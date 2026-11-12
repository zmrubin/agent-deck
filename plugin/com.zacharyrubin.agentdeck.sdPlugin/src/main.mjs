// Agent Deck plugin entry point.
//
// Two connections:
//   1. OpenDeck (Stream Deck SDK WebSocket) – receives key/knob events, sends
//      key images (setImage) and touch-strip panels (setFeedback).
//   2. A localhost HTTP endpoint agents report to (see hooks/):
//        POST /event        Claude Code hook JSON, or the generic format in agents.mjs
//        POST /permission   PermissionRequest hook JSON; held open until the user
//                           answers on the deck, then returns the hook's output
//        POST /decide       {"session_id", "choice"} answer a pending request (testing)
//        GET  /agents       current state as JSON
//        GET  /apps         running apps (most recent first) and what each key shows
//        GET  /context      the app the strip is showing (last app key pressed) and what it says
//        GET  /preview      live browser preview of the deck
//
// Keys: every agent gets a key first; keys left over show running apps
// (apps.mjs), with assignments kept stable by slots.mjs.
//
// Agent keys show the icon of the app the agent runs in; a key pulses while
// its agent needs a decision, or has finished and you haven't pressed its key
// since (render.mjs).
//
// Strip: pressing an app key shows that app's context there (context.mjs:
// recent messages, tabs, windows…) until an agent key is pressed, which shows
// that agent instead. A permission question always takes the strip.
//
// The deck goes dark while the Mac's displays sleep (power.mjs). The knobs
// control the computer (controls.mjs): push the first to open Spotlight and
// dictate, again to stop, turn it through the results and push a third time
// to open one; while the strip lists an app's tabs, conversations, chats or
// notes, the second picks one (turn to move, push to open); turn the third to
// scroll, push it to dictate with Snaply; turn the fourth to move between
// fields, push it to click.
//
// Run without OpenDeck (`node src/main.mjs`) to use just the HTTP side + preview.

import http from "node:http";
import { execFile } from "node:child_process";
import { AgentStore, displayNames } from "./agents.mjs";
import { AppWatcher, TERM_APPS, activateApp, appsForDeck, hostApp } from "./apps.mjs";
import { AppReads, ContextReader, moveCursor, pickCursor } from "./context.mjs";
import { Controls, SNAPLY_BUNDLE, knobPush, knobTurn } from "./controls.mjs";
import { PermissionBroker } from "./permissions.mjs";
import { DeckPower } from "./power.mjs";
import { CHOICES, PULSE, appKeySvg, blankKeySvg, blankPanelSvg, keySvg, stripPanels, svgDataUrl, wantsAttention } from "./render.mjs";
import { allocate } from "./slots.mjs";

const SLOT = "com.zacharyrubin.agentdeck.slot";
const STRIP = "com.zacharyrubin.agentdeck.strip";
const HTTP_PORT = Number(process.env.AGENT_DECK_PORT || 47821);
const PULSE_MS = 500; // one blink frame (render.mjs PULSE): larger, smaller, once a second
const PRUNE_AFTER_MS = 12 * 60 * 60 * 1000;
const PREVIEW_SLOTS = 10;
const BLANK_MS = 1000; // time for black images to reach the deck before it sleeps
const CONTEXT_REFRESH_MS = 3000; // re-read the app on the strip this often
const SLOW_READ_MS = 2000; // log reads slower than this

