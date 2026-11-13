//! The native twin of web/gpu.ts and web/edid.ts: virtio-gpu 2D over host
//! RGBA resources, answering exactly as that backend does (the same errors,
//! the same EDID bytes, the same pixels), so the gpu test guest keeps one step
//! count in every runner. The state hashes (`State`) are what the runners
//! compare with the Node and Chromium runs.

use std::collections::HashMap;

pub const RAM_BASE: u64 = 0x4000_0000;
const HDR: usize = 24;

const GET_DISPLAY_INFO: u32 = 0x100;
const RESOURCE_CREATE_2D: u32 = 0x101;
const RESOURCE_UNREF: u32 = 0x102;
const SET_SCANOUT: u32 = 0x103;
const RESOURCE_FLUSH: u32 = 0x104;
const TRANSFER_TO_HOST_2D: u32 = 0x105;
const RESOURCE_ATTACH_BACKING: u32 = 0x106;
const RESOURCE_DETACH_BACKING: u32 = 0x107;
const GET_EDID: u32 = 0x10a;
const UPDATE_CURSOR: u32 = 0x300;
const MOVE_CURSOR: u32 = 0x301;
const OK_NODATA: u32 = 0x1100;
const OK_DISPLAY_INFO: u32 = 0x1101;
const OK_EDID: u32 = 0x1104;
const ERR_UNSPEC: u32 = 0x1200;
const ERR_OUT_OF_MEMORY: u32 = 0x1201;
const ERR_INVALID_SCANOUT_ID: u32 = 0x1202;
const ERR_INVALID_RESOURCE_ID: u32 = 0x1203;
const ERR_INVALID_PARAMETER: u32 = 0x1205;
const FLAG_FENCE: u32 = 1;

const MAX_RESOURCE: u64 = 64 << 20;
const MAX_TOTAL: u64 = 256 << 20;
const MAX_ENTRIES: u32 = 16384;
const CURSOR: u32 = 64;

pub const EDID_MAX: u32 = 4095;
pub const EDID_MIN: (u32, u32) = (480, 300);

/// Byte positions of R, G, B and A in each format's memory order; an X format's unused byte is
/// kept as alpha (web/gpu.ts `FORMATS` says why).
fn format(f: u32) -> Option<[usize; 4]> {
    Some(match f {
        1 | 2 => [2, 1, 0, 3],
        3 | 4 => [1, 2, 3, 0],
        67 | 134 => [0, 1, 2, 3],
        68 | 121 => [3, 2, 1, 0],
        _ => return None,
    })
}

// ---- EDID (web/edid.ts) ----

struct Timing {
    clock_khz: u32,
    h_active: u32,
    h_blank: u32,
    h_front: u32,
    h_sync: u32,
    v_active: u32,
    v_blank: u32,
    v_front: u32,
    v_sync: u32,
}

fn cvt_rb(w: u32, h: u32, hz: u32) -> Timing {
    let (h_blank, h_front, h_sync, v_front, min_back) = (160u32, 48u32, 32u32, 3u32, 6u32);
    let r = w as f64 * 100.0 / h as f64;
    let near = |x: f64| (r - x).abs() < 1.0;
    let v_sync = if near(400.0 / 3.0) {
        4
    } else if near(1600.0 / 9.0) {
        5
    } else if near(160.0) {
        6
    } else if near(125.0) || near(500.0 / 3.0) {
        7
    } else {
        10
    };
    let h_period = (1e6 / hz as f64 - 460.0) / h as f64;
    let vbi = ((460.0 / h_period).floor() as u32 + 1).max(v_front + v_sync + min_back);
    let v_total = h + vbi;
    let h_total = w + h_blank;
    let clock_khz = (hz as f64 * v_total as f64 * h_total as f64 / 250_000.0).floor() as u32 * 250;
    Timing {
        clock_khz,
        h_active: w,
        h_blank,
        h_front,
        h_sync,
        v_active: h,
        v_blank: vbi,
        v_front,
        v_sync,
    }
}

