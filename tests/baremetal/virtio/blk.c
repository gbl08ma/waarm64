// virtio-blk requests no Linux driver sends, through the whole path: the device tests' driver (virtio.h) posts
// hand-built chains to three disks and prints, per case, the status byte the device wrote and the used length;
// tests/virtio-guest.test.ts boots it in Node over the TS backends (web/devices.ts `blk`) and compares the transcript
// with what it expects. Linux's drivers test the well-formed path (the Buildroot device test, the Debian page tests);
// this is the rest: short, split or misplaced headers, no status byte, ranges past the disk's end or past 2^53 bytes,
// data in the wrong direction, unknown types, DISCARD and WRITE_ZEROES segments that don't fit, a write to a read-only
// disk, a chain the transport refuses (DEVICE_NEEDS_RESET, then a reset and a request).
//
// The disks, in device order: 0 a 1 MiB ramdisk (discard), 1 a 64 KiB read-only image, 2 a 64 KiB image under an
// overlay (discard). The images hold `pattern(0, offset)`.
#include "virtio.h"

#define F_SEG_MAX (1u << 2)
#define F_RO (1u << 5)
#define F_FLUSH (1u << 9)
#define F_DISCARD (1u << 13)
#define F_WRITE_ZEROES (1u << 14)

#define T_IN 0
#define T_OUT 1
#define T_FLUSH 4
#define T_GET_ID 8
#define T_DISCARD 11
#define T_WRITE_ZEROES 13

#define HDR 0x40900000UL     // the request header (16 bytes), and what follows it in the same buffer
#define DATA 0x40910000UL    // data (64 KiB)
#define STATUS_AT 0x40920000UL
#define SEG 0x40930000UL     // a DISCARD or WRITE_ZEROES segment
#define SCRATCH 0x40950000UL // a second data buffer (64 KiB)

struct disk {
  struct dev v;
  int slot;
  u64 sectors;
} disks[3];

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

// Resets the disk and brings its queue up again, and reads its capacity.
static void init(struct disk *d) {
  dev_init(&d->v, d->slot, 1, F_SEG_MAX | F_RO | F_FLUSH | F_DISCARD | F_WRITE_ZEROES | F_INDIRECT, 0);
  d->sectors = R(&d->v, CONFIG) | (u64)R(&d->v, CONFIG + 4) << 32;
}

static u64 status_at; // the byte `submit` reports as the status (preset to 0xee: "not written")
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
// brought up again, so the next case starts from a working device). A helper's request (no name: setting a case up,
// reading its result back) prints only its failure.
static int submit(struct disk *d, const char *name, int indirect) {
  if (status_at) mmio8(status_at) = 0xee;
  post(&d->v, 0, 0, indirect);
  u32 id, len;
  long got = wait_used(&d->v, 0, &id, &len) ? (long)len : -1;
  check(got < 0 || id == 0, 4);
  u8 s = status_at ? mmio8(status_at) : 0xee;
  int reset = needs_reset(&d->v);
  if (!*name) {
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
  for (int i = 0; i < 3; i++) {
    disks[i].v.base = dev_find(2, i);
    check(disks[i].v.base, 1);
    disks[i].slot = i;
    init(&disks[i]);
  }
  static const char *names[] = {"ram", "ro", "overlay"};
  for (int i = 0; i < 3; i++) {
    uart_puts(names[i]);
    uart_puts(" features=");
    hex(disks[i].v.offered[0]);
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
