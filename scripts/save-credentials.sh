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
