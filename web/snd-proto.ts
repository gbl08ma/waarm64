// virtio-snd's protocol (web/snd.ts's device; docs/audio.md): the request codes, formats, rates and controls, the
// sinks' and sources' interfaces (`SndSink`, `SndSource`), and `Snd`, the control requests and each stream's state
// machine without the queues. core/tests/common/snd.rs is its native twin.
/** The queues, in order. */
export const CONTROLQ = 0;
export const EVENTQ = 1;
export const TXQ = 2;
export const RXQ = 3;

/** Request codes and statuses (virtio 1.2 §5.14.6). */
export const R_JACK_INFO = 1;
export const R_JACK_REMAP = 2;
export const R_PCM_INFO = 0x100;
export const R_PCM_SET_PARAMS = 0x101;
export const R_PCM_PREPARE = 0x102;
export const R_PCM_RELEASE = 0x103;
export const R_PCM_START = 0x104;
export const R_PCM_STOP = 0x105;
export const R_CHMAP_INFO = 0x200;
/** Control elements (virtio 1.3 §5.14.6.11): only with `VIRTIO_SND_F_CTLS`. */
export const R_CTL_INFO = 0x300;
export const R_CTL_ENUM_ITEMS = 0x301;
export const R_CTL_READ = 0x302;
export const R_CTL_WRITE = 0x303;
export const R_CTL_TLV_READ = 0x304;
export const R_CTL_TLV_WRITE = 0x305;
export const R_CTL_TLV_COMMAND = 0x306;
/** `VIRTIO_SND_EVT_CTL_NOTIFY`: a control's value changed (an event: code, control id u16, mask u16). */
export const EVT_CTL_NOTIFY = 0x1200;
export const S_OK = 0x8000;
export const S_BAD_MSG = 0x8001;
export const S_NOT_SUPP = 0x8002;

/** Sample formats (`VIRTIO_SND_PCM_FMT_*`) offered, and their sample size in bytes. */
export const FMT_S16 = 5;
export const FMT_S32 = 17;
export const FMT_FLOAT = 19;
export const SAMPLE_BYTES: Record<number, number> = { [FMT_S16]: 2, [FMT_S32]: 4, [FMT_FLOAT]: 4 };
const FORMAT_NAMES: Record<number, string> = { [FMT_S16]: 'S16', [FMT_S32]: 'S32', [FMT_FLOAT]: 'FLOAT' };

/** `VIRTIO_SND_PCM_RATE_*`: the rate of each bit. */
export const RATES = [
  5512, 8000, 11025, 16000, 22050, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000, 384000,
];
/** Offered: 8 kHz to 192 kHz (bits 1-12), what every browser's AudioContext takes (Chromium takes 3-768 kHz, Firefox 8-192). */
export const RATE_BITS = 0x1ffe;
const CHANNELS_MAX = 2;
/** The size of a `virtio_snd_pcm_info`. */
const PCM_INFO_SIZE = 32;
/** The streams: 0 the output, 1 the input (capture, audio S4). */
const STREAMS = 2;
export const OUT = 0;
export const IN = 1;

type State = 'none' | 'params' | 'prepared' | 'started' | 'stopped' | 'released';
type Stream = { state: State; params?: SndParams };
/** `VIRTIO_SND_F_CTLS` (feature bit 0): the device has control elements. */
export const F_CTLS = 1n;
/** The controls: the Master volume (an integer with a dB scale) and its switch (on: sound plays). */
export const VOLUME = 0;
export const SWITCH = 1;
/** The volume's steps: 0.25 dB each from -100 dB (0, silent) to 0 dB. */
export const VOLUME_MAX = 400;
const CONTROLS = [
  // role, type, access, name: VOLUME (role 1), INTEGER (1), read, write and TLV read; MUTE (role 2), BOOLEAN (0), read and write.
  { role: 1, type: 1, access: (1 << 0) | (1 << 1) | (1 << 4), name: 'Master Playback Volume' }, // i18n-ignore: ALSA's control name (the guest's mixer matches it)
  { role: 2, type: 0, access: (1 << 0) | (1 << 1), name: 'Master Playback Switch' }, // i18n-ignore: ALSA's control name
];
/** The sizes of a `virtio_snd_ctl_info` and a `virtio_snd_ctl_value`. */
const CTL_INFO_SIZE = 96;
const CTL_VALUE_SIZE = 512;
/** The volume's TLV: `SNDRV_CTL_TLVT_DB_SCALE` (1), 8 bytes, min -100.00 dB, steps of 0.25 dB with the lowest silent (`TLV_DB_SCALE_MUTE`). */
const VOLUME_TLV = [1, 8, -10000 >>> 0, 25 | 0x10000];

