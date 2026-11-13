// Disk I/O on a chosen disk: a `File` the user picked, read with FileReaderSync, under an OPFS overlay
// (web/devices.ts `blobSource`, web/overlay.ts), as the page's "Open disk…" makes it (M8 track IOSPEED, loop 0).
// The Buildroot kernel boots its read-only root on /dev/vda; the disk under test is /dev/vdb, 256 MiB. The
// guest side is bench/io/guest.sh, mounted over 9p. Realtime mode, one fresh boot and overlay per sample.
//   node bench/run.ts --page bench/io/index.html --input target/bench/io-raw.img [--only io]
import type { Options, Sample } from '../spike/benchmarks.ts';
import { boot, images } from '../boot/suite.ts';
import { removeOverlay } from '../../web/overlay.ts';

const OVERLAY = 'bench-io';
const CMDLINE = 'console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/bin/sh -- -c "mount -t proc proc /proc; mount -t 9p -o trans=virtio,version=9p2000.L host /mnt; . /mnt/guest.sh; poweroff -f"';

type Fio = { jobs: { read: { bw: number; iops: number; clat_ns: { mean: number } }; write: { bw: number; iops: number; clat_ns: { mean: number } } }[] };

/** `only`: the jobs to run (guest.sh's names; all if empty); `stats`: the blk device's per-stage timers (web/iostats.ts). */
export async function ioRun(file: File, kind: 'raw' | 'qcow2', n: number, log?: (m: string) => void, o: { runtime?: number; only?: string; stats?: boolean } = {}) {
  const img = await images();
  const module = await WebAssembly.compile(img.wasm);
  const script = await (await fetch(new URL('./guest.sh', import.meta.url))).text();
  const runs = [];
  for (let i = 0; i < n; i++) {
    await removeOverlay(OVERLAY).catch(() => {});
    const devices = [
      { type: 'console' as const }, { type: 'rng' as const },
      { type: 'blk' as const, url: img.disk },
      { type: 'blk' as const, url: '', file, overlay: OVERLAY, stats: o.stats },
      { type: '9p' as const, tag: 'host', files: { 'guest.sh': (o.runtime ? `RUNTIME=${o.runtime}\n` : '') + (o.only ? `ONLY="${o.only}"\n` : '') + script } },
    ];
    const r = await boot(module, { ...img, test: false }, undefined, { cmdline: CMDLINE, realtime: true, devices });
    log?.(`${kind} run ${i + 1}/${n}: ${r.total.toFixed(0)} ms`);
    runs.push({ ...r, deviceStats: o.stats ? (await r.closed as Record<string, unknown>)?.[3] : undefined });
    await removeOverlay(OVERLAY).catch(() => {});
  }
  return runs;
}

type Run = Awaited<ReturnType<typeof ioRun>>[number];

/** The JSON between a job's markers. */
function fioJson(r: Run, name: string): Fio['jobs'][0] {
  const s = r.console.split(`waarm64: ${name} start`)[1]?.split(`waarm64: ${name} end`)[0];
  const j = s && s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  if (!j) throw new Error(`no ${name} output:\n${r.console}`);
  return (JSON.parse(j) as Fio).jobs[0];
}
const between = (r: Run, what: string) => {
  const ms = r.marks[`${what} end`] - r.marks[`${what} start`];
  if (!(ms > 0)) throw new Error(`no ${what} markers:\n${r.console}`);
  return ms;
};

const JOBS: [string, 'read' | 'write'][] = [
  ['randread4k', 'read'], ['seqread128k', 'read'], ['seqread1M', 'read'],
  ['seqwrite1M', 'write'], ['seqwrite1M_fsync', 'write'], ['randwrite4k', 'write'], ['randwrite4k_fsync', 'write'],
  ['heldseqread1M', 'read'], ['heldrandread4k', 'read'],
];

export function samples(runs: Run[], kind: string, jobs = JOBS): Sample[] {
  const params = { disk: kind, size: '256 MiB', overlay: 'fresh OPFS', realtime: true, kernel: 'Buildroot Image' };
  const out: Sample[] = [];
  for (const [name, dir] of jobs) {
    const js = runs.map((r) => fioJson(r, name)[dir]);
    out.push({ name: `io_${kind}_${name}_bw`, unit: 'KiB/s', params, samples: js.map((j) => j.bw) });
    out.push({ name: `io_${kind}_${name}_iops`, unit: 'IOPS', params, samples: js.map((j) => j.iops) });
    out.push({ name: `io_${kind}_${name}_lat`, unit: 'us', params, samples: js.map((j) => j.clat_ns.mean / 1000) });
  }
  if (jobs !== JOBS) return out;
  out.push({ name: `io_${kind}_dd_read`, unit: 'MiB/s', params: { ...params, bs: '1M', bytes: 128 << 20 }, samples: runs.map((r) => 128 / (between(r, 'dd') / 1000)) });
  out.push({ name: `io_${kind}_dd_write_fsync`, unit: 'MiB/s', params: { ...params, bs: '1M', bytes: 16 << 20 }, samples: runs.map((r) => 16 / (between(r, 'ddsync') / 1000)) });
  return out;
}

async function io(o: Options & { file: File }): Promise<Sample[]> {
  const runs = await ioRun(o.file, 'raw', o.quick ? 1 : 5, o.log, { runtime: o.quick ? 1 : undefined });
  return samples(runs, 'raw');
}

/** The base reads alone, of a raw file or a qcow2 (by the chosen file's name): the qcow2 inflate's A/B (bench/io/REPORT.md). */
async function ioReads(o: Options & { file: File }): Promise<Sample[]> {
  const kind = /\.qcow2$/.test(o.file.name) ? 'qcow2' : 'raw';
  const reads = JOBS.filter(([name]) => !/write|held/.test(name));
  const runs = await ioRun(o.file, kind, o.quick ? 1 : 5, o.log, { runtime: o.quick ? 1 : undefined, only: reads.map(([name]) => name).join(' ') });
  return samples(runs, kind, reads);
}

/** Per-stage time of each workload alone (one boot each; the held reads' boots include their writes, subtract the `seqwrite1M` one). */
const STAT_SETS = ['randread4k', 'seqread128k', 'seqread1M', 'dd', 'seqwrite1M', 'seqwrite1M_fsync', 'randwrite4k', 'randwrite4k_fsync', 'ddsync', 'seqwrite1M heldseqread1M', 'seqwrite1M heldrandread4k'];

async function ioStats(o: Options & { file: File }): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const only of STAT_SETS) {
    const [r] = await ioRun(o.file, 'raw', 1, o.log, { only, stats: true, runtime: o.quick ? 1 : undefined });
    out.push({ name: `iostats_${only.replace(' ', '+')}`, unit: 'ms', params: { only, device: 'vdb (3: the device index)', ...(r.deviceStats as object) }, samples: [r.total] });
    o.log?.(`${only}: ${JSON.stringify(r.deviceStats)}`);
  }
  return out;
}

export const suite = { io, io_reads: ioReads, io_stats: ioStats };
export const runAll = io;
