//! The native qcow2 reader (common/qcow2.rs) against qemu-img's fixtures
//! (tests/qcow2/make.sh); tests/qcow2.test.ts checks web/qcow2.ts the same way.

mod common;

use common::qcow2::Disk;

fn fixture(name: &str) -> &'static [u8] {
    let path = format!("{}/../tests/qcow2/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap().leak()
}

#[test]
fn images_read_as_the_raw_data() {
    let data = fixture("data.raw");
    for name in ["v2.qcow2", "v3.qcow2", "deflate.qcow2", "data.raw"] {
        let d = Disk::open(fixture(name)).unwrap();
        assert_eq!(d.size(), data.len() as u64, "{name}");
        let mut all = vec![0; data.len()];
        assert!(d.read(0, &mut all), "{name}");
        assert!(all == data, "{name}");
        // Unaligned reads across cluster boundaries and through every kind of cluster.
        for off in (0..data.len()).step_by(3001) {
            let mut b = vec![0xaa; 9000.min(data.len() - off)];
            assert!(d.read(off as u64, &mut b), "{name} at {off}");
            assert!(b == data[off..off + b.len()], "{name} at {off}");
        }
        assert!(!d.read(data.len() as u64 - 512, &mut [0; 1024]), "{name}");
    }
}

#[test]
fn unsupported_features_are_refused_at_open() {
    for (name, why) in [
        ("reject-backing.qcow2", "backing files"),
        ("reject-zstd.qcow2", "zstd"),
        ("reject-extl2.qcow2", "extended L2"),
        ("reject-datafile.qcow2", "external data"),
        ("reject-luks.qcow2", "encrypted"),
    ] {
        let e = Disk::open(fixture(name)).err().unwrap();
        assert!(e.contains(why), "{name}: {e}");
    }
}
