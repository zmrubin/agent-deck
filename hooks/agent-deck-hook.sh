#!/bin/sh
# Forwards one Claude Code hook event (JSON on stdin) to Agent Deck.
# Adds which app/terminal the agent runs in so a key press can jump back to it.
# Never blocks the agent for more than a second and always exits 0.

PORT="${AGENT_DECK_PORT:-47821}"
TTY="$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')"
[ "$TTY" = "??" ] && TTY=""   # no controlling terminal

curl -s -m 1 -o /dev/null -X POST "http://127.0.0.1:$PORT/event" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Source: claude-code' \
  -H "X-Agent-Bundle: ${__CFBundleIdentifier:-}" \
  -H "X-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Agent-TTY: ${TTY}" \
  --data-binary @- >/dev/null 2>&1

exit 0