/**
 * The page's volume level (its slider, 0 to 1; the gain is its cube, as PipeWire's and PulseAudio's sliders are) as the
 * Master volume's value, and back: the guest's mixer then shows the page's percentage.
 */
export const levelToValue = (level: number) =>
  level > 0 ? Math.max(0, Math.min(VOLUME_MAX, Math.round((60 * Math.log10(Math.min(1, level)) + 100) * 4))) : 0;
export const valueToLevel = (value: number) => (value > 0 ? 10 ** ((Math.min(value, VOLUME_MAX) / 4 - 100) / 60) : 0);

/** The page's Sound menu as the device's controls: the volume level (0 to 1) and mute. */
export type SndMixer = { level: number; muted: boolean };

const STATES: State[] = ['none', 'params', 'prepared', 'started', 'stopped', 'released'];
export type SndParams = { bufferBytes: number; periodBytes: number; channels: number; format: number; rate: number };

/**
 * Where a playback stream's frames go. `play` gets a message's frames (raw, in the stream's format: `toF32`
 * converts) and calls `done(latencyBytes)` once they're played, which completes the message; frames come in
 * order. `start` (with the stream's parameters) and `stop` start and pause consumption; `release` drops whatever wasn't played (the device
 * returns those messages itself, and a later `done` for them does nothing). `tick` ends a DEVICE exit's
 * requests: a sink that completes at exits does it there.
 */
export type SndSink = {
  play(p: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void): void;
  start?(p: SndParams): void;
  stop?(): void;
  release?(): void;
  tick?(): void;
  save?(): unknown;
  restore?(state: unknown): void;
  /** After a restore, once its held messages were given again (`bytes` of frames): see `completionBound`. */
  restored?(p: SndParams, bytes: number): void;
};

/**
 * Where an input stream's frames come from. `record` asks for `bytes` of frames (a message's room, in the stream's
 * format) and calls `done(data, latencyBytes)` once they're recorded, which completes the message; asks come in
 * order. `start`, `stop`, `release`, `tick`, `save` and `restore` as for a sink.
 */
export type SndSource = {
  record(p: SndParams, bytes: number, done: (data: Uint8Array, latencyBytes: number) => void): void;
  start?(p: SndParams): void;
  stop?(): void;
  release?(): void;
  tick?(): void;
  save?(): unknown;
  restore?(state: unknown): void;
  /** As `SndSink.restored`. */
  restored?(p: SndParams, bytes: number): void;
};

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const status = (s: number, more = 0) => {
  const b = new Uint8Array(4 + more);
  new DataView(b.buffer).setUint32(0, s, true);
  return b;
};
const NAMES: Record<number, string> = {
  [R_JACK_INFO]: 'JACK_INFO',
  [R_JACK_REMAP]: 'JACK_REMAP',
  [R_PCM_INFO]: 'PCM_INFO',
  [R_PCM_SET_PARAMS]: 'PCM_SET_PARAMS',
  [R_PCM_PREPARE]: 'PCM_PREPARE',
  [R_PCM_RELEASE]: 'PCM_RELEASE',
  [R_PCM_START]: 'PCM_START',
  [R_PCM_STOP]: 'PCM_STOP',
  [R_CHMAP_INFO]: 'CHMAP_INFO',
  [R_CTL_INFO]: 'CTL_INFO',
  [R_CTL_ENUM_ITEMS]: 'CTL_ENUM_ITEMS',
  [R_CTL_READ]: 'CTL_READ',
  [R_CTL_WRITE]: 'CTL_WRITE',
  [R_CTL_TLV_READ]: 'CTL_TLV_READ',
  [R_CTL_TLV_WRITE]: 'CTL_TLV_WRITE',
  [R_CTL_TLV_COMMAND]: 'CTL_TLV_COMMAND',
};
const STATUS_NAMES: Record<number, string> = { [S_OK]: 'OK', [S_BAD_MSG]: 'BAD_MSG', [S_NOT_SUPP]: 'NOT_SUPP' };
/** The control requests logged (`Snd.log`), the first this many. */
const LOG_MAX = 64;

