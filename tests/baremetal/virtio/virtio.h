// A virtio driver of the device tests' own (virtio-mmio v2, split queues of QN, polled): what Linux's drivers
// never do is what these tests are for (docs/testing.md "Bare-metal device tests"), so chains are built by hand
// (`RD`, `WR`) and posted as they are. The MMU stays off: every access is to Device memory, so all of them are
// naturally aligned, and memset and memcpy (which the compiler may call) go a byte at a time.
#pragma once
#include "../lib.h"

typedef unsigned short u16;
typedef unsigned char u8;
#define mmio16(a) (*(volatile u16 *)(a))

void *memset(void *d, int c, unsigned long n) {
  volatile u8 *p = d;
  while (n--) *p++ = (u8)c;
  return d;
}
void *memcpy(void *d, const void *s, unsigned long n) {
  volatile u8 *p = d;
  const volatile u8 *q = s;
  while (n--) *p++ = *q++;
  return d;
}

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(100 + vec);
}

// virtio-mmio v2 (virtio 1.2 §4.2.2).
#define MMIO 0x0a000000UL
#define STRIDE 0x200UL
#define MAGIC 0x000
#define VERSION 0x004
#define DEVICE_ID 0x008
#define DEV_FEATURES 0x010
#define DEV_FEATURES_SEL 0x014
#define DRV_FEATURES 0x020
#define DRV_FEATURES_SEL 0x024
#define QUEUE_SEL 0x030
#define QUEUE_NUM_MAX 0x034
#define QUEUE_NUM 0x038
#define QUEUE_READY 0x044
#define QUEUE_NOTIFY 0x050
#define INT_STATUS 0x060
#define INT_ACK 0x064
#define STATUS 0x070
#define QUEUE_DESC 0x080
#define QUEUE_AVAIL 0x090
#define QUEUE_USED 0x0a0
#define CONFIG 0x100
#define S_ACK 1
#define S_DRIVER 2
#define S_DRIVER_OK 4
#define S_FEATURES_OK 8
#define S_NEEDS_RESET 0x40

#define F_INDIRECT (1u << 28)

#define D_NEXT 1
#define D_WRITE 2
#define D_INDIRECT 4

#define QN 128 // each queue's size (what the devices offer, but input's 64)

struct desc {
  u64 addr;
  u32 len;
  u16 flags, next;
};
struct avail {
  u16 flags, idx, ring[QN], used_event;
};
struct used_elem {
  u32 id, len;
};
struct used {
  u16 flags, idx;
  struct used_elem ring[QN];
};
struct vq {
  struct desc *desc;
  struct avail *avail;
  volatile struct used *used;
  u16 next_avail, last_used;
};

// A device's queues at QUEUES + 64 KiB per device found, 12 KiB each; the tests' buffers above 0x4090_0000; an
// indirect table at TABLE.
#define QUEUES 0x40800000UL
#define TABLE 0x40f00000UL

struct dev {
  u64 base;
  int nq;
  u32 offered[2], features[2];
  struct vq q[4];
};

#define R(d, off) mmio32((d)->base + (off))

static inline void dmb(void) { __asm__ volatile("dmb sy" ::: "memory"); }

/** The `nth` transport (from 0) with device ID `id`, or 0. */
static u64 dev_find(u32 id, int nth) {
  for (int i = 0; i < 32; i++) {
    u64 b = MMIO + i * STRIDE;
    if (mmio32(b + MAGIC) != 0x74726976 || mmio32(b + VERSION) != 2 || mmio32(b + DEVICE_ID) != id) continue;
    if (nth-- == 0) return b;
  }
  return 0;
}