const log = (...a) => console.log(new Date().toISOString(), ...a);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-") && i + 1 < argv.length) o[argv[i].replace(/^-+/, "")] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const store = new AgentStore();
const contexts = new Map(); // context -> { action, device, row, column }
const lastSent = new Map(); // context -> last payload JSON (skip identical updates)
const layouts = new Map(); // device (or "preview") -> what each slot key shows: "agent:<id>" | "app:<key>" | null
const apps = new AppWatcher({ onChange: () => render(), log });
const decks = new Set(); // ids of the decks OpenDeck has told us about
const power = new DeckPower({
  devices: () => [...decks],
  beforeSleep: () => {
    for (const [ctx, c] of contexts) {
      if (c.action === SLOT) push(ctx, "setImage", { image: svgDataUrl(blankKeySvg()), target: 0 });
      else if (c.action === STRIP) push(ctx, "setFeedback", { canvas: blankPanelSvg() });
    }
    return new Promise((r) => setTimeout(r, BLANK_MS));
  },
  onWake: () => {
    lastSent.clear(); // whatever was sent while it slept was dropped
    render();
  },
  log,
});
const controls = new Controls({
  log,
  // Unknown until the app list loads: try the key anyway.
  isRunning: () => !apps.apps.length || apps.apps.some((a) => a.bundleId === SNAPLY_BUNDLE),
  launch: () => execFile("open", ["-g", "-b", SNAPLY_BUNDLE], (err) => err && log("couldn't open Snaply:", err.message)),
  onChange: () => render(), // the launcher's step shows on the strip
});
let ws = null;
let frame = 0; // pulse frame for keys that want attention
const seenDone = new Map(); // agent id -> stateSince of the finish you saw (pressed its key)
let featuredShift = 0;
let focusApp = null; // key of the app whose key was pressed last: the strip shows it
const appContext = new Map(); // app key -> { summary, items } from context.mjs
const reader = new ContextReader({ log });
const reads = new AppReads({
  read: (app) => reader.read(app),
  settled(app, { context, error, ms, again }) {
    if (error) {
      log(`context: couldn't read ${app.name}:`, error.message);
      if (!appContext.has(app.key)) appContext.set(app.key, { summary: "Couldn't read this app", items: [] });
    } else appContext.set(app.key, context);
    if (ms > SLOW_READ_MS) log(`context: reading ${app.name} took ${ms} ms`);
    render();
    if (again) refreshContext({ soon: true });
  },
});
let pick = null; // picker cursor: { app, index, title, group } (context.mjs pickCursor)

const broker = new PermissionBroker({
  onChange(agentId, request) {
    store.setRequest(agentId, request);
    if (request) featuredShift = 0; // new decision: feature it on the strip
    render();
  },
});
// Once Claude moves on (answered in the terminal, next tool, turn over), a held request is stale.
const RELEASE_ON = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionEnd"]);

/** Knob / strip-section press while the featured agent has a pending request. */
function chooseFromDeck(agent, dial) {
  const choice = CHOICES[dial]?.key;
  if (!choice) return;
  if (choice === "terminal") {
    broker.release(agent.id, "user chose terminal");
    activate(agent);
  } else if (!broker.decide(agent.id, choice)) {
    log(`choice ${choice} not available for ${agent.id}`);
  } else {
    log(`answered ${agent.id}: ${choice}`);
  }
}

// ---------------------------------------------------------------- rendering

function names() {
  const agents = store.ordered();
  const n = displayNames(agents);
  return new Map(agents.map((a, i) => [a.id, n[i]]));
}

function featured() {
  const list = store.byUrgency();
  if (!list.length) return { agent: null, index: 0, total: 0 };
  const i = ((featuredShift % list.length) + list.length) % list.length;
  return { agent: list[i], index: i, total: list.length };
}

/** The app the strip shows: the last app key pressed, while it runs and no agent asks a permission question. */
function stripApp() {
  if (!focusApp || store.ordered().some((a) => a.request)) return null;
  return apps.get(focusApp) || null;
}

/**
 * The strip's picker, when the app on it lists tabs, conversations, chats or
 * notes: { app, picks, cursor } (cursor kept on the same entry).
 */
function stripPicks() {
  const app = stripApp();
  const picks = app && appContext.get(app.key)?.picks;
  if (!picks?.length) return null;
  pick = { app: app.key, ...pickCursor(pick?.app === app.key ? pick : null, picks) };
  return { app, picks, cursor: pick.index };
}

/** Knob 1 pushed on the picker: open that tab, conversation, chat or note and bring the app forward. */
async function openPick(app, p) {
  try {
    const r = await reader.open(app, p);
    if (!r.pressed) log(`context: couldn't open "${p.title}" in ${app.name}`);
  } catch (err) {
    log(`context: couldn't open "${p.title}" in ${app.name}:`, err.message);
  }
  activateApp(app, log);
  setTimeout(() => refreshContext({ soon: true }), 300);
}

/**
 * Re-read the app on the strip (AppReads: each app on its own, so switching
 * app keys never waits behind a slow read of the last app). `soon`: the app
 * was just pressed or changed, so if it's being read already, read it again.
 */
function refreshContext({ soon = false } = {}) {
  const app = stripApp();
  if (app && !power.asleep) reads.request(app, { soon });
}

function slotContexts(device) {
  return [...contexts]
    .filter(([, c]) => c.action === SLOT && c.device === device)
    .sort(([, a], [, b]) => a.row - b.row || a.column - b.column)
    .map(([ctx]) => ctx);
}

/** Assign agents (first) and apps to `count` keys, keeping each key's previous occupant where possible. */
function layout(device, count) {
  const agents = store.ordered();
  const ids = allocate({
    count,
    agents: agents.map((a) => `agent:${a.id}`),
    apps: appsForDeck(apps.apps, agents).map((a) => `app:${a.key}`),
    prev: layouts.get(device),
  });
  layouts.set(device, ids);
  return ids;
}

