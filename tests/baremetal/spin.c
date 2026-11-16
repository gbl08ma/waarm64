// A vCPU that loops in compiled code with no exits (PERF loop 31: parallel SMP's code has no step budget, it polls a
// stop word where a cycle can close; docs/jit.md "Preemption") must still take its timer's IRQ, take another vCPU's
// IPI, answer its TLBI IS (the issuer's DSB completes) and stop for the host. CPU 1 spins in five shapes, copied to a
// code area so their layout is exact: a one-block loop (a region's back-edge once compiled), a cycle of 20 blocks (more
// than a region holds: a backward chain, through the jump cache under JIT-check, which enters it mid-way), a BR to
// itself (the transfer cache's probe; the jump cache's with the MMU off), two BRs 64 KiB apart (the same transfer cache
// slot: every transfer through its miss function), and a branch back to the page before (a by-VA link under
// JIT-check). Each at EL1 with the MMU off, at EL1 with it on, and at EL0. Meanwhile CPU 0 times IPI round trips
// (SGI 1 to CPU 1, whose handler sends SGI 2 back) and TLBI VMALLE1IS + DSB ISH; then, in a second pass with nothing
// else going on, CPU 1 its timer's lateness (1 ms after it starts to spin, when the shape is compiled already); it
// prints the medians in µs (tests/spin.test.ts holds them to bounds in parallel SMP, with long chunks too, where only
// the stop word ends one early). Last, CPU 1 spins while the host pauses the machine: CPU 0 waits for the host's
// release at a fixed address (0x40a0_0000: the phase, the host's hello, the release), or 10 ms of the counter if no
// host says hello. The guest checks only that everything completes (it passes on the oracles and the deterministic
// runners too, where the numbers mean nothing).
// smp: 2
#include "lib.h"

#define RD(c) (GICR + 0x20000UL * (c))
#define SGI_C(c) (RD(c) + 0x10000)
#define VTIMER 27
#define PSCI_CPU_ON 0xc4000003UL
#define ROUNDS 8
#define FORMS 5
#define ENVS 3

#define TABLE 3UL
#define PAGE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)
#define AP_RW_ALL (1UL << 6)    // EL1 and EL0 read-write (EL1 can't execute it)
#define AP_RO_ALL (3UL << 6)    // EL1 and EL0 read-only (both execute it)
#define DEVICE (1UL << 2)       // MAIR index 1
#define XN (3UL << 53)

// The code area (a 2 MiB block, read-only and executable at EL0 and EL1) and the host's words (a 2 MiB block).
#define CODE 0x40800000UL
#define HOST 0x40a00000UL
#define PHASE_STOP 0x5709UL

void secondary_start(void);

// Every writable object, page-aligned: the pages before it are text and read-only data (mapped read-only at both ELs,
// executable), the pages from it on read-write at both (lib.h's power_off turns the MMU off before the UART).
static struct {
  u64 l0[512], l1[512], l2[512], l3[512];
  char stack1[8192];
  // The spinner's words: `done` ends a shape, `in` says it's in one (its prologue sets it).
  volatile u64 done, in;
  volatile u64 cmd, ack, finished;
  volatile u64 back, t1, timer, late;
  u64 rtt[ENVS][FORMS], tlbi[ENVS][FORMS], timer_late[ENVS][FORMS];
  // The shapes' entries, and where the next word goes while writing them.
  u64 shape[FORMS];
  volatile u32 *at;
} g __attribute__((aligned(4096)));

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

static u64 now(void) { return sysreg(CNTVCT_EL0); }
static void sgi(u64 id, u64 cpu) { set_sysreg(ICC_SGI1R_EL1, id << 24 | 1UL << cpu); }
static void delay(u64 ticks) {
  u64 t = now();
  while (now() - t < ticks)
    ;
}

static void gic_cpu_init(u64 c) {
  mmio32(RD(c) + 0x14) &= ~2u; // GICR_WAKER.ProcessorSleep
  while (mmio32(RD(c) + 0x14) & 4)
    ;
  mmio32(SGI_C(c) + 0x080) = ~0u; // SGIs and PPIs group 1
  mmio32(SGI_C(c) + 0x100) = 1u << 1 | 1u << 2 | 1u << VTIMER;
  set_sysreg(ICC_PMR_EL1, 0xf0);
  set_sysreg(ICC_IGRPEN1_EL1, 1);
}

