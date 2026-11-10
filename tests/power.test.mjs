import { test } from "node:test";
import assert from "node:assert/strict";
import { DeckPower, findOpenDeck, parseDisplayLine } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/power.mjs";

const OPENDECK = "/Applications/OpenDeck.app/Contents/MacOS/opendeck";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A DeckPower with a fake OpenDeck that records each command. */
function fake(opts = {}) {
  const calls = [];
  const wakes = [];
  const power = new DeckPower({
    devices: () => ["n4-A"],
    onWake: () => wakes.push(Date.now()),
    findBinary: async () => "/fake/opendeck",
    exec: async (bin, args) => calls.push([bin, ...args].join(" ")),
    redrawMs: [0, 5],
    ...opts,
  });
  return { power, calls, wakes };
}

test("parseDisplayLine reads the helper's two words and ignores anything else", () => {
  assert.equal(parseDisplayLine("asleep"), true);
  assert.equal(parseDisplayLine("awake\n"), false);
  assert.equal(parseDisplayLine(""), null);
  assert.equal(parseDisplayLine("[[1,2,3,1]]"), null);
});

test("findOpenDeck walks up to the OpenDeck process that launched the plugin", async () => {
  const tree = { 300: "  200 /bin/sh", 200: `  1 ${OPENDECK}` };
  assert.equal(await findOpenDeck({ pid: 300, ps: async (p) => tree[p], exists: () => false }), OPENDECK);

  const elsewhere = "/Users/me/Applications/OpenDeck.app/Contents/MacOS/opendeck";
  assert.equal(await findOpenDeck({ pid: 9, ps: async () => `1 ${elsewhere}`, exists: () => false }), elsewhere);
});

test("findOpenDeck falls back to the usual install path, else null", async () => {
  const notDeck = { ps: async () => "1 /usr/bin/node" };
  assert.equal(await findOpenDeck({ pid: 9, ...notDeck, exists: (p) => p === OPENDECK }), OPENDECK);
  assert.equal(await findOpenDeck({ pid: 9, ...notDeck, exists: () => false }), null);
  const failing = { ps: async () => { throw new Error("no ps"); } };
  assert.equal(await findOpenDeck({ pid: 9, ...failing, exists: () => false }), null);
});

test("displays sleeping turns every deck off, once", async () => {
  const { power, calls } = fake({ devices: () => ["n4-A", "n4-B"] });
  power.onLine("asleep");
  power.onLine("asleep");
  await power.queue;
  assert.equal(power.asleep, true);
  assert.deepEqual(calls, ["/fake/opendeck --sleep-device n4-A", "/fake/opendeck --sleep-device n4-B"]);
  power.stop();
});

test("waking turns the deck on and then redraws it, twice", async () => {
  const { power, calls, wakes } = fake();
  power.set(true);
  power.set(false);
  await power.queue;
  await tick(20);
  assert.equal(power.asleep, false);
  assert.deepEqual(calls, ["/fake/opendeck --sleep-device n4-A", "/fake/opendeck --wake-device n4-A"]);
  assert.equal(wakes.length, 2);
});

test("commands reach OpenDeck in order even when one is slow", async () => {
  const calls = [];
  const { power } = fake({
    exec: async (bin, args) => {
      if (args[0] === "--sleep-device") await tick(15); // a slow sleep must not land after the wake
      calls.push(args[0]);
    },
  });
  power.set(true);
  power.set(false);
  await power.queue;
  assert.deepEqual(calls, ["--sleep-device", "--wake-device"]);
});

test("no redraw if the displays went back to sleep before the deck woke", async () => {
  const { power, wakes } = fake();
  power.set(true);
  power.set(false);
  power.set(true);
  await power.queue;
  await tick(20);
  assert.equal(wakes.length, 0);
  power.stop();
});

test("a deck woken by a key press is put back to sleep while the displays still sleep", async () => {
  const { power, calls } = fake({ resleepMs: 10 });
  power.set(true);
  await tick(35);
  const sleeps = calls.filter((c) => c.includes("--sleep-device")).length;
  assert.ok(sleeps >= 3, `expected repeated sleeps, got ${sleeps}`);
  power.set(false);
  await power.queue;
  const after = calls.length;
  await tick(30);
  assert.equal(calls.length, after, "no more sleeps once the displays are awake");
});

test("a deck that (re)connects while the displays sleep goes straight back to sleep", async () => {
  const { power, calls } = fake();
  power.noteDevice("n4-B");
  await power.queue;
  assert.deepEqual(calls, [], "awake: leave it alone");
  power.set(true);
  power.noteDevice("n4-B");
  await power.queue;
  assert.deepEqual(calls, ["/fake/opendeck --sleep-device n4-A", "/fake/opendeck --sleep-device n4-B"]);
  power.stop();
});

test("without OpenDeck it only logs, once", async () => {
  const logs = [];
  const { power, calls } = fake({ findBinary: async () => null, log: (...a) => logs.push(a.join(" ")) });
  power.set(true);
  power.set(false);
  await power.queue;
  assert.deepEqual(calls, []);
  assert.equal(logs.filter((l) => l.includes("OpenDeck not found")).length, 1);
});

test("a failed command is logged and doesn't block the next one", async () => {
  const logs = [];
  const calls = [];
  const { power } = fake({
    log: (...a) => logs.push(a.join(" ")),
    exec: async (bin, args) => {
      calls.push(args[0]);
      if (args[0] === "--sleep-device") throw new Error("boom");
    },
  });
  power.set(true);
  power.set(false);
  await power.queue;
  assert.deepEqual(calls, ["--sleep-device", "--wake-device"]);
  assert.ok(logs.some((l) => l.includes("--sleep-device n4-A failed: boom")));
});

test("the deck is blanked before it's put to sleep (its screens only dim)", async () => {
  const order = [];
  const { power } = fake({
    beforeSleep: async () => {
      order.push("blank");
      await tick(10);
      order.push("blanked");
    },
    exec: async (bin, args) => order.push(args[0]),
  });
  power.set(true);
  await power.queue;
  assert.deepEqual(order, ["blank", "blanked", "--sleep-device"]);
  power.stop();
});

test("a failed blank still puts the deck to sleep", async () => {
  const logs = [];
  const { power, calls } = fake({
    beforeSleep: async () => {
      throw new Error("no deck");
    },
    log: (...a) => logs.push(a.join(" ")),
  });
  power.set(true);
  await power.queue;
  assert.deepEqual(calls, ["/fake/opendeck --sleep-device n4-A"]);
  assert.ok(logs.some((l) => l.includes("blanking failed: no deck")));
  power.stop();
});
