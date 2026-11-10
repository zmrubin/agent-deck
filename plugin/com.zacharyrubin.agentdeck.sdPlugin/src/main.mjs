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
// Strip: pressing an app key shows that app's context there (context.mjs:
// recent messages, tabs, windows…) until an agent key is pressed or a knob
// turned to cycle agents. A permission question always takes the strip.
//
// The deck goes dark while the Mac's displays sleep (power.mjs). The two
// rightmost knobs control the computer (controls.mjs): turn the third to
// scroll, push it to dictate with Snaply; turn the fourth to move between
// fields, push it to click. While the strip lists an app's tabs, the first
// knob picks one: turn to move, push to switch to it.
//
// Run without OpenDeck (`node src/main.mjs`) to use just the HTTP side + preview.

import http from "node:http";
import { execFile } from "node:child_process";
import { AgentStore, displayNames } from "./agents.mjs";
import { AppWatcher, TERM_APPS, activateApp, appsForDeck } from "./apps.mjs";
import { ContextReader, moveCursor, tabCursor } from "./context.mjs";
import { Controls, SNAPLY_BUNDLE, knobPush, knobTurn } from "./controls.mjs";
import { PermissionBroker } from "./permissions.mjs";
import { DeckPower } from "./power.mjs";
import { CHOICES, appKeySvg, blankKeySvg, blankPanelSvg, keySvg, stripPanels, svgDataUrl } from "./render.mjs";
import { allocate } from "./slots.mjs";

const SLOT = "com.zacharyrubin.agentdeck.slot";
const STRIP = "com.zacharyrubin.agentdeck.strip";
const HTTP_PORT = Number(process.env.AGENT_DECK_PORT || 47821);
const BLINK_MS = 600;
const PRUNE_AFTER_MS = 12 * 60 * 60 * 1000;
const PREVIEW_SLOTS = 10;
const BLANK_MS = 1000; // time for black images to reach the deck before it sleeps
const CONTEXT_REFRESH_MS = 3000; // re-read the app on the strip this often

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
});
let ws = null;
let blinkOn = true;
let featuredShift = 0;
let focusApp = null; // key of the app whose key was pressed last: the strip shows it
const appContext = new Map(); // app key -> { summary, items } from context.mjs
const reader = new ContextReader({ log });
let reading = false;
let pick = null; // tab picker cursor: { app, index, title, window } (context.mjs tabCursor)

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

/** The strip's tab picker, when it shows a tabbed app: { app, tabs, cursor } (cursor kept on the same tab). */
function stripTabs() {
  const app = stripApp();
  const tabs = app && appContext.get(app.key)?.tabs;
  if (!tabs?.length) return null;
  pick = { app: app.key, ...tabCursor(pick?.app === app.key ? pick : null, tabs) };
  return { app, tabs, cursor: pick.index };
}

/** Knob 1 pushed on the tab picker: switch the app to that tab and bring it forward. */
async function openTab(app, tab) {
  try {
    const r = await reader.pressTab(app, tab);
    if (!r.pressed) log(`context: couldn't find tab "${tab.title}" in ${app.name}`);
  } catch (err) {
    log(`context: couldn't switch tab in ${app.name}:`, err.message);
  }
  activateApp(app, log);
  setTimeout(refreshContext, 300);
}

async function refreshContext() {
  const app = stripApp();
  if (!app || reading || power.asleep) return;
  reading = true;
  try {
    appContext.set(app.key, await reader.read(app));
  } catch (err) {
    log(`context: couldn't read ${app.name}:`, err.message);
    if (!appContext.has(app.key)) appContext.set(app.key, { summary: "Couldn't read this app", items: [] });
  } finally {
    reading = false;
  }
  render();
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

function scene() {
  const agents = store.ordered();
  const nm = names();
  const keyFor = (id, i) => {
    const { agent, app } = resolve(id);
    if (app) return appKeySvg({ app });
    return keySvg({ agent, name: agent && nm.get(agent.id), slot: i + 1, blinkOn });
  };
  const f = featured();
  const app = stripApp();
  const strip = stripPanels({
    agent: f.agent, name: f.agent && nm.get(f.agent.id), index: f.index, total: f.total, counts: store.counts(),
    ...(app && { app, context: appContext.get(app.key) ?? null, cursor: stripTabs()?.cursor }),
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
      if (app) {
        activateApp(app, log);
        focusApp = app.key; // the strip shows this app until an agent takes over
        pick = null; // tab picker starts on the current tab
        render();
        refreshContext();
        break;
      }
      // Jumping to the agent hands any pending question back to its own dialog.
      if (agent && broker.get(agent.id)) broker.release(agent.id, "user jumped to agent");
      if (agent) {
        focusApp = null;
        const at = store.byUrgency().findIndex((a) => a.id === agent.id);
        if (at >= 0) featuredShift = at; // and the strip features that agent
        render();
      }
      activate(agent);
      break;
    }
    case "dialRotate": {
      const ticks = msg.payload?.ticks || 0;
      const tabs = stripTabs();
      const what = knobTurn(c.column ?? 0, { tabs: !!tabs });
      if (what === "fields") controls.tab(ticks); // move between fields in the front app
      else if (what === "scroll") controls.scroll(ticks); // wheel where the pointer is
      else if (what === "pick-tab") {
        pick = { app: tabs.app.key, ...moveCursor(pick, tabs.tabs, ticks) };
        render();
      } else {
        if (focusApp) focusApp = null; // back to the agents, starting from the featured one
        else featuredShift += Math.sign(ticks);
        render();
      }
      break;
    }
    case "dialDown":
    case "touchTap": {
      const agent = featured().agent;
      const column = c.column ?? 0;
      // A pending decision owns all four knobs (its choices sit above them).
      const tabs = stripTabs();
      const what = knobPush(column, { pending: !!(agent && broker.get(agent.id)), touch: msg.event === "touchTap", tabs: !!tabs });
      if (what === "choose") chooseFromDeck(agent, column);
      else if (what === "open-tab") openTab(tabs.app, tabs.tabs[tabs.cursor]);
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
      sendJson(res, 200, { focus: focusApp, showing: app?.key ?? null, cursor: stripTabs()?.cursor ?? null, context: app ? appContext.get(app.key) ?? null : null });
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

setInterval(() => {
  const anyWaiting = store.counts().waiting > 0;
  if (anyWaiting || !blinkOn) {
    blinkOn = anyWaiting ? !blinkOn : true;
    render();
  }
}, BLINK_MS);

setInterval(() => store.prune(PRUNE_AFTER_MS) && render(), 60_000);

// Keep the app on the strip current (tabs opened, messages arriving).
setInterval(refreshContext, CONTEXT_REFRESH_MS);

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
