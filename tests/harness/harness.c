// Golden-corpus harness: runs A64 test snippets at EL0 under Linux (qemu-aarch64
// or real hardware) and dumps the resulting state. Static and freestanding: no libc.
//
// Protocol (little-endian records on stdin/stdout; see PLAN.md §4.2):
//   in:  magic 'WPCI', ncode u32, x[31] u64, sp u64, nzcv u64, mem[8192], code[ncode] u32
//   out: magic 'WPCO', signo u32, si_code u32, pad u32, si_addr u64, pc u64,
//        x[31] u64, sp u64, pstate u64, mem[8192]
// The code runs at CODE, followed by a BRK end marker; the data region is DATA.
// Every test ends in a signal (SIGTRAP at the end marker when it completes). The
// handler runs on an alternate stack, so the test's SP and memory stay untouched.
//
// Build: tests/harness/build.sh (it defines test_code = CODE at link time)

typedef unsigned long u64;
typedef unsigned int u32;
typedef unsigned char u8;

#define CODE 0x100000UL
#define CODE_SIZE 4096UL
#define DATA 0x200000UL
#define DATA_SIZE 8192UL
#define MAX_CODE (CODE_SIZE / 4 - 1)
#define BRK_END 0xd4200000u // brk #0

struct state {
    u64 x[31], sp, nzcv;
};

struct out {
    u32 magic, signo, si_code, pad;
    u64 si_addr, pc;
    u64 x[31], sp, pstate;
    u8 mem[DATA_SIZE];
};

// Kernel ABI (arm64).
struct kernel_sigaction {
    void *handler;
    u64 flags;
    void *restorer;
    u64 mask;
};
struct sigcontext {
    u64 fault_address, regs[31], sp, pc, pstate;
};
struct ucontext {
    u64 uc_flags;
    void *uc_link;
    u64 ss_sp, ss_flags_pad, ss_size;
    u8 sigmask[128];
    struct sigcontext mcontext __attribute__((aligned(16)));
};
struct siginfo {
    int signo, errno_, code, pad;
    u64 addr;
};

enum { SYS_read = 63, SYS_write = 64, SYS_exit_group = 94, SYS_mmap = 222,
       SYS_sigaltstack = 132, SYS_rt_sigaction = 134 };
#define SA_SIGINFO 4UL
#define SA_ONSTACK 0x08000000UL
#define SA_RESTORER 0x04000000UL

static long sys(long n, long a, long b, long c, long d, long e, long f) {
    register long x8 __asm__("x8") = n, x0 __asm__("x0") = a, x1 __asm__("x1") = b,
                  x2 __asm__("x2") = c, x3 __asm__("x3") = d, x4 __asm__("x4") = e,
                  x5 __asm__("x5") = f;
    __asm__ volatile("svc #0"
                     : "+r"(x0)
                     : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5)
                     : "memory");
    return x0;
}

void *memcpy(void *d, const void *s, u64 n) {
    u8 *dp = d;
    const u8 *sp = s;
    while (n--) *dp++ = *sp++;
    return d;
}

void *memset(void *d, int v, u64 n) {
    u8 *dp = d;
    while (n--) *dp++ = (u8)v;
    return d;
}

static void die(const char *msg) {
    u64 n = 0;
    while (msg[n]) n++;
    sys(SYS_write, 2, (long)msg, n, 0, 0, 0);
    sys(SYS_exit_group, 1, 0, 0, 0, 0, 0);
}

// Reads exactly n bytes; returns 0 on EOF before the first byte.
static int read_all(void *buf, u64 n) {
    u64 got = 0;
    while (got < n) {
        long r = sys(SYS_read, 0, (long)buf + got, n - got, 0, 0, 0);
        if (r <= 0) {
            if (got == 0 && r == 0) return 0;
            die("harness: short read\n");
        }
        got += r;
    }
    return 1;
}

static void write_all(const void *buf, u64 n) {
    u64 done = 0;
    while (done < n) {
        long r = sys(SYS_write, 1, (long)buf + done, n - done, 0, 0, 0);
        if (r <= 0) die("harness: write failed\n");
        done += r;
    }
}

// Harness registers saved by run_test and restored by the handler: x19..x30, sp.
u64 saved[13];
static struct out out;
static struct state st;
static u32 code[MAX_CODE];
static u8 altstack[65536] __attribute__((aligned(16)));

