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

export const THEME = {
  working: { bg: "#1e40af", fg: "#ffffff", sub: "#bfdbfe", label: "WORKING", head: "is working" },
  waiting: {
    bg: "#f59e0b", fg: "#1c1300", sub: "#3b2a00",
    bgAlt: "#1c1300", fgAlt: "#fbbf24", subAlt: "#fbbf24",
    label: "NEEDS YOU", head: "needs a decision",
  },
  done: { bg: "#166534", fg: "#ffffff", sub: "#bbf7d0", label: "DONE", head: "finished" },
  idle: { bg: "#334155", fg: "#ffffff", sub: "#cbd5e1", label: "READY", head: "is ready" },
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

/** Split a project name into at most two short lines for a key. */
function nameLines(name, perLine) {
  const parts = String(name).split(/(?<=[-_. ])/);
  const lines = [""];
  for (const p of parts) {
    const i = lines.length - 1;
    if ((lines[i] + p).length <= perLine || !lines[i]) lines[i] += p;
    else lines.push(p);
  }
  return wrap(lines.map((l) => l.replace(/[-_. ]$/, "")).join(" "), perLine, 2);
}

export function keySvg({ agent, name, slot, blinkOn = true }) {
  const S = 144;
  if (!agent) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
      + `<rect width="${S}" height="${S}" fill="#0b0d10"/>`
      + `<text x="72" y="86" font-family="${FONT}" font-size="40" font-weight="700" fill="#262b33" text-anchor="middle">${slot}</text>`
      + `</svg>`;
  }
  const t = THEME[agent.state] || THEME.idle;
  const dim = agent.state === "waiting" && !blinkOn;
  const bg = dim ? t.bgAlt : t.bg;
  const fg = dim ? t.fgAlt : t.fg;
  const sub = dim ? t.subAlt : t.sub;

  const short = String(name).length <= 6;
  const size = short ? 32 : 25;
  const lines = nameLines(name, short ? 6 : 9);
  const mid = lines.length === 1 ? [80] : [66, 96];
  const nameSvg = lines
    .map((l, i) => `<text x="72" y="${mid[i]}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="${fg}" text-anchor="middle">${esc(l)}</text>`)
    .join("");

  const border = dim ? `<rect x="5" y="5" width="${S - 10}" height="${S - 10}" fill="none" stroke="${t.fgAlt}" stroke-width="8"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
    + `<rect width="${S}" height="${S}" fill="${bg}"/>${border}`
    + `<text x="14" y="28" font-family="${FONT}" font-size="17" font-weight="700" fill="${sub}">${slot}</text>`
    + nameSvg
    + `<text x="72" y="130" font-family="${FONT}" font-size="16" font-weight="700" letter-spacing="1" fill="${sub}" text-anchor="middle">${t.label}</text>`
    + `</svg>`;
}

/**
 * Key for a running app (a key no agent needs): its icon and name on a dark
 * background, so it reads differently from the colored agent keys.
 * app = { name, icon? } where icon is a PNG data URL.
 */
export function appKeySvg({ app }) {
  const S = 144;
  const W = S - 14; // usable text width
  const name = String(app.name || "");
  // One line at 20px if it fits, else 16px, else two lines at 16px under a smaller icon.
  let size = 20;
  let lines = [name];
  if (textWidth(name, 20, true) > W) {
    size = 16;
    lines = wrapPx(name, W, 16, true, textWidth(name, 16, true) > W ? 2 : 1);
  }
  const two = lines.length > 1;
  const icon = two ? { x: 40, y: 10, s: 64 } : { x: 32, y: 12, s: 80 };
  const base = two ? [102, 122] : [126];

  const iconSvg = app.icon
    ? `<image x="${icon.x}" y="${icon.y}" width="${icon.s}" height="${icon.s}" xlink:href="${esc(app.icon)}"/>`
    : `<rect x="${icon.x + 6}" y="${icon.y + 6}" width="${icon.s - 12}" height="${icon.s - 12}" rx="${(icon.s - 12) / 4.5}" fill="#334155"/>`
      + `<text x="72" y="${icon.y + icon.s / 2 + 12}" font-family="${FONT}" font-size="34" font-weight="700" fill="#e2e8f0" text-anchor="middle">${esc([...name][0]?.toUpperCase() || "?")}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
    + `<rect width="${S}" height="${S}" fill="#111318"/>`
    + iconSvg
    + lines.map((l, i) => `<text x="72" y="${base[i]}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#cbd5e1" text-anchor="middle">${esc(l)}</text>`).join("")
    + `</svg>`;
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
 * Tab picker: when the app has tabs and `cursor` (an index into context.tabs)
 * is given, the strip pages through every tab instead, with the one at the
 * cursor highlighted.
 */
export function contextScene({ app, context, cursor }) {
  const COLS = 2;
  const ROWS = 3;
  const colW = (STRIP_W - 2 * PAD + 24) / COLS - 24; // 24px between columns
  const size = 19;
  const picking = context?.tabs?.length && Number.isInteger(cursor);
  const at = picking ? Math.max(0, Math.min(cursor, context.tabs.length - 1)) : 0;
  const first = picking ? Math.floor(at / PAGE) * PAGE : 0;
  const summary = !context ? "Reading…"
    : picking ? `Tab ${at + 1} of ${context.tabs.length}` + (context.summary.includes(" in ") ? ` · ${context.summary.split(" in ")[1]}` : "")
    : context.summary;
  const sumW = Math.min(textWidth(summary, 19) + 4, 360);
  const icon = app.icon
    ? `<image x="${PAD - 4}" y="7" width="38" height="38" xlink:href="${esc(app.icon)}"/>`
    : `<rect x="${PAD}" y="11" width="30" height="30" rx="7" fill="#334155"/>`;
  const nameX = PAD + 44;
  const name = fitPx(app.name, STRIP_W - PAD - nameX - sumW - 20, 26, true);

  const items = picking
    ? context.tabs.slice(first, first + PAGE).map((t, i) => ({ ...t, active: t.current, picked: first + i === at }))
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

/**
 * The whole 800x128 strip scene as SVG body markup (no outer <svg>), in real
 * strip pixels. `app` (with `context`): show that app instead of the agents.
 */
export function stripScene({ agent, name, index = 0, total = 0, counts = {}, app, context, cursor }) {
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
