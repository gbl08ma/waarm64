// The status bar's elements (web/app/statusbar.ts, statusbar-*.ts; docs/frontend.md "The status bar"): the kept list checked, the
// defaults drawing today's bar, rates from two statuses, per-device elements and their disappearing, the graphics.
// The words expected are the catalog's (docs/i18n.md "Tests").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ITEMS, nameOf, normalize, palette, shows, type Item } from '../web/app/statusbar.ts';
import { graphics } from '../web/app/statusbar-graphics.ts';
import { metrics, type Metrics } from '../web/app/statusbar-metrics.ts';
import type { Live } from '../web/app/statusbar-piece.ts';
import { render } from '../web/app/statusbar-render.ts';
import type { Status } from '../web/app/protocol.ts';
import { msg, t } from '../web/i18n.ts';

const MiB = 2 ** 20;
const RUNNING = t('machine:messages.state.running');
const status = (o: Partial<Status> = {}): Status => ({
  ncpus: 2, ramMiB: 1024, uptime: 10_000, steps: 0, jitBlocks: 1234, jitFlushes: 0, jitCompileMs: 2500, jitSteps: 0, jitBytes: 0, irqs: 0, tlbMisses: 0, tlbFlushes: 0,
  loopMaxMs: 0, loopAgeMs: 0, vcpus: [], stats: {} as Status['stats'],
  memory: { ramBytes: 0, heapLive: 0, heapPeak: 0, jitLiveBytes: 10 * MiB, jitModules: 0, jitBudget: 320 * MiB, jitEpochs: 0, jitLimit: 0, jitKeys: 0, jitKeyBytes: 0, jitHeld: 0 }, estimateBytes: 0, peakBytes: 0,
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
const mips = (value: string) => t('statusbar:statusbar-render.cpu.mips', { value });
const inJit = (value: string) => t('statusbar:statusbar-render.cpu.jit', { value });
const net = (rx: string, tx: string) => t('statusbar:statusbar-traffic.net.traffic', { rx, tx });
const disk = (read: string, written: string) => t('statusbar:statusbar-traffic.disk.traffic', { read, written });

test('the defaults draw what the bar always showed, and the guest\'s OS once its agent names it', () => {
  const m = second();
  assert.equal(DEFAULT_ITEMS.filter((i) => i.kind !== 'divider').map((i) => text(i, m, { ...live, os: 'Debian GNU/Linux 13 (trixie)' })).join(' · '), [
    RUNNING, 'Debian GNU/Linux 13 (trixie)', t('statusbar:statusbar-render.vcpus', { count: 2 }), '1024 MiB', t('statusbar:statusbar-render.uptime', { time: '0:00:11' }), mips('600'), inJit('83.3%'), t('statusbar:statusbar-render.irqs', { irqs: '1,000' }),
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
  assert.equal(text({ kind: 'vcpus' }, m), t('statusbar:statusbar-render.vcpus', { count: 2 }));
  assert.equal(text({ kind: 'state' }, undefined), RUNNING, 'the state needs no status');
  assert.equal(text({ kind: 'vcpus' }, undefined), '');
});

test('per vCPU: each as bars or numbers, one by its number, gone without per-vCPU counters', () => {
  const m = second();
  const bars = render({ kind: 'mips', scope: 'each' }, m, live)[0];
  assert.deepEqual(bars.bars, [1, 0.5]);
  assert.equal(text({ kind: 'jit', scope: 'each', numbers: true }, m), inJit('100.0% 50.0%'));
  assert.equal(text({ kind: 'mips', scope: 'one', index: 1 }, m), t('statusbar:statusbar-render.cpu.one', { vcpu: 1, value: mips('200') }));
  assert.equal(text({ kind: 'mips', scope: 'one', index: 2 }, m), '', 'no vCPU 2');
  assert.equal(text({ kind: 'mips', scope: 'each' }, { ...m, cpus: undefined }), '');
});

test('per disk and adapter: all summed, each, one from 1; gone when the machine hasn\'t it', () => {
  const m = second();
  assert.equal(text({ kind: 'diskrate', scope: 'all' }, m), t('statusbar:statusbar-traffic.disk.all', { traffic: disk('2.0 MiB/s', '0 B/s') }));
  assert.equal(text({ kind: 'netrate', scope: 'each' }, m), [
    t('statusbar:statusbar-traffic.net.one', { name: 'Adapter 1', traffic: net('0 B/s', '0 B/s') }), t('statusbar:statusbar-traffic.net.one', { name: 'Adapter 2', traffic: net('1.0 MiB/s', '0 B/s') }),
  ].join(' | '));
  assert.deepEqual(render({ kind: 'netrate', scope: 'one', index: 2 }, m, live)[0].parts!.map((p) => [p.icon, p.text]), [['arrow-down', '1.0 MiB/s'], ['arrow-up', '0 B/s']]);
  assert.equal(text({ kind: 'nettotal', scope: 'one', index: 3 }, m), '');
  assert.equal(text({ kind: 'disktotal', scope: 'one', index: 1 }, m), t('statusbar:statusbar-traffic.disk.one', { name: 'root.qcow2', traffic: disk('2.0 MiB', '0 B') }));
  assert.equal(text({ kind: 'netrate', scope: 'all' }, { ...m, nets: undefined }), '', 'no network: no element');
  assert.equal(text({ kind: 'link', scope: 'each' }, m), `${t('statusbar:statusbar-render.link.connected', { name: 'Adapter 1' })} | ${t('statusbar:statusbar-render.link.off', { name: 'Adapter 2' })}`);
});

test('USB: its devices together, in and out a second and since the start; gone without a USB controller', () => {
  const a = status({ usb: { in: MiB, out: 0 } });
  const b = status({ uptime: 11_000, usb: { in: 3 * MiB, out: 512 } });
  const m = metrics(b, 1000, { status: a, at: 0, metrics: metrics(a, 0) });
  const usb = (into: string, out: string) => t('statusbar:statusbar-traffic.usb', { traffic: t('statusbar:statusbar-traffic.usb.traffic', { in: into, out }) });
  assert.equal(text({ kind: 'usbrate' }, m), usb('2.0 MiB/s', '512 B/s'));
  assert.equal(text({ kind: 'usbtotal' }, m), usb('3.0 MiB', '512 B'));
  assert.deepEqual(render({ kind: 'usbrate' }, m, live)[0].parts!.map((p) => [p.icon, p.text]), [['arrow-down', '2.0 MiB/s'], ['arrow-up', '512 B/s']]);
  assert.equal(text({ kind: 'usbrate' }, metrics(a, 0)), usb('…', '…'), 'the first status: no rate yet');
  assert.equal(text({ kind: 'usbtotal' }, second()), '', 'no USB controller: no element');
});

test('states as tones: the mouse lock, where keys go, the microphone shown only while it records', () => {
  assert.equal(render({ kind: 'pointer' }, undefined, live)[0].tone, 'dim');
  assert.equal(render({ kind: 'pointer' }, undefined, { ...live, mouseLocked: true })[0].tone, 'ok');
  assert.equal(text({ kind: 'mic' }, undefined), '');
  assert.equal(text({ kind: 'keyboard' }, undefined), t('statusbar:statusbar-render.keyboard.click'));
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true }), t('statusbar:statusbar-render.keyboard.typing'));
  assert.equal(text({ kind: 'keyboard' }, undefined, { ...live, keysFocused: true, keyboardLocked: true }), t('statusbar:statusbar-render.keyboard.locked'));
  assert.equal(render({ kind: 'mic' }, undefined, { ...live, mic: 'on' })[0].tone, 'bad');
});

test('graphics: the renderer, frames and video streams a second', () => {
  const report = (presents: number, decoded: number) => ({ renderer: 'SwiftShader', software: true, presents, video: { enabled: true, decoded, decoderErrors: 0, streams: [{ id: 3, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded }] } });
  const a = graphics('3d', report(100, 10), 0);
  const g = graphics('3d', report(160, 40), 1000, { g: a, at: 0 });
  const l = { ...live, gpu: g };
  assert.equal(text({ kind: 'gpu' }, undefined, l), t('statusbar:statusbar-graphics.gpu.software.3d'));
  assert.equal(render({ kind: 'gpu' }, undefined, l)[0].tone, 'busy');
  assert.equal(text({ kind: 'fps' }, undefined, l), t('statusbar:statusbar-graphics.fps', { fps: '60' }));
  assert.equal(text({ kind: 'video' }, undefined, l), t('statusbar:statusbar-graphics.video.hw.fps', { codecs: 'H.264 High', fps: '30' }));
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: { ...g, video: { ...g.video!, streams: [] } } }), t('statusbar:statusbar-graphics.video.idle'));
  assert.equal(text({ kind: 'video' }, undefined, { ...l, gpu: graphics('canvas2d', { presents: 1 }, 0) }), '', '2D: no video');
  // A machine without virtio-gpu: its simple framebuffer's draws.
  const fb = graphics('framebuffer', { presents: 30 }, 1000, { g: graphics('framebuffer', { presents: 5 }, 0), at: 0 });
  assert.equal(text({ kind: 'gpu' }, undefined, { ...live, gpu: fb }), t('statusbar:statusbar-graphics.gpu.framebuffer'));
  assert.equal(text({ kind: 'fps' }, undefined, { ...live, gpu: fb }), t('statusbar:statusbar-graphics.fps', { fps: '25' }));
});

