# Agent Deck

A stream-deck view of your AI coding agents. Each key is one running agent,
shown with the icon of the app it runs in; its icon **blinks larger and
smaller when that agent needs a decision or has finished**, and the touch
strip says what it needs. Press the
key to jump to the agent's app.

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
| Agent's app icon (Claude, a terminal…) + project name, steady | Agent is working, or ready and hasn't been asked anything |
| Icon blinking larger and smaller | Finished its turn — your move. Stops once you press its key |
| Icon blinking, project name in amber | Waiting on a permission/decision |
| App icon + app name | A running app (no agent needs this key); press to bring it to the front |
| Dim number | Empty slot |

The blink switches the icon between full size and 70% once a second (`PULSE`
in `src/render.mjs`). An agent with no app icon to show gets a letter tile
instead. Every key's background is pure black, so it matches the deck's own
black instead of glowing faintly.

Agents always get keys first, in the order sessions start. Keys no agent
needs show your most recently used apps that have a window open (apps with a
Dock icon; Finder, OpenDeck and any app an agent is running in are left out).
Every key keeps what it shows for as long as that stays on the deck, so keys
don't shuffle:

- A new agent takes an empty key, or else the key of the least recently used app.
- When an agent ends, its key goes to the most recently used app that isn't on the deck.
- Quit an app, or close its last window, and its key goes to the next most
  recent app with a window (or stays empty until one opens). Hidden, minimized
  and other-Space windows still count as open.
- Switching between apps already on the deck moves nothing. An app that comes
  to the front while off the deck replaces the least recently used app, in place.

The app list follows launches, quits and app switches as they happen
(`lsappinfo listen`, no extra permissions). Closing a window raises no event,
so a tiny Swift helper (`src/windows.swift`, compiled on first run into
`~/Library/Caches/agent-deck/`; needs the Xcode command line tools) checks the
window list once a second, using well under 1% of a core. Without the
command line tools, apps with no windows simply stay on the deck. While no app
is on it, the touch strip features the most urgent agent (waiting first), or
the one whose key you pressed; turn one of the first two knobs to cycle
through agents; push the second to jump to the featured one.

**Press an app key and the strip shows that app** until you press an agent's
key, which shows that agent instead. Agents finishing don't take it over, and
turning the first two knobs doesn't switch it back (a permission question
always takes the strip). It's re-read every 3 seconds while it's showing:

| App | Strip shows |
|---|---|
| Messages | **Conversation picker**: recent conversations with the last message and time, unread marked, starting on the open one; while you search, the open chat's latest messages |
| WhatsApp | **Chat picker**: recent chats with the last message, unread counts and the total unread |
| Notes | **Note picker**: recent notes with their dates |
| Chrome, Safari, Terminal, Finder… (any tab bar) | **Tab picker**: every open tab, starting on the current one (blue bar) |
| Anything else | Its window titles, the front one marked |

On a picker, six entries show at a time. Turn knob 2 to move the highlight
(it pages on past the sixth), and push knob 2 to open that tab, conversation,
chat or note and bring the app forward (on the one that's already open it
just brings the app forward: pressing an open conversation again would make
Messages open it in a window of its own). Only what the app has loaded can be
picked: Messages and WhatsApp list just the conversations on screen, about a
dozen. Lists are read from the app's first three windows, so a chat in its
own window doesn't hide the conversation list.

It's read through Accessibility (`src/context.swift`, the same permission the
knobs use), from the app's own window, so it only sees what that app has on
screen on the current desktop. Pushing knob 2 while an app is showing jumps
to that app (on a picker it opens the highlighted entry). `GET /context` shows what was read.

The knobs also control the computer:

- **First (leftmost) knob, push** to open an app by voice: the first push
  opens Spotlight (Cmd-Space) and starts Snaply dictation, so say what to
  open; push again to stop, and the words land in Spotlight's search box;
  **turn** it to move through the results; push a third time to open the
  highlighted one (Return). The strip shows which step you're on. Each step
  first checks Spotlight is still open, so if you closed it (Escape, a click
  elsewhere) nothing is pressed and the knob starts over; it also starts over
  after two minutes unused.

