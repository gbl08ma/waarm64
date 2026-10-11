//! The native twin of web/snd.ts: virtio-snd with an output and an input stream, no jacks or channel
//! maps, the deterministic sink and source, answering exactly as that backend does (the same statuses,
//! the same state machines, the same completions at the same exits, the same control log, the same
//! recorded frames), so the snd test guest keeps one step count in every runner. `T` is what the runner
//! holds an I/O message as (a `Request`); the device reads a transmit message's frames through the
//! runner when it plays it, and gives a receive message's frames back to it to write.

use std::collections::VecDeque;

pub const CONTROLQ: u32 = 0;
pub const EVENTQ: u32 = 1;
pub const TXQ: u32 = 2;
pub const RXQ: u32 = 3;
const OUT: usize = 0;
const IN: usize = 1;

const R_JACK_INFO: u32 = 1;
const R_JACK_REMAP: u32 = 2;
const R_PCM_INFO: u32 = 0x100;
const R_PCM_SET_PARAMS: u32 = 0x101;
const R_PCM_PREPARE: u32 = 0x102;
const R_PCM_RELEASE: u32 = 0x103;
const R_PCM_START: u32 = 0x104;
const R_PCM_STOP: u32 = 0x105;
const R_CHMAP_INFO: u32 = 0x200;
pub const S_OK: u32 = 0x8000;
pub const S_BAD_MSG: u32 = 0x8001;
const S_NOT_SUPP: u32 = 0x8002;

const FMT_S16: u8 = 5;
const FMT_S32: u8 = 17;
const FMT_FLOAT: u8 = 19;
const RATES: [u32; 14] = [
    5512, 8000, 11025, 16000, 22050, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000,
    384000,
];
/// 8 kHz to 192 kHz (web/snd.ts `RATE_BITS`).
const RATE_BITS: u32 = 0x1ffe;
const CHANNELS_MAX: u8 = 2;
const PCM_INFO_SIZE: u32 = 32;
const STREAMS: u32 = 2;
const LOG_MAX: usize = 64;
const FNV_OFFSET: u32 = 0x811c_9dc5;

/// The configuration space: jacks 0, streams 2 (out, in), chmaps 0.
pub const CONFIG: [u8; 12] = [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0];

fn sample_bytes(format: u8) -> Option<u32> {
    match format {
        FMT_S16 => Some(2),
        FMT_S32 | FMT_FLOAT => Some(4),
        _ => None,
    }
}

fn format_name(format: u8) -> String {
    match format {
        FMT_S16 => "S16".into(),
        FMT_S32 => "S32".into(),
        FMT_FLOAT => "FLOAT".into(),
        f => format!("fmt{f}"),
    }
}

