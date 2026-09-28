// Atomics stress for the litmus image (M7): one thread per CPU, each pinned,
// hammering shared atomics; every test checks an exact result. Built twice
// (images/build.sh litmus) from this one file: stress-lse with
// -march=armv8.1-a (LDADD, CAS, CASP) and stress-llsc with -march=armv8-a
// (LDXR/STXR, LDXP/STLXP), both -mno-outline-atomics, so the compiler inlines
// each atomic as those instructions.
//   stress [-n iterations per thread] [test...]   (default: every test)
// Tests:
//   count  __atomic_fetch_add (32 and 64 bits) and a CAS loop on counters
//          sharing a cache line: each must end at threads x n.
//   stack  a Treiber stack of 64 nodes whose head (top, tag) is one 128-bit
//          CAS: each thread pops a node, bumps its count, pushes it back;
//          every node must be there once at the end, the counts summing to
//          threads x n.
//   pingpong  pairs of threads pass a token n / 16 times through a mutex
//          and a condition variable (futexes: sleeping and waking CPUs).
//   spin   CPU 0 stores a sequence number with a plain STR, CPU 1 polls it
//          with plain LDRs and answers the same way, n / 16 round trips:
//          prints the round trip's percentiles (reported, not checked).
// Prints "stress: <test> ok ..." or "stress: <test> FAIL ..." per test and
// exits non-zero on any failure. Portable to real hardware (the oracle VM).
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int nthreads;
static long iters = 100000;
static pthread_barrier_t start;

