"""Draw numbered test images on the Streonor S10 Pro, mirroring opendeck-akp05.

Sequence copied from the plugin's device_task + mirajazz:
  DIS (wake) -> LIG 0 -> LIG 50 (brightness) -> CLE 0xFF + STP (clear all)
  -> for each image: BAT header + 1024-byte data reports, then STP
  -> keep the handle open, CONNECT keep-alive every 10 s, while reading input.

Protocol v3: 112x112 JPEG keys, 176x112 JPEG touch-strip segments, rotated 180.
Slot numbers follow the plugin's map_position() + 1:
  top row keys (OpenDeck 0-4)    -> slots 11-15
  bottom row keys (OpenDeck 5-9) -> slots 6-10
  touch strip segments 0-3       -> slots 1-4
Nothing persistent is written (no boot logo).

Usage: draw_test.py [hold_seconds] [--brightness N]
"""
import colorsys
import io
import sys
import time

import hid
from PIL import Image, ImageDraw, ImageFont

VID, PID = 0x1500, 0x3007
PACKET = 1024


def font(size):
    for path in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def jpeg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.rotate(180).convert("RGB").save(buf, "JPEG", quality=90)
    return buf.getvalue()


def make_tile(size, label, sub, hue):
    r, g, b = (int(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.75, 0.85))
    img = Image.new("RGB", size, (r, g, b))
    d = ImageDraw.Draw(img)
    w, h = size
    d.text((w / 2, 4), "TOP", font=font(14), fill="white", anchor="mt")
    d.text((w / 2, h / 2 + 2), label, font=font(52), fill="white", anchor="mm")
    d.text((w / 2, h - 4), sub, font=font(13), fill="white", anchor="mb")
    return img


def report(payload: bytes) -> bytes:
    return (b"\x00" + payload).ljust(1 + PACKET, b"\x00")


def cmd(h, payload: bytes, label: str = ""):
    n = h.write(report(payload))
    if n != 1 + PACKET:
        raise RuntimeError(f"short write {n} for {payload[:12]!r}")
    if label:
        print(f"sent {label}", flush=True)


def send_image(h, slot: int, data: bytes):
    if len(data) > 0xFFFF:
        raise ValueError("image too large for 16-bit length")
    cmd(h, b"CRT\x00\x00BAT\x00\x00" + bytes([len(data) >> 8, len(data) & 0xFF, slot]))
    for i in range(0, len(data), PACKET):
        h.write(report(data[i:i + PACKET]))
    cmd(h, b"CRT\x00\x00STP")  # plugin flushes (STP) after every image


def jobs():
    out = []
    for pos in range(10):  # OpenDeck reading order: 0-4 top row, 5-9 bottom row
        slot = (pos + 10 if pos < 5 else pos) + 1
        out.append((slot, make_tile((112, 112), str(pos + 1), f"slot {slot}", pos / 10)))
    for seg in range(4):
        slot = seg + 1
        out.append((slot, make_tile((176, 112), f"K{seg + 1}", f"strip slot {slot}",
                                    0.55 + seg * 0.1)))
    return out


def main():
    args = sys.argv[1:]
    brightness = 50
    if "--brightness" in args:
        i = args.index("--brightness")
        brightness = max(0, min(100, int(args[i + 1])))
        del args[i:i + 2]
    hold = float(args[0]) if args else 45

    path = next(d["path"] for d in hid.enumerate(VID, PID) if d["usage_page"] == 0xFFA0)
    h = hid.device()
    h.open_path(path)

    cmd(h, b"CRT\x00\x00DIS", "DIS (wake)")
    cmd(h, b"CRT\x00\x00LIG\x00\x00\x00\x00", "LIG 0 (mirajazz initialize)")
    cmd(h, b"CRT\x00\x00LIG\x00\x00" + bytes([brightness]), f"LIG {brightness} (brightness)")
    cmd(h, b"CRT\x00\x00CLE\x00\x00\x00\xff", "CLE 0xFF (clear all)")
    cmd(h, b"CRT\x00\x00STP", "STP (commit clear)")

    for slot, img in jobs():
        data = jpeg(img)
        send_image(h, slot, data)
        print(f"slot {slot:2d}: {len(data)} bytes + STP", flush=True)

    print(f"holding connection {hold:.0f}s (keep-alive every 10s, logging input)...", flush=True)
    end = time.time() + hold
    next_ka = time.time() + 10
    while time.time() < end:
        if time.time() >= next_ka:
            cmd(h, b"CRT\x00\x00CONNECT", "CONNECT keep-alive")
            next_ka += 10
        r = h.read(512, 200)
        if r:
            raw = bytes(r)
            print(f"[{time.strftime('%H:%M:%S')}] input: {raw[:12].hex(' ')}", flush=True)
    h.close()
    print("closed")


if __name__ == "__main__":
    main()