- **Third knob, turn** to scroll, like a mouse wheel, wherever the pointer is
  (down turning right).
- **Third knob, push** to start dictation in Snaply, push again to
  stop. It presses Snaply's own dictation shortcut (read from
  `~/.snaply/settings.json` each time). With Snaply set to *hold* (push-to-talk)
  the knob holds the key down until the next push (or any other key or knob
  push on the deck, or five minutes), so typing in between carries that
  modifier. A touch on the strip above this knob counts as a push too; with
  *toggle* or *combined* it just taps the key. If Snaply isn't running, the
  push opens it.
- **Fourth (rightmost) knob, turn** to move between fields in the app in front
  (Tab, or Shift-Tab turning left).
- **Fourth knob, push** to click whatever is highlighted: a focused button,
  link, checkbox or menu is pressed through Accessibility (the pointer doesn't
  move); with nothing pressable focused (a text box, a page) it's an ordinary
  click where the pointer is, without any key the dictation knob is holding.
- While an agent's permission question is on the strip, all four knobs answer
  it (the rightmost is **In terminal**).

Sending keys needs the Accessibility permission for **OpenDeck** (it launches
the plugin): macOS asks the first time you use the knob, or add it under System
Settings → Privacy & Security → Accessibility, then restart OpenDeck.

The deck goes dark while your Mac's displays sleep, so its screens aren't lit
all night, and lights up with the current state when they wake. A second
helper (`src/displays.swift`) reports display sleep and wake, and the plugin
asks OpenDeck to switch the deck (`opendeck --sleep-device` /
`--wake-device`, the same calls OpenDeck's own idle sleep uses). The S10's
sleep only dims its screens, so every key and the strip are drawn black just
before. Pressing a deck key while it's dark lights it up; if the displays are
still asleep it goes dark again within five minutes.

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
(state as JSON: `/agents`; running apps and what each key shows: `/apps`).

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
| `plugin/…/src/slots.mjs` | Which agent or app each key shows (agents first, sticky keys) |
| `plugin/…/src/apps.mjs` | Running-app discovery (`lsappinfo`), recency, icons, exclusions, window state |
| `plugin/…/src/windows.swift` | Window helper: reports which apps have windows open |
| `plugin/…/src/power.mjs` | Turns the deck off while the displays sleep, on when they wake |
| `plugin/…/src/displays.swift` | Display helper: reports display sleep and wake |
| `plugin/…/src/context.mjs` | What the strip says about the last app key pressed (`context.swift` reads it) |
| `plugin/…/src/controls.mjs` | What each knob does; third knob: scroll and dictation (Snaply); fourth knob: Tab between fields and click |
| `plugin/…/src/keys.swift` | Key helper: posts keystrokes for the right knob |
| `plugin/…/src/helpers.mjs` | Compiling the Swift helpers, keeping long-running helpers alive |
| `tests/` | `node --test` unit tests for state, slot allocation, app discovery, deck power, knob controls + rendering |
| `docs/s10-hardware.md` | What we learned about the S10's USB protocol |
| `tools/s10-probe/` | Python scripts that talk to the S10 directly (bypassing OpenDeck) |

## Known limits / open questions

- Jumping to an agent focuses its *app* (iTerm, Terminal, VS Code, Claude…), not the exact tab yet. The hook already records the tty for that.
- OpenDeck renders the strip as four 200×100 panels; the patched device plugin stitches and stretches them to the S10's 800×128, so the strip is effectively 100 rows of resolution. Each update currently sends the full strip once per panel (4 writes); batching would cut that to one.
- Blinking costs one image per frame through OpenDeck's renderer; fine at ~1.6 Hz, untested faster.
- State is in memory: restarting OpenDeck forgets agents until their next event.
- Answering permission requests from the deck (the `PermissionRequest` hook, `hooks/agent-deck-permission.sh`): the strip shows the tool and command with **Allow · Always allow · Deny · In terminal** above the four knobs; push a knob or tap that quarter of the strip. Verified with headless `claude -p`; not yet known whether Claude's own terminal prompt also shows while the deck holds the request.
