//! Direct kernel boot: the arm64 `Image` protocol (Linux
//! Documentation/arch/arm64/booting.rst) and the device tree describing the VM.
//!
//! A kernel without the `Image` header (kvm-unit-tests' `.flat` files) boots
//! as a raw binary entered at its first byte, as QEMU does.
//!
//! The host has already copied the `Image` and the initrd into RAM. The DTB
//! goes in the last 2 MiB of RAM, which the host must leave free. The vCPU
//! starts at the `Image`'s first byte in its reset state (EL1h, DAIF masked,
//! MMU and caches off) with x0 = the DTB's address and x1–x3 = 0.

use crate::cpu::Cpu;
use crate::fdt::Fdt;
use crate::virtio;
use crate::vm::{GICC, GICD, IRQ_UART, RAM_BASE, UART, Vm};

/// Space reserved for the DTB at the top of RAM (booting.rst's limit is 2 MiB).
pub const DTB_SPACE: u64 = 2 << 20;
const IMAGE_MAGIC: u32 = 0x644d_5241; // "ARM\x64" at offset 0x38
const GIC_PHANDLE: u32 = 1;
const CLK_PHANDLE: u32 = 2;

/// The device tree for this VM: QEMU `virt`'s addresses and bindings for the
/// devices we have, with `virtio` virtio-mmio transports in the first slots.
/// `initrd` is (start, end) in guest PA.
pub fn dtb(ram_size: u64, cmdline: &str, initrd: Option<(u64, u64)>, virtio: usize) -> Vec<u8> {
    let mut f = Fdt::default();
    f.begin("");
    f.cells("#address-cells", &[2]);
    f.cells("#size-cells", &[2]);
    f.strs("compatible", &["webpc", "linux,dummy-virt"]);
    f.strs("model", &["webpc"]);
    f.cells("interrupt-parent", &[GIC_PHANDLE]);

    f.begin("chosen");
    f.strs("bootargs", &[cmdline]);
    f.strs("stdout-path", &["/pl011@9000000"]);
    if let Some((start, end)) = initrd {
        f.cells64("linux,initrd-start", &[start]);
        f.cells64("linux,initrd-end", &[end]);
    }
    f.end();

    f.begin(&format!("memory@{RAM_BASE:x}"));
    f.strs("device_type", &["memory"]);
    f.cells64("reg", &[RAM_BASE, ram_size]);
    f.end();

    f.begin("cpus");
    f.cells("#address-cells", &[1]);
    f.cells("#size-cells", &[0]);
    f.begin("cpu@0");
    f.strs("device_type", &["cpu"]);
    f.strs("compatible", &["arm,armv8"]);
    f.cells("reg", &[0]);
    f.strs("enable-method", &["psci"]);
    f.end();
    f.end();

    f.begin("psci");
    f.strs("compatible", &["arm,psci-1.0", "arm,psci-0.2"]);
    f.strs("method", &["hvc"]);
    f.end();

    f.begin(&format!("intc@{GICD:x}"));
    f.strs("compatible", &["arm,cortex-a15-gic"]);
    f.cells("#interrupt-cells", &[3]);
    f.flag("interrupt-controller");
    f.cells64("reg", &[GICD, 0x1_0000, GICC, 0x1_0000]);
    f.cells("phandle", &[GIC_PHANDLE]);
    f.end();

    // PPIs (type 1): secure physical 13, non-secure physical 14, virtual 11,
    // hypervisor 10 (INTIDs 29, 30, 27, 26); level-high, CPU 0.
    const PPI: u32 = 1;
    const LEVEL_CPU0: u32 = 1 << 8 | 4;
    f.begin("timer");
    f.strs("compatible", &["arm,armv8-timer"]);
    f.cells(
        "interrupts",
        &[
            PPI, 13, LEVEL_CPU0, PPI, 14, LEVEL_CPU0, PPI, 11, LEVEL_CPU0, PPI, 10, LEVEL_CPU0,
        ],
    );
    f.end();

    f.begin("apb-pclk");
    f.strs("compatible", &["fixed-clock"]);
    f.cells("#clock-cells", &[0]);
    f.cells("clock-frequency", &[24_000_000]);
    f.strs("clock-output-names", &["clk24mhz"]);
    f.cells("phandle", &[CLK_PHANDLE]);
    f.end();

    f.begin(&format!("pl011@{UART:x}"));
    f.strs("compatible", &["arm,pl011", "arm,primecell"]);
    f.cells64("reg", &[UART, 0x1000]);
    f.cells("interrupts", &[0, IRQ_UART as u32 - 32, 4]); // SPI, level-high
    f.cells("clocks", &[CLK_PHANDLE, CLK_PHANDLE]);
    f.strs("clock-names", &["uartclk", "apb_pclk"]);
    f.end();

    // The line is level-high: it follows InterruptStatus (QEMU says edge).
    for i in 0..virtio {
        let pa = virtio::MMIO_BASE + i as u64 * virtio::MMIO_STRIDE;
        f.begin(&format!("virtio_mmio@{pa:x}"));
        f.strs("compatible", &["virtio,mmio"]);
        f.cells64("reg", &[pa, virtio::MMIO_STRIDE]);
        f.cells("interrupts", &[0, (virtio::IRQ_BASE + i - 32) as u32, 4]);
        f.flag("dma-coherent");
        f.end();
    }

    f.end();
    f.finish()
}

