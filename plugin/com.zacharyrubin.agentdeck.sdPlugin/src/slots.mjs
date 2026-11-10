// Which agent or app each key shows. Pure function, no I/O.
//
// Agents always win: every agent gets a key before any app does. Keys left
// over show running apps, most recently used first. Assignments are sticky:
// a key keeps the same agent or app for as long as it stays on the deck, so
// keys don't move as things change:
//   - a new agent takes an empty key, else the key of the least recently used app;
//   - an ended agent's key goes to the most recently used app not on the deck;
//   - an app that comes to the front while off the deck takes the key of the
//     least recently used app on it.
// With no previous layout, agents fill the first keys and apps follow.

/**
 * @param {object} o
 * @param {number} o.count            number of keys
 * @param {string[]} o.agents         agent ids, priority order (oldest session first)
 * @param {string[]} o.apps           app ids, most recently used first
 * @param {(string|null)[]} [o.prev]  this function's previous result for the same keys
 * @returns {(string|null)[]}         one id per key; null = empty key
 * Agent and app ids must not overlap (callers prefix them).
 */
export function allocate({ count, agents, apps, prev = [] }) {
  const n = Math.max(0, count | 0);
  const before = new Set(prev.slice(0, n).filter(Boolean));

  // Which agents get keys: ones already on the deck keep theirs, then newcomers in order.
  const onDeck = agents.filter((id) => before.has(id));
  const newcomers = agents.filter((id) => !before.has(id));
  const chosenAgents = [...onDeck, ...newcomers].slice(0, n);
  // Apps fill whatever is left, most recent first.
  const chosenApps = apps.filter((id) => !chosenAgents.includes(id)).slice(0, n - chosenAgents.length);
  const wanted = new Set([...chosenAgents, ...chosenApps]);

  // Keep everything that is still wanted where it is.
  const out = Array(n).fill(null);
  const placed = new Set();
  for (let i = 0; i < n; i++) {
    const id = prev[i];
    if (id && wanted.has(id) && !placed.has(id)) {
      out[i] = id;
      placed.add(id);
    }
  }

  // Newcomers take the lowest free keys: agents first, then apps by recency.
  // A free key is either empty or was held by something no longer wanted
  // (an ended agent, a quit app, the least recently used app).
  const incoming = [...chosenAgents, ...chosenApps].filter((id) => !placed.has(id));
  let k = 0;
  for (let i = 0; i < n && k < incoming.length; i++) {
    if (out[i] === null) out[i] = incoming[k++];
  }
  return out;
}
