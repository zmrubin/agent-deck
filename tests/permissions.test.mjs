import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PermissionBroker, describeRequest, hookOutput } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/permissions.mjs";
import { AgentStore } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/agents.mjs";
import { stripPanels } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/render.mjs";

// Shape from the Claude Code hooks reference (PermissionRequest).
const REQ = {
  session_id: "s1",
  cwd: "/x/proj",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf node_modules", description: "Remove node_modules directory" },
  permission_suggestions: [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf node_modules" }], behavior: "allow", destination: "localSettings" },
  ],
};

/** Minimal stand-in for http.ServerResponse. */
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = (code) => { res.code = code; return res; };
  res.end = (body = "") => { res.body = body; res.writableEnded = true; };
  return res;
}

test("describeRequest pulls out the tool and the specific command", () => {
  const r = describeRequest(REQ);
  assert.equal(r.tool, "Bash");
  assert.equal(r.detail, "rm -rf node_modules");
  assert.equal(r.canAlways, true);
  assert.equal(describeRequest({ tool_name: "Edit", tool_input: { file_path: "/a/b/c.js" } }).detail, "/a/b/c.js");
  assert.equal(describeRequest({ tool_name: "Read", tool_input: {} }).canAlways, false);
});

test("hookOutput matches the documented PermissionRequest decision schema", () => {
  const r = describeRequest(REQ);
  assert.deepEqual(hookOutput("allow", r), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.deepEqual(hookOutput("always", r).hookSpecificOutput.decision, { behavior: "allow", updatedPermissions: REQ.permission_suggestions });
  const deny = hookOutput("deny", r).hookSpecificOutput.decision;
  assert.equal(deny.behavior, "deny");
  assert.equal(typeof deny.message, "string");
  assert.equal(hookOutput("terminal", r), null);
});

test("broker holds the response until a choice, then replies once", () => {
  const changes = [];
  const b = new PermissionBroker({ onChange: (id, r) => changes.push([id, r?.tool ?? null]) });
  const res = fakeRes();
  b.open("s1", REQ, res);
  assert.equal(res.writableEnded, false);
  assert.equal(b.get("s1").tool, "Bash");
  assert.equal(b.decide("s1", "allow"), true);
  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(b.get("s1"), null);
  assert.equal(b.decide("s1", "allow"), false, "nothing pending any more");
  assert.deepEqual(changes, [["s1", "Bash"], ["s1", null]]);
});

test("release replies with no decision; always is refused without suggestions", () => {
  const b = new PermissionBroker();
  const res = fakeRes();
  b.open("s1", { ...REQ, permission_suggestions: undefined }, res);
  assert.equal(b.decide("s1", "always"), false);
  assert.equal(res.writableEnded, false);
  b.release("s1");
  assert.equal(res.body, "");
  assert.equal(b.get("s1"), null);
});

test("a hook that goes away drops its request; a new request supersedes the old", () => {
  const b = new PermissionBroker();
  const first = fakeRes();
  b.open("s1", REQ, first);
  const second = fakeRes();
  b.open("s1", { ...REQ, tool_input: { command: "ls" } }, second);
  assert.equal(first.body, "", "superseded request released without decision");
  assert.equal(b.get("s1").detail, "ls");
  second.emit("close");
  assert.equal(b.get("s1"), null);
});

test("timeout releases without a decision", async () => {
  const b = new PermissionBroker({ timeoutMs: 20 });
  const res = fakeRes();
  b.open("s1", REQ, res);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(res.body, "");
  assert.equal(b.get("s1"), null);
});

test("store shows the request; a permission Notification doesn't overwrite it", () => {
  const s = new AgentStore();
  s.apply({ session_id: "s1", cwd: "/x/proj", state: "working" });
  s.setRequest("s1", describeRequest(REQ));
  assert.equal(s.ordered()[0].state, "waiting");
  assert.equal(s.ordered()[0].message, "Bash: rm -rf node_modules");
  s.apply({ session_id: "s1", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(s.ordered()[0].message, "Bash: rm -rf node_modules");
  s.apply({ session_id: "s1", hook_event_name: "Notification", notification_type: "auth_success", message: "x" });
  assert.equal(s.ordered()[0].state, "waiting", "non-state notifications are ignored");
  s.setRequest("s1", null);
  assert.equal(s.ordered()[0].request, undefined);
});

test("strip shows the decision view with four choices when a request is pending", () => {
  const agent = { state: "waiting", request: describeRequest(REQ), message: "" };
  const panels = stripPanels({ agent, name: "proj", index: 0, total: 1, counts: { waiting: 1 } });
  for (const label of ["Allow", "Always allow", "Deny", "In terminal"]) assert.match(panels[0], new RegExp(label));
  assert.match(panels[0], /proj wants to use Bash/);
  assert.match(panels[0], /rm -rf node_modules/);
});
