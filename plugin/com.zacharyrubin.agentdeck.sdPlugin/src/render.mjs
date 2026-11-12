// SVG rendering. Pure functions, no I/O.
//
// Keys: 144x144 SVG. OpenDeck draws it in its webview canvas, then the S10
//   plugin turns it into a 112x112 JPEG (rotated for the panel).
// Strip: one 800x100 scene sliced into four 200x100 panels with viewBox, one
//   per knob. OpenDeck renders each with resvg. The patched S10 device plugin
//   stitches the four back into one 800x100 image and sends it to the strip's
//   full-width slot (5), so the scene shows continuously with no gaps. (The
//   stock plugin sends four 176x112 tiles instead, which leaves dark gaps.)

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

// Strip colors for the agent view (keys show the agent's app icon instead).
export const THEME = {
  working: { bg: "#1e40af", fg: "#ffffff", sub: "#bfdbfe", head: "is working" },
  waiting: { bg: "#f59e0b", fg: "#1c1300", sub: "#3b2a00", head: "needs a decision" },
  done: { bg: "#166534", fg: "#ffffff", sub: "#bbf7d0", head: "finished" },
  idle: { bg: "#334155", fg: "#ffffff", sub: "#cbd5e1", head: "is ready" },
};

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

// Approximate Helvetica advance widths (em) — good enough to wrap text to a pixel width.
const NARROW = new Set("iljI.,:;'|!".split(""));
const SEMI = new Set("ftr()[]{}-/ \"".split(""));
const WIDE = new Set("mwMW@%".split(""));
export function textWidth(s, size, bold = false) {
  let em = 0;
  for (const ch of String(s)) {
    if (NARROW.has(ch)) em += 0.26;
    else if (SEMI.has(ch)) em += 0.34;
    else if (WIDE.has(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.68;
    else if (ch >= "0" && ch <= "9") em += 0.56;
    else em += 0.55;
  }
  return em * size * (bold ? 1.07 : 1);
}

/**
 * Greedy word wrap. `fits(line)` decides whether a line is short enough
 * (character count or pixel width). Long words are hard-broken; overflow ends
 * in an ellipsis.
 */
export function wrapBy(text, fits, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (let w of words) {
    while (!fits(w)) {
      let n = w.length - 1;
      while (n > 1 && !fits(w.slice(0, n))) n--;
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(w.slice(0, n));
      w = w.slice(n);
    }
    if (!cur) cur = w;
    else if (fits(cur + " " + w)) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && !fits(last + "…")) last = last.slice(0, -1);
  kept[maxLines - 1] = last.trimEnd() + "…";
  return kept;
}

/** Character-count wrap (keys). */
export function wrap(text, maxChars, maxLines) {
  return wrapBy(text, (s) => s.length <= maxChars, maxLines);
}

/** Pixel-width wrap (strip). */
export function wrapPx(text, maxW, size, bold, maxLines) {
  return wrapBy(text, (s) => textWidth(s, size, bold) <= maxW, maxLines);
}

// ---------------------------------------------------------------- keys
//
// App and agent keys share one look: an icon above a name on a pure black
// key (true black, so every key's background matches the deck's own black).
// An agent's key shows the icon of the app it runs in (Claude, a terminal…)
// over its project name. Working or ready, the icon just sits there; when the
// agent needs you, the icon blinks larger and smaller:
//   done     until you press its key
//   waiting  until it's answered (its name turns amber)
// PULSE is the icon's size per animation frame (main.mjs steps it).

export const PULSE = [1, 0.7];

/** Whether an agent's key pulses: it needs a decision, or it finished and you haven't pressed its key since. */
export function wantsAttention(agent, seen = false) {
  return agent?.state === "waiting" || (agent?.state === "done" && !seen);
}

const KEY = 144;
const KEY_BG = "#000000";

/** Name lines and where the icon and name go: one line under an 80px icon, or two under a 64px one. */
function iconKeyLayout(name) {
  const W = KEY - 14; // usable text width
  // One line at 20px if it fits, else 16px, else two lines at 16px under a smaller icon.
  let size = 20;
  let lines = [name];
  if (textWidth(name, 20, true) > W) {
    size = 16;
    lines = wrapPx(name, W, 16, true, textWidth(name, 16, true) > W ? 2 : 1);
  }
  const two = lines.length > 1;
  return { size, lines, box: two ? { x: 40, y: 10, s: 64 } : { x: 32, y: 12, s: 80 }, base: two ? [102, 122] : [126] };
}

/** An icon (PNG data URL) in `box`, or a rounded tile with `letter` when there's none. */
function iconMarkup(box, icon, letter) {
  if (icon) return `<image x="${box.x}" y="${box.y}" width="${box.s}" height="${box.s}" xlink:href="${esc(icon)}"/>`;
  const font = Math.round(box.s * 0.42);
  return `<rect x="${box.x + box.s * 0.075}" y="${box.y + box.s * 0.075}" width="${box.s * 0.85}" height="${box.s * 0.85}" rx="${(box.s * 0.85) / 4.5}" fill="#334155"/>`
    + `<text x="72" y="${Math.round(box.y + box.s / 2 + font * 0.35)}" font-family="${FONT}" font-size="${font}" font-weight="700" fill="#e2e8f0" text-anchor="middle">${esc(letter)}</text>`;
}

function iconKey(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}">`
    + `<rect width="${KEY}" height="${KEY}" fill="${KEY_BG}"/>${body}</svg>`;
}

const nameMarkup = ({ lines, base, size }, fill) =>
  lines.map((l, i) => `<text x="72" y="${base[i]}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="${fill}" text-anchor="middle">${esc(l)}</text>`).join("");

const initial = (s) => [...String(s || "")][0]?.toUpperCase() || "?";

/**
 * Key for one agent: `icon` is the PNG data URL of the app it runs in (null:
 * a letter tile). `frame` steps the blink; `seen`: its key was pressed since
 * it finished, so a done agent stops blinking. No agent: an empty key with
 * its slot number.
 */
export function keySvg({ agent, name, slot, icon = null, frame = 0, seen = false }) {
  if (!agent) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}">`
      + `<rect width="${KEY}" height="${KEY}" fill="${KEY_BG}"/>`
      + `<text x="72" y="86" font-family="${FONT}" font-size="40" font-weight="700" fill="#262b33" text-anchor="middle">${slot}</text>`
      + `</svg>`;
  }
  const L = iconKeyLayout(String(name ?? ""));
  const scale = wantsAttention(agent, seen) ? PULSE[((frame % PULSE.length) + PULSE.length) % PULSE.length] : 1;
  const s = Math.round(L.box.s * scale);
  const box = { x: L.box.x + (L.box.s - s) / 2, y: L.box.y + (L.box.s - s) / 2, s }; // shrinks about its center
  return iconKey(iconMarkup(box, icon, initial(name)) + nameMarkup(L, agent.state === "waiting" ? "#fbbf24" : "#e2e8f0"));
}

