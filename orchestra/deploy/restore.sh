#!/bin/sh
# Put a backup archive back into the volume. Stop the server first: docker compose stop orchestra
#   ./restore.sh /var/backups/orchestra/2026-11-04.tgz && docker compose start orchestra
# The files it replaces are moved aside to DATA.before-<time>, not deleted.
set -eu
A=${1:?usage: restore.sh <archive.tgz>}; D=${DATA:-/srv/orchestra}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
tar -xzf "$A" -C "$W"
S=$(find "$W" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -f "$S/orders.json" ] || { echo "no orders.json in $A" >&2; exit 1; }
P="$D.before-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$P"
for f in orders.json auction.json seats; do if [ -e "$D/$f" ]; then mv "$D/$f" "$P/"; fi; done
cp -R "$S"/. "$D"/
# The server runs as node (uid 1000) and must be able to write here.
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$D"; fi
echo "restored $A into $D (previous files: $P)"
