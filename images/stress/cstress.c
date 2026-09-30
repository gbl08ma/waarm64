// cstress: the C twin of gostress (docs/images.md): pthreads spinning on sched_yield, an
// mmap/mprotect/munmap churn per thread (TLBI IS broadcasts), malloc/free of big blocks (glibc
// mmaps and trims them), a mutex + condvar ping-pong (futexes) and fork/exec of /bin/true.
// usage: cstress [seconds] [threads]   (defaults 60, 4). One heartbeat line a second; "cstress: done".
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static atomic_int stop;
static atomic_ulong maps, prots, allocs, execs, spins, pings;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static unsigned long turn;

static uint64_t rnd(uint64_t *s) { *s ^= *s >> 12; *s ^= *s << 25; *s ^= *s >> 27; return *s * 2685821657736338717ULL; }

static void *mapper(void *arg) {
  uint64_t s = (uintptr_t)arg * 0x9e3779b97f4a7c15ULL + 1;
  while (!atomic_load(&stop)) {
    size_t n = (1 + rnd(&s) % 32) * 4096;
    char *p = mmap(0, n, PROT_READ | PROT_WRITE, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
    if (p == MAP_FAILED) { usleep(10000); continue; }
    for (size_t k = 0; k < n; k += 4096) p[k] = 1;
    mprotect(p, n, PROT_READ); mprotect(p, n, PROT_READ | PROT_WRITE); p[0] = 2; mprotect(p, n, PROT_NONE);
    atomic_fetch_add(&prots, 3);
    munmap(p, n);
    atomic_fetch_add(&maps, 1);
  }
  return 0;
}

static void *allocator(void *arg) {
  uint64_t s = (uintptr_t)arg * 0x2545f4914f6cdd1dULL + 7;
  while (!atomic_load(&stop)) {
    size_t n = 100 + rnd(&s) % (2 << 20);
    char *p = malloc(n); // above the mmap threshold glibc mmaps and munmaps
    if (!p) continue;
    for (size_t k = 0; k < n; k += 4096) p[k] = 1;
    free(p);
    atomic_fetch_add(&allocs, 1);
  }
  return 0;
}

static void *spinner(void *arg) {
  (void)arg;
  volatile uint64_t x = 1;
  while (!atomic_load(&stop)) {
    for (int i = 0; i < 200; i++) x = x * 6364136223846793005ULL + 1;
    sched_yield();
    atomic_fetch_add(&spins, 1);
  }
  return 0;
}

static void *pinger(void *arg) { // two threads take turns through a condvar
  unsigned long me = (uintptr_t)arg;
  pthread_mutex_lock(&mu);
  while (!atomic_load(&stop)) {
    while (turn % 2 != me && !atomic_load(&stop)) {
      struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_nsec += 20000000; if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
      pthread_cond_timedwait(&cv, &mu, &ts);
    }
    turn++; atomic_fetch_add(&pings, 1);
    pthread_cond_broadcast(&cv);
  }
  pthread_mutex_unlock(&mu);
  return 0;
}

static void *execer(void *arg) {
  (void)arg;
  while (!atomic_load(&stop)) {
    pid_t p = fork();
    if (p == 0) { execl("/bin/true", "true", (char *)0); _exit(127); }
    if (p > 0) { int st; waitpid(p, &st, 0); atomic_fetch_add(&execs, 1); } else usleep(100000);
  }
  return 0;
}

int main(int argc, char **argv) {
  int secs = argc > 1 ? atoi(argv[1]) : 60, n = argc > 2 ? atoi(argv[2]) : 4;
  pthread_t t[64]; int k = 0;
  for (int i = 0; i < n; i++) { pthread_create(&t[k++], 0, allocator, (void *)(uintptr_t)i); pthread_create(&t[k++], 0, mapper, (void *)(uintptr_t)i); }
  pthread_create(&t[k++], 0, spinner, 0); pthread_create(&t[k++], 0, spinner, 0);
  pthread_create(&t[k++], 0, pinger, (void *)0); pthread_create(&t[k++], 0, pinger, (void *)1);
  pthread_create(&t[k++], 0, execer, 0);
  struct timespec t0; clock_gettime(CLOCK_MONOTONIC, &t0);
  for (int s = 1; s <= secs; s++) {
    struct timespec w = t0; w.tv_sec += s; clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &w, 0);
    printf("cstress: t=%d allocs=%lu mmaps=%lu mprotects=%lu execs=%lu pings=%lu spins=%lu\n", s, atomic_load(&allocs), atomic_load(&maps), atomic_load(&prots), atomic_load(&execs), atomic_load(&pings), atomic_load(&spins));
    fflush(stdout);
  }
  atomic_store(&stop, 1);
  for (int i = 0; i < k; i++) pthread_join(t[i], 0);
  puts("cstress: done");
  return 0;
}
