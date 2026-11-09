// virtio-9p requests no Linux client sends, through the whole path: the device tests' driver (virtio.h) posts
// hand-built 9P2000.L messages to the in-memory tree (web/9p.ts, tag `host` with /hello.txt) and prints, per case,
// the used length and the reply; tests/virtio-guest.test.ts has what each should get. A session first (version,
// attach, walk, open, read), then the chain's shape (a `size` past the readable bytes or under 7, too little room,
// trailing bytes, 1-byte buffers, a count past the room, a reply past it) and the message's (truncated fields, a
// string past the end, an unknown type or fid, a write's count past its data, offsets past 2^40 and 2^63).
#include "virtio.h"

#define MSG 0x40900000UL   // the T-message
#define REPLY 0x40910000UL // the R-message (64 KiB)

static struct dev p9;

// The T-message being written at MSG: size (filled in by `send`), type, tag, then the fields.
static u32 at;
static void p8(u32 v) { mmio8(MSG + at++) = (u8)v; }
static void p16(u32 v) { p8(v); p8(v >> 8); }
static void p32(u32 v) { p16(v); p16(v >> 16); }
static void p64(u64 v) { p32((u32)v); p32((u32)(v >> 32)); }
static void pstr(const char *s) {
  u32 n = 0;
  while (s[n]) n++;
  p16(n);
  for (u32 i = 0; i < n; i++) p8(s[i]);
}
static u32 tag;
static void msg(u32 type) {
  at = 4;
  p8(type);
  p16(++tag & 0x7fff);
}
static u32 g8(u32 o) { return mmio8(REPLY + o); }
static u32 g16(u32 o) { return g8(o) | g8(o + 1) << 8; }
static u32 g32(u32 o) { return g16(o) | g16(o + 2) << 16; }

// The message's size field set to its length plus `extra`, then the usual chain: the message readable, `room` bytes
// writable (64 KiB when 0).
static u32 size_extra;
static void chain_of(u32 room) {
  u32 size = at + size_extra;
  for (int i = 0; i < 4; i++) mmio8(MSG + i) = (u8)(size >> 8 * i);
  nchain = 0;
  RD(MSG, at);
  WR(REPLY, room ? room : 0x10000);
}

// Posts the chain, waits, prints `<name> n=<used length>` and the reply: `R<type>` with what matters of it
// (`Rlerror <errno>`, `Rread <count> <text>`), `tag?` when its tag isn't the request's.
static void run(const char *name) {
  memset((void *)REPLY, 0, 64);
  post(&p9, 0, 0, 0);
  u32 id, len;
  int got = wait_used(&p9, 0, &id, &len);
  if (!name) return;
  uart_puts(name);
  uart_puts(" n=");
  if (got) uart_dec(len);
  else uart_puts("-");
  if (got && len >= 7) {
    u32 type = g8(4);
    if (g16(5) != (tag & 0x7fff)) uart_puts(" tag?");
    uart_puts(" R");
    uart_dec(type);
    if (type == 7) {
      uart_puts(" errno=");
      uart_dec(g32(7));
    } else if (type == 101) {
      uart_puts(" msize=");
      uart_dec(g32(7));
    } else if (type == 111) {
      uart_puts(" nwqid=");
      uart_dec(g16(7));
    } else if (type == 117) {
      u32 n = g32(7);
      uart_puts(" count=");
      uart_dec(n);
      uart_puts(" ");
      for (u32 i = 0; i < n && i < 40; i++) uart_putc(g8(11 + i) == '\n' ? '/' : (char)g8(11 + i));
    } else if (type == 119) {
      uart_puts(" count=");
      uart_dec(g32(7));
    }
  }
  if (needs_reset(&p9)) uart_puts(" reset");
  end();
}

static void tread(u32 fid, u64 off, u32 count) {
  msg(116);
  p32(fid);
  p64(off);
  p32(count);
}

