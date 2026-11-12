// Keystroke helper for Agent Deck (macOS). Compiled on first use by controls.mjs.
//
// Reads one command per line on stdin and posts the keystrokes to whatever app
// is in front:
//   tab <n>          Tab n times (Shift-Tab when n is negative)
//   scroll <n>       scroll wheel n notches where the pointer is (down when n > 0)
//   click            click whatever is highlighted (see click() below);
//                    prints "click press <role> <title>" or "click mouse <x>,<y>"
//   tap <keycode>    press and release a key (modifier keys work too)
//   down <keycode>   hold a key down
//   up <keycode>     release a held key
//   prompt           ask macOS for the Accessibility permission if it's missing
//   launcher-open    Cmd-Space, then wait for the app launcher (Spotlight) to
//                    take focus; prints "launcher open" or "launcher failed"
//   launcher-move <n>  Down arrow n times (Up when n < 0) while the launcher has
//                    focus; prints "launcher moved", or "launcher gone" if it closed
//   launcher-return  Return while the launcher has focus; prints "launcher opened",
//                    or "launcher gone" (and presses nothing) if it closed
// Prints "trusted" or "untrusted" at start: whether macOS lets it post keys
// (the permission belongs to the app that launched it, i.e. OpenDeck).
// Releases any key it's holding when stdin closes.

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_DFL)

let source = CGEventSource(stateID: .privateState)
let tabKey: CGKeyCode = 48

/// Modifier keys: the generic flag plus the left/right-specific bit real keyboards send.
let modifiers: [CGKeyCode: UInt64] = [
  59: CGEventFlags.maskControl.rawValue | 0x0001, 62: CGEventFlags.maskControl.rawValue | 0x2000,
  56: CGEventFlags.maskShift.rawValue | 0x0002, 60: CGEventFlags.maskShift.rawValue | 0x0004,
  55: CGEventFlags.maskCommand.rawValue | 0x0008, 54: CGEventFlags.maskCommand.rawValue | 0x0010,
  58: CGEventFlags.maskAlternate.rawValue | 0x0020, 61: CGEventFlags.maskAlternate.rawValue | 0x0040,
  63: CGEventFlags.maskSecondaryFn.rawValue,
]
var held = Set<CGKeyCode>()

/// Flags for the modifiers we're holding (0x100 is set on every real key event).
func heldFlags() -> CGEventFlags {
  CGEventFlags(rawValue: held.reduce(UInt64(0x100)) { $0 | (modifiers[$1] ?? 0) })
}

func post(_ key: CGKeyCode, down: Bool, flags: CGEventFlags) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return }
  event.flags = flags
  event.post(tap: .cghidEventTap)
}

func press(_ key: CGKeyCode) {
  guard !held.contains(key) else { return }
  held.insert(key)
  post(key, down: true, flags: heldFlags())
}

func release(_ key: CGKeyCode) {
  guard held.contains(key) else { return }
  held.remove(key)
  post(key, down: false, flags: heldFlags())
}

// Killed rather than closed: still let go of held keys, or one would stay stuck down.
signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
terminate.setEventHandler {
  for k in held { post(k, down: false, flags: CGEventFlags(rawValue: 0x100)) }
  exit(0)
}
terminate.resume()

/// A string attribute of an accessibility element, or "".
func text(_ el: AXUIElement, _ attr: String) -> String {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let s = v as? String else { return "" }
  return s
}

/// The element with keyboard focus in the app in front, if any.
func focusedElement() -> AXUIElement? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.5) // a hung app mustn't hang the knob
  var app: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &app) == .success,
        let app, CFGetTypeID(app) == AXUIElementGetTypeID() else { return nil }
  let appEl = app as! AXUIElement
  // Electron and Chromium apps only build their accessibility tree when asked.
  AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  var el: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &el) == .success,
        let el, CFGetTypeID(el) == AXUIElementGetTypeID() else { return nil }
  return (el as! AXUIElement)
}

/// A plain left click where the pointer is, without any modifier we're holding.
func mouseClick() -> CGPoint {
  let at = CGEvent(source: nil)?.location ?? .zero
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left) else { continue }
    e.flags = []
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
    usleep(15_000)
  }
  return at
}

/// Scroll like a mouse wheel at the pointer: n notches, down for positive n,
/// without any modifier we're holding (Control + scroll would zoom the screen).
func scroll(_ n: Int) {
  let lines = Int32(max(-20, min(20, n)) * -linesPerNotch)
  guard lines != 0, let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0) else { return }
  e.flags = []
  e.post(tap: .cghidEventTap)
}
let linesPerNotch = 2

