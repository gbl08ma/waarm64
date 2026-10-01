//! Boots the gpu test kernel (target/images/linux-gpu/, images/build.sh linux-gpu: Linux with the
//! virtio-gpu driver and a static init, images/gpu/init.c) on a virtio-gpu 2D display of 640×480:
//! the guest sets a mode, sends damage, sets a cursor, and after the display event the host raises
//! (the Nth flush changes the size to 800×600) shows a buffer of the new size. The scanout's and the
//! cursor's hashes and the step count are the same in the Node and Chromium runs
//! (tests/boot-node-suite.ts, tests/browser.test.ts; tests/steps.txt "gpu").
//! Ignored by default (needs the image and a release build); scripts/ci.sh runs it.

mod common;

use common::{Boot, Dev};

/// A value of tests/gpu/guest.json (flat `"key": "value"` lines, shared with the JS runners): the
/// flush after which the display changes (`resizeAfter`), the scanout's and the cursor's hashes.
fn expected(key: &str) -> String {
    let path = format!("{}/../tests/gpu/guest.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .find_map(|l| {
            let (k, v) = l.trim().trim_end_matches(',').split_once("\": \"")?;
            (k.trim_start_matches('"') == key).then(|| v.trim_end_matches('"').to_owned())
        })
        .unwrap_or_else(|| panic!("no {key} in tests/gpu/guest.json"))
}

#[test]
#[ignore = "needs target/images (images/build.sh linux-gpu) and --release"]
fn the_gpu_guest_draws_and_follows_a_display_event() {
    let kernel = common::image("linux-gpu/Image");
    let initrd = common::image("linux-gpu/initramfs.cpio");
    let devices = [Dev::Gpu(
        640,
        480,
        Some((expected("resizeAfter").parse().unwrap(), 800, 600)),
        true,
    )];
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices: &devices,
        echo: true,
        ..Boot::new(&kernel, "console=ttyAMA0 panic=-1")
    });
    eprintln!("[{}]\n{:?}", r.summary, r.gpu);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    for want in [
        "gpu: 1 crtc 1 connector 1 encoder",
        "gpu: connector connected, 1 mode, preferred 640x480@",
        "gpu: mode set 640x480 pitch 2560\n",
        "gpu: damage sent\n",
        "gpu: cursor set and moved\n",
        "gpu: preferred now 800x600,",
        "gpu: mode set 800x600\n",
        "webpc: gpu test ok\n",
    ] {
        assert!(r.console.contains(want), "missing {want:?}");
    }
    let g = r.gpu.expect("a gpu");
    assert_eq!((g.width, g.height), (800, 600));
    assert_eq!(g.screen.as_deref(), Some(expected("screen").as_str()));
    // The pictures after each flush: the gradient, the gradient with the damaged rectangle (and not
    // the pixel written silently), and the 800×600 one (tests/gpu.test.ts computes them from init.c's drawing).
    let trace: Vec<_> = (1..=3).map(|k| expected(&format!("trace{k}"))).collect();
    assert_eq!(g.trace, trace);
    assert_eq!(
        g.cursor.as_ref().map(|c| c.0.as_str()),
        Some(expected("cursor").as_str())
    );
    assert_eq!(r.steps, common::steps("gpu"));
}
