// virtio-blk requests no Linux driver sends, through the whole path: a driver of its own (virtio-mmio v2, one split
// queue, polled) posts hand-built chains to three disks and prints, per case, the status byte the device wrote and the
// used length; tests/virtio-guest.test.ts boots it in Node over the TS backends (web/devices.ts `blk`) and compares
// the transcript with what it expects. Linux's drivers test the well-formed path (the Buildroot device test, the
// Debian page tests); this is the rest: short, split or misplaced headers, no status byte, ranges past the disk's
// end or past 2^53 bytes, data in the wrong direction, unknown types, DISCARD and WRITE_ZEROES segments that don't
// fit, a write to a read-only disk, a chain the transport refuses (DEVICE_NEEDS_RESET, then a reset and a request).
// Not in the top-level runners (core/tests/baremetal.rs, tests/boot-node-suite.ts): it needs the disks.
//
// The disks, in device order: 0 a 1 MiB ramdisk (discard), 1 a 64 KiB read-only image, 2 a 64 KiB image under an
// overlay (discard). The images hold `pattern(0, offset)`. The MMU stays off, so every access is to Device memory:
// all of them naturally aligned.
#include "../lib.h"

typedef unsigned short u16;
typedef unsigned char u8;

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

#define F_SEG_MAX (1u << 2)
#define F_RO (1u << 5)
#define F_FLUSH (1u << 9)
#define F_DISCARD (1u << 13)
#define F_WRITE_ZEROES (1u << 14)
#define F_INDIRECT (1u << 28)

#define D_NEXT 1
#define D_WRITE 2
#define D_INDIRECT 4

#define T_IN 0
#define T_OUT 1
#define T_FLUSH 4
#define T_GET_ID 8
#define T_DISCARD 11
#define T_WRITE_ZEROES 13

#define QN 128 // the queue's size (what the device offers)

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

// Memory: the image and its stacks below 1 MiB; a disk's queue at QUEUES + 64 KiB each; the buffers above.
#define QUEUES 0x40800000UL
#define HDR 0x40900000UL     // the request header (16 bytes), and what follows it in the same buffer
#define DATA 0x40910000UL    // data (64 KiB)
#define STATUS_AT 0x40920000UL
#define SEG 0x40930000UL     // a DISCARD or WRITE_ZEROES segment
#define TABLE 0x40940000UL   // an indirect table
#define SCRATCH 0x40950000UL // a second data buffer (64 KiB)

struct disk {
  u64 base;
  struct desc *desc;
  struct avail *avail;
  volatile struct used *used;
  u16 next_avail, last_used;
  u32 features;
  u64 sectors;
} disks[3];

#define R(d, off) mmio32((d)->base + (off))

static void dmb(void) { __asm__ volatile("dmb sy" ::: "memory"); }

// Byte `o` of a disk image as tests/virtio-guest.test.ts makes it (seed 0), a blank disk's (ZERO), or as written here
// (other seeds).
#define ZERO 256
static u8 pattern(u32 seed, u64 o) { return seed == ZERO ? 0 : seed ? (u8)(o * 3 + seed) : (u8)((o >> 9) * 31 + o * 7 + 3); }
static void fill(u64 buf, u32 len, u32 seed, u64 off) {
  for (u32 i = 0; i < len; i++) mmio8(buf + i) = pattern(seed, off + i);
}
static int holds(u64 buf, u32 len, u32 seed, u64 off) {
  for (u32 i = 0; i < len; i++)
    if (mmio8(buf + i) != pattern(seed, off + i)) return 0;
  return 1;
}
static int zeros(u64 buf, u32 len) {
  for (u32 i = 0; i < len; i++)
    if (mmio8(buf + i)) return 0;
  return 1;
}

static void hex(u64 v) {
  char b[17], *p = b + 16;
  *p = 0;
  do *--p = "0123456789abcdef"[v & 15]; while (v >>= 4);
  uart_puts("0x");
  uart_puts(p);
}

