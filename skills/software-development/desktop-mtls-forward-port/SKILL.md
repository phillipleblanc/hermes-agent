---
name: desktop-mtls-forward-port
description: "Use when rebasing the Desktop mTLS patch onto a newer Hermes release and rebuilding the app."
version: 1.0.0
author: Phillip LeBlanc / Hermes Agent
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [desktop, mtls, electron, rebase, packaging, forward-port]
    related_skills: [hermes-agent, github-repo-management, test-driven-development]
---

# Desktop mTLS Forward-Port

## Overview

Maintain and rebuild the patched Hermes Desktop that connects to an mTLS-protected remote hub. The working patch lives on the fork:

```text
https://github.com/phillipleblanc/hermes-agent
branch: feature/desktop-mtls
```

Desktop is a thin remote UI. The hub remains authoritative for sessions, memory, skills, models, messaging, cron, and Kanban. Private keys stay in the OS certificate store (macOS Keychain); Desktop only stores public certificate selectors.

## When to Use

- A newer Hermes Desktop release is available and you need mTLS again
- Rebuild an unsigned local `.app` / `.dmg` with the mTLS patch
- Resolve conflicts after rebasing `feature/desktop-mtls`
- Verify certificate selection still works after an Electron bump

Do not use for ordinary local-only Desktop work, or when upstream already includes equivalent mTLS support (then drop overlapping commits instead).

## Source of truth

| Item | Value |
|------|-------|
| Fork | `phillipleblanc/hermes-agent` |
| Patch branch | `feature/desktop-mtls` |
| Upstream | `NousResearch/hermes-agent` |
| Preferred base | tagged Desktop/release commit, else `upstream/main` |
| Node for builds | Hermes-managed Node 22 (`~/.hermes/node/bin`) |
| Electron pin (current) | `44.0.0-alpha.9` (only if upstream is still on Electron 40-class) |

### Focused commits (apply in order)

1. `feat(desktop): add mTLS client certificate selection helpers`
2. `feat(desktop): persist mTLS certificate selectors in remote config`
3. `feat(desktop): wire certificate-aware Electron transport for remote gateways`
4. `build(desktop): bump Electron to 44.0.0-alpha.9 for mTLS net support`

Inspect live SHAs with:

```bash
git log --oneline upstream/main..feature/desktop-mtls
# or
git log --oneline origin/feature/desktop-mtls -10
```

## Prerequisites

```bash
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"
command -v gh >/dev/null
command -v git >/dev/null
node --version   # expect v22.x
gh auth status
```

Working tree should be clean before rebase/cherry-pick.

## Upgrade workflow

### Task 1 — Sync remotes

```bash
cd "$(git rev-parse --show-toplevel)"

git remote get-url upstream >/dev/null 2>&1 || \
  git remote add upstream https://github.com/NousResearch/hermes-agent.git
git remote get-url origin >/dev/null 2>&1 || \
  git remote add origin https://github.com/phillipleblanc/hermes-agent.git

# If this clone still points origin at NousResearch, fix it:
# git remote rename origin upstream
# git remote add origin https://github.com/phillipleblanc/hermes-agent.git

git fetch upstream --tags --prune
git fetch origin --tags --prune
```

**Done when:** `git remote -v` shows both remotes and fetches succeed.

### Task 2 — Choose the new base

Prefer a release tag when packaging a specific Desktop version:

```bash
git tag -l 'v*' | tail -20
# or inspect GitHub releases
gh release list --repo NousResearch/hermes-agent --limit 20
```

```bash
NEW_BASE=upstream/vX.Y.Z    # preferred
# NEW_BASE=upstream/main    # rolling
```

**Done when:** `NEW_BASE` resolves (`git rev-parse "$NEW_BASE"`).

### Task 3 — Create a forward-port branch

```bash
git switch --detach "$NEW_BASE"
git switch -c "desktop-mtls-$(git describe --tags --always "$NEW_BASE" | tr '/' '-')"
```

**Done when:** you are on a new branch based at `$NEW_BASE` with a clean tree.

### Task 4 — Cherry-pick the focused commits

```bash
# Discover SHAs from the maintained branch
git log --oneline origin/feature/desktop-mtls ^upstream/main | tee /tmp/mtls-commits.txt

# Cherry-pick oldest→newest (reverse of git log order)
git rev-list --reverse origin/feature/desktop-mtls ^$(git merge-base origin/feature/desktop-mtls upstream/main) \
  | while read -r sha; do
      git cherry-pick "$sha" || {
        echo "CONFLICT on $sha — resolve, then: git add -A && git cherry-pick --continue"
        exit 1
      }
    done
```

If the branch was already rebased onto a known old base:

```bash
OLD_BASE=$(git merge-base origin/feature/desktop-mtls upstream/main)
git rev-list --reverse "${OLD_BASE}..origin/feature/desktop-mtls" | while read -r sha; do
  git cherry-pick "$sha" || exit 1
done
```

**Done when:** all mTLS commits are applied and `git status` is clean.

### Task 5 — Resolve conflicts by category

#### `apps/desktop/electron/main.ts` (most likely)

Re-apply only these behaviors on top of upstream code:

