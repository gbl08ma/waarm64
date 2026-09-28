// M3 step 4: the PL011 registers Linux's amba-pl011 driver uses, and its
// interrupt through the GICv3 (SPI 1, INTID 33, routed to CPU 0).
#include "lib.h"

#define DR 0x00
#define FR 0x18
#define IBRD 0x24
#define FBRD 0x28
#define LCR_H 0x2c
#define IMSC 0x38
#define RIS 0x3c
#define MIS 0x40
#define ICR 0x44
#define TXI (1 << 5)
#define R(off) mmio32(UART + (off))

static volatile u64 n_irq, last_iar, last_mis;

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(100 + vec);
  u64 iar = sysreg(ICC_IAR1_EL1);
  n_irq++;
  last_iar = iar;
  last_mis = R(MIS);
  R(IMSC) = 0; // the driver's stop_tx
  set_sysreg(ICC_EOIR1_EL1, iar);
  (void)f;
}

int main(void) {
  // Identification for the AMBA bus probe: PeriphID0-3, PCellID0-3.
  static const u32 id[8] = {0x11, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1};
  for (int i = 0; i < 8; i++) check(R(0xfe0 + 4 * i) == id[i], 1 + i);

  // Line settings read back.
  R(IBRD) = 0x27;
  R(FBRD) = 0x09;
  R(LCR_H) = 0x70; // 8N1, FIFOs on
  check(R(IBRD) == 0x27 && R(FBRD) == 0x09 && R(LCR_H) == 0x70, 10);
  R(IMSC) = 0x50; // RX, RX timeout
  check(R(IMSC) == 0x50, 11);
  R(IMSC) = 0;
  // Nothing received, room to transmit.
  check((R(FR) & 0x30) == 0x10, 12); // RXFE, not TXFF
  check(!(R(RIS) & 0x50), 13);

  uart_puts("hello from the PL011\n");

  // The TX interrupt after output drains, cleared by ICR, taken through the GIC.
  check(R(RIS) & TXI, 20);
  R(ICR) = TXI;
  check(!(R(RIS) & TXI), 21);
  gic_init();
  mmio32(GICD + 0x6000 + 8 * 33) = 0; // IROUTER33: CPU 0 (affinity 0.0.0.0)
  mmio32(GICD + 0x084) = 1 << 1;      // IGROUPR1: group 1
  mmio8(GICD + 0x400 + 33) = 0xa0;
  mmio32(GICD + 0x104) = 1 << 1; // ISENABLER1: SPI 1 = INTID 33
  R(IMSC) = TXI;
  uart_putc('.');
  for (int i = 0; i < 100000 && !(R(RIS) & TXI); i++)
    ;
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 1 && last_iar == 33 && last_mis == TXI, 22);
  uart_putc('\n');
  return 0;
}
