#!/bin/zsh
set -eu
sonata_root="${0:A:h}"
if [[ "${1:-}" != "--editor" ]]; then
  exec "$sonata_root/watch.command" "$@"
fi
shift
mkdir -p "$sonata_root/.build"
if [[ ! -x "$sonata_root/.build/piano" || "$sonata_root/Piano.swift" -nt "$sonata_root/.build/piano" ]]; then
  echo "Code Sonata · Piyano hazırlanıyor…"
  xcrun swiftc -swift-version 5 -O "$sonata_root/Piano.swift" -o "$sonata_root/.build/piano"
fi
exec python3 "$sonata_root/sonata.py" "$@"
