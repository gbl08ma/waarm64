// The uhid rig's HID devices (tests/usb/uhid.ts, docs/testing.md "USB: the dev VM's host rigs"): report descriptors that cover what
// the WebHID backend's encoder must round-trip (docs/usb.md "The WebHID device"). Chromium's parse of
// each is recorded in tests/usb/hid-fixtures/<id>.json by tests/usb/hid-record.ts.
//
// Only `dualsense` stands for a real device, and it is transcribed, not dumped: written from public dumps of the
// DualSense's USB report descriptor and checked against the report sizes Linux's hid-playstation expects (input 0x01
// 64 bytes, feature 0x05 41, 0x09 20, 0x20 64, each with its ID). The others are ours, shaped like the devices
// they're named after.

export type HidDescriptor = {
  id: string;
  name: string;
  vendorId: number;
  productId: number;
  version?: number;
  rdesc: Uint8Array;
  /** Feature reports GET_REPORT answers, by report ID (0 without IDs), each as sent: the ID byte first when the device has IDs. */
  features?: [number, Uint8Array][];
  note: string;
};

/** Hex bytes with `//` comments, one item per line. */
function hex(s: string): Uint8Array {
  const bytes = s.replace(/\/\/.*$/gm, '').match(/[0-9a-f]{2}/gi) ?? [];
  return Uint8Array.from(bytes, (b) => Number.parseInt(b, 16));
}

/** A feature report of `size` bytes in all (its ID byte first when `id` isn't 0), filled with `fill`. */
function feature(id: number, size: number, fill = 0): [number, Uint8Array] {
  const r = new Uint8Array(size).fill(fill);
  if (id) r[0] = id;
  return [id, r];
}

