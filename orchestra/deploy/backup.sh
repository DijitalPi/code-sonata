#!/bin/sh
# Daily backup of the seat sale: orders and coupon codes, the auction, logos. Run as root from cron:
#   15 4 * * * root /srv/code-sonata/orchestra/deploy/backup.sh
# DATA is the volume, BACKUPS the local archives (KEEP_DAYS days), REMOTE an rclone target off this machine
# (an encrypted remote, e.g. rclone crypt). REMOTE="" keeps the archive here only.
# Buyers' e-mails and payment ids are in it: everything it makes is readable by its owner only, and a run that
# fails leaves neither its copy nor a part of an archive behind.
set -eu
umask 077
D=${DATA:-/srv/orchestra}; K=${BACKUPS:-/var/backups/orchestra}; R=${REMOTE-yedek-sifreli:orchestra/}
G=$(date +%F); T="$K/$G"
trap 'rm -rf "${T:?}" "$T.tgz.part"' EXIT
mkdir -p "$T"
# JSON first, logos after: an order is written after its logo, so every order in the copy has its logo.
# The ledger is written to a temporary file and renamed, so each copy is whole.
cp "$D/orders.json" "$T/"
if [ -f "$D/auction.json" ]; then cp "$D/auction.json" "$T/"; fi
if [ -d "$D/seats" ]; then cp -R "$D/seats" "$T/"; fi
tar -czf "$T.tgz.part" -C "$K" "$G"
mv "$T.tgz.part" "$T.tgz"
if [ -n "$R" ]; then rclone copy "$T.tgz" "$R"; fi
find "$K" -name '*.tgz' -mtime +"${KEEP_DAYS:-30}" -delete
echo "$T.tgz"
