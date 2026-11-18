// What the USB menu and the Home page's USB tab ask (docs/usb.md "The page"; web/app/page.ts's `usb*`): devices
// added from the browser's chooser, attached, detached, edited and forgotten, grants given, the menu's offers taken,
// the game pads and Gadget Zero; and the host's devices and pads as they come and go.
import { describe, msg, MsgError, t } from '../../i18n.ts';
import { listPads } from '../gamepads.ts';
import { KEYBOARD_CONNECTOR, type MachineRecord, type UsbEntry } from '../shape.ts';
import {
  browserApi,
  entryStates,
  filterFor,
  findDevices,
  granted,
  identityOfDevice,
  requestDevices,
  ungranted,
  type Api,
  type HostDevice,
  type UsbPorts,
} from '../usb-live.ts';
import { deviceName, entryOf, identityKey, newEntry } from '../usb-ports.ts';
import type { UsbVirtual } from '../../usb-device.ts';
import type { Messages } from '../run/messages.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { Page } from '../page.ts';
import { attachFailed, type UsbRun } from './usb-attach.ts';
import type { UsbEntries } from './usb-entries.ts';
import { padOf, type UsbView } from './usb-view.ts';
import { usb } from './usb.svelte.ts';

/** How long after a device left a new one is taken for it come back (re-enumeration). */
const REENUMERATION_MS = 60_000;

type UsbPage = Pick<
  Page,
  | 'usbAdd'
  | 'usbAttach'
  | 'usbDetach'
  | 'usbEdit'
  | 'usbForget'
  | 'usbAllow'
  | 'usbOffer'
  | 'usbStates'
  | 'usbPad'
  | 'usbZero'
>;

export class UsbActions {
  readonly #m: PageMachine;
  readonly #messages: Messages;
  readonly #entries: UsbEntries;
  readonly #run: UsbRun;
  readonly #view: UsbView;

  constructor(d: { machine: PageMachine; messages: Messages; entries: UsbEntries; run: UsbRun; view: UsbView }) {
    [this.#m, this.#messages, this.#entries, this.#run, this.#view] = [d.machine, d.messages, d.entries, d.run, d.view];
    d.run.replug = async (api, o) => {
      for (const device of await requestDevices(api)) await this.rememberAndAttach(api, device, o);
    };
  }

  readonly #padCame = () => this.#view.refresh();
  /** A pad the browser loses is unplugged. */
  readonly #padWent = (ev: GamepadEvent) => {
    const p = this.#m.run?.usb;
    const index = ev.gamepad.index;
    p?.connectors.forEach((c, i) => {
      if (padOf(c) === index) void p.detach(i).catch(() => undefined); // it's gone either way
    });
    this.#view.refresh();
  };

