#!/usr/bin/env bash
#
# Jarvis installer — installs without the macOS Gatekeeper warning.
#
# Why this exists: the app is ad-hoc signed (no paid Apple notarization), so a
# browser-downloaded .dmg shows "Apple could not verify…". Files fetched with
# curl are NOT quarantined, so installing this way skips that prompt entirely.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Jarvis-broker/jarvis/master/scripts/install.sh | bash
#
set -euo pipefail

REPO="Jarvis-broker/jarvis"
APP="/Applications/Jarvis.app"
TMP="$(mktemp -d)"
VOL=""

cleanup() {
  [ -n "$VOL" ] && hdiutil detach "$VOL" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

say() { printf '\033[36m▸\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Это установщик только для macOS."

say "Ищу последнюю версию Jarvis…"
DMG_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o 'https://[^"]*universal\.dmg' | head -1)"
[ -n "$DMG_URL" ] || die "Не нашёл .dmg в последнем релизе $REPO."

say "Скачиваю: $(basename "$DMG_URL")"
curl -fsSL "$DMG_URL" -o "$TMP/Jarvis.dmg"

say "Монтирую образ…"
VOL="$(hdiutil attach "$TMP/Jarvis.dmg" -nobrowse -quiet | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/' | tail -1)"
[ -n "$VOL" ] && [ -d "$VOL/Jarvis.app" ] || die "Не смог смонтировать образ."

say "Ставлю в /Applications…"
rm -rf "$APP" 2>/dev/null || sudo rm -rf "$APP"
cp -R "$VOL/Jarvis.app" /Applications/ 2>/dev/null || sudo cp -R "$VOL/Jarvis.app" /Applications/

# Belt-and-suspenders: strip any quarantine flag so Gatekeeper stays silent.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

say "Запускаю Jarvis…"
open "$APP"

printf '\033[32m✓ Готово — Jarvis установлен и запущен.\033[0m\n'