// Resets the device and brings its queue up again (virtio 1.2 §3.1.1): the features it offers that we take (and
// VERSION_1), queue 0 at QN entries.
static void init(struct disk *d) {
  R(d, STATUS) = 0;
  while (R(d, STATUS))
    ;
  R(d, STATUS) = S_ACK;
  R(d, STATUS) = S_ACK | S_DRIVER;
  R(d, DEV_FEATURES_SEL) = 0;
  d->features = R(d, DEV_FEATURES);
  R(d, DRV_FEATURES_SEL) = 0;
  R(d, DRV_FEATURES) = d->features & (F_SEG_MAX | F_RO | F_FLUSH | F_DISCARD | F_WRITE_ZEROES | F_INDIRECT);
  R(d, DRV_FEATURES_SEL) = 1;
  R(d, DRV_FEATURES) = 1; // VERSION_1
  R(d, STATUS) = S_ACK | S_DRIVER | S_FEATURES_OK;
  check(R(d, STATUS) & S_FEATURES_OK, 2);
  R(d, QUEUE_SEL) = 0;
  check(R(d, QUEUE_NUM_MAX) >= QN, 3);
  memset(d->desc, 0, 0x3000);
  d->next_avail = d->last_used = 0;
  R(d, QUEUE_NUM) = QN;
  R(d, QUEUE_DESC) = (u32)(u64)d->desc;
  R(d, QUEUE_DESC + 4) = 0;
  R(d, QUEUE_AVAIL) = (u32)(u64)d->avail;
  R(d, QUEUE_AVAIL + 4) = 0;
  R(d, QUEUE_USED) = (u32)(u64)d->used;
  R(d, QUEUE_USED + 4) = 0;
  R(d, QUEUE_READY) = 1;
  R(d, STATUS) = S_ACK | S_DRIVER | S_FEATURES_OK | S_DRIVER_OK;
  d->sectors = R(d, CONFIG) | (u64)R(d, CONFIG + 4) << 32;
}

// The chain being built: buffers in order, then `submit` lays them out in the queue's table (or, with `indirect`, in
// an indirect table that one ring descriptor points at).
static struct desc chain[80];
static int nchain;
static u64 status_at; // the byte `run` reports as the status (preset to 0xee: "not written")
static void buf(u64 addr, u32 len, u16 flags) {
  chain[nchain].addr = addr;
  chain[nchain].len = len;
  chain[nchain].flags = flags;
  nchain++;
}
#define RD(a, l) buf(a, l, 0)
#define WR(a, l) buf(a, l, D_WRITE)
static void header(u32 type, u64 sector) {
  mmio32(HDR) = type;
  mmio32(HDR + 4) = 0;
  mmio32(HDR + 8) = (u32)sector;
  mmio32(HDR + 12) = (u32)(sector >> 32);
}
static void segment(u64 sector, u32 sectors, u32 flags) {
  mmio32(SEG) = (u32)sector;
  mmio32(SEG + 4) = (u32)(sector >> 32);
  mmio32(SEG + 8) = sectors;
  mmio32(SEG + 12) = flags;
}
// The usual shape: header, then data (`dir` 0 none, D_WRITE device-writable, 1 readable), then a status byte.
static void request(u32 type, u64 sector, u64 data, u32 len, int dir) {
  nchain = 0;
  header(type, sector);
  RD(HDR, 16);
  if (dir == 1) RD(data, len);
  else if (dir == D_WRITE) WR(data, len);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
}