/**
 * Key for a running app (a key no agent needs): its icon and name on a dark
 * key. app = { name, icon? } where icon is a PNG data URL.
 */
export function appKeySvg({ app }) {
  const name = String(app.name || "");
  const L = iconKeyLayout(name);
  return iconKey(iconMarkup(L.box, app.icon, initial(name)) + nameMarkup(L, "#cbd5e1"));
}

// ---------------------------------------------------------------- strip

export const PANELS = 4;
export const PANEL_W = 200;
const STRIP_W = PANELS * PANEL_W;
// The S10's strip is 800x128, but OpenDeck renders each dial at 200x100 and the
// device plugin stretches it to 200x128. So the scene is laid out at the real
// 800x128 and squashed vertically into each 200x100 panel; the stretch undoes it.
export const STRIP_H = 128;
const RENDER_H = 100;
const PAD = 20;

function countsLine(c) {
  return ["waiting", "working", "done", "idle"]
    .filter((k) => c[k])
    .map((k) => `${c[k]} ${k}`)
    .join(" · ");
}

// Decision view: one button per knob, left to right. `key` is what a press returns.
export const CHOICES = [
  { key: "allow", label: "Allow", color: "#16a34a" },
  { key: "always", label: "Always allow", color: "#0d9488" },
  { key: "deny", label: "Deny", color: "#dc2626" },
  { key: "terminal", label: "In terminal", color: "#475569" },
];

