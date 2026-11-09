#!/usr/bin/env node
// Fill an OpenDeck profile with Agent Deck actions: every empty key gets an
// "Agent slot", every empty knob an "Agent status strip". Saves dragging 14
// actions by hand.
//
// OpenDeck rewrites profiles when it quits, so this quits OpenDeck first,
// edits the profile, then relaunches it (macOS). A timestamped backup of the
// profile is written next to it.
//
// Usage: node scripts/fill-profile.mjs [--device ID] [--profile NAME] [--force]
//   --force   also replace keys/knobs that hold other actions

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = "com.zacharyrubin.agentdeck.sdPlugin";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/opendeck")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opendeck");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const force = argv.includes("--force");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const running = () => {
  try {
    execFileSync("pgrep", ["-x", "opendeck"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// ---- find the device and profile
const profilesDir = path.join(CONFIG, "profiles");
const devices = fs.existsSync(profilesDir)
  ? fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
  : [];
const device = opt("--device") || (devices.length === 1 ? devices[0] : null);
if (!device) die(`Pick a device with --device. Found: ${devices.join(", ") || "none (start OpenDeck with the deck plugged in first)"}`);
const selected = JSON.parse(fs.readFileSync(path.join(profilesDir, `${device}.json`), "utf8")).selected_profile;
const profileName = opt("--profile") || selected || "Default";
const profileFile = path.join(profilesDir, device, `${profileName}.json`);

// ---- build action objects the way OpenDeck stores them
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "plugin", PLUGIN, "manifest.json"), "utf8"));
const icon = (p) => `plugins/${PLUGIN}/${p}${fs.existsSync(path.join(REPO, "plugin", PLUGIN, p + ".svg")) ? ".svg" : ""}`;
const state = (s) => ({
  image: icon(s.Image),
  image_override: null,
  image_scale: 100,
  background_colour: "#000000",
  name: "",
  text: "",
  text_override: null,
  show: s.ShowTitle ?? true,
  colour: "#FFFFFF",
  stroke_colour: "#000000",
  alignment: "middle",
  family: "Liberation Sans",
  style: "Regular",
  size: 16,
  stroke_size: 3,
  underline: false,
});
function action(uuid) {
  const a = manifest.Actions.find((x) => x.UUID === uuid);
  const enc = a.Encoder;
  return {
    name: a.Name,
    uuid: a.UUID,
    plugin: PLUGIN,
    tooltip: a.Tooltip || "",
    icon: icon(a.Icon),
    disable_automatic_states: false,
    visible_in_action_list: true,
    supported_in_multi_actions: a.SupportedInMultiActions ?? true,
    property_inspector: "",
    controllers: a.Controllers,
    encoder: enc
      ? {
          icon: icon(enc.Icon),
          stack_color: "",
          trigger_description: {
            long_touch: enc.TriggerDescription?.LongTouch || "",
            push: enc.TriggerDescription?.Push || "",
            rotate: enc.TriggerDescription?.Rotate || "",
            touch: enc.TriggerDescription?.Touch || "",
          },
          background: "",
          layout: enc.layout,
        }
      : null,
    states: a.States.map(state),
  };
}
const instance = (uuid, controller, position) => {
  const act = action(uuid);
  return { action: act, context: `${controller}.${position}.0`, states: act.states, current_state: 0, settings: {}, children: null };
};

// ---- quit OpenDeck, edit, relaunch
const wasRunning = running();
if (wasRunning) {
  if (process.platform !== "darwin") die("Quit OpenDeck first (it rewrites profiles on exit).");
  execFileSync("osascript", ["-e", 'quit app "OpenDeck"']);
  for (let i = 0; i < 40 && running(); i++) execFileSync("sleep", ["0.25"]);
  if (running()) die("OpenDeck did not quit; close it and rerun.");
}

const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
const backup = `${profileFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(profileFile, backup);

let filled = 0;
const fill = (list, uuid, controller) =>
  list.forEach((slot, i) => {
    if (!slot || force) {
      list[i] = instance(uuid, controller, i);
      filled++;
    }
  });
fill(profile.keys, "com.zacharyrubin.agentdeck.slot", "Keypad");
fill(profile.sliders, "com.zacharyrubin.agentdeck.strip", "Encoder");
fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2));

console.log(`${device} / ${profileName}: filled ${filled} of ${profile.keys.length + profile.sliders.length} positions`);
console.log(`backup: ${backup}`);

if (wasRunning) {
  execFileSync("open", ["-a", "OpenDeck"]);
  console.log("relaunched OpenDeck");
}