fn timings(w: u32, h: u32) -> Timing {
    for hz in (25..=60).rev() {
        let t = cvt_rb(w, h, hz);
        if t.clock_khz / 10 <= 0xffff {
            return t;
        }
    }
    cvt_rb(w, h, 24)
}

fn dtd(t: &Timing, mm_w: u32, mm_h: u32) -> [u8; 18] {
    let mut d = [0u8; 18];
    let px = t.clock_khz / 10;
    d[0] = px as u8;
    d[1] = (px >> 8) as u8;
    d[2] = t.h_active as u8;
    d[3] = t.h_blank as u8;
    d[4] = ((t.h_active >> 8) << 4 | t.h_blank >> 8) as u8;
    d[5] = t.v_active as u8;
    d[6] = t.v_blank as u8;
    d[7] = ((t.v_active >> 8) << 4 | t.v_blank >> 8) as u8;
    d[8] = t.h_front as u8;
    d[9] = t.h_sync as u8;
    d[10] = ((t.v_front & 0xf) << 4 | t.v_sync & 0xf) as u8;
    d[11] = ((t.h_front >> 8) << 6 | (t.h_sync >> 8) << 4 | (t.v_front >> 4) << 2 | t.v_sync >> 4)
        as u8;
    d[12] = mm_w as u8;
    d[13] = mm_h as u8;
    d[14] = ((mm_w >> 8) << 4 | mm_h >> 8) as u8;
    d[17] = 0x1a;
    d
}

fn descriptor(tag: u8, data: &[u8]) -> [u8; 18] {
    let mut d = [0u8; 18];
    d[3] = tag;
    d[5..5 + data.len().min(13)].copy_from_slice(&data[..data.len().min(13)]);
    d
}

/// web/edid.ts `edid`: the base block for `width`×`height` at `dpi`, with up to two extra modes.
pub fn edid(width: u32, height: u32, dpi: u32, extra: &[(u32, u32)]) -> [u8; 128] {
    assert!(
        (EDID_MIN.0..=EDID_MAX).contains(&width) && (EDID_MIN.1..=EDID_MAX).contains(&height),
        "EDID size {width}x{height}"
    );
    let mut e = [0u8; 128];
    e[..8].copy_from_slice(&[0, 255, 255, 255, 255, 255, 255, 0]);
    let id = (87 - 64) << 10 | (65 - 64) << 5 | (77 - 64);
    e[8] = (id >> 8) as u8;
    e[9] = id as u8;
    e[10] = 1;
    e[16] = 1;
    e[17] = 36; // 2026 - 1990
    e[18] = 1;
    e[19] = 4;
    e[20] = 0xa5;
    let mm = |px: u32| ((px as f64 * 25.4 / dpi as f64).round() as u32).max(1);
    let (mm_w, mm_h) = (mm(width), mm(height));
    e[21] = (((mm_w as f64 / 10.0).round() as u32).clamp(1, 255)) as u8;
    e[22] = (((mm_h as f64 / 10.0).round() as u32).clamp(1, 255)) as u8;
    e[23] = 120;
    e[24] = 0x06;
    e[25..35].copy_from_slice(&[0xee, 0x91, 0xa3, 0x54, 0x4c, 0x99, 0x26, 0x0f, 0x50, 0x54]);
    e[38..54].fill(0x01);
    let t = timings(width, height);
    e[54..72].copy_from_slice(&dtd(&t, mm_w, mm_h));
    let extra = &extra[..extra.len().min(2)];
    let mut modes = vec![t];
    let mut more = Vec::new();
    for &(w, h) in extra {
        let m = timings(w, h);
        more.push(dtd(&m, mm_w, mm_h));
        modes.push(m);
    }
    let clock = modes.iter().map(|m| m.clock_khz).max().unwrap();
    let h_max = modes
        .iter()
        .map(|m| m.clock_khz.div_ceil(m.h_active + m.h_blank))
        .max()
        .unwrap();
    let range = descriptor(
        0xfd,
        &[
            24,
            75,
            15,
            h_max.clamp(15, 255) as u8,
            clock.div_ceil(10_000).min(255) as u8,
            0x01,
            0x0a,
            0x20,
            0x20,
            0x20,
            0x20,
            0x20,
            0x20,
        ],
    );
    let mut name = b"waarm64\n".to_vec();
    name.resize(13, 0x20);
    let mut order: Vec<[u8; 18]> = more;
    order.push(range);
    order.push(descriptor(0xfc, &name));
    order.truncate(3);
    while order.len() < 3 {
        order.push(descriptor(0x10, &[]));
    }
    for (k, d) in order.iter().enumerate() {
        e[72 + 18 * k..90 + 18 * k].copy_from_slice(d);
    }
    let sum: u32 = e[..127].iter().map(|&b| b as u32).sum();
    e[127] = ((256 - sum % 256) % 256) as u8;
    e
}

