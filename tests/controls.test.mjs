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

test("knob pushes: first runs the launcher, third dictates, fourth clicks, second jumps to the agent", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobPush(col)), ["launch", "jump", "dictate", "click"]);
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

test("an app on the strip stays there: the first two knobs don't switch back to the agents", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col, { app: true })), ["none", "none", "scroll", "fields"]);
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col, { app: true, list: true })), ["none", "pick", "scroll", "fields"]);
});

test("with a list on the strip (tabs, conversations…) the second knob picks one: turn to move, push to open", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col, { list: true })), ["agents", "pick", "scroll", "fields"]);
  assert.deepEqual([0, 1, 2, 3].map((col) => knobPush(col, { list: true })), ["launch", "open", "dictate", "click"]);
  assert.equal(knobPush(1, { list: true, pending: true }), "choose", "a permission question still wins");
});

test("while the launcher is open, turning the first knob moves through its results", () => {
  assert.deepEqual([0, 1, 2, 3].map((col) => knobTurn(col, { launcher: true, list: true, app: true })), ["launcher", "pick", "scroll", "fields"]);
});

/** Controls with a fake key helper that answers launcher commands like keys.swift. */
function launcherFake({ open = "launcher open", mode = "hold", gone = false } = {}) {
  const steps = [];
  const f = fake({ readSettings: () => settings(mode), onChange: (s) => steps.push(s) });
  f.c.helper = {
    write(l) {
      f.sent.push(l);
      const reply = l === "launcher-open" ? open
        : gone && l.startsWith("launcher-") ? "launcher gone"
        : l.startsWith("launcher-move") ? "launcher moved"
        : l === "launcher-return" ? "launcher opened" : null;
      if (reply) setTimeout(() => f.c.onLine(reply), 0);
      return true;
    },
    stop() {},
  };
  return { ...f, steps };
}

test("launcher: open Spotlight and talk, stop talking, turn through results, open the pick", async () => {
  const { c, sent, steps } = launcherFake();
  c.launcherPush();
  await tick(5);
  assert.deepEqual(sent, ["launcher-open", "down 59"], "Spotlight first, then dictation (held: hold mode)");
  assert.equal(c.launcher, "listening");
  await c.launcherTurn(2);
  c.launcherPush(); // done talking
  assert.deepEqual(sent.slice(2), ["launcher-move 2", "up 59"]);
  assert.equal(c.launcher, "choosing");
  await c.launcherTurn(-1);
  c.launcherPush(); // open it
  await tick(5);
  assert.deepEqual(sent.slice(4), ["launcher-move -1", "launcher-return"]);
  assert.equal(c.launcher, "idle");
  assert.deepEqual(steps, ["opening", "listening", "choosing", "idle"]);
  c.stop();
});

test("launcher with Snaply in toggle mode: a tap starts dictation and a tap stops it", async () => {
  const { c, sent } = launcherFake({ mode: "toggle" });
  c.launcherPush();
  await tick(5);
  c.launcherPush();
  assert.deepEqual(sent, ["launcher-open", "tap 59", "tap 59"]);
  assert.equal(c.launcher, "choosing");
  c.stop();
});

test("launcher: if Spotlight was closed, nothing is opened and the knob starts over", async () => {
  const { c, sent, logs } = launcherFake({ gone: true }); // opens, then reports Spotlight gone
  c.launcherPush();
  await tick(5);
  await c.launcherTurn(1);
  assert.equal(c.launcher, "idle", "turned after Spotlight closed: reset");
  assert.ok(sent.includes("up 59"), "and the dictation key let go");
  assert.ok(logs.some((l) => l.includes("launcher reset (Spotlight was closed)")));
  c.stop();
});

test("launcher: Spotlight didn't open, so no dictation starts", async () => {
  const { c, sent } = launcherFake({ open: "launcher failed" });
  c.launcherPush();
  await tick(5);
  assert.deepEqual(sent, ["launcher-open"]);
  assert.equal(c.launcher, "idle");
});

test("launcher: another knob or key letting go of dictation moves it on to choosing", async () => {
  const { c } = launcherFake();
  c.launcherPush();
  await tick(5);
  c.letGo("another knob pushed");
  assert.equal(c.launcher, "choosing", "so the next push opens the pick instead of dictating again");
  c.stop();
});

test("launcher resets itself when left alone, letting go of the dictation key", async () => {
  const steps = [];
  const f = fake({ launcherLimitMs: 15, onChange: (s) => steps.push(s) });
  f.c.helper.write = (l) => (f.sent.push(l), l === "launcher-open" && setTimeout(() => f.c.onLine("launcher open"), 0), true);
  f.c.launcherPush();
  await tick(40);
  assert.equal(f.c.launcher, "idle");
  assert.ok(f.sent.includes("up 59"));
});

test("no reply from the key helper: the launcher gives up", async () => {
  const f = fake({ askMs: 10 });
  f.c.launcherPush();
  await tick(30);
  assert.equal(f.c.launcher, "idle");
  assert.ok(f.logs.some((l) => l.includes("Spotlight didn't open (no reply)")));
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