const MONO = "Menlo, SF Mono, Monaco, monospace";

/** Strip scene for an agent blocked on a permission request, with a button above each knob. */
export function decisionScene({ name, request, index = 0, total = 0 }) {
  const counter = total > 1 ? `${index + 1} of ${total}` : "";
  const counterW = counter ? textWidth(counter, 18) + 24 : 0;
  const head = wrapPx(`${name} wants to use ${request.tool}`, STRIP_W - 2 * PAD - counterW, 26, true, 1)[0] || "";
  // Monospace ~0.6em per char.
  const detail = wrapBy(request.detail || "", (s) => s.length * 0.6 * 21 <= STRIP_W - 2 * PAD, 2);
  const btnY = 90;
  const btnH = 32;
  const buttons = CHOICES.map((c, i) => {
    const enabled = c.key !== "always" || request.canAlways;
    const x = i * PANEL_W + 10;
    return `<rect x="${x}" y="${btnY}" width="${PANEL_W - 20}" height="${btnH}" rx="8" fill="${enabled ? c.color : "#1f2937"}"/>`
      + `<text x="${x + (PANEL_W - 20) / 2}" y="${btnY + 22}" font-family="${FONT}" font-size="19" font-weight="700" fill="${enabled ? "#ffffff" : "#4b5563"}" text-anchor="middle">${esc(c.label)}</text>`;
  }).join("");
  return `<rect width="${STRIP_W}" height="${STRIP_H}" fill="#140f00"/>`
    + `<rect width="${STRIP_W}" height="4" fill="#f59e0b"/>`
    + `<text x="${PAD}" y="31" font-family="${FONT}" font-size="26" font-weight="700" fill="#fbbf24">${esc(head)}</text>`
    + (counter ? `<text x="${STRIP_W - PAD}" y="29" font-family="${FONT}" font-size="18" fill="#a16207" text-anchor="end">${esc(counter)}</text>` : "")
    + detail.map((l, i) => `<text x="${PAD}" y="${56 + i * 24}" font-family="${MONO}" font-size="21" fill="#fde68a">${esc(l)}</text>`).join("")
    + buttons;
}

/** `text` cut to `maxW` pixels with an ellipsis ("" when even that won't fit). */
function fitPx(text, maxW, size, bold = false) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (textWidth(t, size, bold) <= maxW) return t;
  return wrapPx(t, maxW, size, bold, 1)[0] || "";
}

export const PAGE = 6; // lines on the strip: two columns of three

/**
 * Strip scene for the app whose key was pressed last: icon, name and summary,
 * then up to six lines (two columns of three) from context.mjs. Unread lines
 * get a dot; the current tab or window gets a bar. context = null: still reading.
 *
 * Picker: when the app has picks (tabs, conversations, chats, notes) and
 * `cursor` (an index into context.picks) is given, the strip pages through
 * all of them instead, with the one at the cursor highlighted.
 */