// Resets the device and brings it up (virtio 1.2 §3.1.1): of what it offers, `lo` and `hi` (the feature words) and
// VERSION_1; its first `nq` queues at QN entries, in the memory of device slot `slot`.
static void dev_init(struct dev *d, int slot, int nq, u32 lo, u32 hi) {
  R(d, STATUS) = 0;
  while (R(d, STATUS))
    ;
  R(d, STATUS) = S_ACK;
  R(d, STATUS) = S_ACK | S_DRIVER;
  for (u32 w = 0; w < 2; w++) {
    R(d, DEV_FEATURES_SEL) = w;
    d->offered[w] = R(d, DEV_FEATURES);
  }
  d->features[0] = d->offered[0] & lo;
  d->features[1] = d->offered[1] & (hi | 1); // VERSION_1
  for (u32 w = 0; w < 2; w++) {
    R(d, DRV_FEATURES_SEL) = w;
    R(d, DRV_FEATURES) = d->features[w];
  }
  R(d, STATUS) = S_ACK | S_DRIVER | S_FEATURES_OK;
  check(R(d, STATUS) & S_FEATURES_OK, 2);
  d->nq = nq;
  for (int i = 0; i < nq; i++) {
    struct vq *q = &d->q[i];
    u64 at = QUEUES + slot * 0x10000UL + i * 0x3000UL;
    q->desc = (struct desc *)at;
    q->avail = (struct avail *)(at + 0x1000);
    q->used = (volatile struct used *)(at + 0x2000);
    memset(q->desc, 0, 0x3000);
    q->next_avail = q->last_used = 0;
    R(d, QUEUE_SEL) = i;
    check(R(d, QUEUE_NUM_MAX) >= QN, 3);
    R(d, QUEUE_NUM) = QN;
    R(d, QUEUE_DESC) = (u32)at;
    R(d, QUEUE_DESC + 4) = 0;
    R(d, QUEUE_AVAIL) = (u32)(at + 0x1000);
    R(d, QUEUE_AVAIL + 4) = 0;
    R(d, QUEUE_USED) = (u32)(at + 0x2000);
    R(d, QUEUE_USED + 4) = 0;
    R(d, QUEUE_READY) = 1;
  }
  R(d, STATUS) = S_ACK | S_DRIVER | S_FEATURES_OK | S_DRIVER_OK;
}

static int needs_reset(struct dev *d) { return (R(d, STATUS) & S_NEEDS_RESET) != 0; }

// The chain being built: buffers in order; `post` lays them out.
static struct desc chain[160];
static int nchain;
static void buf(u64 addr, u32 len, u16 flags) {
  chain[nchain].addr = addr;
  chain[nchain].len = len;
  chain[nchain].flags = flags;
  nchain++;
}
#define RD(a, l) buf(a, l, 0)
#define WR(a, l) buf(a, l, D_WRITE)

// Posts the chain on queue `qi` from descriptor `head` (it takes the next ones), or with `indirect` in an indirect
// table that descriptor `head` points at; then notifies.
static void post(struct dev *d, int qi, u16 head, int indirect) {
  struct vq *q = &d->q[qi];
  int n = nchain;
  struct desc *t = indirect ? (struct desc *)TABLE : q->desc + head;
  for (int i = 0; i < n; i++) {
    t[i] = chain[i];
    t[i].next = (u16)(indirect ? i + 1 : head + i + 1);
    if (i + 1 < n) t[i].flags |= D_NEXT;
  }
  if (indirect) {
    q->desc[head].addr = TABLE;
    q->desc[head].len = (u32)(16 * n);
    q->desc[head].flags = D_INDIRECT;
    q->desc[head].next = 0;
  }
  dmb();
  q->avail->ring[q->next_avail % QN] = head;
  dmb();
  q->avail->idx = ++q->next_avail;
  dmb();
  R(d, QUEUE_NOTIFY) = qi;
}

// The next used element of queue `qi`, if there is one now: 1 with its head and length.
__attribute__((unused)) static int poll_used(struct dev *d, int qi, u32 *id, u32 *len) {
  struct vq *q = &d->q[qi];
  dmb();
  if (q->used->idx == q->last_used) return 0;
  volatile struct used_elem *e = &q->used->ring[q->last_used % QN];
  *id = e->id;
  *len = e->len;
  q->last_used++;
  R(d, INT_ACK) = R(d, INT_STATUS);
  return 1;
}

// Waits for the next used element of queue `qi`: 1 with its head and length, 0 when the device asks for a reset
// (a refused chain never completes) or nothing came. Deterministic runs complete a request before the notify returns
// (the run exits for the device and settles it); parallel ones (a backend on another thread) a while later.
static int wait_used(struct dev *d, int qi, u32 *id, u32 *len) {
  for (long spin = 0; spin < 1L << 28 && !needs_reset(d); spin++)
    if (poll_used(d, qi, id, len)) return 1;
  return 0;
}

__attribute__((unused)) static void hex(u64 v) {
  char b[17], *p = b + 16;
  *p = 0;
  do *--p = "0123456789abcdef"[v & 15]; while (v >>= 4);
  uart_puts("0x");
  uart_puts(p);
}
__attribute__((unused)) static void note(const char *what, int ok) {
  uart_puts(ok ? " " : " NOT ");
  uart_puts(what);
}
static void end(void) { uart_puts("\n"); }
