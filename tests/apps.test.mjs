import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppWatcher, appsForDeck, hostApp, openArgs, parseAppList, parseNotification, rankApps, windowedPids,
} from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/apps.mjs";
import { appKeySvg, textWidth } from "../plugin/com.zacharyrubin.agentdeck.sdPlugin/src/render.mjs";

// Trimmed real output of `lsappinfo list visibleProcessList` (macOS 26).
const LIST = String.raw` 1) "loginwindow" ASN:0x0-0x3003:
    bundleID="com.apple.loginwindow"
    bundle path="/System/Library/CoreServices/loginwindow.app"
    pid = 408 type="UIElement" flavor=3 Version="3085.6.3" fileType="APPL" creator="lgnw" Arch=ARM64
 2) "universalaccessd" ASN:0x0-0xa00a:
    bundleID=[ NULL ]
    bundle path="/usr/sbin/universalaccessd"
    pid = 616 !signalled type="BackgroundOnly" flavor=3 Version=[ NULL ]  fileType="????" creator="????" Arch=ARM64
 5) "Google Chrome" ASN:0x0-0x10010:
    bundleID="com.google.Chrome"
    bundle path="/Applications/Google Chrome.app"
    executable path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    pid = 646 type="Foreground" flavor=3 Version="8078.80" fileType="APPL" creator="rimZ" Arch=ARM64
    coalition: 704  { 706 724 842 }
    parentASN="loginwindow" ASN:0x0-0x3003:
 7) "Terminal" ASN:0x0-0x17017:
    bundleID="com.apple.Terminal"
    bundle path="/System/Applications/Utilities/Terminal.app"
    pid = 655 type="Foreground" flavor=3 Version="470.2" fileType="APPL" creator="????" Arch=ARM64
 9) "Finder" ASN:0x0-0x26026:
    bundleID="com.apple.finder"
    bundle path="/System/Library/CoreServices/Finder.app"
    pid = 683 type="Foreground" flavor=3 Version="26.6" fileType="APPL" Arch=ARM64
10) "{LRM}WhatsApp" ASN:0x0-0xdfcdfc:
    bundleID="net.whatsapp.WhatsApp"
    bundle path="/Applications/WhatsApp.app"
    pid = 900 type="Foreground" flavor=3 Version="25.1" fileType="APPL" Arch=ARM64
11) "OpenDeck" ASN:0x0-0xf60f60:
    bundleID="opendeck"
    bundle path="/Applications/OpenDeck.app"
    pid = 910 type="Foreground" flavor=3 Version="2.14.2" fileType="APPL" Arch=ARM64
12) "QuickTime Player" ASN:0x0-0xd0dd0d:
    bundleID="com.apple.QuickTimePlayerX"
    bundle path="/System/Applications/QuickTime Player.app"
    pid = 920 type="Foreground" flavor=3 Version="10.5" fileType="APPL" Arch=ARM64
ASN:0x0-0xdfcdfc-"{LRM}WhatsApp": ASN:0x0-0x10010-"Google_Chrome": ASN:0x0-0x26026-"Finder": ASN:0x0-0xf60f60-"OpenDeck": ASN:0x0-0x17017-"Terminal":
`.replaceAll("{LRM}", "‎"); // WhatsApp really starts its name with a left-to-right mark

test("parseAppList keeps only Foreground apps and reads the visible order", () => {
  const { apps, visible } = parseAppList(LIST);
  assert.deepEqual(apps.map((a) => a.name), ["Google Chrome", "Terminal", "Finder", "WhatsApp", "OpenDeck", "QuickTime Player"]);
  assert.deepEqual(apps[0], {
    key: "com.google.Chrome", name: "Google Chrome", bundleId: "com.google.Chrome",
    bundlePath: "/Applications/Google Chrome.app", pid: 646, asn: "0x0-0x10010",
  });
  assert.equal(apps[3].name, "WhatsApp", "invisible bidi mark stripped");
  assert.deepEqual(visible, ["0x0-0xdfcdfc", "0x0-0x10010", "0x0-0x26026", "0x0-0xf60f60", "0x0-0x17017"]);
});

test("parseAppList de-duplicates two copies of one app", () => {
  const twice = LIST.replace(` 9) "Finder"`, ` 8) "Google Chrome" ASN:0x0-0x99099: \n    bundleID="com.google.Chrome"\n    pid = 1 type="Foreground"\n 9) "Finder"`);
  assert.equal(parseAppList(twice).apps.filter((a) => a.key === "com.google.Chrome").length, 1);
});

