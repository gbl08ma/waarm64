// USB on the running machine (docs/usb.md "The page"): a machine with a controller attaches its remembered devices
// when it runs, by their identities (the device worker opens them: web/usb-device.ts). A device is one machine's at a
// time (its Web Lock, web/app/usb-live.ts); Snapshot and Suspend empty the ports first. The built-in keyboard is
// plugged in while the guest has no driver on its virtio keyboard; a device plugged in is attached or offered.
import { msg, MsgError, t, text, type Said } from '../../i18n.ts';
import type { UsbIdentity, UsbVirtual } from '../../usb-device.ts';
import { ask } from '../ask.svelte.ts';
import { listPads } from '../gamepads.ts';
import { KEYBOARD_CONNECTOR, type UsbEntry } from '../shape.ts';
import { findDevices, isGranted, UsbError, UsbHeldError, UsbPorts, type Api } from '../usb-live.ts';
import { deviceName, identityKey, identityOf as usbIdentity, usbLock } from '../usb-ports.ts';
import type { Messages } from '../run/messages.ts';
import { usbDetails } from '../run/messages.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { Run } from '../run/run.ts';
import { takeHeld } from './held.ts';
import { keys } from './keys.svelte.ts';
import type { UsbEntries } from './usb-entries.ts';
import { isKeyboard, padOf, type UsbView } from './usb-view.ts';
import { usb } from './usb.svelte.ts';

const KEYBOARD = { api: 'virtual', kind: 'keyboard' } as const;
export type Unplugged = { connector: number; device: UsbIdentity | UsbVirtual; entry?: string }[];

/** An attach's error for the message bar (`again`: an attach after a snapshot): a `UsbError` with problems names the device itself. */
export const attachFailed = (name: string, err: unknown, again = false): Said =>
  err instanceof UsbError && err.words.length
    ? { headline: text(err.msg), details: err.words.map((w) => w.text), from: [err.msg] }
    : usbDetails(
        again ? msg('usb:usb-attach.attachFailed.again', { name }) : msg('usb:usb-attach.attachFailed', { name }),
        err,
      );

export class UsbRun {
  readonly #m: PageMachine;
  readonly #messages: Messages;
  readonly #view: UsbView;
  readonly #entries: UsbEntries;
  /** The last device that was unplugged while attached (re-enumeration: the next new device takes its connector). */
  lastGone: { connector: number; api: Api; atStart: boolean; name: string; at: number } | undefined;
  #keyboardSync: Promise<void> = Promise.resolve();
  /** Re-plugs the device just gone, from its offer (web/app/areas/usb-actions.ts). */
  replug: (api: Api, o: { connector: number; atStart: boolean }) => Promise<void> = () => Promise.resolve();

