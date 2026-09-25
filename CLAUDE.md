# Project instructions

## Versioning and releases
- Every PR that changes the app bumps `version` in `package.json` and
  `package-lock.json` (`npm version --no-git-tag-version <patch|minor|major>`):
  patch for fixes, minor for features, major for breaking changes.
- Merging to `main` releases automatically: `.github/workflows/release.yml`
  builds and publishes `v<version>` when that tag doesn't exist yet.
- PRs that change only docs, CI, or tests (nothing shipped) don't bump the
  version; their merge then releases nothing.
- Don't push version tags by hand; the release workflow creates them.
