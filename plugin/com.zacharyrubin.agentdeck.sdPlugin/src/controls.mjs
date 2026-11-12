// Knob controls for the computer (macOS):
// - leftmost: the app launcher, by voice. Push once to open Spotlight (Cmd-Space)
//   and start dictating; push again to stop, so the words land in its search
//   box; turn to move through the results; push a third time to open the
//   highlighted one. Each step checks Spotlight is still open (keys.swift), so
//   the Return never lands in another app; if it was closed, the knob resets.
// - second: picks a tab, conversation, chat or note while the strip lists
//   them (main.mjs): turn to move, push to open.
// - third, turn: scroll like a mouse wheel where the pointer is;
//   push: start or stop dictation in Snaply.
// - rightmost, turn: move between fields in the app in front (Tab / Shift-Tab);
//   push: click whatever is highlighted (keys.swift `click`).
// So you can tab to a box, dictate into it, then tab to the button and click.
// While an agent's permission question is on the strip, pushes answer it instead.
//
// Keystrokes go through keys.swift (compiled on first use, like the other
// helpers), a long-running helper that posts keyboard events. macOS only
// allows that with the Accessibility permission, which belongs to OpenDeck
// (it launches the plugin): System Settings → Privacy & Security → Accessibility.
//
// Dictation presses Snaply's own dictation shortcut, read from
// ~/.snaply/settings.json on every push so changes made in Snaply apply at once:
// - "toggle" / "combined": a quick tap starts or stops it.
// - "hold" (push-to-talk): the first push holds the key down and the next push
//   lets go, since the knob reports no release of its own. It's let go after
//   five minutes regardless, and when the plugin stops. While it's held, keys
//   you type and clicks you make carry that modifier too.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supervise, swiftHelper } from "./helpers.mjs";

const HELPER_SRC = fileURLToPath(new URL("./keys.swift", import.meta.url));
export const LAUNCH_KNOB = 0; // dial column: leftmost (app launcher by voice)
export const PICK_KNOB = 1; // dial column: second (picks from the strip's list: tabs, conversations…)
export const DICTATE_KNOB = 2; // dial column: second from the right (scroll / dictate)
export const COMPUTER_KNOB = 3; // dial column: rightmost (Tab / click)

/**
 * What a knob push (or strip tap, `touch`) in dial `column` does: "choose"
 * (answer the permission question on the strip), "launch" (the next launcher
 * step), "open" (open the tab, conversation, chat or note highlighted on the
 * strip), "dictate", "click", or "jump" (to what the strip shows). `pending`:
 * a permission question is showing; `list`: the strip lists an app's tabs,
 * conversations, chats or notes.
 */
export function knobPush(column, { pending = false, touch = false, list = false } = {}) {
  if (pending) return "choose";
  if (touch) return "jump";
  if (column === LAUNCH_KNOB) return "launch";
  if (column === PICK_KNOB && list) return "open";
  if (column === DICTATE_KNOB) return "dictate";
  if (column === COMPUTER_KNOB) return "click";
  return "jump";
}

/**
 * What turning the knob in dial `column` does: "fields" (Tab / Shift-Tab),
 * "scroll", "launcher" (move through the launcher's results), "pick" (move
 * the highlight through the strip's list: tabs, conversations, chats, notes),
 * "agents" (cycle the featured agent), or "none". `launcher`: the launcher is
 * open; `app`: the strip shows an app, which stays there until an agent's key
 * is pressed, so the first two knobs don't switch it back to the agents.
 */
export function knobTurn(column, { list = false, app = false, launcher = false } = {}) {
  if (column === COMPUTER_KNOB) return "fields";
  if (column === DICTATE_KNOB) return "scroll";
  if (column === LAUNCH_KNOB && launcher) return "launcher";
  if (column === PICK_KNOB && list) return "pick";
  return app ? "none" : "agents";
}
export const SNAPLY_BUNDLE = "com.snaply.app";
export const SNAPLY_SETTINGS = path.join(os.homedir(), ".snaply/settings.json");

/**
 * Snaply's dictation shortcut from its settings JSON: { keycode, behavior,
 * label }, or null when it can't be read or isn't a single key.
 */
