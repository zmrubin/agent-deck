import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTab, describe, moveCursor, tabCursor, whatsappPreview, windowTitle } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/context.mjs";
import { PAGE, contextScene, stripPanels } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/render.mjs";

// Snapshots shaped like context.swift's output for each app (made-up content).
const row = (o) => ({ desc: "", value: "", id: "", selected: false, texts: [], ...o });
const win = (title, tabs = [], main = true) => ({ title, main, tabs });
const LRM = "‎";

test("Messages: conversations with sender, preview, time and unread", () => {
  const snap = {
    windows: [win("Sam")],
    lists: [{ role: "AXGroup", id: "ConversationList", desc: "Conversations", rows: [
      row({ desc: "Sam Lee, see you at 8, sounds good, 1:52 PM" }),
      row({ desc: "Pat, Unread, Running late!, Yesterday" }),
      row({ desc: "+1 (555) 010-0100, ok" }),
    ] }],
  };
  const out = describe({ bundleId: "com.apple.MobileSMS", name: "Messages" }, snap);
  assert.equal(out.summary, "1 unread");
  assert.deepEqual(out.items, [
    { title: "Sam Lee", text: "see you at 8, sounds good", time: "1:52 PM", unread: false },
    { title: "Pat", text: "Running late!", time: "Yesterday", unread: true },
    { title: "+1 (555) 010-0100", text: "ok", time: "", unread: false },
  ]);
});

test("Messages while searching: the open chat's latest messages, newest first", () => {
  const snap = {
    windows: [win("Sam Lee")],
    lists: [{ role: "AXGroup", id: "TranscriptCollectionView", desc: "Messages", rows: [
      row({ desc: "Your iMessage, Lunch?, 11:58 AM" }),
      row({ texts: ["Today 1:30 PM"] }),
      row({ desc: "Sam Lee, Sure, noon works, 12:01 PM" }),
      row({ texts: ["Read 12:02 PM"] }),
    ] }],
  };
  const out = describe({ bundleId: "com.apple.MobileSMS", name: "Messages" }, snap);
  assert.equal(out.summary, "Chat with Sam Lee");
  assert.deepEqual(out.items, [
    { title: "Sam Lee", text: "Sure, noon works", time: "12:01 PM" },
    { title: "You", text: "Lunch?", time: "11:58 AM" },
  ]);
});

test("WhatsApp preview text: sender first, time apart, delivery notes dropped", () => {
  assert.deepEqual(whatsappPreview(`${LRM}Message from ${LRM}Maybe Robin, Does anyone have a ladder?, 1:41 PM, ${LRM}Received in Block chat`),
    { text: "Robin: Does anyone have a ladder?", time: "1:41 PM" });
  assert.deepEqual(whatsappPreview(`${LRM}Your message, On my way, 12:07 PM, ${LRM}Sent to Kim, ${LRM}Delivered`),
    { text: "You: On my way", time: "12:07 PM" });
  assert.deepEqual(whatsappPreview(`${LRM}Message from Ana, ${LRM}Link, New demo is up, 2:05 PM`), { text: "Ana: New demo is up", time: "2:05 PM" });
  assert.deepEqual(whatsappPreview(`${LRM}Photo from ${LRM}Maybe Gil, 2:05 PM`), { text: "Gil: Photo", time: "2:05 PM" });
});

test("WhatsApp: chats with unread counts; the filter chips give the total", () => {
  const snap = {
    windows: [win("WhatsApp")],
    lists: [
      { role: "AXGroup", id: "ChatListView_TableView", desc: "List of chats", rows: [
        row({ id: "ChatListView_chipButtonsCell" }),
        row({ desc: "Kim", value: `${LRM}Your message, On my way, 12:07 PM` }),
        row({ desc: `Book club, ${LRM}12 unread messages`, value: `${LRM}Message from Ana, Chapter 4 tonight?, 1:40 PM` }),
      ] },
      { role: "AXGroup", id: "ChatListView_chipButtonsCell", desc: "", rows: [
        row({ desc: `${LRM}All` }), row({ desc: `${LRM}Unread, ${LRM}7 unread chats` }),
      ] },
    ],
  };
  const out = describe({ bundleId: "net.whatsapp.WhatsApp", name: "WhatsApp" }, snap);
  assert.equal(out.summary, "7 unread chats");
  assert.deepEqual(out.items.map((i) => [i.title, i.text, i.time, i.unread]), [
    ["Kim", "You: On my way", "12:07 PM", false],
    ["Book club", "Ana: Chapter 4 tonight?", "1:40 PM", true],
  ]);
});

test("Notes: recent notes with dates; date headings skipped", () => {
  const snap = {
    windows: [win("All iCloud – 12 notes")],
    lists: [
      { role: "AXOutline", id: "_NS:50", desc: "Folders", rows: [row({ desc: "Notes, 12 notes", texts: ["Notes", "12"] })] },
      { role: "AXTable", id: "ICMNoteListTableView_asList", desc: "My Notes as List", rows: [
        row({ texts: ["Today"] }),
        row({ texts: ["Groceries", "9:10 AM", "Notes", "eggs, milk"] }),
        row({ texts: ["Trip ideas", "Yesterday"] }),
      ] },
    ],
  };
  const out = describe({ bundleId: "com.apple.Notes", name: "Notes" }, snap);
  assert.equal(out.summary, "All iCloud – 12 notes");
  assert.deepEqual(out.items, [
    { title: "Groceries", text: "eggs, milk", time: "9:10 AM" },
    { title: "Trip ideas", text: "", time: "Yesterday" },
  ]);
});