// ---- the device (web/gpu.ts) ----

#[derive(Clone, Copy)]
pub struct Options {
    pub width: u32,
    pub height: u32,
    /// After this many flushes the display changes to the size given (web/gpu.ts `resize`).
    pub resize: Option<(u32, u32, u32)>,
    /// Hash the scanout at every flush (web/gpu.ts `trace`).
    pub trace: bool,
}

#[derive(Clone, Copy, Default)]
struct Rect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

struct Resource {
    format: u32,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    /// RAM offsets and lengths of the guest's pages.
    backing: Option<Vec<(u64, u64)>>,
    /// Shown on the scanout: alpha is 255 (web/gpu.ts `makeOpaque`).
    opaque: bool,
}

/// What a runner compares with the Node and Chromium runs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct State {
    pub width: u32,
    pub height: u32,
    pub flushes: u32,
    pub resources: usize,
    /// The hash of the visible scanout (alpha forced opaque), if there is one.
    pub screen: Option<String>,
    /// The scanout's hash at each flush, with `Options::trace`.
    pub trace: Vec<String>,
    /// The hash of the cursor image (RGBA as the guest gave it) and its hotspot and position.
    pub cursor: Option<(String, u32, u32, u32, u32)>,
}

pub struct Gpu {
    resources: HashMap<u32, Resource>,
    total: u64,
    scanout: Option<(u32, Rect)>,
    cursor_image: Option<Vec<u8>>,
    cursor: (u32, u32, u32, u32),
    flushes: u32,
    trace: Vec<String>,
    width: u32,
    height: u32,
    o: Options,
    /// Set when the display's size changed: the caller raises the display event.
    pub event: bool,
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

/// Two word-wise 32-bit lanes over little-endian words (web/gpu.ts `hashRgba`).
fn hash_rgba(rows: impl Iterator<Item = Vec<u8>>, opaque: bool) -> String {
    let (mut a, mut b) = (0x811c_9dc5u32, 0x9e37_79b9u32);
    for row in rows {
        for w in row.as_chunks::<4>().0 {
            let mut w = u32::from_le_bytes(*w);
            if opaque {
                w |= 0xff00_0000;
            }
            a = (a ^ w).wrapping_mul(0x0100_0193);
            b = (b ^ w).rotate_left(13).wrapping_mul(0x9e37_79b1);
        }
    }
    format!("{a:08x}{b:08x}")
}

impl Gpu {
    pub fn new(o: Options) -> Gpu {
        Gpu {
            resources: HashMap::new(),
            total: 0,
            scanout: None,
            cursor_image: None,
            cursor: (0, 0, 0, 0),
            flushes: 0,
            trace: Vec::new(),
            width: o.width.clamp(1, EDID_MAX),
            height: o.height.clamp(1, EDID_MAX),
            o,
            event: false,
        }
    }

    pub fn reset(&mut self) {
        self.resources.clear();
        self.total = 0;
        self.cursor_image = None;
        self.cursor = (0, 0, 0, 0);
        self.scanout = None;
    }

    fn set_size(&mut self, w: u32, h: u32) {
        self.width = w.clamp(1, EDID_MAX);
        self.height = h.clamp(1, EDID_MAX);
        self.event = true;
    }

