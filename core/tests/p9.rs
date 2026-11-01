//! The native 9p server (common/p9.rs, the boots' twin of web/9p.ts) answers
//! tests/p9/transcript.txt's T-messages with its R-messages, byte for byte: the
//! exchanges tests/devices.test.ts makes with web/9p.ts's memory tree
//! (readdir offsets, qid versions, times, xattrs, POSIX ACLs).

#[path = "common/p9.rs"]
mod p9;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|k| u8::from_str_radix(&s[k..k + 2], 16).unwrap())
        .collect()
}

#[test]
fn native_9p_answers_as_web_9p() {
    let path = format!("{}/../tests/p9/transcript.txt", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let mut s = p9::Server::new(&[("hello.txt", "hi\n")]);
    for (k, line) in text.lines().enumerate() {
        let (t, r) = line.split_once(' ').unwrap();
        let (t, r) = (hex(t), hex(r));
        let got = s.handle(&t, 8192);
        assert!(
            got == r,
            "exchange {} (type {}): got {:02x?}, want {:02x?}",
            k + 1,
            t[4],
            got,
            r
        );
    }
}
