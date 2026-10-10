//! The native twin of web/snd.ts: virtio-snd with one output stream, no jacks or channel maps,
//! and the deterministic sink, answering exactly as that backend does (the same statuses, the same
//! state machine, the same completions at the same exits, the same control log), so the snd test
//! guest keeps one step count in every runner. `T` is what the runner holds a transmit message as
//! (a `Request`); the device reads its frames through the runner when it plays it.

use std::collections::VecDeque;

pub const CONTROLQ: u32 = 0;
pub const EVENTQ: u32 = 1;
pub const TXQ: u32 = 2;

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
const STREAMS: u32 = 1;
const LOG_MAX: usize = 64;
const FNV_OFFSET: u32 = 0x811c_9dc5;

/// The configuration space: jacks 0, streams 1, chmaps 0.
pub const CONFIG: [u8; 12] = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];

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

/// What the sink played (web/snd.ts `Played`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Played {
    pub frames: u64,
    pub bytes: u64,
    pub messages: u64,
    pub fnv: u32,
}

/// FNV-1a (32-bit) of `b`, continuing from `h`.
pub fn fnv1a(b: &[u8], mut h: u32) -> u32 {
    for &x in b {
        h = (h ^ x as u32).wrapping_mul(0x0100_0193);
    }
    h
}

/// The device: the protocol (web/snd.ts `Snd`), the messages held, and the deterministic sink
/// (`checksumSink`): messages played at the end of an exit (`tick`), at most a buffer less a
/// period per exit.
pub struct Device<T> {
    pub state: State,
    pub params: Option<Params>,
    pub log: Vec<String>,
    pub played: Played,
    /// Transmit messages waiting for START.
    waiting: VecDeque<T>,
    /// Given to the sink, not played yet: the stream's parameters and the frames with each.
    queue: VecDeque<(Params, Vec<u8>, T)>,
    running: bool,
    /// Event buffers, held: no events yet.
    pub events: Vec<T>,
}

impl<T> Default for Device<T> {
    fn default() -> Self {
        Device {
            state: State::None,
            params: None,
            log: Vec::new(),
            played: Played {
                fnv: FNV_OFFSET,
                ..Played::default()
            },
            waiting: VecDeque::new(),
            queue: VecDeque::new(),
            running: false,
            events: Vec::new(),
        }
    }
}

impl<T> Device<T> {
    /// The chains held (for a snapshot: the restored VM posts them again).
    pub fn holds(&self) -> usize {
        self.waiting.len() + self.queue.len() + self.events.len()
    }

    /// The VM was replaced by one restored from its snapshot: what was held goes with it.
    pub fn restored(&mut self) {
        self.waiting.clear();
        self.queue.clear();
        self.events.clear();
    }

    /// A virtio reset.
    pub fn reset(&mut self) {
        self.restored();
        self.state = State::None;
        self.params = None;
        self.running = false;
    }

    /// A control request (`room` writable bytes): the reply, and the messages to complete with OK
    /// now (RELEASE returns them all). `frames` reads a held message's frames when START plays it.
    pub fn control(
        &mut self,
        cmd: &[u8],
        room: usize,
        frames: impl Fn(&T) -> Vec<u8>,
    ) -> (Vec<u8>, Vec<T>) {
        let (reply, detail) = self.answer(cmd, room);
        if self.log.len() < LOG_MAX && cmd.len() >= 4 {
            let st = match u32_at(&reply, 0) {
                S_OK => "OK",
                S_BAD_MSG => "BAD_MSG",
                _ => "NOT_SUPP",
            };
            self.log
                .push(format!("{}{detail} {st}", request_name(u32_at(cmd, 0))));
        }
        let mut back = Vec::new();
        if u32_at(&reply, 0) == S_OK && cmd.len() >= 4 {
            match u32_at(cmd, 0) {
                R_PCM_START => {
                    self.running = true;
                    let p = self.params.unwrap();
                    while let Some(t) = self.waiting.pop_front() {
                        let f = frames(&t);
                        self.queue.push_back((p, f[4..].to_vec(), t));
                    }
                }
                R_PCM_STOP => self.running = false,
                R_PCM_RELEASE => {
                    self.running = false;
                    back.extend(self.queue.drain(..).map(|(_, _, t)| t));
                    back.extend(self.waiting.drain(..));
                }
                _ => {}
            }
        }
        (reply, back)
    }

