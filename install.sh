#!/bin/zsh
# Code Sonata kurulumu. Yalnız ev klasörüne yazar; açılışta kendiliğinden başlayan servis kurmaz.
#
#   ./install.sh             kur ya da güncelle (güncellemeden sonra yeniden çalıştır)
#   ./install.sh --link      geliştirici: repodaki dosyaları doğrudan kullan (kopya alma)
#   ./install.sh --kaldir    kaldır (eklediğin MIDI şarkıları kalır; --hepsi onları da siler)
set -eu
root="${0:A:h}"
home="$HOME/Library/Application Support/code-sonata"
bin="$home/bin"
mode="${1:-}"

if [[ "$mode" == "--kaldir" ]]; then
  python3 "$root/skill/scripts/control.py" stop >/dev/null 2>&1 || true
  pkill -f "code-sonata/bin/menubar" 2>/dev/null || true
  for dir in "$HOME/.claude/skills/code-sonata" "$HOME/.codex/skills/code-sonata"; do
    if [[ -L "$dir/SKILL.md" ]]; then rm -rf "$dir"; echo "Kaldırıldı: $dir"; fi
  done
  rm -rf "$bin" "$home/app" "$HOME/Library/Caches/code-sonata"
  if [[ "${2:-}" == "--hepsi" ]]; then rm -rf "$home"; echo "Eklediğin şarkılar da silindi."
  else rmdir "$home" 2>/dev/null || echo "Eklediğin şarkılar duruyor: $home/songs (silmek için: ./install.sh --kaldir --hepsi)"; fi
  echo "Code Sonata kaldırıldı."
  exit 0
fi

command -v xcrun >/dev/null || { echo "Önce Xcode Command Line Tools: xcode-select --install"; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "Python 3.9 ya da yenisi gerekli."; exit 1; }

# macOS, arka planda çalışan bir programın Masaüstü, Belgeler, İndirilenler ve iCloud Drive'daki
# dosyaları açmasını izne bağlar; arka plan servisi bu soruyu gösteremeyip takılabilir. Repo böyle
# bir yerdeyse çalışan kopya ~/Library/Application Support/code-sonata/app altına alınır.
app="$root"
case "$root" in
  "$HOME"/Desktop/*|"$HOME"/Documents/*|"$HOME"/Downloads/*|"$HOME"/Library/Mobile\ Documents/*)
    if [[ "$mode" != "--link" ]]; then
      app="$home/app"
      rm -rf "$app"
      mkdir -p "$app/orchestra/web" "$app/skill"
      cp "$root"/{agents,reader,conductor,melodies,sonata,songbook,watch,demo}.py "$root"/{Piano,MenuBar}.swift "$app/"
      cp "$root"/orchestra/web/{songs,styles,flow}.mjs "$app/orchestra/web/"
      cp -R "$root/skill/scripts" "$root"/skill/SKILL.*.md "$app/skill/"
      echo "Repo korunan bir klasörde; çalışan kopya: $app (değişiklikten sonra ./install.sh'i yeniden çalıştır)"
    fi ;;
esac

mkdir -p "$bin" "$root/.build"
echo "Ses motoru ve menü çubuğu derleniyor…"
xcrun swiftc -swift-version 5 -O "$app/Piano.swift" -o "$bin/piano"
xcrun swiftc -swift-version 5 -O "$app/MenuBar.swift" -o "$bin/menubar"
cp "$bin/piano" "$root/.build/piano"   # demo ve klasör modu Terminal'den repodaki kopyayı kullanır

# Skill: kopya değil bağlantı; control.py çalışan kopyayı (ya da repoyu) kendisi bulur.
link() {  # $1 skills klasörü, $2 o aracın SKILL dosyası
  local dir="$1/code-sonata" stamp
  stamp=$(date +%Y%m%d%H%M%S)
  mkdir -p "$dir"
  for name in SKILL.md scripts; do   # eski elle kopyalanmış kurulum silinmez, kenara alınır
    if [[ -e "$dir/$name" && ! -L "$dir/$name" ]]; then mv "$dir/$name" "$dir/$name.eski-$stamp"; echo "Eski kopya kenara alındı: $dir/$name.eski-$stamp"; fi
  done
  ln -sfn "$app/skill/$2" "$dir/SKILL.md"
  ln -sfn "$app/skill/scripts" "$dir/scripts"
  echo "Skill bağlandı: $dir"
}
link "$HOME/.claude/skills" SKILL.claude.md
if [[ -d "$HOME/.codex" ]]; then link "$HOME/.codex/skills" SKILL.codex.md; fi

python3 "$app/skill/scripts/control.py" doctor || true
cat <<EOF

Hazır. Claude Code ya da Codex'e "kod müziğini aç" de, veya:
  python3 "$app/skill/scripts/control.py" start --style 8bit
Kaldırmak için: ./install.sh --kaldir

İsteğe bağlı: Claude izin ya da cevap beklerken çan çalsın diye ~/.claude/settings.json içindeki
"hooks" bölümüne bir Notification kancası ekleyebilirsin; komutu:
  echo wait >> ~/Library/Caches/code-sonata/commands
EOF
