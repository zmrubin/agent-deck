import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/slots.mjs";

const apps = (...names) => names.map((n) => `app:${n}`);
const agents = (...ids) => ids.map((n) => `agent:${n}`);

test("fresh deck: agents fill the first keys, apps follow most recent first, rest empty", () => {
  assert.deepEqual(allocate({ count: 5, agents: agents("a", "b"), apps: apps("x", "y") }), [
    "agent:a", "agent:b", "app:x", "app:y", null,
  ]);
  assert.deepEqual(allocate({ count: 3, agents: [], apps: apps("x", "y", "z", "w") }), apps("x", "y", "z"));
  assert.deepEqual(allocate({ count: 0, agents: agents("a"), apps: apps("x") }), []);
});

test("a new agent on a full deck takes the least recently used app's key; nothing else moves", () => {
  const prev = allocate({ count: 4, agents: [], apps: apps("x", "y", "z", "w") });
  assert.deepEqual(prev, ["app:x", "app:y", "app:z", "app:w"]);
  // Recency is now y, w, x, z (z least recent); z sits on key 3.
  const next = allocate({ count: 4, agents: agents("a"), apps: apps("y", "w", "x", "z"), prev });
  assert.deepEqual(next, ["app:x", "app:y", "agent:a", "app:w"]);
});

test("a new agent prefers an empty key over evicting an app", () => {
  const prev = ["app:x", null, "app:y", null];
  assert.deepEqual(allocate({ count: 4, agents: agents("a"), apps: apps("x", "y"), prev }), ["app:x", "agent:a", "app:y", null]);
});

test("an ended agent's key goes back to the most recent app not on the deck", () => {
  const prev = ["app:x", "agent:a", "app:y"];
  const next = allocate({ count: 3, agents: [], apps: apps("y", "q", "x", "r"), prev });
  assert.deepEqual(next, ["app:x", "app:q", "app:y"]);
});

test("agents keep their keys when other agents come and go", () => {
  let prev = allocate({ count: 4, agents: agents("a", "b", "c"), apps: apps("x") });
  assert.deepEqual(prev, ["agent:a", "agent:b", "agent:c", "app:x"]);
  prev = allocate({ count: 4, agents: agents("a", "c"), apps: apps("x", "y"), prev });
  assert.deepEqual(prev, ["agent:a", "app:y", "agent:c", "app:x"]);
  prev = allocate({ count: 4, agents: agents("a", "c", "d"), apps: apps("x", "y"), prev });
  assert.deepEqual(prev, ["agent:a", "agent:d", "agent:c", "app:x"], "d takes y's key (y is least recent)");
});

test("agents always win: with more agents than keys, no app shows and placed agents stay", () => {
  let prev = allocate({ count: 2, agents: agents("a", "b", "c"), apps: apps("x") });
  assert.deepEqual(prev, ["agent:a", "agent:b"]);
  // a ends: c (next in line) takes its key, b stays put.
  prev = allocate({ count: 2, agents: agents("b", "c"), apps: apps("x"), prev });
  assert.deepEqual(prev, ["agent:c", "agent:b"]);
  // A new agent never displaces an agent already on the deck.
  prev = allocate({ count: 2, agents: agents("d", "b", "c"), apps: [], prev });
  assert.deepEqual(prev, ["agent:c", "agent:b"]);
});

test("switching between apps already on the deck moves no keys", () => {
  const prev = ["app:x", "app:y", "app:z"];
  assert.deepEqual(allocate({ count: 3, agents: [], apps: apps("z", "x", "y", "w"), prev }), prev);
});

test("an off-deck app that comes to the front replaces the least recently used app in place", () => {
  const prev = ["app:x", "app:y", "app:z"];
  // w came to the front; y is now least recent of the four.
  assert.deepEqual(allocate({ count: 3, agents: [], apps: apps("w", "x", "z", "y"), prev }), ["app:x", "app:w", "app:z"]);
});

test("a quit app's key goes to the next most recent app; with none left it empties", () => {
  assert.deepEqual(allocate({ count: 3, agents: [], apps: apps("x", "z", "q"), prev: ["app:x", "app:y", "app:z"] }), ["app:x", "app:q", "app:z"]);
  assert.deepEqual(allocate({ count: 3, agents: [], apps: apps("x", "z"), prev: ["app:x", "app:y", "app:z"] }), ["app:x", null, "app:z"]);
});

test("an app that becomes an agent's host is replaced by that agent in place", () => {
  // Terminal is on key 1; an agent starts in Terminal, so Terminal leaves the app list.
  const prev = ["app:chrome", "app:terminal", "app:notes"];
  assert.deepEqual(allocate({ count: 3, agents: agents("a"), apps: apps("chrome", "notes", "mail"), prev }), ["app:chrome", "agent:a", "app:notes"]);
});

test("allocation is stable: feeding the result back changes nothing", () => {
  const input = { count: 6, agents: agents("a", "b"), apps: apps("x", "y", "z", "w", "v") };
  const first = allocate(input);
  assert.deepEqual(allocate({ ...input, prev: first }), first);
});

test("fewer keys than before: keys beyond the new count are dropped, nothing duplicates", () => {
  const prev = ["app:x", "agent:a", "app:y", "agent:b"];
  const next = allocate({ count: 2, agents: agents("a", "b"), apps: apps("x", "y"), prev });
  assert.deepEqual(next, ["agent:b", "agent:a"]);
  const more = allocate({ count: 5, agents: agents("a"), apps: apps("x"), prev: ["app:x", "app:x", "agent:a"] });
  assert.deepEqual(more, ["app:x", null, "agent:a", null, null]);
});
