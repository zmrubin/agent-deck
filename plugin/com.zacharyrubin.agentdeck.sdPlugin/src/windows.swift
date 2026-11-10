// Window helper for Agent Deck (macOS). Compiled on first use by apps.mjs.
//
// Every <interval> seconds, reads the window list (CGWindowListCopyWindowInfo,
// which needs no permission for owner/size/on-screen info) and prints one
// JSON line describing the normal (layer 0) windows, but only when that line
// changes:  [[pid, width, height, onscreen], …]
// apps.mjs decides from it which apps still have a real window open.
// Exits when its parent goes away or stdout closes.

import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_DFL)
let interval = Double(CommandLine.arguments.dropFirst().first ?? "1") ?? 1
let parent = getppid()
var last = ""

while getppid() == parent {
  autoreleasepool {
    let opts: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return }
    var rows: [String] = []
    for w in list {
      guard (w[kCGWindowLayer as String] as? Int) == 0,
            let pid = w[kCGWindowOwnerPID as String] as? Int,
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
      let on = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
      rows.append("[\(pid),\(Int(r.width)),\(Int(r.height)),\(on ? 1 : 0)]")
    }
    rows.sort()
    let line = "[" + rows.joined(separator: ",") + "]"
    if line != last {
      last = line
      print(line)
    }
  }
  Thread.sleep(forTimeInterval: interval)
}
