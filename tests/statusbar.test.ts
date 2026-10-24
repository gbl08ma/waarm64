// The status bar's elements (web/app/statusbar.ts; docs/frontend.md "The status bar"): the kept list checked, the
// defaults drawing today's bar, rates from two statuses, per-device elements and their disappearing, the graphics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ITEMS, graphics, metrics, nameOf, normalize, palette, render, shows, type Item, type Live, type Metrics } from '../web/app/statusbar.ts';
import type { Status } from '../web/app/protocol.ts';

const MiB = 2 ** 20;
const status = (o: Partial<Status> = {}): Status => ({
  ncpus: 2, ramMiB: 1024, uptime: 10_000, steps: 0, jitBlocks: 1234, jitFlushes: 0, jitCompileMs: 2500, jitSteps: 0, jitBytes: 0, irqs: 0,
  loopMaxMs: 0, loopAgeMs: 0, vcpus: [], stats: {} as Status['stats'],
  memory: { ramBytes: 0, heapLive: 0, heapPeak: 0, jitLiveBytes: 10 * MiB, jitModules: 0, jitBudget: 320 * MiB, jitEpochs: 0, jitLimit: 0, jitKeys: 0, jitKeyBytes: 0, jitHeld: 0 },
  disks: [{ read: 0, written: 0 }], nets: [{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }], cpus: [{ steps: 0, jitSteps: 0 }, { steps: 0, jitSteps: 0 }],
  ...o,
});
const live: Live = { state: 'running', stateText: 'Running', now: 0, mouseLock: true, mouseLocked: false, keyboardLocked: false, keysFocused: false, mic: 'idle', disks: ['root.qcow2'], nets: [{ name: 'Adapter 1', phase: 'connected', text: '' }, { name: 'Adapter 2', phase: 'off', text: '' }] };
/** Two statuses a second apart: 600 M steps (500 M of them in JIT code), 1000 IRQs, 2 MiB read, 1 MiB received on adapter 2. */
function second(): Metrics {
  const a = status();
  const b = status({
    uptime: 11_000, steps: 600e6, jitSteps: 500e6, irqs: 1000, disks: [{ read: 2 * MiB, written: 0 }], nets: [{ rx: 0, tx: 0 }, { rx: MiB, tx: 0 }],
    cpus: [{ steps: 400e6, jitSteps: 400e6 }, { steps: 200e6, jitSteps: 100e6 }],
  });
  const first = { status: a, at: 0, metrics: metrics(a, 0) };
  return metrics(b, 1000, first);
}
const text = (i: Item, m?: Metrics, l = live) => render(i, m, l).map((p) => p.text).join(' | ');

test('the defaults draw what the bar always showed', () => {
  const m = second();
  assert.equal(DEFAULT_ITEMS.filter((i) => i.kind !== 'divider').map((i) => text(i, m)).join(' · '), 'Running · 2 vCPUs · 1024 MiB · up 0:00:11 · 600 MIPS · 83.3% in JIT · 1,000 IRQ/s');
  assert.ok(shows(DEFAULT_ITEMS));
  assert.ok(!shows([{ kind: 'spacer' }, { kind: 'divider' }]), 'only layout: no bar');
});

test('a kept list: unknown kinds and fields dropped, scopes and indices checked, nothing kept: the defaults', () => {
  assert.deepEqual(normalize(undefined), DEFAULT_ITEMS);
  assert.deepEqual(normalize([]), []);
  assert.deepEqual(normalize([{ kind: 'nope' }, { kind: 'mips', scope: 'one', index: -1, look: 'icon' }, { kind: 'link', scope: 'all' }, { kind: 'mips', scope: 'each', numbers: true, look: 'text' }, 7]), [
    { kind: 'mips', scope: 'one', index: 0, look: 'icon' }, { kind: 'link', scope: 'each' }, { kind: 'mips', scope: 'each', numbers: true },
  ]);
});

test('rates need two statuses, and none across a new run', () => {
  const m = metrics(status(), 0);
  assert.equal(text({ kind: 'mips' }, m), '', 'no MIPS from one status');
  assert.equal(text({ kind: 'vcpus' }, m), '2 vCPUs');
  assert.equal(text({ kind: 'state' }, undefined), 'Running', 'the state needs no status');
  assert.equal(text({ kind: 'vcpus' }, undefined), '');
});

