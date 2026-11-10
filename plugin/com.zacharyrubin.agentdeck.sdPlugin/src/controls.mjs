// Knob controls for the computer (macOS), the two rightmost knobs:
// - second from the right, turn: scroll like a mouse wheel where the pointer is;
//   push: start or stop dictation in Snaply.
// - rightmost, turn: move between fields in the app in front (Tab / Shift-Tab);
//   push: click whatever is highlighted (keys.swift `click`).
// So you can tab to a box, dictate into it, then tab to the button and click.
// While an agent's permission question is on the strip, pushes answer it instead.
// The leftmost knob picks a tab while the strip shows a tabbed app (main.mjs).
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
export const TABS_KNOB = 0; // dial column: leftmost (picks a tab when the strip lists tabs)
export const DICTATE_KNOB = 2; // dial column: second from the right (scroll / dictate)
export const COMPUTER_KNOB = 3; // dial column: rightmost (Tab / click)

/**
 * What a knob push (or strip tap, `touch`) in dial `column` does: "choose"
 * (answer the permission question on the strip), "open-tab" (switch to the
 * tab highlighted on the strip), "dictate", "click", or "jump" (to what the
 * strip shows). `pending`: a permission question is showing; `tabs`: the strip
 * lists an app's tabs.
 */
export function knobPush(column, { pending = false, touch = false, tabs = false } = {}) {
  if (pending) return "choose";
  if (touch) return "jump";
  if (column === TABS_KNOB && tabs) return "open-tab";
  if (column === DICTATE_KNOB) return "dictate";
  if (column === COMPUTER_KNOB) return "click";
  return "jump";
}

/**
 * What turning the knob in dial `column` does: "fields" (Tab / Shift-Tab),
 * "scroll", "pick-tab" (move the highlight through the strip's tab list), or
 * "agents" (cycle the featured agent).
 */
export function knobTurn(column, { tabs = false } = {}) {
  if (column === COMPUTER_KNOB) return "fields";
  if (column === DICTATE_KNOB) return "scroll";
  if (column === TABS_KNOB && tabs) return "pick-tab";
  return "agents";
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
   * Snaply's settings JSON text.
   */
  constructor({
    log = () => {},
    isRunning = () => true,
    launch = () => {},
    readSettings = () => fs.readFileSync(SNAPLY_SETTINGS, "utf8"),
    holdLimitMs = 5 * 60_000,
  } = {}) {
    Object.assign(this, { log, isRunning, launch, readSettings, holdLimitMs });
    this.helper = null; // { write, stop } once keys.swift is running
    this.trusted = null; // whether macOS lets the helper post keys (null = not known yet)
    this.prompted = false;
    this.held = null; // keycode held down for push-to-talk dictation
    this.holdTimer = null;
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
    this.helper?.stop(); // the helper lets go of anything still held
  }

  onLine(line) {
    const s = line.trim();
    if (s.startsWith("click ")) return this.log(`controls: ${s}`);
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
    if (!this.isRunning()) {
      this.log("controls: Snaply isn't running; opening it");
      return this.launch();
    }
    let shortcut = null;
    try {
      shortcut = snaplyShortcut(this.readSettings());
    } catch {}
    if (!shortcut) return this.log("controls: couldn't read Snaply's dictation shortcut (a single key is expected)");
    if (shortcut.behavior === "hold") {
      this.held = shortcut.keycode;
      this.send(`down ${shortcut.keycode}`);
      this.holdTimer = setTimeout(() => this.letGo(`held ${Math.round(this.holdLimitMs / 60_000)} minutes`), this.holdLimitMs);
      this.log(`controls: dictation started (holding ${shortcut.label})`);
    } else {
      this.send(`tap ${shortcut.keycode}`);
      this.log(`controls: dictation toggled (tapped ${shortcut.label})`);
    }
  }

  /** Release the push-to-talk key. */
  letGo(why) {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.held === null) return;
    this.send(`up ${this.held}`);
    this.held = null;
    this.log(`controls: dictation stopped (${why})`);
  }
}
