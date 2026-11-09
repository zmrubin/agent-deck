// Agent Deck plugin entry point.
//
// Two connections:
//   1. OpenDeck (Stream Deck SDK WebSocket) – receives key/knob events, sends
//      key images (setImage) and touch-strip panels (setFeedback).
//   2. A localhost HTTP endpoint agents report to (see hooks/agent-deck-hook.sh):
//        POST /event        Claude Code hook JSON, or the generic format in agents.mjs
//        GET  /agents       current state as JSON
//        GET  /preview      live browser preview of the deck
//
// Run without OpenDeck (`node src/main.mjs`) to use just the HTTP side + preview.

import http from "node:http";
import { execFile } from "node:child_process";
import { AgentStore, displayNames } from "./agents.mjs";
import { keySvg, stripPanels, svgDataUrl } from "./render.mjs";

const SLOT = "com.zacharyrubin.agentdeck.slot";
const STRIP = "com.zacharyrubin.agentdeck.strip";
const HTTP_PORT = Number(process.env.AGENT_DECK_PORT || 47821);
const BLINK_MS = 600;
const PRUNE_AFTER_MS = 12 * 60 * 60 * 1000;
const PREVIEW_SLOTS = 10;

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
let ws = null;
let blinkOn = true;
let featuredShift = 0;

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

function slotContexts(device) {
  return [...contexts]
    .filter(([, c]) => c.action === SLOT && c.device === device)
    .sort(([, a], [, b]) => a.row - b.row || a.column - b.column)
    .map(([ctx]) => ctx);
}

function scene() {
  const agents = store.ordered();
  const nm = names();
  const keyFor = (i) => {
    const agent = agents[i];
    return keySvg({ agent, name: agent && nm.get(agent.id), slot: i + 1, blinkOn });
  };
  const f = featured();
  const strip = stripPanels({ agent: f.agent, name: f.agent && nm.get(f.agent.id), index: f.index, total: f.total, counts: store.counts() });
  return { keyFor, strip, agents, featured: f };
}

function push(context, event, payload) {
  const key = JSON.stringify(payload);
  if (lastSent.get(context) === key) return;
  lastSent.set(context, key);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, context, payload }));
}

function render() {
  if (!contexts.size) return;
  const { keyFor, strip } = scene();
  for (const device of new Set([...contexts.values()].map((c) => c.device))) {
    slotContexts(device).forEach((ctx, i) => push(ctx, "setImage", { image: svgDataUrl(keyFor(i)), target: 0 }));
  }
  for (const [ctx, c] of contexts) {
    if (c.action === STRIP) push(ctx, "setFeedback", { canvas: strip[c.column % 4] });
  }
}

// ---------------------------------------------------------------- actions

const APP_BY_TERM = {
  "iTerm.app": "iTerm",
  Apple_Terminal: "Terminal",
  vscode: "Visual Studio Code",
  WarpTerminal: "Warp",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
};

function activate(agent) {
  if (!agent) return;
  if (process.platform !== "darwin") return log("activate: only implemented on macOS");
  const argv = agent.bundleId ? ["-b", agent.bundleId] : APP_BY_TERM[agent.termProgram] ? ["-a", APP_BY_TERM[agent.termProgram]] : null;
  if (!argv) return log(`activate: no app known for ${agent.id}`);
  execFile("open", argv, (err) => err && log("activate failed:", err.message));
}

// ---------------------------------------------------------------- OpenDeck

function onDeckMessage(msg) {
  const c = msg.payload?.coordinates || {};
  switch (msg.event) {
    case "willAppear":
      contexts.set(msg.context, { action: msg.action, device: msg.device, row: c.row ?? 0, column: c.column ?? 0 });
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
      activate(store.ordered()[i]);
      break;
    }
    case "dialRotate":
      featuredShift += Math.sign(msg.payload?.ticks || 0);
      render();
      break;
    case "dialDown":
    case "touchTap":
      activate(featured().agent);
      break;
    case "systemDidWakeUp":
    case "deviceDidConnect":
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
      const waitingBefore = store.counts().waiting;
      if (store.apply(evt, meta)) {
        if (store.counts().waiting > waitingBefore) featuredShift = 0; // new decision: feature it
        render();
      }
      res.writeHead(204).end();
    } else if (req.method === "GET" && url.pathname === "/agents") {
      sendJson(res, 200, { agents: store.ordered(), featured: featured().agent?.id ?? null });
    } else if (req.method === "GET" && url.pathname === "/preview") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PREVIEW_HTML);
    } else if (req.method === "GET" && url.pathname === "/preview.json") {
      const { keyFor, strip, agents } = scene();
      sendJson(res, 200, {
        keys: Array.from({ length: PREVIEW_SLOTS }, (_, i) => svgDataUrl(keyFor(i))),
        strip: strip.map(svgDataUrl),
        agents,
      });
    } else if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, deck: ws?.readyState === WebSocket.OPEN, contexts: contexts.size });
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

if (args.port) connectDeck();
else log("no -port given: running standalone (HTTP + preview only)");
