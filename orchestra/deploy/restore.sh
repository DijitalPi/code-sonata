#!/bin/sh
# Put a backup archive back into the volume. Stop the server first: docker compose stop orchestra
#   ./restore.sh /var/backups/orchestra/2026-11-04.tgz && docker compose start orchestra
# The archive is checked before anything changes (one folder, its ledgers whole JSON; python3 reads them). The files
# it replaces are moved aside to DATA.before-<time>, not deleted, and put back if the restore stops half way. The
# server checks every order and bid again when it starts: "not read" in its log means payment stays closed.
set -eu
A=${1:?usage: restore.sh <archive.tgz>}; D=${DATA:-/srv/orchestra}
W=$(mktemp -d); P="$D.before-$(date +%Y%m%d-%H%M%S)"; N="$P.new"
moved=""; placed=""
undo() {
  for f in $placed; do rm -rf "${D:?}/$f"; done
  for f in $moved; do mv "$P/$f" "$D/"; done
  rmdir "$P" 2>/dev/null || true
}
trap 'code=$?; if [ "$code" -ne 0 ] && [ -n "$moved$placed" ]; then undo && echo "restore stopped; $D is as it was" >&2; fi; rm -rf "$W" "$N"' EXIT
tar -xzf "$A" -C "$W"
[ "$(find "$W" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] || { echo "$A: one folder expected" >&2; exit 1; }
S=$(find "$W" -mindepth 1 -maxdepth 1 -type d)
[ -n "$S" ] && [ -f "$S/orders.json" ] || { echo "no orders.json in $A" >&2; exit 1; }
python3 - "$S" <<'PY' || { echo "$A: its ledgers are not whole, nothing changed" >&2; exit 1; }
import json, os, sys
d = sys.argv[1]
with open(os.path.join(d, "orders.json")) as f:
    orders = json.load(f)
if not (isinstance(orders, dict) and isinstance(orders.get("orders"), list)):
    sys.exit("orders.json has no list of orders")
if os.path.exists(os.path.join(d, "auction.json")):
    with open(os.path.join(d, "auction.json")) as f:
        auction = json.load(f)
    if not (isinstance(auction, dict) and "auction" in auction):
        sys.exit("auction.json has no auction")
PY
cp -R "$S" "$N"   # next to the volume, on its disk: each part then goes in with one rename
mkdir -p "$P"
for f in orders.json auction.json seats; do
  if [ -e "$D/$f" ]; then mv "$D/$f" "$P/"; moved="$moved $f"; fi
done
for f in orders.json auction.json seats; do
  if [ -e "$N/$f" ]; then mv "$N/$f" "$D/"; placed="$placed $f"; fi
done
# The server runs as node (uid 1000) and must be able to write here.
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$D"; fi
echo "restored $A into $D (previous files: $P)"