// Loads the test state and jumps to CODE. "Returns" when the handler resumes at
// the saved x30 with the saved callee-saved registers and SP.
void run_test(const struct state *s);
__asm__(
    ".text\n"
    ".globl run_test\n"
    "run_test:\n"
    "  adrp x1, saved\n"
    "  add x1, x1, :lo12:saved\n"
    "  stp x19, x20, [x1, #0]\n"
    "  stp x21, x22, [x1, #16]\n"
    "  stp x23, x24, [x1, #32]\n"
    "  stp x25, x26, [x1, #48]\n"
    "  stp x27, x28, [x1, #64]\n"
    "  stp x29, x30, [x1, #80]\n"
    "  mov x2, sp\n"
    "  str x2, [x1, #96]\n"
    "  mov x30, x0\n"
    "  ldr x0, [x30, #248]\n"
    "  mov sp, x0\n"
    "  ldr x0, [x30, #256]\n"
    "  msr nzcv, x0\n"
    "  ldp x0, x1, [x30, #0]\n"
    "  ldp x2, x3, [x30, #16]\n"
    "  ldp x4, x5, [x30, #32]\n"
    "  ldp x6, x7, [x30, #48]\n"
    "  ldp x8, x9, [x30, #64]\n"
    "  ldp x10, x11, [x30, #80]\n"
    "  ldp x12, x13, [x30, #96]\n"
    "  ldp x14, x15, [x30, #112]\n"
    "  ldp x16, x17, [x30, #128]\n"
    "  ldp x18, x19, [x30, #144]\n"
    "  ldp x20, x21, [x30, #160]\n"
    "  ldp x22, x23, [x30, #176]\n"
    "  ldp x24, x25, [x30, #192]\n"
    "  ldp x26, x27, [x30, #208]\n"
    "  ldp x28, x29, [x30, #224]\n"
    "  ldr x30, [x30, #240]\n"
    "  b test_code\n"
    "\n"
    "restorer:\n"
    "  mov x8, #139\n" // rt_sigreturn
    "  svc #0\n");
extern char restorer[];

static void handler(int sig, struct siginfo *si, void *ucv) {
    struct sigcontext *m = &((struct ucontext *)ucv)->mcontext;
    if (m->pc < CODE || m->pc >= CODE + CODE_SIZE) die("harness: signal outside test code\n");
    out.signo = sig;
    out.si_code = si->code;
    out.si_addr = si->addr;
    out.pc = m->pc;
    for (int i = 0; i < 31; i++) out.x[i] = m->regs[i];
    out.sp = m->sp;
    out.pstate = m->pstate;
    // Resume in run_test's caller.
    for (int i = 0; i < 12; i++) m->regs[19 + i] = saved[i];
    m->sp = saved[12];
    m->pc = saved[11];
}

static void sync_icache(u64 start, u64 len) {
    // 16 bytes is below any real cache line size, so this covers every line.
    for (u64 a = start; a < start + len; a += 16) __asm__ volatile("dc cvau, %0" ::"r"(a));
    __asm__ volatile("dsb ish");
    for (u64 a = start; a < start + len; a += 16) __asm__ volatile("ic ivau, %0" ::"r"(a));
    __asm__ volatile("dsb ish\n isb");
}

static void main_loop(void) {
    // PROT_READ|WRITE|EXEC, MAP_PRIVATE|ANONYMOUS|FIXED_NOREPLACE.
    if (sys(SYS_mmap, CODE, CODE_SIZE, 7, 0x100022, -1, 0) != (long)CODE) die("harness: mmap code\n");
    if (sys(SYS_mmap, DATA, DATA_SIZE, 3, 0x100022, -1, 0) != (long)DATA) die("harness: mmap data\n");
    u64 ss[3] = {(u64)altstack, 0, sizeof altstack};
    if (sys(SYS_sigaltstack, (long)ss, 0, 0, 0, 0, 0)) die("harness: sigaltstack\n");
    struct kernel_sigaction sa = {(void *)handler, SA_SIGINFO | SA_ONSTACK | SA_RESTORER, restorer, 0};
    int sigs[] = {4 /* ILL */, 5 /* TRAP */, 7 /* BUS */, 11 /* SEGV */};
    for (int i = 0; i < 4; i++)
        if (sys(SYS_rt_sigaction, sigs[i], (long)&sa, 0, 8, 0, 0)) die("harness: sigaction\n");

    for (;;) {
        u32 hdr[2];
        if (!read_all(hdr, sizeof hdr)) sys(SYS_exit_group, 0, 0, 0, 0, 0, 0);
        if (hdr[0] != 0x49435057 /* WPCI */ || hdr[1] > MAX_CODE) die("harness: bad record\n");
        read_all(&st, sizeof st);
        read_all((void *)DATA, DATA_SIZE);
        read_all(code, hdr[1] * 4);
        memset((void *)CODE, 0, CODE_SIZE);
        memcpy((void *)CODE, code, hdr[1] * 4);
        ((u32 *)CODE)[hdr[1]] = BRK_END;
        sync_icache(CODE, CODE_SIZE);
        run_test(&st);
        out.magic = 0x4f435057; // WPCO
        memcpy(out.mem, (void *)DATA, DATA_SIZE);
        write_all(&out, sizeof out);
    }
}

__asm__(".globl _start\n"
        "_start:\n"
        "  mov x29, #0\n"
        "  bl main_loop_entry\n");

void main_loop_entry(void) { main_loop(); }
