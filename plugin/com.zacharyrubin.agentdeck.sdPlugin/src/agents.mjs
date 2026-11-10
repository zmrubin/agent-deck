// Agent state store. Turns agent events (Claude Code hooks, or the generic
// format below) into one record per session.
//
// States:
//   working  – the agent is busy (prompt submitted, tools running)
//   waiting  – the agent is halted on a decision only you can make
//   done     – the agent finished its turn; your move whenever you like
//   idle     – session started, nothing asked yet
//
// Generic event format (for other tools and for testing):
//   { "session_id": "...", "cwd": "/path/project", "state": "waiting",
//     "message": "Approve npm publish?", "name": "optional display name" }
// "state": "ended" removes the agent.

import path from "node:path";

export const STATES = ["working", "waiting", "done", "idle"];

const IDLE_PROMPT = /waiting for your input/i;

function clip(s, n) {
  if (!s) return "";
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function describeTool(name, input = {}) {
  if (!name) return "";
  if (input.command) return `${name}: ${clip(input.command, 120)}`;
  if (input.file_path) return `${name}: ${path.basename(String(input.file_path))}`;
  if (input.pattern) return `${name}: ${clip(input.pattern, 80)}`;
  if (input.url) return `${name}: ${clip(input.url, 100)}`;
  if (input.description) return `${name}: ${clip(input.description, 100)}`;
  return name;
}

/** Map a raw event to {state, message} or {ended:true}; null = ignore. */
export function interpret(evt) {
  if (evt.state) {
    if (evt.state === "ended") return { ended: true };
    if (!STATES.includes(evt.state)) return null;
    return { state: evt.state, message: evt.message ?? "" };
  }
  switch (evt.hook_event_name) {
    case "SessionStart":
      return { state: "idle", message: "Ready" };
    case "UserPromptSubmit":
      return { state: "working", message: clip(evt.prompt, 200) };
    case "PreToolUse":
      return { state: "working", message: describeTool(evt.tool_name, evt.tool_input) };
    case "PostToolUse":
      return { state: "working", keepMessage: true };
    case "PreCompact":
      return { state: "working", message: "Compacting context" };
    case "Notification": {
      // notification_type: permission_prompt, idle_prompt, agent_needs_input, …
      // (older builds have no type; fall back to the message text).
      const type = evt.notification_type;
      if (type === "idle_prompt" || (!type && IDLE_PROMPT.test(evt.message || ""))) {
        return { state: "done", message: evt.message };
      }
      if (type && !["permission_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"].includes(type)) {
        return null; // auth, quota, plugin notices: not a state change
      }
      return { state: "waiting", message: evt.message || "Needs your attention", keepRequest: true };
    }
    case "Stop":
      return { state: "done", message: "Finished — your turn" };
    case "SessionEnd":
      return { ended: true };
    default:
      return null;
  }
}

export class AgentStore {
  constructor({ now = () => Date.now() } = {}) {
    this.agents = new Map();
    this.now = now;
    this.seq = 0;
  }

  /** Apply one event. meta = {bundleId, termProgram, tty, source}. Returns true if anything changed. */
  apply(evt, meta = {}) {
    const id = evt.session_id;
    if (!id) return false;
    const r = interpret(evt);
    if (!r) return false;
    if (r.ended) return this.agents.delete(id);

    const t = this.now();
    let a = this.agents.get(id);
    if (!a) {
      a = { id, order: this.seq++, firstSeen: t, state: "idle", message: "", stateSince: t };
      this.agents.set(id, a);
    }
    const before = JSON.stringify(a);

    if (evt.cwd) a.cwd = evt.cwd;
    if (evt.name) a.name = evt.name;
    for (const k of ["bundleId", "termProgram", "tty", "source"]) if (meta[k]) a[k] = meta[k];
    if (r.state !== a.state) {
      a.state = r.state;
      a.stateSince = t;
    }
    if (!r.keepMessage && !(r.keepRequest && a.request)) a.message = r.message ?? "";
    a.updated = t;

    return JSON.stringify(a) !== before;
  }

  /** Attach (or clear, with null) a pending permission request shown on the strip. */
  setRequest(id, request) {
    const a = this.agents.get(id);
    if (!a) return false;
    if (request) {
      a.request = request;
      a.message = `${request.tool}: ${request.detail}`;
      if (a.state !== "waiting") {
        a.state = "waiting";
        a.stateSince = this.now();
      }
    } else {
      delete a.request;
    }
    a.updated = this.now();
    return true;
  }

  /** Agents in slot order: oldest session first, so keys don't shuffle. */
  ordered() {
    return [...this.agents.values()].sort((x, y) => x.order - y.order);
  }

  /** Agents in urgency order for the strip: waiting (oldest first), done, working, idle. */
  byUrgency() {
    const rank = { waiting: 0, done: 1, working: 2, idle: 3 };
    return [...this.agents.values()].sort(
      (x, y) => rank[x.state] - rank[y.state] || x.stateSince - y.stateSince,
    );
  }

  counts() {
    const c = { working: 0, waiting: 0, done: 0, idle: 0 };
    for (const a of this.agents.values()) c[a.state]++;
    return c;
  }

  /** Drop sessions that went silent (e.g. terminal closed without SessionEnd). */
  prune(maxAgeMs) {
    const cutoff = this.now() - maxAgeMs;
    let changed = false;
    for (const [id, a] of this.agents) {
      if (a.updated < cutoff) changed = this.agents.delete(id) || changed;
    }
    return changed;
  }
}

/** Short display name: explicit name, else project folder, de-duplicated. */
export function displayNames(agents) {
  const base = agents.map((a) => a.name || (a.cwd ? path.basename(a.cwd) : "agent"));
  const seen = new Map();
  base.forEach((n) => seen.set(n, (seen.get(n) || 0) + 1));
  return base.map((n, i) => (seen.get(n) > 1 ? `${n}·${agents[i].id.slice(0, 4)}` : n));
}
