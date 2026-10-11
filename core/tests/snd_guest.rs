//! Boots the snd test kernel (target/images/linux-snd/, images/build.sh linux-snd: Linux with the
//! virtio sound driver and a static init, images/snd/init.c) on a virtio-snd: ALSA plays a known
//! waveform through the deterministic sink, which must be given exactly the bytes the guest says it
//! wrote (their FNV-1a), then records from the deterministic source, and must have read the
//! source's pattern (its FNV-1a, 1 and 1.5 kHz), after the control requests of tests/snd/log.txt,
//! in the step count the Node and Chromium runs take (tests/boot-node-suite.ts,
//! tests/browser.test.ts; tests/steps.txt "snd").
//! Ignored by default (needs the image and a release build); scripts/ci.sh runs it.

mod common;

use common::{Boot, Dev};

#[test]
#[ignore = "needs target/images (images/build.sh linux-snd) and --release"]
fn the_snd_guest_plays_its_waveform() {
    let kernel = common::image("linux-snd/Image");
    let initrd = common::image("linux-snd/initramfs.cpio");
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices: &[Dev::Snd],
        echo: true,
        ..Boot::new(&kernel, "console=ttyAMA0 panic=-1")
    });
    eprintln!("[{}]\n{:?}", r.summary, r.snd);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    for want in [
        "snd: card VirtIO SoundCard, driver virtio-snd\n",
        "snd: hw params 48000 Hz, 2 channels, period 1024 frames, buffer 4096 frames\n",
        "snd: 0 frames queued at the end, drop ok",
        "webpc: snd test ok\n",
    ] {
        assert!(r.console.contains(want), "missing {want:?}");
    }
    let line = r
        .console
        .lines()
        .find_map(|l| l.strip_prefix("snd: wrote "))
        .expect("no 'snd: wrote' line");
    let (frames, fnv) = line.split_once(" frames fnv1a ").unwrap();
    let (played, recorded, log) = r.snd.expect("a sound device");
    assert_eq!(
        (played.frames, played.bytes, format!("{:08x}", played.fnv)),
        (
            frames.parse().unwrap(),
            frames.parse::<u64>().unwrap() * 4,
            fnv.to_owned()
        )
    );
    let want = std::fs::read_to_string(format!(
        "{}/../tests/snd/log.txt",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let want: Vec<_> = want
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    assert_eq!(log, want);
    // What the guest read: 16 periods of the pattern from frame 4096. Linux's driver posts a capture
    // period again as soon as ALSA counts it, before the reader has it, so a source faster than real
    // time (this one fills a message at the exit after it's posted) overwrites the first buffer
    // before the first read (docs/plans/audio.md §16); the source filled that buffer, the 16 periods
    // read, and the buffer still posted at the end. (The pattern's 96-frame cycle makes a start at
    // 1024 the same bytes; the counts say 4096.)
    let p = common::snd::Params {
        buffer_bytes: 16384,
        period_bytes: 4096,
        channels: 2,
        format: 5,
    };
    let read = common::snd::fnv1a(&common::snd::pattern(&p, 4096, 16 * 4096), 0x811c_9dc5);
    assert_eq!(
        read, 0x2b1e_136b,
        "the pattern, as web/snd.ts makes it (tests/snd/guest.ts)"
    );
    let want = format!("snd: recorded 16384 frames fnv1a {read:08x} in ");
    assert!(r.console.contains(&want), "missing {want:?}");
    assert!(r.console.contains(" ms, 999 Hz left, 1500 Hz right\n"));
    assert_eq!(
        (recorded.frames, recorded.messages),
        (4096 + 16384 + 4096, 24)
    );
    assert_eq!(r.steps, common::steps("snd"));
}
