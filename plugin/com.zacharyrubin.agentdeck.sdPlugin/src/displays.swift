// Display helper for Agent Deck (macOS). Compiled on first use by power.mjs.
//
// Prints "asleep" when the displays go to sleep (or the Mac starts to sleep)
// and "awake" when they wake, plus the current state at start. Listens for
// AppKit's workspace notifications, and every few seconds also reads each
// display's own sleep state as a backstop in case a notification is missed.
// Exits when its parent goes away or stdout closes.

import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_DFL)

/// True when every connected display is asleep.
func displaysAsleep() -> Bool {
  var count: UInt32 = 0
  guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return false }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return false }
  return ids.prefix(Int(count)).allSatisfy { CGDisplayIsAsleep($0) != 0 }
}

var reported = ""
func report(_ asleep: Bool) {
  let line = asleep ? "asleep" : "awake"
  if line != reported {
    reported = line
    print(line)
  }
}

let center = NSWorkspace.shared.notificationCenter
let events: [(Notification.Name, Bool)] = [
  (NSWorkspace.screensDidSleepNotification, true),
  (NSWorkspace.willSleepNotification, true),
  (NSWorkspace.screensDidWakeNotification, false),
]
for (name, asleep) in events {
  center.addObserver(forName: name, object: nil, queue: .main) { _ in report(asleep) }
}

// The backstop acts only when its own reading changes, so a reading that lags
// behind a notification can't undo it.
var lastReading = displaysAsleep()
report(lastReading)
let parent = getppid()
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  if getppid() != parent { exit(0) }
  let reading = displaysAsleep()
  if reading != lastReading {
    lastReading = reading
    report(reading)
  }
}
RunLoop.main.run()
