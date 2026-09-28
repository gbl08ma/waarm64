// M8 loop 1: host input on the PL011. The RX and RX-timeout interrupts on,
// "ready" printed, then WFI with no timer armed: only the host's input (and,
// in parallel SMP, the SIGNAL_RX wake-up that comes with it) can end the wait.
// The handler reads DR until RXFE; a line ends the test, which echoes it.
// Two vCPUs, the second never started: in parallel mode either may be the one
// that sees the signal. The runners send the `// input:` line (with a newline)
// once the test waits (docs/testing.md "Bare-metal tests").
// smp: 2
// input: ping
#include "lib.h"

#define DR 0x00
#define FR 0x18
#define IMSC 0x38
#define RXFE (1 << 4)
#define RXI (1 << 4)
#define RTI (1 << 6)
#define R(off) mmio32(UART + (off))

static volatile u64 n_irq, n;
static volatile int done;
static char line[64];

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(100 + vec);
  u64 iar = sysreg(ICC_IAR1_EL1);
  if (iar != 33) power_off(30);
  n_irq++;
  while (!done && !(R(FR) & RXFE)) {
    char c = R(DR) & 0xff;
    if (c == '\n' || c == '\r') done = 1;
    else if (n < sizeof line - 1) line[n++] = c;
  }
  if (done) R(IMSC) = 0;
  set_sysreg(ICC_EOIR1_EL1, iar);
  (void)f;
}

int main(void) {
  set_sysreg(CNTV_CTL_EL0, 0); // no timer to wake the WFI
  set_sysreg(CNTP_CTL_EL0, 0);
  check(R(FR) & RXFE, 1); // nothing received yet
  gic_init();
  mmio32(GICD + 0x6000 + 8 * 33) = 0; // IROUTER33: CPU 0
  mmio32(GICD + 0x084) = 1 << 1;      // IGROUPR1: group 1
  mmio8(GICD + 0x400 + 33) = 0xa0;
  mmio32(GICD + 0x104) = 1 << 1; // ISENABLER1: SPI 1 = INTID 33
  R(IMSC) = RXI | RTI;
  uart_puts("ready\n");
  while (!done) {
    __asm__ volatile("wfi"); // IRQs masked: a pending one still ends it
    __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  }
  check(n_irq >= 1, 2);
  line[n] = 0;
  check(n == 4 && line[0] == 'p' && line[1] == 'i' && line[2] == 'n' && line[3] == 'g', 3);
  uart_puts("got ");
  uart_puts(line);
  uart_putc('\n');
  return 0;
}
