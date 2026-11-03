//! Direct kernel boot: the arm64 `Image` protocol (Linux
//! Documentation/arch/arm64/booting.rst) and the device tree describing the VM.
//!
//! A kernel without the `Image` header (kvm-unit-tests' `.flat` files) boots
//! as a raw binary entered at its first byte, as QEMU does.
//!
//! The host has already copied the `Image` and the initrd into RAM. The DTB
//! goes in the last 2 MiB of RAM, which the host must leave free, and a
//! framebuffer, if the config has one, just below it. The vCPU
//! starts at the `Image`'s first byte in its reset state (EL1h, DAIF masked,
//! MMU and caches off) with x0 = the DTB's address and x1–x3 = 0.

use crate::cpu::Cpu;
use crate::fdt::Fdt;
use crate::virtio;
use crate::vm::{GICD, GICR, IRQ_RTC, IRQ_UART, RAM_BASE, RTC, UART, Vm, VmConfig};

/// Space reserved for the DTB at the top of RAM (booting.rst's limit is 2 MiB).
pub const DTB_SPACE: u64 = 2 << 20;
/// The firmware (ArmVirtQemuKernel) copies the DTB into the 32 KiB after its
/// 64-byte `Image` header (its FDF's first region).
const FIRMWARE_DTB_MAX: u64 = (32 << 10) - 64;
const IMAGE_MAGIC: u32 = 0x644d_5241; // "ARM\x64" at offset 0x38
const GIC_PHANDLE: u32 = 1;
const CLK_PHANDLE: u32 = 2;

/// The framebuffer `cfg` asks for: its guest PA and the bytes it spans
/// (4 per pixel, rows packed). It sits at the top of RAM below the DTB space,
/// in a region of whole 2 MiB units the DT reserves (`no-map`), so the host
/// reads it straight out of guest RAM. None without one, or if it would take
/// more than half of RAM.
pub fn framebuffer(cfg: &VmConfig) -> Option<(u64, u64)> {
    let bytes = cfg.fb_width.checked_mul(cfg.fb_height)?.checked_mul(4)?;
    let region = bytes.checked_next_multiple_of(DTB_SPACE)?;
    (bytes > 0 && region <= cfg.ram_size / 2)
        .then(|| (RAM_BASE + cfg.ram_size - DTB_SPACE - region, bytes))
}

