#!/usr/bin/env bash
# Removes the NAVFLIX that install.sh put in your home folder.
#
#   bash installer/linux/uninstall.sh
#
# Your library is kept unless you ask for it to go, so reinstalling picks up where
# you left off. Your films are never touched.

set -eu

APP="${XDG_DATA_HOME:-$HOME/.local/share}/navflix"
BIN="$HOME/.local/bin/navflix"
DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/navflix.desktop"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

say() { printf '%s\n' "$*"; }

# Stop it first, or the files would go while it is still running.
if [ -x "$BIN" ]; then
  "$BIN" --quit >/dev/null 2>&1 || true
  sleep 1
fi

rm -f "$BIN" "$DESKTOP"
rm -f "$ICONS/512x512/apps/navflix.png" "$ICONS/192x192/apps/navflix.png" "$ICONS/32x32/apps/navflix.png"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS" >/dev/null 2>&1 || true

if [ -d "$APP" ]; then
  find "$APP" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
fi

say ""
say "NAVFLIX removed from the menu, and its program files deleted."

if [ -d "$APP/data" ]; then
  say ""
  say "Your library, progress and backups are still in:"
  say "  $APP/data"
  say ""
  printf 'Delete those too? [y/N] '
  read -r answer || answer=n
  case "$answer" in
    y|Y|yes|YES)
      rm -rf "$APP"
      rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/navflix"
      say "Deleted."
      ;;
    *)
      say "Kept. Install NAVFLIX again and it carries on where you left off."
      ;;
  esac
fi
say ""
