// One loop per class: 16 instructions, then the counter (x28) and the back-edge. x9 points at the data area.
.macro loop name
.globl \name
.balign 64
\name:
.endm
.macro tail l
  subs x28, x28, #1
  b.ne \l
  brk #0
.endm
.text
loop alu
1: add x0, x0, #1; sub x1, x1, #3; orr x2, x2, x0; eor x3, x3, x1; lsl x4, x0, #3; add x5, x4, x2; and x6, x5, #0xff; sub x7, x6, x3
   add x0, x0, x1; sub x1, x1, x2; orr x2, x3, x4; eor x3, x5, x6; lsr x4, x7, #2; add x5, x4, x0, lsl #2; and x6, x5, x1; mov x7, x2
   tail 1b
loop movs
1: movz x0, #1; movk x0, #2, lsl #16; movz x1, #3; movk x1, #4, lsl #32; mov x2, x0; mov x3, x1; movz x4, #5; movk x4, #6, lsl #48
   movz x5, #7; movk x5, #8, lsl #16; mov x6, x5; mov x7, x4; movz x0, #9; movz x1, #10; mov x2, x7; mov x3, x6
   tail 1b
loop flags
1: adds x0, x0, x1; csel x2, x0, x1, lo; subs x3, x2, #5; cinc x4, x4, eq; ccmp x0, x3, #4, ne; csel x5, x4, x2, gt; adcs x6, x6, x5; cset x7, cs
   cmp x7, x0; csneg x1, x1, x2, le; ands x2, x2, x3; csel x3, x3, x0, mi; adds w4, w4, w5; cinc x5, x5, vs; sbcs x6, x6, x1; cset x0, hi
   tail 1b
loop ldst
1: ldr x0, [x9]; ldr x1, [x9, #8]; add x2, x0, x1; str x2, [x9, #16]; ldr w3, [x9, #24]; ldrb w4, [x9, #3]; strh w4, [x9, #40]; ldr x5, [x9, #48]
   str x5, [x9, #56]; ldr x6, [x9, x10]; ldrsw x7, [x9, #64]; str w7, [x9, #72]; ldur x0, [x9, #80]; stur x0, [x9, #96]; ldr x1, [x9, #104]; strb w1, [x9, #112]
   tail 1b
loop pairs
1: ldp x0, x1, [x9]; stp x1, x0, [x9, #16]; ldp x2, x3, [x9, #32]; stp x3, x2, [x9, #48]; ldp w4, w5, [x9, #64]; stp w5, w4, [x9, #72]; ldp x6, x7, [x9, #80]; stp x7, x6, [x9, #96]
   ldp x0, x1, [x9, #112]; stp x1, x0, [x9, #128]; ldp x2, x3, [x9, #144]; stp x3, x2, [x9, #160]; ldp x4, x5, [x9, #176]; stp x5, x4, [x9, #192]; ldp x6, x7, [x9, #208]; stp x7, x6, [x9, #224]
   tail 1b
loop muls
1: mul x0, x1, x2; madd x3, x0, x1, x3; umulh x4, x3, x0; smull x5, w1, w2; msub x6, x5, x4, x6; mul w7, w0, w3; umaddl x1, w2, w3, x1; smulh x2, x1, x4
   mul x0, x1, x2; madd x3, x0, x1, x3; umulh x4, x3, x0; smull x5, w1, w2; msub x6, x5, x4, x6; mul w7, w0, w3; umaddl x1, w2, w3, x1; smulh x2, x1, x4
   tail 1b
loop bits
1: ubfx x0, x1, #3, #9; sbfx x2, x0, #2, #5; extr x3, x1, x2, #13; rev x4, x3; clz x5, x4; bfi x6, x5, #8, #8; rbit x7, x6; rev32 x0, x7
   ror x1, x0, #7; cls x2, x1; ubfiz x3, x2, #4, #10; sxtw x4, w3; uxtb w5, w4; rev16 x6, x5; lsrv x7, x6, x0; asrv x0, x7, x1
   tail 1b
loop fp
1: fadd d0, d16, d17; fmul d1, d18, d19; fmadd d2, d16, d17, d18; fsub d3, d19, d20; fadd s4, s21, s22; fmul s5, s21, s23; fcmp d16, d17; fcsel d6, d18, d19, gt
   fdiv d7, d16, d17; fnmul d0, d20, d21; fabs d1, d22; fmax d2, d16, d23; scvtf d3, x2; fcvtzs x3, d18; fmsub d4, d16, d17, d19; fneg d5, d20
   tail 1b
loop neon
1: add v0.4s, v16.4s, v17.4s; eor v1.16b, v18.16b, v19.16b; mul v2.4s, v16.4s, v20.4s; ext v3.16b, v17.16b, v18.16b, #4; and v4.16b, v19.16b, v20.16b; cmeq v5.4s, v21.4s, v16.4s; ushr v6.4s, v22.4s, #3; orr v7.16b, v23.16b, v17.16b
   addp v0.4s, v16.4s, v17.4s; dup v1.4s, w1; umov w2, v18.s[1]; ins v2.s[2], w3; zip1 v3.4s, v19.4s, v20.4s; tbl v4.16b, {v21.16b}, v22.16b; fadd v5.4s, v23.4s, v16.4s; bic v6.16b, v17.16b, v18.16b
   tail 1b
loop sys
1: mrs x0, tpidr_el0; mrs x1, nzcv; mrs x2, tpidrro_el0; add x3, x0, x1; mrs x4, fpcr; msr tpidr_el0, x3; mrs x5, fpsr; mrs x6, tpidr_el0
   mrs x0, tpidr_el0; mrs x1, nzcv; mrs x2, tpidrro_el0; add x3, x0, x1; mrs x4, fpcr; msr tpidr_el0, x3; mrs x5, fpsr; mrs x6, tpidr_el0
   tail 1b
// Short blocks: 2 instructions each, ended by a direct branch to the next.
loop short
1: add x0, x0, #1; b 2f
2: eor x1, x1, x0; b 3f
3: add x2, x2, x1; b 4f
4: sub x3, x3, x2; b 5f
5: orr x4, x4, x3; b 6f
6: add x5, x5, x4; b 7f
7: and x6, x6, x5; b 8f
8: add x7, x7, x6; b 9f
9: subs x28, x28, #1
   b.ne 1b
   brk #0
// Calls and returns: a leaf called 4 times a loop.
loop calls
1: bl 2f; bl 2f; bl 2f; bl 2f
   subs x28, x28, #1
   b.ne 1b
   brk #0
2: add x0, x0, #1; eor x1, x1, x0; ret
