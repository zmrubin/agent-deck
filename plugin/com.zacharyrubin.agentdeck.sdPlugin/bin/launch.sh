#!/bin/sh
# OpenDeck starts plugins with a minimal PATH (no ~/.local/bin, no Homebrew),
# so find a Node.js >= 22 ourselves. Override with AGENT_DECK_NODE.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$DIR/src/main.mjs"

for n in "$AGENT_DECK_NODE" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then
    exec "$n" "$MAIN" "$@"
  fi
done

# Last resort: ask a login shell, which loads the user's PATH.
exec /bin/zsh -lc 'exec node "$0" "$@"' "$MAIN" "$@"
