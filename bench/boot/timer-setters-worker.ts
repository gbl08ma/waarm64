// timer-setters.ts's workers: a spinner (a vCPU in compiled code, polling its stop word) or the setter under test.
// Words of the shared buffer (i32): 0 the end; 16 + cpu a spinner's stop word (1 running, 0 stop); 32 + cpu its ack.
export type SetterJob =
  | { role: 'spin'; sab: SharedArrayBuffer; cpu: number }
  | { role: 'set'; sab: SharedArrayBuffer; cpus: number; ms: number; gap: number; mechanism: 'wait' | 'spin' | 'halve' | 'waitAsync' | 'setTimeout' };
/** Per due store: µs from the deadline to the setter's wake-up, and from that store to the spinner's ack. */
export type SetterResult = { wake: number[]; seen: number[]; spinUs: number; waits: number; wallUs: number };

const STOP = 16,
  ACK = 32,
  BELL = 48; // a word nobody notifies: the timed waits' target
/** The hybrid's spin before a deadline: a futex wake-up's usual lateness, waited off by spinning. */
const SPIN_US = 200;
/** `halve`: waits of half the time left (macOS's timer leeway grows with the timeout), spinning the last of it. */
const HALVE_FLOOR_US = 40;

const self = globalThis as unknown as { onmessage: (e: MessageEvent<SetterJob>) => void; postMessage(m: SetterResult): void };
self.onmessage = (e) => {
  const j = e.data;
  const i32 = new Int32Array(j.sab);
  if (j.role === 'spin') {
    Atomics.store(i32, STOP + j.cpu, 1);
    let x = 0;
    // Work between polls, as compiled code has (~25 steps a poll).
    while (Atomics.load(i32, 0) === 0) {
      for (let k = 0; k < 16; k++) x = (x * 1103515245 + 12345) | 0;
      if (Atomics.load(i32, STOP + j.cpu) === 0) {
        Atomics.store(i32, ACK + j.cpu, 1);
        Atomics.store(i32, STOP + j.cpu, 1);
      }
    }
    if (x === 42) console.log(x);
    return;
  }
  const { cpus, ms, gap, mechanism } = j;
  const wake: number[] = [];
  const seen: number[] = [];
  const next = (t: number) => t + gap * (0.5 + Math.random()); // µs: a guest tick `gap` apart on average
  const t0 = performance.now() * 1000;
  const due = Array.from({ length: cpus }, () => next(t0));
  const fire = () => {
    const w = performance.now() * 1000;
    const hit: number[] = [];
    for (let c = 0; c < cpus; c++) {
      if (due[c] > w) continue;
      Atomics.store(i32, ACK + c, 0);
      Atomics.store(i32, STOP + c, 0);
      hit.push(c);
    }
    // For the measure only (a setter wouldn't wait): each spinner's answer.
    for (const c of hit) {
      while (Atomics.load(i32, ACK + c) === 0 && performance.now() * 1000 - w < 50_000);
      wake.push(w - due[c]);
      seen.push(performance.now() * 1000 - w);
      due[c] = next(Math.max(due[c], w));
    }
  };
  const end = t0 + ms * 1000;
  const earliest = () => Math.min(...due);
  let spinUs = 0,
    waits = 0;
  const wait = (us: number) => {
    waits++;
    Atomics.wait(i32, BELL, 0, us / 1000);
  };
  const spinTo = (d: number) => {
    const s0 = performance.now() * 1000;
    while (performance.now() * 1000 < d);
    spinUs += Math.max(0, performance.now() * 1000 - s0);
  };
  const done = () => self.postMessage({ wake, seen, spinUs, waits, wallUs: performance.now() * 1000 - t0 });
  if (mechanism === 'wait' || mechanism === 'spin' || mechanism === 'halve') {
    while (performance.now() * 1000 < end) {
      const d = earliest();
      if (mechanism === 'halve') {
        for (let r = d - performance.now() * 1000; r > HALVE_FLOOR_US; r = d - performance.now() * 1000) wait(r / 2);
      } else {
        const t = d - (mechanism === 'spin' ? SPIN_US : 0) - performance.now() * 1000;
        if (t > 0) wait(t);
      }
      spinTo(d);
      fire();
    }
    done();
    return;
  }
  const step = () => {
    if (performance.now() * 1000 >= end) return done();
    const t = Math.max(0, earliest() - performance.now() * 1000) / 1000;
    const go = () => {
      fire();
      step();
    };
    if (mechanism === 'setTimeout') setTimeout(go, t);
    else {
      waits++;
      const r = Atomics.waitAsync(i32, BELL, 0, t);
      if (r.async) void r.value.then(go);
      else go();
    }
  };
  step();
};
