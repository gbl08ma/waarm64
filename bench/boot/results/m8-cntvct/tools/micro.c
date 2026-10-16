#include "lib.h"
// One loop of N iterations of a single MRS (REG), then power off.
void main(void) {
  u64 acc = 0;
  for (u64 i = 0; i < 2000000; i++) {
    u64 v;
    __asm__ volatile("mrs %0, " REG : "=r"(v));
    acc += v;
  }
  __asm__ volatile("" : : "r"(acc));
}
struct frame; void on_exception(struct frame *f, u64 vec) { (void)f; (void)vec; power_off(99); }