/** What a control request does to a stream's messages: nothing, run them (START), pause (STOP), return them (RELEASE); or the guest changed a control (`mixer`). */
export type Effect = 'none' | 'start' | 'stop' | 'release' | 'mixer';

/**
 * The device's protocol without the queues: control requests answered, I/O messages checked, each stream's
 * state machine (virtio 1.2 §5.14.6.6.1; a request out of its order is BAD_MSG).
 */
export class Snd {
  streams: Stream[] = Array.from({ length: STREAMS }, () => ({ state: 'none' }));
  /** The controls' values (`VOLUME`, `SWITCH`), with `controls`; none without (the requests are NOT_SUPP). */
  values: number[];

  constructor(controls = false) {
    this.values = controls ? [VOLUME_MAX, 1] : [];
  }

  /** Sets control `id` to `value` (clamped to its range); whether it changed. */
  set(id: number, value: number) {
    const v = Math.max(0, Math.min(id === VOLUME ? VOLUME_MAX : 1, Math.round(value)));
    if (id >= this.values.length || this.values[id] === v) return false;
    this.values[id] = v;
    return true;
  }
  /** The control requests and their statuses, in order (the first LOG_MAX): what the guest tests and the oracle comparison read. A stream other than 0 is named (`#1`). */
  log: string[] = [];

  /** The output stream's state and parameters. */
  get state() {
    return this.streams[OUT].state;
  }
  get params() {
    return this.streams[OUT].params;
  }

  reset() {
    for (const st of this.streams) [st.state, st.params] = ['none', undefined];
  }

  /** A control request's reply (`room` bytes are writable: an info query's items must fit), what it does to the messages, and to which stream's. */
  control(cmd: Uint8Array, room: number): { reply: Uint8Array; effect: Effect; stream: number } {
    const [reply, effect, detail, stream] = this.answer(cmd, room);
    if (this.log.length < LOG_MAX && cmd.length >= 4) {
      const code = u32(cmd, 0);
      this.log.push(
        `${NAMES[code] ?? `0x${code.toString(16)}`}${stream > 0 ? `#${stream}` : ''}${detail} ${STATUS_NAMES[u32(reply, 0)]}`,
      );
    }
    return { reply, effect, stream };
  }

