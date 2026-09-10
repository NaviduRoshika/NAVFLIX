#!/usr/bin/env bash
# NAVFLIX — launcher for Linux and macOS.
# Run it with:  ./start.sh      (or:  bash start.sh)

set -u
cd "$(dirname "$0")" || exit 1

# --- find node -------------------------------------------------------------
# A node carried in the app folder wins, so a portable drive runs on a machine
# with nothing installed.
#
# One folder cannot hold two platforms' binaries, so the Windows build lives in
# runtime/node/ (node.exe) and the Linux one in runtime/node-linux/. Looking only
# in runtime/node/ meant the Linux build was carried around and never once used.
# runtime/node/ is still searched last, as the place to drop any build by hand.
case "$(uname -s 2>/dev/null || echo Linux)" in
  Darwin) BUNDLES="./runtime/node-mac/bin/node ./runtime/node-darwin/bin/node ./runtime/node/bin/node ./runtime/node/node" ;;
  *)      BUNDLES="./runtime/node-linux/bin/node ./runtime/node/bin/node ./runtime/node/node" ;;
esac

NODE=""
BUNDLED=""
for candidate in $BUNDLES; do
  [ -f "$candidate" ] || continue
  [ -n "$BUNDLED" ] || BUNDLED="$candidate"     # remember the first that is there
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done

# A portable drive is almost always NTFS or exFAT, and neither stores a Unix
# permission bit — so a perfectly good binary arrives without its execute flag.
# Asking for it back costs nothing and usually works.
if [ -z "$NODE" ] && [ -n "$BUNDLED" ]; then
  chmod +x "$BUNDLED" 2>/dev/null
  [ -x "$BUNDLED" ] && NODE="$BUNDLED"
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

# The binary is present and sound, but the filesystem will not let anything on it
# be executed at all — an NTFS mount with fmask set, or plain noexec. chmod cannot
# argue with that, so copy it somewhere that will run it. Once, then remembered.
if [ -z "$NODE" ] && [ -n "$BUNDLED" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/navflix"
  # A stale copy is worse than none: if the one on the drive has been replaced,
  # its size will differ and the cached one is thrown away rather than trusted.
  if [ -x "$CACHE/node" ] \
     && [ "$(wc -c < "$CACHE/node" 2>/dev/null | tr -d ' ')" != "$(wc -c < "$BUNDLED" 2>/dev/null | tr -d ' ')" ]; then
    rm -f "$CACHE/node"
  fi
  if [ ! -x "$CACHE/node" ]; then
    echo
    echo "  This drive will not run programs directly, so the Node that came with"
    echo "  NAVFLIX is being copied to $CACHE."
    echo "  About 110 MB, once — after this it starts straight away."
    echo
    mkdir -p "$CACHE" && cp "$BUNDLED" "$CACHE/node" && chmod +x "$CACHE/node"
  fi
  [ -x "$CACHE/node" ] && NODE="$CACHE/node"
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
  echo "  Or drop a node binary in the app folder and it will be used:"
  echo "    Linux :  ./runtime/node-linux/bin/node"
  echo "    macOS :  ./runtime/node-mac/bin/node"
  echo "    Either:  ./runtime/node/bin/node"
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
