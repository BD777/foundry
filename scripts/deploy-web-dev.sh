#!/usr/bin/env bash
# Publish a built Web dist to the dev site, the one way every session deploys.
#
# Usage: scripts/deploy-web-dev.sh <dist-dir> <release-dir>
#   <dist-dir>     a `vite build` output (index.html, version.json, assets/)
#   <release-dir>  this deployment's folder; the served index.html/version.json
#                  are saved under <release-dir>/previous-<UTC time> first
#
# Steps: refuse a bundle that still points browsers at the local server
# (127.0.0.1:31982, i.e. built without VITE_API_BASE_URL on a build that
# predates the same-origin default) → copy new assets beside the old ones
# (never deleting any, open pages keep loading theirs) → swap index.html and
# version.json atomically → check that the public site serves the new build,
# its entry assets byte for byte, and that the API answers JSON on the same
# origin. If a check after the swap fails, the previous index/version are put
# back. A real-browser check (page loads, API requests go to the site's own
# origin) is still the deployer's job.
#
# Environment: FOUNDRY_WEB_ROOT (default /var/www/foundryapp-dev),
# FOUNDRY_WEB_ORIGIN (default https://dev.foundryapp.app).
set -euo pipefail

die() {
  echo "deploy-web-dev: $*" >&2
  exit 1
}

[ $# -eq 2 ] || die "usage: scripts/deploy-web-dev.sh <dist-dir> <release-dir>"
DIST=$(cd "$1" && pwd)
RELEASE=$2
ROOT=${FOUNDRY_WEB_ROOT:-/var/www/foundryapp-dev}
ORIGIN=${FOUNDRY_WEB_ORIGIN:-https://dev.foundryapp.app}

for f in index.html version.json assets; do
  [ -e "$DIST/$f" ] || die "$DIST has no $f; pass a vite build output"
done
[ -d "$ROOT/assets" ] || die "$ROOT is not the served Web root"
BUILD=$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$DIST/version.json")
[ -n "$BUILD" ] || die "$DIST/version.json has no build id"

# 1. The bundle must stay on its own origin.
if grep -l '127\.0\.0\.1:31982' "$DIST"/assets/*.js >/dev/null 2>&1; then
  grep -l '127\.0\.0\.1:31982' "$DIST"/assets/*.js >&2
  die "refusing: the bundle calls http://127.0.0.1:31982 (rebuild in apps/web so .env.production loads, or set VITE_API_BASE_URL=)"
fi

# 2. Keep the served entry for rollback.
PREVIOUS="$RELEASE/previous-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PREVIOUS"
cp -p "$ROOT/index.html" "$ROOT/version.json" "$PREVIOUS/"
OLD_BUILD=$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$PREVIOUS/version.json")
echo "previous build $OLD_BUILD saved in $PREVIOUS"

rollback() {
  cp "$PREVIOUS/index.html" "$ROOT/.index.html.rollback" &&
    mv "$ROOT/.index.html.rollback" "$ROOT/index.html"
  cp "$PREVIOUS/version.json" "$ROOT/.version.json.rollback" &&
    mv "$ROOT/.version.json.rollback" "$ROOT/version.json"
  die "$1; rolled back to $OLD_BUILD"
}

# 3. Assets first (no overwrite: names are content hashes), then other files.
cp -rn "$DIST/assets/." "$ROOT/assets/"
for f in "$DIST"/*; do
  name=$(basename "$f")
  [ -f "$f" ] || continue
  case $name in index.html | version.json) ;; *) cp -p "$f" "$ROOT/$name" ;; esac
done

# 4. Atomic swap of the entry.
cp "$DIST/index.html" "$ROOT/.index.html.new" && mv "$ROOT/.index.html.new" "$ROOT/index.html"
cp "$DIST/version.json" "$ROOT/.version.json.new" && mv "$ROOT/.version.json.new" "$ROOT/version.json"

# 5. Verify what the public site serves.
served=$(curl -fsS "$ORIGIN/version.json?deploy=$BUILD") || rollback "version.json unreachable"
case $served in *"\"$BUILD\""*) ;; *) rollback "site serves $served, not $BUILD" ;; esac
html=$(curl -fsS "$ORIGIN/") || rollback "index unreachable"
for asset in $(printf '%s' "$html" | grep -o 'assets/[^"]*\.\(js\|css\)' | sort -u); do
  want=$(sha256sum "$DIST/$asset" | cut -d' ' -f1)
  got=$(curl -fsS "$ORIGIN/$asset" | sha256sum | cut -d' ' -f1)
  [ "$want" = "$got" ] || rollback "$asset differs from the build"
done
type=$(curl -fsS -o /dev/null -w '%{content_type}' "$ORIGIN/api/worker/release") ||
  rollback "same-origin API did not answer"
case $type in application/json*) ;; *) rollback "same-origin API answered $type" ;; esac

echo "published $BUILD (was $OLD_BUILD) at $ORIGIN; entry assets match, API answers JSON"
