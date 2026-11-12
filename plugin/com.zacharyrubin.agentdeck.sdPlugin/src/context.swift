// Context reader for Agent Deck (macOS). Compiled on first use by context.mjs.
//
//   context <pid>                        print a snapshot (below)
//   context <pid> press <win> <tab> [title]   switch to a tab (see "press" below)
//   context <pid> select <list> <row> [title] open a list row (see "select" below)
//
// Prints one JSON snapshot of what an app shows, read through Accessibility
// (the permission belongs to OpenDeck, which launches the plugin):
//   { "windows": [ { "title", "main", "tabs": [ { "title", "selected" } ] } ],
//     "lists":   [ { "index", "window", "role", "id", "desc", "rows": [ { "index", "desc", "value", "id", "selected", "texts": [] } ] } ] }
// A list's and a row's "index" are what `select` takes.
// Windows are the app's standard windows, main window first; tabs come from
// each window's tab bar (browsers, Terminal, Finder…). Lists are the tables,
// outlines and list-like groups in the first three windows, main window first
// (Messages' conversations, WhatsApp's chats, Notes' notes…; a chat Messages
// opened in its own window has no conversation list, so the main window may
// not hold it); context.mjs decides what's worth showing.
// Web page content is never walked: it's slow and the tab titles say enough.

import ApplicationServices
import Foundation

guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else {
  FileHandle.standardError.write("usage: context <pid>\n".data(using: .utf8)!)
  exit(2)
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.75) // a busy app mustn't stall the deck

func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}

