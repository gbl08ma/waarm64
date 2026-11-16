// The made-up machine the Preferences' status bar preview draws while no machine runs (web/app/StatusEditor.svelte).
import { t } from '../i18n.ts';
import type { Graphics } from './statusbar-graphics.ts';
import type { Metrics } from './statusbar-metrics.ts';
import { adapterName, type Live } from './statusbar-piece.ts';

/** What the Preferences' preview draws while no machine runs: a made-up machine with 4 vCPUs, 2 disks, 2 adapters and a USB controller. */
export const SAMPLE: { metrics: Metrics; disks: string[]; nets: Live['nets']; gpu: Graphics } = {
  metrics: {
    ncpus: 4,
    ramMiB: 4096,
    uptimeMs: 754_000,
    mips: 812,
    jit: 98.7,
    irqs: 2140,
    tlbMisses: 184_300,
    tlbFlushes: 46,
    blocks: 48_213,
    flushes: 0,
    compileMs: 9300,
    cpus: [
      { mips: 310, jit: 99.1 },
      { mips: 254, jit: 98.8 },
      { mips: 172, jit: 97.9 },
      { mips: 76, jit: 96.2 },
    ],
    cpuPeak: 400,
    jitLive: 61 * 2 ** 20,
    jitBudget: 320 * 2 ** 20,
    tabBytes: 6.2 * 2 ** 30,
    disks: [
      { read: 812 * 2 ** 20, written: 96 * 2 ** 20, readRate: 3.1 * 2 ** 20, writeRate: 48 * 2 ** 10 },
      { read: 4 * 2 ** 20, written: 0, readRate: 0, writeRate: 0 },
    ],
    nets: [
      { rx: 210 * 2 ** 20, tx: 12 * 2 ** 20, rxRate: 1.4 * 2 ** 20, txRate: 31 * 2 ** 10 },
      { rx: 2 * 2 ** 20, tx: 1 * 2 ** 20, rxRate: 512, txRate: 300 },
    ],
    usb: { in: 38 * 2 ** 20, out: 2 * 2 ** 20, inRate: 640 * 2 ** 10, outRate: 12 * 2 ** 10 },
  },
  disks: ['debian.qcow2', 'data.img'], // i18n-ignore: file names
  nets: [
    { name: adapterName(1), phase: 'connected', text: t('statusbar:statusbar-sample.sample.net1') },
    { name: adapterName(2), phase: 'off', text: t('statusbar:statusbar-sample.sample.net2') },
  ],
  gpu: {
    mode: '3d',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)',
    software: false,
    presents: 0,
    fps: 60,
    video: {
      enabled: true,
      decoded: 0,
      fps: 30,
      decoderErrors: 0,
      streams: [
        { id: 1, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded: 0, fps: 30 },
      ],
    },
    vulkan: {
      contexts: 2,
      submits: 0,
      draws: 0,
      device: true,
      adapter: 'apple metal-3',
      software: false,
      submitRate: 60,
      drawRate: 840,
    },
  },
};