/// Click whatever is highlighted: the focused control (button, link, checkbox,
/// menu…) is pressed the way VoiceOver presses it, so the pointer doesn't move.
/// When nothing pressable has focus (a text box, a page), it's an ordinary
/// mouse click where the pointer is.
func click() -> String {
  if let el = focusedElement() {
    var names: CFArray?
    if AXUIElementCopyActionNames(el, &names) == .success,
       let actions = names as? [String], actions.contains(kAXPressAction as String),
       AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
      let title = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
        .lazy.map { text(el, $0 as String) }.first { !$0.isEmpty } ?? ""
      return "click press \(text(el, kAXRoleAttribute as String)) \(title.prefix(60))"
    }
  }
  let at = mouseClick()
  return "click mouse \(Int(at.x)),\(Int(at.y))"
}

/// The app with keyboard focus (Spotlight's panel counts while it's open).
func focusedPid() -> pid_t? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.5)
  var app: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &app) == .success,
        let app, CFGetTypeID(app) == AXUIElementGetTypeID() else { return nil }
  var pid: pid_t = 0
  return AXUIElementGetPid(app as! AXUIElement, &pid) == .success ? pid : nil
}

/// What Cmd-Space opens: Spotlight, or a launcher that took over its shortcut.
let launchers: Set<String> = ["com.apple.Spotlight", "com.raycast.macos", "com.runningwithcrayons.Alfred", "at.obdev.LaunchBar"]
func isLauncher(_ pid: pid_t?) -> Bool {
  guard let pid, let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return false }
  return launchers.contains(id)
}
/// The launcher's process while it's open (launcher-open found it).
var launcherPid: pid_t?
func launcherOpen() -> Bool { launcherPid != nil && focusedPid() == launcherPid }

/// Tap a key `count` times with `flags` (and nothing we're holding).
func taps(_ key: CGKeyCode, _ count: Int, _ flags: CGEventFlags) {
  for _ in 0..<min(count, 20) {
    post(key, down: true, flags: flags)
    post(key, down: false, flags: flags)
    usleep(4_000)
  }
}
// Arrow keys carry the keypad and Fn flags on real keyboards.
let arrowFlags = CGEventFlags(rawValue: 0x100 | CGEventFlags.maskNumericPad.rawValue | CGEventFlags.maskSecondaryFn.rawValue)

func openLauncher() -> String {
  let before = focusedPid()
  if isLauncher(before) { // already open: Cmd-Space again would close it
    launcherPid = before
    return "launcher open"
  }
  taps(49, 1, CGEventFlags(rawValue: 0x100 | CGEventFlags.maskCommand.rawValue | 0x0008)) // Cmd-Space
  for _ in 0..<25 { // up to ~0.75 s for it to appear
    usleep(30_000)
    let now = focusedPid()
    if now != before, isLauncher(now) {
      launcherPid = now
      return "launcher open"
    }
  }
  launcherPid = nil
  return "launcher failed"
}

print(AXIsProcessTrusted() ? "trusted" : "untrusted")

while let line = readLine() {
  let parts = line.split(separator: " ")
  guard let command = parts.first else { continue }
  let arg = parts.count > 1 ? Int(parts[1]) : nil
  switch command {
  case "tab":
    let n = arg ?? 1
    let flags = CGEventFlags(rawValue: 0x100 | (n < 0 ? CGEventFlags.maskShift.rawValue : 0))
    for _ in 0..<min(abs(n), 20) {
      post(tabKey, down: true, flags: flags)
      post(tabKey, down: false, flags: flags)
      usleep(4_000)
    }
  case "click":
    print(click())
  case "scroll":
    scroll(arg ?? 0)
  case "tap":
    if let k = arg.map({ CGKeyCode($0) }) {
      press(k)
      usleep(40_000)
      release(k)
    }
  case "down":
    if let k = arg.map({ CGKeyCode($0) }) { press(k) }
  case "up":
    if let k = arg.map({ CGKeyCode($0) }) { release(k) }
  case "launcher-open":
    print(openLauncher())
  case "launcher-move":
    let n = arg ?? 1
    guard launcherOpen() else { print("launcher gone"); break }
    taps(n < 0 ? 126 : 125, abs(n), arrowFlags) // Up / Down
    print("launcher moved")
  case "launcher-return":
    guard launcherOpen() else { print("launcher gone"); break }
    taps(36, 1, CGEventFlags(rawValue: 0x100)) // Return
    launcherPid = nil
    print("launcher opened")
  case "prompt":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    print(AXIsProcessTrustedWithOptions(options) ? "trusted" : "untrusted")
  default:
    break
  }
}
for k in held { release(k) }
