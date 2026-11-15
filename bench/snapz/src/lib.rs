//! Ad-hoc codec bench (not shipped): every candidate behind one C ABI, on its own (non-shared) memory.
//! kinds: 0 the core's LZ, 1 lz4_flex, 2 snap (raw), 3..=6 miniz_oxide deflate-raw levels 1,2,3,6,
//! 7 ruzstd Fastest, 8.. C zstd (feature czstd): 8 level -1 (fast 1), 9 level 1, 10 level 3, 11 fast 4.
#![allow(clippy::missing_safety_doc)]

mod lz;

use std::slice;

#[unsafe(no_mangle)]
pub extern "C" fn buf(n: usize) -> *mut u8 {
    let mut v = vec![0u8; n];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub extern "C" fn crc(p: *const u8, n: usize) -> u32 {
    // SAFETY: the caller hands a range of this instance's memory.
    let s = unsafe { slice::from_raw_parts(p, n) };
    let mut h = crc32fast::Hasher::new();
    h.update(s);
    h.finalize()
}

#[cfg(feature = "czstd")]
thread_local! {
    static CCTX: std::cell::RefCell<zstd_safe::CCtx<'static>> = std::cell::RefCell::new(zstd_safe::CCtx::create());
    static DCTX: std::cell::RefCell<zstd_safe::DCtx<'static>> = std::cell::RefCell::new(zstd_safe::DCtx::create());
}

#[unsafe(no_mangle)]
pub extern "C" fn comp(kind: u32, src: *const u8, n: usize, dst: *mut u8, cap: usize) -> isize {
    // SAFETY: as above.
    let (s, d) = unsafe { (slice::from_raw_parts(src, n), slice::from_raw_parts_mut(dst, cap)) };
    let r: Option<usize> = match kind {
        0 => lz::compress(s, d),
        1 => lz4_flex::block::compress_into(s, d).ok(),
        2 => snap::raw::Encoder::new().compress(s, d).ok(),
        3..=6 => {
            let level = [1u8, 2, 3, 6][(kind - 3) as usize];
            let v = miniz_oxide::deflate::compress_to_vec(s, level);
            (v.len() <= cap).then(|| {
                d[..v.len()].copy_from_slice(&v);
                v.len()
            })
        }
        7 => {
            let v = ruzstd::encoding::compress_to_vec(s, ruzstd::encoding::CompressionLevel::Fastest);
            (v.len() <= cap).then(|| {
                d[..v.len()].copy_from_slice(&v);
                v.len()
            })
        }
        #[cfg(feature = "czstd")]
        8..=11 => {
            let level = [-1i32, 1, 3, -4][(kind - 8) as usize];
            CCTX.with(|c| c.borrow_mut().compress(d, s, level).ok())
        }
        _ => None,
    };
    r.map_or(-1, |x| x as isize)
}

#[unsafe(no_mangle)]
pub extern "C" fn decomp(kind: u32, src: *const u8, n: usize, dst: *mut u8, cap: usize) -> isize {
    // SAFETY: as above.
    let (s, d) = unsafe { (slice::from_raw_parts(src, n), slice::from_raw_parts_mut(dst, cap)) };
    let r: Option<usize> = match kind {
        0 => lz::decompress(s, d),
        1 => lz4_flex::block::decompress_into(s, d).ok(),
        2 => snap::raw::Decoder::new().decompress(s, d).ok(),
        3..=6 => {
            let mut st = miniz_oxide::inflate::core::DecompressorOxide::new();
            let (status, _, out) = miniz_oxide::inflate::core::decompress(
                &mut st,
                s,
                d,
                0,
                miniz_oxide::inflate::core::inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
            );
            matches!(status, miniz_oxide::inflate::TINFLStatus::Done).then_some(out)
        }
        7 => {
            let mut dec = ruzstd::decoding::FrameDecoder::new();
            dec.decode_all(s, d).ok()
        }
        #[cfg(feature = "czstd")]
        8..=11 => DCTX.with(|c| c.borrow_mut().decompress(d, s).ok()),
        _ => None,
    };
    r.map_or(-1, |x| x as isize)
}
