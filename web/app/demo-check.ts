// The browser checked before a demo's download (docs/frontend.md "The demo store"):
// what the demo needs of the browser and the computer, each said as met, a warning (it may still run: another browser,
// a phone, little memory) or a stop (it can't: no cross-origin isolation, no OPFS, no WebGL2 for 3D, no WebGPU for
// Vulkan, the storage too full for the download). `checkDemo` is the rules over what the browser says (`BrowserEnv`,
// read by `readEnv` on the page), so Node's tests run them.
import type { Definition } from './definitions.ts';

/** What the browser and computer say of themselves (undefined: the browser doesn't say). */
export type BrowserEnv = {
  /** Chromium's (Chrome, Edge…): the browser the emulator is made for. */
  chromium: boolean;
  /** A phone or tablet (User-Agent Client Hints' `mobile`, or the User-Agent's). */
  mobile: boolean;
  /** Cross-origin isolated, with SharedArrayBuffer (the guest's memory, shared by the vCPUs). */
  isolated: boolean;
  /** The origin private file system (a stored machine's disks). */
  opfs: boolean;
  /** WebGL2 (a 3D machine's renderer); undefined: not asked (the demo has no 3D). */
  webgl2?: boolean;
  /** A WebGPU adapter (Vulkan's renderer); undefined: not asked. */
  webgpu?: boolean;
  /** The device's memory, GiB, as the browser rounds it (Chromium: at most 8). */
  memoryGiB?: number;
  /** The storage left to this origin, bytes (its quota less its use). */
  free?: number;
};

export type CheckLevel = 'ok' | 'warn' | 'fail';
/** What is checked (each a message of its own: `machines:DemoChecks.<what>.<level>`). */
export type CheckWhat = 'browser' | 'isolation' | 'opfs' | 'webgl2' | 'webgpu' | 'memory' | 'storage' | 'mobile';
export type Check = { what: CheckWhat; level: CheckLevel; params?: Record<string, number> };

/** The memory past the guest's RAM a running machine takes in the browser (its JIT, its workers, the page), MiB. */
export const OVERHEAD_MIB = 1536;
/** The room a demo wants past its download: its first writes to the disk's overlay (×1.25), and at least 64 MiB. */
export const room = (download: number) => Math.max(Math.ceil(download * 1.25), download + (64 << 20));

/** What the demo needs of the browser: its 3D, its Vulkan and its RAM, from its machine; its download. */
export type Needs = { gl: boolean; vulkan: boolean; ramMiB: number; download: number };
export const needsOf = (def: Definition & { demo: { download: number } }): Needs => ({
  gl: def.machine.display === '3d',
  vulkan: def.machine.vulkan === true,
  ramMiB: def.machine.ramMiB,
  download: def.demo.download,
});

/** The checks of browser `env` for a demo that needs `n`, in the order shown; a stop among them keeps it from starting. */
export function checkDemo(env: BrowserEnv, n: Needs): Check[] {
  const pass = (what: CheckWhat, ok: boolean, bad: CheckLevel = 'fail'): Check => ({ what, level: ok ? 'ok' : bad });
  const list: Check[] = [
    pass('browser', env.chromium, 'warn'),
    pass('isolation', env.isolated),
    pass('opfs', env.opfs),
  ];
  if (n.gl || n.vulkan) list.push(pass('webgl2', env.webgl2 === true));
  if (n.vulkan) list.push(pass('webgpu', env.webgpu === true));
  if (env.memoryGiB !== undefined) {
    const need = Math.ceil((n.ramMiB + OVERHEAD_MIB) / 1024);
    list.push({ ...pass('memory', env.memoryGiB >= need, 'warn'), params: { have: env.memoryGiB, need } });
  }
  if (env.free !== undefined)
    list.push({ ...pass('storage', env.free >= room(n.download)), params: { free: env.free, need: room(n.download) } });
  if (env.mobile) list.push({ what: 'mobile', level: 'warn' });
  return list;
}

/** Whether checks `c` let the demo start (no stop among them). */
export const canStart = (c: readonly Check[]) => !c.some((x) => x.level === 'fail');

type Nav = Pick<Navigator, 'userAgent'> & {
  userAgentData?: { brands: { brand: string }[]; mobile?: boolean };
  deviceMemory?: number;
  storage?: Pick<StorageManager, 'estimate' | 'getDirectory'>;
  gpu?: { requestAdapter(): Promise<unknown> };
};

/** What this browser says of itself, for a demo that needs `n` (WebGL2 and WebGPU asked only when it needs them). */
export async function readEnv(n: Needs, nav: Nav = navigator): Promise<BrowserEnv> {
  const ua = nav.userAgentData;
  const est = await nav.storage?.estimate().catch(() => undefined);
  const opfs = await (nav.storage?.getDirectory() ?? Promise.reject(new Error('no OPFS'))).then(
    () => true,
    () => false,
  );
  return {
    chromium: !!ua?.brands.some((b) => b.brand === 'Chromium'),
    mobile: ua?.mobile ?? /Mobi|Android/i.test(nav.userAgent),
    isolated: globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function',
    opfs,
    ...(await graphics(n, nav)),
    ...(nav.deviceMemory === undefined ? {} : { memoryGiB: nav.deviceMemory }),
    ...(est?.quota ? { free: Math.max(0, est.quota - (est.usage ?? 0)) } : {}),
  };
}

/** WebGL2 and WebGPU, each asked only when the demo needs it. */
async function graphics(n: Needs, nav: Nav): Promise<Pick<BrowserEnv, 'webgl2' | 'webgpu'>> {
  return {
    ...(n.gl || n.vulkan ? { webgl2: hasWebgl2() } : {}),
    ...(n.vulkan ? { webgpu: !!(await nav.gpu?.requestAdapter().catch(() => null)) } : {}),
  };
}

/** Whether a WebGL2 context can be made (on a canvas off the page, let go of at once). */
function hasWebgl2() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false; // no OffscreenCanvas or no WebGL2: either way, none
  }
}
