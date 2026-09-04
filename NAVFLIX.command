#!/usr/bin/env bash
# macOS: double-click this in Finder to launch NAVFLIX in Terminal.
# First time only, make it double-clickable:  chmod +x "NAVFLIX.command"
cd "$(dirname "$0")" || exit 1
bash ./start.sh
echo
echo "NAVFLIX has stopped. You can close this window."
