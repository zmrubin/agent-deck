import { test } from "node:test";
import assert from "node:assert/strict";
import { Controls, knobPush, knobTurn, snaplyShortcut } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/controls.mjs";
import { supervise } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/helpers.mjs";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settings = (behavior, shortcut = { type: "single-key", key: "59", label: "Left Control" }) =>
  JSON.stringify({ general: {}, dictation: { shortcut, ...(behavior && { shortcutBehavior: behavior }) } });

/** Controls wired to a fake key helper that records each command. */
function fake(opts = {}) {
  const sent = [];
  const logs = [];
  const c = new Controls({ log: (...a) => logs.push(a.join(" ")), readSettings: () => settings("hold"), ...opts });
  c.helper = { write: (l) => (sent.push(l), true), stop() {} };
  c.trusted = true;
  return { c, sent, logs };
}

test("snaplyShortcut reads Snaply's single-key dictation shortcut", () => {
  assert.deepEqual(snaplyShortcut(settings("hold")), { keycode: 59, behavior: "hold", label: "Left Control" });
  assert.equal(snaplyShortcut(settings(undefined)).behavior, "combined", "Snaply's default");
  assert.equal(snaplyShortcut(settings("toggle", { type: "multi-key", key: "Control+Space" })), null);
  assert.equal(snaplyShortcut("not json"), null);
  assert.equal(snaplyShortcut("{}"), null);
});

test("push-to-talk: the first push holds the key, the next lets go", () => {
  const { c, sent } = fake();
  c.dictate();
  assert.deepEqual(sent, ["down 59"]);
  c.dictate();
  assert.deepEqual(sent, ["down 59", "up 59"]);
  c.dictate();
  assert.deepEqual(sent, ["down 59", "up 59", "down 59"], "and again");
  c.stop();
});

test("push-to-talk lets go by itself after the time limit", async () => {
  const { c, sent } = fake({ holdLimitMs: 10 });
  c.dictate();
  await tick(25);
  assert.deepEqual(sent, ["down 59", "up 59"]);
  c.dictate();
  assert.deepEqual(sent.at(-1), "down 59", "the next push starts again rather than letting go");
  c.stop();
});

test("toggle and combined modes get a quick tap per push", () => {
  for (const mode of ["toggle", "combined"]) {
    const { c, sent } = fake({ readSettings: () => settings(mode) });
    c.dictate();
    c.dictate();
    assert.deepEqual(sent, ["tap 59", "tap 59"], mode);
  }
});

test("the shortcut is re-read on every push", () => {
  let mode = "hold";
  const { c, sent } = fake({ readSettings: () => settings(mode) });
  c.dictate(); // holds
  mode = "toggle";
  c.dictate(); // still lets go of the held key first
  c.dictate();
  assert.deepEqual(sent, ["down 59", "up 59", "tap 59"]);
});

test("Snaply not running: open it instead of pressing keys", () => {
  let launched = 0;
  const { c, sent } = fake({ isRunning: () => false, launch: () => launched++ });
  c.dictate();
  assert.equal(launched, 1);
  assert.deepEqual(sent, []);
});

test("unreadable Snaply settings are logged, no keys sent", () => {
  const { c, sent, logs } = fake({ readSettings: () => { throw new Error("ENOENT"); } });
  c.dictate();
  assert.deepEqual(sent, []);
  assert.ok(logs.some((l) => l.includes("couldn't read Snaply's dictation shortcut")));
});

test("knob pushes: third dictates, fourth clicks, the rest jump to the agent", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobPush(col)), ["jump", "jump", "dictate", "click"]);
});

test("a permission question on the strip takes every knob push and tap", () => {
  for (const col of [0, 1, 2, 3]) {
    assert.equal(knobPush(col, { pending: true }), "choose");
    assert.equal(knobPush(col, { pending: true, touch: true }), "choose");
  }
});

test("strip taps jump to the agent, never dictate or click", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobPush(col, { touch: true })), ["jump", "jump", "jump", "jump"]);
});

test("knob turns: first two cycle agents, third scrolls, fourth tabs between fields", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col)), ["agents", "agents", "scroll", "fields"]);
});

test("with tabs on the strip the first knob picks one: turn to move, push to open", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col, { tabs: true })), ["pick-tab", "agents", "scroll", "fields"]);
  assert.deepEqual([0, 1, 2, 3].map((col) => knobPush(col, { tabs: true })), ["open-tab", "jump", "dictate", "click"]);
  assert.equal(knobPush(0, { tabs: true, pending: true }), "choose", "a permission question still wins");
});

test("turning the third knob scrolls: one command per turn, nothing for zero", () => {
  const { c, sent } = fake();
  c.scroll(2);
  c.scroll(-1);
  c.scroll(0);
  assert.deepEqual(sent, ["scroll 2", "scroll -1"]);
});

test("pushing the rightmost knob sends one click; the helper's report is logged", () => {
  const { c, sent, logs } = fake();
  c.click();
  assert.deepEqual(sent, ["click"]);
  c.onLine('click press AXButton Send');
  assert.ok(logs.some((l) => l.includes("controls: click press AXButton Send")));
});

test("turning sends Tab or Shift-Tab per tick", () => {
  const { c, sent } = fake();
  c.tab(1);
  c.tab(-2);
  c.tab(0);
  c.tab(undefined);
  assert.deepEqual(sent, ["tab 1", "tab -2"]);
});

test("without Accessibility permission, macOS is asked once", () => {
  const { c, sent, logs } = fake();
  c.onLine("untrusted");
  assert.ok(logs.some((l) => l.includes("Accessibility")));
  c.tab(1);
  c.tab(1);
  assert.deepEqual(sent, ["prompt", "tab 1", "tab 1"]);
});

test("no key helper: commands are dropped and logged", () => {
  const { c, logs } = fake();
  c.helper = null;
  c.tab(1);
  assert.ok(logs.some((l) => l.includes('dropped "tab 1"')));
});

test("supervise can write lines to a child's stdin", async () => {
  const lines = [];
  const child = supervise({ name: "cat", cmd: "cat", stdin: true, onLine: (l) => lines.push(l) });
  assert.equal(child.write("hello"), true);
  assert.equal(child.write("world"), true);
  for (let i = 0; i < 50 && lines.length < 2; i++) await tick(10);
  child.stop();
  assert.deepEqual(lines, ["hello", "world"]);
});
