// xdg-desktop-portal GlobalShortcuts hotkey source (Linux, Wayland-friendly).
// Uses the low-level dbus-next Message API for exact signatures and so that the
// Request/Response signals can be subscribed before the calls are issued.

import dbus from "dbus-next";
import { EventEmitter } from "node:events";
import type { HotkeySource } from "./types.ts";

const PORTAL_DEST = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_IFACE = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_IFACE = "org.freedesktop.portal.Request";
const SESSION_IFACE = "org.freedesktop.portal.Session";
const BUS_IFACE = "org.freedesktop.DBus";
const BUS_PATH = "/org/freedesktop/DBus";
const PROPERTIES_IFACE = "org.freedesktop.DBus.Properties";

const MIN_PORTAL_VERSION = 1;
const SHORTCUT_ID = "dictate";

const CREATE_TIMEOUT_MS = 10_000;
const BIND_TIMEOUT_MS = 90_000; // KDE shows a confirmation dialog

/** "/org/freedesktop/portal/desktop/request/SENDER/TOKEN": the requestor's
 *  unique bus name with the leading colon removed, dots → underscores. */
export function predictedRequestPath(sender: string, token: string): string {
  return `/org/freedesktop/portal/desktop/request/${sender.replace(/^:/, "").replace(/\./g, "_")}/${token}`;
}

/** D-Bus handle tokens are restricted to [A-Za-z0-9_]. */
function token(name: string): string {
  return `${name}_${Math.random().toString(36).slice(2, 10)}`;
}

interface PortalResponse {
  /** 0 = ok, 1 = user cancelled (dialog dismissed), 2+ = errors. */
  code: number;
  results: Record<string, unknown>;
}

export interface PortalHotkeySourceOptions {
  /** Preferred trigger in XDG shortcuts spec format, e.g. "CTRL+space". */
  preferredTrigger: string;
  description: string;
  appId?: string;
}

export class PortalHotkeySource extends EventEmitter implements HotkeySource {
  readonly kind = "portal";
  private readonly preferredTrigger: string;
  private readonly description: string;
  readonly appId: string;

  private bus: dbus.MessageBus | null = null;
  private messageListener: ((msg: dbus.Message) => void) | null = null;
  private sessionHandle: string | null = null;
  private triggerDescription: string | null = null;
  private isDown = false;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<string, (res: PortalResponse) => void>();
  private early = new Map<string, PortalResponse>();

  constructor(opts: PortalHotkeySourceOptions) {
    super();
    this.preferredTrigger = opts.preferredTrigger;
    this.description = opts.description;
    this.appId = opts.appId ?? "dev.chirp";
  }

  describe(): string {
    return this.triggerDescription ?? this.preferredTrigger;
  }

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((err) => {
        this.startPromise = null;
        this.stop();
        throw err;
      });
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const bus = dbus.sessionBus();
    this.bus = bus;
    this.messageListener = (msg) => this.onMessage(msg);
    bus.on("message", this.messageListener);
    bus.on("error", (err) => this.emit("error", err));

    // dbus-next performs the Hello handshake itself; wait for it so
    // `bus.name` (our unique address) is available for request path prediction.
    if (!busOwnName(bus)) {
      await new Promise<void>((resolve) => bus.once("connect", () => resolve()));
    }
    const ownName = busOwnName(bus);
    if (ownName === "") throw new Error("dbus: session bus did not report our unique name");

    // Subscribe BEFORE CreateSession: the Response signal may otherwise arrive
    // before the method call's promise resolves.
    for (const rule of [
      `type='signal',sender='${PORTAL_DEST}',interface='${REQUEST_IFACE}'`,
      `type='signal',sender='${PORTAL_DEST}',path='${PORTAL_PATH}',interface='${GLOBAL_SHORTCUTS_IFACE}'`,
    ]) {
      await bus.call(
        new dbus.Message({
          destination: BUS_IFACE,
          path: BUS_PATH,
          interface: BUS_IFACE,
          member: "AddMatch",
          signature: "s",
          body: [rule],
        }),
      );
    }

    // Unsandboxed apps must tell the portal who they are before any portal
    // call, or KDE refuses GlobalShortcuts with "An app id is required".
    // The id must match an installed <appId>.desktop file.
    try {
      await bus.call(
        new dbus.Message({
          destination: PORTAL_DEST,
          path: PORTAL_PATH,
          interface: "org.freedesktop.host.portal.Registry",
          member: "Register",
          signature: "sa{sv}",
          body: [this.appId, {}],
        }),
      );
    } catch (err) {
      // Older xdg-desktop-portal (< 1.19) has no registry; carry on and let
      // the portal derive the app id itself.
      console.warn("[portal] Registry.Register failed:", err);
    }