test('vulkan: the guest\'s programs using Venus and their submits a second, idle, or no WebGPU', () => {
  const report = (contexts: number, submits: number, draws: number, more = {}) => ({ presents: 0, vulkan: { contexts, submits, draws, device: true, adapter: 'apple metal-3', software: false, ...more } });
  const a = graphics('3d', report(2, 100, 1000), 0);
  const g = graphics('3d', report(2, 160, 1840), 1000, { g: a, at: 0 });
  const l = { ...live, gpu: g };
  assert.equal(text({ kind: 'vulkan' }, undefined, l), t('statusbar:statusbar-graphics.vulkan.programs.rate', { count: 2, submits: '60' }));
  const [p] = render({ kind: 'vulkan' }, undefined, l);
  assert.equal(p.tone, 'ok');
  assert.equal(p.title, [t('statusbar:statusbar-graphics.vulkan.title', { count: 2 }), t('statusbar:statusbar-graphics.vulkan.rates', { submits: '60', draws: '840' }), t('statusbar:statusbar-graphics.vulkan.adapter', { adapter: 'apple metal-3' })].join('\n'));
  // The first report has no rates yet; no program; no device; software underneath; no Vulkan at all.
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: a }), t('statusbar:statusbar-graphics.vulkan.programs', { count: 2 }));
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(0, 160, 1840), 0) }), t('statusbar:statusbar-graphics.vulkan.idle'));
  assert.equal(render({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(0, 0, 0, { device: false }), 0) })[0].tone, 'bad');
  assert.equal(render({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', report(1, 160, 1840, { software: true }), 1000, { g: a, at: 0 }) })[0].tone, 'busy');
  assert.equal(text({ kind: 'vulkan' }, undefined, { ...live, gpu: graphics('3d', { presents: 0 }, 0) }), '', 'no Vulkan: nothing');
});

test('the palette names one chip per kind and scope', () => {
  const names = palette().flatMap((g) => g.items.map((i) => nameOf(i, true)));
  const name = (k: string) => msg(k);
  const want = [
    t('statusbar:statusbar-kinds.kind.mips'), t('statusbar:statusbar.name.each.cpu', { name: name('statusbar:statusbar-kinds.kind.mips') }),
    t('statusbar:statusbar.name.any.cpu', { name: name('statusbar:statusbar-kinds.kind.mips') }), t('statusbar:statusbar.name.any.disk', { name: name('statusbar:statusbar-kinds.kind.diskrate') }),
  ];
  for (const w of want) assert.ok(names.includes(w), w);
  assert.equal(new Set(names).size, names.length);
  assert.equal(nameOf({ kind: 'netrate', scope: 'one', index: 2 }), t('statusbar:statusbar.name.one.net', { name: name('statusbar:statusbar-kinds.kind.netrate'), index: 2 }));
});

test('the TLB: misses and flushes a second, from two statuses; nothing from one', () => {
  const a = status({ tlbMisses: 1_000, tlbFlushes: 10 });
  const b = status({ uptime: 12_000, tlbMisses: 401_000, tlbFlushes: 110 });
  assert.equal(text({ kind: 'tlb' }, metrics(a, 0)), '');
  const m = metrics(b, 2000, { status: a, at: 0, metrics: metrics(a, 0) });
  assert.deepEqual([m.tlbMisses, m.tlbFlushes], [200_000, 50]);
  assert.equal(text({ kind: 'tlb' }, m), t('statusbar:statusbar-mmu.tlb', { misses: '200,000', flushes: '50', count: 50 }));
  assert.deepEqual(normalize([{ kind: 'tlb', look: 'icon' }]), [{ kind: 'tlb', look: 'icon' }]);
});
