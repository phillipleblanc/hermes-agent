#!/usr/bin/env bash
# Forward-port the Desktop mTLS commit series onto a newer upstream base and
# run the Desktop verification gate.
#
# Usage (from hermes-agent repo root):
#   ./skills/software-development/desktop-mtls-forward-port/scripts/forward-port.sh upstream/vX.Y.Z
#   ./skills/software-development/desktop-mtls-forward-port/scripts/forward-port.sh upstream/main
#
# Env:
#   MTLS_BRANCH   source branch with focused commits (default: origin/feature/desktop-mtls)
#   SKIP_CHECK=1  skip apps/desktop npm run check
#   PUSH=1        push the new branch to origin after success

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

NEW_BASE="${1:-}"
if [ -z "$NEW_BASE" ]; then
  echo "usage: $0 <new-base-ref>" >&2
  echo "example: $0 upstream/v0.18.0" >&2
  exit 2
fi

export PATH="${HOME}/.local/bin:${HOME}/.hermes/node/bin:${PATH}"

MTLS_BRANCH="${MTLS_BRANCH:-origin/feature/desktop-mtls}"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/NousResearch/hermes-agent.git
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/phillipleblanc/hermes-agent.git
fi

echo "==> fetching remotes"
git fetch upstream --tags --prune
git fetch origin --tags --prune

git rev-parse --verify "$NEW_BASE" >/dev/null
git rev-parse --verify "$MTLS_BRANCH" >/dev/null

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty; commit/stash first" >&2
  exit 1
fi

BASE_SLUG="$(git describe --tags --always "$NEW_BASE" 2>/dev/null | tr '/:' '--' || git rev-parse --short "$NEW_BASE")"
BRANCH="desktop-mtls-${BASE_SLUG}"

echo "==> creating branch ${BRANCH} from ${NEW_BASE}"
git switch --detach "$NEW_BASE"
git switch -c "$BRANCH"

if git rev-parse --verify upstream/main >/dev/null 2>&1; then
  OLD_BASE="$(git merge-base "$MTLS_BRANCH" upstream/main)"
else
  OLD_BASE="$(git merge-base "$MTLS_BRANCH" "$NEW_BASE")"
fi

COMMIT_FILE="$(mktemp)"
git rev-list --reverse "${OLD_BASE}..${MTLS_BRANCH}" >"$COMMIT_FILE"
COUNT="$(wc -l <"$COMMIT_FILE" | tr -d ' ')"
if [ "$COUNT" -eq 0 ]; then
  rm -f "$COMMIT_FILE"
  echo "error: no commits found on ${MTLS_BRANCH} after ${OLD_BASE}" >&2
  exit 1
fi

echo "==> cherry-picking ${COUNT} commit(s) from ${MTLS_BRANCH}"
while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  subject="$(git log -1 --pretty=%s "$sha")"
  echo "  - $sha $subject"
  if ! git cherry-pick "$sha"; then
    rm -f "$COMMIT_FILE"
    echo "error: conflict while cherry-picking $sha ($subject)" >&2
    echo "resolve conflicts, then: git add -A && git cherry-pick --continue" >&2
    echo "re-run check with: (cd apps/desktop && npm run check)" >&2
    exit 1
  fi
done <"$COMMIT_FILE"
rm -f "$COMMIT_FILE"

if git diff --name-only "${NEW_BASE}..HEAD" | grep -qE 'apps/desktop/package.json|^package.json$'; then
  echo "==> regenerating package-lock.json (Node $(node --version))"
  npm_config_min_release_age=0 npm install --package-lock-only --ignore-scripts --legacy-peer-deps --engine-strict=false
  if [ -n "$(git status --porcelain package-lock.json)" ]; then
    git add package-lock.json
    git commit -m "build: regenerate package-lock after mTLS forward-port"
  fi
fi

if [ "${SKIP_CHECK:-0}" != "1" ]; then
  echo "==> running apps/desktop check"
  (
    cd apps/desktop
    npm run check
  )
else
  echo "==> SKIP_CHECK=1 — not running npm run check"
fi

if [ "${PUSH:-0}" = "1" ]; then
  echo "==> pushing ${BRANCH} to origin"
  git push -u origin "HEAD:refs/heads/${BRANCH}"
fi

echo
echo "Forward-port complete."
echo "  branch: ${BRANCH}"
echo "  base:   ${NEW_BASE}"
echo "  source: ${MTLS_BRANCH}"
echo "Next:"
echo "  cd apps/desktop && npm run pack   # or npm run dist:mac:dmg"
echo "  git push -u origin ${BRANCH}"