test('per vCPU: each as bars or numbers, one by its number, gone without per-vCPU counters', () => {
  const m = second();
  const bars = render({ kind: 'mips', scope: 'each' }, m, live)[0];
  assert.deepEqual(bars.bars, [1, 0.5]);
  assert.equal(text({ kind: 'jit', scope: 'each', numbers: true }, m), '100.0% 50.0% in JIT');
  assert.equal(text({ kind: 'mips', scope: 'one', index: 1 }, m), 'vCPU 1 200 MIPS');
  assert.equal(text({ kind: 'mips', scope: 'one', index: 2 }, m), '', 'no vCPU 2');
  assert.equal(text({ kind: 'mips', scope: 'each' }, { ...m, cpus: undefined }), '');
});

test('per disk and adapter: all summed, each, one from 1; gone when the machine hasn\'t it', () => {
  const m = second();
  assert.equal(text({ kind: 'diskrate', scope: 'all' }, m), 'disk R 2.0 MiB/s W 0 B/s');
  assert.equal(text({ kind: 'netrate', scope: 'each' }, m), 'Adapter 1 received 0 B/s, sent 0 B/s | Adapter 2 received 1.0 MiB/s, sent 0 B/s');
  assert.deepEqual(render({ kind: 'netrate', scope: 'one', index: 2 }, m, live)[0].parts!.map((p) => [p.icon, p.text]), [['arrow-down', '1.0 MiB/s'], ['arrow-up', '0 B/s']]);
  assert.equal(text({ kind: 'nettotal', scope: 'one', index: 3 }, m), '');
  assert.equal(text({ kind: 'disktotal', scope: 'one', index: 1 }, m), 'root.qcow2 R 2.0 MiB W 0 B');
  assert.equal(text({ kind: 'netrate', scope: 'all' }, { ...m, nets: undefined }), '', 'no network: no element');
  assert.equal(text({ kind: 'link', scope: 'each' }, m), 'Adapter 1 connected | Adapter 2 off');
});

test('states as tones: the mouse lock, where keys go, the microphone shown only while it records', () => {
  assert.equal(render({ kind: 'pointer' }, undefined, live)[0].tone, 'dim');
  assert.equal(render({ kind: 'pointer' }, undefined, { ...live, mouseLocked: true })[0].tone, 'ok');
  assert.equal(text({ kind: 'mic' }, undefined), '');
  assert.equal(text({ kind: 'keyboard' }, undefined), 'Click to type');
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true }), 'Typing to the machine');
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true, keyboardLocked: true }), 'Keys locked');
  assert.equal(render({ kind: 'mic' }, undefined, { ...live, mic: 'on' })[0].tone, 'bad');
});

test('graphics: the renderer, frames and video streams a second', () => {
  const report = (presents: number, decoded: number) => ({ renderer: 'SwiftShader', software: true, presents, video: { enabled: true, decoded, decoderErrors: 0, streams: [{ id: 3, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded }] } });
  const a = graphics('3d', report(100, 10), 0);
  const g = graphics('3d', report(160, 40), 1000, { g: a, at: 0 });
  const l = { ...live, gpu: g };
  assert.equal(text({ kind: 'gpu' }, undefined, l), '3D software');
  assert.equal(render({ kind: 'gpu' }, undefined, l)[0].tone, 'busy');
  assert.equal(text({ kind: 'fps' }, undefined, l), '60 fps');
  assert.equal(text({ kind: 'video' }, undefined, l), 'H.264 High hw 30 fps');
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: { ...g, video: { ...g.video!, streams: [] } } }), 'video idle');
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: graphics('canvas2d', { presents: 1 }, 0) }), '', '2D: no video');
});

test('the palette names one chip per kind and scope', () => {
  const names = palette().flatMap((g) => g.items.map((i) => nameOf(i, true)));
  assert.ok(names.includes('MIPS') && names.includes('MIPS, each vCPU') && names.includes('MIPS, one vCPU') && names.includes('Disk speed, one disk'));
  assert.equal(new Set(names).size, names.length);
  assert.equal(nameOf({ kind: 'netrate', scope: 'one', index: 2 }), 'Network traffic, adapter 2');
});
