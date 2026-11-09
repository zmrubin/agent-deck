#!/bin/sh
# Symlink the plugin into OpenDeck's plugin folder and restart OpenDeck,
# so edits in this repo take effect on the next restart.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="com.zacharyrubin.agentdeck.sdPlugin"
SRC="$REPO/plugin/$NAME"
case "$(uname)" in
  Darwin) DEST_DIR="$HOME/Library/Application Support/opendeck/plugins" ;;
  *)      DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/plugins" ;;
esac

mkdir -p "$DEST_DIR"
if [ -e "$DEST_DIR/$NAME" ] && [ ! -L "$DEST_DIR/$NAME" ]; then
  echo "Refusing to replace a real folder at $DEST_DIR/$NAME (remove it first)." >&2
  exit 1
fi
ln -sfn "$SRC" "$DEST_DIR/$NAME"
chmod +x "$SRC/bin/launch.sh" "$REPO/hooks/agent-deck-hook.sh"
echo "linked $DEST_DIR/$NAME -> $SRC"

if [ "$(uname)" = Darwin ]; then
  osascript -e 'quit app "OpenDeck"' 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq opendeck || break; sleep 0.5; done
  open -a OpenDeck
  echo "restarted OpenDeck"
fi
