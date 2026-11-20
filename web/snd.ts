// virtio-snd backend (docs/devices.md "snd (ID 25)", docs/audio.md), written from the virtio 1.2
// specification §5.14, with Linux's sound/virtio read for behavior and QEMU's virtio-sound-device as
// the oracle for what a guest sends (docs/audio.md "Linux driver behavior"). core/tests/common/snd.rs is its native twin and
// must give the same answers and play the same bytes.
//
// An output stream (0) and an input stream (1), no jacks, no channel maps; with a mixer (the page's machines) the
// controls of virtio 1.3 (`VIRTIO_SND_F_CTLS`): a Master volume and switch the guest's ALSA sees as the card's,
// which are the page's Sound menu (`SndMixer`); queues controlq,
// eventq, txq, rxq. A transmit message's frames go to a sink (`SndSink`): the deterministic one here hashes
// them and completes the messages at the end of the DEVICE exit that posted them (so boots keep exact step
// counts); the realtime one (`ringSink`) writes them into the page's ring (web/audio-ring.ts) and completes
// them once the AudioWorklet played them. A receive message is filled by a source (`SndSource`): the
// deterministic one with a known waveform at the end of its exit, the realtime one at the stream's rate.
//
// The protocol is web/snd-proto.ts, the deterministic sink and source web/snd-test.ts, the realtime ones
// web/snd-realtime.ts; this is the backend over the queues.
import { bytes, type Ram, type Segment } from './devices.ts';
import { gather, scatter, type Ctx, type Request } from './virtio.ts';
import { checksumSink, patternSource } from './snd-test.ts';
import {
  CONTROLQ,
  EVENTQ,
  EVT_CTL_NOTIFY,
  F_CTLS,
  IN,
  OUT,
  RXQ,
  S_OK,
  SWITCH,
  Snd,
  TXQ,
  VOLUME,
  levelToValue,
  valueToLevel,
  type SndMixer,
  type SndSink,
  type SndSource,
} from './snd-proto.ts';
import type { SndFromPage, SndToPage } from './snd-realtime.ts';

/** A sound device's state (`Backend.save`): the streams, the control requests taken, what the sink played (the deterministic sink's `Played`) and what the source recorded (`Recorded`). */
export type SndState = ReturnType<Snd['save']> & { sink: unknown; source?: unknown };

/** Writes `bytes` over the last bytes of the segments (a status: the end of a request's writable bytes). */
function writeTail(ram: Ram, segs: Segment[], data: Uint8Array) {
  let skip = segs.reduce((n, s) => n + s.len, 0) - data.length;
  let k = 0;
  for (const s of segs) {
    if (skip >= s.len) {
      skip -= s.len;
      continue;
    }
    const n = Math.min(s.len - skip, data.length - k);
    bytes(ram, s).set(data.subarray(k, k + n), skip);
    k += n;
    skip = 0;
  }
}

/**
 * The backend over the queues: control requests answered at once; event buffers held for the controls' notifications.
 * With `mixer` the device has its controls, starting at the page's volume and mute: the guest's changes are said on
 * `mixer.port` and the page's (heard there) set them and notify the guest, if its driver took the controls. Output
 * messages (txq) are held until their stream's START, then given to `sink`; input messages (rxq) likewise to
 * `source`, which fills them; both are returned at RELEASE (STOP pauses: Linux sends it for a pause too, and
 * resumes with START without posting the held messages again).
 */
