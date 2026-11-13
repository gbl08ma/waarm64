//! An allocation that fails aborts without the panic hook: the allocation
//! error hook (`diag`) records a message for the host instead. Its own test
//! binary, which runs itself as the child that aborts.

use std::process::Command;

const CHILD: &str = "WAARM64_ALLOC_HOOK_CHILD";

#[test]
fn a_failed_allocation_records_a_message() {
    if std::env::var_os(CHILD).is_some() {
        waarm64_core::diag::install_panic_hook();
        let l = std::alloc::Layout::from_size_align(1 << 40, 8).unwrap();
        std::alloc::handle_alloc_error(l);
    }
    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_failed_allocation_records_a_message",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    assert!(!out.status.success(), "the child aborts");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("waarm64: out of memory: an allocation of 1099511627776 bytes failed"),
        "{err}"
    );
}

#[test]
fn the_message_needs_no_heap() {
    let m = waarm64_core::diag::alloc_message(328 << 20, 700 << 20, 1000 << 20);
    assert_eq!(
        m.as_str(),
        "out of memory: an allocation of 343932928 bytes failed (the core's heap: 700 MiB live, 1000 MiB at most)"
    );
}
