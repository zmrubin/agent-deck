// Deck power (macOS): the deck goes dark while the Mac's displays sleep, so
// its screens aren't lit all night, and lights up again when they wake.
//
// displays.swift (compiled on first use, like windows.swift) prints "asleep"
// and "awake". OpenDeck owns device power: `opendeck --sleep-device <id>` and
// `--wake-device <id>`, handed to the running OpenDeck, are the same calls its
// own idle and lock sleep make (brightness 0 turns the S10's screens off).
//
// - Sleep only dims the S10's screens, so every key and the strip are drawn
//   black first (beforeSleep), leaving nothing to see.
// - The device plugin drops images sent while a deck sleeps, so drawing pauses
//   while asleep and everything is redrawn after waking.
// - Pressing a deck key while it's dark wakes it (OpenDeck does that). While
//   the displays still sleep, it's put back to sleep every few minutes.
// - A deck that reconnects while the displays sleep is put back to sleep too
//   (OpenDeck lights a deck up when it registers).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, supervise, swiftHelper } from "./helpers.mjs";

const HELPER_SRC = fileURLToPath(new URL("./displays.swift", import.meta.url));
const DEFAULT_OPENDECK = "/Applications/OpenDeck.app/Contents/MacOS/opendeck";

/** One display-helper line: "asleep" → true, "awake" → false, anything else → null. */
export function parseDisplayLine(line) {
  const s = String(line).trim();
  return s === "asleep" ? true : s === "awake" ? false : null;
}

/**
 * The OpenDeck executable: the process that launched us (looking a few
 * parents up), else the usual install path, else null.
 */
export async function findOpenDeck({
  pid = process.ppid,
  ps = (p) => run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(p)]),
  exists = fs.existsSync,
} = {}) {
  for (let i = 0; i < 4 && pid > 1; i++) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(await ps(pid).catch(() => ""));
    if (!m) break;
    if (path.basename(m[2]).toLowerCase() === "opendeck") return m[2];
    pid = Number(m[1]);
  }
  return exists(DEFAULT_OPENDECK) ? DEFAULT_OPENDECK : null;
}

/**
 * Follows display sleep and switches the decks to match. `asleep` says whether
 * the displays (and so the decks) are asleep right now.
 *
 *   devices()      ids of the decks to switch
 *   beforeSleep()  blank the decks; the sleep command waits for its promise
 *   onWake()       redraw everything; runs shortly after waking, and once more
 *                  a moment later in case OpenDeck took a while to light the deck
 */
export class DeckPower {
  constructor({
    devices = () => [],
    beforeSleep = async () => {},
    onWake = () => {},
    log = () => {},
    exec = (bin, args) => run(bin, args, 10_000),
    findBinary = findOpenDeck,
    resleepMs = 5 * 60_000,
    redrawMs = [400, 2000],
  } = {}) {
    Object.assign(this, { devices, beforeSleep, onWake, log, exec, findBinary, resleepMs, redrawMs });
    this.asleep = false;
    this.binary = null; // promise of the OpenDeck path (or null)
    this.queue = Promise.resolve(); // commands run one at a time, in order
    this.resleepTimer = null;
    this.redrawTimers = [];
    this.helper = null;
    this.stopped = true;
    this.warned = false;
  }

  start() {
    if (process.platform !== "darwin") return this.log("power: only implemented on macOS");
    this.stopped = false;
    swiftHelper(HELPER_SRC)
      .then((bin) => {
        if (this.stopped) return;
        this.helper = supervise({ name: "power: display helper", cmd: bin, onLine: (l) => this.onLine(l), log: this.log });
      })
      .catch((err) => this.log("power: no display helper, so the deck stays on while the displays sleep:", err.message));
  }

  stop() {
    this.stopped = true;
    this.helper?.stop();
    this.clearTimers();
  }

  /** Handle one display-helper line. */
  onLine(line) {
    const asleep = parseDisplayLine(line);
    if (asleep !== null) this.set(asleep);
  }

  /** The displays went to sleep (true) or woke (false). */
  set(asleep) {
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    this.clearTimers();
    this.log(`power: displays ${asleep ? "asleep, deck off" : "awake, deck on"}`);
    if (asleep) {
      this.queue = this.queue.then(() => this.beforeSleep()).catch((err) => this.log("power: blanking failed:", err.message));
      this.command("--sleep-device", this.devices());
      this.resleepTimer = setInterval(() => this.command("--sleep-device", this.devices()), this.resleepMs);
    } else {
      this.command("--wake-device", this.devices()).then(() => {
        if (this.asleep) return;
        this.redrawTimers = this.redrawMs.map((ms) => setTimeout(() => this.onWake(), ms));
      });
    }
  }

  /** A deck connected (or reconnected, which lights it up): keep it dark while the displays sleep. */
  noteDevice(id) {
    if (this.asleep && id) this.command("--sleep-device", [id]);
  }

  /** Queue `opendeck <flag> <id>` for each id; resolves once they've run. */
  command(flag, ids) {
    if (!ids.length) return this.queue;
    this.queue = this.queue.then(async () => {
      this.binary ??= this.findBinary();
      const bin = await this.binary;
      if (!bin) {
        if (!this.warned) this.log("power: OpenDeck not found, so the deck can't be switched off");
        this.warned = true;
        return;
      }
      for (const id of ids) {
        try {
          await this.exec(bin, [flag, id]);
        } catch (err) {
          this.log(`power: ${flag} ${id} failed:`, err.message);
        }
      }
    });
    return this.queue;
  }

  clearTimers() {
    clearInterval(this.resleepTimer);
    this.resleepTimer = null;
    for (const t of this.redrawTimers) clearTimeout(t);
    this.redrawTimers = [];
  }
}