/// The device tree for this VM: QEMU `virt`'s addresses and bindings for the
/// devices we have, with `virtio` virtio-mmio transports in the first slots.
/// `initrd` is (start, end) in guest PA; `fb` a framebuffer as (PA, width, height);
/// `ncpus` the vCPUs; `rtc` whether there's the PL031; `flash` the flash
/// bank's size in the firmware configuration (docs/abi.md "M8 phase B"), which
/// also adds fw_cfg and ends `/memory` below the framebuffer and the DTB space;
/// `xhci` the `generic-xhci` node (docs/usb.md); `spill` the spill memories
/// as (PA, size), each a CPU-less NUMA node (docs/spill-memories.md).
#[allow(clippy::too_many_arguments)]
pub fn dtb(
    ram_size: u64,
    spill: &[(u64, u64)],
    cmdline: &str,
    initrd: Option<(u64, u64)>,
    virtio: usize,
    fb: Option<(u64, u64, u64)>,
    ncpus: usize,
    rtc: bool,
    flash: Option<u64>,
    xhci: bool,
) -> Vec<u8> {
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
    // The simple-framebuffer binding's place for one set up before the OS
    // (its `reg` translates through an empty `ranges`, as U-Boot does it).
    if let Some((pa, w, h)) = fb {
        f.cells("#address-cells", &[2]);
        f.cells("#size-cells", &[2]);
        f.flag("ranges");
        f.begin(&format!("framebuffer@{pa:x}"));
        f.strs("compatible", &["simple-framebuffer"]);
        f.cells64("reg", &[pa, w * h * 4]);
        f.cells("width", &[w as u32]);
        f.cells("height", &[h as u32]);
        f.cells("stride", &[w as u32 * 4]);
        f.strs("format", &["x8r8g8b8"]);
        f.end();
    }
    f.end();

    // The firmware allocates down from `/memory`'s top and ignores
    // `/reserved-memory`, so there `/memory` stops short of the framebuffer
    // and the DTB space (EDK2 copies the DTB before it allocates anything).
    let memory = match (flash, fb) {
        (None, _) => ram_size,
        (Some(_), Some((pa, _, _))) => pa - RAM_BASE,
        (Some(_), None) => ram_size - DTB_SPACE,
    };
    // With spill memories, memory 0 is NUMA node 0 (with every vCPU) and
    // memory k node k; EDK2 takes the first `/memory` as its own and adds
    // the others as system memory.
    let numa = !spill.is_empty();
    f.begin(&format!("memory@{RAM_BASE:x}"));
    f.strs("device_type", &["memory"]);
    f.cells64("reg", &[RAM_BASE, memory]);
    if numa {
        f.cells("numa-node-id", &[0]);
    }
    f.end();
    for (k, &(pa, size)) in spill.iter().enumerate() {
        f.begin(&format!("memory@{pa:x}"));
        f.strs("device_type", &["memory"]);
        f.cells64("reg", &[pa, size]);
        f.cells("numa-node-id", &[k as u32 + 1]);
        f.end();
    }
    if numa {
        // 10 to itself, 20 (the default remote distance) between nodes.
        let n = spill.len() as u32 + 1;
        let matrix: Vec<u32> = (0..n)
            .flat_map(|a| (0..n).flat_map(move |b| [a, b, if a == b { 10 } else { 20 }]))
            .collect();
        f.begin("distance-map");
        f.strs("compatible", &["numa-distance-map-v1"]);
        f.cells("distance-matrix", &matrix);
        f.end();
    }

    // The framebuffer's region, out of the kernel's linear map (the driver maps it).
    if let Some((pa, w, h)) = fb
        && flash.is_none()
    {
        f.begin("reserved-memory");
        f.cells("#address-cells", &[2]);
        f.cells("#size-cells", &[2]);
        f.flag("ranges");
        f.begin(&format!("framebuffer@{pa:x}"));
        f.cells64("reg", &[pa, (w * h * 4).next_multiple_of(DTB_SPACE)]);
        f.flag("no-map");
        f.end();
        f.end();
    }

    f.begin("cpus");
    f.cells("#address-cells", &[1]);
    f.cells("#size-cells", &[0]);
    for i in 0..ncpus {
        // `reg`: the MPIDR_EL1 affinity fields (Aff2–Aff0 fit one cell).
        let aff = crate::gicv3::mpidr(i) as u32 & 0xff_ffff;
        f.begin(&format!("cpu@{aff:x}"));
        f.strs("device_type", &["cpu"]);
        f.strs("compatible", &["arm,armv8"]);
        f.cells("reg", &[aff]);
        f.strs("enable-method", &["psci"]);
        if numa {
            f.cells("numa-node-id", &[0]);
        }
        f.end();
    }
    f.end();

    f.begin("psci");
    f.strs("compatible", &["arm,psci-1.0", "arm,psci-0.2"]);
    f.strs("method", &["hvc"]);
    f.end();

    // The variable store (EDK2 disables the node in the DT it hands on).
    if let Some(size) = flash {
        f.begin(&format!("flash@{:x}", crate::flash::FLASH));
        f.strs("compatible", &["cfi-flash"]);
        f.cells64("reg", &[crate::flash::FLASH, size]);
        f.cells("bank-width", &[4]);
        f.end();
    }

    // The GICv3, QEMU `virt`'s map: the distributor, then one region of redistributors.
    f.begin(&format!("intc@{GICD:x}"));
    f.strs("compatible", &["arm,gic-v3"]);
    f.cells("#interrupt-cells", &[3]);
    f.flag("interrupt-controller");
    f.cells("#redistributor-regions", &[1]);
    let rd = ncpus as u64 * crate::gicv3::GICR_STRIDE;
    f.cells64("reg", &[GICD, crate::gicv3::GICD_SIZE, GICR, rd]);
    f.cells("phandle", &[GIC_PHANDLE]);
    f.end();

    // PPIs (type 1): secure physical 13, non-secure physical 14, virtual 11,
    // hypervisor 10 (INTIDs 29, 30, 27, 26); level-high (a GICv3 has no CPU
    // mask in the flags).
    const PPI: u32 = 1;
    const LEVEL: u32 = 4;
    f.begin("timer");
    f.strs("compatible", &["arm,armv8-timer"]);
    f.cells(
        "interrupts",
        &[
            PPI, 13, LEVEL, PPI, 14, LEVEL, PPI, 11, LEVEL, PPI, 10, LEVEL,
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

    if rtc {
        f.begin(&format!("pl031@{RTC:x}"));
        f.strs("compatible", &["arm,pl031", "arm,primecell"]);
        f.cells64("reg", &[RTC, 0x1000]);
        f.cells("interrupts", &[0, IRQ_RTC as u32 - 32, 4]);
        f.cells("clocks", &[CLK_PHANDLE]);
        f.strs("clock-names", &["apb_pclk"]);
        f.end();
    }

    if flash.is_some() {
        let pa = crate::fw_cfg::FW_CFG;
        f.begin(&format!("fw-cfg@{pa:x}"));
        f.strs("compatible", &["qemu,fw-cfg-mmio"]);
        f.cells64("reg", &[pa, crate::fw_cfg::SIZE]);
        f.flag("dma-coherent");
        f.end();
    }

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

    if xhci {
        let pa = crate::xhci::BASE;
        f.begin(&format!("usb@{pa:x}"));
        f.strs("compatible", &["generic-xhci"]);
        f.cells64("reg", &[pa, crate::xhci::SIZE]);
        f.cells("interrupts", &[0, crate::xhci::IRQ as u32 - 32, 4]);
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
        // The host's values and the Image header's: checked, so a bad one is refused (not a
        // panic, or a wrap in release).
        let rd = |pa: u64, size| {
            let pa = pa.checked_add(kernel_pa).ok_or("kernel outside RAM")?;
            self.mem.read(pa, size).map_err(|_| "kernel outside RAM")
        };
        if rd(0x38, 4)? as u32 == IMAGE_MAGIC {
            let text_offset = rd(8, 8)?;
            let base = kernel_pa
                .checked_sub(text_offset)
                .ok_or("Image base below 0")?;
            if !base.is_multiple_of(2 << 20) {
                return Err("Image base not 2 MiB aligned");
            }
        }
        // RAM: memory 0 (the host-visible window is in memory 1).
        let ram = self.mem.size();
        let dtb_pa = RAM_BASE + ram - DTB_SPACE;
        let fb = framebuffer(&self.cfg);
        let initrd = match initrd.map(|(pa, len)| pa.checked_add(len).map(|end| (pa, end))) {
            None => None,
            Some(Some((start, end))) if start >= RAM_BASE && end <= fb.map_or(dtb_pa, |f| f.0) => {
                Some((start, end))
            }
            Some(_) => return Err("initrd outside RAM or over the framebuffer or DTB space"),
        };
        let fb = fb.map(|(pa, _)| (pa, self.cfg.fb_width, self.cfg.fb_height));
        let ncpus = self.cfg.ncpus.max(1) as usize;
        let spill: Vec<_> = self.mem.spill().iter().map(|s| (s.phys, s.size)).collect();
        let blob = dtb(
            ram,
            &spill,
            cmdline,
            initrd,
            self.plat.get_mut().virtio.len(),
            fb,
            ncpus,
            self.cfg.has_rtc(),
            self.cfg.firmware().then_some(self.cfg.flash_size),
            self.cfg.xhci != 0,
        );
        if blob.len() as u64 > DTB_SPACE {
            return Err("DTB too large");
        }
        if self.cfg.firmware() && blob.len() as u64 > FIRMWARE_DTB_MAX {
            return Err("DTB too large for the firmware's copy");
        }
        for (k, b) in blob.iter().enumerate() {
            self.mem
                .write(dtb_pa + k as u64, 1, *b as u64)
                .map_err(|_| "RAM too small for the DTB")?;
        }
        let mut c = Cpu::reset();
        c.pc = kernel_pa;
        c.x[0] = dtb_pa;
        // What the VM gave the vCPU stays: its features (with the GIC's) and MPIDR.
        let v0 = &mut self.vcpus[0];
        (c.features, c.mpidr) = (v0.cpu.features, v0.cpu.mpidr);
        v0.cpu = c;
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
        let cfg = VmConfig {
            features: crate::cpu::FEATURE_CRYPTO,
            ..VmConfig::default()
        };
        let mut vm = Vm::new(mem, cfg);
        let k = RAM_BASE + (2 << 20);
        assert!(
            vm.boot(RAM_BASE + (8 << 20), None, "").is_err(),
            "outside RAM"
        );
        vm.boot(k + 0x1000, None, "").unwrap(); // no header: a raw binary, anywhere
        assert_eq!(vm.vcpus[0].cpu.pc, k + 0x1000);
        vm.mem.write(k + 0x38, 4, IMAGE_MAGIC as u64).unwrap();
        vm.mem
            .write(k + 0x1000 + 0x38, 4, IMAGE_MAGIC as u64)
            .unwrap();
        assert!(vm.boot(k + 0x1000, None, "").is_err(), "not 2 MiB aligned");
        let rd = Some((RAM_BASE + (5 << 20), 2 << 20));
        assert!(vm.boot(k, rd, "").is_err(), "initrd over the DTB space");
        vm.boot(k, Some((RAM_BASE + (4 << 20), 4096)), "x").unwrap();
        let dtb = RAM_BASE + (6 << 20);
        let c = &vm.vcpus[0].cpu;
        assert_eq!((c.pc, c.x[0], c.el(), c.sctlr_el1 & 1), (k, dtb, 1, 0));
        assert_eq!(
            c.features,
            crate::cpu::FEATURE_CRYPTO | crate::cpu::FEATURE_GICV3,
            "the reset keeps the VM's features"
        );
        assert_eq!(vm.mem.read(dtb, 4), Ok(0xedfe0dd0)); // FDT magic, big-endian
        // Values the arithmetic would overflow on are refused, not a panic or a wrap.
        assert!(
            vm.boot(u64::MAX - 7, None, "").is_err(),
            "the header past 2^64"
        );
        vm.mem.write(k + 8, 8, k + (2 << 20)).unwrap();
        assert!(vm.boot(k, None, "").is_err(), "a text_offset past the base");
        vm.mem.write(k + 8, 8, 0).unwrap();
        let rd = Some((RAM_BASE + (4 << 20), u64::MAX));
        assert!(vm.boot(k, rd, "").is_err(), "an initrd's end past 2^64");
    }

    #[test]
    fn framebuffer_sits_below_the_dtb_in_whole_2_mib_units() {
        let cfg = |w, h| VmConfig {
            ram_size: 256 << 20,
            fb_width: w,
            fb_height: h,
            ..VmConfig::default()
        };
        assert_eq!(framebuffer(&cfg(0, 0)), None);
        assert_eq!(
            framebuffer(&cfg(640, 480)),
            Some((0x4fc0_0000, 640 * 480 * 4))
        );
        let big = 1024 * 768 * 4;
        assert_eq!(framebuffer(&cfg(1024, 768)), Some((0x4fa0_0000, big)));
        assert_eq!(framebuffer(&cfg(8192, 8192)), None, "over half of RAM");
        assert_eq!(framebuffer(&cfg(u64::MAX, 2)), None);
    }

    /// Our DTB, decompiled by `dtc`, must match the reviewed sources
    /// tests/dtb/webpc.dts (two vCPUs, the RTC, the xHCI; a round trip through the reference
    /// tool) and webpc-firmware.dts (the firmware configuration: one vCPU, the
    /// flash bank, fw_cfg) and webpc-numa.dts (the firmware configuration with two
    /// spill memories, docs/spill-memories.md). Set UPDATE_DTS=1 to rewrite
    /// them after an intended change.
    #[test]
    fn dtb_round_trips_through_dtc() {
        let spill = VmConfig {
            ram_size: 256 << 20,
            spill: [1 << 30, 1 << 32, 0, 0, 0, 0, 0, 0],
            ..VmConfig::default()
        }
        .spill_layout();
        assert_eq!(spill, [(0x8000_0000, 1 << 30), (0x1_0000_0000, 1 << 32)]);
        let cases = [
            (
                "webpc.dts",
                2,
                "console=ttyAMA0 earlycon",
                Some((0x4800_0000, 0x4810_0000)),
                None,
                &[][..],
            ),
            ("webpc-firmware.dts", 1, "", None, Some(1 << 20), &[][..]),
            ("webpc-numa.dts", 2, "", None, Some(1 << 20), &spill[..]),
        ];
        for (name, ncpus, cmdline, initrd, flash, spill) in cases {
            let blob = dtb(
                256 << 20,
                spill,
                cmdline,
                initrd,
                2,
                Some((0x4fc0_0000, 640, 480)),
                ncpus,
                true,
                flash,
                ncpus == 2 && spill.is_empty(), // the xHCI in webpc.dts
            );
            let dir =
                std::env::temp_dir().join(format!("webpc-dtb-{}-{ncpus}", std::process::id()));
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
            let golden = format!("{}/../tests/dtb/{name}", env!("CARGO_MANIFEST_DIR"));
            if std::env::var_os("UPDATE_DTS").is_some() {
                std::fs::write(&golden, &dts).unwrap();
            }
            assert_eq!(
                dts,
                std::fs::read_to_string(&golden).unwrap(),
                "UPDATE_DTS=1 rewrites {golden}"
            );
        }
    }
}
