// Permission requests answered from the deck.
//
// Claude Code's PermissionRequest hook (hooks/agent-deck-permission.sh) POSTs
// the request to /permission and waits. The broker holds that HTTP response
// open until the user picks a choice on the deck (or answers elsewhere), then
// replies with the JSON the hook prints back to Claude Code.
//
// Choices (one per knob): allow · always · deny · terminal.
// "terminal" (and any timeout/abandon) replies with no decision, so Claude
// Code falls back to its normal in-terminal permission dialog.

import path from "node:path";

const clip = (s, n) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** What the request is about, for the strip: tool name + the specific command/file/etc. */
export function describeRequest(evt) {
  const tool = evt.tool_name || "a tool";
  const input = evt.tool_input || {};
  let detail = "";
  if (input.command) detail = input.command;
  else if (input.file_path) detail = input.file_path.replace(process.env.HOME || "\u0000", "~");
  else if (input.url) detail = input.url;
  else if (input.pattern) detail = `${input.pattern}${input.path ? "  in " + path.basename(input.path) : ""}`;
  else if (input.description) detail = input.description;
  else if (Object.keys(input).length) detail = JSON.stringify(input);
  const suggestions = Array.isArray(evt.permission_suggestions) ? evt.permission_suggestions : [];
  return { tool, detail: clip(detail, 200), canAlways: suggestions.length > 0, suggestions };
}

/** The JSON a PermissionRequest hook prints to stdout for a choice; null = no decision (normal dialog). */
export function hookOutput(choice, request) {
  const decision =
    choice === "allow" ? { behavior: "allow" }
    : choice === "always" ? { behavior: "allow", updatedPermissions: request.suggestions }
    : choice === "deny" ? { behavior: "deny", message: "Denied from Agent Deck." }
    : null;
  if (!decision) return null;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

export class PermissionBroker {
  /** onChange(agentId, request|null) is called whenever an agent's pending request changes. */
  constructor({ onChange = () => {}, timeoutMs = 9 * 60 * 1000 } = {}) {
    this.pending = new Map(); // agentId -> { request, res, timer }
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
  }

  /** Hold `res` open for this request. Replaces (and releases) an older pending request from the same agent. */
  open(agentId, evt, res) {
    this.release(agentId, "superseded");
    const request = { id: ++this.seq, ...describeRequest(evt) };
    const timer = setTimeout(() => this.release(agentId, "timeout"), this.timeoutMs);
    const entry = { request, res, timer };
    this.pending.set(agentId, entry);
    // Hook killed / user answered in the terminal and Claude moved on: drop it.
    res.on("close", () => {
      if (this.pending.get(agentId) === entry && !res.writableEnded) this.release(agentId, "hook went away");
    });
    this.onChange(agentId, request);
    return request;
  }

  get(agentId) {
    return this.pending.get(agentId)?.request ?? null;
  }

  /** Answer the agent's pending request. Returns false if there wasn't one (or the choice isn't available). */
  decide(agentId, choice) {
    const entry = this.pending.get(agentId);
    if (!entry) return false;
    if (choice === "always" && !entry.request.canAlways) return false;
    this.#finish(agentId, entry, hookOutput(choice, entry.request));
    return true;
  }

  /** Let go of a pending request without a decision (Claude shows its own dialog). */
  release(agentId, _why) {
    const entry = this.pending.get(agentId);
    if (entry) this.#finish(agentId, entry, null);
  }

  #finish(agentId, entry, output) {
    clearTimeout(entry.timer);
    this.pending.delete(agentId);
    if (!entry.res.writableEnded) {
      entry.res.writeHead(200, { "content-type": "application/json" });
      entry.res.end(output ? JSON.stringify(output) : "");
    }
    this.onChange(agentId, null);
  }
}