  private answer(cmd: Uint8Array, room: number): [Uint8Array, Effect, string, number] {
    if (cmd.length < 4) return [status(S_BAD_MSG), 'none', '', 0];
    const code = u32(cmd, 0);
    switch (code) {
      case R_JACK_INFO:
      case R_CHMAP_INFO:
      case R_PCM_INFO: {
        // virtio_snd_query_info: start_id, count, size. No jacks or channel maps.
        if (cmd.length < 16) return [status(S_BAD_MSG), 'none', '', 0];
        const [start, count, size] = [u32(cmd, 4), u32(cmd, 8), u32(cmd, 12)];
        const n = code === R_PCM_INFO ? STREAMS : 0;
        const detail = ` ${start}+${count}`;
        if (start > n || count > n - start || (count > 0 && (size < PCM_INFO_SIZE || 4 + count * size > room)))
          return [status(S_BAD_MSG), 'none', detail, 0];
        const r = status(S_OK, count * size);
        const v = new DataView(r.buffer);
        for (let k = 0; k < count; k++) {
          // virtio_snd_pcm_info: hda_fn_nid 0, features 0, formats (u64), rates (u64), direction, channels_min, channels_max.
          const at = 4 + k * size;
          v.setUint32(at + 8, (1 << FMT_S16) | (1 << FMT_S32) | (1 << FMT_FLOAT), true); // the u64s' high words stay 0
          v.setUint32(at + 16, RATE_BITS, true);
          r[at + 24] = start + k === IN ? 1 : 0; // VIRTIO_SND_D_INPUT, VIRTIO_SND_D_OUTPUT
          r[at + 25] = 1;
          r[at + 26] = CHANNELS_MAX;
        }
        return [r, 'none', detail, 0];
      }
      case R_JACK_REMAP:
        return [status(S_BAD_MSG), 'none', '', 0]; // no jack to remap
      case R_CTL_INFO:
      case R_CTL_ENUM_ITEMS:
      case R_CTL_READ:
      case R_CTL_WRITE:
      case R_CTL_TLV_READ:
      case R_CTL_TLV_WRITE:
      case R_CTL_TLV_COMMAND:
        return this.values.length ? [...this.ctl(code, cmd, room), 0] : [status(S_NOT_SUPP), 'none', '', 0];
      case R_PCM_SET_PARAMS:
      case R_PCM_PREPARE:
      case R_PCM_RELEASE:
      case R_PCM_START:
      case R_PCM_STOP: {
        if (cmd.length < (code === R_PCM_SET_PARAMS ? 24 : 8) || u32(cmd, 4) >= STREAMS)
          return [status(S_BAD_MSG), 'none', '', 0];
        const sid = u32(cmd, 4);
        const st = this.streams[sid];
        const s = st.state;
        const to = (ok: boolean, next: State, effect: Effect = 'none'): [Uint8Array, Effect, string, number] => {
          if (!ok) return [status(S_BAD_MSG), 'none', '', sid];
          st.state = next;
          return [status(S_OK), effect, '', sid];
        };
        if (code === R_PCM_SET_PARAMS) {
          // virtio_snd_pcm_set_params: buffer_bytes, period_bytes, features, channels, format, rate.
          const p: SndParams = {
            bufferBytes: u32(cmd, 8),
            periodBytes: u32(cmd, 12),
            channels: cmd[20],
            format: cmd[21],
            rate: RATES[cmd[22]] ?? 0,
          };
          const detail = ` ${p.channels}ch ${FORMAT_NAMES[p.format] ?? `fmt${cmd[21]}`} ${p.rate || `rate${cmd[22]}`} ${p.bufferBytes}/${p.periodBytes}`;
          if (!(s === 'none' || s === 'params' || s === 'prepared' || s === 'released'))
            return [status(S_BAD_MSG), 'none', detail, sid];
          if (
            u32(cmd, 16) !== 0 ||
            !SAMPLE_BYTES[p.format] ||
            cmd[22] > 31 ||
            !((RATE_BITS >> cmd[22]) & 1) ||
            p.channels < 1 ||
            p.channels > CHANNELS_MAX
          )
            return [status(S_NOT_SUPP), 'none', detail, sid];
          const frame = p.channels * SAMPLE_BYTES[p.format];
          if (
            p.periodBytes === 0 ||
            p.periodBytes % frame !== 0 ||
            p.bufferBytes === 0 ||
            p.bufferBytes % p.periodBytes !== 0
          )
            return [status(S_BAD_MSG), 'none', detail, sid];
          [st.params, st.state] = [p, 'params'];
          return [status(S_OK), 'none', detail, sid];
        }
        if (code === R_PCM_PREPARE) return to(s === 'params' || s === 'prepared' || s === 'released', 'prepared');
        if (code === R_PCM_START) return to(s === 'prepared' || s === 'stopped', 'started', 'start');
        if (code === R_PCM_STOP) return to(s === 'started', 'stopped', 'stop');
        return to(s === 'prepared' || s === 'stopped', 'released', 'release');
      }
      default:
        return [status(S_NOT_SUPP), 'none', '', 0];
    }
  }

