// What one pointer event costs from the page's listener to the guest's event buffers (PERF loop 103, #272; dev-only):
// today's shape, `[type, code, value][]` posted on a MessagePort (web/input.ts `pointer`) and taken by
// web/input-device.ts `inject` (pushed, trimmed, each written through a fresh 8-byte DataView), against a flat
// `Int32Array` (cloned, or transferred) taken into one kept 8-byte buffer. A tablet's move: ABS_X, ABS_Y, SYN (three
// events). In headless Chromium, the sender on the page, the receiver in a worker on the other end of a
// MessageChannel, as in a run (the page and the machine worker). Per message: the sender's time (build and post),
// and the whole time for a burst of BURST messages until the worker has written them all (both threads' work and the
// hop), ROUNDS rounds alternating the arms; medians and IQR; JSON on stdout.
//   node bench/io/pointer.ts [rounds]
import { chromium } from 'playwright-core';

const ROUNDS = Number(process.argv[2] ?? 11);
const BURST = 2000;

// The worker: each arm's receiver, as web/input-device.ts's `input` is (`trimInput` is a no-op under its cap here: the
// guest has posted buffers, so `deliver` empties the queue at once).
const worker = `
const ram = new Uint8Array(1 << 16);
let at = 0;
const events = [];
const write = (b) => { ram.set(b, at); at = (at + 8) & 0xfff8; };
const kept = new DataView(new ArrayBuffer(8));
const keptBytes = new Uint8Array(kept.buffer);
let got = 0, want = 0, port;
const took = () => { if (++got === want) port.postMessage('done'); };
const arms = {
  nested(e) {
    if (e.some((x) => x[0] === 1)) {}
    events.push(...e);
    while (events.length) {
      const b = new DataView(new ArrayBuffer(8));
      const [type, code, value] = events.shift();
      b.setUint16(0, type, true); b.setUint16(2, code, true); b.setInt32(4, value, true);
      write(new Uint8Array(b.buffer));
    }
  },
  flat(e) {
    for (let k = 0; k + 2 < e.length; k += 3) {
      kept.setUint16(0, e[k], true); kept.setUint16(2, e[k + 1], true); kept.setInt32(4, e[k + 2], true);
      write(keptBytes);
    }
  },
};
arms.transfer = arms.flat;
onmessage = (m) => {
  port = m.data.port;
  port.onmessage = (e) => {
    if (e.data && e.data.arm) { got = 0; want = e.data.n; const f = arms[e.data.arm]; port.onmessage2 = f; return; }
    port.onmessage2(e.data); took();
  };
  port.postMessage('ready');
};`;

function inPage(src: string, rounds: number, burst: number) {
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const ch = new MessageChannel();
  const port = ch.port1;
  const next = () => new Promise<unknown>((r) => (port.onmessage = (e) => r(e.data)));
  const ready = next();
  w.postMessage({ port: ch.port2 }, [ch.port2]);
  const EV_ABS = 3;
  const EV_SYN = 0;
  let x = 0;
  const senders: Record<string, () => void> = {
    nested() {
      x = (x + 7) & 0x7fff;
      port.postMessage([
        [EV_ABS, 0, x],
        [EV_ABS, 1, 32767 - x],
        [EV_SYN, 0, 0],
      ]);
    },
    flat() {
      x = (x + 7) & 0x7fff;
      port.postMessage(Int32Array.of(EV_ABS, 0, x, EV_ABS, 1, 32767 - x, EV_SYN, 0, 0));
    },
    transfer() {
      x = (x + 7) & 0x7fff;
      const a = Int32Array.of(EV_ABS, 0, x, EV_ABS, 1, 32767 - x, EV_SYN, 0, 0);
      port.postMessage(a, [a.buffer]);
    },
  };
  const stats = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    const q = (p: number) => s[Math.floor((s.length - 1) * p)];
    return { median: q(0.5), q1: q(0.25), q3: q(0.75), rounds: a };
  };
  return (async () => {
    await ready;
    const send: Record<string, number[]> = {};
    const whole: Record<string, number[]> = {};
    const names = Object.keys(senders);
    for (let r = 0; r < rounds + 1; r++) {
      for (const n of r % 2 ? [...names].reverse() : names) {
        port.postMessage({ arm: n, n: burst });
        const done = next();
        const f = senders[n];
        const t0 = performance.now();
        for (let i = 0; i < burst; i++) f();
        const t1 = performance.now();
        await done;
        const t2 = performance.now();
        if (r > 0) {
          // round 0 warms up
          (send[n] ??= []).push(+(((t1 - t0) * 1e3) / burst).toFixed(3));
          (whole[n] ??= []).push(+(((t2 - t0) * 1e3) / burst).toFixed(3));
        }
      }
    }
    w.terminate();
    const st = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([n, t]) => [n, stats(t)]));
    return { usSendPerMessage: st(send), usWholePerMessage: st(whole) };
  })();
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const version = browser.version();
let out;
try {
  const page = await browser.newPage();
  out = await page.evaluate(`(${inPage.toString()})(${JSON.stringify(worker)}, ${ROUNDS}, ${BURST})`);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({ rounds: ROUNDS, burst: BURST, events: 3, chromium: version, ...(out as object) }, null, 1),
);
