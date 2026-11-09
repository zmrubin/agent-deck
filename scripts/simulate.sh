#!/bin/sh
# Fake a few agents so you can see the deck without running real ones.
#   scripts/simulate.sh          # start the demo agents
#   scripts/simulate.sh approve  # the waiting agent gets its answer
#   scripts/simulate.sh clear    # remove all demo agents
PORT="${AGENT_DECK_PORT:-47821}"
post() { curl -s -m 2 -X POST "http://127.0.0.1:$PORT/event" -H 'Content-Type: application/json' -d "$1"; }

case "${1:-start}" in
  start)
    post '{"session_id":"demo-1","cwd":"/Users/me/code/agent-deck","state":"working","message":"Bash: npm test"}'
    post '{"session_id":"demo-2","cwd":"/Users/me/code/billing-api","state":"waiting","message":"Claude needs your permission to use Bash: git push --force origin main"}'
    post '{"session_id":"demo-3","cwd":"/Users/me/code/website","state":"done","message":"Finished — your turn"}'
    post '{"session_id":"demo-4","cwd":"/Users/me/code/infra","state":"idle","message":"Ready"}'
    ;;
  approve)
    post '{"session_id":"demo-2","state":"working","message":"Bash: git push --force origin main"}'
    ;;
  clear)
    for i in 1 2 3 4; do post "{\"session_id\":\"demo-$i\",\"state\":\"ended\"}"; done
    ;;
  *) echo "usage: $0 [start|approve|clear]" >&2; exit 2 ;;
esac
curl -s -m 2 "http://127.0.0.1:$PORT/agents" | head -c 2000; echo