// Posts the chain, waits for its used element and prints `<name> s=<status> n=<used length>`: `s=-` when the status
// byte wasn't written, `n=-` when nothing came back, and ` reset` when the device asks for one (then it is reset and
// brought up again, so the next case starts from a working device).
static int submit(struct disk *d, const char *name, int indirect) {
  int n = nchain;
  struct desc *t = indirect ? (struct desc *)TABLE : d->desc;
  for (int i = 0; i < n; i++) {
    t[i] = chain[i];
    t[i].next = (u16)(i + 1);
    if (i + 1 < n) t[i].flags |= D_NEXT;
  }
  if (indirect) {
    d->desc[0].addr = TABLE;
    d->desc[0].len = (u32)(16 * n);
    d->desc[0].flags = D_INDIRECT;
    d->desc[0].next = 0;
  }
  if (status_at) mmio8(status_at) = 0xee;
  dmb();
  d->avail->ring[d->next_avail % QN] = 0;
  dmb();
  d->avail->idx = ++d->next_avail;
  dmb();
  R(d, QUEUE_NOTIFY) = 0;
  long got = -1;
  // Deterministic runs complete a request before the notify returns (the run exits for the device and settles it);
  // parallel ones (a backend on another thread) a while later. A refused chain completes never: NEEDS_RESET ends the wait.
  for (long spin = 0; spin < 1L << 28 && !(R(d, STATUS) & S_NEEDS_RESET); spin++) {
    dmb();
    if (d->used->idx != d->last_used) {
      volatile struct used_elem *e = &d->used->ring[d->last_used % QN];
      check(e->id == 0, 4);
      got = e->len;
      d->last_used++;
      break;
    }
  }
  R(d, INT_ACK) = R(d, INT_STATUS);
  u8 s = status_at ? mmio8(status_at) : 0xee;
  int reset = (R(d, STATUS) & S_NEEDS_RESET) != 0;
  if (!*name) { // a helper's request (setting a case up, reading its result back): only its failure is told
    if (s || got < 0 || reset) uart_puts(" helper-failed");
    if (reset) init(d);
    return s;
  }
  uart_puts(name);
  uart_puts(" s=");
  if (s == 0xee) uart_puts("-");
  else uart_dec(s);
  uart_puts(" n=");
  if (got < 0) uart_puts("-");
  else uart_dec((u64)got);
  if (reset) uart_puts(" reset");
  if (reset) init(d);
  return s;
}
static void note(const char *what, int ok) {
  uart_puts(ok ? " " : " NOT ");
  uart_puts(what);
}
static void end(void) { uart_puts("\n"); }

// What every disk takes: its ID, reads and their failures. `seed` is what its first sectors hold.
static void reads(struct disk *d, const char *p, u32 seed) {
  char name[48];
  const char *s;
  int k;
#define NAME(x) (k = 0, ({ for (s = p; *s; s++) name[k++] = *s; for (s = x; *s; s++) name[k++] = *s; name[k] = 0; }), name)

  // GET_ID: 20 bytes (the serial, NUL-padded), the status after them.
  memset((void *)DATA, 0x55, 32);
  request(T_GET_ID, 0, DATA, 20, D_WRITE);
  submit(d, NAME(".id"), 0);
  uart_puts(" ");
  for (int i = 0; i < 20 && mmio8(DATA + i); i++) uart_putc(mmio8(DATA + i));
  end();
  // A GET_ID with room for 8: the serial cut there.
  request(T_GET_ID, 0, DATA, 8, D_WRITE);
  submit(d, NAME(".id-short"), 0);
  end();

  request(T_IN, 0, DATA, 1024, D_WRITE);
  submit(d, NAME(".read"), 0);
  note("data", holds(DATA, 1024, seed, 0));
  end();
  // The header split over two buffers, and the data over 64 of 8 bytes.
  nchain = 0;
  header(T_IN, 1);
  RD(HDR, 8);
  RD(HDR + 8, 8);
  memset((void *)DATA, 0, 512);
  for (int i = 0; i < 64; i++) WR(DATA + 8 * i, 8);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".read-split"), 0);
  note("data", holds(DATA, 512, seed, 512));
  end();
  // Through an indirect table.
  memset((void *)DATA, 0, 512);
  request(T_IN, 2, DATA, 512, D_WRITE);
  submit(d, NAME(".read-indirect"), 1);
  note("data", holds(DATA, 512, seed, 1024));
  end();
  // The status byte at the end of the data's buffer (513 bytes) instead of a buffer of its own.
  nchain = 0;
  header(T_IN, 0);
  RD(HDR, 16);
  WR(DATA, 513);
  status_at = DATA + 512;
  submit(d, NAME(".read-status-in-data"), 0);
  note("data", holds(DATA, 512, seed, 0));
  end();
  // A header of 32 bytes (16 more than it is).
  nchain = 0;
  header(T_IN, 0);
  RD(HDR, 32);
  WR(DATA, 512);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".read-long-header"), 0);
  end();
  // A header of 8 bytes.
  nchain = 0;
  header(T_IN, 0);
  RD(HDR, 8);
  WR(DATA, 512);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".read-short-header"), 0);
  end();
  // No header at all: everything writable.
  nchain = 0;
  WR(DATA, 512);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".no-header"), 0);
  end();
  // No status byte: nothing writable, or a writable buffer of 0 bytes.
  request(T_IN, 0, DATA, 512, 1);
  nchain--;
  status_at = 0;
  submit(d, NAME(".no-status"), 0);
  end();
  request(T_IN, 0, DATA, 512, D_WRITE);
  chain[nchain - 1].len = 0;
  status_at = 0;
  submit(d, NAME(".status-empty"), 0);
  end();
  // The data readable: nothing to read into.
  request(T_IN, 0, DATA, 512, 1);
  submit(d, NAME(".read-into-readable"), 0);
  end();
  // An unaligned length (100 bytes).
  memset((void *)DATA, 0, 512);
  request(T_IN, 0, DATA, 100, D_WRITE);
  submit(d, NAME(".read-100"), 0);
  note("data", holds(DATA, 100, seed, 0) && zeros(DATA + 100, 412));
  end();

  // Past the end: the last sector and one more, the sector after the last, and sectors whose byte offset is past
  // 2^53 (2^44 sectors and one), past 2^64 (2^55), and the last u64.
  request(T_IN, d->sectors - 1, DATA, 1024, D_WRITE);
  submit(d, NAME(".read-across-end"), 0);
  end();
  request(T_IN, d->sectors, DATA, 512, D_WRITE);
  submit(d, NAME(".read-at-end"), 0);
  end();
  request(T_IN, (1UL << 44) + 1, DATA, 512, D_WRITE);
  submit(d, NAME(".read-2^53"), 0);
  end();
  request(T_IN, 1UL << 55, DATA, 512, D_WRITE);
  submit(d, NAME(".read-2^64"), 0);
  end();
  request(T_IN, ~0UL, DATA, 512, D_WRITE);
  submit(d, NAME(".read-max"), 0);
  end();
  // An unknown type, and a FLUSH.
  request(99, 0, DATA, 512, D_WRITE);
  submit(d, NAME(".type-99"), 0);
  end();
  request(T_FLUSH, 0, 0, 0, 0);
  submit(d, NAME(".flush"), 0);
  end();
