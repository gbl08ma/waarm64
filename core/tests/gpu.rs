//! The native virtio-gpu twin (common/gpu.rs) against web/gpu.ts and web/edid.ts: the same EDID
//! bytes (tests/gpu/edid.json) and the same hashes from the same script (tests/gpu.test.ts).

mod common;

use common::gpu::{Gpu, Options, RAM_BASE, edid};

fn cmd(ty: u32, fields: &[u64]) -> Vec<u8> {
    // Fields are u32, except where 8 bytes are given as two entries marked by the caller: see `cmd64`.
    let mut b = vec![0u8; 24];
    b[..4].copy_from_slice(&ty.to_le_bytes());
    for &f in fields {
        b.extend((f as u32).to_le_bytes());
    }
    b
}

fn attach(id: u32, off: u64, bytes: u64, chunk: u64) -> Vec<u8> {
    let n = bytes.div_ceil(chunk);
    let mut c = cmd(0x106, &[id as u64, n]);
    for k in 0..n {
        c.extend((RAM_BASE + off + k * chunk).to_le_bytes());
        c.extend((chunk.min(bytes - k * chunk) as u32).to_le_bytes());
        c.extend(0u32.to_le_bytes());
    }
    c
}

fn transfer(x: u32, y: u32, w: u32, h: u32, offset: u64, id: u32) -> Vec<u8> {
    let mut c = cmd(0x105, &[x as u64, y as u64, w as u64, h as u64]);
    c.extend(offset.to_le_bytes());
    c.extend(id.to_le_bytes());
    c.extend(0u32.to_le_bytes());
    c
}

fn ok(g: &mut Gpu, ram: &[u8], c: &[u8]) {
    let r = g.control(ram, c, 4096);
    assert_eq!(
        u32::from_le_bytes(r[..4].try_into().unwrap()),
        0x1100,
        "command {:#x}",
        u32::from_le_bytes(c[..4].try_into().unwrap())
    );
}

#[test]
fn edid_bytes_are_the_typescript_ones() {
    let path = format!("{}/../tests/gpu/edid.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let mut n = 0;
    // The file is flat `"key": "hex"` lines.
    for line in text.lines() {
        let Some((k, v)) = line.trim().trim_end_matches(',').split_once("\": \"") else {
            continue;
        };
        let k = k.trim_start_matches('"');
        let want: Vec<u8> = (0..v.len() - 1)
            .step_by(2)
            .map(|i| u8::from_str_radix(&v[i..i + 2], 16).unwrap())
            .collect();
        let (dims, dpi) = k.split_once('@').map_or((k, 96), |(d, p)| {
            (d, p.trim_end_matches("dpi").parse().unwrap())
        });
        let (main, extra) = match dims.split_once('+') {
            Some((a, b)) => (a, Some(b)),
            None => (dims, None),
        };
        let size = |s: &str| {
            let (w, h) = s.split_once('x').unwrap();
            (w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap())
        };
        let (w, h) = size(main);
        let extra: Vec<_> = extra.map(size).into_iter().collect();
        assert_eq!(edid(w, h, dpi, &extra).to_vec(), want, "{k}");
        n += 1;
    }
    assert!(n >= 10, "{n} sizes");
}

#[test]
fn the_conformance_script_hashes() {
    let mut ram = vec![0u8; 1 << 20];
    for k in 0..8 * 8 * 4 {
        ram[0x3000 + k] = ((k * 7 + 3) & 0xff) as u8;
    }
    for k in 0..64 * 64 * 4 {
        ram[0x8000 + k] = ((k * 13 + k / 64) & 0xff) as u8;
    }
    let mut g = Gpu::new(Options {
        width: 800,
        height: 600,
        resize: None,
        trace: false,
    });
    let r = &ram;
    ok(&mut g, r, &cmd(0x101, &[1, 2, 8, 8]));
    ok(&mut g, r, &attach(1, 0x3000, 256, 100));
    ok(&mut g, r, &transfer(0, 0, 8, 8, 0, 1));
    ok(&mut g, r, &cmd(0x103, &[1, 1, 6, 5, 0, 1]));
    ok(&mut g, r, &cmd(0x101, &[2, 1, 64, 64]));
    ok(&mut g, r, &attach(2, 0x8000, 64 * 64 * 4, 4096));
    ok(&mut g, r, &transfer(0, 0, 64, 64, 0, 2));
    g.cursor(&cmd(0x300, &[0, 11, 12, 0, 2, 5, 6, 0]));
    let s = g.state();
    assert_eq!(s.screen.as_deref(), Some("7270f777c2f4c1c5"));
    assert_eq!(
        s.cursor.as_ref().map(|c| c.0.as_str()),
        Some("e3974fc5495011dc")
    );
    assert_eq!(s.cursor.map(|c| (c.1, c.2, c.3, c.4)), Some((5, 6, 11, 12)));
}

#[test]
fn display_info_and_errors() {
    let ram = vec![0u8; 1 << 16];
    let mut g = Gpu::new(Options {
        width: 1024,
        height: 768,
        resize: Some((2, 800, 600)),
        trace: false,
    });
    let r = g.control(&ram, &cmd(0x100, &[]), 4096);
    assert_eq!(r.len(), 24 + 16 * 24);
    assert_eq!(u32::from_le_bytes(r[32..36].try_into().unwrap()), 1024);
    // The same refusals as the TypeScript backend.
    let ty = |g: &mut Gpu, c: &[u8]| {
        u32::from_le_bytes(g.control(&ram, c, 4096)[..4].try_into().unwrap())
    };
    assert_eq!(ty(&mut g, &cmd(0x101, &[0, 2, 4, 4])), 0x1203);
    ok(&mut g, &ram, &cmd(0x101, &[1, 2, 4, 4]));
    assert_eq!(ty(&mut g, &cmd(0x101, &[1, 2, 4, 4])), 0x1203);
    assert_eq!(ty(&mut g, &cmd(0x101, &[2, 99, 4, 4])), 0x1205);
    assert_eq!(ty(&mut g, &cmd(0x101, &[2, 2, 4096, 4097])), 0x1201);
    assert_eq!(ty(&mut g, &transfer(0, 0, 1, 1, 0, 1)), 0x1200);
    assert_eq!(ty(&mut g, &attach(1, 1 << 20, 64, 64)), 0x1205, "past RAM");
    assert_eq!(ty(&mut g, &cmd(0x103, &[0, 0, 4, 4, 1, 1])), 0x1202);
    assert_eq!(ty(&mut g, &cmd(0x200, &[])), 0x1200);
    // The second flush changes the display size and asks for the event, once.
    ok(&mut g, &ram, &cmd(0x104, &[0, 0, 1, 1, 1, 0]));
    assert!(!g.event);
    ok(&mut g, &ram, &cmd(0x104, &[0, 0, 1, 1, 1, 0]));
    assert!(std::mem::take(&mut g.event));
    assert_eq!((g.state().width, g.state().height), (800, 600));
}