  /**
   * Follows the host: its game pads while the machine runs with its controller (a pad attaches only then), and its
   * devices plugged in and out. Chromium polls the pads (a thread of the browser's, ~0.5% of a core) from the first
   * gamepad listener or `getGamepads()` until the page's last gamepad listener goes: so the listeners go when the
   * machine stops, and the pads are read only while it runs (UsbView.refresh), and an idle tab polls nothing.
   */
  listen() {
    usb.watchRunning((on) => {
      if (on) {
        addEventListener('gamepadconnected', this.#padCame);
        addEventListener('gamepaddisconnected', this.#padWent);
        this.#view.refresh();
      } else {
        removeEventListener('gamepadconnected', this.#padCame);
        removeEventListener('gamepaddisconnected', this.#padWent);
      }
    });
    for (const api of ['usb', 'hid'] as const) {
      browserApi(api)?.addEventListener('connect', (ev) => void this.#connected(api, ev.device));
      browserApi(api)?.addEventListener('disconnect', () => this.#view.refresh());
    }
  }

  /** The browser's grant for entry `id` of machine `machine`, from a click: its chooser, filtered on the entry's device. */
  async allow(machine: string | undefined, id: string) {
    const e = (await this.#entries.of(machine)).find((x) => x.id === id);
    if (!e) return;
    const devices = await requestDevices(e.api, [filterFor(e)]);
    if (!devices.length) return;
    granted(identityKey(e));
    usb.takeOffer(`allow-${e.id}`);
    if (this.#m.isCurrent(machine) && this.#run.running() && e.atStart) await this.#run.attach(e);
    this.#view.refresh();
  }

  /** Remembers `device` (just picked or plugged in) on the page's machine, unless it is already, and attaches it while the machine runs. */
  async rememberAndAttach(api: Api, device: HostDevice, o: { connector?: number; atStart?: boolean } = {}) {
    const identity = await identityOfDevice(api, device);
    granted(identityKey(identity));
    let e = entryOf(this.#entries.list(), identity);
    if (!e) {
      const added = newEntry(identity, this.#entries.list(), o);
      await this.#entries.edit(this.#m.stored?.record.id, (list) => [...list, added]);
      e = added;
    }
    if (this.#run.running()) await this.#run.attach(e);
  }

  // A device plugged in with a grant (WebUSB and WebHID say so only for those): an entry attached at start goes on; a
  // remembered one not attached at start, or one this machine doesn't remember, is offered; one right after an
  // attached device left takes that one's connector (re-enumeration: docs/usb.md "What the browser allows").
  async #connected(api: Api, device: HostDevice) {
    this.#view.refresh();
    const p = this.#m.run?.usb;
    if (!this.#run.running() || !p) return;
    const identity = await identityOfDevice(api, device);
    granted(identityKey(identity));
    const name = deviceName(identity);
    const id = `seen-${identityKey(identity)}`;
    const e = entryOf(this.#entries.list(), identity);
    if (e) {
      if (p.connectorOf(e.id) !== -1) return;
      if (e.atStart && !p.connectors[e.connector])
        return void this.#run
          .attach(e, { quiet: true })
          .catch((err: unknown) => this.#messages.notify(attachFailed(name, err), 'error'));
      const label = t('usb:usb-actions.offer.attach');
      return usb.offer({
        id,
        text: msg('usb:usb-actions.offer.plugged', { name }),
        label,
        run: () => this.#run.attach(e),
      });
    }
    const gone = this.#run.lastGone;
    const back = gone && Date.now() - gone.at < REENUMERATION_MS ? gone : undefined;
    if (back) {
      usb.takeOffer(`gone-${back.connector}`);
      return usb.offer({
        id,
        text: msg('usb:usb-actions.offer.back', { name, was: back.name, connector: back.connector + 1 }),
        label: t('usb:usb-actions.offer.there'),
        run: () => this.rememberAndAttach(api, device, { connector: back.connector, atStart: back.atStart }),
      });
    }
    const label = t('usb:usb-actions.offer.remember');
    usb.offer({
      id,
      text: msg('usb:usb-actions.offer.plugged', { name }),
      label,
      run: () => this.rememberAndAttach(api, device),
    });
  }

  /** The running machine's ports, or an error (`zero`: Gadget Zero's words). */
  #ports(zero = false): UsbPorts {
    const p = this.#m.run?.usb;
    if (!p || !this.#run.running())
      throw new MsgError(zero ? 'usb:usb-actions.zero.stopped' : 'usb:usb-actions.stopped');
    return p;
  }
  /** A virtual device of ours on a free connector (not the built-in keyboard's), or off where `on` finds it. */
  async #toggle(p: UsbPorts, on: number, device: UsbVirtual | (() => UsbVirtual), full: string) {
    if (on >= 0) return p.detach(on);
    const free = p.connectors.findIndex((c, i) => !c && i !== KEYBOARD_CONNECTOR);
    if (free < 0) throw new MsgError(full);
    await p.attach(free, typeof device === 'function' ? device() : device);
  }

  async #forget(machine: string | undefined, id: string) {
    const e = (await this.#entries.of(machine)).find((x) => x.id === id);
    if (!e) return;
    if (this.#m.isCurrent(machine)) await this.#detach(id);
    await this.#entries.edit(machine, (list) => list.filter((x) => x.id !== id));
    // No other machine remembers it: the browser's grant goes too.
    const key = identityKey(e);
    const machines = await this.#m.store.all('machines');
    const others = [...machines.flatMap((m) => m.usbDevices ?? []), ...this.#entries.transient];
    if (others.some((x) => identityKey(x) === key)) return;
    const d = (await findDevices([e])).get(e.id);
    await d?.forget?.().catch(() => undefined); // the grant may stay: the browser's own to drop
    ungranted(key);
    this.#view.refresh();
  }
  async #detach(id: string) {
    const p = this.#m.run?.usb;
    const at = p?.connectorOf(id) ?? -1;
    if (p && at >= 0) await p.detach(at);
  }
  async #add(machine: string | undefined, api: Api) {
    const names: string[] = [];
    for (const d of await requestDevices(api)) {
      const identity = await identityOfDevice(api, d);
      granted(identityKey(identity));
      names.push(deviceName(identity));
      const have = await this.#entries.of(machine);
      if (entryOf(have, identity)) continue;
      const e = newEntry(identity, have);
      await this.#entries.edit(machine, (list) => [...list, e]);
      if (this.#m.isCurrent(machine) && this.#run.running()) await this.#run.attach(e);
    }
    return names;
  }

  /** The page's `usb*` actions. */
  page(): UsbPage {
    const m = this.#m;
    const attached = () => m.run?.usb?.attachedEntries() ?? new Set<string>();
    return {
      usbAdd: (machine, api) => this.#add(machine, api),
      usbAttach: async (id) => {
        const e = this.#entries.list().find((x) => x.id === id);
        if (e) await this.#run.attach(e);
      },
      usbDetach: (id) => this.#detach(id),
      usbEdit: async (machine, id, change: Partial<Pick<UsbEntry, 'connector' | 'atStart'>>) => {
        if (change.connector !== undefined && m.isCurrent(machine) && (m.run?.usb?.connectorOf(id) ?? -1) >= 0)
          throw new MsgError('usb:usb-actions.edit.detachFirst');
        await this.#entries.edit(machine, (list) => list.map((e) => (e.id === id ? { ...e, ...change } : e)));
      },
      usbForget: (machine, id) => this.#forget(machine, id),
      usbAllow: (machine, id) => this.allow(machine, id),
      usbOffer: (id, take) => {
        const o = usb.takeOffer(id);
        if (take && o)
          void o
            .run()
            .catch((err: unknown) => this.#messages.notify(describe(err), 'error'))
            .finally(() => this.#view.refresh());
      },
      usbStates: (r: MachineRecord) =>
        entryStates(r.usbDevices ?? [], m.isCurrent(r.id) ? attached() : new Set<string>(), this.#entries.locks),
      usbPad: async (index) => {
        const p = this.#ports();
        const pad = () => {
          const found = listPads().find((x) => x.index === index);
          if (!found) throw new MsgError('usb:usb-actions.pad.gone');
          return { api: 'virtual', kind: 'gamepad', index, name: found.name } as const;
        };
        await this.#toggle(
          p,
          p.connectors.findIndex((c) => padOf(c) === index),
          pad,
          'usb:usb-actions.pad.full',
        );
      },
      usbZero: async () => {
        const p = this.#ports(true);
        const at = p.connectors.findIndex((c) => c?.device.api === 'virtual' && c.device.kind === 'gadget-zero');
        await this.#toggle(p, at, { api: 'virtual', kind: 'gadget-zero' }, 'usb:usb-actions.zero.full');
      },
    };
  }
}