static void pin(int cpu) {
  cpu_set_t s;
  CPU_ZERO(&s);
  CPU_SET(cpu % nthreads, &s);
  if (sched_setaffinity(0, sizeof s, &s)) perror("sched_setaffinity");
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

// Runs fn(i) on nthreads threads, thread i on CPU i, released together.
static void run(void *(*fn)(void *)) {
  pthread_t t[64];
  pthread_barrier_init(&start, 0, nthreads);
  for (long i = 0; i < nthreads; i++) pthread_create(&t[i], 0, fn, (void *)i);
  for (int i = 0; i < nthreads; i++) pthread_join(t[i], 0);
  pthread_barrier_destroy(&start);
}

static void begin(void *arg) {
  pin((long)arg);
  pthread_barrier_wait(&start);
}

// count: one cache line, three counters.
static struct {
  uint64_t add64;
  uint32_t add32, pad;
  uint64_t cas;
} __attribute__((aligned(64))) counters;

static void *count(void *arg) {
  begin(arg);
  for (long i = 0; i < iters; i++) {
    __atomic_fetch_add(&counters.add64, 1, __ATOMIC_RELAXED);
    __atomic_fetch_add(&counters.add32, 1, __ATOMIC_SEQ_CST);
    uint64_t v = __atomic_load_n(&counters.cas, __ATOMIC_RELAXED);
    while (!__atomic_compare_exchange_n(&counters.cas, &v, v + 1, 0, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED)) {}
  }
  return 0;
}

static int test_count(void) {
  memset(&counters, 0, sizeof counters);
  run(count);
  uint64_t want = (uint64_t)nthreads * iters;
  int ok = counters.add64 == want && counters.add32 == (uint32_t)want && counters.cas == want;
  printf("stress: count %s %llu %u %llu (want %llu)\n", ok ? "ok" : "FAIL", (unsigned long long)counters.add64,
         counters.add32, (unsigned long long)counters.cas, (unsigned long long)want);
  return ok;
}

// stack: nodes by index, the head a (top, tag) pair; the tag defeats ABA.
#define NODES 64
#define EMPTY UINT64_MAX
static struct {
  uint64_t next;
  uint64_t count;
} nodes[NODES];
static union {
  unsigned __int128 v;
  struct {
    uint64_t top, tag;
  };
} head __attribute__((aligned(16)));

// The head's halves, read one at a time: a torn pair only fails the CAS.
static unsigned __int128 read_head(void) {
  uint64_t top = __atomic_load_n(&head.top, __ATOMIC_ACQUIRE);
  uint64_t tag = __atomic_load_n(&head.tag, __ATOMIC_ACQUIRE);
  return (unsigned __int128)tag << 64 | top;
}

static unsigned __int128 pair(uint64_t top, uint64_t tag) { return (unsigned __int128)tag << 64 | top; }

// GCC inlines the __sync builtin on 16 bytes (CASPAL, or LDXP/STLXP and a
// DMB); __atomic_compare_exchange_n there calls libatomic. Updates *h with
// what was there.
static int cas_head(unsigned __int128 *h, unsigned __int128 n) {
  unsigned __int128 was = __sync_val_compare_and_swap(&head.v, *h, n);
  if (was == *h) return 1;
  *h = was;
  return 0;
}

static uint64_t pop(void) {
  unsigned __int128 h = read_head();
  for (;;) {
    uint64_t top = (uint64_t)h, tag = (uint64_t)(h >> 64);
    if (top == EMPTY) {
      h = read_head();
      continue;
    }
    uint64_t next = __atomic_load_n(&nodes[top].next, __ATOMIC_RELAXED);
    if (cas_head(&h, pair(next, tag + 1))) return top;
  }
}

static void push(uint64_t n) {
  unsigned __int128 h = read_head();
  for (;;) {
    __atomic_store_n(&nodes[n].next, (uint64_t)h, __ATOMIC_RELAXED);
    if (cas_head(&h, pair(n, (uint64_t)(h >> 64) + 1))) return;
  }
}

static void *stack(void *arg) {
  begin(arg);
  for (long i = 0; i < iters; i++) {
    uint64_t n = pop();
    nodes[n].count++;
    push(n);
  }
  return 0;
}

static int test_stack(void) {
  head.top = EMPTY, head.tag = 0;
  for (uint64_t i = 0; i < NODES; i++) nodes[i].count = 0, push(i);
  run(stack);
  int seen[NODES] = {0}, found = 0, ok = 1;
  uint64_t sum = 0, want = (uint64_t)nthreads * iters;
  for (uint64_t n = head.top; n != EMPTY && found <= NODES; n = nodes[n].next, found++) {
    if (n >= NODES || seen[n]++) { ok = 0; break; }
    sum += nodes[n].count;
  }
  ok = ok && found == NODES && sum == want;
  printf("stress: stack %s %d nodes, %llu pops (want %d, %llu), tag %llu\n", ok ? "ok" : "FAIL", found,
         (unsigned long long)sum, NODES, (unsigned long long)want, (unsigned long long)head.tag);
  return ok;
}

// pingpong: pair p is threads 2p and 2p + 1; the token says whose turn it is.
static struct {
  pthread_mutex_t m;
  pthread_cond_t c;
  long turn, rounds;
} pairs[32];

static void *pingpong(void *arg) {
  begin(arg);
  long i = (long)arg, me = i & 1;
  if (i / 2 >= nthreads / 2) return 0;
  typeof(pairs[0]) *p = &pairs[i / 2];
  for (long k = 0; k < iters / 16; k++) {
    pthread_mutex_lock(&p->m);
    while (p->turn != me) pthread_cond_wait(&p->c, &p->m);
    p->turn = !me;
    p->rounds++;
    pthread_cond_signal(&p->c);
    pthread_mutex_unlock(&p->m);
  }
  return 0;
}

static int test_pingpong(void) {
  if (nthreads < 2) return printf("stress: pingpong skipped (one CPU)\n"), 1;
  for (int p = 0; p < nthreads / 2; p++) {
    pthread_mutex_init(&pairs[p].m, 0);
    pthread_cond_init(&pairs[p].c, 0);
    pairs[p].turn = pairs[p].rounds = 0;
  }
  run(pingpong);
  long sum = 0, want = nthreads / 2 * (iters / 16 * 2);
  for (int p = 0; p < nthreads / 2; p++) sum += pairs[p].rounds;
  int ok = sum == want;
  printf("stress: pingpong %s %ld rounds (want %ld)\n", ok ? "ok" : "FAIL", sum, want);
  return ok;
}

// spin: plain loads and stores through volatile (LDR, STR; no barriers).
static volatile uint64_t ping, pong;
static double *rtt;

static void *spin(void *arg) {
  begin(arg);
  long i = (long)arg, n = iters / 16;
  for (uint64_t k = 1; k <= (uint64_t)n; k++) {
    if (i == 0) {
      double t = now();
      ping = k;
      while (pong != k) {}
      rtt[k - 1] = now() - t;
    } else if (i == 1) {
      while (ping != k) {}
      pong = k;
    }
  }
  return 0;
}

static int cmp(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static int test_spin(void) {
  if (nthreads < 2) return printf("stress: spin skipped (one CPU)\n"), 1;
  long n = iters / 16;
  rtt = calloc(n, sizeof *rtt);
  ping = pong = 0;
  run(spin);
  qsort(rtt, n, sizeof *rtt, cmp);
  // Percentiles of the round trip in microseconds.
#define P(q) (rtt[(long)((n - 1) * (q))] * 1e6)
  printf("stress: spin ok %ld round trips, us: min %.2f p50 %.2f p90 %.2f p99 %.2f p99.9 %.2f max %.2f\n", n, P(0),
         P(0.5), P(0.9), P(0.99), P(0.999), P(1));
  free(rtt);
  return 1;
}

static const struct {
  const char *name;
  int (*fn)(void);
} TESTS[] = {{"count", test_count}, {"stack", test_stack}, {"pingpong", test_pingpong}, {"spin", test_spin}};

int main(int argc, char **argv) {
  setvbuf(stdout, 0, _IOLBF, 0);
  nthreads = sysconf(_SC_NPROCESSORS_ONLN);
  if (nthreads > 64) nthreads = 64;
  int a = 1, fail = 0, any = 0;
  if (a + 1 < argc && !strcmp(argv[a], "-n")) iters = atol(argv[a + 1]), a += 2;
  if (iters < 16) iters = 16;
  for (size_t t = 0; t < sizeof TESTS / sizeof *TESTS; t++) {
    int want = a == argc;
    for (int k = a; k < argc; k++) want |= !strcmp(argv[k], TESTS[t].name);
    if (!want) continue;
    any = 1;
    double t0 = now();
    int ok = TESTS[t].fn();
    printf("stress: %s took %.2f s on %d threads x %ld\n", TESTS[t].name, now() - t0, nthreads, iters);
    fail += !ok;
  }
  if (!any) return fprintf(stderr, "stress: no such test\n"), 2;
  return fail != 0;
}
