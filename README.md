# Agent Deck

A stream-deck view of your AI coding agents. Each key is one running agent;
it **blinks when that agent is halted on a decision**, and the touch strip
says what it needs. Press the key to jump to the agent's app.

Prototype status: an [OpenDeck](https://github.com/nekename/OpenDeck) plugin
(Stream Deck SDK format), developed on a Streonor S10 Pro (Mirabox N4 family:
10 LCD keys, 4 knobs, touch strip). No fork of OpenDeck yet — the plan is to
find out how far a plugin gets first.

```
Claude Code ──hook──▶ hooks/agent-deck-hook.sh ──HTTP──▶ plugin (127.0.0.1:47821)
                                                        │
                                OpenDeck ◀──WebSocket───┘──▶ S10 keys + touch strip
```

## What you see

| Key | Meaning |
|---|---|
| Blue **WORKING** | Agent is busy |
| Amber **NEEDS YOU**, blinking | Agent is waiting on a permission/decision |
| Green **DONE** | Finished its turn — your move |
| Slate **READY** | Session started, nothing asked yet |
| Dark number | Empty slot |

Slots fill in the order sessions start, so keys don't shuffle. The touch strip
features the most urgent agent (waiting first); turn any knob to cycle through
agents, push a knob or tap the strip to jump to the featured one.

## Setup (macOS)

Needs OpenDeck ≥ 2.14 with the device plugin for your deck (for the S10:
[opendeck-akp05](https://github.com/ambiso/opendeck-akp05)), and Node.js ≥ 22.

For a continuous touch strip on the S10, use the patched device plugin
(`~/Development/opendeck-akp05`, branch `s10-full-strip`): it sends the strip
as one 800×128 image to the strip's full-width slot instead of four gapped
tiles. Build with `cargo build --release` and copy `target/release/opendeck-akp05`
over `opendeck-akp05-mac` in OpenDeck's plugin folder (keep the original).
With the stock plugin the strip still works, with dark gaps between knobs.

```sh
npm test                 # unit tests
npm run dev-install      # symlink plugin into OpenDeck and restart it
```

In OpenDeck, drag **Agent Deck → Agent slot** onto the keys you want and
**Agent status strip** onto each of the four knobs.

Try it without real agents:

```sh
npm run simulate                 # four demo agents, one waiting
sh scripts/simulate.sh approve   # the waiting one gets its answer
sh scripts/simulate.sh clear
```

Live preview of what the deck should show: <http://127.0.0.1:47821/preview>
(state as JSON: `/agents`).

### Connect Claude Code

Merge [`hooks/claude-settings.example.json`](hooks/claude-settings.example.json)
into `~/.claude/settings.json` (all sessions) or a project's
`.claude/settings.json` (just that project). The hook script posts each event
to the plugin, adds which app the agent runs in (`__CFBundleIdentifier`,
`TERM_PROGRAM`, tty), never blocks for more than a second, and always exits 0.

Other tools can post the generic format instead:

```sh
curl -X POST http://127.0.0.1:47821/event -H 'Content-Type: application/json' \
  -d '{"session_id":"x1","cwd":"/path/project","state":"waiting","message":"Approve deploy?"}'
```

`state` is one of `working`, `waiting`, `done`, `idle`, or `ended` (removes it).

## Layout

| Path | What |
|---|---|
| `plugin/com.zacharyrubin.agentdeck.sdPlugin/` | The OpenDeck plugin (manifest, launcher, source, icons, strip layout) |
| `hooks/` | Claude Code hook script + example settings |
| `scripts/` | `dev-install.sh`, `simulate.sh` |
| `tests/` | `node --test` unit tests for state + rendering |
| `docs/s10-hardware.md` | What we learned about the S10's USB protocol |
| `tools/s10-probe/` | Python scripts that talk to the S10 directly (bypassing OpenDeck) |

## Known limits / open questions

- Jumping to an agent focuses its *app* (iTerm, Terminal, VS Code, Claude…), not the exact tab yet. The hook already records the tty for that.
- OpenDeck renders the strip as four 200×100 panels; the patched device plugin stitches and stretches them to the S10's 800×128, so the strip is effectively 100 rows of resolution. Each update currently sends the full strip once per panel (4 writes); batching would cut that to one.
- Blinking costs one image per frame through OpenDeck's renderer; fine at ~1.6 Hz, untested faster.
- State is in memory: restarting OpenDeck forgets agents until their next event.
- Answering an agent from the deck (approve/deny) isn't attempted yet.