const dualsense = hex(`
  05 01        // Usage Page (Generic Desktop)
  09 05        // Usage (Game Pad)
  a1 01        // Collection (Application)
  85 01        //   Report ID (1)
  09 30        //   Usage (X)
  09 31        //   Usage (Y)
  09 32        //   Usage (Z)
  09 35        //   Usage (Rz)
  09 33        //   Usage (Rx)
  09 34        //   Usage (Ry)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  75 08        //   Report Size (8)
  95 06        //   Report Count (6)
  81 02        //   Input (Data, Var, Abs)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 20        //   Usage (0x20)
  95 01        //   Report Count (1)
  81 02        //   Input (Data, Var, Abs)
  05 01        //   Usage Page (Generic Desktop)
  09 39        //   Usage (Hat Switch)
  15 00        //   Logical Minimum (0)
  25 07        //   Logical Maximum (7)
  35 00        //   Physical Minimum (0)
  46 3b 01     //   Physical Maximum (315)
  65 14        //   Unit (English Rotation: degrees)
  75 04        //   Report Size (4)
  95 01        //   Report Count (1)
  81 42        //   Input (Data, Var, Abs, Null State)
  65 00        //   Unit (None)
  05 09        //   Usage Page (Button)
  19 01        //   Usage Minimum (1)
  29 0f        //   Usage Maximum (15)
  15 00        //   Logical Minimum (0)
  25 01        //   Logical Maximum (1)
  75 01        //   Report Size (1)
  95 0f        //   Report Count (15)
  81 02        //   Input (Data, Var, Abs)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 21        //   Usage (0x21)
  95 0d        //   Report Count (13)
  81 02        //   Input (Data, Var, Abs)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 22        //   Usage (0x22)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  75 08        //   Report Size (8)
  95 34        //   Report Count (52)
  81 02        //   Input (Data, Var, Abs)
  85 02        //   Report ID (2)
  09 23        //   Usage (0x23)
  95 3f        //   Report Count (63)
  91 02        //   Output (Data, Var, Abs)
  85 05 09 33 95 28 b1 02   // Report ID (5) Usage (0x33) Report Count (40) Feature: calibration
  85 08 09 34 95 2f b1 02   // Report ID (8) Usage (0x34) Report Count (47) Feature
  85 09 09 24 95 13 b1 02   // Report ID (9) Usage (0x24) Report Count (19) Feature: pairing info
  85 0a 09 25 95 1a b1 02   // Report ID (10) Usage (0x25) Report Count (26) Feature
  85 20 09 26 95 3f b1 02   // Report ID (32) Usage (0x26) Report Count (63) Feature: firmware info
  85 21 09 27 95 04 b1 02   // Report ID (33) Usage (0x27) Report Count (4) Feature
  85 22 09 40 95 3f b1 02   // Report ID (34) Usage (0x40) Report Count (63) Feature
  85 80 09 28 95 3f b1 02   // Report ID (128) Usage (0x28) Report Count (63) Feature
  85 81 09 29 95 3f b1 02   // Report ID (129) Usage (0x29) Report Count (63) Feature
  85 82 09 2a 95 09 b1 02   // Report ID (130) Usage (0x2A) Report Count (9) Feature
  85 83 09 2b 95 3f b1 02   // Report ID (131) Usage (0x2B) Report Count (63) Feature
  85 84 09 2c 95 3f b1 02   // Report ID (132) Usage (0x2C) Report Count (63) Feature
  85 85 09 2d 95 02 b1 02   // Report ID (133) Usage (0x2D) Report Count (2) Feature
  85 a0 09 2e 95 01 b1 02   // Report ID (160) Usage (0x2E) Report Count (1) Feature
  85 e0 09 2f 95 3f b1 02   // Report ID (224) Usage (0x2F) Report Count (63) Feature
  85 f0 09 30 95 3f b1 02   // Report ID (240) Usage (0x30) Report Count (63) Feature
  85 f1 09 31 95 3f b1 02   // Report ID (241) Usage (0x31) Report Count (63) Feature
  85 f2 09 32 95 0f b1 02   // Report ID (242) Usage (0x32) Report Count (15) Feature
  85 f4 09 35 95 3f b1 02   // Report ID (244) Usage (0x35) Report Count (63) Feature
  85 f5 09 36 95 03 b1 02   // Report ID (245) Usage (0x36) Report Count (3) Feature
  c0           // End Collection
`);

// Shaped like an Elgato Stream Deck (no Linux driver binds 0fd9): keys as an input report, key images as one large
// output report, commands and identity as feature reports, all under a Consumer Control application collection.
const streamdeck = hex(`
  05 0c        // Usage Page (Consumer)
  09 01        // Usage (Consumer Control)
  a1 01        // Collection (Application)
  85 01        //   Report ID (1)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 01        //   Usage (0x01)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  75 08        //   Report Size (8)
  95 03        //   Report Count (3)
  81 02        //   Input (Data, Var, Abs): a header
  05 09        //   Usage Page (Button)
  19 01        //   Usage Minimum (1)
  29 0f        //   Usage Maximum (15)
  25 01        //   Logical Maximum (1)
  95 0f        //   Report Count (15)
  81 02        //   Input (Data, Var, Abs): one byte per key
  85 02        //   Report ID (2)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 02        //   Usage (0x02)
  26 ff 00     //   Logical Maximum (255)
  96 ff 03     //   Report Count (1023)
  91 02        //   Output (Data, Var, Abs): image data
  85 03        //   Report ID (3)
  09 03        //   Usage (0x03)
  95 1f        //   Report Count (31)
  b1 02        //   Feature (Data, Var, Abs): reset, brightness
  85 05        //   Report ID (5)
  09 05        //   Usage (0x05)
  b1 02        //   Feature: firmware version
  85 06        //   Report ID (6)
  09 06        //   Usage (0x06)
  b1 02        //   Feature: serial number
  c0           // End Collection
`);