#undef NAME
}

// Writes and their failures on a writable disk; each failure checked to have left the disk as it was.
static void writes(struct disk *d, const char *p) {
  char name[48];
  const char *s;
  int k;
#define NAME(x) (k = 0, ({ for (s = p; *s; s++) name[k++] = *s; for (s = x; *s; s++) name[k++] = *s; name[k] = 0; }), name)
  u64 last = d->sectors - 1;

  fill(DATA, 1024, 5, 0);
  request(T_OUT, 0, DATA, 1024, 1);
  submit(d, NAME(".write"), 0);
  request(T_IN, 0, SCRATCH, 1024, D_WRITE);
  submit(d, "", 0);
  note("read back", holds(SCRATCH, 1024, 5, 0));
  end();
  // The data writable: nothing to write.
  request(T_OUT, 0, DATA, 512, D_WRITE);
  submit(d, NAME(".write-from-writable"), 0);
  end();
  // The data in the header's buffer (Linux gives it a buffer of its own).
  nchain = 0;
  header(T_OUT, 4);
  fill(HDR + 16, 512, 9, 4 * 512);
  RD(HDR, 16 + 512);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".write-data-in-header"), 0);
  request(T_IN, 4, SCRATCH, 512, D_WRITE);
  submit(d, "", 0);
  note("read back", holds(SCRATCH, 512, 9, 4 * 512));
  end();
  // An unaligned length (100 bytes) into sector 6.
  memset((void *)DATA, 0, 512);
  request(T_OUT, 6, DATA, 512, 1);
  submit(d, "", 0);
  fill(DATA, 100, 11, 6 * 512);
  request(T_OUT, 6, DATA, 100, 1);
  submit(d, NAME(".write-100"), 0);
  request(T_IN, 6, SCRATCH, 512, D_WRITE);
  submit(d, "", 0);
  note("first 100 bytes", holds(SCRATCH, 100, 11, 6 * 512));
  note("rest zeros", zeros(SCRATCH + 100, 412));
  end();

  // Failures: across the end, at it, past 2^53, 2^64, the last u64. The last sector holds seed 13 before.
  fill(DATA, 512, 13, last * 512);
  request(T_OUT, last, DATA, 512, 1);
  submit(d, "", 0);
  fill(DATA, 1024, 17, last * 512);
  request(T_OUT, last, DATA, 1024, 1);
  submit(d, NAME(".write-across-end"), 0);
  request(T_IN, last, SCRATCH, 512, D_WRITE);
  submit(d, "", 0);
  note("last sector kept", holds(SCRATCH, 512, 13, last * 512));
  end();
  request(T_OUT, d->sectors, DATA, 512, 1);
  submit(d, NAME(".write-at-end"), 0);
  end();
  request(T_OUT, (1UL << 44) + 1, DATA, 512, 1);
  submit(d, NAME(".write-2^53"), 0);
  end();
  request(T_OUT, 1UL << 55, DATA, 512, 1);
  submit(d, NAME(".write-2^64"), 0);
  end();
  request(T_OUT, ~0UL, DATA, 512, 1);
  submit(d, NAME(".write-max"), 0);
  request(T_IN, 0, SCRATCH, 1024, D_WRITE);
  submit(d, "", 0);
  note("sectors 0-1 kept", holds(SCRATCH, 1024, 5, 0));
  end();
