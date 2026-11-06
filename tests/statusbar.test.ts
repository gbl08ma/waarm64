// The status bar's elements (web/app/statusbar.ts; docs/frontend.md "The status bar"): the kept list checked, the
// defaults drawing today's bar, rates from two statuses, per-device elements and their disappearing, the graphics.
// The words expected are the catalog's (docs/i18n.md "Tests").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ITEMS, graphics, metrics, nameOf, normalize, palette, render, shows, type Item, type Live, type Metrics } from '../web/app/statusbar.ts';
import type { Status } from '../web/app/protocol.ts';
import { msg, t } from '../web/i18n.ts';

const MiB = 2 ** 20;
const RUNNING = t('machine:main.state.running');
const status = (o: Partial<Status> = {}): Status => ({
  ncpus: 2, ramMiB: 1024, uptime: 10_000, steps: 0, jitBlocks: 1234, jitFlushes: 0, jitCompileMs: 2500, jitSteps: 0, jitBytes: 0, irqs: 0,
  loopMaxMs: 0, loopAgeMs: 0, vcpus: [], stats: {} as Status['stats'],
  memory: { ramBytes: 0, heapLive: 0, heapPeak: 0, jitLiveBytes: 10 * MiB, jitModules: 0, jitBudget: 320 * MiB, jitEpochs: 0, jitLimit: 0, jitKeys: 0, jitKeyBytes: 0, jitHeld: 0 },
  disks: [{ read: 0, written: 0 }], nets: [{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }], cpus: [{ steps: 0, jitSteps: 0 }, { steps: 0, jitSteps: 0 }],
  ...o,
});
const live: Live = { state: 'running', stateText: RUNNING, now: 0, mouseLock: true, mouseLocked: false, keyboardLocked: false, keysFocused: false, mic: 'idle', disks: ['root.qcow2'], nets: [{ name: 'Adapter 1', phase: 'connected', text: '' }, { name: 'Adapter 2', phase: 'off', text: '' }] };
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
const mips = (value: string) => t('statusbar:statusbar.cpu.mips', { value });
const inJit = (value: string) => t('statusbar:statusbar.cpu.jit', { value });
const net = (rx: string, tx: string) => t('statusbar:statusbar.net.traffic', { rx, tx });
const disk = (read: string, written: string) => t('statusbar:statusbar.disk.traffic', { read, written });

test('the defaults draw what the bar always showed', () => {
  const m = second();
  assert.equal(DEFAULT_ITEMS.filter((i) => i.kind !== 'divider').map((i) => text(i, m)).join(' · '), [
    RUNNING, t('statusbar:statusbar.vcpus', { count: 2 }), '1024 MiB', t('statusbar:statusbar.uptime', { time: '0:00:11' }), mips('600'), inJit('83.3%'), t('statusbar:statusbar.irqs', { irqs: '1,000' }),
  ].join(' · '));
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
  assert.equal(text({ kind: 'vcpus' }, m), t('statusbar:statusbar.vcpus', { count: 2 }));
  assert.equal(text({ kind: 'state' }, undefined), RUNNING, 'the state needs no status');
  assert.equal(text({ kind: 'vcpus' }, undefined), '');
});

test('per vCPU: each as bars or numbers, one by its number, gone without per-vCPU counters', () => {
  const m = second();
  const bars = render({ kind: 'mips', scope: 'each' }, m, live)[0];
  assert.deepEqual(bars.bars, [1, 0.5]);
  assert.equal(text({ kind: 'jit', scope: 'each', numbers: true }, m), inJit('100.0% 50.0%'));
  assert.equal(text({ kind: 'mips', scope: 'one', index: 1 }, m), t('statusbar:statusbar.cpu.one', { vcpu: 1, value: mips('200') }));
  assert.equal(text({ kind: 'mips', scope: 'one', index: 2 }, m), '', 'no vCPU 2');
  assert.equal(text({ kind: 'mips', scope: 'each' }, { ...m, cpus: undefined }), '');
});

test('per disk and adapter: all summed, each, one from 1; gone when the machine hasn\'t it', () => {
  const m = second();
  assert.equal(text({ kind: 'diskrate', scope: 'all' }, m), t('statusbar:statusbar.disk.all', { traffic: disk('2.0 MiB/s', '0 B/s') }));
  assert.equal(text({ kind: 'netrate', scope: 'each' }, m), [
    t('statusbar:statusbar.net.one', { name: 'Adapter 1', traffic: net('0 B/s', '0 B/s') }), t('statusbar:statusbar.net.one', { name: 'Adapter 2', traffic: net('1.0 MiB/s', '0 B/s') }),
  ].join(' | '));
  assert.deepEqual(render({ kind: 'netrate', scope: 'one', index: 2 }, m, live)[0].parts!.map((p) => [p.icon, p.text]), [['arrow-down', '1.0 MiB/s'], ['arrow-up', '0 B/s']]);
  assert.equal(text({ kind: 'nettotal', scope: 'one', index: 3 }, m), '');
  assert.equal(text({ kind: 'disktotal', scope: 'one', index: 1 }, m), t('statusbar:statusbar.disk.one', { name: 'root.qcow2', traffic: disk('2.0 MiB', '0 B') }));
  assert.equal(text({ kind: 'netrate', scope: 'all' }, { ...m, nets: undefined }), '', 'no network: no element');
  assert.equal(text({ kind: 'link', scope: 'each' }, m), `${t('statusbar:statusbar.link.connected', { name: 'Adapter 1' })} | ${t('statusbar:statusbar.link.off', { name: 'Adapter 2' })}`);
});

