# Streonor S10 (Pro) — hardware notes

What we learned probing the device directly (2026-11-08). The S10 is a rebadged
Mirabox N4 / Ajazz AKP05: the vendor's own software tags its profiles
`"DeviceUUID": "MBox-N4"` with Elgato's Stream Deck+ model id.

## Identity

| | |
|---|---|
| USB VID:PID | `1500:3007` (vendor 0x1500 is shared with Soomfon CN003 `1500:3002`) |
| USB strings | manufacturer `HOTSPOTEKUSB`, product `HOTSPOTEKUSB HID DEMO` (generic chip strings) |
| Firmware | `V3.S10.02.017` — read from HID feature report 0x01 |
| Link | USB 2.0 high speed (480 Mb/s), 450 mA |
| Controls | 10 LCD keys (5×2), 4 push knobs, touch strip split into 4 segments |

## USB interfaces

1. **Interface 0 — vendor HID**, usage page `0xFFA0`, usage 1 (and 2). No report IDs.
   512-byte input reports, 1024-byte output reports. This is the control channel.
2. **Interface 1 — boot keyboard** (usage page 1, usage 6). Used in standalone mode.

## Protocol (v3, same as mirajazz / opendeck-akp05)

Every command is one 1024-byte output report (send 1025 bytes with a leading
`0x00` report id), starting with `CRT\0\0` + a 3-letter command:

| Command | Bytes after `CRT\0\0` | Effect |
|---|---|---|
| Wake | `DIS` | **Required** before the device reports input on interface 0 |
| Brightness | `LIG\0\0<0-100>` | Screen brightness |
| Clear | `CLE\0\0\0<slot or 0xFF>` | Clear one slot / all |
| Image | `BAT\0\0<len_hi><len_lo><slot>` then data in 1024-byte reports | JPEG for one slot |
| Commit | `STP` | Show what was sent (send after each image / clear) |
| Keep-alive | `CONNECT` | Send every ~10 s while connected |
| Sleep | `HAN` | Screens off |

Images: keys 112×112 JPEG, touch-strip segments 176×112 JPEG, both rotated 180°.
Do **not** send `LOG` (boot logo) — that one is written to flash.

### Image slots (where pictures go)

| Slot | Screen |
|---|---|
| 11–15 | top row keys, left → right |
| 6–10 | bottom row keys, left → right |
| 1–4 | touch-strip segments, left → right (176×112 each — **dark gaps between them**) |
| **5** | **the whole touch strip as one 800×128 image, continuous, edge to edge** (found 2026-11-08; the stock plugin never uses it) |

Whole-display layout: the S10 is one 800×480 panel behind the keys; slots are
regions on it. Mirabox's SDK only offers a full-panel image via the boot logo
(`LOG`, written to flash — never use it for live content). For a continuous
strip, send an 800×128 JPEG (rotated 180°) to slot 5 instead of slots 1–4.
(800×100 also displays, but leaves an unused band at the top; tested
100/112/120/128 with edge markers — 128 fills the strip.)

Patched device plugin doing this: `~/Development/opendeck-akp05`, branch
`s10-full-strip` (stitches OpenDeck's four 200×100 dial images into 800×128).

### Input (interface 0, after `DIS`)

Reports start `ACK\0\0OK\0\0`; byte 9 = input code, byte 10 = state.

| Code | Meaning |
|---|---|
| `0x01`–`0x0A` | LCD keys 1–10, state 1 = down, 0 = up |
| `a0`/`a1`, `50`/`51`, `90`/`91`, `70`/`71` | Knobs 1–4 turned left / right |
| `37`, `35`, `33`, `36` | Knobs 1–4 pressed (no release event) |
| `40`–`43` | Touch-strip taps (expected; not yet observed) |
| `38`, `39` | Touch-strip swipes |
| `b2` | Seen once right after a keep-alive; meaning unknown, harmless |

## Software

- OpenDeck 2.14.2 + `opendeck-akp05` v0.11.1 (lists "Streonor S10 Pro (1500:3007)") works on macOS.
- The vendor app (Streonor 2.10.179, bundle `com.xf.controldeck`) is a rebranded Mirabox StreamDock app. Don't run it alongside OpenDeck.

Low-level probe scripts: [`tools/s10-probe/`](../tools/s10-probe/).