- Import from `./client-certificate-selection`
- `installClientCertificateSelector` on default + OAuth sessions
- Host allowlist via configured remote URL / `HERMES_DESKTOP_CLIENT_CERT_HOSTS`
- Never auto-pick a cert for unrelated hosts
- `fetchJsonViaElectronSession` and routing when `clientCertificate` / `forceElectronTransport` is set
- Pass `clientCertificate` through remote connection build/test/request paths
- Live-WS leg of the Test-connection check: the main-process Node WebSocket can
  never present an mTLS client certificate (selection is a Chromium-session
  feature; a YubiHSM identity's key can't be extracted at all). When
  `clientCertificate` is set, the WS probe must run in the renderer's session
  (`gateway-ws-probe-renderer.ts` / `probeGatewayWebSocketInRenderer`), which
  mirrors the real chat transport. Without this, "Test remote" on an mTLS
  gateway always fails with "Reached the gateway over HTTP, but the live
  WebSocket (/api/ws) connection failed" even though the app itself connects.
- Electron 44 clipboard image read/write if upstream still uses removed `readImage`/`writeImage`

Do **not** keep unrelated local edits.

#### Config / UI

Keep upstream structure; re-add:

- `clientCertificate` on connection config types
- profile override pass-through
- Gateway settings fields: fingerprint, issuer, serial, subject

#### `apps/desktop/package.json` + lockfile

1. Prefer upstream Electron if it is already ≥ the version needed for `session`/`net` client certificates.
2. Only re-apply the Electron 44 pin if upstream is still on Electron 40-class.
3. Resolve `package.json` first, then regenerate the lockfile (never hand-merge large lock chunks):

```bash
export PATH="$HOME/.hermes/node/bin:$PATH"
npm_config_min_release_age=0 npm install --package-lock-only --ignore-scripts --legacy-peer-deps --engine-strict=false
```

4. Update root `package.json` `allowScripts` electron key if the version string changed.

**Done when:** conflicts resolved, tree builds conceptually, no private keys or secrets in the diff.

### Task 6 — Verify

```bash
export PATH="$HOME/.hermes/node/bin:$PATH"
cd apps/desktop

# Full Desktop gate (preferred)
npm run check

# If check is too heavy mid-conflict, minimum bar:
npm run typecheck
npm run test:desktop:platforms
```

Live mTLS smoke (after packaging or `npm run start`):

1. Settings → Gateway → Remote URL = hub HTTPS URL
2. Fingerprint = installed client cert SHA-256 (no private key)
3. Leave issuer blank unless needed
4. Test connection
5. Confirm HTTP status probe + WebSocket chat both work
6. Confirm no private key appears in config/logs

**Done when:** `npm run check` exits 0 and live mTLS path works, or remaining failures are documented upstream pre-existing issues.

### Task 7 — Package

```bash
export PATH="$HOME/.hermes/node/bin:$PATH"
cd apps/desktop

npm run pack          # unpacked .app
# or
npm run dist:mac:dmg  # DMG under release/
```

Artifacts:

```text
apps/desktop/release/mac-arm64/Hermes.app
apps/desktop/release/Hermes-*-mac-arm64.dmg
```

Unsigned/local builds are expected unless signing env is configured.

**Done when:** app binary exists and launches.

### Task 8 — Publish the forward-port branch

```bash
BRANCH=$(git branch --show-current)
git push -u origin "$BRANCH"

# Optionally advance the maintained long-lived branch after validation:
# git push origin HEAD:feature/desktop-mtls
```

**Done when:** `gh repo view phillipleblanc/hermes-agent --branch "$BRANCH"` works.

## Certificate values (example machine)

For the installed identity labeled `PhillipMacBookM4`:

| Field | Value |
|-------|-------|
| Fingerprint | `FE9F62D8A7FBC8C86299371ABC106AC9BA152539EB85A40998F8761EB7853A65` |
| Subject | `PhillipMacBookM4` |
| Serial | `44524A77C11BC8340A1ECAD7A8C393B2` |
| Issuer | leave blank unless selection is ambiguous |

Fingerprint alone is preferred. The private key must be a usable macOS SSL client identity (`security find-identity -v -p ssl-client`).

## Helper script

`scripts/forward-port.sh` automates fetch → branch → cherry-pick → check. Run from repo root:

```bash
./skills/software-development/desktop-mtls-forward-port/scripts/forward-port.sh upstream/vX.Y.Z
```

## Common Pitfalls

1. **Rebasing the DMG instead of source commits** — always forward-port git commits, then rebuild.
2. **Blindly re-applying the Electron 44 pin** — skip it if upstream already ships a compatible Electron.
3. **Hand-merging `package-lock.json`** — regenerate after resolving `package.json`.
4. **Using Node 25 for install/lockfile** — use Hermes Node 22.
5. **Cherry-picking newest-first** — apply oldest→newest.
6. **HTTP-only test success** — WebSocket must also succeed under mTLS.
7. **Storing private keys in config** — never; only public selectors.
8. **Shallow clone surprises** — `git fetch --unshallow` or re-clone the fork if history is incomplete.
9. **origin still points at NousResearch** — push target must be `phillipleblanc/hermes-agent`.
10. **Assuming Keychain cert ⇒ usable identity** — verify with `security find-identity -v -p ssl-client`.

## Verification Checklist

- [ ] Fork remote is `phillipleblanc/hermes-agent`
- [ ] Forward-port branch based on intended upstream tag/commit
- [ ] All focused mTLS commits present (or intentionally dropped if upstream absorbed them)
- [ ] No secrets/private keys in diff
- [ ] `npm run check` passes on Node 22
- [ ] Packaged app built
- [ ] Live hub mTLS HTTP + WebSocket verified
- [ ] Branch pushed to the fork

## One-shot recipe

```bash
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"
cd ~/src/hermes-agent   # clone of phillipleblanc/hermes-agent

git fetch upstream --tags
git fetch origin
BASE=upstream/vX.Y.Z   # set me
./skills/software-development/desktop-mtls-forward-port/scripts/forward-port.sh "$BASE"
cd apps/desktop && npm run dist:mac:dmg
```