/** What a layout id refers to right now. */
function resolve(id) {
  if (id?.startsWith("agent:")) return { agent: store.agents.get(id.slice(6)) };
  if (id?.startsWith("app:")) return { app: apps.get(id.slice(4)) };
  return {};
}

/** Whether you've pressed this agent's key since it last finished. */
const seen = (agent) => agent.state === "done" && seenDone.get(agent.id) === agent.stateSince;
const pulsing = () => store.ordered().some((a) => wantsAttention(a, seen(a)));

function scene() {
  const agents = store.ordered();
  const nm = names();
  const keyFor = (id, i) => {
    const { agent, app } = resolve(id);
    if (app) return appKeySvg({ app });
    if (!agent) return keySvg({ slot: i + 1 });
    const icon = hostApp(apps.apps, agent)?.icon ?? null;
    return keySvg({ agent, name: nm.get(agent.id), slot: i + 1, icon, frame, seen: seen(agent) });
  };
  const f = featured();
  const app = stripApp();
  const pending = agents.some((a) => a.request); // a permission question takes the strip over the launcher
  const strip = stripPanels({
    agent: f.agent, name: f.agent && nm.get(f.agent.id), index: f.index, total: f.total, counts: store.counts(),
    ...(app && { app, context: appContext.get(app.key) ?? null, cursor: stripPicks()?.cursor }),
    ...(!pending && controls.launcher !== "idle" && { launcher: controls.launcher }),
  });
  return { keyFor, strip, agents, featured: f };
}

function push(context, event, payload) {
  const key = JSON.stringify(payload);
  if (lastSent.get(context) === key) return;
  lastSent.set(context, key);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, context, payload }));
}

function render() {
  if (!contexts.size || power.asleep) return; // a sleeping deck drops images; redrawn on wake
  const { keyFor, strip } = scene();
  for (const device of new Set([...contexts.values()].map((c) => c.device))) {
    const slots = slotContexts(device);
    const ids = layout(device, slots.length);
    slots.forEach((ctx, i) => push(ctx, "setImage", { image: svgDataUrl(keyFor(ids[i], i)), target: 0 }));
  }
  for (const [ctx, c] of contexts) {
    if (c.action === STRIP) push(ctx, "setFeedback", { canvas: strip[c.column % 4] });
  }
}

// ---------------------------------------------------------------- actions

function activate(agent) {
  if (!agent) return;
  if (process.platform !== "darwin") return log("activate: only implemented on macOS");
  const argv = agent.bundleId ? ["-b", agent.bundleId] : TERM_APPS[agent.termProgram] ? ["-a", TERM_APPS[agent.termProgram]] : null;
  if (!argv) return log(`activate: no app known for ${agent.id}`);
  execFile("open", argv, (err) => err && log("activate failed:", err.message));
}

// ---------------------------------------------------------------- OpenDeck

