//! Native interpreter MIPS on the benchmark guests, for profiling with perf.
//! Not a reported number (those come from bench/run.ts in Chromium).
//! cargo run --release --example mips -- [bench/interp/guest.bin] [instructions]
use webpc_core::cpu::Cpu;
use webpc_core::interp::run;
use webpc_core::mem::Mem;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bin = args.get(1).map_or("bench/interp/guest.bin", |s| s);
    let n: u64 = args.get(2).map_or(500_000_000, |s| s.parse().unwrap());
    let (ram_size, load) = (16usize << 20, 0x10000u64);
    let mut ram = vec![0u128; ram_size / 16];
    // SAFETY: ram is 16-byte aligned, ram_size bytes long, and outlives mem.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, ram_size as u64) };
    for (k, b) in std::fs::read(bin).unwrap().iter().enumerate() {
        mem.write(load + k as u64, 1, *b as u64).unwrap();
    }
    let mut cpu = Cpu {
        pc: load,
        ..Cpu::default()
    };
    let t = std::time::Instant::now();
    let (done, r) = run(&mut cpu, &mem, n);
    let dt = t.elapsed().as_secs_f64();
    assert_eq!((done, r), (n, Ok(())), "stopped at pc {:#x}", cpu.pc);
    println!("{:.1} MIPS", n as f64 / dt / 1e6);
}
