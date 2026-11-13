//! The panic hook keeps the message for the host (ABI 27, `diag`). Its own test
//! binary: the buffer keeps the first panic of the process.

#[test]
fn the_hook_records_the_first_panic() {
    assert_eq!(waarm64_core::diag::recorded(), None);
    waarm64_core::diag::install_panic_hook();
    let r = std::panic::catch_unwind(|| panic!("first {}", 1));
    assert!(r.is_err());
    let m = waarm64_core::diag::recorded().unwrap();
    assert!(m.contains("first 1"), "{m}");
    let _ = std::panic::catch_unwind(|| panic!("second"));
    assert_eq!(waarm64_core::diag::recorded().unwrap(), m);
    // The export gives the buffer: length word, then the bytes.
    let p = waarm64_core::diag::panic_message().cast::<u8>();
    // SAFETY: the buffer is a static, `len` (4 bytes) then the message.
    let (len, first) = unsafe { (p.cast::<u32>().read() as usize, p.add(4).read()) };
    assert_eq!(len, m.len());
    assert_eq!(first, m.as_bytes()[0]);
}