export function sndBackend(
  ctx: Ctx,
  sink: SndSink = checksumSink(),
  source: SndSource = patternSource(),
  mixer?: SndMixer & { port?: MessagePort },
) {
  const snd = new Snd(!!mixer);
  if (mixer) [snd.values[VOLUME], snd.values[SWITCH]] = [levelToValue(mixer.level), mixer.muted ? 0 : 1];
  /** I/O messages not completed, per stream: waiting for START, or given to the sink or source and not done yet. */
  type Msg = { r: Request; live: boolean };
  const waiting: Msg[][] = [[], []];
  const running: Msg[][] = [[], []];
  const events: Request[] = [];
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  /** Completes a message with a `virtio_snd_pcm_status` (status, latency_bytes) in its last writable bytes, after `data` (a capture's frames). */
  const finish = (r: Request, st: number, latency = 0, data?: Uint8Array) => {
    if (room(r) < 8) return ctx.complete(r.w0, 0); // no room for a status: nothing to say
    if (data) scatter(ctx.ram(), r.write, data);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, st, true);
    new DataView(b.buffer).setUint32(4, latency, true);
    writeTail(ctx.ram(), r.write, b);
    ctx.complete(r.w0, (data?.length ?? 0) + 8);
  };
  const done = (sid: number, m: Msg) => {
    if (!m.live) return false;
    m.live = false;
    running[sid] = running[sid].filter((x) => x !== m);
    return true;
  };
  const run = (sid: number, m: Msg) => {
    running[sid].push(m);
    const p = snd.streams[sid].params!;
    if (reposted) reposted[sid] += sid === OUT ? m.r.read.reduce((n, s) => n + s.len, 0) - 4 : room(m.r) - 8;
    if (sid === OUT) {
      const len = m.r.read.reduce((n, s) => n + s.len, 0);
      sink.play(p, gather(ctx.ram(), m.r.read, len).subarray(4), (latency) => {
        if (done(sid, m)) finish(m.r, S_OK, latency);
      });
    } else {
      source.record(p, room(m.r) - 8, (data, latency) => {
        if (done(sid, m)) finish(m.r, S_OK, latency, data);
      });
    }
  };
  const drop = (sid: number) => {
    const back = [...running[sid], ...waiting[sid]];
    for (const m of back) m.live = false;
    [running[sid], waiting[sid]] = [[], []];
    return back;
  };
  const side = (sid: number) => (sid === OUT ? sink : source);
  /** After a restore, until its first poll ends: the bytes of held messages given again to the sink and the source. */
  let reposted: number[] | undefined;
  /** Controls changed by the page that the guest wasn't told yet (it hears of them as event buffers come). */
  const notify: number[] = [];
  const flush = () => {
    while (notify.length && events.length) {
      const r = events.shift()!;
      if (room(r) < 8) {
        ctx.complete(r.w0, 0);
        continue;
      }
      // virtio_snd_ctl_event: VIRTIO_SND_EVT_CTL_NOTIFY, the control, VIRTIO_SND_CTL_EVT_MASK_VALUE.
      const b = new Uint8Array(8);
      const v = new DataView(b.buffer);
      v.setUint32(0, EVT_CTL_NOTIFY, true);
      v.setUint16(4, notify.shift()!, true);
      v.setUint16(6, 1, true);
      scatter(ctx.ram(), r.write, b);
      ctx.complete(r.w0, 8);
    }
  };
  const tellPage = () =>
    mixer?.port?.postMessage({
      type: 'mixer',
      level: valueToLevel(snd.values[VOLUME]),
      muted: !snd.values[SWITCH],
    } satisfies SndToPage);
  /** The page's volume and mute: the controls take them, and a driver that has them is notified. */
  const fromPage = (m: SndMixer) => {
    for (const [id, value] of [
      [VOLUME, levelToValue(m.level)],
      [SWITCH, m.muted ? 0 : 1],
    ]) {
      if (snd.set(id, value) && ctx.features() & F_CTLS && !notify.includes(id)) notify.push(id);
    }
    flush();
  };
  if (mixer?.port)
    mixer.port.onmessage = (e: MessageEvent<SndFromPage>) => {
      if (e.data?.type === 'mixer') fromPage(e.data);
    };
  return {
    snd,
    sink,
    source,
    request(r: Request): number | undefined {
      const ram = ctx.ram();
      if (r.queue === EVENTQ) {
        events.push(r);
        flush();
        return undefined;
      }
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (r.queue === CONTROLQ) {
        const w = room(r);
        if (w < 4) return 0;
        const { reply, effect, stream: sid } = snd.control(gather(ram, r.read, len), w);
        scatter(ram, r.write, reply);
        // The reply first: the stream's messages complete after the request that started or released it.
        ctx.complete(r.w0, reply.length);
        if (effect === 'start') {
          side(sid).start?.(snd.streams[sid].params!);
          const now = waiting[sid];
          waiting[sid] = [];
          for (const m of now) run(sid, m);
        } else if (effect === 'stop') {
          side(sid).stop?.();
        } else if (effect === 'release') {
          const back = drop(sid);
          side(sid).release?.();
          for (const m of back) finish(m.r, S_OK);
        } else if (effect === 'mixer') {
          tellPage();
        }
        return undefined;
      }
      if (r.queue === TXQ || r.queue === RXQ) {
        const sid = r.queue === TXQ ? OUT : IN;
        const verdict = snd.io(sid, gather(ram, r.read, 4), sid === OUT ? len - 4 : room(r) - 8);
        if (verdict === 'run') run(sid, { r, live: true });
        else if (verdict === 'hold') waiting[sid].push({ r, live: true });
        else finish(r, verdict);
      }
      return undefined;
    },
    /** The end of a DEVICE exit's requests. */
    polled() {
      if (reposted) {
        // The restore's chains were posted again in this poll (web/vm.ts serves the doorbell once after a restore).
        for (const sid of [OUT, IN])
          if (snd.streams[sid].state === 'started') side(sid).restored?.(snd.streams[sid].params!, reposted[sid]);
        reposted = undefined;
      }
      sink.tick?.();
      source.tick?.();
    },
    reset() {
      drop(OUT);
      drop(IN);
      events.length = 0;
      notify.length = 0;
      snd.reset();
      sink.release?.();
      source.release?.();
    },
    save: (): SndState => ({ ...snd.save(), sink: sink.save?.() ?? null, source: source.save?.() ?? null }),
    restore(state: unknown) {
      snd.restore(state);
      const s = state as { sink?: unknown; source?: unknown };
      if (s.sink !== null && s.sink !== undefined) sink.restore?.(s.sink);
      if (s.source !== null && s.source !== undefined) source.restore?.(s.source);
      if (snd.streams[OUT].state === 'started') sink.start?.(snd.streams[OUT].params!);
      if (snd.streams[IN].state === 'started') source.start?.(snd.streams[IN].params!);
      reposted = [0, 0];
      if (snd.values.length) tellPage();
    },
    /** The page's volume and mute (what its port says), for tests. */
    mixer: fromPage,
  };
}
