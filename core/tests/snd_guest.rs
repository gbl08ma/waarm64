//! Boots the snd test kernel (target/images/linux-snd/, images/build.sh linux-snd: Linux with the
//! virtio sound driver and a static init, images/snd/init.c) on a virtio-snd: ALSA plays a known
//! waveform through the deterministic sink, which must be given exactly the bytes the guest says it
//! wrote (their FNV-1a), after the control requests of tests/snd/log.txt, in the step count the Node
//! and Chromium runs take (tests/boot-node-suite.ts, tests/browser.test.ts; tests/steps.txt "snd").
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
    let (played, log) = r.snd.expect("a sound device");
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
    assert_eq!(r.steps, common::steps("snd"));
}
