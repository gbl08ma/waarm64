// Self-hosted debug from user space (docs/cpu.md "Self-hosted debug"): ptrace
// single step over straight-line code and an SVC, and perf's hardware
// breakpoint and watchpoint events (what gdb's stepi, hbreak and watch and
// perf's mem: events use). Prints "debug: <check> ok" for each, or what went
// wrong and exits 1.
#define _GNU_SOURCE
#include <asm/ptrace.h>
#include <elf.h>
#include <linux/hw_breakpoint.h>
#include <linux/perf_event.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define fail(...) (printf("debug: " __VA_ARGS__), putchar('\n'), exit(1))

// Stepped from `seq`: three adds, then getpid through an SVC, then a spin.
extern char seq[], seq_end[];
__asm__(".text\n"
        ".globl seq\n"
        "seq:\n"
        "  mov x0, #0\n"
        "  add x0, x0, #1\n"
        "  add x0, x0, #1\n"
        "  add x0, x0, #1\n"
        "  mov x8, #172\n" // getpid
        "  svc #0\n"
        ".globl seq_end\n"
        "seq_end:\n"
        "  mov x1, x0\n"
        "  b .\n");

static struct user_pt_regs regs(pid_t pid) {
  struct user_pt_regs r;
  struct iovec v = {&r, sizeof r};
  if (ptrace(PTRACE_GETREGSET, pid, NT_PRSTATUS, &v)) fail("GETREGSET: %m");
  return r;
}

static void step(void) {
  pid_t pid = fork();
  if (pid == 0) {
    ptrace(PTRACE_TRACEME, 0, 0, 0);
    raise(SIGSTOP);
    for (;;) pause();
  }
  int st;
  waitpid(pid, &st, 0);
  if (!WIFSTOPPED(st)) fail("child didn't stop");
  struct user_pt_regs r = regs(pid);
  r.pc = (uint64_t)seq;
  struct iovec v = {&r, sizeof r};
  if (ptrace(PTRACE_SETREGSET, pid, NT_PRSTATUS, &v)) fail("SETREGSET: %m");
  // One stop per instruction; past the SVC, two at seq_end: Linux reports the
  // syscall's exit, then the step left pending by the SVC is taken before
  // anything runs (as on the M4).
  static const uint64_t at[] = {4, 8, 12, 16, 20, 24, 24, 28};
  for (unsigned k = 0; k < sizeof at / sizeof *at; k++) {
    if (ptrace(PTRACE_SINGLESTEP, pid, 0, 0)) fail("SINGLESTEP: %m");
    waitpid(pid, &st, 0);
    if (!WIFSTOPPED(st) || WSTOPSIG(st) != SIGTRAP) fail("step %u: status %#x", k, st);
    r = regs(pid);
    if (r.pc != (uint64_t)seq + at[k]) fail("step %u: pc seq+%#lx", k, (unsigned long)(r.pc - (uint64_t)seq));
    if (k == 3 && r.regs[0] != 3) fail("x0 %lu after the adds", (unsigned long)r.regs[0]);
    if (k == 5 && r.regs[0] != (uint64_t)pid) fail("getpid gave %lu, not %d", (unsigned long)r.regs[0], pid);
  }
  if ((uint64_t)seq_end + 4 != r.pc) fail("not at the spin");
  kill(pid, SIGKILL);
  waitpid(pid, &st, 0);
  printf("debug: ptrace single step ok\n");
}

static volatile uint32_t var;

__attribute__((noinline)) static void func(void) { __asm__ volatile("" ::: "memory"); }

// A user-space perf breakpoint event's count over `run`.
static uint64_t count(int type, uint64_t addr, int len, void (*run)(void)) {
  struct perf_event_attr a;
  memset(&a, 0, sizeof a);
  a.type = PERF_TYPE_BREAKPOINT;
  a.size = sizeof a;
  a.bp_type = type;
  a.bp_addr = addr;
  a.bp_len = len;
  a.exclude_kernel = 1;
  a.exclude_hv = 1;
  a.disabled = 1;
  int fd = syscall(__NR_perf_event_open, &a, 0, -1, -1, 0);
  if (fd < 0) fail("perf_event_open (type %d): %m", type);
  ioctl(fd, PERF_EVENT_IOC_RESET, 0);
  ioctl(fd, PERF_EVENT_IOC_ENABLE, 0);
  run();
  ioctl(fd, PERF_EVENT_IOC_DISABLE, 0);
  uint64_t n;
  if (read(fd, &n, sizeof n) != sizeof n) fail("read: %m");
  close(fd);
  return n;
}

static void calls(void) {
  for (int k = 0; k < 5; k++) func();
}

// 5 stores and 3 loads of `var`, and 4 of its neighbour.
static volatile uint32_t other;
static void accesses(void) {
  for (int k = 0; k < 5; k++) var = k;
  for (int k = 0; k < 3; k++) (void)var;
  for (int k = 0; k < 4; k++) other = k;
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  step();
  uint64_t n = count(HW_BREAKPOINT_X, (uint64_t)func, HW_BREAKPOINT_LEN_4, calls);
  if (n != 5) fail("breakpoint: %lu hits, not 5", (unsigned long)n);
  printf("debug: perf breakpoint ok\n");
  n = count(HW_BREAKPOINT_W, (uint64_t)&var, HW_BREAKPOINT_LEN_4, accesses);
  if (n != 5) fail("write watchpoint: %lu hits, not 5", (unsigned long)n);
  n = count(HW_BREAKPOINT_R, (uint64_t)&var, HW_BREAKPOINT_LEN_4, accesses);
  if (n != 3) fail("read watchpoint: %lu hits, not 3", (unsigned long)n);
  n = count(HW_BREAKPOINT_RW, (uint64_t)&var, HW_BREAKPOINT_LEN_4, accesses);
  if (n != 8) fail("read-write watchpoint: %lu hits, not 8", (unsigned long)n);
  printf("debug: perf watchpoint ok\n");
  return 0;
}