    // Availability check: the portal runs AND the GlobalShortcuts interface exists.
    await this.portalVersion(bus);

    // CreateSession: options carry the tokens; the reply is just the request
    // path, the real answer arrives as Request.Response on that path.
    const createToken = token("chirp_create");
    const bindToken = token("chirp_bind");
    const createReply = await bus.call(
      new dbus.Message({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GLOBAL_SHORTCUTS_IFACE,
        member: "CreateSession",
        signature: "a{sv}",
        body: [
          {
            handle_token: new dbus.Variant("s", createToken),
            session_handle_token: new dbus.Variant("s", token("chirp_session")),
          },
        ],
      }),
    );
    const createRequestPath = requestPath(createReply, ownName, createToken);
    const created = await this.awaitResponse(createRequestPath, CREATE_TIMEOUT_MS, "CreateSession");
    const handle = variantValue(created.results["session_handle"]);
    if (typeof handle !== "string") throw new Error("portal did not return a session_handle");
    this.sessionHandle = handle;

    // Bind on every start, even if the shortcut is already listed: KDE only
    // activates the kglobalaccel component in BindShortcuts, so skipping it
    // leaves the shortcut registered but dead. A persisted binding doesn't
    // show the dialog again.
    {
      const bindReply = await bus.call(
        new dbus.Message({
          destination: PORTAL_DEST,
          path: PORTAL_PATH,
          interface: GLOBAL_SHORTCUTS_IFACE,
          member: "BindShortcuts",
          signature: "oa(sa{sv})sa{sv}",
          body: [
            this.sessionHandle,
            [
              [
                SHORTCUT_ID,
                {
                  description: new dbus.Variant("s", this.description),
                  preferred_trigger: new dbus.Variant("s", this.preferredTrigger),
                },
              ],
            ],
            "",
            { handle_token: new dbus.Variant("s", bindToken) },
          ],
        }),
      );
      const bindRequestPath = requestPath(bindReply, ownName, bindToken);
      // Resolves once the user confirms the KDE dialog (or rejects on cancel).
      const response = await this.awaitResponse(bindRequestPath, BIND_TIMEOUT_MS, "BindShortcuts");
      if (response.code !== 0) {
        throw new Error(`GlobalShortcuts binding rejected (response code ${response.code})`);
      }
    }

