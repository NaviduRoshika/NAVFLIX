#!/usr/bin/env bash
# NAVFLIX — launcher for Linux and macOS.
# Run it with:  ./start.sh      (or:  bash start.sh)

set -u
cd "$(dirname "$0")" || exit 1

# --- find node -------------------------------------------------------------
# A node carried in the app folder wins, so a portable drive runs on a machine
# with nothing installed.
NODE=""
if [ -x "./runtime/node/bin/node" ]; then
  NODE="./runtime/node/bin/node"
elif [ -x "./runtime/node/node" ]; then
  NODE="./runtime/node/node"
fi

if [ -z "$NODE" ]; then
  for candidate in node nodejs; do
    if command -v "$candidate" >/dev/null 2>&1; then NODE="$candidate"; break; fi
  done
fi

# nvm / fnm / volta users often have node outside a non-interactive PATH
if [ -z "$NODE" ]; then
  for guess in \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node
  do
    if [ -x "$guess" ]; then NODE="$guess"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo
  echo "  Node.js was not found."
  echo
  echo "    Debian/Ubuntu :  sudo apt install nodejs"
  echo "    Fedora        :  sudo dnf install nodejs"
  echo "    Arch          :  sudo pacman -S nodejs"
  echo "    macOS         :  brew install node"
  echo "    Any platform  :  https://nodejs.org"
  echo
  echo "  Or drop a node binary at  ./runtime/node/bin/node  and it will be used."
  echo
  exit 1
fi

# --- warn early if VLC is missing -----------------------------------------
if [ ! -x "./runtime/vlc/vlc" ] \
   && ! command -v vlc >/dev/null 2>&1 \
   && [ ! -x /Applications/VLC.app/Contents/MacOS/VLC ] \
   && [ ! -x /snap/bin/vlc ] \
   && [ ! -x /var/lib/flatpak/exports/bin/org.videolan.VLC ]; then
  echo
  echo "  Heads up: VLC was not found. Playback needs it."
  echo
  echo "    Debian/Ubuntu :  sudo apt install vlc"
  echo "    Fedora        :  sudo dnf install vlc"
  echo "    Arch          :  sudo pacman -S vlc"
  echo "    macOS         :  brew install --cask vlc"
  echo
  echo "  Starting anyway — you can set the VLC path under Settings."
fi

exec "$NODE" server.js
