// What the touch strip says about an app after you press its key: recent
// conversations in Messages and WhatsApp, recent notes in Notes, open tabs in
// browsers (and any app with a tab bar), otherwise the app's window titles.
//
// context.swift reads a snapshot of the app through Accessibility (the
// permission OpenDeck already has for the knobs); describe() turns it into a
// summary and up to six strip lines. Only the app the strip is showing is read,
// when its key is pressed and every few seconds after.

import { fileURLToPath } from "node:url";
import { run, swiftHelper } from "./helpers.mjs";

const HELPER_SRC = fileURLToPath(new URL("./context.swift", import.meta.url));
export const MAX_ITEMS = 6;

// Direction marks Messages and WhatsApp wrap names and text in.
const MARKS = /[‎‏‪-‮⁦-⁩]/g;
const clean = (s) => String(s ?? "").replace(MARKS, "").replace(/\s+/g, " ").trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TIME = /^(\d{1,2}:\d{2}\s?([AP]M)?|Today|Yesterday|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ ?\d{1,2}(,? ?at ?\d.*)?)$/i;

/** First list in the snapshot matching `test`. */
const list = (snap, test) => (snap.lists || []).find(test);

/** Latest messages of the open chat, newest first: rows read "Sender, text, time". */
function transcript(l, chat) {
  const items = [];
  for (const r of l.rows) {
    const parts = clean(r.desc).split(", ");
    if (parts.length < 2) continue; // date and read-receipt rows
    const who = parts.shift();
    const time = parts.length > 1 && TIME.test(parts.at(-1)) ? parts.pop() : "";
    items.push({ title: /^Your (iMessage|SMS|message|RCS)/.test(who) ? "You" : who, text: parts.join(", "), time });
  }
  return { summary: chat ? `Chat with ${chat}` : "Open chat", items: items.reverse() };
}

/** Messages: "Name, [Unread, ]preview, time" per conversation, or the open chat while searching. */
function messages(snap) {
  const l = list(snap, (x) => x.id === "ConversationList" || x.desc === "Conversations");
  if (!l) {
    const t = list(snap, (x) => x.id === "TranscriptCollectionView");
    return t ? transcript(t, clean(snap.windows?.[0]?.title)) : null;
  }
  const items = [];
  for (const r of l.rows) {
    const parts = clean(r.desc).split(", ");
    if (parts.length < 2) continue;
    const name = parts.shift();
    const unread = parts[0] === "Unread";
    if (unread) parts.shift();
    const time = parts.length > 1 && TIME.test(parts.at(-1)) ? parts.pop() : "";
    items.push({ title: name, text: parts.join(", "), time, unread });
  }
  const n = items.filter((i) => i.unread).length;
  return { summary: n ? `${n} unread` : "Recent conversations", items };
}

/** WhatsApp's last-message text: "Message from X, text, 1:42 PM, Received in Chat" → "X: text". */
export function whatsappPreview(value) {
  let v = clean(value).replace(/, (Received in|Sent to) .*$/, "").replace(/, (Delivered|Read)$/, "");
  const parts = v.split(", ");
  let sender = "";
  const m = /^(Message|Photo|Video|Voice message|Sticker|GIF|Document) from (?:Maybe |~ ?)?(.+)$/.exec(parts[0]);
  if (m) {
    parts.shift();
    sender = m[2];
    if (m[1] !== "Message") parts.unshift(m[1]);
  } else if (parts[0] === "Your message") {
    parts.shift();
    sender = "You";
  } else if (parts[0] === "message") parts.shift();
  if (parts[0] === "Link" && parts.length > 1) parts.shift();
  const time = parts.length > 1 && TIME.test(parts.at(-1)) ? parts.pop() : "";
  const text = parts.join(", ");
  return { text: sender ? `${sender}: ${text}` : text, time };
}