// A vendor collection without report IDs, as QMK's and VIA's raw HID: 32 bytes each way, and a feature report.
const vendorNoId = hex(`
  06 60 ff     // Usage Page (Vendor 0xFF60)
  09 61        // Usage (0x61)
  a1 01        // Collection (Application)
  09 62        //   Usage (0x62)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  95 20        //   Report Count (32)
  75 08        //   Report Size (8)
  81 02        //   Input (Data, Var, Abs)
  09 63        //   Usage (0x63)
  95 20        //   Report Count (32)
  91 02        //   Output (Data, Var, Abs)
  09 64        //   Usage (0x64)
  95 20        //   Report Count (32)
  b1 02        //   Feature (Data, Var, Abs)
  c0           // End Collection
`);

// A vendor collection with report IDs: reports of different sizes and signedness, usage ranges and constant padding.
const vendorIds = hex(`
  06 00 ff     // Usage Page (Vendor 0xFF00)
  09 01        // Usage (0x01)
  a1 01        // Collection (Application)
  85 01        //   Report ID (1)
  09 01        //   Usage (0x01)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  75 08        //   Report Size (8)
  95 08        //   Report Count (8)
  81 02        //   Input (Data, Var, Abs)
  85 02        //   Report ID (2)
  09 02        //   Usage (0x02)
  16 00 80     //   Logical Minimum (-32768)
  26 ff 7f     //   Logical Maximum (32767)
  75 10        //   Report Size (16)
  95 04        //   Report Count (4)
  81 02        //   Input (Data, Var, Abs)
  85 03        //   Report ID (3)
  09 03        //   Usage (0x03)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  75 08        //   Report Size (8)
  95 10        //   Report Count (16)
  91 02        //   Output (Data, Var, Abs)
  85 04        //   Report ID (4)
  09 04        //   Usage (0x04)
  95 04        //   Report Count (4)
  b1 02        //   Feature (Data, Var, Abs)
  85 05        //   Report ID (5)
  09 05        //   Usage (0x05)
  95 3f        //   Report Count (63)
  b1 02        //   Feature (Data, Var, Abs)
  85 06        //   Report ID (6)
  05 09        //   Usage Page (Button)
  19 01        //   Usage Minimum (1)
  29 03        //   Usage Maximum (3)
  15 00        //   Logical Minimum (0)
  25 01        //   Logical Maximum (1)
  75 01        //   Report Size (1)
  95 03        //   Report Count (3)
  81 02        //   Input (Data, Var, Abs)
  95 05        //   Report Count (5)
  81 03        //   Input (Const, Var, Abs): padding
  c0           // End Collection
`);

// A game pad without report IDs, as many cheap ones: the sticks in a Pointer physical collection (which a joystick's
// descriptor often has, and which Chromium may treat as protected), a hat with units, buttons, padding.
const gamepadNoId = hex(`
  05 01        // Usage Page (Generic Desktop)
  09 05        // Usage (Game Pad)
  a1 01        // Collection (Application)
  09 01        //   Usage (Pointer)
  a1 00        //   Collection (Physical)
  09 30        //     Usage (X)
  09 31        //     Usage (Y)
  15 00        //     Logical Minimum (0)
  26 ff 00     //     Logical Maximum (255)
  75 08        //     Report Size (8)
  95 02        //     Report Count (2)
  81 02        //     Input (Data, Var, Abs)
  c0           //   End Collection
  09 32        //   Usage (Z)
  09 35        //   Usage (Rz)
  95 02        //   Report Count (2)
  81 02        //   Input (Data, Var, Abs)
  09 39        //   Usage (Hat Switch)
  15 00        //   Logical Minimum (0)
  25 07        //   Logical Maximum (7)
  35 00        //   Physical Minimum (0)
  46 3b 01     //   Physical Maximum (315)
  65 14        //   Unit (English Rotation: degrees)
  75 04        //   Report Size (4)
  95 01        //   Report Count (1)
  81 42        //   Input (Data, Var, Abs, Null State)
  65 00        //   Unit (None)
  75 04        //   Report Size (4)
  95 01        //   Report Count (1)
  81 01        //   Input (Const, Array, Abs): padding
  05 09        //   Usage Page (Button)
  19 01        //   Usage Minimum (1)
  29 0c        //   Usage Maximum (12)
  15 00        //   Logical Minimum (0)
  25 01        //   Logical Maximum (1)
  75 01        //   Report Size (1)
  95 0c        //   Report Count (12)
  81 02        //   Input (Data, Var, Abs)
  95 04        //   Report Count (4)
  81 01        //   Input (Const): padding
  c0           // End Collection
`);

