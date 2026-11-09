"""Find the real height of the S10's full-width strip slot (slot 5).

Each phase sends one 800xH image to slot 5: a solid color, a white bar on the
top edge, a yellow bar on the bottom edge, and H printed big. Key 1 shows the
phase letter. The right H is the largest one where both bars are visible with
no dark band above the white bar.

Only RAM image slots are written (BAT/CLE/STP). Never LOG (flash).
OpenDeck must be closed while this runs.

Usage: python strip_height_test.py [seconds_per_phase]
"""
import io
import sys
import time

import hid
from PIL import Image, ImageDraw, ImageFont

VID, PID = 0x1500, 0x3007
PACKET = 1024
HOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 10
PHASES = [("A", 100, (190, 40, 190)), ("B", 112, (30, 150, 60)), ("C", 120, (40, 90, 220)), ("D", 128, (220, 110, 20))]


def font(size):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def report(payload):
    return (b"\x00" + payload).ljust(1 + PACKET, b"\x00")


def cmd(h, payload):
    if h.write(report(payload)) != 1 + PACKET:
        raise RuntimeError(f"short write for {payload[:12]!r}")


def send_image(h, slot, img):
    buf = io.BytesIO()
    img.rotate(180).convert("RGB").save(buf, "JPEG", quality=90)
    data = buf.getvalue()
    cmd(h, b"CRT\x00\x00BAT\x00\x00" + bytes([len(data) >> 8, len(data) & 0xFF, slot]))
    for i in range(0, len(data), PACKET):
        h.write(report(data[i:i + PACKET]))
    cmd(h, b"CRT\x00\x00STP")


def strip(hgt, color, letter):
    img = Image.new("RGB", (800, hgt), color)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 799, 3], fill="white")                 # top edge
    d.rectangle([0, hgt - 4, 799, hgt - 1], fill=(255, 230, 0))  # bottom edge
    d.text((400, hgt / 2), f"{letter}   H = {hgt}", font=font(40), fill="white", anchor="mm")
    return img


def key(letter, color):
    img = Image.new("RGB", (112, 112), color)
    ImageDraw.Draw(img).text((56, 58), letter, font=font(72), fill="white", anchor="mm")
    return img


path = next(d["path"] for d in hid.enumerate(VID, PID) if d["usage_page"] == 0xFFA0)
h = hid.device()
h.open_path(path)
cmd(h, b"CRT\x00\x00DIS")
try:
    for letter, hgt, color in PHASES:
        cmd(h, b"CRT\x00\x00CLE\x00\x00\x00\xff")
        cmd(h, b"CRT\x00\x00STP")
        send_image(h, 11, key(letter, color))
        send_image(h, 5, strip(hgt, color, letter))
        print(f"[{time.strftime('%H:%M:%S')}] phase {letter}: slot 5, 800x{hgt}", flush=True)
        end = time.time() + HOLD
        while time.time() < end:
            time.sleep(0.5)
            h.read(512, 10)
        cmd(h, b"CRT\x00\x00CONNECT")
finally:
    h.close()
print("done")