/// A text-ish attribute as a string ("" when missing); numbers become their decimal text.
func str(_ e: AXUIElement, _ a: String) -> String {
  guard let v = attr(e, a) else { return "" }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func clip(_ s: String, _ n: Int = 300) -> String { s.count > n ? String(s.prefix(n)) : s }

/// Never walked: page content and document text are huge and slow, and say little here.
let skipped: Set<String> = ["AXWebArea", "AXTextArea", "AXScrollBar", "AXMenuBar"]

/// Breadth-first search below `root` for elements matching `match`, not descending
/// into `skipped` roles or into matches (except groups). Stops at `limit` matches or `maxDepth`.
func find(_ root: AXUIElement, maxDepth: Int, limit: Int, budget start: Int, skip: Set<String> = skipped,
          _ match: (AXUIElement, String) -> Bool) -> [AXUIElement] {
  var budget = start // elements this search may visit
  var found: [AXUIElement] = []
  var level = [root]
  for _ in 0..<maxDepth {
    var next: [AXUIElement] = []
    for e in level {
      budget -= 1
      if budget <= 0 { return found }
      let role = str(e, "AXRole")
      if skip.contains(role) { continue }
      if match(e, role) {
        found.append(e)
        if found.count >= limit { return found }
        if role != "AXGroup" { continue } // a list-like group can hold the real list
      }
      next.append(contentsOf: children(e))
    }
    if next.isEmpty { break }
    level = next
  }
  return found
}

/// Up to six pieces of visible text inside a row.
func texts(_ row: AXUIElement) -> [String] {
  var out: [String] = []
  var level = [row]
  for _ in 0..<5 {
    var next: [AXUIElement] = []
    for e in level {
      let role = str(e, "AXRole")
      if role == "AXStaticText" || role == "AXTextField" {
        let t = str(e, "AXValue").isEmpty ? str(e, "AXDescription") : str(e, "AXValue")
        if !t.isEmpty { out.append(clip(t, 200)) }
        if out.count >= 6 { return out }
      }
      next.append(contentsOf: children(e))
    }
    level = next
  }
  return out
}

let windows = ((attr(app, "AXWindows") as? [AXUIElement]) ?? []).filter { str($0, "AXSubrole") == "AXStandardWindow" }
let mainWindow = attr(app, "AXMainWindow").map { $0 as! AXUIElement }
let mainIndex = windows.firstIndex { mainWindow != nil && CFEqual($0, mainWindow!) } ?? 0
/// Up to 12 windows, main window first: the order "windows" is printed in and `press` counts in.
var ordered = Array(windows.prefix(12))
if mainIndex > 0, mainIndex < ordered.count { ordered.insert(ordered.remove(at: mainIndex), at: 0) }

func tabTitle(_ t: AXUIElement) -> String { str(t, "AXTitle").isEmpty ? str(t, "AXDescription") : str(t, "AXTitle") }

/// A window's tab buttons, left to right (the indexes `press` takes).
func tabButtons(_ w: AXUIElement) -> [AXUIElement] {
  // Tab bars sit near the top of a window (Chrome's is 7 deep); lists never hold one.
  let notTabs = skipped.union(["AXTable", "AXOutline", "AXList", "AXSplitGroup"])
  guard let group = find(w, maxDepth: 9, limit: 1, budget: 400, skip: notTabs, { _, role in role == "AXTabGroup" }).first else { return [] }
  return Array(children(group).filter { str($0, "AXRole") == "AXRadioButton" && !tabTitle($0).isEmpty }.prefix(80))
}

// context <pid> press <window> <tab> [title]: switch to that tab and raise its
// window. `title` (as listed, possibly shortened) guards against the tabs having
// moved since they were read; if it doesn't match there, the first tab with
// that title anywhere is used. Prints {"pressed": bool, "title"}.
if CommandLine.arguments.count > 4, CommandLine.arguments[2] == "press" {
  let args = CommandLine.arguments
  let wi = Int(args[3]) ?? 0, ti = Int(args[4]) ?? 0, want = args.count > 5 ? args[5] : ""
  func exact(_ t: AXUIElement) -> Bool { tabTitle(t) == want }
  func close(_ t: AXUIElement) -> Bool { want.isEmpty || exact(t) || tabTitle(t).hasPrefix(want + " - ") }
  var target: (window: AXUIElement, tab: AXUIElement)?
  if wi < ordered.count {
    let tabs = tabButtons(ordered[wi])
    if ti < tabs.count, close(tabs[ti]) { target = (ordered[wi], tabs[ti]) }
  }
  for test in [exact, close] where target == nil && !want.isEmpty {
    for w in ordered where target == nil {
      if let t = tabButtons(w).first(where: test) { target = (w, t) }
    }
  }
  var out: [String: Any] = ["pressed": false]
  if let target {
    out["pressed"] = AXUIElementPerformAction(target.tab, kAXPressAction as CFString) == .success
    out["title"] = tabTitle(target.tab)
    AXUIElementPerformAction(target.window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(target.window, kAXMainAttribute as CFString, kCFBooleanTrue)
  }
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out, options: []))
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

/// The tables, outlines and list-like groups in a window, in the order "lists" indexes them.
func findLists(_ front: AXUIElement) -> [AXUIElement] {
  let listy = ["List", "TableView", "CollectionView"]
  return find(front, maxDepth: 30, limit: 8, budget: 3000) { e, role in
    if ["AXTable", "AXOutline", "AXList"].contains(role) { return true }
    let id = str(e, "AXIdentifier")
    return role == "AXGroup" && listy.contains { id.contains($0) } && !children(e).isEmpty
  }
}

/// The lists of the first three windows (main window first), at most 8 in all,
/// with the window each is in: the order "lists" indexes them.
func allLists() -> [(window: Int, list: AXUIElement)] {
  var out: [(window: Int, list: AXUIElement)] = []
  for (wi, w) in ordered.prefix(3).enumerated() where out.count < 8 {
    out += findLists(w).prefix(8 - out.count).map { (window: wi, list: $0) }
  }
  return out
}

/// Text without the direction marks Messages and WhatsApp wrap names in, spaces collapsed.
func plain(_ s: String) -> String {
  let marks: [ClosedRange<UInt32>] = [0x200E...0x200F, 0x202A...0x202E, 0x2066...0x2069]
  let kept = String(String.UnicodeScalarView(s.unicodeScalars.filter { u in !marks.contains { $0.contains(u.value) } }))
  return kept.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

func actionNames(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(e, &names) == .success ? (names as? [String]) ?? [] : []
}

/// Open a list row the way a click would: press it (Messages, WhatsApp), else
/// select it (Notes' table rows), else press its first pressable child. A row
/// that's already selected is left alone: pressing the open conversation again
/// makes Messages open it in a window of its own.
func openRow(_ row: AXUIElement) -> String? {
  let press = kAXPressAction as String
  if (attr(row, "AXSelected") as? Bool) == true { return "already open" }
  AXUIElementPerformAction(row, "AXScrollToVisible" as CFString)
  if actionNames(row).contains(press), AXUIElementPerformAction(row, press as CFString) == .success { return "press" }
  var settable = DarwinBoolean(false)
  if AXUIElementIsAttributeSettable(row, "AXSelected" as CFString, &settable) == .success, settable.boolValue,
     AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue) == .success { return "select" }
  for c in children(row) where actionNames(c).contains(press) {
    if AXUIElementPerformAction(c, press as CFString) == .success { return "press child" }
  }
  return nil
}

// context <pid> select <list> <row> [title]: open that row of that list
// (indexes as in the snapshot) and raise its window. `title` (as listed)
// guards against the rows having moved since they were read: if that row
// doesn't contain it, the first row in the list that does is used. Prints
// {"pressed": bool, "how"}.
if CommandLine.arguments.count > 4, CommandLine.arguments[2] == "select" {
  let args = CommandLine.arguments
  let li = Int(args[3]) ?? 0, ri = Int(args[4]) ?? 0, want = plain(args.count > 5 ? args[5] : "")
  func has(_ r: AXUIElement) -> Bool {
    want.isEmpty || plain(([str(r, "AXDescription"), str(r, "AXValue")] + texts(r)).joined(separator: " ")).contains(want)
  }
  var out: [String: Any] = ["pressed": false]
  let lists = allLists()
  if li < lists.count {
    let rows = children(lists[li].list)
    if let row = (ri < rows.count && has(rows[ri])) ? rows[ri] : rows.first(where: has) {
      let how = openRow(row)
      out["pressed"] = how != nil
      out["how"] = how ?? ""
      let window = ordered[lists[li].window]
      AXUIElementPerformAction(window, kAXRaiseAction as CFString)
      AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
  }
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out, options: []))
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

var outWindows: [[String: Any]] = []
for (i, w) in ordered.enumerated() {
  let tabs = tabButtons(w).map { ["title": clip(tabTitle($0)), "selected": str($0, "AXValue") == "1"] as [String: Any] }
  outWindows.append(["title": clip(str(w, "AXTitle")), "main": i == 0 && mainIndex < 12, "tabs": tabs])
}

var outLists: [[String: Any]] = []
do {
  for (li, (wi, l)) in allLists().enumerated() {
    var rows: [[String: Any]] = []
    // Conversation lists are newest first, chat transcripts newest last: keep both ends.
    let all = children(l)
    let keep = all.count <= 60 ? Array(all.indices) : Array(all.indices.prefix(30)) + Array(all.indices.suffix(30))
    for ri in keep {
      let r = all[ri]
      let role = str(r, "AXRole")
      if role == "AXColumn" || role == "AXScrollBar" { continue }
      rows.append([
        "index": ri, "desc": clip(str(r, "AXDescription")), "value": clip(str(r, "AXValue")),
        "id": str(r, "AXIdentifier"), "selected": (attr(r, "AXSelected") as? Bool) ?? false,
        "texts": texts(r),
      ])
    }
    if !rows.isEmpty {
      outLists.append(["index": li, "window": wi, "role": str(l, "AXRole"), "id": str(l, "AXIdentifier"), "desc": str(l, "AXDescription"), "rows": rows])
    }
  }
}

let out: [String: Any] = ["trusted": AXIsProcessTrusted(), "windows": outWindows, "lists": outLists]
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