// A keyboard as one HID device with report IDs: the keyboard (with LEDs and a vendor feature report inside it),
// consumer keys, system control, a mouse, and a VIA-style vendor collection. Chromium hides the protected ones.
const keyboard = hex(`
  05 01        // Usage Page (Generic Desktop)
  09 06        // Usage (Keyboard)
  a1 01        // Collection (Application)
  85 01        //   Report ID (1)
  05 07        //   Usage Page (Keyboard)
  19 e0        //   Usage Minimum (Left Control)
  29 e7        //   Usage Maximum (Right GUI)
  15 00        //   Logical Minimum (0)
  25 01        //   Logical Maximum (1)
  75 01        //   Report Size (1)
  95 08        //   Report Count (8)
  81 02        //   Input (Data, Var, Abs): modifiers
  95 01        //   Report Count (1)
  75 08        //   Report Size (8)
  81 01        //   Input (Const): reserved
  95 05        //   Report Count (5)
  75 01        //   Report Size (1)
  05 08        //   Usage Page (LEDs)
  19 01        //   Usage Minimum (Num Lock)
  29 05        //   Usage Maximum (Kana)
  91 02        //   Output (Data, Var, Abs): LEDs
  95 01        //   Report Count (1)
  75 03        //   Report Size (3)
  91 01        //   Output (Const): padding
  95 06        //   Report Count (6)
  75 08        //   Report Size (8)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  05 07        //   Usage Page (Keyboard)
  19 00        //   Usage Minimum (0)
  2a ff 00     //   Usage Maximum (255)
  81 00        //   Input (Data, Array, Abs): keys
  85 06        //   Report ID (6)
  06 00 ff     //   Usage Page (Vendor 0xFF00)
  09 01        //   Usage (0x01)
  95 08        //   Report Count (8)
  75 08        //   Report Size (8)
  b1 02        //   Feature (Data, Var, Abs): a keyboard's configuration
  c0           // End Collection
  05 0c        // Usage Page (Consumer)
  09 01        // Usage (Consumer Control)
  a1 01        // Collection (Application)
  85 02        //   Report ID (2)
  15 00        //   Logical Minimum (0)
  26 ff 03     //   Logical Maximum (1023)
  19 00        //   Usage Minimum (0)
  2a ff 03     //   Usage Maximum (1023)
  75 10        //   Report Size (16)
  95 01        //   Report Count (1)
  81 00        //   Input (Data, Array, Abs)
  c0           // End Collection
  05 01        // Usage Page (Generic Desktop)
  09 80        // Usage (System Control)
  a1 01        // Collection (Application)
  85 03        //   Report ID (3)
  19 81        //   Usage Minimum (System Power Down)
  29 83        //   Usage Maximum (System Wake Up)
  15 00        //   Logical Minimum (0)
  25 01        //   Logical Maximum (1)
  75 01        //   Report Size (1)
  95 03        //   Report Count (3)
  81 02        //   Input (Data, Var, Abs)
  95 05        //   Report Count (5)
  81 01        //   Input (Const): padding
  c0           // End Collection
  05 01        // Usage Page (Generic Desktop)
  09 02        // Usage (Mouse)
  a1 01        // Collection (Application)
  85 04        //   Report ID (4)
  09 01        //   Usage (Pointer)
  a1 00        //   Collection (Physical)
  05 09        //     Usage Page (Button)
  19 01        //     Usage Minimum (1)
  29 03        //     Usage Maximum (3)
  15 00        //     Logical Minimum (0)
  25 01        //     Logical Maximum (1)
  95 03        //     Report Count (3)
  75 01        //     Report Size (1)
  81 02        //     Input (Data, Var, Abs)
  95 01        //     Report Count (1)
  75 05        //     Report Size (5)
  81 01        //     Input (Const): padding
  05 01        //     Usage Page (Generic Desktop)
  09 30        //     Usage (X)
  09 31        //     Usage (Y)
  15 81        //     Logical Minimum (-127)
  25 7f        //     Logical Maximum (127)
  75 08        //     Report Size (8)
  95 02        //     Report Count (2)
  81 06        //     Input (Data, Var, Rel)
  c0           //   End Collection
  c0           // End Collection
  06 60 ff     // Usage Page (Vendor 0xFF60)
  09 61        // Usage (0x61)
  a1 01        // Collection (Application)
  85 05        //   Report ID (5)
  09 62        //   Usage (0x62)
  15 00        //   Logical Minimum (0)
  26 ff 00     //   Logical Maximum (255)
  95 20        //   Report Count (32)
  75 08        //   Report Size (8)
  81 02        //   Input (Data, Var, Abs)
  09 63        //   Usage (0x63)
  95 20        //   Report Count (32)
  91 02        //   Output (Data, Var, Abs)
  c0           // End Collection
`);