/** WhatsApp: chat rows are the unlabelled children of the chat list. */
function whatsapp(snap) {
  const l = list(snap, (x) => x.id === "ChatListView_TableView");
  if (!l) return null;
  const items = [];
  for (const r of l.rows) {
    if (r.id) continue; // filter chips, archive row
    const desc = clean(r.desc || r.texts?.[0]);
    if (!desc) continue;
    const unread = Number(/(\d[\d,]*) unread messages?/.exec(desc)?.[1]?.replace(/,/g, "") || 0);
    const title = desc.replace(/, \d[\d,]* unread messages?.*$/, "");
    const { text, time } = whatsappPreview(r.value || "");
    items.push({ title, text, time, unread: unread > 0, count: unread });
  }
  const chips = list(snap, (x) => x.id === "ChatListView_chipButtonsCell");
  const chip = chips?.rows.map((r) => clean(r.desc)).find((d) => /^Unread, /.test(d));
  const chats = /(\d[\d,]*) unread chats?/.exec(chip || "")?.[1];
  const n = items.filter((i) => i.unread).length;
  return { summary: chats ? `${chats} unread chats` : n ? plural(n, "unread chat") : "Recent chats", items };
}

/** Notes: each note row's texts are [title, date, folder?, preview]; one-text rows are date headings. */
function notes(snap) {
  const l = list(snap, (x) => /^ICMNoteListTableView/.test(x.id));
  if (!l) return null;
  const items = l.rows
    .map((r) => (r.texts || []).map(clean))
    .filter((t) => t.length >= 2)
    .map((t) => ({ title: t[0], text: t[3] || "", time: t[1] }));
  return { summary: clean(snap.windows?.[0]?.title) || "Recent notes", items };
}

// Chrome appends memory notes to tab titles.
const TAB_NOISE = / - (?:(?:High )?[Mm]emory usage - [\d.,]+ ?[KMGT]?B|Inactive tab - [\d.,]+ ?[KMGT]?B freed up|Audio playing|Muted|Pinned|Network error|Crashed)$/;
export function cleanTab(title) {
  let t = clean(title);
  for (let prev = ""; prev !== t; ) (prev = t), (t = t.replace(TAB_NOISE, ""));
  return t;
}

/**
 * Any app with a tab bar: the main window's tabs (current first), then other
 * windows' current tabs; and `tabs`, every tab in order for the tab picker:
 * { title, window, index (what `press` takes), current (selected in its window), text }.
 */
function tabs(snap) {
  const wins = (snap.windows || []).map((w, wi) => ({ ...w, wi })).filter((w) => w.tabs?.length);
  if (!wins.length) return null;
  const total = wins.reduce((n, w) => n + w.tabs.length, 0);
  const [main, ...rest] = wins;
  const cur = main.tabs.find((t) => t.selected);
  const items = [
    ...(cur ? [{ title: cleanTab(cur.title), active: true }] : []),
    ...main.tabs.filter((t) => t !== cur).map((t) => ({ title: cleanTab(t.title) })),
  ];
  const others = rest.map((w) => w.tabs.find((t) => t.selected) || w.tabs[0]).map((t) => ({ title: cleanTab(t.title), text: "other window" }));
  // Keep room for the other windows' current tabs.
  const keep = Math.max(MAX_ITEMS - others.length, Math.min(items.length, 3));
  const all = wins.flatMap((w, n) =>
    w.tabs.map((t, index) => ({ title: cleanTab(t.title), window: w.wi, index, current: !!t.selected, ...(n > 0 && { text: `window ${n + 1}` }) })));
  return {
    summary: plural(total, "tab") + (wins.length > 1 ? ` in ${wins.length} windows` : ""),
    items: [...items.slice(0, keep), ...others],
    tabs: all,
  };
}

/** Drop the app's own name from a window title ("README.md — agent-deck — Visual Studio Code"). */
export function windowTitle(title, appName) {
  const t = clean(title);
  const name = clean(appName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(`\\s[-–—]\\s${name}(\\s[-–—]\\s.*)?$`), "") || t;
}

