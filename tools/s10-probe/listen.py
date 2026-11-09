"""Passively listen to the Streonor S10 Pro vendor HID interface. Sends nothing.

Decodes packets using the input map from the opendeck-akp05 plugin
(Mirabox N4 family): ACK header, input code at byte 9, state at byte 10.
"""
import sys
import time

import hid

VID, PID = 0x1500, 0x3007
_nums = [a for a in sys.argv[1:] if not a.startswith("--")]
SECONDS = float(_nums[0]) if _nums else 30

KNOB_TWIST = {0xA0: (1, "left"), 0xA1: (1, "right"), 0x50: (2, "left"), 0x51: (2, "right"),
              0x90: (3, "left"), 0x91: (3, "right"), 0x70: (4, "left"), 0x71: (4, "right")}
KNOB_PRESS = {0x37: 1, 0x35: 2, 0x33: 3, 0x36: 4}
TOUCH = {0x40: "touch zone 1", 0x41: "touch zone 2", 0x42: "touch zone 3",
         0x43: "touch zone 4", 0x38: "swipe (left?)", 0x39: "swipe (right?)"}


def describe(code: int, state: int) -> str:
    if 1 <= code <= 10:
        return f"LCD key {code} {'down' if state else 'up'}"
    if code in KNOB_TWIST:
        k, d = KNOB_TWIST[code]
        return f"knob {k} turned {d}"
    if code in KNOB_PRESS:
        return f"knob {KNOB_PRESS[code]} pressed (state {state})"
    if code in TOUCH:
        return f"{TOUCH[code]} (state {state})"
    return f"UNKNOWN code 0x{code:02x} state {state}"


WAKE = "--wake" in sys.argv

path = next(d["path"] for d in hid.enumerate(VID, PID) if d["usage_page"] == 0xFFA0)
h = hid.device()
h.open_path(path)
if WAKE:
    # Same "wake display" handshake mirajazz/OpenDeck send on connect:
    # report ID 0 + b"CRT\0\0DIS", padded to the 1024-byte output report.
    pkt = bytes([0x00]) + b"CRT\x00\x00DIS"
    pkt = pkt.ljust(1 + 1024, b"\x00")
    print(f"sent wake handshake ({h.write(pkt)} bytes)", flush=True)
print(f"listening {SECONDS:.0f}s on vendor interface...", flush=True)
end = time.time() + SECONDS
n = 0
while time.time() < end:
    data = h.read(512, 250)
    if not data:
        continue
    n += 1
    raw = bytes(data)
    head = raw[:16].hex(" ")
    if raw[:3] == b"ACK":
        print(f"[{time.strftime('%H:%M:%S')}] {head}  ->  {describe(raw[9], raw[10])}", flush=True)
    else:
        print(f"[{time.strftime('%H:%M:%S')}] non-ACK packet: {head}", flush=True)
h.close()
print(f"done, {n} packet(s) received")