#undef NAME
}

// DISCARD and WRITE_ZEROES (one segment each: max_discard_seg and max_write_zeroes_seg are 1).
static void unmaps(struct disk *d, const char *p) {
  char name[48];
  const char *s;
  int k;
#define NAME(x) (k = 0, ({ for (s = p; *s; s++) name[k++] = *s; for (s = x; *s; s++) name[k++] = *s; name[k] = 0; }), name)
  u64 n = d->sectors;
#define UNMAP(type, len) (nchain = 0, header(type, 0), RD(HDR, 16), RD(SEG, len), WR(STATUS_AT, 1), status_at = STATUS_AT)

  // Sectors 16-31 hold seed 19; WRITE_ZEROES over 16-23 leaves 24-31.
  fill(DATA, 16 * 512, 19, 16 * 512);
  request(T_OUT, 16, DATA, 16 * 512, 1);
  submit(d, "", 0);
  segment(16, 8, 0);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes"), 0);
  request(T_IN, 16, SCRATCH, 16 * 512, D_WRITE);
  submit(d, "", 0);
  note("zeros", zeros(SCRATCH, 8 * 512));
  note("the rest kept", holds(SCRATCH + 8 * 512, 8 * 512, 19, 24 * 512));
  end();
  segment(24, 8, 1);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes-unmap"), 0);
  request(T_IN, 24, SCRATCH, 8 * 512, D_WRITE);
  submit(d, "", 0);
  note("zeros", zeros(SCRATCH, 8 * 512));
  end();
  segment(32, 8, 0);
  UNMAP(T_DISCARD, 16);
  submit(d, NAME(".discard"), 0);
  end();
  // The header and the segment in one buffer.
  nchain = 0;
  header(T_DISCARD, 0);
  mmio32(HDR + 16) = 40;
  mmio32(HDR + 20) = 0;
  mmio32(HDR + 24) = 8;
  mmio32(HDR + 28) = 0;
  RD(HDR, 32);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".discard-in-header"), 0);
  end();

  // Refusals, each leaving sectors 0-1 as they were (seed 5): unmap on a DISCARD and unknown flags, a short segment
  // and two, no segment, past the end, past 2^53, more than max_*_sectors, a sector count past 2^32 bytes.
  segment(0, 2, 1);
  UNMAP(T_DISCARD, 16);
  submit(d, NAME(".discard-unmap"), 0);
  end();
  segment(0, 2, 4);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes-flags"), 0);
  end();
  segment(0, 2, 0);
  UNMAP(T_WRITE_ZEROES, 8);
  submit(d, NAME(".write-zeroes-short"), 0);
  end();
  mmio32(SEG + 16) = 0;
  mmio32(SEG + 20) = 0;
  mmio32(SEG + 24) = 2;
  mmio32(SEG + 28) = 0;
  segment(0, 2, 0);
  UNMAP(T_WRITE_ZEROES, 32);
  submit(d, NAME(".write-zeroes-two"), 0);
  end();
  nchain = 0;
  header(T_WRITE_ZEROES, 0);
  RD(HDR, 16);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, NAME(".write-zeroes-none"), 0);
  end();
  segment(n - 1, 2, 0);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes-across-end"), 0);
  end();
  segment((1UL << 44) + 1, 1, 0);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes-2^53"), 0);
  end();
  segment(~0UL, 1, 0);
  UNMAP(T_DISCARD, 16);
  submit(d, NAME(".discard-max"), 0);
  end();
  segment(0, (1u << 22) + 1, 0);
  UNMAP(T_WRITE_ZEROES, 16);
  submit(d, NAME(".write-zeroes-too-many"), 0);
  end();
  segment(0, ~0u, 0);
  UNMAP(T_DISCARD, 16);
  submit(d, NAME(".discard-2^32-sectors"), 0);
  request(T_IN, 0, SCRATCH, 1024, D_WRITE);
  submit(d, "", 0);
  note("sectors 0-1 kept", holds(SCRATCH, 1024, 5, 0));
  end();