test("parseNotification reads event, app type and ASN", () => {
  const front = `Notification: kLSNotifyBecameFrontmost time=+1.65836s  dataRef={ "ApplicationType"="Foreground", "CFBundleIdentifier"="com.google.Chrome", "LSASN"=ASN:0x0-0x10010:, "LSFrontApplicationSeed"=1230, "LSMenuBarOwnerASN"=ASN:0x0-0x10010:, "LSOtherASN"=ASN:0x0-0x124e24d: } affectedASN="Google Chrome" ASN:0x0-0x10010:  context=0`;
  assert.deepEqual(parseNotification(front), { event: "BecameFrontmost", appType: "Foreground", asn: "0x0-0x10010" });
  const daemon = `Notification: kLSNotifyApplicationDeath time=+2.33884s  dataRef={ "ApplicationType"="BackgroundOnly", "CFBundleExecutablePath"="/usr/bin/osascript", "LSASN"=ASN:0x0-0x1244243:, "pid"=59020 }`;
  assert.deepEqual(parseNotification(daemon), { event: "ApplicationDeath", appType: "BackgroundOnly", asn: "0x0-0x1244243" });
  assert.equal(parseNotification("random line"), null);
});

test("rankApps: seen-in-front apps by time, then visible order, then hidden by name", () => {
  const { apps, visible } = parseAppList(LIST);
  const names = (list) => list.map((a) => a.name);
  assert.deepEqual(names(rankApps(apps, { visible })), ["WhatsApp", "Google Chrome", "Finder", "OpenDeck", "Terminal", "QuickTime Player"]);
  const lastFront = new Map([["0x0-0x17017", 2000], ["0x0-0xd0dd0d", 1000]]); // Terminal, then QuickTime (now hidden)
  assert.deepEqual(names(rankApps(apps, { visible, lastFront })), ["Terminal", "QuickTime Player", "WhatsApp", "Google Chrome", "Finder", "OpenDeck"]);
});

test("appsForDeck drops Finder, OpenDeck and apps an agent runs in", () => {
  const { apps } = parseAppList(LIST);
  const names = (agents) => appsForDeck(apps, agents).map((a) => a.name);
  assert.deepEqual(names([]), ["Google Chrome", "Terminal", "WhatsApp", "QuickTime Player"]);
  assert.deepEqual(names([{ bundleId: "com.apple.Terminal" }]), ["Google Chrome", "WhatsApp", "QuickTime Player"]);
  assert.deepEqual(names([{ termProgram: "Apple_Terminal" }]), ["Google Chrome", "WhatsApp", "QuickTime Player"], "matched by TERM_PROGRAM too");
});

test("openArgs targets the exact running bundle", () => {
  assert.deepEqual(openArgs({ name: "X", bundleId: "a.b", bundlePath: "/Applications/X.app" }), ["-a", "/Applications/X.app"]);
  assert.deepEqual(openArgs({ name: "X", bundleId: "a.b" }), ["-b", "a.b"]);
  assert.deepEqual(openArgs({ name: "X" }), ["-a", "X"]);
});

test("AppWatcher re-ranks on front-app events and ignores background processes", async () => {
  let t = 0;
  const changes = [];
  const w = new AppWatcher({ now: () => ++t, onChange: (apps) => changes.push(apps.map((a) => a.name)) });
  let refreshes = 0;
  w.scheduleRefresh = () => refreshes++;
  w.raw = parseAppList(LIST);
  w.publish();
  assert.equal(changes.at(-1)[0], "WhatsApp");
  w.onNotification(`Notification: kLSNotifyBecameFrontmost time=+1s  dataRef={ "ApplicationType"="Foreground", "LSASN"=ASN:0x0-0xd0dd0d:, "LSOtherASN"=ASN:0x0-0x10010: }`);
  assert.equal(changes.at(-1)[0], "QuickTime Player");
  assert.equal(refreshes, 1);
  const n = changes.length;
  w.onNotification(`Notification: kLSNotifyApplicationDeath time=+2s  dataRef={ "ApplicationType"="BackgroundOnly", "LSASN"=ASN:0x0-0x1244243: }`);
  w.onNotification(`Notification: kLSNotifyApplicationLaunch time=+2s  dataRef={ "ApplicationType"="BackgroundOnly", "LSASN"=ASN:0x0-0x1244244: }`);
  assert.equal(refreshes, 1, "our own lsappinfo/osascript runs don't trigger a refresh");
  w.onNotification(`Notification: kLSNotifyApplicationLaunch time=+3s  dataRef={ "ApplicationType"="Foreground", "LSASN"=ASN:0x0-0x1243242: }`);
  assert.equal(refreshes, 2);
  w.publish();
  assert.equal(changes.length, n, "no change event when nothing changed");
});

