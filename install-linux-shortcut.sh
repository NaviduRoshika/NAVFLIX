#!/usr/bin/env bash
# Adds "NAVFLIX" to your Linux application menu.
# Run once:  bash install-linux-shortcut.sh
# Undo with: rm ~/.local/share/applications/navflix.desktop

set -eu

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME/.local/share/applications"
DEST="$DEST_DIR/navflix.desktop"

chmod +x "$APP_DIR/start.sh"
mkdir -p "$DEST_DIR"

cat > "$DEST" <<EOF
[Desktop Entry]
Type=Application
Name=NAVFLIX
Comment=Watch a movie folder as a series, one timed episode a day
Exec=$APP_DIR/start.sh
Path=$APP_DIR
Terminal=true
Categories=AudioVideo;Video;Player;
EOF

chmod +x "$DEST"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DEST_DIR" || true

echo "Installed: $DEST"
echo "Look for \"NAVFLIX\" in your application menu."