export function snaplyShortcut(text) {
  try {
    const d = JSON.parse(text)?.dictation;
    const keycode = Number(d?.shortcut?.key);
    if (d?.shortcut?.type !== "single-key" || !Number.isInteger(keycode)) return null;
    return { keycode, behavior: d.shortcutBehavior || "combined", label: d.shortcut.label || `key ${keycode}` };
  } catch {
    return null;
  }
}

export class Controls {
  /**
   * isRunning(): whether Snaply is open. launch(): open it. readSettings():
   * Snaply's settings JSON text. onChange(): the launcher moved to another step.
   */
  constructor({
    log = () => {},
    isRunning = () => true,
    launch = () => {},
    readSettings = () => fs.readFileSync(SNAPLY_SETTINGS, "utf8"),
    onChange = () => {},
    holdLimitMs = 5 * 60_000,
    launcherLimitMs = 2 * 60_000,
    askMs = 2000,
  } = {}) {
    Object.assign(this, { log, isRunning, launch, readSettings, onChange, holdLimitMs, launcherLimitMs, askMs });
    this.helper = null; // { write, stop } once keys.swift is running
    this.trusted = null; // whether macOS lets the helper post keys (null = not known yet)
    this.prompted = false;
    this.held = null; // keycode held down for push-to-talk dictation
    this.holdTimer = null;
    this.launcher = "idle"; // knob 1: "idle" | "opening" | "listening" | "choosing"
    this.launcherTimer = null;
    this.tapped = null; // keycode tapped to start the launcher's dictation (toggle mode), tapped again to stop
    this.waiters = []; // ask()s waiting for the helper's "launcher …" replies, in order
  }

