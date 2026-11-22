// A template made on the page for the demos' tests (tests/page-template-first.test.ts, tests/page-demos.test.ts), in
// Chromium without a guest: the machine worker as a stand-in that records each start, and a template's machine made in
// a fresh profile (a chunked image's disk) with its definition and a snapshot file of it.
import type { Browser, Page } from 'playwright-core';

export type Start = { disks: { overlay?: string }[]; plan?: { slot: number; action: string; overlay?: string }[]; snapshot: boolean };

/**
 * The machine worker as a stand-in: each start recorded (`window.__starts`) and answered "off" (`live`: "running", a
 * machine that runs on); a stop, "stopped". `gpuFails`: the GPU worker too, which answers its `init` with `failed`
 * (3D can't start in this browser).
 */
export const standIn = (page: Page, live = false, gpuFails = false) => page.addInitScript(([live, gpuFails]) => {
  const Real = window.Worker;
  const starts: unknown[] = [];
  (window as unknown as { __starts: unknown[] }).__starts = starts;
  window.Worker = class extends Real {
    #fake: boolean;
    #gpu: boolean;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.#fake = /\/app\/worker\.ts/.test(String(url));
      this.#gpu = gpuFails && /\/gpu-worker\.ts/.test(String(url));
    }
    postMessage(m: unknown, t?: unknown) {
      const answer = (data: unknown) => setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })));
      if (this.#gpu) {
        if ((m as { type?: string }).type === 'init') answer({ type: 'failed', reason: 'the test says no' });
        return;
      }
      if (!this.#fake) return super.postMessage(m as never, t as never);
      const msg = m as { type?: string; disks?: { overlay?: string }[]; plan?: unknown; snapshot?: unknown };
      if (msg.type === 'start') {
        starts.push({ disks: (msg.disks ?? []).map((d) => ({ overlay: d.overlay })), plan: msg.plan, snapshot: !!msg.snapshot });
        answer({ type: 'state', state: live ? 'running' : 'off' });
      }
      if (msg.type === 'stop') answer({ type: 'stopped' });
    }
  };
}, [live, gpuFails] as const);

/** A template's machine made in a fresh profile (`display`: its graphics): its definition, a snapshot file of it, the snapshot's shape hash. */
export async function makeTemplate(browser: Browser, base: string, display: '2d' | '3d' = '2d'): Promise<{ def: { disks: object[] } & Record<string, unknown>; snapshot: number[]; hash: string }> {
  // Where the template is made: its machine, its definition, a snapshot pinning its overlay at a later generation.
  const maker = await browser.newContext();
  const a = await maker.newPage();
  await standIn(a);
  await a.goto(`${base}/web/app/`);
  await a.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 }); // the page's actions provided
  const made = await a.evaluate(async (display) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { exportDefinition } = await import('/web/app/definitions.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const { SnapshotWriter, crc32, SNAPSHOT_VERSION } = await import('/web/snapshot-file.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Alpine', ncpus: 1, ramMiB: 256, display, usb: false, mouse: false, touch: false, shares: false });
    const d = await createDisk(store, { kind: 'url', url: 'http://localhost:9/alpine/manifest.json', size: 1 << 20, bytes: 1 << 20, chunked: 'ab'.repeat(32) });
    await attach(store, m, d);
    const rec = await store.get('machines', m.id);
    const disks = new Map((await store.all('disks')).map((x: { id: string }) => [x.id, x]));
    const { shape, hash } = await p.shapeNow(rec, disks, await store.all('overlays'));
    const pins = [{ slot: shape.disks[0].slot, identity: 'x', size: 1 << 20, blocks: 0, overlay: 'overlays/0123456789ab', generation: 4 }];
    const header = { format: 1, coreVersion: SNAPSHOT_VERSION, abi: 0, created: new Date().toISOString(), shape, shapeHash: hash, disks: pins, template: true };
    const parts: Uint8Array[] = [];
    const stored = { id: 0, compress: async (b: Uint8Array) => b, decompress: async (b: Uint8Array) => b, crc32 };
    await new SnapshotWriter((b: Uint8Array) => { parts.push(b.slice()); }, header, { codec: stored }).end();
    const file = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    return { def: await exportDefinition(store, m.id), snapshot: [...file], hash: hash as string };
  }, display);
  await maker.close();
  return made;

}
