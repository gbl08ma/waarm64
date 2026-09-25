//! libFuzzer target: any word must execute without panicking and agree with
//! Capstone on whether it's a valid instruction.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::cell::RefCell;

#[path = "../src/check.rs"]
mod check;

thread_local! {
    static CHECKER: RefCell<check::Checker> = RefCell::new(check::Checker::new());
}

fuzz_target!(|data: [u8; 4]| {
    CHECKER.with(|c| {
        if let Some(m) = c.borrow_mut().check(u32::from_le_bytes(data)) {
            panic!("{}", m.detail);
        }
    });
});