  start() {
    if (process.platform !== "darwin") return this.log("controls: only implemented on macOS");
    this.stopped = false;
    swiftHelper(HELPER_SRC)
      .then((bin) => {
        if (this.stopped) return;
        this.helper = supervise({ name: "controls: key helper", cmd: bin, stdin: true, onLine: (l) => this.onLine(l), log: this.log });
      })
      .catch((err) => this.log("controls: no key helper, so the right knob can't send keys:", err.message));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.holdTimer);
    clearTimeout(this.launcherTimer);
    this.helper?.stop(); // the helper lets go of anything still held
  }

  onLine(line) {
    const s = line.trim();
    if (s.startsWith("click ")) return this.log(`controls: ${s}`);
    if (s.startsWith("launcher ")) {
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(s);
      }
      return;
    }
    if (s !== "trusted" && s !== "untrusted") return;
    this.trusted = s === "trusted";
    if (!this.trusted) this.log("controls: OpenDeck needs the Accessibility permission for the right knob (System Settings → Privacy & Security → Accessibility)");
  }

  /** Send one command to the key helper. */
  send(line) {
    if (this.trusted === false && !this.prompted) {
      this.prompted = true; // macOS shows its permission dialog once
      this.helper?.write("prompt");
    }
    if (!this.helper?.write(line)) this.log(`controls: key helper not running; dropped "${line}"`);
  }

  /** Rightmost knob turned: move between fields. */
  tab(ticks) {
    const n = Math.trunc(ticks || 0);
    if (n) this.send(`tab ${n}`);
  }

  /** Second knob from the right turned: scroll where the pointer is, down for positive ticks. */
  scroll(ticks) {
    const n = Math.trunc(ticks || 0);
    if (n) this.send(`scroll ${n}`);
  }

  /** Rightmost knob pushed: click whatever is highlighted. */
  click() {
    this.send("click");
  }

  /** Second knob from the right pushed: start or stop dictation. */
  dictate() {
    if (this.held !== null) return this.letGo("pushed again");
    this.startTalking();
  }

  /**
   * Start dictation with Snaply's shortcut (held down in hold mode, else
   * tapped). Returns the shortcut, or null when it couldn't: Snaply wasn't
   * running (it's opened instead) or its shortcut can't be read.
   */
  startTalking() {
    if (!this.isRunning()) {
      this.log("controls: Snaply isn't running; opening it");
      this.launch();
      return null;
    }
    let shortcut = null;
    try {
      shortcut = snaplyShortcut(this.readSettings());
    } catch {}
    if (!shortcut) {
      this.log("controls: couldn't read Snaply's dictation shortcut (a single key is expected)");
      return null;
    }
    if (shortcut.behavior === "hold") {
      this.held = shortcut.keycode;
      this.send(`down ${shortcut.keycode}`);
      this.holdTimer = setTimeout(() => this.letGo(`held ${Math.round(this.holdLimitMs / 60_000)} minutes`), this.holdLimitMs);
      this.log(`controls: dictation started (holding ${shortcut.label})`);
    } else {
      this.send(`tap ${shortcut.keycode}`);
      this.log(`controls: dictation toggled (tapped ${shortcut.label})`);
    }
    return shortcut;
  }

  /** Release the push-to-talk key. */
  letGo(why) {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.held === null) return;
    this.send(`up ${this.held}`);
    this.held = null;
    this.log(`controls: dictation stopped (${why})`);
    if (this.launcher === "listening") this.setLauncher("choosing"); // the words are in; pick a result
  }

  // ---------------------------------------------------------------- knob 1: launcher

  /** Knob 1 pushed: open the launcher and start dictating, stop dictating, or open the highlighted result. */
  launcherPush() {
    if (this.launcher === "idle") return this.openLauncher();
    if (this.launcher === "listening") return this.doneTalking();
    if (this.launcher === "choosing") return this.openChoice();
    // "opening": Spotlight is on its way; this push is dropped
  }

  async openLauncher() {
    this.setLauncher("opening");
    const reply = await this.ask("launcher-open");
    if (this.launcher !== "opening") return; // reset meanwhile
    if (reply !== "launcher open") {
      this.log(`controls: Spotlight didn't open (${reply ?? "no reply"})`);
      return this.setLauncher("idle");
    }
    const shortcut = this.startTalking();
    this.tapped = shortcut && shortcut.behavior !== "hold" ? shortcut.keycode : null;
    this.setLauncher(shortcut ? "listening" : "choosing"); // no dictation: type, then turn and push
  }

  doneTalking() {
    if (this.held !== null) this.letGo("done talking");
    else if (this.tapped !== null) {
      this.send(`tap ${this.tapped}`);
      this.log("controls: dictation toggled off");
    }
    this.tapped = null;
    this.setLauncher("choosing");
  }

  async openChoice() {
    this.setLauncher("idle");
    const reply = await this.ask("launcher-return");
    this.log(reply === "launcher opened" ? "controls: opened the launcher's pick" : `controls: Spotlight had closed; nothing opened (${reply ?? "no reply"})`);
  }

  /** Knob 1 turned while the launcher is open: move through its results (down for positive ticks). */
  async launcherTurn(ticks) {
    const n = Math.trunc(ticks || 0);
    if (!n || (this.launcher !== "listening" && this.launcher !== "choosing")) return;
    this.setLauncher(this.launcher); // still in use: restart the idle limit
    const reply = await this.ask(`launcher-move ${n}`);
    if (reply === "launcher gone") this.resetLauncher("Spotlight was closed");
  }

  /** Back to idle without pressing anything (a held dictation key is let go). */
  resetLauncher(why) {
    if (this.launcher === "idle") return;
    this.letGo(why);
    this.tapped = null; // toggle mode: Snaply is left as it is
    this.setLauncher("idle");
    this.log(`controls: launcher reset (${why})`);
  }

  setLauncher(step) {
    clearTimeout(this.launcherTimer);
    this.launcherTimer = step === "idle" ? null : setTimeout(() => this.resetLauncher("unused too long"), this.launcherLimitMs);
    if (step === this.launcher) return;
    this.launcher = step;
    this.onChange(step);
  }

  /** Send a launcher command; resolves with the helper's "launcher …" reply, or null if none comes. */
  ask(line) {
    return new Promise((resolve) => {
      const w = { resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(null);
      }, this.askMs);
      this.waiters.push(w);
      this.send(line);
    });
  }
}
