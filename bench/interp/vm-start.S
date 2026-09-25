// EL1 entry for guest-vm.bin in a whole VM (bench/interp/suite.ts, vm_run MIPS).
// Loaded as a raw binary at PA 0x40200000 with guest-vm.bin 64 KiB after it.
// x1 = 1 turns the MMU on first: TTBR0 maps the 1 GiB at 0x40000000 onto
// itself as one Normal write-back block, so VA = PA and the guest runs the
// same either way. Build: build.sh
    .section .text
    .globl _start
_start:
    mov     x2, #(3 << 20)          // CPACR_EL1.FPEN: no FP traps
    msr     cpacr_el1, x2
    cbz     x1, 1f
    mov     x2, #0xff               // MAIR attr 0: Normal, write-back
    msr     mair_el1, x2
    // T0SZ 25 (39-bit VA, walks start at level 1), inner/outer WB, inner
    // shareable, 4K granule, EPD1, IPS 40 bits.
    ldr     x2, =(25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2 << 32)
    msr     tcr_el1, x2
    adr     x2, l1
    msr     ttbr0_el1, x2
    isb
    mrs     x2, sctlr_el1
    orr     x2, x2, #1              // M
    msr     sctlr_el1, x2
    isb
1:  ldr     x2, =0x40210000
    br      x2
    .ltorg

    .balign 4096
l1: .quad   0
    .quad   0x40000000 | 1 << 10 | 3 << 8 | 1   // AF, inner shareable, block
    .fill   510, 8, 0
