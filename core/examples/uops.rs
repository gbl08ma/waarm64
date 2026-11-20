//! The block interpreter's micro-ops for blocks of a flat guest binary, as JSON lines, for the introduction page's
//! capture tool (tools/intro-capture.ts). Decoded by the core's own code built natively (`interp::block::describe`:
//! the calls the block cache makes, checked there against what a cache holds for the block).
//! cargo run --features capture --example uops -- <guest.bin> <load address> <regime bits> <block address>...
//! Addresses are hex offsets into a RAM that starts at 0 (a block's micro-ops depend on its words and its offset in
//! its page, not on where RAM is); the regime bits are a block key's low two (1: EL1, 2: the MMU on).
use waarm64_core::interp::describe;
use waarm64_core::mem::Mem;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let hex = |s: &str| u64::from_str_radix(s.trim_start_matches("0x"), 16).expect("a hex number");
    let (bin, load, regime) = (&args[1], hex(&args[2]), hex(&args[3]) & 3);
    let ram_size = 16usize << 20;
    let mut ram = vec![0u128; ram_size / 16];
    // SAFETY: ram is 16-byte aligned, ram_size bytes long, and outlives mem.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, ram_size as u64) };
    for (k, b) in std::fs::read(bin).unwrap().iter().enumerate() {
        mem.write(load + k as u64, 1, *b as u64).unwrap();
    }
    for a in &args[4..] {
        let key = hex(a) | regime;
        let (uops, consts, rich) = describe(&mem, key);
        let list: Vec<String> = uops
            .iter()
            .map(|u| {
                let packed: String = u.packed.iter().map(|b| format!("{b:02x}")).collect();
                format!(
                    r#"{{"word":"{:08x}","kind":"{}","d":{},"n":{},"m":{},"x":"{:#x}","imm":"{:#x}","packed":"{}"}}"#,
                    u.word, u.kind, u.d, u.n, u.m, u.x, u.imm, packed
                )
            })
            .collect();
        let consts: Vec<String> = consts.iter().map(|c| format!(r#""{c:#x}""#)).collect();
        println!(
            r#"{{"at":"{:#x}","rich":{},"uops":[{}],"consts":[{}]}}"#,
            key & !3,
            rich,
            list.join(","),
            consts.join(",")
        );
    }
}
