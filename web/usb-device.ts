// What a USB device is to the xHCI's glue (docs/plans/usb.md §4): the interface every device
// backend implements (Gadget Zero, a WebUSB passthrough, a WebHID device), and the messages the
// page and the device worker exchange about the controller's ports. The controller is the
// core's; the glue (web/usb.ts) turns its request records into `submit` calls and their results
// into completion records. Devices never see TRBs, rings or guest addresses.

export type UsbSpeed = 'low' | 'full' | 'high' | 'super';

/** A control transfer's setup packet (USB 2.0 §9.3), fields as numbers. */
export type Setup = { requestType: number; request: number; value: number; index: number; length: number };

/** A transfer's outcome, as the controller turns it into a completion code (xHCI 1.2 §6.4.5). */
export type UsbCode = 'success' | 'short' | 'stall' | 'babble' | 'error';

/**
 * One transfer descriptor (TD). `ep` is the endpoint address: 0 for the default control pipe,
 * `n | 0x80` for IN endpoint n, `n` for OUT endpoint n. A control transfer has its `setup`, and its
 * direction is the setup's (bit 7 of `requestType`). OUT data (a control OUT's data stage, a bulk or
 * interrupt OUT) comes gathered in `data`; an IN can take up to `length` bytes.
 */
export type UsbTransfer = {
  tag: number;
  ep: number;
  type: 'control' | 'bulk' | 'interrupt' | 'isoch';
  setup?: Setup;
  data?: Uint8Array;
  length: number;
  /** An OUT TD ended by the zero-length TRB Linux adds for URB_ZERO_PACKET: send an empty packet after the data. */
  zeroPacket?: boolean;
  /** Isochronous: each packet's length (U6). */
  packets?: number[];
};

/** IN data is `data` (at most the TD's `length` bytes); `actual` is the bytes transferred either way. */
export type UsbResult = { code: UsbCode; actual: number; data?: Uint8Array };

/** An endpoint the guest enabled with Configure Endpoint. */
export type UsbEndpoint = { ep: number; type: 'bulk' | 'interrupt' | 'isoch'; maxPacket: number; interval: number };

/**
 * A device on a root port. The standard requests on the default pipe are the device's (SET_ADDRESS
 * excepted: the controller's Address Device), as on hardware: a virtual device answers them from
 * its descriptors, a passthrough interprets them (docs/plans/usb.md §4).
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

/** A virtual device of ours, by kind (Gadget Zero is the controller's test device). */
export type UsbVirtual = { api: 'virtual'; kind: 'gadget-zero' };

/** Root connectors are numbered 0–3; each has a USB 2 and a USB 3 port behind it (docs/plans/usb.md §4). */
export type UsbToWorker =
  | { type: 'usb-attach'; connector: number; device: UsbIdentity | UsbVirtual }
  | { type: 'usb-detach'; connector: number };

export type UsbFromWorker =
  | { type: 'usb-state'; connector: number; state: 'attached'; device: UsbIdentity | UsbVirtual; speed: UsbSpeed; notes?: string[] }
  | { type: 'usb-state'; connector: number; state: 'detached'; reason?: 'unplugged' | 'guest' | 'page' }
  | { type: 'usb-state'; connector: number; state: 'error'; message: string; detail?: UsbProblem[] };

/** Why part of a device can't reach the guest, for the page's messages (docs/plans/usb.md U4). */
export type UsbProblem =
  | { kind: 'protected-interface'; interface: number; class: number }
  | { kind: 'claim-failed'; interface: number; message: string }
  | { kind: 'no-collections' }
  | { kind: 'open-failed'; message: string };
