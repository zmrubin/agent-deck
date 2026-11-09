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

/** The whole 800x128 strip scene as SVG body markup (no outer <svg>), in real strip pixels. */
export function stripScene({ agent, name, index = 0, total = 0, counts = {} }) {
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
    (i) => `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${RENDER_H}" viewBox="0 0 ${PANEL_W} ${RENDER_H}">`
      + `<g transform="scale(1 ${sy}) translate(${-i * PANEL_W} 0)">${scene}</g></svg>`,
  );
}

export function svgDataUrl(svg) {
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
