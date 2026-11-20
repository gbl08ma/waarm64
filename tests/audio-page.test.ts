// The page's sound without a browser (web/audio.ts `PageAudio`, docs/audio.md "How it fits together"): the Web Audio and
// media globals stubbed, the worklet's `?worker&url` import resolved to a stub. Playback doesn't wait for the
// microphone's prompt; a detach suspends the context and stops the latency timer; a worklet that fails to load for the
// microphone stops its tracks.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, next) {
        if (s.endsWith('?worker&url')) return { url: 'data:text/javascript,export default "worklet"', shortCircuit: true };
        return next(s, c);
      }`,
    ),
);

interface Fake {
  contexts: FakeContext[];
  /** Settles the pending getUserMedia. */
  grant?: () => void;
  stopped: number;
  failModule: boolean;
}
const fake: Fake = { contexts: [], stopped: 0, failModule: false };

class FakeContext {
  state = 'suspended';
  baseLatency = 0;
  outputLatency = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = {
    addModule: async () => {
      if (fake.failModule) throw new Error('no module');
    },
  };
  opts: { sampleRate: number };
  constructor(opts: { sampleRate: number }) {
    this.opts = opts;
    fake.contexts.push(this);
  }
  get sampleRate() {
    return this.opts.sampleRate;
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
}
class FakeNode {
  gain = { value: 1 };
  connect() {}
  disconnect() {}
}
const g = globalThis as Record<string, unknown>;
g.AudioContext = FakeContext;
g.AudioWorkletNode = FakeNode;
g.GainNode = FakeNode;
g.MediaStreamAudioSourceNode = FakeNode;
const track = { stop: () => fake.stopped++ };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          fake.grant = () => resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
        }),
    },
  },
});

const { PageAudio } = await import('../web/audio.ts');

const settle = () => new Promise((r) => setTimeout(r, 10));

/** A started machine whose device port the test posts on. */
function machine() {
  const a = new PageAudio();
  const { port } = a.attach();
  const post = (m: unknown) => port.postMessage(m);
  return { a, port, post };
}

test('page audio: playback starts while the microphone prompt is unanswered', async () => {
  fake.contexts = [];
  const { a, port, post } = machine();
  post({ type: 'capture-start', rate: 48000 });
  await settle();
  assert.equal(a.micState, 'asking');
  post({ type: 'start', rate: 44100 });
  await settle();
  assert.equal(a.context()?.sampleRate, 44100, 'the playback context is made without waiting for the prompt');
  fake.grant?.();
  await settle();
  assert.equal(a.micState, 'on');
  a.detach();
  await settle();
  port.close();
});

test('page audio: a detach suspends the context and stops the latency timer', async () => {
  fake.contexts = [];
  const { a, port, post } = machine();
  post({ type: 'start', rate: 48000 });
  await settle();
  const ctx = a.context() as unknown as FakeContext;
  assert.equal(ctx.state, 'running');
  assert.notEqual(Reflect.get(a, 'latencyTimer'), undefined);
  a.detach();
  await settle();
  assert.equal(ctx.state, 'suspended');
  a.gesture(); // a click on the stopped machine doesn't run it again
  await settle();
  assert.equal(ctx.state, 'suspended');
  assert.equal(Reflect.get(a, 'latencyTimer'), undefined);
  port.close();
});

test("page audio: a microphone worklet that doesn't load stops the tracks", async () => {
  fake.contexts = [];
  fake.stopped = 0;
  const { a, port, post } = machine();
  post({ type: 'capture-start', rate: 48000 });
  await settle();
  fake.failModule = true;
  fake.grant?.();
  await settle();
  fake.failModule = false;
  assert.equal(fake.stopped, 1);
  assert.equal(a.micSettings(), undefined);
  assert.notEqual(a.micState, 'asking');
  a.detach();
  await settle();
  port.close();
});