    fn answer(&mut self, cmd: &[u8], room: usize) -> (Vec<u8>, String) {
        let bad = || (status(S_BAD_MSG), String::new());
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
                    return (status(S_BAD_MSG), detail);
                }
                let mut r = status(S_OK);
                for _ in 0..count {
                    let mut item = vec![0u8; size as usize];
                    let formats: u32 = 1 << FMT_S16 | 1 << FMT_S32 | 1 << FMT_FLOAT;
                    item[8..12].copy_from_slice(&formats.to_le_bytes());
                    item[16..20].copy_from_slice(&RATE_BITS.to_le_bytes());
                    item[24] = 0; // output
                    item[25] = 1;
                    item[26] = CHANNELS_MAX;
                    r.extend(item);
                }
                (r, detail)
            }
            R_JACK_REMAP => bad(),
            R_PCM_SET_PARAMS | R_PCM_PREPARE | R_PCM_RELEASE | R_PCM_START | R_PCM_STOP => {
                let need = if code == R_PCM_SET_PARAMS { 24 } else { 8 };
                if cmd.len() < need || u32_at(cmd, 4) >= STREAMS {
                    return bad();
                }
                let s = self.state;
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
                        return (status(S_BAD_MSG), detail);
                    }
                    if u32_at(cmd, 16) != 0
                        || sample_bytes(format).is_none()
                        || rate > 31
                        || RATE_BITS >> rate & 1 == 0
                        || !(1..=CHANNELS_MAX).contains(&p.channels)
                    {
                        return (status(S_NOT_SUPP), detail);
                    }
                    if p.period_bytes == 0
                        || !p.period_bytes.is_multiple_of(p.frame())
                        || p.buffer_bytes == 0
                        || !p.buffer_bytes.is_multiple_of(p.period_bytes)
                    {
                        return (status(S_BAD_MSG), detail);
                    }
                    self.params = Some(p);
                    self.state = State::Params;
                    return (status(S_OK), detail);
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
                    return bad();
                }
                self.state = next;
                (status(S_OK), String::new())
            }
            _ => (status(S_NOT_SUPP), String::new()),
        }
    }

    /// A transmit message (`head`: its first readable bytes; `len`: all of them): `Some((t,
    /// status))` to complete now, or None if it's held (waiting for START, or given to the sink).
    pub fn tx(
        &mut self,
        head: &[u8],
        len: usize,
        t: T,
        frames: impl Fn(&T) -> Vec<u8>,
    ) -> Option<(T, u32)> {
        let Some(p) = self.params else {
            return Some((t, S_BAD_MSG));
        };
        if len < 4 || head.len() < 4 || u32_at(head, 0) >= STREAMS {
            return Some((t, S_BAD_MSG));
        }
        if !(len - 4).is_multiple_of(p.frame() as usize) {
            return Some((t, S_BAD_MSG));
        }
        match self.state {
            State::Started => {
                let f = frames(&t);
                self.queue.push_back((p, f[4..].to_vec(), t));
                None
            }
            State::Prepared | State::Stopped => {
                self.waiting.push_back(t);
                None
            }
            _ => Some((t, S_BAD_MSG)),
        }
    }

    /// The end of a DEVICE exit's requests: the sink plays what it was given, at most a buffer
    /// less a period (web/snd.ts `checksumSink` says why). Returns the messages to complete with OK.
    pub fn tick(&mut self) -> Vec<T> {
        let mut done = Vec::new();
        let mut burst = 0u32;
        while self.running {
            let Some((p, f, _)) = self.queue.front() else {
                break;
            };
            let n = f.len() as u32;
            if burst > 0 && burst + n > p.buffer_bytes - p.period_bytes {
                break;
            }
            let (p, f, t) = self.queue.pop_front().unwrap();
            burst += n;
            self.played.frames += (f.len() as u32 / p.frame()) as u64;
            self.played.bytes += f.len() as u64;
            self.played.messages += 1;
            self.played.fnv = fnv1a(&f, self.played.fnv);
            done.push(t);
        }
        done
    }
}
