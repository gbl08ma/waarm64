// Integer guest workload for the interpreter MIPS baseline (M1). Bare metal on
// flat memory: no OS, no FP/SIMD. It loops forever over a mix of compiled
// integer code (table-driven CRC, sorting, matrix multiply, a linked list and
// byte strings) and counts rounds at ROUNDS so the host can check progress.
// Build: bench/interp/build.sh

typedef unsigned long u64;
typedef unsigned int u32;
typedef unsigned char u8;

#define ROUNDS ((volatile u64 *)0x80000)

static u32 crc_table[256];
static u32 arr[256];
static int ma[16][16], mb[16][16], mc[16][16];
static struct node { struct node *next; u32 val; } nodes[128];
static u8 text[512], copy[512];

static u32 rng = 12345;
static u32 rand32(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

static void init(void) {
    for (u32 i = 0; i < 256; i++) {
        u32 c = i;
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & -(c & 1));
        crc_table[i] = c;
    }
    for (int i = 0; i < 16; i++)
        for (int j = 0; j < 16; j++) ma[i][j] = (int)(rand32() % 200) - 100, mb[i][j] = (int)(rand32() % 200) - 100;
    for (int i = 0; i < 128; i++) nodes[i].next = &nodes[(i * 37 + 11) % 128], nodes[i].val = rand32();
    for (int i = 0; i < 511; i++) text[i] = 'a' + rand32() % 26;
}

static u32 crc32(const u8 *p, u64 n) {
    u32 c = ~0u;
    while (n--) c = crc_table[(c ^ *p++) & 0xff] ^ (c >> 8);
    return ~c;
}

static void sort(u32 *a, int n) { // insertion sort
    for (int i = 1; i < n; i++) {
        u32 v = a[i];
        int j = i - 1;
        while (j >= 0 && a[j] > v) a[j + 1] = a[j], j--;
        a[j + 1] = v;
    }
}

static int matmul(void) {
    int s = 0;
    for (int i = 0; i < 16; i++)
        for (int j = 0; j < 16; j++) {
            int acc = 0;
            for (int k = 0; k < 16; k++) acc += ma[i][k] * mb[k][j];
            mc[i][j] = acc;
            s ^= acc;
        }
    return s;
}

static u32 walk(void) {
    u32 s = 0;
    struct node *p = &nodes[0];
    for (int i = 0; i < 1000; i++) s += p->val >> (i & 7), p = p->next;
    return s;
}

static u64 strwork(void) {
    u64 n = 0;
    while (text[n]) copy[n] = text[n], n++;
    u64 vowels = 0;
    for (u64 i = 0; i < n; i++) vowels += copy[i] == 'a' || copy[i] == 'e' || copy[i] == 'i' || copy[i] == 'o' || copy[i] == 'u';
    return n + vowels;
}

__attribute__((noreturn)) void guest_main(void) {
    init();
    u32 sink = 0;
    for (;;) {
        for (int i = 0; i < 256; i++) arr[i] = rand32();
        sort(arr, 256);
        sink ^= crc32(text, 511) + (u32)matmul() + walk() + (u32)strwork() + arr[128];
        *ROUNDS += 1;
        ((volatile u32 *)ROUNDS)[2] = sink;
    }
}

__asm__(".section .text.start\n"
        ".globl _start\n"
        "_start:\n"
        "  mov sp, #0x100000\n"
        "  bl guest_main\n");