void on_exception(struct frame *f, u64 vec) {
  u64 ec = f->esr >> 26;
  if (vec == VEC_EL0_SYNC && ec == 0x15 && (f->esr & 0xffff) == 1) {
    f->elr = (u64)el0_return; // run_el0's way back
    f->spsr = 0x3c5;
    return;
  }
  if (vec != VEC_EL1H_IRQ && vec != VEC_EL0_SYNC + 1) {
#ifdef SPIN_DEBUG
    mmio32(UART + 0x30) = 0x301;
    uart_puts("esr "); uart_dec(f->esr); uart_puts(" elr "); uart_dec(f->elr); uart_puts(" far "); uart_dec(f->far); uart_puts("\n");
#endif
    power_off(100 + vec);
  }
  u64 iar = sysreg(ICC_IAR1_EL1);
  if (iar == 1) { // CPU 1: the ping
    sgi(2, 0);
  } else if (iar == 2) { // CPU 0: the pong
    g.t1 = now();
    __atomic_store_n(&g.back, 1, __ATOMIC_SEQ_CST);
  } else if (iar == VTIMER) { // CPU 1's own timer
    g.late = now() - sysreg(CNTV_CVAL_EL0);
    set_sysreg(cntv_ctl_el0, 0);
    __atomic_store_n(&g.timer, 1, __ATOMIC_SEQ_CST);
  } else if (iar != 1023) {
    power_off(90);
  }
  set_sysreg(ICC_EOIR1_EL1, iar);
}

// The shapes' code, written word by word (x0 = &g.done throughout), with the MMU off: Device memory, where the
// compiler's merged 8-byte stores at a 4-byte boundary would fault (volatile keeps them single).
#define at g.at
#define shape g.shape
static void op(u32 w) { *at++ = w; }
static void movx(u32 rd, u64 v) { // movz, movk: a 32-bit address
  op(0xd2800000 | (u32)(v & 0xffff) << 5 | rd);
  op(0xf2a00000 | (u32)(v >> 16 & 0xffff) << 5 | rd);
}
static u32 b_to(volatile u32 *from, volatile u32 *to) { return 0x14000000 | (u32)((to - from) & 0x3ffffff); }
static u32 cbnz_to(volatile u32 *from, volatile u32 *to) { return 0xb5000001 | (u32)((to - from) & 0x7ffff) << 5; } // x1
static u32 cbz_to(volatile u32 *from, volatile u32 *to) { return 0xb4000001 | (u32)((to - from) & 0x7ffff) << 5; }
#define LDR_X1_X0 0xf9400001u
#define RET 0xd65f03c0u
#define BR(n) (0xd61f0000u | (n) << 5)

// The prologue: x0 = &done, `in` = 1.
static void prologue(void) {
  movx(0, (u64)&g.done);
  op(0xd2800021); // movz x1, #1
  op(0xf9000401); // str x1, [x0, #8]
}


static void write_shapes(void) {
  // 0: a one-block loop.
  at = (volatile u32 *)CODE;
  shape[0] = (u64)at;
  prologue();
  volatile u32 *l = at;
  op(LDR_X1_X0);
  op(cbz_to(at, l));
  op(RET);

  // 1: twenty blocks, entered at the tenth: the done check, then `b .+4` nineteen times, the last back to the check.
  at = (volatile u32 *)(CODE + 0x1000);
  shape[1] = (u64)at;
  prologue();
  volatile u32 *jump = at++;
  volatile u32 *head = at;
  op(LDR_X1_X0);
  volatile u32 *exit = at++;
  volatile u32 *c[19];
  for (int i = 0; i < 19; i++) c[i] = at++;
  for (int i = 0; i < 18; i++) *c[i] = b_to(c[i], c[i] + 1);
  *c[18] = b_to(c[18], head);
  *jump = b_to(jump, c[9]);
  *exit = cbnz_to(exit, at);
  op(RET);

  // 2: a BR to itself.
  at = (volatile u32 *)(CODE + 0x2000);
  shape[2] = (u64)at;
  prologue();
  movx(2, (u64)(at + 2));
  l = at;
  op(LDR_X1_X0);
  op(cbnz_to(at, at + 2));
  op(BR(2));
  op(RET);
  (void)l;

  // 3: two BRs to each other 64 KiB apart, at the same offset: one transfer cache slot.
  at = (volatile u32 *)(CODE + 0x10000);
  shape[3] = (u64)at;
  prologue();
  volatile u32 *a = (volatile u32 *)(CODE + 0x10040), *bb = (volatile u32 *)(CODE + 0x20040);
  movx(2, (u64)bb);
  movx(3, (u64)a);
  op(b_to(at, a));
  at = a;
  op(LDR_X1_X0);
  op(cbnz_to(at, at + 2));
  op(BR(2));
  op(RET);
  at = bb;
  op(LDR_X1_X0);
  op(cbnz_to(at, at + 2));
  op(BR(3));
  op(RET);

  // 4: a branch back to the page before, whose block branches forward again; entered from a third page, so the
  // first block compiled is the one with the backward branch (JIT-check: a by-VA link, as nothing is at Y yet).
  volatile u32 *y = (volatile u32 *)(CODE + 0x30000), *x = (volatile u32 *)(CODE + 0x31000);
  at = (volatile u32 *)(CODE + 0x32000);
  shape[4] = (u64)at;
  prologue();
  op(b_to(at, x));
  at = x;
  op(LDR_X1_X0);
  op(cbnz_to(at, at + 2));
  op(b_to(at, y));
  op(RET);
  *y = b_to(y, x);

  __asm__ volatile("dsb sy; ic iallu; dsb sy; isb" ::: "memory");
}

