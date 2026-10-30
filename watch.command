#!/bin/zsh
set -eu
sonata_root="${0:A:h}"
if [[ $# -eq 0 ]]; then
  sonata_project=$(osascript -e 'POSIX path of (choose folder with prompt "Codex veya Claude ile çalıştığın proje klasörünü seç")') || exit 0
  set -- "$sonata_project"
fi
mkdir -p "$sonata_root/.build"
if [[ ! -x "$sonata_root/.build/piano" || "$sonata_root/Piano.swift" -nt "$sonata_root/.build/piano" ]]; then
  echo "Code Sonata · Piyano hazırlanıyor…"
  xcrun swiftc -swift-version 5 -O "$sonata_root/Piano.swift" -o "$sonata_root/.build/piano"
fi
exec python3 "$sonata_root/watch.py" "$@"