int main(void) {
  p9.base = dev_find(9, 0);
  check(p9.base, 1);
  dev_init(&p9, 0, 1, 1 /* MOUNT_TAG */, 0);
  uart_puts("9p features=");
  hex(p9.offered[0]);
  uart_puts(" tag=");
  for (u32 i = 0, n = mmio8(p9.base + CONFIG) | mmio8(p9.base + CONFIG + 1) << 8; i < n; i++) uart_putc(mmio8(p9.base + CONFIG + 2 + i));
  end();

  // The session: fid 1 the root, fid 2 /hello.txt opened for reading.
  msg(100);
  p32(8192);
  pstr("9P2000.L");
  chain_of(0);
  run("version");
  msg(104);
  p32(1);
  p32(~0u);
  pstr("root");
  pstr("");
  p32(0);
  chain_of(0);
  run("attach");
  msg(110);
  p32(1);
  p32(2);
  p16(1);
  pstr("hello.txt");
  chain_of(0);
  run("walk");
  msg(12);
  p32(2);
  p32(0);
  chain_of(0);
  run("lopen");
  tread(2, 0, 100);
  chain_of(0);
  run("read");

  // The chain's shape. A size past the readable bytes, one under 7, 4 bytes readable in all, room for 10: no answer.
  tread(2, 0, 100);
  size_extra = 10;
  chain_of(0);
  size_extra = 0;
  run("size-past-readable");
  tread(2, 0, 100);
  chain_of(0);
  mmio32(MSG) = 6;
  run("size-6");
  tread(2, 0, 100);
  chain_of(0);
  chain[0].len = 4;
  run("readable-4");
  tread(2, 0, 100);
  chain_of(10);
  run("room-10");
  // Bytes past the size: left out.
  tread(2, 0, 100);
  chain_of(0);
  chain[0].len += 32;
  run("bytes-past-size");
  // The message and the reply in 1-byte buffers (23 readable, 40 writable).
  tread(2, 0, 100);
  chain_of(0);
  nchain = 0;
  for (u32 i = 0; i < at; i++) RD(MSG + i, 1);
  for (u32 i = 0; i < 40; i++) WR(REPLY + i, 1);
  run("one-byte-buffers");
  // A count past the room (16 bytes: 5 of data) and the largest count: cut to the room, then to the file.
  tread(2, 0, 100);
  chain_of(16);
  run("read-count-past-room");
  tread(2, 0, ~0u);
  chain_of(64);
  run("read-count-max");
  tread(2, ~0UL, 100);
  chain_of(0);
  run("read-offset-max");
  // A reply past the room: Rgetattr (160 bytes) into 20. No answer.
  msg(24);
  p32(2);
  p64(0x3fff);
  chain_of(20);
  run("reply-past-room");

  // The message's fields. Two names announced, one there; 65535 announced, none there; a string past the end.
  msg(110);
  p32(1);
  p32(3);
  p16(2);
  pstr("hello.txt");
  chain_of(0);
  run("walk-truncated");
  msg(110);
  p32(1);
  p32(3);
  p16(65535);
  chain_of(0);
  run("walk-65535");
  msg(110);
  p32(1);
  p32(3);
  p16(1);
  p16(1000);
  p8('a');
  chain_of(0);
  run("string-past-end");
  // A header and nothing else of a Tread; an unknown type; an unknown fid; a fid in use as newfid.
  msg(116);
  chain_of(0);
  run("read-no-fields");
  msg(250);
  p32(1);
  chain_of(0);
  run("type-250");
  tread(99, 0, 100);
  chain_of(0);
  run("unknown-fid");

  // Writes: fid 4 a new file /new (a clone of the root, then Tlcreate), its count past the data, offsets past 2^40
  // and 2^63, then a write that lands, read back.
  msg(110);
  p32(1);
  p32(4);
  p16(0);
  chain_of(0);
  run(0);
  msg(14);
  p32(4);
  pstr("new");
  p32(2); // O_RDWR
  p32(0644);
  p32(0);
  chain_of(0);
  run("lcreate");
  msg(118);
  p32(4);
  p64(0);
  p32(100);
  for (int i = 0; i < 5; i++) p8('x');
  chain_of(0);
  run("write-count-past-data");
  msg(118);
  p32(4);
  p64(1UL << 40);
  p32(3);
  p8('a'), p8('b'), p8('c');
  chain_of(0);
  run("write-2^40");
  msg(118);
  p32(4);
  p64(1UL << 63);
  p32(3);
  p8('a'), p8('b'), p8('c');
  chain_of(0);
  run("write-2^63");
  msg(118);
  p32(4);
  p64(0);
  p32(3);
  p8('a'), p8('b'), p8('c');
  chain_of(0);
  run("write");
  tread(4, 0, 100);
  chain_of(0);
  run("read-back");

  // A Tflush of a tag that isn't running; a Tversion (every fid ends), then fid 2 is unknown.
  msg(108);
  p16(0x1234);
  chain_of(0);
  run("flush-idle-tag");
  msg(100);
  p32(8192);
  pstr("9P2000.L");
  chain_of(0);
  run("version-again");
  tread(2, 0, 100);
  chain_of(0);
  run("read-after-version");
  return 0;
}