test("hostApp finds the app an agent runs in: its bundle id, else its terminal", () => {
  const list = [
    { key: "claude", name: "Claude", bundleId: "com.anthropic.claudefordesktop" },
    { key: "term", name: "Terminal", bundleId: "com.apple.Terminal" },
  ];
  assert.equal(hostApp(list, { bundleId: "com.anthropic.claudefordesktop" })?.key, "claude");
  assert.equal(hostApp(list, { termProgram: "Apple_Terminal" })?.key, "term");
  assert.equal(hostApp(list, { bundleId: "com.example.gone", termProgram: "Apple_Terminal" }), null, "the bundle id wins");
  assert.equal(hostApp(list, { termProgram: "unknown" }), null);
  assert.equal(hostApp(list, null), null);
});

test("app keys show the icon and name, with a letter tile when there is no icon", () => {
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const withIcon = appKeySvg({ app: { name: "Notes", icon } });
  assert.match(withIcon, /<image [^>]*xlink:href="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(withIcon, />Notes<\/text>/);
  const noIcon = appKeySvg({ app: { name: "<Odd & App>", icon: null } });
  assert.doesNotMatch(noIcon, /<image/);
  assert.match(noIcon, />&lt;<\/text>/, "first letter tile, escaped");
  assert.match(noIcon, /&lt;Odd &amp; App&gt;/);
  // Long names wrap to two lines that fit the key.
  const long = appKeySvg({ app: { name: "Microsoft Remote Desktop Beta", icon } });
  const lines = [...long.matchAll(/font-size="16"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.equal(lines.length, 2);
  lines.forEach((l) => assert.ok(textWidth(l, 16, true) <= 130, `too wide: ${l}`));
});

test("windowedPids counts real windows (shown, hidden, minimized) and skips app furniture", () => {
  // Rows as the window helper prints them: [pid, width, height, onscreen].
  const rows = [
    [646, 1705, 1390, 1], // Chrome: a window on screen
    [655, 1266, 1294, 0], // Terminal: window minimized / hidden / on another Space
    [683, 3840, 30, 0], [683, 1710, 39, 0], // Finder: menu-bar strips only
    [700, 500, 500, 0], // Xcode: just the offscreen 500x500 helper
    [701, 64, 64, 0], [701, 1, 1, 0], // status item + 1x1 helpers
    [702, 500, 500, 1], // a real 500x500 window on screen still counts
  ];
  assert.deepEqual([...windowedPids(rows)].sort(), [646, 655, 702]);
  assert.equal(windowedPids([]).size, 0);
});

test("appsForDeck drops apps with no window open; unknown window state counts as open", () => {
  const apps = [
    { key: "a", name: "A", bundleId: "a", hasWindows: true },
    { key: "b", name: "B", bundleId: "b", hasWindows: false },
    { key: "c", name: "C", bundleId: "c", hasWindows: null },
  ];
  assert.deepEqual(appsForDeck(apps).map((a) => a.key), ["a", "c"]);
});

test("AppWatcher marks windowless apps and only fires on real changes", () => {
  const changes = [];
  const w = new AppWatcher({ onChange: (apps) => changes.push(apps) });
  w.raw = parseAppList(LIST);
  w.publish();
  assert.equal(changes.at(-1).find((a) => a.name === "Google Chrome").hasWindows, null, "unknown before the helper reports");
  w.onWindows(JSON.stringify([[646, 1705, 1390, 1], [655, 900, 600, 0], [910, 500, 500, 0]]));
  const now = changes.at(-1);
  assert.equal(now.find((a) => a.name === "Google Chrome").hasWindows, true);
  assert.equal(now.find((a) => a.name === "Terminal").hasWindows, true, "minimized/hidden window still counts");
  assert.equal(now.find((a) => a.name === "OpenDeck").hasWindows, false, "only the 500x500 helper");
  assert.equal(now.find((a) => a.name === "WhatsApp").hasWindows, false);
  const n = changes.length;
  w.onWindows(JSON.stringify([[655, 900, 600, 0], [646, 1000, 800, 1]])); // resized, same apps with windows
  w.onWindows("not json");
  assert.equal(changes.length, n, "same set of apps with windows: no change event");
  w.onWindows(JSON.stringify([[646, 1705, 1390, 1]])); // Terminal's last window closed
  assert.equal(changes.at(-1).find((a) => a.name === "Terminal").hasWindows, false);
});

test("AppWatcher holds the first list back until window state is known", () => {
  const changes = [];
  const w = new AppWatcher({ onChange: (apps) => changes.push(apps) });
  w.windowsSettled = false; // as start() does while the helper compiles/starts
  w.raw = parseAppList(LIST);
  w.publish();
  assert.equal(changes.length, 0);
  w.windowed = new Set([646]);
  w.windowsSettled = true;
  w.publish();
  assert.equal(changes.length, 1);
  assert.deepEqual(appsForDeck(changes[0]).map((a) => a.name), ["Google Chrome"]);
});
