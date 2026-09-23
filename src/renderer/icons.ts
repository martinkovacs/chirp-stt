// Inline stroke icons (16×16 grid, currentColor) shared by the renderers.

const PATHS = {
  arrow: "M2.5 8h10.5M9.5 4.5 13 8l-3.5 3.5",
  swap: "M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

/** "HU → EN" as text + SVG arrow, or just "HU" when both sides match. */
export function langPair(from: string, to: string): Node[] {
  const a = from.toUpperCase();
  if (from === to) return [document.createTextNode(a)];
  return [document.createTextNode(a), icon("arrow", "icon arrow"), document.createTextNode(to.toUpperCase())];
}
