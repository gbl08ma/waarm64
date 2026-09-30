// The host-stall test (tests/hoststall.test.ts, docs/testing.md "Host stalls"): a vCPU's
// host worker stalls while another vCPU's DSB waits for its TLBI IS. This guest
// cooperates with a test-only hook in the worker (web/vm.ts `Stall`) through a
// word in RAM at FLAG: CPU 1 writes MODE to it ("armed"); the hook of CPU 1's
// worker sees it, writes 2 ("stalling") and blocks the worker. CPU 0 waits for
// the 2, then runs TLBI VMALLE1IS + DSB ISH.
//   run     (MODE 1): CPU 1 spins, and the hook stalls its clock import (`now_ms`,
//           called between chunks, inside vm_run_cpu: the vCPU is RUN).
//   install (MODE 1, -DFRESH): CPU 1 keeps running never-compiled code, and the
//           hook stalls the `jit_install` import (inside the chunk: RUN).
//   idle    (MODE 3, -DIDLE): CPU 1 executes WFI, and the hook stalls its worker
//           after vm_run_cpu returned IDLE (the vCPU is OUT). The DSB must not wait:
//           CPU 0 checks it took far less than the stall (CNTVCT).
//   waiter  (MODE 1, -DWAITER): as run, but vCPU 1's worker stalls 13 s and vCPU 0's
//           own worker stalls 11 s in the middle of its DSB wait (a second hook,
//           armed by the first's 2). vCPU 1 is healthy afterwards: the wait must
//           not count the waiter's own stall against the DSB limit, and the DSB
//           returns once vCPU 1 does (CPU 0 checks it waited over 10 s).
// The run and install variants end in the core's DSB panic once the wait
// passes the DSB limit (10 s), which the test expects; idle and waiter pass.
// smp: 2
#include "../baremetal/lib.h"

#define PSCI_CPU_ON 0xc4000003UL
#define FLAG ((volatile u64 *)0x40800000UL)
#ifdef IDLE
#define MODE 3
#else
#define MODE 1
#endif

#define TABLE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1;

void secondary_start(void);
static char stack1[4096] __attribute__((aligned(16)));
static volatile u64 go, stop, ack;

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(90 + vec);
}

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

// Normal memory everywhere: RAM identity-mapped by a 1 GiB block, MMU and caches on, no ASID (TLBI IS waits for all).
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}

#ifdef FRESH
// Code that has never run: enough executions make its blocks hot and the JIT compiles them (jit_install).
__asm__(".text\n.balign 4096\n.globl fresh\nfresh:\n.rept 1500\nnop\n.endr\nret\n");
void fresh(void);
#endif

void secondary_main(void) {
  mmu_on();
  __atomic_store_n(&ack, 1, __ATOMIC_RELEASE);
  while (!__atomic_load_n(&go, __ATOMIC_ACQUIRE))
    ;
  __atomic_store_n(FLAG, MODE, __ATOMIC_SEQ_CST);
#ifdef IDLE
  for (;;)
    __asm__ volatile("wfi");
#endif
  while (!stop) {
#ifdef FRESH
    fresh();
#endif
  }
  for (;;)
    __asm__ volatile("wfi");
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 3000000000UL) power_off(code); } while (0)

int main(void) {
  l0[0] = (u64)l1 | TABLE;
  l1[1] = 0x40000000UL | BLOCK | AF | SH_INNER;
  mmu_on();
  *FLAG = 0;
  check(psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(stack1 + sizeof stack1)) == 0, 2);
  WAIT(__atomic_load_n(&ack, __ATOMIC_ACQUIRE) == 1, 10);
  __atomic_store_n(&go, 1, __ATOMIC_RELEASE);
  WAIT(__atomic_load_n(FLAG, __ATOMIC_ACQUIRE) == 2, 11); // the host stalled CPU 1's worker
  u64 t0 = sysreg(CNTVCT_EL0);
  __asm__ volatile("dsb ishst; tlbi vmalle1is; dsb ish; isb" ::: "memory");
  u64 ticks = sysreg(CNTVCT_EL0) - t0;
#ifdef IDLE
  check(ticks < sysreg(CNTFRQ_EL0) / 2, 20); // an OUT vCPU isn't waited for
  return 0;
#elif defined(WAITER)
  check(ticks > 10 * sysreg(CNTFRQ_EL0), 22); // the wait outlasted the DSB limit: it counts waiting only
  return 0;
#else
  (void)ticks;
  power_off(21); // the DSB returned: the stall didn't reach it
#endif
}
