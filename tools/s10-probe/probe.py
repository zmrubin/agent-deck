"""Read-only probe of the Streonor S10 Pro (VID 0x1500, PID 0x3007).

Enumerates HID interfaces and reads the firmware-version feature report.
Sends nothing to the device.
"""
import hid

VID, PID = 0x1500, 0x3007

devs = hid.enumerate(VID, PID)
for d in devs:
    print({k: d[k] for k in ("path", "serial_number", "release_number",
                             "manufacturer_string", "product_string",
                             "usage_page", "usage", "interface_number")})

vendor = [d for d in devs if d["usage_page"] == 0xFFA0]
if not vendor:
    raise SystemExit("vendor interface (usage page 0xFFA0) not found")

h = hid.device()
h.open_path(vendor[0]["path"])
print("opened vendor interface")

for rid in (0x01, 0x00, 0x02):
    try:
        data = h.get_feature_report(rid, 64)
        raw = bytes(data)
        print(f"feature report 0x{rid:02x}: {len(raw)} bytes  hex={raw.hex()}  "
              f"text={raw.decode('ascii', 'replace')!r}")
    except Exception as e:  # noqa: BLE001
        print(f"feature report 0x{rid:02x}: error {e}")

h.close()