export const DESCRIPTORS: HidDescriptor[] = [
  {
    id: 'dualsense',
    name: 'Sony Interactive Entertainment DualSense Wireless Controller',
    vendorId: 0x054c,
    productId: 0x0ce6,
    rdesc: dualsense,
    // What the host's hid-playstation reads at probe: calibration, pairing info (a MAC address), firmware info.
    features: [feature(0x05, 41), feature(0x09, 20, 0x11), feature(0x20, 64), feature(0x22, 64)],
    note: 'transcribed from public dumps of the DualSense USB report descriptor; report sizes checked against hid-playstation',
  },
  {
    id: 'streamdeck',
    name: 'webpc Stream Deck-like',
    vendorId: 0x0fd9,
    productId: 0x0080,
    rdesc: streamdeck,
    features: [feature(0x03, 32), feature(0x05, 32, 0x31), feature(0x06, 32, 0x41)],
    note: 'ours, shaped like an Elgato Stream Deck MK.2: keys in, images out, commands as feature reports',
  },
  {
    id: 'vendor-noid',
    name: 'webpc vendor HID without report IDs',
    vendorId: 0x1209,
    productId: 0x0001,
    rdesc: vendorNoId,
    features: [feature(0, 32, 0x5a)],
    note: 'ours: a QMK/VIA-style raw HID collection, no report IDs',
  },
  {
    id: 'vendor-ids',
    name: 'webpc vendor HID with report IDs',
    vendorId: 0x1209,
    productId: 0x0002,
    rdesc: vendorIds,
    features: [feature(4, 5, 0x44), feature(5, 64, 0x55)],
    note: 'ours: a vendor collection with report IDs, signed 16-bit fields, usage ranges, constant padding',
  },
  {
    id: 'gamepad-noid',
    name: 'webpc game pad without report IDs',
    vendorId: 0x1209,
    productId: 0x0003,
    rdesc: gamepadNoId,
    note: 'ours: a generic game pad, no report IDs, a Pointer physical collection inside',
  },
  {
    id: 'keyboard',
    name: 'webpc keyboard composite',
    vendorId: 0x1209,
    productId: 0x0004,
    rdesc: keyboard,
    features: [feature(6, 9, 0x66)],
    note: 'ours: keyboard (LEDs, a vendor feature report), consumer, system control, mouse and a vendor collection, with report IDs',
  },
];