  /** A control element request (with controls). */
  private ctl(code: number, cmd: Uint8Array, room: number): [Uint8Array, Effect, string] {
    const n = this.values.length;
    if (code === R_CTL_INFO) {
      // virtio_snd_query_info: start_id, count, size; each item a virtio_snd_ctl_info.
      if (cmd.length < 16) return [status(S_BAD_MSG), 'none', ''];
      const [start, count, size] = [u32(cmd, 4), u32(cmd, 8), u32(cmd, 12)];
      const detail = ` ${start}+${count}`;
      if (start > n || count > n - start || (count > 0 && (size < CTL_INFO_SIZE || 4 + count * size > room)))
        return [status(S_BAD_MSG), 'none', detail];
      const r = status(S_OK, count * size);
      const v = new DataView(r.buffer);
      for (let k = 0; k < count; k++) {
        // hda_fn_nid 0, role, type, access, count 1, index 0, name[44], then the integer's min, max, step.
        const at = 4 + k * size;
        const c = CONTROLS[start + k];
        v.setUint32(at + 4, c.role, true);
        v.setUint32(at + 8, c.type, true);
        v.setUint32(at + 12, c.access, true);
        v.setUint32(at + 16, 1, true);
        r.set(new TextEncoder().encode(c.name), at + 24);
        if (start + k === VOLUME) [0, VOLUME_MAX, 1].forEach((x, j) => v.setUint32(at + 72 + 4 * j, x, true));
      }
      return [r, 'none', detail];
    }
    // virtio_snd_ctl_hdr: control_id.
    if (cmd.length < 8 || u32(cmd, 4) >= n) return [status(S_BAD_MSG), 'none', ''];
    const id = u32(cmd, 4);
    if (code === R_CTL_READ) {
      if (room < 4 + CTL_VALUE_SIZE) return [status(S_BAD_MSG), 'none', ` ${id}`];
      const r = status(S_OK, CTL_VALUE_SIZE);
      new DataView(r.buffer).setUint32(4, this.values[id], true);
      return [r, 'none', ` ${id}=${this.values[id]}`];
    }
    if (code === R_CTL_WRITE) {
      // Then a virtio_snd_ctl_value: one member.
      if (cmd.length < 12) return [status(S_BAD_MSG), 'none', ` ${id}`];
      const value = u32(cmd, 8);
      if (value > (id === VOLUME ? VOLUME_MAX : 1)) return [status(S_BAD_MSG), 'none', ` ${id}=${value}`];
      return [status(S_OK), this.set(id, value) ? 'mixer' : 'none', ` ${id}=${value}`];
    }
    if (code === R_CTL_TLV_READ) {
      if (id !== VOLUME || room < 4 + 4 * VOLUME_TLV.length) return [status(S_BAD_MSG), 'none', ` ${id}`];
      const r = status(S_OK, 4 * VOLUME_TLV.length);
      VOLUME_TLV.forEach((x, j) => new DataView(r.buffer).setUint32(4 + 4 * j, x, true));
      return [r, 'none', ` ${id}`];
    }
    // No enumerated control; the TLV is read only.
    return [status(code === R_CTL_ENUM_ITEMS ? S_BAD_MSG : S_NOT_SUPP), 'none', ` ${id}`];
  }

  /**
   * What to do with an I/O message on stream `sid` (the output's on txq, the input's on rxq; `head`: its first
   * readable bytes, the stream id; `frameBytes`: the bytes of frames it carries or has room for): run it
   * (started), hold it (prepared or stopped), or answer with a status.
   */
  io(sid: number, head: Uint8Array, frameBytes: number): 'run' | 'hold' | number {
    if (head.length < 4 || u32(head, 0) !== sid) return S_BAD_MSG;
    const { state, params } = this.streams[sid];
    if (
      !params ||
      frameBytes < 0 ||
      (sid === IN && frameBytes === 0) ||
      frameBytes % (params.channels * SAMPLE_BYTES[params.format]) !== 0
    )
      return S_BAD_MSG;
    return state === 'started' ? 'run' : state === 'prepared' || state === 'stopped' ? 'hold' : S_BAD_MSG;
  }

  save() {
    return {
      streams: this.streams.map((st) => ({ state: st.state, params: st.params ?? null })),
      log: [...this.log],
      ...(this.values.length ? { controls: [...this.values] } : {}),
    };
  }

  /** A saved state (`save`'s). */
  restore(state: unknown) {
    const saved = state as { streams?: { state: State; params: SndParams | null }[]; log: unknown[] };
    const streams = saved?.streams; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- a snapshot's: anything
    if (
      !Array.isArray(streams) ||
      streams.length !== STREAMS ||
      !Array.isArray(saved.log) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a snapshot's: anything
      streams.some((st) => !STATES.includes(st?.state) || (st.state !== 'none' && !st.params))
    )
      throw new Error('the snapshot has no state for the sound device');
    this.streams = streams.map((st) => ({ state: st.state, params: st.params ?? undefined }));
    this.log = saved.log.map(String);
    // The controls' values, if it has them (a device without `mixer` has none: the page's stay).
    const controls = (state as { controls?: unknown }).controls;
    if (Array.isArray(controls)) controls.forEach((v, id) => typeof v === 'number' && this.set(id, v));
  }
}
