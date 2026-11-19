#!/usr/bin/env bash
# Upload a packed build to Even Hub and (optionally) put it on the beta channel.
#
#   scripts/publish.sh <file.ehpk> <version> <notes-file>
#
# - First release: `evenhub create` (name from app.json, tagline from EVENHUB_TAGLINE,
#   description from store/description.md, icon from store/icon.png if present).
# - Later releases: `evenhub upload`. Re-running for an already uploaded version is
#   treated as success so a failed workflow can simply be re-run.
# - EVENHUB_BETA=false skips `evenhub promote --to beta`.
#
# Public release needs Even's review and is done in the developer portal.
set -euo pipefail

EHPK=$1
VERSION=$2
NOTES_FILE=$3
PKG_ID=$(node -p "require('./app.json').package_id")
NAME=$(node -p "require('./app.json').name")
TAGLINE=${EVENHUB_TAGLINE:-"하루 종일 켜두는 상태표시창"}

gha() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2" >&2; fi; }
# EVENHUB_BIN lets tests substitute a fake CLI.
eh() { ${EVENHUB_BIN:-npx --no-install evenhub} "$@"; }

# Run an evenhub command with --json; sets $OUT and $CODE without aborting.
run() {
  set +e
  OUT=$(eh "$@" --json)
  CODE=$?
  set -e
}

explain() {
  local msg
  msg=$(node -e 'try{const j=JSON.parse(process.argv[1]);console.log(`${j.message}${j.hint?" — "+j.hint:""}`)}catch{console.log(process.argv[1])}' "$OUT")
  case $CODE in
    2) gha error "Even Hub login expired or invalid. Run 'npx evenhub login' locally and update the EVENHUB_CREDENTIALS_B64 secret (npm run credentials). ($msg)" ;;
    *) gha error "evenhub $1 failed (exit $CODE): $msg" ;;
  esac
  exit "$CODE"
}

run ls "$PKG_ID"
case $CODE in
  0)
    echo "Uploading $VERSION to existing app $PKG_ID"
    run upload "$EHPK" --package-id "$PKG_ID" -m "$(cat "$NOTES_FILE")"
    if [ "$CODE" -eq 4 ]; then
      gha notice "Version $VERSION was already uploaded; continuing."
    elif [ "$CODE" -ne 0 ]; then
      explain upload
    fi
    ;;
  3)
    echo "Creating new app $PKG_ID"
    args=(create "$EHPK" --package-id "$PKG_ID" --name "$NAME" --tagline "$TAGLINE")
    [ -f store/description.md ] && args+=(--description-file store/description.md)
    if [ -f store/icon.png ]; then
      args+=(--icon store/icon.png)
    else
      gha warning "store/icon.png not found; Even Hub will use a placeholder icon (24x24 PNG required)."
    fi
    run "${args[@]}"
    [ "$CODE" -eq 0 ] || explain create
    ;;
  *)
    explain ls
    ;;
esac
echo "$OUT"

if [ "${EVENHUB_BETA:-true}" = "true" ]; then
  run promote "$VERSION" --to beta --package-id "$PKG_ID"
  [ "$CODE" -eq 0 ] || explain promote
  echo "Promoted $VERSION to beta."
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Even Hub: $NAME $VERSION"
    echo "- package: \`$PKG_ID\`"
    echo "- beta: ${EVENHUB_BETA:-true}"
    echo "- 공개 배포는 Even Hub 개발자 포털에서 심사 요청이 필요합니다."
  } >> "$GITHUB_STEP_SUMMARY"
fi