function onDeckMessage(msg) {
  const c = msg.payload?.coordinates || {};
  switch (msg.event) {
    case "willAppear":
      contexts.set(msg.context, { action: msg.action, device: msg.device, row: c.row ?? 0, column: c.column ?? 0 });
      decks.add(msg.device);
      lastSent.delete(msg.context);
      render();
      break;
    case "willDisappear":
      contexts.delete(msg.context);
      lastSent.delete(msg.context);
      render();
      break;
    case "keyDown": {
      if (msg.action !== SLOT) break;
      const i = slotContexts(msg.device).indexOf(msg.context);
      const { agent, app } = resolve(layouts.get(msg.device)?.[i]); // what the key shows now
      log(`deck: key ${i + 1} → ${app ? app.name : agent ? `agent ${names().get(agent.id)} (${agent.state})` : "empty"}`);
      controls.letGo("another key pushed"); // a dictation key held down mustn't outlast other use of the deck
      if (app) {
        activateApp(app, log);
        focusApp = app.key; // the strip shows this app until an agent takes over
        pick = null; // the picker starts on the current tab or conversation
        render();
        refreshContext({ soon: true });
        break;
      }
      // Jumping to the agent hands any pending question back to its own dialog.
      if (agent && broker.get(agent.id)) broker.release(agent.id, "user jumped to agent");
      if (agent) {
        focusApp = null; // the strip shows this agent instead of an app
        if (agent.state === "done") seenDone.set(agent.id, agent.stateSince); // its key stops pulsing
        const at = store.byUrgency().findIndex((a) => a.id === agent.id);
        if (at >= 0) featuredShift = at; // and the strip features that agent
        render();
      }
      activate(agent);
      break;
    }
    case "dialRotate": {
      const ticks = msg.payload?.ticks || 0;
      const list = stripPicks();
      const what = knobTurn(c.column ?? 0, { list: !!list, app: !!stripApp(), launcher: controls.launcher !== "idle" });
      if (what === "fields") controls.tab(ticks); // move between fields in the front app
      else if (what === "scroll") controls.scroll(ticks); // wheel where the pointer is
      else if (what === "launcher") controls.launcherTurn(ticks); // through Spotlight's results
      else if (what === "pick") {
        pick = { app: list.app.key, ...moveCursor(pick, list.picks, ticks) };
        render();
      } else if (what === "agents") {
        featuredShift += Math.sign(ticks);
        render();
      } // "none": an app is on the strip and stays until an agent key is pressed
      break;
    }
    case "dialDown":
    case "touchTap": {
      const agent = featured().agent;
      const column = c.column ?? 0;
      // A pending decision owns all four knobs (its choices sit above them).
      const list = stripPicks();
      const what = knobPush(column, { pending: !!(agent && broker.get(agent.id)), touch: msg.event === "touchTap", list: !!list });
      log(`deck: knob ${column + 1} ${msg.event === "touchTap" ? "tap" : "push"} → ${what}`);
      if (what !== "dictate" && what !== "launch") controls.letGo("another knob pushed"); // the launcher stops its own
      if (what === "choose") chooseFromDeck(agent, column);
      else if (what === "launch") controls.launcherPush();
      else if (what === "open") openPick(list.app, list.picks[list.cursor]);
      else if (what === "dictate") controls.dictate();
      else if (what === "click") controls.click();
      else if (stripApp()) activateApp(stripApp(), log); // jump to what the strip shows
      else activate(agent);
      break;
    }
    case "deviceDidConnect":
      decks.add(msg.device);
      power.noteDevice(msg.device); // OpenDeck lights a deck up when it connects
      lastSent.clear();
      render();
      break;
    case "deviceDidDisconnect":
      decks.delete(msg.device);
      break;
    case "systemDidWakeUp":
      lastSent.clear();
      render();
      break;
  }
}

function connectDeck() {
  ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
    log(`registered with OpenDeck as ${args.pluginUUID}`);
  });
  ws.addEventListener("message", (e) => {
    try {
      onDeckMessage(JSON.parse(e.data));
    } catch (err) {
      log("bad message from OpenDeck:", err.message);
    }
  });
  ws.addEventListener("close", () => {
    log("OpenDeck connection closed; exiting");
    process.exit(0);
  });
  ws.addEventListener("error", (e) => log("websocket error:", e.message || e.type));
}

// ---------------------------------------------------------------- HTTP

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
}