    // Actual trigger description (what the DE assigned), from ListShortcuts.
    this.applyShortcutInfo(await this.listShortcuts(bus));
    this.started = true;
  }

  /** Closes the portal session (org.freedesktop.portal.Session.Close) and
   *  disconnects from the bus. */
  stop(): void {
    this.started = false;
    this.isDown = false;
    this.pending.clear();
    this.startPromise = null;
    const bus = this.bus;
    const session = this.sessionHandle;
    this.sessionHandle = null;
    this.triggerDescription = null;
    if (bus && session) {
      // Session.Close has no method return; ignore errors (already closed).
      void bus
        .call(
          new dbus.Message({
            destination: PORTAL_DEST,
            path: session,
            interface: SESSION_IFACE,
            member: "Close",
          }),
        )
        .catch(() => {
          // session may already be gone
        });
    }
    if (bus) {
      if (this.messageListener) bus.off("message", this.messageListener);
      this.messageListener = null;
      bus.disconnect();
      this.bus = null;
    }
  }

  // -- helpers --------------------------------------------------------------

  private async portalVersion(bus: dbus.MessageBus): Promise<number> {
    let reply: dbus.Message | null;
    try {
      reply = await bus.call(
        new dbus.Message({
          destination: PORTAL_DEST,
          path: PORTAL_PATH,
          interface: PROPERTIES_IFACE,
          member: "Get",
          signature: "ss",
          body: [GLOBAL_SHORTCUTS_IFACE, "version"],
        }),
      );
    } catch (err) {
      throw new Error(
        `xdg-desktop-portal GlobalShortcuts interface unavailable (portals need version ${MIN_PORTAL_VERSION}+): ${errorText(err)}`,
      );
    }
    const value = variantValue(reply?.body[0]);
    if (typeof value !== "number") {
      throw new Error("xdg-desktop-portal GlobalShortcuts interface unavailable: missing 'version' property");
    }
    if (value < MIN_PORTAL_VERSION) {
      throw new Error(`xdg-desktop-portal GlobalShortcuts version ${value} is too old`);
    }
    return value;
  }

  /** ListShortcuts → entries as {id, dict?}; works with a(su) and a(sa{sv}) replies. */
  private async listShortcuts(bus: dbus.MessageBus): Promise<ShortcutEntry[]> {
    const listToken = token("chirp_list");
    const reply = await bus.call(
      new dbus.Message({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GLOBAL_SHORTCUTS_IFACE,
        member: "ListShortcuts",
        signature: "oa{sv}",
        body: [this.sessionHandle, { handle_token: new dbus.Variant("s", listToken) }],
      }),
    );
    const res = await this.awaitResponse(requestPath(reply, busOwnName(bus), listToken), CREATE_TIMEOUT_MS, "ListShortcuts");
    if (res.code !== 0) return [];
    return asShortcutEntries(variantValue(res.results["shortcuts"]));
  }

  private applyShortcutInfo(entries: ShortcutEntry[]): void {
    for (const entry of entries) {
      if (entry.id !== SHORTCUT_ID || !entry.dict) continue;
      const text = variantText(entry.dict["trigger_description"]);
      if (text !== null) this.triggerDescription = text;
    }
  }

  private onMessage(msg: dbus.Message): void {
    if (msg.interface === REQUEST_IFACE && msg.member === "Response") {
      this.feedResponse(msg);
      return;
    }
    if (msg.interface !== GLOBAL_SHORTCUTS_IFACE) return;
    // Activated/Deactivated/ShortcutsChanged: (o session_handle, s shortcut_id | a(sa{sv}) shortcuts, ...)
    if (this.sessionHandle && msg.body[0] !== this.sessionHandle) return;
    if (msg.member === "ShortcutsChanged") {
      this.applyShortcutInfo(asShortcutEntries(msg.body[1]));
      return;
    }
    const shortcutId = typeof msg.body[1] === "string" ? msg.body[1] : "";
    if (shortcutId !== SHORTCUT_ID) return;
    switch (msg.member) {
      case "Activated":
        // Auto-repeat / double sends are filtered: one "down" per press.
        if (this.started && !this.isDown) {
          this.isDown = true;
          this.emit("down");
        }
        break;
      case "Deactivated":
        if (this.started && this.isDown) {
          this.isDown = false;
          this.emit("up");
        }
        break;
      case "ShortcutsChanged":
        this.applyShortcutInfo(asShortcutEntries(msg.body[1]));
        break;
      default:
        break;
    }
  }

  private feedResponse(msg: dbus.Message): void {
    const res = { code: Number(msg.body[0] ?? 0), results: asResults(msg.body[1]) };
    const resolver = msg.path !== undefined ? this.pending.get(msg.path) : undefined;
    if (!resolver) {
      // The Response signal can be dispatched before the method reply that
      // tells us the request path; keep it until awaitResponse() asks.
      if (msg.path) this.early.set(msg.path, res);
      return;
    }
    this.pending.delete(msg.path);
    resolver(res);
  }

  private awaitResponse(requestPath: string, timeoutMs: number, call: string): Promise<PortalResponse> {
    return new Promise((resolve, reject) => {
      if (this.bus === null || requestPath === "") {
        reject(new Error(`internal: cannot wait for the ${call} response (no bus or no request path)`));
        return;
      }
      const early = this.early.get(requestPath);
      if (early) {
        this.early.delete(requestPath);
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestPath);
        reject(new Error(`timed out waiting for the ${call} response`));
      }, timeoutMs);
      this.pending.set(requestPath, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }
}

// -- module-level small helpers ---------------------------------------------

interface ShortcutEntry {
  id: string;
  dict?: Record<string, unknown>;
}

function requestPath(reply: dbus.Message | null, ownName: string, handleToken: string): string {
  const direct = typeof reply?.body[0] === "string" ? reply.body[0] : "";
  return direct !== "" ? direct : ownName !== "" ? predictedRequestPath(ownName, handleToken) : "";
}

/** Our unique bus address; assigned during dbus-next's internal Hello. */
function busOwnName(bus: dbus.MessageBus): string {
  const name = (bus as unknown as { name?: string }).name;
  return typeof name === "string" ? name : "";
}

function asResults(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function asShortcutEntries(body: unknown): ShortcutEntry[] {
  return Array.isArray(body)
    ? body
        .filter((e): e is unknown[] => Array.isArray(e))
        .map((e) => ({
          id: String(e[0]),
          dict: e.length > 1 && e[1] && typeof e[1] === "object" ? (e[1] as Record<string, unknown>) : undefined,
        }))
    : [];
}

/** Unwraps dbus.Variant (and tolerates already-plain values). */
function variantValue(raw: unknown): unknown {
  return raw instanceof dbus.Variant ? raw.value : raw;
}

function variantText(raw: unknown): string | null {
  const value = variantValue(raw);
  return typeof value === "string" ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
