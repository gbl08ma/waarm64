// The address's knobs (docs/frontend.md "The page's code"): the query as the run reads it, collected here as the page
// parsed it before (a later pass makes it one typed machine configuration). `?machine=buildroot` picks the test
// guest, `?ncpus=N` the vCPU count, `?view=screen|terminal|both` the first view, `?params=` extra kernel parameters
// (direct-boot machines), `?credential=name:value` a systemd credential over fw_cfg (firmware machines),
// `?keyboard=<id>` the guest's keyboard layout (web/app/keyboard.ts), `?disk2=<url>` a read-only second disk,
// `?disk=<url>` a root disk of your own, `?snd=stats[,timer]` the sound's measurements, `?avprobe` the screen's
// flashes for A/V sync (bench/audio/avsync.ts), `?gpu=` the graphics' knobs.
import { parseGpuKnobs } from '../../gpu-knobs.ts';
import { cpuFromQuery } from '../../cpu-features.ts';
import { settings } from '../settings.ts';

export const params = new URLSearchParams(location.search);
/** The address's query as it is now (a switch to another machine drops the last one's size and switches from it). */
export const query = () => new URLSearchParams(location.search);

/** `?credential=name:value` (repeatable): a systemd credential for a firmware machine, for development and tests. */
export const credentials = params
  .getAll('credential')
  .map((c) => ({ name: c.slice(0, c.indexOf(':')), data: c.slice(c.indexOf(':') + 1) }));

/** The page's CPU features (`?<feature>=0` turns a default one off, `?<feature>=1` another on: development; web/cpu-features.ts). */
export const cpuFeatures = () => cpuFromQuery(params);

/** The JIT's code cache budget, MiB (`BootOptions.jitBytes`; docs/jit.md "Memory"): `?jitmb=`; 0: none asked. */
export const jitParam = () => Math.max(0, Math.round(Number(new URLSearchParams(location.search).get('jitmb')) || 0));

/** `?display=simple`: the simple framebuffer, without a virtio-gpu. */
export const simpleDisplay = params.get('display') === 'simple';

/**
 * Benchmarks' hooks (`?displaystats`, bench/gpu/sway-load.ts; web/app/hooks.ts): `?snd=` (sound measurements) wants
 * the serial log and status too.
 */
export const benchHooks = params.has('displaystats') || params.has('snd');

/**
 * 3D's knobs (docs/frontend.md "A 3D machine"): `?gpu=2d` (or `virgl-null`, G2's null renderer) off, `?gpu=virgl` on,
 * over the Machine menu's Graphics; `?gpu=vulkan` Vulkan; the rest the GPU worker's (`gpuInitKnobs`, web/gpu-knobs.ts) and the machine worker's (web/app/run/dev-knobs.ts).
 */
export const gpuKnobs = (params.get('gpu') ?? '').split(',');
export const gpuAsked =
  gpuKnobs.includes('2d') || gpuKnobs.includes('virgl-null') ? '2d' : gpuKnobs.includes('virgl') ? '3d' : undefined;

/** The GPU worker's knobs from the address and the Preferences (its `init` without the canvas and the port). */
export const gpuInitKnobs = () => parseGpuKnobs(params, settings().shaderMiB);
