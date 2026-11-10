#!/bin/sh
# Claude Code PermissionRequest hook: asks Agent Deck to answer a permission
# prompt. Sends the request (JSON on stdin) to the plugin and waits while the
# user picks Allow / Always allow / Deny / In terminal on the deck; prints the
# decision JSON the plugin returns.
#
# Prints nothing (= no decision, Claude Code handles the prompt itself) when
# the plugin isn't running, the user chooses "In terminal", or it times out.
# Configure the hook with "timeout": 600; the plugin gives up after 9 minutes.

PORT="${AGENT_DECK_PORT:-47821}"
TTY="$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')"
[ "$TTY" = "??" ] && TTY=""

curl -s -m 590 -X POST "http://127.0.0.1:$PORT/permission" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Source: claude-code' \
  -H "X-Agent-Bundle: ${__CFBundleIdentifier:-}" \
  -H "X-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Agent-TTY: ${TTY}" \
  --data-binary @- 2>/dev/null

exit 0