// Identity maps: devices (EL1), the binary (text read-only at both ELs, the rest read-write at both), the code area,
// the host's words.
static void tables(void) {
  g.l0[0] = (u64)g.l1 | TABLE;
  g.l1[0] = 0 | BLOCK | AF | DEVICE | XN;
  g.l1[1] = (u64)g.l2 | TABLE;
  g.l2[0] = (u64)g.l3 | TABLE;
  for (u64 i = 0; i < 512; i++) {
    u64 pa = 0x40000000UL + (i << 12);
    g.l3[i] = pa | PAGE | AF | SH_INNER | (pa < (u64)&g ? AP_RO_ALL : AP_RW_ALL);
  }
  g.l2[(CODE - 0x40000000UL) >> 21] = CODE | BLOCK | AF | SH_INNER | AP_RO_ALL;
  g.l2[(HOST - 0x40000000UL) >> 21] = HOST | BLOCK | AF | SH_INNER | AP_RW_ALL | XN;
}

static void mmu_on(void) {
  set_sysreg(mair_el1, 0x00ff);
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)g.l0);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}

// The spinner's commands: env << 8 | form, plus one, with TIMED for the timer's pass; the stop phase; the end.
#define TIMED 0x800UL
#define CMD_STOP 0x1000UL
#define CMD_END 0x2000UL

static void spin(u64 env, u64 form) {
  u64 (*f)(void) = (u64(*)(void))shape[form];
  if (env == 2) {
    run_el0(f, (u64)user_stack_top);
  } else {
    __asm__ volatile("msr daifclr, #2" ::: "memory");
    f();
    __asm__ volatile("msr daifset, #2" ::: "memory");
  }
}

void secondary_main(void) {
  gic_cpu_init(1);
  u64 seen = 0;
  for (;;) {
    u64 cmd;
    while ((cmd = __atomic_load_n(&g.cmd, __ATOMIC_SEQ_CST)) == seen)
      ;
    seen = cmd;
    if (cmd == CMD_END) break;
    u64 c = cmd & ~TIMED, env = c == CMD_STOP ? 1 : (c - 1) >> 8, form = c == CMD_STOP ? 0 : (c - 1) & 0xff;
    if (env >= 1 && !(sysreg(SCTLR_EL1) & 1)) mmu_on();
    g.in = 0;
    // Its timer, due once it spins with nothing else going on (the IRQ's lateness is the measure).
    g.timer = 0;
    if (cmd & TIMED) {
      set_sysreg(cntv_tval_el0, sysreg(CNTFRQ_EL0) / 1000); // 1 ms
      set_sysreg(cntv_ctl_el0, 1);
    }
    __atomic_store_n(&g.ack, cmd, __ATOMIC_SEQ_CST);
    spin(env, form);
    __atomic_store_n(&g.finished, cmd, __ATOMIC_SEQ_CST);
  }
  __atomic_store_n(&g.finished, CMD_END, __ATOMIC_SEQ_CST);
  for (;;)
    __asm__ volatile("wfi");
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 400000000UL) power_off(code); } while (0)

static u64 median(u64 *v) {
  for (int i = 1; i < ROUNDS; i++)
    for (int j = i; j > 0 && v[j - 1] > v[j]; j--) {
      u64 t = v[j];
      v[j] = v[j - 1];
      v[j - 1] = t;
    }
  return v[ROUNDS / 2];
}

static u64 us(u64 ticks) { return ticks * 1000000 / sysreg(CNTFRQ_EL0); }

