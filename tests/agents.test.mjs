import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentStore, interpret, displayNames } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/agents.mjs";
import { keySvg, stripPanels, wrap, wrapPx, textWidth } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/render.mjs";

const hook = (name, extra = {}) => ({ session_id: "s1", cwd: "/x/my-project", hook_event_name: name, ...extra });

test("Claude Code hook events map to states", () => {
  assert.equal(interpret(hook("SessionStart")).state, "idle");
  assert.equal(interpret(hook("UserPromptSubmit", { prompt: "fix it" })).state, "working");
  assert.equal(interpret(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } })).message, "Bash: npm test");
  assert.equal(interpret(hook("Notification", { message: "Claude needs your permission to use Bash" })).state, "waiting");
  assert.equal(interpret(hook("Notification", { message: "Claude is waiting for your input" })).state, "done");
  assert.equal(interpret(hook("Stop")).state, "done");
  assert.deepEqual(interpret(hook("SessionEnd")), { ended: true });
  assert.equal(interpret(hook("SubagentStop")), null);
});

test("permission flow: waiting, then PostToolUse returns to working", () => {
  const s = new AgentStore();
  s.apply(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
  s.apply(hook("Notification", { message: "Claude needs your permission to use Bash" }));
  assert.equal(s.ordered()[0].state, "waiting");
  s.apply(hook("PostToolUse"));
  const a = s.ordered()[0];
  assert.equal(a.state, "working");
  assert.equal(a.message, "Claude needs your permission to use Bash", "PostToolUse keeps the last message");
});

test("slot order is stable; urgency order puts waiting first", () => {
  let t = 0;
  const s = new AgentStore({ now: () => ++t });
  s.apply({ session_id: "a", state: "working" });
  s.apply({ session_id: "b", state: "done" });
  s.apply({ session_id: "c", state: "waiting", message: "?" });
  assert.deepEqual(s.ordered().map((a) => a.id), ["a", "b", "c"]);
  assert.deepEqual(s.byUrgency().map((a) => a.id), ["c", "b", "a"]);
  assert.deepEqual(s.counts(), { working: 1, waiting: 1, done: 1, idle: 0 });
  s.apply({ session_id: "b", state: "ended" });
  assert.deepEqual(s.ordered().map((a) => a.id), ["a", "c"]);
});

test("meta from headers is kept; unchanged events report no change", () => {
  const s = new AgentStore({ now: () => 1 });
  assert.equal(s.apply({ session_id: "a", state: "working", message: "m" }, { bundleId: "com.googlecode.iterm2" }), true);
  assert.equal(s.ordered()[0].bundleId, "com.googlecode.iterm2");
  assert.equal(s.apply({ session_id: "a", state: "working", message: "m" }), false);
});

test("prune drops silent sessions", () => {
  let t = 0;
  const s = new AgentStore({ now: () => t });
  s.apply({ session_id: "a", state: "working" });
  t = 1000;
  assert.equal(s.prune(500), true);
  assert.equal(s.ordered().length, 0);
});

test("display names de-duplicate same project", () => {
  const n = displayNames([{ id: "abcd1", cwd: "/x/app" }, { id: "efgh2", cwd: "/y/app" }, { id: "z", cwd: "/z/web" }]);
  assert.deepEqual(n, ["app·abcd", "app·efgh", "web"]);
});

test("wrap breaks words and adds an ellipsis on overflow", () => {
  assert.deepEqual(wrap("one two three four", 9, 2), ["one two", "three…"]);
  assert.deepEqual(wrap("abcdefghijkl", 5, 3), ["abcde", "fghij", "kl"]);
});

test("rendering: keys blink only when waiting; strip is four slices of one scene", () => {
  const waiting = { state: "waiting", message: "Approve <deploy> & push?" };
  assert.notEqual(keySvg({ agent: waiting, name: "api", slot: 1, blinkOn: true }), keySvg({ agent: waiting, name: "api", slot: 1, blinkOn: false }));
  const working = { state: "working" };
  assert.equal(keySvg({ agent: working, name: "api", slot: 1, blinkOn: true }), keySvg({ agent: working, name: "api", slot: 1, blinkOn: false }));
  const panels = stripPanels({ agent: waiting, name: "api", index: 0, total: 1, counts: { waiting: 1 } });
  assert.equal(panels.length, 4);
  panels.forEach((p, i) => {
    assert.match(p, /^<svg[^>]*width="200" height="100" viewBox="0 0 200 100"/);
    assert.match(p, new RegExp(`<g transform="scale\\(1 0\\.78125\\) translate\\(${-i * 200} 0\\)">`));
  });
  assert.match(panels[0], /&lt;deploy&gt;/);
  assert.match(panels[0], /&amp;/);
  assert.doesNotMatch(panels[0], /<deploy>/);
});

test("strip lines are wrapped to the full 800px width", () => {
  const msg = "Claude needs your permission to use Bash: git push --force origin main and then deploy the billing service to production";
  const lines = wrapPx(msg, 760, 24, false, 2);
  assert.ok(lines.length >= 1 && lines.length <= 2);
  lines.forEach((l) => assert.ok(textWidth(l, 24) <= 760, `line too wide: "${l}"`));
  assert.ok(lines[0].length > 55, "first line should use most of the strip");
  const long = wrapPx("word ".repeat(200), 760, 24, false, 2);
  assert.ok(long.at(-1).endsWith("…"));
  assert.deepEqual(wrapPx("short message", 760, 24, false, 2), ["short message"]);
});