    fn reply(&self, ty: u32, cmd: &[u8], room: usize, body: Option<Vec<u8>>) -> Vec<u8> {
        let mut r = body.unwrap_or_else(|| vec![0; HDR]);
        if r.len() > room {
            return Vec::new();
        }
        r[..4].copy_from_slice(&ty.to_le_bytes());
        if cmd.len() >= HDR {
            if u32_at(cmd, 4) & FLAG_FENCE != 0 {
                r[4..8].copy_from_slice(&FLAG_FENCE.to_le_bytes());
                r[8..16].copy_from_slice(&cmd[8..16]);
            }
            r[16..20].copy_from_slice(&cmd[16..20]);
        }
        r
    }

    fn inside(r: &Rect, res: &Resource) -> bool {
        r.x <= res.width && r.y <= res.height && r.w <= res.width - r.x && r.h <= res.height - r.y
    }

    /// A control command (the whole readable payload) → the response to write (empty: none fits).
    /// `ram` is guest RAM from `RAM_BASE`.
    pub fn control(&mut self, ram: &[u8], cmd: &[u8], room: usize) -> Vec<u8> {
        if cmd.len() < HDR {
            return self.reply(ERR_UNSPEC, cmd, room, None);
        }
        let ty = u32_at(cmd, 0);
        let need = |n: usize| cmd.len() >= n;
        let f = |at: usize| u32_at(cmd, HDR + at);
        let rect = |at: usize| Rect {
            x: f(at),
            y: f(at + 4),
            w: f(at + 8),
            h: f(at + 12),
        };
        let err = |s: &Gpu, e: u32| s.reply(e, cmd, room, None);
        match ty {
            GET_DISPLAY_INFO => {
                let mut r = vec![0; HDR + 16 * 24];
                r[HDR + 8..HDR + 12].copy_from_slice(&self.width.to_le_bytes());
                r[HDR + 12..HDR + 16].copy_from_slice(&self.height.to_le_bytes());
                r[HDR + 16..HDR + 20].copy_from_slice(&1u32.to_le_bytes());
                self.reply(OK_DISPLAY_INFO, cmd, room, Some(r))
            }
            GET_EDID => {
                if !need(HDR + 8) {
                    return err(self, ERR_UNSPEC);
                }
                if f(0) != 0 {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                let mut r = vec![0; HDR + 8 + 1024];
                let e = edid(
                    self.width.max(EDID_MIN.0),
                    self.height.max(EDID_MIN.1),
                    96,
                    &[],
                );
                r[HDR..HDR + 4].copy_from_slice(&(e.len() as u32).to_le_bytes());
                r[HDR + 8..HDR + 8 + e.len()].copy_from_slice(&e);
                self.reply(OK_EDID, cmd, room, Some(r))
            }
            RESOURCE_CREATE_2D => {
                if !need(HDR + 16) {
                    return err(self, ERR_UNSPEC);
                }
                let (id, fmt, w, h) = (f(0), f(4), f(8), f(12));
                if id == 0 || self.resources.contains_key(&id) {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                }
                if format(fmt).is_none() || w == 0 || h == 0 {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                let bytes = w as u64 * h as u64 * 4;
                if bytes > MAX_RESOURCE || self.total + bytes > MAX_TOTAL {
                    return err(self, ERR_OUT_OF_MEMORY);
                }
                self.total += bytes;
                self.resources.insert(
                    id,
                    Resource {
                        format: fmt,
                        width: w,
                        height: h,
                        pixels: vec![0; bytes as usize],
                        backing: None,
                        opaque: false,
                    },
                );
                self.reply(OK_NODATA, cmd, room, None)
            }
            RESOURCE_UNREF => {
                if !need(HDR + 8) {
                    return err(self, ERR_UNSPEC);
                }
                let id = f(0);
                let Some(res) = self.resources.remove(&id) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                self.total -= res.pixels.len() as u64;
                if self.scanout.is_some_and(|(sid, _)| sid == id) {
                    self.scanout = None;
                }
                self.reply(OK_NODATA, cmd, room, None)
            }
            SET_SCANOUT => {
                if !need(HDR + 24) {
                    return err(self, ERR_UNSPEC);
                }
                let (r, scanout, id) = (rect(0), f(16), f(20));
                if scanout != 0 {
                    return err(self, ERR_INVALID_SCANOUT_ID);
                }
                if id == 0 || r.w == 0 || r.h == 0 {
                    self.scanout = None;
                    return self.reply(OK_NODATA, cmd, room, None);
                }
                let Some(res) = self.resources.get(&id) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                if !Self::inside(&r, res) {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                let res = self.resources.get_mut(&id).unwrap();
                if !res.opaque {
                    res.opaque = true;
                    res.pixels
                        .iter_mut()
                        .skip(3)
                        .step_by(4)
                        .for_each(|a| *a = 255);
                }
                self.scanout = Some((id, r));
                self.reply(OK_NODATA, cmd, room, None)
            }
            RESOURCE_FLUSH => {
                if !need(HDR + 24) {
                    return err(self, ERR_UNSPEC);
                }
                let (r, id) = (rect(0), f(16));
                let Some(res) = self.resources.get(&id) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                if !Self::inside(&r, res) {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                self.flushes += 1;
                if self.o.trace {
                    let h = self.screen_hash().unwrap_or_default();
                    self.trace.push(h);
                }
                if let Some((after, w, h)) = self.o.resize
                    && self.flushes == after
                {
                    self.set_size(w, h);
                }
                self.reply(OK_NODATA, cmd, room, None)
            }
            TRANSFER_TO_HOST_2D => {
                if !need(HDR + 32) {
                    return err(self, ERR_UNSPEC);
                }
                let (r, offset, id) = (rect(0), u64_at(cmd, HDR + 16), f(24));
                let Some(res) = self.resources.get_mut(&id) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                if res.backing.is_none() {
                    return err(self, ERR_UNSPEC);
                }
                if !Self::inside(&r, res) {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                let ok = transfer(ram, res, &r, offset);
                self.reply(
                    if ok { OK_NODATA } else { ERR_INVALID_PARAMETER },
                    cmd,
                    room,
                    None,
                )
            }
            RESOURCE_ATTACH_BACKING => {
                if !need(HDR + 8) {
                    return err(self, ERR_UNSPEC);
                }
                let (id, n) = (f(0), f(4));
                let ram_size = ram.len() as u64;
                let Some(res) = self.resources.get_mut(&id) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                if res.backing.is_some() {
                    return err(self, ERR_UNSPEC);
                }
                if n == 0 || n > MAX_ENTRIES || cmd.len() < HDR + 8 + 16 * n as usize {
                    return err(self, ERR_INVALID_PARAMETER);
                }
                let end = RAM_BASE as u128 + ram_size as u128;
                let mut backing = Vec::new();
                for k in 0..n as usize {
                    let at = HDR + 8 + 16 * k;
                    let (addr, len) = (u64_at(cmd, at), u32_at(cmd, at + 8) as u128);
                    if addr < RAM_BASE || addr as u128 > end || len > end - addr as u128 {
                        return err(self, ERR_INVALID_PARAMETER);
                    }
                    backing.push((addr - RAM_BASE, len as u64));
                }
                res.backing = Some(backing);
                self.reply(OK_NODATA, cmd, room, None)
            }
            RESOURCE_DETACH_BACKING => {
                if !need(HDR + 8) {
                    return err(self, ERR_UNSPEC);
                }
                let Some(res) = self.resources.get_mut(&f(0)) else {
                    return err(self, ERR_INVALID_RESOURCE_ID);
                };
                res.backing = None;
                self.reply(OK_NODATA, cmd, room, None)
            }
            _ => err(self, ERR_UNSPEC),
        }
    }

    /// A cursor command: no response.
    pub fn cursor(&mut self, cmd: &[u8]) {
        if cmd.len() < HDR + 32 {
            return;
        }
        let ty = u32_at(cmd, 0);
        if ty != UPDATE_CURSOR && ty != MOVE_CURSOR {
            return;
        }
        let f = |at: usize| u32_at(cmd, HDR + at);
        if f(0) != 0 {
            return;
        }
        let c = &mut self.cursor;
        (c.2, c.3) = (f(4), f(8));
        if ty == UPDATE_CURSOR {
            let id = f(16);
            (c.0, c.1) = (f(20), f(24));
            if id == 0 {
                self.cursor_image = None;
            } else {
                match self.resources.get(&id) {
                    Some(r) if r.width == CURSOR && r.height == CURSOR => {
                        self.cursor_image = Some(r.pixels.clone());
                    }
                    _ => {}
                }
            }
        }
    }

    fn screen_hash(&self) -> Option<String> {
        self.scanout.map(|(id, s)| {
            let res = &self.resources[&id];
            hash_rgba(
                (0..s.h).map(|y| {
                    let at = (((s.y + y) * res.width + s.x) * 4) as usize;
                    res.pixels[at..at + (s.w * 4) as usize].to_vec()
                }),
                true,
            )
        })
    }

    pub fn state(&self) -> State {
        let screen = self.screen_hash();
        State {
            width: self.width,
            height: self.height,
            flushes: self.flushes,
            resources: self.resources.len(),
            screen,
            trace: self.trace.clone(),
            cursor: self.cursor_image.as_ref().map(|c| {
                (
                    hash_rgba(std::iter::once(c.clone()), false),
                    self.cursor.0,
                    self.cursor.1,
                    self.cursor.2,
                    self.cursor.3,
                )
            }),
        }
    }

    /// The visible scanout as RGBA rows (alpha as the resource has it), width and height.
    pub fn screen(&self) -> Option<(u32, u32, Vec<u8>)> {
        let (id, s) = self.scanout?;
        let res = &self.resources[&id];
        let mut out = Vec::new();
        for y in 0..s.h {
            let at = (((s.y + y) * res.width + s.x) * 4) as usize;
            out.extend_from_slice(&res.pixels[at..at + (s.w * 4) as usize]);
        }
        Some((s.w, s.h, out))
    }
}

/// The rectangle's rows from the backing (the first at `offset`, rows a resource width apart)
/// into the host pixels; false if the backing is too short.
fn transfer(ram: &[u8], res: &mut Resource, r: &Rect, offset: u64) -> bool {
    if r.w == 0 || r.h == 0 {
        return true;
    }
    let stride = res.width as u64 * 4;
    let row_len = r.w as u64 * 4;
    let backing = res.backing.as_ref().unwrap();
    let total: u64 = backing.iter().map(|b| b.1).sum();
    let Some(last) = stride
        .checked_mul(r.h as u64 - 1)
        .and_then(|v| v.checked_add(offset))
        .and_then(|v| v.checked_add(row_len))
    else {
        return false;
    };
    // The twin of a JS safe integer check: offsets past 2^53 are refused as well.
    if last > (1 << 53) || last > total {
        return false;
    }
    let [ri, gi, bi, ai] = format(res.format).unwrap();
    let mut row = vec![0u8; row_len as usize];
    for y in 0..r.h as u64 {
        read_backing(ram, backing, offset + stride * y, &mut row);
        let mut d = (((r.y as u64 + y) * res.width as u64 + r.x as u64) * 4) as usize;
        for px in row.as_chunks::<4>().0 {
            res.pixels[d] = px[ri];
            res.pixels[d + 1] = px[gi];
            res.pixels[d + 2] = px[bi];
            res.pixels[d + 3] = if res.opaque { 255 } else { px[ai] };
            d += 4;
        }
    }
    true
}

fn read_backing(ram: &[u8], backing: &[(u64, u64)], offset: u64, out: &mut [u8]) {
    let (mut skip, mut k) = (offset, 0usize);
    for &(off, len) in backing {
        if skip >= len {
            skip -= len;
            continue;
        }
        let n = ((len - skip) as usize).min(out.len() - k);
        let at = (off + skip) as usize;
        out[k..k + n].copy_from_slice(&ram[at..at + n]);
        k += n;
        skip = 0;
        if k == out.len() {
            return;
        }
    }
}
