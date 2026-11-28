// PERF loop 92: what `Vm::refresh`'s swap of a vCPU's IRQ byte costs when the value doesn't change, against a load
// first. NR reader threads (the vCPUs) each load their own byte in a loop with ~WORK ns of arithmetic between loads
// (a DAIF unmask's inline check, the run loop); one writer (the vCPU holding the platform lock) does, every GAP ns,
// for each byte: swap (mode 0, today) or load and swap only if it differs (mode 1). Prints the writer's ns a refresh
// and the readers' loads a second. cc -O2 -o swap swap.c -lpthread; ./swap <mode> [readers 3] [gap ns 2000] [s 3]
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#define MAXR 8
struct { _Alignas(128) atomic_bool b; } bytes[MAXR + 1];
static atomic_int stop;
static long loads[MAXR];
#ifdef __APPLE__
#include <mach/mach_time.h>
static double now(void) { static double k; if (!k) { mach_timebase_info_data_t i; mach_timebase_info(&i); k = (double)i.numer / i.denom; } return mach_absolute_time() * k; } // 41.7 ns ticks: a mean over many
#else
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
#endif
static void *reader(void *p) {
  long i = (long)p, n = 0; unsigned x = 1;
  while (!atomic_load_explicit(&stop, memory_order_relaxed)) {
    for (int k = 0; k < 60; k++) x = x * 1103515245u + 12345u; // ~ a few dozen ns of work
    if (atomic_load_explicit(&bytes[i].b, memory_order_seq_cst)) x++;
    n++;
  }
  loads[i] = n + (x == 7);
  return 0;
}
int main(int argc, char **argv) {
  int mode = atoi(argv[1]), nr = argc > 2 ? atoi(argv[2]) : 3; double gap = argc > 3 ? atof(argv[3]) : 2000, secs = argc > 4 ? atof(argv[4]) : 3;
  pthread_t t[MAXR];
  for (long i = 0; i < nr; i++) pthread_create(&t[i], 0, reader, (void *)i);
  double t0 = now(), spent = 0; long refreshes = 0;
  while (now() - t0 < secs * 1e9) {
    double a = now();
    for (int i = 0; i <= nr; i++) { // the readers' bytes and the writer's own
      if (mode == 0) (void)atomic_exchange_explicit(&bytes[i].b, 0, memory_order_seq_cst);
      else if (atomic_load_explicit(&bytes[i].b, memory_order_seq_cst) != 0) atomic_store_explicit(&bytes[i].b, 0, memory_order_seq_cst);
    }
    double b = now();
    spent += b - a; refreshes++;
    while (now() - b < gap) {}
  }
  atomic_store(&stop, 1);
  long all = 0;
  for (int i = 0; i < nr; i++) { pthread_join(t[i], 0); all += loads[i]; }
  printf("mode %d (%s): %d readers, a refresh every %.0f ns: %.1f ns a refresh (%ld), readers' loads %.2f M/s\n", mode, mode ? "load first" : "swap", nr, gap, spent / refreshes, refreshes, all / secs / 1e6);
  return 0;
}
