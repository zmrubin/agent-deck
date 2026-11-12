// Running GUI apps (macOS), shown on keys no agent needs.
//
// Discovery uses `lsappinfo`, which ships with macOS and needs no permissions:
//   lsappinfo list visibleProcessList   one snapshot: every app, then front-to-back order
//   lsappinfo listen +launch +death +becameFrontmost … forever
//                                       a push stream of launch / quit / front-app
//                                       events, so the list stays current without polling
// Only "Foreground" apps count (the ones with a Dock icon), not menu-bar
// extras or background daemons.
//
// An app whose windows are all closed counts as closed too (macOS keeps many
// apps running with no windows). Closing a window raises no app event, so a
// small Swift helper (windows.swift, compiled on first use) reads the window
// list once a second and prints only when it changes. Hidden, minimized and
// other-Space windows still count as open.
//
// Icons come from AppKit (NSWorkspace) through one JXA call per batch of newly
// seen apps, and are cached.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, supervise, swiftHelper } from "./helpers.mjs";

/** Apps that never get a key. */
export const EXCLUDED_BUNDLES = new Set([
  "com.apple.finder",
  "opendeck", // OpenDeck's own bundle id
]);
const EXCLUDED_NAMES = new Set(["OpenDeck"]);

/** TERM_PROGRAM → app name, for agents whose hook didn't report a bundle id. */
export const TERM_APPS = {
  "iTerm.app": "iTerm",
  Apple_Terminal: "Terminal",
  vscode: "Visual Studio Code",
  WarpTerminal: "Warp",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
};

const ASN = String.raw`0x[0-9a-f]+-0x[0-9a-f]+`;
// Bidi marks and zero-width characters some apps put in their names (e.g. "‎WhatsApp").
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Parse `lsappinfo list` (optionally followed by `visibleProcessList`).
 * Returns { apps, visible }: Foreground apps in list order, and the ASNs of
 * visible (not hidden) apps front to back.
 */
export function parseAppList(text) {
  const apps = [];
  const visible = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (/^\s*ASN:/.test(line)) {
      // visibleProcessList: ASN:0x0-0x10010-"Google_Chrome": ASN:0x0-0xe08e08-"Claude": …
      for (const m of line.matchAll(new RegExp(`ASN:(${ASN})-"`, "gi"))) visible.push(m[1]);
      cur = null;
      continue;
    }
    const head = line.match(new RegExp(`^\\s*\\d+\\) "(.*)" ASN:(${ASN}):`, "i"));
    if (head) {
      cur = { name: head[1].replace(INVISIBLE, "").trim(), asn: head[2] };
      apps.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^\s*bundleID="(.*)"/))) cur.bundleId = m[1];
    else if ((m = line.match(/^\s*bundle path="(.*)"/))) cur.bundlePath = m[1];
    if ((m = line.match(/\bpid = (\d+)/))) cur.pid = Number(m[1]);
    if ((m = line.match(/\btype="(\w+)"/))) cur.type = m[1];
  }
  const seen = new Set();
  const out = [];
  for (const a of apps) {
    if (a.type !== "Foreground") continue;
    const key = a.bundleId || a.bundlePath || a.name;
    if (seen.has(key)) continue; // second copy of the same app: one key is enough
    seen.add(key);
    out.push({ key, name: a.name || key, bundleId: a.bundleId, bundlePath: a.bundlePath, pid: a.pid, asn: a.asn });
  }
  return { apps: out, visible };
}

/** Parse one `lsappinfo listen` line → { event, appType, asn } or null. */
export function parseNotification(line) {
  const m = String(line).match(/^Notification: kLSNotify(\w+)/);
  if (!m) return null;
  return {
    event: m[1],
    appType: line.match(/"ApplicationType"="(\w+)"/)?.[1],
    asn: line.match(new RegExp(`"LSASN"=ASN:(${ASN}):`, "i"))?.[1],
  };
}

/**
 * PIDs with a real window open, from the window helper's rows
 * [[pid, width, height, onscreen], …]. Shown, hidden, minimized and
 * other-Space windows all count; what's skipped is the furniture every app
 * keeps: menu-bar strips and status items (thin or tiny) and a hidden
 * 500×500 helper window many apps hold offscreen.
 */
export function windowedPids(rows) {
  const pids = new Set();
  for (const [pid, w, h, on] of rows) {
    if (w <= 100 || h <= 50) continue;
    if (!on && w === 500 && h === 500) continue;
    pids.add(pid);
  }
  return pids;
}

