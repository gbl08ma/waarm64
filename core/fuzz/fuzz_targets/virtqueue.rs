//! libFuzzer target for the virtio-mmio transport and split-queue parser
//! (PLAN.md §4 item 10): the input is the guest RAM (descriptor table, rings,
//! indirect tables) followed by register writes and backend completions. No
//! input may panic, and every posted buffer must lie in RAM.
#![no_main]

use libfuzzer_sys::fuzz_target;
use webpc_core::mem::Mem;
use webpc_core::virtio::{DevShared, DeviceEntry, Transport};
use webpc_core::vm::RAM_BASE;

const RAM: usize = 8 << 10;

fuzz_target!(|data: &[u8]| {
    let (image, ops) = data.split_at(data.len().min(RAM));
    let mut ram = vec![0u128; RAM / 16];
    // SAFETY: ram is 16-byte aligned, RAM bytes long, and outlives mem.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM as u64) }.at(RAM_BASE);
    for (k, &b) in image.iter().enumerate() {
        mem.write(RAM_BASE + k as u64, 1, b as u64).unwrap();
    }
    let entry = DeviceEntry { device_id: 2, features: 0, queues: 2, queue_size: 16, config_len: 8 };
    let (mut t, sh) = (Transport::new(entry), Box::<DevShared>::default());
    // A driver bring-up with both queues in RAM, the rings where the image says.
    let w = |t: &mut Transport, off: u64, v: u64| t.write(off, 4, v, &mem, &sh);
    w(&mut t, 0x070, 3);
    w(&mut t, 0x024, 0);
    w(&mut t, 0x020, 1 << 28);
    w(&mut t, 0x024, 1);
    w(&mut t, 0x020, 1);
    w(&mut t, 0x070, 0xb);
    for q in 0..2 {
        w(&mut t, 0x030, q);
        w(&mut t, 0x038, 16);
        for (k, off) in [0x080, 0x090, 0x0a0].into_iter().enumerate() {
            w(&mut t, off, RAM_BASE + 0x100 * (3 * q + k as u64));
        }
        w(&mut t, 0x044, 1);
    }
    w(&mut t, 0x070, 0xf);
    // Then: (op, arg) pairs.
    for op in ops.chunks_exact(6) {
        let v = u32::from_le_bytes(op[2..6].try_into().unwrap()) as u64;
        match op[0] % 4 {
            0 => {
                w(&mut t, 0x050, v & 1);
            }
            1 => {
                sh.cpl.push(&[v as u32, op[1] as u32]);
                t.complete(&mem, &sh);
            }
            2 => {
                t.write(op[1] as u64 * 4 % 0x200, 4, v, &mem, &sh);
            }
            _ => {
                t.read(op[1] as u64 * 4 % 0x200, 4, &sh);
            }
        }
        while let Some(r) = sh.req.pop_request() {
            for (off, len) in r.read.into_iter().chain(r.write) {
                assert!(off as u64 + len as u64 <= RAM as u64, "buffer outside RAM");
            }
        }
    }
});