// Has CPU 1 spin in `cmd`'s shape, and waits until it's in.
static void start(u64 cmd, u64 code) {
  g.done = 0;
  __atomic_store_n(&g.cmd, cmd, __ATOMIC_SEQ_CST);
  WAIT(__atomic_load_n(&g.ack, __ATOMIC_SEQ_CST) == cmd && g.in, code);
}

// Ends CPU 1's spin in `cmd`'s shape.
static void stop(u64 cmd, u64 code) {
  __atomic_store_n(&g.done, 1, __ATOMIC_SEQ_CST);
  WAIT(__atomic_load_n(&g.finished, __ATOMIC_SEQ_CST) == cmd, code);
}

// Runs a shape twice: CPU 0 times what it must answer, then CPU 1 its own timer, with nothing else going on.
static void run(u64 env, u64 form) {
  u64 cmd = (env << 8 | form) + 1, gap = sysreg(CNTFRQ_EL0) / 20000; // 50 µs
  start(cmd, 10 + form);
  u64 r[ROUNDS];
  for (int i = 0; i < ROUNDS; i++) {
    delay(gap);
    g.back = 0;
    u64 t0 = now();
    sgi(1, 1);
    WAIT(__atomic_load_n(&g.back, __ATOMIC_SEQ_CST), 20 + form);
    r[i] = g.t1 - t0;
  }
  g.rtt[env][form] = us(median(r));
  for (int i = 0; i < ROUNDS; i++) {
    delay(gap);
    u64 t0 = now();
    __asm__ volatile("dsb ishst; tlbi vmalle1is; dsb ish; isb" ::: "memory");
    r[i] = now() - t0;
  }
  g.tlbi[env][form] = us(median(r));
  stop(cmd, 40 + form);
  start(cmd | TIMED, 10 + form);
  // Nothing ends a chunk for the timer but its steps (P2's ticker will): with a host's long chunks, a ping after
  // 50 ms makes CPU 1 look (a slow run's latency, still bounded).
  u64 t = now(), n = 0;
  while (!__atomic_load_n(&g.timer, __ATOMIC_SEQ_CST)) {
    if (n++ > 400000000UL) power_off(30 + form);
    if (t && now() - t > sysreg(CNTFRQ_EL0) / 20) {
      t = 0;
      sgi(1, 1);
    }
  }
  g.timer_late[env][form] = us(g.late);
  stop(cmd | TIMED, 40 + form);
}

static const char *const ENV[ENVS] = {"el1-off", "el1-on", "el0-on"};
static const char *const FORM[FORMS] = {"loop", "chain", "br", "miss", "byva"};

int main(void) {
  mmio32(GICD) = 1 << 4 | 1 << 1; // ARE, EnableGrp1
  while (mmio32(GICD) & 1u << 31)
    ;
  gic_cpu_init(0);
  write_shapes();
  tables();
  volatile u64 *host = (volatile u64 *)HOST;
  host[0] = host[1] = host[2] = 0;
  check(psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(g.stack1 + sizeof g.stack1)) == 0, 2);
  __asm__ volatile("msr daifclr, #2" ::: "memory");
  for (u64 env = 0; env < ENVS; env++) {
    if (env == 1) mmu_on();
    for (u64 form = 0; form < FORMS; form++) run(env, form);
  }
  // The host's pauses: CPU 1 spins in the loop at EL1.
  start(CMD_STOP, 50);
  __atomic_store_n(&host[0], PHASE_STOP, __ATOMIC_SEQ_CST);
  u64 t = now(), f = sysreg(CNTFRQ_EL0);
  while (!__atomic_load_n(&host[2], __ATOMIC_SEQ_CST) && now() - t < (host[1] ? 30 * f : f / 100))
    ;
  stop(CMD_STOP, 51);
  __atomic_store_n(&g.cmd, CMD_END, __ATOMIC_SEQ_CST);
  WAIT(__atomic_load_n(&g.finished, __ATOMIC_SEQ_CST) == CMD_END, 52);
  __asm__ volatile("msr daifset, #2" ::: "memory");
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  for (u64 env = 0; env < ENVS; env++)
    for (u64 form = 0; form < FORMS; form++) {
      uart_puts("spin ");
      uart_puts(ENV[env]);
      uart_puts(" ");
      uart_puts(FORM[form]);
      uart_puts(" rtt ");
      uart_dec(g.rtt[env][form]);
      uart_puts(" tlbi ");
      uart_dec(g.tlbi[env][form]);
      uart_puts(" timer ");
      uart_dec(g.timer_late[env][form]);
      uart_puts("\n");
    }
  return 0;
}