/**
 * Most recently used first. Apps seen coming to the front since the plugin
 * started rank by when (lastFront: asn → time); the rest by the visible
 * front-to-back order; hidden apps never seen in front go last, by name.
 */
export function rankApps(apps, { visible = [], lastFront = new Map() } = {}) {
  const vis = new Map(visible.map((asn, i) => [asn, i]));
  const score = (a) => lastFront.get(a.asn) ?? (vis.has(a.asn) ? -1 - vis.get(a.asn) : -Infinity);
  return [...apps].sort((x, y) => score(y) - score(x) || x.name.localeCompare(y.name));
}

/**
 * The apps the deck may show: drops apps with no window open (hasWindows
 * false; unknown counts as open), Finder, OpenDeck and apps an agent runs in.
 */
export function appsForDeck(apps, agents = []) {
  const hostBundles = new Set(agents.map((a) => a.bundleId).filter(Boolean));
  const hostNames = new Set(agents.map((a) => TERM_APPS[a.termProgram]).filter(Boolean));
  return apps.filter(
    (a) => a.hasWindows !== false
      && !EXCLUDED_BUNDLES.has(a.bundleId) && !EXCLUDED_NAMES.has(a.name)
      && !hostBundles.has(a.bundleId) && !hostNames.has(a.name),
  );
}

/** The running app an agent runs in (by bundle id, else its terminal's name), or null: its key shows that app's icon. */
export function hostApp(apps, agent) {
  if (!agent) return null;
  if (agent.bundleId) return apps.find((a) => a.bundleId === agent.bundleId) || null;
  const name = TERM_APPS[agent.termProgram];
  return (name && apps.find((a) => a.name === name)) || null;
}

/** `open` arguments that bring an app to the front (unhiding it), like clicking it in the Dock. */
export function openArgs(app) {
  if (app.bundlePath) return ["-a", app.bundlePath];
  if (app.bundleId) return ["-b", app.bundleId];
  return ["-a", app.name];
}

// ---------------------------------------------------------------- I/O

const ICON_JXA = `
ObjC.import("AppKit");
function run(argv) {
  const size = Number(argv[0]);
  const out = {};
  for (const p of argv.slice(1)) {
    try {
      const img = $.NSWorkspace.sharedWorkspace.iconForFile(p);
      const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
      rep.size = $.NSMakeSize(size, size);
      $.NSGraphicsContext.saveGraphicsState;
      $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
      img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1.0);
      $.NSGraphicsContext.restoreGraphicsState;
      out[p] = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;
    } catch (e) {}
  }
  return JSON.stringify(out);
}`;

/** PNG data URLs for app bundles, keyed by bundle path (missing = no icon). */
export async function fetchIcons(paths, size = 96) {
  if (!paths.length) return {};
  const json = JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", ICON_JXA, String(size), ...paths]));
  return Object.fromEntries(Object.entries(json).map(([p, b64]) => [p, `data:image/png;base64,${b64}`]));
}

const HELPER_SRC = fileURLToPath(new URL("./windows.swift", import.meta.url));

/** Path to the compiled window helper (compiled on first use; see helpers.mjs). */
export const windowHelper = () => swiftHelper(HELPER_SRC);

/**
 * Keeps the list of running GUI apps current. `apps` is ranked most recently
 * used first; each app carries `icon` (PNG data URL, or null if unavailable)
 * and `hasWindows` (true/false; null while unknown). onChange() fires when
 * the list, names, icons, window state or recency order change.
 */
export class AppWatcher {
  constructor({ onChange = () => {}, log = () => {}, iconSize = 96, windowPollSec = 1, now = () => Date.now() } = {}) {
    this.onChange = onChange;
    this.log = log;
    this.iconSize = iconSize;
    this.windowPollSec = windowPollSec;
    this.now = now;
    this.apps = [];
    this.byKey = new Map();
    this.raw = { apps: [], visible: [] };
    this.lastFront = new Map(); // asn -> time it last came to the front
    this.icons = new Map(); // bundlePath -> data URL | null
    this.windowed = null; // Set of pids with a window open; null = unknown (no helper)
    this.windowsSettled = true; // false while start() waits for the first window report
    this.signature = "";
    this.stops = []; // the supervised children ({ stop })
    this.stopped = true;
    this.refreshTimer = null;
    this.refreshing = null;
    this.again = false;
  }