fn request_name(code: u32) -> String {
    match code {
        R_JACK_INFO => "JACK_INFO".into(),
        R_JACK_REMAP => "JACK_REMAP".into(),
        R_PCM_INFO => "PCM_INFO".into(),
        R_PCM_SET_PARAMS => "PCM_SET_PARAMS".into(),
        R_PCM_PREPARE => "PCM_PREPARE".into(),
        R_PCM_RELEASE => "PCM_RELEASE".into(),
        R_PCM_START => "PCM_START".into(),
        R_PCM_STOP => "PCM_STOP".into(),
        R_CHMAP_INFO => "CHMAP_INFO".into(),
        c => format!("0x{c:x}"),
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn status(s: u32) -> Vec<u8> {
    s.to_le_bytes().to_vec()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    None,
    Params,
    Prepared,
    Started,
    Stopped,
    Released,
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub buffer_bytes: u32,
    pub period_bytes: u32,
    pub channels: u8,
    pub format: u8,
}

impl Params {
    fn frame(&self) -> u32 {
        self.channels as u32 * sample_bytes(self.format).unwrap()
    }
}

/// What the sink played, or the source recorded (web/snd.ts `Played`, `Recorded`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Played {
    pub frames: u64,
    pub bytes: u64,
    pub messages: u64,
    pub fnv: u32,
}

impl Played {
    fn new() -> Played {
        Played {
            fnv: FNV_OFFSET,
            ..Played::default()
        }
    }

    fn add(&mut self, p: &Params, b: &[u8]) {
        self.frames += (b.len() as u32 / p.frame()) as u64;
        self.bytes += b.len() as u64;
        self.messages += 1;
        self.fnv = fnv1a(b, self.fnv);
    }
}

/// FNV-1a (32-bit) of `b`, continuing from `h`.
pub fn fnv1a(b: &[u8], mut h: u32) -> u32 {
    for &x in b {
        h = (h ^ x as u32).wrapping_mul(0x0100_0193);
    }
    h
}

/// A triangle wave of `period` frames between ±12000 (web/snd.ts `triangle`).
fn triangle(n: u64, period: u64) -> i32 {
    let ph = (n % period) as i32;
    let (p, step) = (period as i32, 48000 / period as i32);
    if ph < p / 2 {
        -12000 + step * ph
    } else {
        36000 - step * ph
    }
}

/// The deterministic source's waveform from frame `from` on, `bytes` of it (web/snd.ts `pattern`):
/// a 1 kHz triangle left, 1.5 kHz right; mono gets the left.
pub fn pattern(p: &Params, from: u64, bytes: u32) -> Vec<u8> {
    let size = sample_bytes(p.format).unwrap();
    let mut out = Vec::with_capacity(bytes as usize);
    for f in 0..(bytes / p.frame()) as u64 {
        for c in 0..p.channels {
            let x = triangle(from + f, if c == 0 { 48 } else { 32 });
            match size {
                2 => out.extend((x as i16).to_le_bytes()),
                _ if p.format == FMT_S32 => out.extend((x * 65536).to_le_bytes()),
                _ => out.extend((x as f32 / 32768.0).to_le_bytes()),
            }
        }
    }
    out
}

/// A stream: its state and parameters.
#[derive(Clone, Copy, Debug)]
pub struct Stream {
    pub state: State,
    pub params: Option<Params>,
}

/// What `tick` completes: a transmit message (status OK), or a receive message with its frames.
pub enum Done<T> {
    Tx(T),
    Rx(T, Vec<u8>),
}

/// The device: the protocol (web/snd.ts `Snd`), the messages held, the deterministic sink
/// (`checksumSink`) and source (`patternSource`): messages played or filled at the end of an exit
/// (`tick`), at most a buffer less a period per exit each.
pub struct Device<T> {
    pub streams: [Stream; 2],
    pub log: Vec<String>,
    pub played: Played,
    pub recorded: Played,
    /// I/O messages waiting for their stream's START, with the bytes of frames they carry or have room for.
    waiting: [VecDeque<(T, u32)>; 2],
    /// Given to the sink, not played yet: the stream's parameters and the frames with each.
    queue: VecDeque<(Params, Vec<u8>, T)>,
    /// Given to the source, not filled yet: the parameters and the bytes of frames asked for.
    asked: VecDeque<(Params, u32, T)>,
    running: [bool; 2],
    /// Event buffers, held: no events yet.
    pub events: Vec<T>,
}

impl<T> Default for Device<T> {
    fn default() -> Self {
        let none = Stream {
            state: State::None,
            params: None,
        };
        Device {
            streams: [none; 2],
            log: Vec::new(),
            played: Played::new(),
            recorded: Played::new(),
            waiting: [VecDeque::new(), VecDeque::new()],
            queue: VecDeque::new(),
            asked: VecDeque::new(),
            running: [false; 2],
            events: Vec::new(),
        }
    }
}

impl<T> Device<T> {
    /// The chains held (for a snapshot: the restored VM posts them again).
    pub fn holds(&self) -> usize {
        self.waiting.iter().map(VecDeque::len).sum::<usize>()
            + self.queue.len()
            + self.asked.len()
            + self.events.len()
    }

    /// The VM was replaced by one restored from its snapshot: what was held goes with it.
    pub fn restored(&mut self) {
        self.waiting.iter_mut().for_each(VecDeque::clear);
        self.queue.clear();
        self.asked.clear();
        self.events.clear();
    }

    /// A virtio reset.
    pub fn reset(&mut self) {
        self.restored();
        for st in &mut self.streams {
            (st.state, st.params) = (State::None, None);
        }
        self.running = [false; 2];
    }

    /// A control request (`room` writable bytes): the reply, and the messages to complete with OK
    /// now (RELEASE returns its stream's). `frames` reads a held message's frames when START plays it.
    pub fn control(
        &mut self,
        cmd: &[u8],
        room: usize,
        frames: impl Fn(&T) -> Vec<u8>,
    ) -> (Vec<u8>, Vec<T>) {
        let (reply, detail, sid) = self.answer(cmd, room);
        if self.log.len() < LOG_MAX && cmd.len() >= 4 {
            let st = match u32_at(&reply, 0) {
                S_OK => "OK",
                S_BAD_MSG => "BAD_MSG",
                _ => "NOT_SUPP",
            };
            let name = if sid > 0 {
                format!("#{sid}")
            } else {
                String::new()
            };
            self.log.push(format!(
                "{}{name}{detail} {st}",
                request_name(u32_at(cmd, 0))
            ));
        }
        let mut back = Vec::new();
        if u32_at(&reply, 0) == S_OK && cmd.len() >= 4 {
            match u32_at(cmd, 0) {
                R_PCM_START => {
                    self.running[sid] = true;
                    let p = self.streams[sid].params.unwrap();
                    while let Some((t, n)) = self.waiting[sid].pop_front() {
                        self.run(sid, p, t, n, &frames);
                    }
                }
                R_PCM_STOP => self.running[sid] = false,
                R_PCM_RELEASE => {
                    self.running[sid] = false;
                    if sid == OUT {
                        back.extend(self.queue.drain(..).map(|(_, _, t)| t));
                    } else {
                        back.extend(self.asked.drain(..).map(|(_, _, t)| t));
                    }
                    back.extend(self.waiting[sid].drain(..).map(|(t, _)| t));
                }
                _ => {}
            }
        }
        (reply, back)
    }

    /// Gives an I/O message to the sink (its frames read through `frames`) or the source (`n` bytes of frames asked for).
    fn run(&mut self, sid: usize, p: Params, t: T, n: u32, frames: &impl Fn(&T) -> Vec<u8>) {
        if sid == OUT {
            let f = frames(&t);
            self.queue.push_back((p, f[4..].to_vec(), t));
        } else {
            self.asked.push_back((p, n, t));
        }
    }

    fn answer(&mut self, cmd: &[u8], room: usize) -> (Vec<u8>, String, usize) {
        let bad = || (status(S_BAD_MSG), String::new(), 0);
        if cmd.len() < 4 {
            return bad();
        }
        let code = u32_at(cmd, 0);
        match code {
            R_JACK_INFO | R_CHMAP_INFO | R_PCM_INFO => {
                if cmd.len() < 16 {
                    return bad();
                }
                let (start, count, size) = (u32_at(cmd, 4), u32_at(cmd, 8), u32_at(cmd, 12));
                let n = if code == R_PCM_INFO { STREAMS } else { 0 };
                let detail = format!(" {start}+{count}");
                if start > n
                    || count > n - start
                    || (count > 0
                        && (size < PCM_INFO_SIZE || 4 + count as u64 * size as u64 > room as u64))
                {
                    return (status(S_BAD_MSG), detail, 0);
                }
                let mut r = status(S_OK);
                for k in 0..count {
                    let mut item = vec![0u8; size as usize];
                    let formats: u32 = 1 << FMT_S16 | 1 << FMT_S32 | 1 << FMT_FLOAT;
                    item[8..12].copy_from_slice(&formats.to_le_bytes());
                    item[16..20].copy_from_slice(&RATE_BITS.to_le_bytes());
                    item[24] = u8::from((start + k) as usize == IN); // input, output
                    item[25] = 1;
                    item[26] = CHANNELS_MAX;
                    r.extend(item);
                }
                (r, detail, 0)
            }
            R_JACK_REMAP => bad(),
            R_PCM_SET_PARAMS | R_PCM_PREPARE | R_PCM_RELEASE | R_PCM_START | R_PCM_STOP => {
                let need = if code == R_PCM_SET_PARAMS { 24 } else { 8 };
                if cmd.len() < need || u32_at(cmd, 4) >= STREAMS {
                    return bad();
                }
                let sid = u32_at(cmd, 4) as usize;
                let s = self.streams[sid].state;
                if code == R_PCM_SET_PARAMS {
                    let (format, rate) = (cmd[21], cmd[22]);
                    let p = Params {
                        buffer_bytes: u32_at(cmd, 8),
                        period_bytes: u32_at(cmd, 12),
                        channels: cmd[20],
                        format,
                    };
                    let rate_name = match RATES.get(rate as usize) {
                        Some(r) => r.to_string(),
                        None => format!("rate{rate}"),
                    };
                    let detail = format!(
                        " {}ch {} {rate_name} {}/{}",
                        p.channels,
                        format_name(format),
                        p.buffer_bytes,
                        p.period_bytes
                    );
                    if !matches!(
                        s,
                        State::None | State::Params | State::Prepared | State::Released
                    ) {
                        return (status(S_BAD_MSG), detail, sid);
                    }
                    if u32_at(cmd, 16) != 0
                        || sample_bytes(format).is_none()
                        || rate > 31
                        || RATE_BITS >> rate & 1 == 0
                        || !(1..=CHANNELS_MAX).contains(&p.channels)
                    {
                        return (status(S_NOT_SUPP), detail, sid);
                    }
                    if p.period_bytes == 0
                        || !p.period_bytes.is_multiple_of(p.frame())
                        || p.buffer_bytes == 0
                        || !p.buffer_bytes.is_multiple_of(p.period_bytes)
                    {
                        return (status(S_BAD_MSG), detail, sid);
                    }
                    self.streams[sid] = Stream {
                        state: State::Params,
                        params: Some(p),
                    };
                    return (status(S_OK), detail, sid);
                }
                let (ok, next) = match code {
                    R_PCM_PREPARE => (
                        matches!(s, State::Params | State::Prepared | State::Released),
                        State::Prepared,
                    ),
                    R_PCM_START => (
                        matches!(s, State::Prepared | State::Stopped),
                        State::Started,
                    ),
                    R_PCM_STOP => (s == State::Started, State::Stopped),
                    _ => (
                        matches!(s, State::Prepared | State::Stopped),
                        State::Released,
                    ),
                };
                if !ok {
                    return (status(S_BAD_MSG), String::new(), sid);
                }
                self.streams[sid].state = next;
                (status(S_OK), String::new(), sid)
            }
            _ => (status(S_NOT_SUPP), String::new(), 0),
        }
    }

    /// An I/O message on stream `sid` (`head`: its first readable bytes; `frame_bytes`: the frames
    /// it carries or has room for): `Some((t, status))` to complete now, or None if it's held.
    fn io(
        &mut self,
        sid: usize,
        head: &[u8],
        frame_bytes: Option<usize>,
        t: T,
        frames: impl Fn(&T) -> Vec<u8>,
    ) -> Option<(T, u32)> {
        let Stream { state, params } = self.streams[sid];
        let Some(p) = params else {
            return Some((t, S_BAD_MSG));
        };
        let Some(n) = frame_bytes else {
            return Some((t, S_BAD_MSG));
        };
        if head.len() < 4
            || u32_at(head, 0) as usize != sid
            || (sid == IN && n == 0)
            || !n.is_multiple_of(p.frame() as usize)
        {
            return Some((t, S_BAD_MSG));
        }
        match state {
            State::Started => {
                self.run(sid, p, t, n as u32, &frames);
                None
            }
            State::Prepared | State::Stopped => {
                self.waiting[sid].push_back((t, n as u32));
                None
            }
            _ => Some((t, S_BAD_MSG)),
        }
    }

    /// A transmit message (`head`: its first readable bytes; `len`: all of them).
    pub fn tx(
        &mut self,
        head: &[u8],
        len: usize,
        t: T,
        frames: impl Fn(&T) -> Vec<u8>,
    ) -> Option<(T, u32)> {
        self.io(OUT, head, len.checked_sub(4), t, frames)
    }

    /// A receive message (`head`: its first readable bytes; `room`: its writable bytes, the frames
    /// and the status).
    pub fn rx(&mut self, head: &[u8], room: usize, t: T) -> Option<(T, u32)> {
        self.io(IN, head, room.checked_sub(8), t, |_| Vec::new())
    }

    /// The end of a DEVICE exit's requests: the sink plays what it was given and the source fills
    /// what it was asked for, at most a buffer less a period each (web/snd.ts `checksumSink` says why).
    pub fn tick(&mut self) -> Vec<Done<T>> {
        let mut done = Vec::new();
        let mut burst = 0u32;
        while self.running[OUT] {
            let Some((p, f, _)) = self.queue.front() else {
                break;
            };
            let n = f.len() as u32;
            if burst > 0 && burst + n > p.buffer_bytes - p.period_bytes {
                break;
            }
            let (p, f, t) = self.queue.pop_front().unwrap();
            burst += n;
            self.played.add(&p, &f);
            done.push(Done::Tx(t));
        }
        let mut burst = 0u32;
        while self.running[IN] {
            let Some(&(p, n, _)) = self.asked.front() else {
                break;
            };
            if burst > 0 && burst + n > p.buffer_bytes - p.period_bytes {
                break;
            }
            let (p, n, t) = self.asked.pop_front().unwrap();
            burst += n;
            let data = pattern(&p, self.recorded.frames, n);
            self.recorded.add(&p, &data);
            done.push(Done::Rx(t, data));
        }
        done
    }
}
