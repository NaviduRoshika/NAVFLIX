#!/usr/bin/env bash
# Installs NAVFLIX on Linux for the current user.
#
#   bash installer/linux/install.sh
#
# It copies NAVFLIX into ~/.local/share/navflix, adds it to the applications menu
# with its own icon, and puts a "navflix" command on your path. No root, nothing
# outside your home folder, and uninstall.sh undoes all of it.
#
# What you get is what Windows gets: click the menu entry and NAVFLIX opens in a
# window of its own; close the window and NAVFLIX stops, unless a film is still
# playing in VLC, in which case it waits for VLC to close so your place is saved.
#
# Your library is never touched: data/ in an existing install is left exactly as
# it is, so this doubles as the way to update.

set -eu

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/navflix"
BIN="$HOME/.local/bin"
DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

say() { printf '%s\n' "$*"; }

# --- what has to be there already ------------------------------------------
NODE="$(command -v node || command -v nodejs || true)"
if [ -z "$NODE" ]; then
  say ""
  say "  Node.js is not installed, and NAVFLIX runs on it."
  say ""
  say "    sudo apt install nodejs        # Ubuntu, Debian"
  say ""
  say "  Then run this again."
  exit 1
fi

NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say ""
  say "  Node.js $("$NODE" -v) is too old; NAVFLIX needs 18 or newer."
  say ""
  say "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  say "    sudo apt install -y nodejs"
  say ""
  exit 1
fi

if ! command -v vlc >/dev/null 2>&1 \
   && [ ! -x /snap/bin/vlc ] \
   && [ ! -x /var/lib/flatpak/exports/bin/org.videolan.VLC ]; then
  say ""
  say "  Heads up: VLC was not found, and playback needs it."
  say "    sudo apt install vlc"
  say ""
  say "  Installing anyway. You can set the path later under Settings."
fi

# --- copy the app -----------------------------------------------------------
say ""
say "Installing NAVFLIX into $APP"
mkdir -p "$APP"

# Everything but your data, and not the build tools either.
for f in server.js probe.js qr.js package.json LICENSE README.md start.sh; do
  [ -f "$SRC/$f" ] && cp -f "$SRC/$f" "$APP/$f"
done
rm -rf "$APP/public"
cp -r "$SRC/public" "$APP/public"
cp -f "$SRC/installer/launcher/navflix-launch.js" "$APP/navflix-launch.js"
chmod +x "$APP/start.sh" 2>/dev/null || true
mkdir -p "$APP/data"

VERSION="$("$NODE" -p "require('$APP/package.json').version" 2>/dev/null || echo '?')"

# --- the command ------------------------------------------------------------
mkdir -p "$BIN"
cat > "$BIN/navflix" <<EOF
#!/usr/bin/env bash
# Opens NAVFLIX. Written by installer/linux/install.sh.
exec "$NODE" "$APP/navflix-launch.js" "\$@"
EOF
chmod +x "$BIN/navflix"

# --- icon and menu entry ----------------------------------------------------
install -D -m 644 "$SRC/public/icon-512.png" "$ICONS/512x512/apps/navflix.png"
install -D -m 644 "$SRC/public/icon-192.png" "$ICONS/192x192/apps/navflix.png"
install -D -m 644 "$SRC/public/favicon-32.png" "$ICONS/32x32/apps/navflix.png"

mkdir -p "$DESKTOP"
cat > "$DESKTOP/navflix.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=NAVFLIX
Comment=Watch a folder of films as a series, one sitting at a time
Exec=$BIN/navflix
Icon=navflix
Terminal=false
Categories=AudioVideo;Video;Player;
StartupWMClass=NAVFLIX
EOF
chmod +x "$DESKTOP/navflix.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS" >/dev/null 2>&1 || true

# --- what just happened -----------------------------------------------------
say ""
say "NAVFLIX $VERSION installed."
say ""
say "  Open it        : look for NAVFLIX in your applications menu, or run: navflix"
say "  It stops       : when you close its window"
say "  Your library   : $APP/data  (kept if you install again, and by uninstall.sh)"
say "  Uninstall      : bash $SRC/installer/linux/uninstall.sh"
say ""

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    say "  Note: $BIN is not on your PATH, so the 'navflix' command will not be found"
    say "  until you add it. The menu entry works either way."
    say ""
    ;;
esac

if ! command -v google-chrome >/dev/null 2>&1 \
   && ! command -v chromium >/dev/null 2>&1 \
   && ! command -v chromium-browser >/dev/null 2>&1 \
   && ! command -v brave-browser >/dev/null 2>&1; then
  say "  Note: no Chrome or Chromium found. NAVFLIX will open in your usual browser"
  say "  instead of a window of its own, and closing that tab will not stop it; it"
  say "  stops by itself once nothing has used it for ten minutes."
  say "    sudo apt install chromium-browser"
  say ""
fi
