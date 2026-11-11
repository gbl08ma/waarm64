// The status bar's traffic (docs/frontend.md "The status bar"): what the network's, the disks' and USB's elements draw,
// rates a second or totals, all devices summed, each, or one. DOM-free, for tests/statusbar.test.ts.
import { t } from '../i18n.ts';
import type { IconName } from './icons.ts';
import type { Item } from './statusbar.ts';
import type { Metrics } from './statusbar-metrics.ts';
import {
  adapterName,
  amount,
  devices,
  perSec,
  piece,
  size,
  sumOf,
  type Live,
  type Part,
  type Piece,
} from './statusbar-piece.ts';

type Net = NonNullable<Metrics['nets']>[number];
type Disk = NonNullable<Metrics['disks']>[number];

/** Received and sent, each with its arrow. */
const arrows = (rx: string, tx: string): Part[] => [
  { icon: 'arrow-down', text: rx },
  { icon: 'arrow-up', text: tx },
];

/** An adapter's (or all adapters') traffic: totals (`nettotal`) or rates. */
export function netPieces(i: Item, icon: IconName | undefined, m: Metrics, live: Live): Piece[] {
  const total = i.kind === 'nettotal';
  const say = (n: number | undefined) => (total ? amount(n) : perSec(n));
  const show = (rx: number | undefined, tx: number | undefined) =>
    t('statusbar:statusbar-traffic.net.traffic', { rx: say(rx), tx: say(tx) });
  const ds = devices(i, m.nets);
  if (!ds) {
    const nets = m.nets;
    if (!nets?.length) return [];
    const sum = (f: (n: Net) => number | undefined) => sumOf(nets, f);
    const [rx, tx] = total ? [sum((n) => n.rx), sum((n) => n.tx)] : [sum((n) => n.rxRate), sum((n) => n.txRate)];
    const traffic = show(rx, tx);
    return piece(
      icon,
      t('statusbar:statusbar-traffic.net.all', { traffic }),
      traffic,
      total
        ? t('statusbar:statusbar-traffic.net.all.total.title')
        : t('statusbar:statusbar-traffic.net.all.rate.title'),
      { label: t('statusbar:statusbar-traffic.net.all.label'), parts: arrows(say(rx), say(tx)) },
    );
  }
  return ds.map(({ at, v }) => {
    const name = live.nets[at]?.name ?? adapterName(at + 1);
    const [rx, tx] = total ? [v.rx, v.tx] : [v.rxRate, v.txRate];
    const traffic = show(rx, tx);
    return {
      text: t('statusbar:statusbar-traffic.net.one', { name, traffic }),
      short: traffic,
      icon,
      title: total
        ? t('statusbar:statusbar-traffic.net.one.total.title', { name })
        : t('statusbar:statusbar-traffic.net.one.rate.title', { name }),
      label: name,
      parts: arrows(say(rx), say(tx)),
    };
  });
}

/** A disk's (or all disks') traffic: totals (`disktotal`) or rates. */
export function diskPieces(i: Item, icon: IconName | undefined, m: Metrics, live: Live): Piece[] {
  const total = i.kind === 'disktotal';
  const say = (n: number | undefined) => (total ? amount(n) : perSec(n));
  const show = (r: number | undefined, w: number | undefined) =>
    t('statusbar:statusbar-traffic.disk.traffic', { read: say(r), written: say(w) });
  const ds = devices(i, m.disks);
  if (!ds) {
    const disks = m.disks;
    if (!disks?.length) return [];
    const sum = (f: (n: Disk) => number | undefined) => sumOf(disks, f);
    const traffic = total
      ? show(
          sum((n) => n.read),
          sum((n) => n.written),
        )
      : show(
          sum((n) => n.readRate),
          sum((n) => n.writeRate),
        );
    return piece(
      icon,
      t('statusbar:statusbar-traffic.disk.all', { traffic }),
      traffic,
      total
        ? t('statusbar:statusbar-traffic.disk.all.total.title')
        : t('statusbar:statusbar-traffic.disk.all.rate.title'),
    );
  }
  return ds.map(({ at, v }) => {
    const name = live.disks[at] ?? t('statusbar:statusbar-traffic.disk.name', { number: at + 1 });
    const traffic = total ? show(v.read, v.written) : show(v.readRate, v.writeRate);
    return {
      text: t('statusbar:statusbar-traffic.disk.one', { name, traffic }),
      short: traffic,
      icon,
      title: total
        ? t('statusbar:statusbar-traffic.disk.one.total.title', { name })
        : t('statusbar:statusbar-traffic.disk.one.rate.title', { name }),
    };
  });
}

/** The USB devices' traffic, all together: totals (`usbtotal`) or rates. */
export function usbPieces(i: Item, icon: IconName | undefined, m: Metrics): Piece[] {
  const u = m.usb;
  if (!u) return [];
  const total = i.kind === 'usbtotal';
  const [into, out] = total ? [size(u.in), size(u.out)] : [perSec(u.inRate), perSec(u.outRate)];
  const traffic = t('statusbar:statusbar-traffic.usb.traffic', { in: into, out });
  return piece(
    icon,
    t('statusbar:statusbar-traffic.usb', { traffic }),
    traffic,
    total ? t('statusbar:statusbar-traffic.usb.total.title') : t('statusbar:statusbar-traffic.usb.rate.title'),
    { label: t('statusbar:statusbar-traffic.usb.label'), parts: arrows(into, out) },
  );
}