#undef UNMAP
#undef NAME
}

int main(void) {
  int found = 0;
  for (int i = 0; i < 8 && found < 3; i++) {
    u64 b = MMIO + i * STRIDE;
    if (mmio32(b + MAGIC) != 0x74726976 || mmio32(b + VERSION) != 2 || mmio32(b + DEVICE_ID) != 2) continue;
    struct disk *d = &disks[found];
    d->base = b;
    d->desc = (struct desc *)(QUEUES + found * 0x10000UL);
    d->avail = (struct avail *)((u64)d->desc + 0x1000);
    d->used = (volatile struct used *)((u64)d->desc + 0x2000);
    init(d);
    found++;
  }
  check(found == 3, 1);
  static const char *names[] = {"ram", "ro", "overlay"};
  for (int i = 0; i < 3; i++) {
    uart_puts(names[i]);
    uart_puts(" features=");
    hex(disks[i].features);
    uart_puts(" sectors=");
    uart_dec(disks[i].sectors);
    end();
  }

  // The ramdisk: zeros at first.
  reads(&disks[0], "ram", ZERO);
  writes(&disks[0], "ram");
  unmaps(&disks[0], "ram");

  // The read-only image: every change refused, the image as it was.
  struct disk *ro = &disks[1];
  reads(ro, "ro", 0);
  fill(DATA, 512, 5, 0);
  request(T_OUT, 0, DATA, 512, 1);
  submit(ro, "ro.write", 0);
  request(T_IN, 0, SCRATCH, 512, D_WRITE);
  submit(ro, "", 0);
  note("kept", holds(SCRATCH, 512, 0, 0));
  end();
  segment(0, 8, 0);
  nchain = 0;
  header(T_DISCARD, 0);
  RD(HDR, 16);
  RD(SEG, 16);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(ro, "ro.discard", 0);
  end();
  nchain = 0;
  header(T_WRITE_ZEROES, 0);
  RD(HDR, 16);
  RD(SEG, 16);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(ro, "ro.write-zeroes", 0);
  request(T_IN, 0, SCRATCH, 512, D_WRITE);
  submit(ro, "", 0);
  note("kept", holds(SCRATCH, 512, 0, 0));
  end();

  // The image under an overlay.
  reads(&disks[2], "overlay", 0);
  writes(&disks[2], "overlay");
  unmaps(&disks[2], "overlay");

  // A readable buffer after a writable one: the transport refuses the chain (DEVICE_NEEDS_RESET) and posts nothing;
  // after a reset the device reads again.
  struct disk *d = &disks[0];
  nchain = 0;
  header(T_IN, 0);
  WR(DATA, 512);
  RD(HDR, 16);
  WR(STATUS_AT, 1);
  status_at = STATUS_AT;
  submit(d, "ram.readable-after-writable", 0);
  end();
  init(d);
  request(T_IN, 0, SCRATCH, 1024, D_WRITE);
  submit(d, "ram.after-reset", 0);
  note("data", holds(SCRATCH, 1024, 5, 0));
  end();
  return 0;
}
