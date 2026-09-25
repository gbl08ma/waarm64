// Bare-metal EL1 runtime: stack, vectors, FP on, main(), then power_off (lib.h)
// with main's result. Every exception saves a struct frame and calls
// on_exception(frame, vector), which may edit the saved ELR/SPSR before the ERET.

#define FRAME 288 // x0-x30, elr, spsr, esr, far, 16-byte aligned

    .section .text.start, "ax"
    .global _start
_start:
    ldr x0, =stack_top
    mov sp, x0
    adr x0, vectors
    msr vbar_el1, x0
    mov x0, #(3 << 20)
    msr cpacr_el1, x0
    isb
    bl main
    b power_off

// run_el0(fn, sp): runs fn() at EL0t on stack sp and returns its result. fn
// returns into el0_tramp, whose SVC #1 on_exception turns into a return here.
    .text
    .global run_el0
run_el0:
    stp x29, x30, [sp, #-96]!
    stp x19, x20, [sp, #16]
    stp x21, x22, [sp, #32]
    stp x23, x24, [sp, #48]
    stp x25, x26, [sp, #64]
    stp x27, x28, [sp, #80]
    msr sp_el0, x1
    adr x1, el0_tramp
    msr elr_el1, x1
    msr spsr_el1, xzr
    eret
el0_tramp:
    blr x0
    svc #1
    .global el0_return
el0_return:
    ldp x19, x20, [sp, #16]
    ldp x21, x22, [sp, #32]
    ldp x23, x24, [sp, #48]
    ldp x25, x26, [sp, #64]
    ldp x27, x28, [sp, #80]
    ldp x29, x30, [sp], #96
    ret

.macro entry n
    .balign 0x80
    sub sp, sp, #FRAME
    stp x0, x1, [sp]
    mov x1, #\n
    b common
.endm

    .balign 0x800
vectors:
    .irp n, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    entry \n
    .endr

common:
    stp x2, x3, [sp, #16]
    stp x4, x5, [sp, #32]
    stp x6, x7, [sp, #48]
    stp x8, x9, [sp, #64]
    stp x10, x11, [sp, #80]
    stp x12, x13, [sp, #96]
    stp x14, x15, [sp, #112]
    stp x16, x17, [sp, #128]
    stp x18, x19, [sp, #144]
    stp x20, x21, [sp, #160]
    stp x22, x23, [sp, #176]
    stp x24, x25, [sp, #192]
    stp x26, x27, [sp, #208]
    stp x28, x29, [sp, #224]
    mrs x2, elr_el1
    stp x30, x2, [sp, #240]
    mrs x2, spsr_el1
    mrs x3, esr_el1
    stp x2, x3, [sp, #256]
    mrs x2, far_el1
    str x2, [sp, #272]
    mov x0, sp
    bl on_exception
    ldp x30, x2, [sp, #240]
    msr elr_el1, x2
    ldr x2, [sp, #256]
    msr spsr_el1, x2
    ldp x2, x3, [sp, #16]
    ldp x4, x5, [sp, #32]
    ldp x6, x7, [sp, #48]
    ldp x8, x9, [sp, #64]
    ldp x10, x11, [sp, #80]
    ldp x12, x13, [sp, #96]
    ldp x14, x15, [sp, #112]
    ldp x16, x17, [sp, #128]
    ldp x18, x19, [sp, #144]
    ldp x20, x21, [sp, #160]
    ldp x22, x23, [sp, #176]
    ldp x24, x25, [sp, #192]
    ldp x26, x27, [sp, #208]
    ldp x28, x29, [sp, #224]
    ldp x0, x1, [sp]
    add sp, sp, #FRAME
    eret