test('states as tones: the mouse lock, where keys go, the microphone shown only while it records', () => {
  assert.equal(render({ kind: 'pointer' }, undefined, live)[0].tone, 'dim');
  assert.equal(render({ kind: 'pointer' }, undefined, { ...live, mouseLocked: true })[0].tone, 'ok');
  assert.equal(text({ kind: 'mic' }, undefined), '');
  assert.equal(text({ kind: 'keyboard' }, undefined), t('statusbar:statusbar.keyboard.click'));
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true }), t('statusbar:statusbar.keyboard.typing'));
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true, keyboardLocked: true }), t('statusbar:statusbar.keyboard.locked'));
  assert.equal(render({ kind: 'mic' }, undefined, { ...live, mic: 'on' })[0].tone, 'bad');
});

test('graphics: the renderer, frames and video streams a second', () => {
  const report = (presents: number, decoded: number) => ({ renderer: 'SwiftShader', software: true, presents, video: { enabled: true, decoded, decoderErrors: 0, streams: [{ id: 3, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded }] } });
  const a = graphics('3d', report(100, 10), 0);
  const g = graphics('3d', report(160, 40), 1000, { g: a, at: 0 });
  const l = { ...live, gpu: g };
  assert.equal(text({ kind: 'gpu' }, undefined, l), t('statusbar:statusbar.gpu.software.3d'));
  assert.equal(render({ kind: 'gpu' }, undefined, l)[0].tone, 'busy');
  assert.equal(text({ kind: 'fps' }, undefined, l), t('statusbar:statusbar.fps', { fps: '60' }));
  assert.equal(text({ kind: 'video' }, undefined, l), t('statusbar:statusbar.video.hw.fps', { codecs: 'H.264 High', fps: '30' }));
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: { ...g, video: { ...g.video!, streams: [] } } }), t('statusbar:statusbar.video.idle'));
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: graphics('canvas2d', { presents: 1 }, 0) }), '', '2D: no video');
});

test('vulkan: the guest\'s programs using Venus and their submits a second, idle, or no WebGPU', () => {
  const report = (contexts: number, submits: number, draws: number, more = {}) => ({ presents: 0, vulkan: { contexts, submits, draws, device: true, adapter: 'apple metal-3', software: false, ...more } });
  const a = graphics('3d', report(2, 100, 1000), 0);
  const g = graphics('3d', report(2, 160, 1840), 1000, { g: a, at: 0 });
  const l = { ...live, gpu: g };
  assert.equal(text({ kind: 'vulkan' }, undefined, l), t('statusbar:statusbar.vulkan.programs.rate', { count: 2, submits: '60' }));
  const [p] = render({ kind: 'vulkan' }, undefined, l);
  assert.equal(p.tone, 'ok');
  assert.equal(p.title, [t('statusbar:statusbar.vulkan.title', { count: 2 }), t('statusbar:statusbar.vulkan.rates', { submits: '60', draws: '840' }), t('statusbar:statusbar.vulkan.adapter', { adapter: 'apple metal-3' })].join('\n'));
  // The first report has no rates yet; no program; no device; software underneath; no Vulkan at all.
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: a }), t('statusbar:statusbar.vulkan.programs', { count: 2 }));
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(0, 160, 1840), 0) }), t('statusbar:statusbar.vulkan.idle'));
  assert.equal(render({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(0, 0, 0, { device: false }), 0) })[0].tone, 'bad');
  assert.equal(render({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(1, 160, 1840, { software: true }), 1000, { g: a, at: 0 }) })[0].tone, 'busy');
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', { presents: 0 }, 0) }), '', 'no Vulkan: nothing');
});

test('the palette names one chip per kind and scope', () => {
  const names = palette().flatMap((g) => g.items.map((i) => nameOf(i, true)));
  const name = (k: string) => msg(k);
  const want = [
    t('statusbar:statusbar.kind.mips'), t('statusbar:statusbar.name.each.cpu', { name: name('statusbar:statusbar.kind.mips') }),
    t('statusbar:statusbar.name.any.cpu', { name: name('statusbar:statusbar.kind.mips') }), t('statusbar:statusbar.name.any.disk', { name: name('statusbar:statusbar.kind.diskrate') }),
  ];
  for (const w of want) assert.ok(names.includes(w), w);
  assert.equal(new Set(names).size, names.length);
  assert.equal(nameOf({ kind: 'netrate', scope: 'one', index: 2 }), t('statusbar:statusbar.name.one.net', { name: name('statusbar:statusbar.kind.netrate'), index: 2 }));
});
