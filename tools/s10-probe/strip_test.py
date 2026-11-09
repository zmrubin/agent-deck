"""Find the real size/addressing of the S10 touch strip.

Runs phases; each fills the strip with one solid color and a thin white line
through the middle, using a different image size or slot. Key 1 shows the
phase letter. Watch for the phase where the strip looks continuous (no dark
gaps, the white line unbroken).

Only RAM image slots are written (BAT/CLE/STP). Never LOG (flash).
OpenDeck must be closed while this runs.

Usage: python strip_test.py [seconds_per_phase]
"""
import io
import sys
import time

import hid
from PIL import Image, ImageDraw, ImageFont

VID, PID = 0x1500, 0x3007
PACKET = 1024
HOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 10

PHASES = [
    # letter, color, list of (slot, (w, h))
    ("A", (220, 40, 40), [(s, (176, 112)) for s in (1, 2, 3, 4)]),
    ("B", (30, 170, 60), [(s, (200, 100)) for s in (1, 2, 3, 4)]),
    ("C", (40, 90, 220), [(s, (200, 112)) for s in (1, 2, 3, 4)]),
    ("D", (190, 40, 190), [(5, (800, 100))]),
    ("E", (240, 140, 20), [(16, (800, 100))]),
]


def font(size):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def report(payload: bytes) -> bytes:
    return (b"\x00" + payload).ljust(1 + PACKET, b"\x00")


def cmd(h, payload: bytes):
    if h.write(report(payload)) != 1 + PACKET:
        raise RuntimeError(f"short write for {payload[:12]!r}")


def jpeg(img):
    buf = io.BytesIO()
    img.rotate(180).convert("RGB").save(buf, "JPEG", quality=90)
    return buf.getvalue()


def send_image(h, slot, data):
    cmd(h, b"CRT\x00\x00BAT\x00\x00" + bytes([len(data) >> 8, len(data) & 0xFF, slot]))
    for i in range(0, len(data), PACKET):
        h.write(report(data[i:i + PACKET]))
    cmd(h, b"CRT\x00\x00STP")


def strip_tile(size, color, label):
    w, hgt = size
    img = Image.new("RGB", size, color)
    d = ImageDraw.Draw(img)
    d.line([(0, hgt // 2), (w, hgt // 2)], fill="white", width=3)  # should look unbroken
    d.line([(0, 0), (0, 10)], fill="white", width=2)               # left-edge tick
    d.line([(w - 1, 0), (w - 1, 10)], fill="white", width=2)       # right-edge tick
    d.text((w / 2, hgt * 0.27), label, font=font(18), fill="white", anchor="mm")
    return img


def key_tile(letter, color):
    img = Image.new("RGB", (112, 112), color)
    ImageDraw.Draw(img).text((56, 58), letter, font=font(72), fill="white", anchor="mm")
    return img


path = next(d["path"] for d in hid.enumerate(VID, PID) if d["usage_page"] == 0xFFA0)
h = hid.device()
h.open_path(path)
cmd(h, b"CRT\x00\x00DIS")
cmd(h, b"CRT\x00\x00LIG\x00\x00" + bytes([70]))

try:
    for letter, color, items in PHASES:
        cmd(h, b"CRT\x00\x00CLE\x00\x00\x00\xff")
        cmd(h, b"CRT\x00\x00STP")
        send_image(h, 11, jpeg(key_tile(letter, color)))
        for slot, size in items:
            send_image(h, slot, jpeg(strip_tile(size, color, f"{letter}  slot {slot}  {size[0]}x{size[1]}")))
        print(f"[{time.strftime('%H:%M:%S')}] phase {letter}: " + ", ".join(f"slot {s} {w}x{hh}" for s, (w, hh) in items), flush=True)
        end = time.time() + HOLD
        while time.time() < end:
            time.sleep(0.5)
            r = h.read(512, 10)
        cmd(h, b"CRT\x00\x00CONNECT")
finally:
    h.close()
print("done")