  start() {
    if (process.platform !== "darwin") return this.log("apps: only implemented on macOS");
    this.stopped = false;
    // Hold back the first app list until window state is known (or a few seconds pass),
    // so windowless apps don't show for a moment and then vanish.
    this.windowsSettled = false;
    const settle = () => {
      if (this.windowsSettled) return;
      this.windowsSettled = true;
      this.publish();
    };
    this.settleTimer = setTimeout(settle, 8000);
    this.stops.push(supervise({
      name: "apps: listener",
      cmd: "lsappinfo",
      args: ["listen", "+launch", "+death", "+becameFrontmost", "+appTypeChanged", "+appNameChanged", "forever"],
      onLine: (l) => this.onNotification(l),
      onRestart: () => this.refresh(), // catch up on anything missed meanwhile
      log: this.log,
      now: this.now,
    }));
    this.refresh();
    windowHelper()
      .then((bin) => {
        if (this.stopped) return;
        this.stops.push(supervise({
          name: "apps: window helper",
          cmd: bin,
          args: [String(this.windowPollSec)],
          onLine: (l) => {
            this.onWindows(l);
            settle();
          },
          log: this.log,
          now: this.now,
        }));
      })
      .catch((err) => {
        this.log("apps: no window helper, so apps with no windows stay on the deck:", err.message);
        settle();
      });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.settleTimer);
    for (const s of this.stops) s.stop();
    this.stops = [];
  }

  get(key) {
    return this.byKey.get(key);
  }

  /** Handle one `lsappinfo listen` line. */
  onNotification(line) {
    const n = parseNotification(line);
    if (!n) return;
    if (n.event === "BecameFrontmost") {
      if (n.asn) this.lastFront.set(n.asn, this.now());
      this.publish(); // re-rank right away; the refresh below catches new apps/names
      this.scheduleRefresh();
    } else if (n.appType === "Foreground" || /Type/.test(n.event)) {
      // Our own lsappinfo/osascript runs come and go as BackgroundOnly: ignored.
      if (n.event === "ApplicationDeath" && n.asn) this.lastFront.delete(n.asn);
      this.scheduleRefresh();
    }
  }

  /** Handle one window-helper line: JSON rows [[pid, width, height, onscreen], …]. */
  onWindows(line) {
    let rows;
    try {
      rows = JSON.parse(line);
    } catch {
      return;
    }
    const pids = windowedPids(rows);
    if (this.windowed && pids.size === this.windowed.size && [...pids].every((p) => this.windowed.has(p))) return;
    this.windowed = pids;
    this.publish();
  }

  scheduleRefresh(ms = 150) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), ms);
  }

  /** Re-read the app list (and fetch icons for new apps). Concurrent calls coalesce. */
  async refresh() {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        this.raw = parseAppList(await run("lsappinfo", ["list", "visibleProcessList"]));
        await this.loadIcons(this.raw.apps);
        this.publish();
      } catch (err) {
        this.log("apps: refresh failed:", err.message);
      }
    })();
    await this.refreshing;
    this.refreshing = null;
    if (this.again) {
      this.again = false;
      return this.refresh();
    }
  }

  async loadIcons(apps) {
    const missing = [...new Set(apps.map((a) => a.bundlePath).filter((p) => p && !this.icons.has(p)))];
    if (!missing.length) return;
    let got = {};
    try {
      got = await fetchIcons(missing, this.iconSize);
    } catch (err) {
      this.log("apps: icon fetch failed:", err.message);
    }
    for (const p of missing) this.icons.set(p, got[p] ?? null);
  }

  publish() {
    if (!this.windowsSettled) return;
    const ranked = rankApps(this.raw.apps, { visible: this.raw.visible, lastFront: this.lastFront });
    this.apps = ranked.map((a) => ({
      ...a,
      icon: this.icons.get(a.bundlePath) ?? null,
      hasWindows: this.windowed ? this.windowed.has(a.pid) : null,
    }));
    this.byKey = new Map(this.apps.map((a) => [a.key, a]));
    const sig = JSON.stringify(this.apps.map((a) => [a.key, a.name, !!a.icon, a.hasWindows]));
    if (sig === this.signature) return;
    this.signature = sig;
    this.onChange(this.apps);
  }
}

/** Bring an app to the front. */
export function activateApp(app, log = () => {}) {
  if (!app) return;
  if (process.platform !== "darwin") return log("activate: only implemented on macOS");
  execFile("open", openArgs(app), (err) => err && log("activate app failed:", err.message));
}
