#!/bin/sh
# Put a backup archive back into the volume. Stop the server first: docker compose stop orchestra
#   ./restore.sh /var/backups/orchestra/2026-11-04.tgz && docker compose start orchestra
# The archive is checked before anything changes: one folder of plain files and folders (no links), and ledgers the
# server would read, by its own rules (orchestra/check-data.mjs: node here, or else the server's image without network).
# The files it replaces are moved aside to a folder of its own, DATA.before-<time>-<random>, not deleted, and put
# back if the restore fails or is stopped (TERM, INT, HUP) half way.
set -eu
A=${1:?usage: restore.sh <archive.tgz>}; D=${DATA:-/srv/orchestra}
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); P=$(mktemp -d "$D.before-$(date +%Y%m%d-%H%M%S)-XXXXXX"); N="$P.new"
moved=""; placed=""
undo() {
  for f in $placed; do rm -rf "${D:?}/$f"; done
  for f in $moved; do mv "$P/$f" "$D/"; done
}
finish() {
  code=$1
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] && [ -n "$moved$placed" ]; then undo && echo "restore stopped; $D is as it was" >&2; fi
  rm -rf "$W" "$N"
  rmdir "$P" 2>/dev/null || true   # kept only when it holds what was replaced
  exit "$code"
}
trap 'finish $?' EXIT
trap 'finish 1' HUP INT TERM
tar -xzf "$A" -C "$W"
[ "$(find "$W" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] || { echo "$A: one folder expected" >&2; exit 1; }
[ -z "$(find "$W" ! -type f ! -type d)" ] || { echo "$A: holds links or other special files, nothing changed" >&2; exit 1; }
S=$(find "$W" -mindepth 1 -maxdepth 1 -type d)
[ -n "$S" ] && [ -f "$S/orders.json" ] || { echo "no orders.json in $A" >&2; exit 1; }
if command -v node >/dev/null 2>&1; then
  node "$HERE/../check-data.mjs" "$S"
else
  docker run --rm --network none -u 0 -v "$S:/restore:ro" agent-orchestra:local node orchestra/check-data.mjs /restore
fi || { echo "$A: the server would not read its ledgers, nothing changed" >&2; exit 1; }
cp -R "$S" "$N"   # next to the volume, on its disk: each part then goes in with one rename
for f in orders.json auction.json seats; do
  if [ -e "$D/$f" ]; then mv "$D/$f" "$P/"; moved="$moved $f"; fi
done
for f in orders.json auction.json seats; do
  if [ -e "$N/$f" ]; then mv "$N/$f" "$D/"; placed="$placed $f"; fi
done
# The server runs as node (uid 1000) and must be able to write here.
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$D"; fi
echo "restored $A into $D (previous files: $P)"