  constructor(d: { machine: PageMachine; messages: Messages; view: UsbView; entries: UsbEntries }) {
    [this.#m, this.#messages, this.#view, this.#entries] = [d.machine, d.messages, d.view, d.entries];
  }

  /** It runs here with its controller: devices attach now. */
  running() {
    return usb.running;
  }

  /** A run's ports, followed by the area. */
  ports(port: MessagePort) {
    const p = new UsbPorts(port, this.#entries.locks);
    p.onChange = () => this.#view.refresh();
    p.onLeds = (c, l) => {
      if (c === KEYBOARD_CONNECTOR) keys.ledBits.usb = l;
    };
    p.onRumble = (c, strong, weak) => this.#view.pads.rumble(c, strong, weak);
    p.onGone = (connector, was, reason, error) => {
      if (reason === 'unplugged' && was.device.api !== 'virtual') {
        // It may come back as another device (a bootloader, after a firmware upload): the offer to attach that one there.
        const api = was.device.api;
        const entry = this.#entries.list().find((e) => e.id === was.entry);
        const gone = { connector, api, atStart: entry?.atStart ?? false, name: was.name, at: Date.now() };
        this.lastGone = gone;
        usb.offer({
          id: `gone-${connector}`,
          text: msg('usb:usb-attach.offer.gone', { name: was.name, connector: connector + 1 }),
          label: t('usb:usb-attach.offer.pick'),
          run: () => this.replug(api, gone),
        });
      } else if (error) {
        this.#messages.notify(usbDetails(msg('usb:usb-attach.detached', { name: was.name }), error), 'error');
      }
    };
    return p;
  }

  /** Attaches entry `e` on its connector; a device another machine holds is offered to be detached there first (`quiet`: skipped, with a note). */
  async attach(e: UsbEntry, o: { quiet?: boolean } = {}) {
    const p = this.#m.run?.usb;
    if (!p || !this.running()) throw new MsgError('usb:usb-actions.stopped');
    if (p.connectorOf(e.id) >= 0) return;
    const attach = () => p.attach(e.connector, usbIdentity(e), e.id);
    const name = deviceName(e);
    const locks = this.#entries.locks;
    let who: string | undefined;
    const confirm = async () => {
      who = await locks.holder(usbLock(e));
      if (o.quiet) {
        this.#messages.notify(
          who ? msg('usb:usb-attach.held.left', { name, who }) : msg('usb:usb-attach.held.left.unknown', { name }),
        );
        return false;
      }
      const question = who
        ? msg('usb:usb-attach.held.confirm', { name, who })
        : msg('usb:usb-attach.held.confirm.unknown', { name });
      return ask.confirm(question, { title: t('usb:usb-attach.held.title'), ok: t('usb:usb-attach.held.ok') });
    };
    await takeHeld(attach, UsbHeldError, confirm, async () => {
      if (!(await locks.takeFrom(usbLock(e))))
        throw who
          ? new MsgError('usb:usb-attach.held.kept', { name, who })
          : new MsgError('usb:usb-attach.held.kept.unknown', { name });
      await attach();
    });
  }

  /** Another tab wants the device of `lock`: it is detached here. */
  async letGo(lock: string) {
    const p = this.#m.run?.usb;
    const at = p?.connectors.findIndex((c) => c && c.device.api !== 'virtual' && usbLock(c.device) === lock) ?? -1;
    const c = p?.connectors[at];
    if (!p || !c) return this.#entries.locks.drop(lock);
    await p.detach(at).catch(() => undefined); // it goes either way: the other tab takes it
    this.#messages.notify(msg('usb:usb-attach.taken', { name: c.name }));
  }

  /** The screen's key for the built-in keyboard: false when it isn't plugged in (the serial console takes it then). */
  readonly keyboardKey = (code: string, down: boolean): boolean => {
    const p = this.#m.run?.usb;
    const c = p?.connectors[KEYBOARD_CONNECTOR];
    if (!p || !isKeyboard(c) || c?.state !== 'attached') return false;
    p.key(KEYBOARD_CONNECTOR, code, down);
    return true;
  };
  /** Plugs the built-in keyboard in or out, as the guest's virtio keyboard is live or not. */
  syncKeyboard(r: Run) {
    this.#keyboardSync = this.#keyboardSync.then(async () => {
      const p = r.usb;
      if (!p || !r.live() || !this.running()) return;
      const c = p.connectors[KEYBOARD_CONNECTOR];
      if (keys.live && isKeyboard(c))
        await p.detach(KEYBOARD_CONNECTOR).catch(() => undefined); // the guest has its own
      else if (!keys.live && !c)
        await p
          .attach(KEYBOARD_CONNECTOR, KEYBOARD)
          .catch((err: unknown) =>
            this.#messages.notify(usbDetails(msg('usb:usb-attach.keyboardFailed'), err), 'error'),
          );
    });
    return this.#keyboardSync;
  }

  /** At a start, a resume or a restore: the entries attached at start that are plugged in go on; those without a grant here are offered one. */
  async attachAtStart(r: Run, allow: (e: UsbEntry) => Promise<void>) {
    await this.syncKeyboard(r);
    const entries = this.#entries.list();
    const found = await findDevices(entries);
    for (const e of entries) {
      if (!r.live()) return;
      if (!found.has(e.id)) {
        if (!isGranted(identityKey(e)))
          usb.offer({
            id: `allow-${e.id}`,
            text: msg('usb:usb-attach.offer.ungranted', { name: deviceName(e) }),
            label: t('usb:usb-attach.offer.allow'),
            run: () => allow(e),
          });
        continue; // not plugged in: skipped without a word
      }
      if (!e.atStart) continue;
      await this.attach(e, { quiet: true }).catch((err: unknown) =>
        this.#messages.notify(usbDetails(msg('usb:usb-attach.attachFailed', { name: deviceName(e) }), err), 'error'),
      );
    }
    this.#view.refresh();
  }

  /**
   * Snapshot and Suspend need the ports empty (docs/usb.md "The page"): with devices attached it asks once, naming
   * them, and detaches them. Returns what was attached (to attach again after), or undefined when the user says no.
   */
  async emptyPorts(r: Run, what: 'snapshot' | 'suspend'): Promise<Unplugged | undefined> {
    const p = r.usb;
    if (!p) return [];
    // The built-in keyboard goes out and back in without a question (the firmware's keyboard; Linux has its own).
    const on = p.attached().filter((c) => !isKeyboard(c));
    if (!on.length) return p.detachAll();
    const names = on.map((c) => c.name);
    const count = names.length;
    const list =
      count === 1
        ? msg('usb:usb-attach.empty.one', { name: names[0] })
        : msg('usb:usb-attach.empty.list', { first: names.slice(0, -1), last: names.at(-1) });
    const question =
      what === 'suspend'
        ? msg('usb:usb-attach.empty.suspend', { count, list })
        : msg('usb:usb-attach.empty.snapshot', { count, list });
    if (!(await ask.confirm(question, { title: t('usb:usb-attach.empty.title'), ok: t('usb:usb-attach.empty.ok') })))
      return undefined;
    return p.detachAll();
  }
  /** Attaches again what `emptyPorts` detached (the machine runs on after a snapshot). */
  async plugBack(r: Run, was: Unplugged | undefined) {
    for (const c of was ?? []) {
      if (!r.live() || !this.running() || !r.usb) return;
      if (isKeyboard(c)) {
        await this.syncKeyboard(r);
        continue;
      }
      const pad = padOf(c);
      if (pad !== undefined && !listPads().some((x) => x.index === pad)) continue; // the host's pad left meanwhile
      await r.usb
        .attach(c.connector, c.device, c.entry)
        .catch((err: unknown) => this.#messages.notify(attachFailed(deviceName(c.device), err, true), 'error'));
    }
  }
}