function windows(app, snap) {
  const wins = snap.windows || [];
  if (!wins.length) return { summary: "No windows on this desktop", items: [] };
  const items = wins.map((w) => ({ title: windowTitle(w.title, app.name) || "Untitled", active: w.main })).filter((i) => i.title);
  return { summary: plural(wins.length, "window"), items };
}

const BY_BUNDLE = {
  "com.apple.MobileSMS": messages,
  "net.whatsapp.WhatsApp": whatsapp,
  "net.whatsapp.WhatsAppSMB": whatsapp,
  "com.apple.Notes": notes,
};

/** Summary + strip lines for `app` (from apps.mjs) given a context.swift snapshot. */
export function describe(app, snap) {
  if (snap?.trusted === false) {
    return { summary: "Needs Accessibility for OpenDeck", items: [{ title: "System Settings → Privacy & Security → Accessibility" }] };
  }
  const out = BY_BUNDLE[app.bundleId]?.(snap) || tabs(snap) || windows(app, snap);
  return {
    summary: out.summary,
    items: out.items.filter((i) => i.title || i.text).slice(0, MAX_ITEMS),
    ...(out.tabs?.length && { tabs: out.tabs }),
  };
}

/**
 * The tab picker's cursor ({ index, title, window }) for a fresh `tabs` list.
 * Starts on the front window's current tab; afterwards follows the same tab
 * (by title) as tabs open, close and move, else stays at the same position.
 */
export function tabCursor(prev, tabs) {
  if (!tabs?.length) return null;
  const at = (i) => ({ index: i, title: tabs[i].title, window: tabs[i].window });
  if (!prev) {
    const cur = tabs.findIndex((t) => t.current && t.window === tabs[0].window);
    return at(cur >= 0 ? cur : 0);
  }
  const here = tabs[prev.index];
  if (here && here.title === prev.title && here.window === prev.window) return at(prev.index);
  let i = tabs.findIndex((t) => t.title === prev.title && t.window === prev.window);
  if (i < 0) i = tabs.findIndex((t) => t.title === prev.title);
  return at(i >= 0 ? i : Math.min(prev.index, tabs.length - 1));
}

/** Move the cursor by `ticks` tabs, wrapping around the ends. */
export function moveCursor(cursor, tabs, ticks) {
  const n = tabs.length;
  const i = ((((cursor?.index ?? 0) + Math.trunc(ticks || 0)) % n) + n) % n;
  return { index: i, title: tabs[i].title, window: tabs[i].window };
}

/** Reads an app's context with the compiled context.swift helper. */
export class ContextReader {
  constructor({ log = () => {}, timeoutMs = 4000 } = {}) {
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.bin = null;
  }

  /** Compile the helper now, so the first key press doesn't wait for it. */
  warm() {
    if (process.platform !== "darwin") return null;
    this.bin ??= swiftHelper(HELPER_SRC).catch((err) => {
      this.bin = null;
      this.log("context: no reader helper, so the strip can't show app context:", err.message);
      throw err;
    });
    this.bin.catch(() => {});
    return this.bin;
  }

  async read(app) {
    if (process.platform !== "darwin") return { summary: "Only on macOS", items: [] };
    if (!app?.pid) return { summary: "Not running", items: [] };
    this.warm();
    const out = await run(await this.bin, [String(app.pid)], this.timeoutMs);
    return describe(app, JSON.parse(out));
  }

  /** Switch `app` to `tab` (from describe()'s `tabs`) and raise its window. Resolves { pressed, title }. */
  async pressTab(app, tab) {
    if (process.platform !== "darwin" || !app?.pid) return { pressed: false };
    this.warm();
    const out = await run(await this.bin, [String(app.pid), "press", String(tab.window), String(tab.index), tab.title], this.timeoutMs);
    return JSON.parse(out);
  }
}