export function contextScene({ app, context, cursor }) {
  const COLS = 2;
  const ROWS = 3;
  const colW = (STRIP_W - 2 * PAD + 24) / COLS - 24; // 24px between columns
  const size = 19;
  const picks = context?.picks;
  const picking = picks?.length && Number.isInteger(cursor);
  const at = picking ? Math.max(0, Math.min(cursor, picks.length - 1)) : 0;
  const first = picking ? Math.floor(at / PAGE) * PAGE : 0;
  // While picking: "Tab 3 of 12 · 2 windows", "Conversation 1 of 40 · 2 unread".
  const extra = !picking ? ""
    : context.noun === "Tab" ? context.summary.split(" in ")[1] || ""
    : /^Recent/.test(context.summary) ? "" : context.summary;
  const summary = !context ? "Reading…"
    : picking ? `${context.noun || "Item"} ${at + 1} of ${picks.length}` + (extra ? ` · ${extra}` : "")
    : context.summary;
  const sumW = Math.min(textWidth(summary, 19) + 4, 360);
  const icon = app.icon
    ? `<image x="${PAD - 4}" y="7" width="38" height="38" xlink:href="${esc(app.icon)}"/>`
    : `<rect x="${PAD}" y="11" width="30" height="30" rx="7" fill="#334155"/>`;
  const nameX = PAD + 44;
  const name = fitPx(app.name, STRIP_W - PAD - nameX - sumW - 20, 26, true);

  const items = picking
    ? picks.slice(first, first + PAGE).map((t, i) => ({ ...t, active: t.current, picked: first + i === at }))
    : (context?.items || []).slice(0, COLS * ROWS);
  const lines = items.map((it, i) => {
    const col = Math.floor(i / ROWS);
    const row = i % ROWS;
    let x = PAD + col * (colW + 24);
    const y = 70 + row * 25;
    let w = colW;
    let out = it.picked ? `<rect x="${x - 6}" y="${y - 19}" width="${colW + 12}" height="25" rx="6" fill="#1d4ed8"/>` : "";
    if (it.unread) {
      out += `<circle cx="${x + 5}" cy="${y - 6}" r="5" fill="#38bdf8"/>`;
      x += 16;
      w -= 16;
    }
    const time = it.time ? fitPx(it.time, 110, 15) : "";
    if (time) {
      out += `<text x="${x + w}" y="${y}" font-family="${FONT}" font-size="15" fill="#64748b" text-anchor="end">${esc(time)}</text>`;
      w -= textWidth(time, 15) + 10;
    }
    const title = fitPx(it.title, it.text ? Math.min(w, w * 0.55 + 40) : w, size, true);
    const restW = w - textWidth(title, size, true) - 8;
    const text = it.text && restW > 30 ? fitPx(it.text, restW, size) : "";
    const tc = it.picked || it.active ? "#ffffff" : it.unread ? "#f1f5f9" : "#cbd5e1";
    out += `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}">`
      + `<tspan font-weight="700" fill="${tc}">${esc(title)}</tspan>`
      + (text ? `<tspan dx="8" fill="${it.picked ? "#bfdbfe" : "#94a3b8"}">${esc(text)}</tspan>` : "")
      + `</text>`;
    if (it.active) out += `<rect x="${x - 10}" y="${y - 16}" width="3" height="19" rx="1.5" fill="#38bdf8"/>`;
    return out;
  }).join("");
  const empty = context && !items.length
    ? `<text x="${PAD}" y="88" font-family="${FONT}" font-size="22" fill="#64748b">Nothing to show for this app yet</text>`
    : "";
  return `<rect width="${STRIP_W}" height="${STRIP_H}" fill="#0b1220"/>`
    + `<rect width="${STRIP_W}" height="4" fill="#38bdf8"/>`
    + icon
    + `<text x="${nameX}" y="36" font-family="${FONT}" font-size="26" font-weight="700" fill="#f1f5f9">${esc(name)}</text>`
    + `<text x="${STRIP_W - PAD}" y="34" font-family="${FONT}" font-size="19" fill="#94a3b8" text-anchor="end">${esc(fitPx(summary, 360, 19))}</text>`
    + lines + empty;
}

const LAUNCHER_STEPS = {
  opening: { title: "Opening Spotlight…", hint: "" },
  listening: { title: "Listening…", hint: "Say what to open, then push knob 1" },
  choosing: { title: "Pick a result", hint: "Turn knob 1 to choose · push knob 1 to open it" },
};

