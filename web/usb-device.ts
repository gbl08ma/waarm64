// What a USB device is to the xHCI's glue (docs/usb.md): the interface every device
// backend implements (Gadget Zero, a WebUSB passthrough, a WebHID device), and the messages the
// page and the device worker exchange about the controller's ports. The controller is the
// core's; the glue (web/usb.ts) turns its request records into `submit` calls and their results
// into completion records. Devices never see TRBs, rings or guest addresses.
import type { WireError } from './msg.ts';

export type UsbSpeed = 'low' | 'full' | 'high' | 'super';

/** A control transfer's setup packet (USB 2.0 §9.3), fields as numbers. */
export type Setup = { requestType: number; request: number; value: number; index: number; length: number };

/** A transfer's outcome, as the controller turns it into a completion code (xHCI 1.2 §6.4.5). */
export type UsbCode = 'success' | 'short' | 'stall' | 'babble' | 'error';

/**
 * One transfer descriptor (TD). `ep` is the endpoint address: 0 for the default control pipe,
 * `n | 0x80` for IN endpoint n, `n` for OUT endpoint n. A control transfer has its `setup`, and its
 * direction is the setup's (bit 7 of `requestType`). OUT data (a control OUT's data stage, a bulk or
 * interrupt OUT) comes gathered in `data`; an IN can take up to `length` bytes. Linux's zero-length packet
 * after an OUT (URB_ZERO_PACKET) is a TD of its own, of length 0: an empty `transferOut`.
 */
export type UsbTransfer = {
  tag: number;
  ep: number;
  type: 'control' | 'bulk' | 'interrupt' | 'isoch';
  setup?: Setup;
  data?: Uint8Array;
  length: number;
  /** Isochronous: each packet's length (no device takes isochronous TDs yet: docs/backlog.md "USB"). */
  packets?: number[];
};

/** IN data is `data` (at most the TD's `length` bytes); `actual` is the bytes transferred either way. */
export type UsbResult = { code: UsbCode; actual: number; data?: Uint8Array };

/** An endpoint the guest enabled with Configure Endpoint. */
export type UsbEndpoint = { ep: number; type: 'bulk' | 'interrupt' | 'isoch'; maxPacket: number; interval: number };

/**
 * A device on a root port. The standard requests on the default pipe are the device's (SET_ADDRESS
 * excepted: the controller's Address Device), as on hardware: a virtual device answers them from
 * its descriptors, a passthrough interprets them (docs/usb.md).
 */
export interface UsbDevice {
  /** The speed it attaches at: `super` goes on the connector's USB 3 port, anything else on its USB 2 port. */
  readonly speed: UsbSpeed;
  /**
   * Starts a TD. `done` is called once, at once or later; per endpoint, TDs complete in the order
   * they were submitted. In deterministic mode a device completes before `submit` returns, so
   * completions land at a fixed step.
   */
  submit(t: UsbTransfer, done: (r: UsbResult) => void): void;
  /** The guest stopped these TDs of an endpoint (Stop Endpoint, Reset Endpoint). Their `done` may still be called; the glue drops it. */
  cancel(ep: number, tags: number[]): void;
  /** Configure Endpoint: the endpoints enabled now (after SET_CONFIGURATION or SET_INTERFACE). */
  configured?(endpoints: UsbEndpoint[]): void;
  /** The guest reset the port (any reset after the attach's first). */
  reset(): void;
  /** CLEAR_FEATURE(ENDPOINT_HALT) arrives as a control transfer; this is the controller's Reset Endpoint after a stall. */
  clearHalt?(ep: number): void;
  /** Unplugged: no `done` after this; release what the device holds. */
  detach(): void;
  /** What of the host's device the guest doesn't get (an interface WebUSB refuses or the host holds, a HID collection WebHID hides): `usb-state`'s `problems`. */
  readonly problems?: UsbProblem[];
}

/** What a page attaches, by its identity (WebUSB's and WebHID's grants persist per origin). */
export type UsbIdentity = {
  api: 'usb' | 'hid';
  vendorId: number;
  productId: number;
  serialNumber?: string;
  productName?: string;
  /** Among identical devices without a serial number, which one in `getDevices()` order. */
  index?: number;
};

/**
 * What the glue (web/usb.ts) gives an opener: `gone` detaches the device's connector when the host's device
 * vanished (the page gets `usb-state` detached, reason 'unplugged'); `connector` is the root connector it goes on.
 */
export type UsbOpenerContext = { gone?: () => void; connector?: number };

/** Opens a granted device for the guest (web/usb.ts `registerUsbOpener`: WebUSB's for 'usb', WebHID's for 'hid'). */
export type UsbOpener = (identity: UsbIdentity, ctx: UsbOpenerContext) => Promise<UsbDevice>;

/**
 * A virtual device of ours, by kind (Gadget Zero is the controller's test device, web/usb-gadget-zero.ts): its speed
 * (default high), its source's and sink's data pattern (0 zeros, the default as Linux's g_zero; 1 the mod-63 bytes,
 * usbtest's `pattern=1`) and its serial number.
 */
export type UsbVirtual =
  | { api: 'virtual'; kind: 'gadget-zero'; speed?: UsbSpeed; pattern?: 0 | 1; serial?: string }
  /** The built-in boot keyboard (web/usb-keyboard.ts), fed by `usb-key` messages: the firmware's keyboard. */
  | { api: 'virtual'; kind: 'keyboard' };

/** Root connectors are numbered 0–3; each has a USB 2 and a USB 3 port behind it (docs/usb.md). */
export type UsbToWorker =
  | { type: 'usb-attach'; connector: number; device: UsbIdentity | UsbVirtual }
  | { type: 'usb-detach'; connector: number }
  /** A key of the page's (`KeyboardEvent.code`) for the device on `connector` (the built-in keyboard); no answer. `code` '' releases every key. */
  | { type: 'usb-key'; connector: number; code: string; down: boolean };

export type UsbFromWorker =
  | { type: 'usb-state'; connector: number; state: 'attached'; device: UsbIdentity | UsbVirtual; speed: UsbSpeed; problems?: UsbProblem[] }
  | { type: 'usb-state'; connector: number; state: 'detached'; reason?: 'unplugged' | 'guest' | 'page' }
  /** `message`: the error's text, a developer's; `error`: the error itself, for the page's words (web/msg.ts `toWire`). */
  | { type: 'usb-state'; connector: number; state: 'error'; message: string; error?: WireError; detail?: UsbProblem[] }
  /** The LEDs the guest set on the built-in keyboard (its output report: bit 0 Num, 1 Caps, 2 Scroll Lock), on a change. */
  | { type: 'usb-leds'; connector: number; leds: number };
/** An attach's answer (`usb-state`). */
export type UsbState = Extract<UsbFromWorker, { type: 'usb-state' }>;

/**
 * Why part of a device can't reach the guest, for the page's messages (docs/usb.md "The page"): on a successful attach
 * (`usb-state` attached, `problems`: what was left out) or a failed one (`error`, `detail`). `claim-failed`'s message is
 * the browser's; the remedies are the page's (web/app/usb-ports.ts `problemText`).
 */
export type UsbProblem =
  | { kind: 'protected-interface'; interface: number; class: number }
  | { kind: 'claim-failed'; interface: number; message: string }
  /** A HID top-level collection WebHID keeps the input and output reports of (a keyboard's, a mouse's): `kept` says whether its feature reports are left. */
  | { kind: 'protected-collection'; usagePage: number; usage: number; kept: boolean }
  | { kind: 'no-collections' }
  | { kind: 'open-failed'; message: string };
