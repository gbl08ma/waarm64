// M7 loop 3: SMP on a GICv3. CPU 0 starts CPUs 1-3 with PSCI CPU_ON (and
// checks its error codes); each secondary starts on its own stack, records its
// MPIDR, wakes its redistributor and arms its own virtual timer. CPU 0 pings
// every secondary with SGI 1 through ICC_SGI1R_EL1 and each answers with
// SGI 2 (after recording the answer: SGIs from different CPUs to one target
// may merge, since an SGI is pending per target); every CPU takes its own timer's PPI (banked per CPU); the secondaries
// turn themselves off with CPU_OFF, which AFFINITY_INFO then reports.
// oracle: GICv3
// smp: 4
#include "lib.h"

#define NCPU 4
#define GICR 0x080a0000UL
#define RD(c) (GICR + 0x20000UL * (c))
#define SGI_BASE(c) (RD(c) + 0x10000)
#define VTIMER 27
#define PSCI_CPU_OFF 0x84000002UL
#define PSCI_CPU_ON 0xc4000003UL
#define PSCI_AFFINITY_INFO 0xc4000004UL

void secondary_start(void);

static char stacks[NCPU][4096] __attribute__((aligned(16)));
// Per-CPU flags, no read-modify-write: the MMU is off, so memory is Device
// memory, where exclusives needn't make progress (they hang on the M4 under hvf).
static volatile u64 mpidr_of[NCPU], started[NCPU], pings[NCPU], pongs[NCPU], timer_hits[NCPU], sgi2;

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

// CPU i is Aff0 = i (QEMU virt and webpc number up to 16 CPUs so).
static u64 me(void) { return sysreg(MPIDR_EL1) & 0xff; }

static void sgi(u64 id, u64 cpu) { set_sysreg(ICC_SGI1R_EL1, id << 24 | 1UL << cpu); }

static void gic_cpu_init(u64 c) {
  mmio32(RD(c) + 0x14) &= ~2u; // GICR_WAKER.ProcessorSleep
  while (mmio32(RD(c) + 0x14) & 4)
    ;
  mmio32(SGI_BASE(c) + 0x080) = ~0u; // SGIs and PPIs group 1
  mmio32(SGI_BASE(c) + 0x100) = 1u << 1 | 1u << 2 | 1u << VTIMER;
  set_sysreg(ICC_PMR_EL1, 0xf0);
  set_sysreg(ICC_IGRPEN1_EL1, 1);
}

static void arm_timer(void) {
  set_sysreg(cntv_tval_el0, sysreg(CNTFRQ_EL0) / 1000); // 1 ms
  set_sysreg(cntv_ctl_el0, 1);
}

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(100 + vec);
  u64 c = me(), iar = sysreg(ICC_IAR1_EL1);
  if (iar == 1) {
    pings[c]++;
    __atomic_store_n(&pongs[c], 1, __ATOMIC_SEQ_CST);
    sgi(2, 0);
  } else if (iar == 2) {
    sgi2++;
  } else if (iar == VTIMER) {
    timer_hits[c]++;
    set_sysreg(cntv_ctl_el0, 3); // IMASK
  } else if (iar != 1023) {
    power_off(90);
  }
  set_sysreg(ICC_EOIR1_EL1, iar);
  (void)f;
}

void secondary_main(void) {
  u64 c = me();
  mpidr_of[c] = sysreg(MPIDR_EL1);
  gic_cpu_init(c);
  arm_timer();
  __atomic_store_n(&started[c], 1, __ATOMIC_SEQ_CST);
  __asm__ volatile("msr daifclr, #2" ::: "memory");
  while (!pings[c] || !timer_hits[c])
    __asm__ volatile("wfi");
  __asm__ volatile("msr daifset, #2" ::: "memory");
  psci(PSCI_CPU_OFF, 0, 0, 0);
  power_off(80); // CPU_OFF returned
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 100000000UL) power_off(code); } while (0)

int main(void) {
  mmio32(GICD) = 1 << 4 | 1 << 1; // ARE, EnableGrp1
  while (mmio32(GICD) & 1u << 31)
    ;
  gic_cpu_init(0);
  check(me() == 0, 1);
  check(psci(PSCI_AFFINITY_INFO, 1, 0, 0) == 1, 2); // OFF
  for (u64 c = 1; c < NCPU; c++)
    check(psci(PSCI_CPU_ON, c, (u64)secondary_start, (u64)(stacks[c] + sizeof stacks[c])) == 0, 3);
  long again = psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(stacks[1] + sizeof stacks[1]));
  check(again == -4 || again == -5, 4); // ALREADY_ON or ON_PENDING
  check(psci(PSCI_CPU_ON, 0x63, (u64)secondary_start, 0) == -2, 5); // INVALID_PARAMETERS: no such CPU

  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&started[c], __ATOMIC_SEQ_CST), 10);
  for (u64 c = 1; c < NCPU; c++) {
    check((mpidr_of[c] & 0xffffff) == c, 11);
    check(psci(PSCI_AFFINITY_INFO, c, 0, 0) == 0, 12); // ON
  }
  // Ping-pong, and CPU 0's own timer.
  arm_timer();
  __asm__ volatile("msr daifclr, #2" ::: "memory");
  for (u64 c = 1; c < NCPU; c++) sgi(1, c);
  for (;;) {
    u64 n = 0;
    for (u64 c = 1; c < NCPU; c++) n += __atomic_load_n(&pongs[c], __ATOMIC_SEQ_CST);
    if (n == NCPU - 1 && timer_hits[0] && sgi2) break;
    __asm__ volatile("wfi");
  }
  __asm__ volatile("msr daifset, #2" ::: "memory");
  for (u64 c = 1; c < NCPU; c++) check(pings[c] == 1 && timer_hits[c] == 1, 20);
  check(pings[0] == 0 && timer_hits[0] == 1 && sgi2 >= 1 && sgi2 < NCPU, 21);
  // The secondaries turn themselves off.
  for (u64 c = 1; c < NCPU; c++) WAIT(psci(PSCI_AFFINITY_INFO, c, 0, 0) == 1, 30);
  return 0;
}
