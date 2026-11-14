// The status bar's elements (docs/frontend.md "The status bar"): what each can show and the bar a browser starts with.
// What an element draws is web/app/statusbar-render.ts's, from the last second's numbers (statusbar-metrics.ts) and the
// screen's (statusbar-graphics.ts). web/app/StatusBar.svelte draws the bar, and the Preferences' editor
// (web/app/StatusEditor.svelte) chooses and orders its elements, kept in the settings' `statusBar`. DOM-free, for
// tests/statusbar.test.ts.
import { msg, t } from '../i18n.ts';
import { def, KINDS, type Device, type Group, type Kind, type Look, type Scope } from './statusbar-kinds.ts';

/** One element of the bar. `index`: the device of a `one` element as the page numbers it (vCPUs from 0, as the guest
 * names them; adapters and disks from 1, as the machine's Network and Disks tabs list them). `numbers`: an `each`
 * vCPU element writes its numbers rather than drawing bars. */
export type Item = { kind: Kind; scope?: Scope; index?: number; look?: Look; numbers?: boolean };

/** Today's bar, and the one a browser starts with (the guest's OS shows where its agent names it). */
export const DEFAULT_ITEMS: readonly Item[] = [
  { kind: 'state' },
  { kind: 'divider' },
  { kind: 'os' },
  { kind: 'vcpus' },
  { kind: 'ram' },
  { kind: 'uptime' },
  { kind: 'mips' },
  { kind: 'jit' },
  { kind: 'irqs' },
];

const LOOKS: Look[] = ['text', 'icon', 'both'];
/** The kept list as the page uses it: unknown kinds and fields dropped (another version's), each field checked. */
export function normalize(kept: unknown): Item[] {
  if (!Array.isArray(kept)) return DEFAULT_ITEMS.map((i) => ({ ...i }));
  return kept.flatMap((k: unknown) => itemOf(k) ?? []);
}
const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.hasOwn(KINDS, k);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const oneOf = <T>(v: unknown, list: readonly T[]): v is T => (list as readonly unknown[]).includes(v);
/** One kept element, its fields checked; none for another version's kind. */
function itemOf(k: unknown): Item | undefined {
  if (typeof k !== 'object' || k === null) return undefined;
  const kept = k as Record<string, unknown>;
  if (!isKind(kept.kind)) return undefined;
  const d = def(kept.kind);
  const item: Item = { kind: kept.kind };
  if (d.scopes) item.scope = oneOf(kept.scope, d.scopes) ? kept.scope : d.scopes[0];
  if (item.scope === 'one') item.index = isIndex(kept.index) ? kept.index : firstIndex(d.device);
  if (oneOf(kept.look, LOOKS) && kept.look !== d.look && hasLooks(kept.kind)) item.look = kept.look;
  if (kept.numbers === true && d.device === 'cpu' && item.scope === 'each') item.numbers = true;
  return item;
}
/** The first device's number: vCPU 0, adapter or disk 1. */
export const firstIndex = (d: Device | undefined) => (d === 'cpu' ? 0 : 1);
/** Whether the element's look can be chosen (the layout's elements have none). */
export const hasLooks = (k: Kind) => k !== 'spacer' && k !== 'divider';
export const lookOf = (i: Item): Look => i.look ?? def(i.kind).look;
/** What the device of a kind is called, for the editor. */
export const deviceOf = (k: Kind) => def(k).device;
export const scopesOf = (k: Kind) => def(k).scopes;
/** The names of a per-device element: `{{name}}` is the kind's, `{{index}}` the device's number. */
const SCOPED = {
  each: {
    cpu: 'statusbar:statusbar.name.each.cpu',
    net: 'statusbar:statusbar.name.each.net',
    disk: 'statusbar:statusbar.name.each.disk',
  },
  any: {
    cpu: 'statusbar:statusbar.name.any.cpu',
    net: 'statusbar:statusbar.name.any.net',
    disk: 'statusbar:statusbar.name.any.disk',
  },
  one: {
    cpu: 'statusbar:statusbar.name.one.cpu',
    net: 'statusbar:statusbar.name.one.net',
    disk: 'statusbar:statusbar.name.one.disk',
  },
} as const;

/** An element's name in the editor and its tooltips: `MIPS`, `MIPS, each vCPU`, `MIPS, vCPU 2` (`generic`, the palette's: `MIPS, one vCPU`). */
export function nameOf(i: Item, generic = false) {
  const d = def(i.kind);
  const name = msg(d.name);
  if (!d.device || !i.scope || (i.scope === 'all' && d.scopes?.[0] === 'all')) return t(d.name);
  if (i.scope === 'each') return t(SCOPED.each[d.device], { name });
  if (i.scope === 'one')
    return generic
      ? t(SCOPED.any[d.device], { name })
      : t(SCOPED.one[d.device], { name, index: i.index ?? firstIndex(d.device) });
  return t(d.name);
}
/** The palette's chips: every kind in each of its scopes (a `one` chip adds the first device: its number is set after). */
export function palette(): { group: Group; items: Item[] }[] {
  const groups = new Map<Group, Item[]>();
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const d = def(kind);
    const items = d.scopes
      ? d.scopes.map((scope): Item =>
          scope === 'one' ? { kind, scope, index: firstIndex(d.device) } : { kind, scope },
        )
      : [{ kind }];
    groups.set(d.group, [...(groups.get(d.group) ?? []), ...items]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
export const aboutOf = (k: Kind) => t(def(k).about);
export const iconOf = (k: Kind) => def(k).icon;

/** Whether a kept list shows anything (none: the bar goes away). */
export const shows = (items: readonly Item[]) => items.some((i) => i.kind !== 'spacer' && i.kind !== 'divider');
