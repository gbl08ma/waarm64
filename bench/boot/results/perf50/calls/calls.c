// PERF loop 50: what a host call costs against a followed call. f calls four leaves; in `host`
// each leaf has a cold tail call through a pointer (an indirect branch: the region can't follow it).
typedef unsigned long u64;
#define ROUNDS ((volatile u64 *)0x80000)
typedef u64 (*fn)(u64);
volatile fn sinkfn;
#ifdef HOST
#define COLD(k) if (__builtin_expect(x == 0x123456789ull + k, 0)) return sinkfn(x);
#else
#define COLD(k) if (x == 0x123456789ull + k) x ^= 7;
#endif
#define G(k) __attribute__((noinline)) u64 g##k(u64 x) { COLD(k) return x * 3 + k; }
G(1) G(2) G(3) G(4)
__attribute__((noinline)) u64 f(u64 x) { x = g1(x); x = g2(x); x = g3(x); x = g4(x); return x + 1; }
__attribute__((noreturn)) void guest_main(void) {
  u64 x = 1;
  for (;;) {
    for (int i = 0; i < 1000; i++) x = f(x);
    *ROUNDS += 1;
    ROUNDS[1] = x;
  }
}
__asm__(".section .text.start\n.globl _start\n_start:\n  mov sp, #0x100000\n  bl guest_main\n");