const PREVIEW_HTML = `<!doctype html><meta charset="utf-8"><title>Agent Deck preview</title>
<style>
  body{margin:0;padding:24px;background:#16181c;color:#cbd5e1;font:14px -apple-system,Helvetica,sans-serif}
  .deck{display:inline-block;background:#000;padding:18px;border-radius:14px}
  .keys{display:grid;grid-template-columns:repeat(5,112px);gap:14px}
  .keys img{width:112px;height:112px;border-radius:8px;display:block}
  .strip{display:flex;margin-top:18px}
  .strip img{width:154px;height:98.56px;display:block} /* 200x100 panels shown at the real 800x128 aspect */
  pre{max-width:900px;white-space:pre-wrap;color:#94a3b8}
</style>
<h3>Agent Deck — live preview</h3>
<div class="deck"><div class="keys" id="keys"></div><div class="strip" id="strip"></div></div>
<pre id="agents"></pre>
<script>
async function tick(){
  try{
    const r = await fetch('/preview.json'); const d = await r.json();
    const fill=(id,urls)=>{const el=document.getElementById(id);
      while(el.children.length<urls.length) el.appendChild(document.createElement('img'));
      urls.forEach((u,i)=>{ if(el.children[i].src!==u) el.children[i].src=u; });};
    fill('keys', d.keys); fill('strip', d.strip);
    document.getElementById('agents').textContent = JSON.stringify(d.agents, null, 2);
  }catch(e){}
  setTimeout(tick, 250);
}
tick();
</script>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/event") {
      const evt = JSON.parse(await readBody(req));
      const meta = {
        source: req.headers["x-agent-source"],
        bundleId: req.headers["x-agent-bundle"],
        termProgram: req.headers["x-term-program"],
        tty: req.headers["x-agent-tty"],
      };
      if (RELEASE_ON.has(evt.hook_event_name) && broker.get(evt.session_id)) {
        broker.release(evt.session_id, `${evt.hook_event_name} arrived`);
      }
      const waitingBefore = store.counts().waiting;
      if (store.apply(evt, meta)) {
        if (store.counts().waiting > waitingBefore) featuredShift = 0; // new decision: feature it
        render();
      }
      res.writeHead(204).end();
    } else if (req.method === "POST" && url.pathname === "/permission") {
      const evt = JSON.parse(await readBody(req));
      if (!evt.session_id) return sendJson(res, 400, { error: "session_id required" });
      store.apply(
        { session_id: evt.session_id, cwd: evt.cwd, state: "waiting", message: "" },
        { source: req.headers["x-agent-source"], bundleId: req.headers["x-agent-bundle"], termProgram: req.headers["x-term-program"], tty: req.headers["x-agent-tty"] },
      );
      const r = broker.open(evt.session_id, evt, res); // response is held until a choice
      log(`permission request ${r.id} from ${evt.session_id}: ${r.tool} ${r.detail}`);
    } else if (req.method === "POST" && url.pathname === "/decide") {
      const { session_id, choice } = JSON.parse(await readBody(req));
      if (!broker.get(session_id)) return sendJson(res, 404, { error: "no pending request" });
      if (choice === "terminal") broker.release(session_id, "decide endpoint");
      else if (!broker.decide(session_id, choice)) return sendJson(res, 400, { error: `choice not available: ${choice}` });
      res.writeHead(204).end();
    } else if (req.method === "GET" && url.pathname === "/agents") {
      sendJson(res, 200, { agents: store.ordered(), featured: featured().agent?.id ?? null });
    } else if (req.method === "GET" && url.pathname === "/preview") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PREVIEW_HTML);
    } else if (req.method === "GET" && url.pathname === "/preview.json") {
      const { keyFor, strip, agents } = scene();
      const ids = layout("preview", PREVIEW_SLOTS);
      sendJson(res, 200, {
        keys: ids.map((id, i) => svgDataUrl(keyFor(id, i))),
        strip: strip.map(svgDataUrl),
        agents,
        layout: ids,
      });
    } else if (req.method === "GET" && url.pathname === "/apps") {
      sendJson(res, 200, {
        apps: apps.apps.map(({ icon, ...a }) => ({ ...a, hasIcon: !!icon })),
        onDeck: appsForDeck(apps.apps, store.ordered()).map((a) => a.key),
        layouts: Object.fromEntries(layouts),
      });
    } else if (req.method === "GET" && url.pathname === "/context") {
      const app = stripApp();
      sendJson(res, 200, { focus: focusApp, showing: app?.key ?? null, cursor: stripPicks()?.cursor ?? null, context: app ? appContext.get(app.key) ?? null : null });
    } else if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, deck: ws?.readyState === WebSocket.OPEN, contexts: contexts.size, decks: [...decks], displaysAsleep: power.asleep });
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    log("http error:", err.message);
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
  }
});

server.on("error", (err) => log(`HTTP server error on port ${HTTP_PORT}:`, err.message));
server.listen(HTTP_PORT, "127.0.0.1", () => log(`listening for agent events on http://127.0.0.1:${HTTP_PORT}`));

// ---------------------------------------------------------------- timers

// Step the pulse while any key wants attention; settle on the first frame after.
setInterval(() => {
  const on = pulsing();
  if (on || frame) {
    frame = on ? (frame + 1) % PULSE.length : 0;
    render();
  }
}, PULSE_MS);

setInterval(() => {
  for (const id of seenDone.keys()) if (!store.agents.has(id)) seenDone.delete(id);
  if (store.prune(PRUNE_AFTER_MS)) render();
}, 60_000);

// Keep the app on the strip current (tabs opened, messages arriving).
setInterval(() => refreshContext(), CONTEXT_REFRESH_MS);

// Running apps fill the keys agents don't need; lsappinfo pushes launch/quit/front changes.
apps.start();
// The deck goes dark while the displays sleep.
power.start();
// The right knob sends keys: dictation and Tab.
controls.start();
// Pressing an app key shows its context on the strip; build the reader now.
reader.warm();
process.on("exit", () => {
  apps.stop();
  power.stop();
  controls.stop();
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));

try {
  for (const d of JSON.parse(args.info || "{}").devices || []) if (d?.id) decks.add(d.id);
} catch {}
if (args.port) connectDeck();
else log("no -port given: running standalone (HTTP + preview only)");