/** Strip scene while knob 1's launcher is open: which step it's on and what the next push does. */
export function launcherScene({ step }) {
  const s = LAUNCHER_STEPS[step] || LAUNCHER_STEPS.opening;
  const dot = step === "listening" ? `<circle cx="${PAD + 9}" cy="34" r="9" fill="#ef4444"/>` : "";
  const x = dot ? PAD + 28 : PAD;
  return `<rect width="${STRIP_W}" height="${STRIP_H}" fill="#0b1220"/>`
    + `<rect width="${STRIP_W}" height="4" fill="#a78bfa"/>`
    + dot
    + `<text x="${x}" y="44" font-family="${FONT}" font-size="32" font-weight="700" fill="#f1f5f9">${esc(s.title)}</text>`
    + `<text x="${STRIP_W - PAD}" y="41" font-family="${FONT}" font-size="19" fill="#94a3b8" text-anchor="end">Spotlight</text>`
    + (s.hint ? `<text x="${PAD}" y="94" font-family="${FONT}" font-size="24" fill="#cbd5e1">${esc(s.hint)}</text>` : "");
}

/**
 * The whole 800x128 strip scene as SVG body markup (no outer <svg>), in real
 * strip pixels. `launcher` (a step): knob 1's launcher is open. `app` (with
 * `context`): show that app instead of the agents.
 */
export function stripScene({ agent, name, index = 0, total = 0, counts = {}, app, context, cursor, launcher }) {
  if (launcher) return launcherScene({ step: launcher });
  if (app) return contextScene({ app, context, cursor });
  if (agent?.request) return decisionScene({ name, request: agent.request, index, total });
  if (!agent) {
    return `<rect width="${STRIP_W}" height="${STRIP_H}" fill="#0f172a"/>`
      + `<text x="${PAD}" y="50" font-family="${FONT}" font-size="32" font-weight="700" fill="#e2e8f0">No agents running</text>`
      + `<text x="${PAD}" y="94" font-family="${FONT}" font-size="24" fill="#94a3b8">Start Claude Code with the Agent Deck hooks and it shows up here.</text>`;
  }
  const t = THEME[agent.state] || THEME.idle;
  const right = [total > 1 ? `${index + 1} of ${total}` : "", countsLine(counts)].filter(Boolean).join("  ·  ");
  const rightW = right ? textWidth(right, 19) + 28 : 0;
  const header = wrapPx(`${name} ${t.head}`, STRIP_W - 2 * PAD - rightW, 32, true, 1)[0] || "";
  const msg = wrapPx(agent.message || "", STRIP_W - 2 * PAD, 24, false, 2);
  return `<rect width="${STRIP_W}" height="${STRIP_H}" fill="${t.bg}"/>`
    + `<text x="${PAD}" y="44" font-family="${FONT}" font-size="32" font-weight="700" fill="${t.fg}">${esc(header)}</text>`
    + (right ? `<text x="${STRIP_W - PAD}" y="41" font-family="${FONT}" font-size="19" fill="${t.sub}" text-anchor="end">${esc(right)}</text>` : "")
    + msg.map((l, i) => `<text x="${PAD}" y="${82 + i * 30}" font-family="${FONT}" font-size="24" fill="${t.sub}">${esc(l)}</text>`).join("");
}

/**
 * Four 200x100 SVG strings, left to right, each one quarter of the scene
 * squashed from 128 to 100 tall (see STRIP_H). Raw SVG text: OpenDeck's strip
 * renderer parses it directly.
 */
export function stripPanels(args) {
  const scene = stripScene(args);
  const sy = RENDER_H / STRIP_H;
  return [0, 1, 2, 3].map(
    (i) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PANEL_W}" height="${RENDER_H}" viewBox="0 0 ${PANEL_W} ${RENDER_H}">`
      + `<g transform="scale(1 ${sy}) translate(${-i * PANEL_W} 0)">${scene}</g></svg>`,
  );
}

/** All-black key and strip-panel images: drawn just before the deck sleeps, since its screens only dim. */
export function blankKeySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000"/></svg>`;
}
export function blankPanelSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${RENDER_H}" viewBox="0 0 ${PANEL_W} ${RENDER_H}"><rect width="${PANEL_W}" height="${RENDER_H}" fill="#000"/></svg>`;
}

export function svgDataUrl(svg) {
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
