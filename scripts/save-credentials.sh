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

if cmp -s "$FILE" <(printf '%s' "${EVENHUB_CREDENTIALS_B64:-}" | base64 -d 2>/dev/null); then
  echo "Credentials unchanged; secret is up to date."
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