test("tabs: current tab first, Chrome's memory notes removed, other windows after", () => {
  const tabs = [
    { title: "Docs - Memory usage - 257 MB", selected: false },
    { title: "Inbox (3) - Mail - High memory usage - 1.3 GB", selected: true },
    { title: "Search - Inactive tab - 373 MB freed up", selected: false },
  ];
  const snap = { windows: [win("Inbox (3) - Google Chrome", tabs), win("Other", [{ title: "Music", selected: true }], false)], lists: [] };
  const out = describe({ bundleId: "com.google.Chrome", name: "Google Chrome" }, snap);
  assert.equal(out.summary, "4 tabs in 2 windows");
  assert.deepEqual(out.items, [
    { title: "Inbox (3) - Mail", active: true },
    { title: "Docs" },
    { title: "Search" },
    { title: "Music", text: "other window" },
  ]);
  assert.equal(cleanTab("A - Pinned - Memory usage - 20 MB"), "A");
});

test("tabs: the picker gets every tab, front window first, with what switching needs", () => {
  const snap = { windows: [
    win("A", [{ title: "One", selected: false }, { title: "Two - Memory usage - 9 MB", selected: true }]),
    win("Untabbed", [], false),
    win("B", [{ title: "Three", selected: true }], false),
  ], lists: [] };
  const out = describe({ bundleId: "com.google.Chrome", name: "Google Chrome" }, snap);
  assert.deepEqual(out.tabs, [
    { title: "One", window: 0, index: 0, current: false },
    { title: "Two", window: 0, index: 1, current: true },
    { title: "Three", window: 2, index: 0, current: true, text: "window 2" },
  ]);
  assert.equal(describe({ bundleId: "com.apple.Notes", name: "Notes" }, { windows: [win("x")], lists: [] }).tabs, undefined);
});

test("tab cursor starts on the current tab and follows it as tabs come and go", () => {
  const t = (title, window = 0, current = false) => ({ title, window, index: 0, current });
  let tabs = [t("a"), t("b", 0, true), t("c")];
  let cur = tabCursor(null, tabs);
  assert.deepEqual(cur, { index: 1, title: "b", window: 0 });
  cur = moveCursor(cur, tabs, 1);
  assert.equal(cur.title, "c");
  cur = moveCursor(cur, tabs, 1);
  assert.equal(cur.title, "a", "wraps around the end");
  cur = moveCursor(cur, tabs, -1);
  assert.equal(cur.title, "c", "and the start");
  tabs = [t("new"), t("a"), t("b", 0, true), t("c")]; // a tab opened in front of it
  assert.deepEqual(tabCursor(cur, tabs), { index: 3, title: "c", window: 0 });
  tabs = [t("a"), t("b", 0, true)]; // its tab closed: same position, clamped
  assert.deepEqual(tabCursor(cur, tabs), { index: 1, title: "b", window: 0 });
  assert.equal(tabCursor(null, []), null);
});

test("tab picker strip: pages of six around the cursor, the picked tab highlighted", () => {
  const tabs = Array.from({ length: 14 }, (_, i) => ({ title: `Tab ${i}`, window: 0, index: i, current: i === 2 }));
  const context = { summary: "14 tabs in 2 windows", items: [], tabs };
  const svg = contextScene({ app: { name: "Safari" }, context, cursor: 8 });
  assert.match(svg, /Tab 9 of 14 · 2 windows/);
  assert.ok(svg.includes(">Tab 6<") && svg.includes(">Tab 11<") && !svg.includes(">Tab 5<") && !svg.includes(">Tab 12<"), "second page");
  assert.equal((svg.match(/fill="#1d4ed8"/g) || []).length, 1, "one highlighted tab");
  assert.equal(PAGE, 6);
  assert.match(contextScene({ app: { name: "Safari" }, context }), /14 tabs in 2 windows/, "no cursor: the summary view");
});

test("any other app: its window titles without the app's name, main window marked", () => {
  const snap = { windows: [win("main.mjs — agent-deck — Visual Studio Code"), win("Untitled-1 — Visual Studio Code", [], false)], lists: [] };
  const out = describe({ bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" }, snap);
  assert.equal(out.summary, "2 windows");
  assert.deepEqual(out.items, [{ title: "main.mjs — agent-deck", active: true }, { title: "Untitled-1", active: false }]);
  assert.equal(windowTitle("Account - Google Chrome - Zachary", "Google Chrome"), "Account");
  assert.deepEqual(describe({ name: "Xcode" }, { windows: [], lists: [] }), { summary: "No windows on this desktop", items: [] });
});

test("an app's own list beats its tabs or windows; at most six lines", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ desc: `P${i}, hi, 1:0${i} PM` }));
  const out = describe({ bundleId: "com.apple.MobileSMS", name: "Messages" }, { windows: [win("x")], lists: [{ id: "ConversationList", rows }] });
  assert.equal(out.items.length, 6);
});

test("without Accessibility it says so instead of showing nothing", () => {
  const out = describe({ name: "Notes", bundleId: "com.apple.Notes" }, { trusted: false, windows: [], lists: [] });
  assert.match(out.summary, /Accessibility/);
});

test("context strip: name, summary, escaped lines; 'Reading…' until the first read", () => {
  const app = { name: "Messages & Co", icon: null };
  const svg = contextScene({ app, context: { summary: "1 unread", items: [{ title: "Pat <3", text: "hi & bye", unread: true, time: "1:52 PM" }] } });
  assert.match(svg, /Messages &amp; Co/);
  assert.match(svg, /Pat &lt;3/);
  assert.match(svg, /hi &amp; bye/);
  assert.match(svg, /<circle/, "unread dot");
  assert.match(contextScene({ app, context: null }), /Reading…/);
  const panels = stripPanels({ app, context: null, agent: null });
  assert.equal(panels.length, 4);
  assert.ok(panels.every((p) => p.includes("Reading…")), "one continuous scene across the four panels");
});
