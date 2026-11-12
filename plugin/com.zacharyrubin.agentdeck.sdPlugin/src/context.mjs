// What the touch strip says about an app after you press its key: recent
// conversations in Messages and WhatsApp, recent notes in Notes, open tabs in
// browsers (and any app with a tab bar), otherwise the app's window titles.
//
// context.swift reads a snapshot of the app through Accessibility (the
// permission OpenDeck already has for the knobs); describe() turns it into a
// summary and up to six strip lines. Only the app the strip is showing is read,
// when its key is pressed and every few seconds after.
//
// Picker: what knob 1 moves through on the strip, and opens when pushed.
// describe() lists every entry as `picks` (with `noun` naming one):
//   { kind: "tab" | "row", group, index, title, text?, time?, unread?, current }
// A tab is tab `index` of window `group`; a row is row `index` of the snapshot's
// list `group` (a conversation, chat or note). open() switches to one.

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

/** Where a list row is, for the picker: open() selects it with context.swift. */
const rowAt = (l, r) => ({ kind: "row", group: l.index ?? 0, index: r.index ?? 0, current: !!r.selected });

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
    items.push({ title: name, text: parts.join(", "), time, unread, ...rowAt(l, r) });
  }
  const n = items.filter((i) => i.unread).length;
  return { summary: n ? `${n} unread` : "Recent conversations", items, picks: items, noun: "Conversation" };
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
    items.push({ title, text, time, unread: unread > 0, count: unread, ...rowAt(l, r) });
  }
  const chips = list(snap, (x) => x.id === "ChatListView_chipButtonsCell");
  const chip = chips?.rows.map((r) => clean(r.desc)).find((d) => /^Unread, /.test(d));
  const chats = /(\d[\d,]*) unread chats?/.exec(chip || "")?.[1];
  const n = items.filter((i) => i.unread).length;
  return { summary: chats ? `${chats} unread chats` : n ? plural(n, "unread chat") : "Recent chats", items, picks: items, noun: "Chat" };
}

/** Notes: each note row's texts are [title, date, folder?, preview]; one-text rows are date headings. */
function notes(snap) {
  const l = list(snap, (x) => /^ICMNoteListTableView/.test(x.id));
  if (!l) return null;
  const items = l.rows
    .map((r) => ({ r, t: (r.texts || []).map(clean) }))
    .filter(({ t }) => t.length >= 2)
    .map(({ r, t }) => ({ title: t[0], text: t[3] || "", time: t[1], ...rowAt(l, r) }));
  return { summary: clean(snap.windows?.[0]?.title) || "Recent notes", items, picks: items, noun: "Note" };
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
 * windows' current tabs; and `picks`, every tab in order (window by window),
 * `current` marking the one selected in its window.
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
    w.tabs.map((t, index) => ({ kind: "tab", group: w.wi, index, title: cleanTab(t.title), current: !!t.selected, ...(n > 0 && { text: `window ${n + 1}` }) })));
  return {
    summary: plural(total, "tab") + (wins.length > 1 ? ` in ${wins.length} windows` : ""),
    items: [...items.slice(0, keep), ...others],
    picks: all,
    noun: "Tab",
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
  const picks = out.picks?.filter((p) => p.title);
  return {
    summary: out.summary,
    items: out.items.filter((i) => i.title || i.text).slice(0, MAX_ITEMS),
    ...(picks?.length && { picks, noun: out.noun }),
  };
}

/**
 * The picker's cursor ({ index, title, group }) for a fresh `picks` list.
 * Starts on the current entry (the front window's current tab, the open
 * conversation); afterwards follows the same entry (by title) as entries come,
 * go and move, else stays at the same position.
 */
export function pickCursor(prev, picks) {
  if (!picks?.length) return null;
  const at = (i) => ({ index: i, title: picks[i].title, group: picks[i].group });
  if (!prev) {
    const cur = picks.findIndex((p) => p.current && p.group === picks[0].group);
    return at(cur >= 0 ? cur : 0);
  }
  const here = picks[prev.index];
  if (here && here.title === prev.title && here.group === prev.group) return at(prev.index);
  let i = picks.findIndex((p) => p.title === prev.title && p.group === prev.group);
  if (i < 0) i = picks.findIndex((p) => p.title === prev.title);
  return at(i >= 0 ? i : Math.min(prev.index, picks.length - 1));
}

/** Move the cursor by `ticks` entries, wrapping around the ends. */
export function moveCursor(cursor, picks, ticks) {
  const n = picks.length;
  const i = ((((cursor?.index ?? 0) + Math.trunc(ticks || 0)) % n) + n) % n;
  return { index: i, title: picks[i].title, group: picks[i].group };
}

/**
 * Context reads, one at a time per app: a slow app never holds up reading
 * another (switching app keys reads the new app at once), and asking again
 * with `soon` while an app is being read reads it once more when that ends.
 * read(app) → Promise of its context; settled(app, { context | error, ms, again }).
 */
export class AppReads {
  constructor({ read, settled, now = () => Date.now() }) {
    Object.assign(this, { read, settled, now });
    this.running = new Map(); // app key -> true, or "again"
  }

  /** Start reading `app` unless it's being read already. Returns whether a read started. */
  request(app, { soon = false } = {}) {
    if (this.running.has(app.key)) {
      if (soon) this.running.set(app.key, "again");
      return false;
    }
    this.running.set(app.key, true);
    const started = this.now();
    Promise.resolve()
      .then(() => this.read(app))
      .then((context) => ({ context }), (error) => ({ error }))
      .then((r) => {
        const again = this.running.get(app.key) === "again";
        this.running.delete(app.key);
        this.settled(app, { ...r, ms: this.now() - started, again });
      });
    return true;
  }
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

  /** Switch `app` to `pick` (from describe()'s `picks`: a tab, or a conversation, chat or note) and raise its window. Resolves { pressed }. */
  async open(app, pick) {
    if (process.platform !== "darwin" || !app?.pid) return { pressed: false };
    this.warm();
    const command = pick.kind === "row" ? "select" : "press";
    const out = await run(await this.bin, [String(app.pid), command, String(pick.group), String(pick.index), pick.title], this.timeoutMs);
    return JSON.parse(out);
  }
}