impl Vm {
    /// Boots the `Image` (or raw binary) the host placed at `kernel_pa`, with the initrd at
    /// `initrd_pa..+initrd_len` (none if the length is 0) and `cmdline`: writes
    /// the DTB into the top `DTB_SPACE` of RAM and resets the vCPU to the entry.
    pub fn boot(
        &mut self,
        kernel_pa: u64,
        initrd: Option<(u64, u64)>,
        cmdline: &str,
    ) -> Result<(), &'static str> {
        let rd = |pa, size| self.mem.read(pa, size).map_err(|_| "kernel outside RAM");
        if rd(kernel_pa + 0x38, 4)? as u32 == IMAGE_MAGIC {
            let text_offset = rd(kernel_pa + 8, 8)?;
            if !(kernel_pa - text_offset).is_multiple_of(2 << 20) {
                return Err("Image base not 2 MiB aligned");
            }
        }
        let ram = self.mem.size();
        let dtb_pa = RAM_BASE + ram - DTB_SPACE;
        let initrd = initrd.map(|(pa, len)| (pa, pa + len));
        if let Some((start, end)) = initrd
            && (start < RAM_BASE || end > dtb_pa)
        {
            return Err("initrd outside RAM or over the DTB space");
        }
        let blob = dtb(ram, cmdline, initrd, self.virtio.len());
        if blob.len() as u64 > DTB_SPACE {
            return Err("DTB too large");
        }
        for (k, b) in blob.iter().enumerate() {
            self.mem
                .write(dtb_pa + k as u64, 1, *b as u64)
                .map_err(|_| "RAM too small for the DTB")?;
        }
        let mut c = Cpu::reset();
        c.pc = kernel_pa;
        c.x[0] = dtb_pa;
        self.vcpu.cpu = c;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_checks_the_image_and_sets_registers() {
        use crate::mem::Mem;
        use crate::vm::VmConfig;
        let mut ram = vec![0u128; (8 << 20) / 16];
        // SAFETY: ram is 16-byte aligned, 8 MiB, and outlives the Vm.
        let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, 8 << 20) };
        let mut vm = Vm::new(mem, VmConfig::default());
        let k = RAM_BASE + (2 << 20);
        assert!(
            vm.boot(RAM_BASE + (8 << 20), None, "").is_err(),
            "outside RAM"
        );
        vm.boot(k + 0x1000, None, "").unwrap(); // no header: a raw binary, anywhere
        assert_eq!(vm.vcpu.cpu.pc, k + 0x1000);
        vm.mem.write(k + 0x38, 4, IMAGE_MAGIC as u64).unwrap();
        vm.mem
            .write(k + 0x1000 + 0x38, 4, IMAGE_MAGIC as u64)
            .unwrap();
        assert!(vm.boot(k + 0x1000, None, "").is_err(), "not 2 MiB aligned");
        let rd = Some((RAM_BASE + (5 << 20), 2 << 20));
        assert!(vm.boot(k, rd, "").is_err(), "initrd over the DTB space");
        vm.boot(k, Some((RAM_BASE + (4 << 20), 4096)), "x").unwrap();
        let dtb = RAM_BASE + (6 << 20);
        let c = &vm.vcpu.cpu;
        assert_eq!((c.pc, c.x[0], c.el(), c.sctlr_el1 & 1), (k, dtb, 1, 0));
        assert_eq!(vm.mem.read(dtb, 4), Ok(0xedfe0dd0)); // FDT magic, big-endian
    }

    /// Our DTB, decompiled by `dtc`, must match the reviewed source in
    /// tests/dtb/webpc.dts (a round trip through the reference tool). Set
    /// UPDATE_DTS=1 to rewrite it after an intended change.
    #[test]
    fn dtb_round_trips_through_dtc() {
        let blob = dtb(
            256 << 20,
            "console=ttyAMA0 earlycon",
            Some((0x4800_0000, 0x4810_0000)),
            2,
        );
        let dir = std::env::temp_dir().join(format!("webpc-dtb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("webpc.dtb");
        std::fs::write(&path, &blob).unwrap();
        let out = std::process::Command::new("dtc")
            .args(["-q", "-I", "dtb", "-O", "dts"])
            .arg(&path)
            .output()
            .expect("dtc (device-tree-compiler) is needed for this test");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let dts = String::from_utf8(out.stdout).unwrap();
        let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/dtb/webpc.dts");
        if std::env::var_os("UPDATE_DTS").is_some() {
            std::fs::write(golden, &dts).unwrap();
        }
        assert_eq!(
            dts,
            std::fs::read_to_string(golden).unwrap(),
            "UPDATE_DTS=1 rewrites {golden}"
        );
    }
}
