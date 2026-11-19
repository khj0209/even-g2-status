#!/usr/bin/env bash
# After the Even Hub CLI ran in CI, write rotated credentials back to the
# EVENHUB_CREDENTIALS_B64 secret. The CLI replaces the refresh token whenever it
# refreshes, and the old one should be assumed dead — without this step the
# secret would stop working after the first refresh.
#
# Needs EVENHUB_SECRET_WRITER_TOKEN: a fine-grained PAT for this repository with
# "Secrets: Read and write" (GITHUB_TOKEN cannot write secrets).
set -euo pipefail

FILE="${XDG_CONFIG_HOME:-$HOME/.config}/evenhub/credentials.yaml"
GH=${GH_BIN:-gh}
gha() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1 title=Even Hub credentials::$2"; else echo "$1: $2" >&2; fi; }

# Pasted secrets often carry a trailing newline or spaces, which GitHub rejects as "Bad credentials".
if [ -n "${GH_TOKEN:-}" ]; then
  GH_TOKEN=$(printf '%s' "$GH_TOKEN" | tr -d '[:space:]')
  export GH_TOKEN
fi

# Describe the token's shape without revealing it (fixed prefix + length only).
token_shape() {
  local t=$GH_TOKEN
  case "$t" in
    github_pat_*) echo "fine-grained token, ${#t} chars" ;;
    ghp_*) echo "classic token, ${#t} chars" ;;
    gh[osur]_*) echo "not a personal access token (prefix ${t:0:4}), ${#t} chars" ;;
    *) echo "unrecognised format (expected github_pat_...), ${#t} chars" ;;
  esac
}

# --check: verify the writer token BEFORE any Even Hub call. Every Even Hub
# command may rotate the refresh token; if we couldn't save the new one, the
# stored session would die. Failing here leaves the session untouched.
if [ "${1:-}" = "--check" ]; then
  if [ -z "${GH_TOKEN:-}" ]; then
    gha error "EVENHUB_SECRET_WRITER_TOKEN is not set. Without it, refreshed Even Hub tokens can't be saved (see README). Stopping before touching the Even Hub session."
    exit 1
  fi
  if ! "$GH" api "repos/$GITHUB_REPOSITORY/actions/secrets/public-key" --silent 2>/tmp/gh-check.err; then
    gha error "EVENHUB_SECRET_WRITER_TOKEN can't write secrets ($(head -c 200 /tmp/gh-check.err | tr '\n' ' '); stored value looks like: $(token_shape)). Regenerate a fine-grained token for this repository with 'Secrets: Read and write' and update the secret. Stopping before touching the Even Hub session, so it stays valid."
    exit 1
  fi
  echo "Secret writer token OK ($(token_shape))."
  exit 0
fi

if [ ! -f "$FILE" ]; then
  echo "No credentials file; nothing to save."
  exit 0
fi

# Compare the tokens themselves (not file bytes) so a reformatted file isn't a false alarm.
LIB="$(cd "$(dirname "$0")" && pwd)/release-lib.mjs"
tokens() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { readYamlField } = await import(process.argv[1]);
    const y = readFileSync(0, "utf8");
    const a = readYamlField(y, "access_token"), r = readYamlField(y, "refresh_token");
    if (!a || !r) process.exit(1);
    console.log(a + " " + r);
  ' "$LIB"
}
NOW=$(tokens < "$FILE" || true)
BEFORE=$(printf '%s' "${EVENHUB_CREDENTIALS_B64:-}" | base64 -d 2>/dev/null | tokens 2>/dev/null || true)
# If either side can't be parsed, assume it changed (saving is safe; skipping is not).
if [ -n "$NOW" ] && [ "$NOW" = "$BEFORE" ]; then
  echo "Tokens unchanged; secret is up to date."
  exit 0
fi

if [ -z "${GH_TOKEN:-}" ]; then
  gha error "The CLI refreshed the Even Hub tokens, but EVENHUB_SECRET_WRITER_TOKEN is not set, so the new tokens could not be saved. The stored secret is probably invalid now: run 'npm run ci-login -- --set' and add EVENHUB_SECRET_WRITER_TOKEN (see README)."
  exit 1
fi

# Pipe through stdin so the value never appears in argv or logs.
if ! base64 -w0 "$FILE" | "$GH" secret set EVENHUB_CREDENTIALS_B64 --repo "$GITHUB_REPOSITORY"; then
  gha error "Failed to save refreshed Even Hub tokens to the secret. Check EVENHUB_SECRET_WRITER_TOKEN permissions, then run 'npm run ci-login -- --set'."
  exit 1
fi
echo "Refreshed credentials saved to EVENHUB_CREDENTIALS_B64."
