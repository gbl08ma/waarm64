// virtio-net chains no Linux driver posts, through the whole path: the device tests' driver (virtio.h) transmits
// hand-built frames to the loopback adapter (web/net.ts: it answers ARP and pings for 10.0.2.2) and prints, per case,
// the frames that came back before the reply to a probe ping sent after it (so the device is shown alive, and a frame
// the device let through when it should have dropped it shows up, in parallel runs too); tests/virtio-guest.test.ts
// has what each should get. Transmit: headers short or alone, split over buffers or writable, a checksum to finish
// past the frame, frames past 1518 bytes, GSO on what isn't TCP or with an unknown type or an MSS of 0 or 1, a GSO
// packet past the largest. Receive: a frame over small mergeable buffers, a readable buffer first, and without
// MRG_RXBUF a buffer too small for any frame.
#include "virtio.h"

#define F_CSUM (1u << 0)
#define F_MAC (1u << 5)
#define F_HOST_TSO4 (1u << 11)
#define F_HOST_TSO6 (1u << 12)
#define F_HOST_ECN (1u << 13)
#define F_MRG_RXBUF (1u << 15)
#define F_STATUS (1u << 16)
#define F_HOST_USO_HI (1u << 24) // feature 56

#define RXQ 0
#define TXQ 1
#define RXN 16             // receive buffers posted, heads 0..15
#define RXBUF 0x40900000UL // their memory: 2 KiB each
#define TX 0x40920000UL    // the transmitted header and frame (up to 70 KiB)
#define FRAME 0x40940000UL // a received frame, put together
#define SMALL 0x40950000UL // small receive buffers

#define HDR 12 // virtio_net_hdr_v1
#define ETH 14

static struct dev net;
static u8 mac[6];
static const u8 peer_mac[6] = {0x52, 0x55, 0x0a, 0x00, 0x02, 0x02};
static const u8 me[4] = {10, 0, 2, 15}, peer[4] = {10, 0, 2, 2};
static u64 rx_addr[QN];
static u32 rx_len[QN];
static u16 rx_flags[QN];

static void rx_post(u16 head, u64 addr, u32 len, u16 flags) {
  rx_addr[head] = addr, rx_len[head] = len, rx_flags[head] = flags;
  nchain = 0;
  buf(addr, len, flags);
  post(&net, RXQ, head, 0);
}

static void init(u32 features) {
  dev_init(&net, 0, 2, features, F_HOST_USO_HI);
  for (u16 i = 0; i < RXN; i++) rx_post(i, RXBUF + i * 0x800UL, 0x800, D_WRITE);
}

static void put8(u64 a, u32 v) { mmio8(a) = (u8)v; }
static void put16be(u64 a, u32 v) { put8(a, v >> 8), put8(a + 1, v); }
static u32 get16be(u64 a) { return mmio8(a) << 8 | mmio8(a + 1); }
static u32 sum(u64 a, u32 len, u32 s) {
  for (u32 i = 0; i + 1 < len; i += 2) s += get16be(a + i);
  if (len & 1) s += mmio8(a + len - 1) << 8;
  return s;
}
static u32 fold(u32 s) {
  while (s > 0xffff) s = (s & 0xffff) + (s >> 16);
  return s;
}

// The virtio-net header at TX: flags, gso_type, hdr_len, gso_size, csum_start, csum_offset (num_buffers 0).
static void header(u32 flags, u32 gso, u32 gso_size, u32 csum_start, u32 csum_offset) {
  put8(TX, flags), put8(TX + 1, gso);
  mmio16(TX + 2) = 0, mmio16(TX + 4) = (u16)gso_size, mmio16(TX + 6) = (u16)csum_start, mmio16(TX + 8) = (u16)csum_offset;
  mmio16(TX + 10) = 0;
}
static void eth(u64 f, const u8 *dst, u32 type) {
  for (int i = 0; i < 6; i++) put8(f + i, dst[i]), put8(f + 6 + i, mac[i]);
  put16be(f + 12, type);
}
// An IPv4 header at `f + ETH` for `len` bytes of protocol `proto` after it.
static void ip(u64 f, u32 proto, u32 len) {
  u64 h = f + ETH;
  put8(h, 0x45), put8(h + 1, 0), put16be(h + 2, 20 + len), put16be(h + 4, 1), put16be(h + 6, 0);
  put8(h + 8, 64), put8(h + 9, proto), put16be(h + 10, 0);
  for (int i = 0; i < 4; i++) put8(h + 12 + i, me[i]), put8(h + 16 + i, peer[i]);
  put16be(h + 10, ~fold(sum(h, 20, 0)) & 0xffff);
}
// A ping to the peer with `n` bytes of payload (byte i = i + seq) at TX + HDR; its frame's length.
static u32 ping(u32 seq, u32 n) {
  u64 f = TX + HDR, icmp = f + ETH + 20;
  eth(f, peer_mac, 0x0800);
  ip(f, 1, 8 + n);
  put8(icmp, 8), put8(icmp + 1, 0), put16be(icmp + 2, 0), put16be(icmp + 4, 0x77), put16be(icmp + 6, seq);
  for (u32 i = 0; i < n; i++) put8(icmp + 8 + i, i + seq);
  put16be(icmp + 2, ~fold(sum(icmp, 8 + n, 0)) & 0xffff);
  return ETH + 20 + 8 + n;
}
// A TCP packet to the peer with `n` bytes of payload at TX + HDR (the loopback adapter ignores it); its length.
static u32 tcp(u32 n) {
  u64 f = TX + HDR, t = f + ETH + 20;
  eth(f, peer_mac, 0x0800);
  ip(f, 6, 20 + n);
  for (u32 i = 0; i < 20; i++) put8(t + i, 0);
  put16be(t, 4000), put16be(t + 2, 80), put8(t + 12, 5 << 4), put8(t + 13, 0x18), put16be(t + 14, 65535);
  for (u32 i = 0; i < n; i++) put8(t + 20 + i, i);
  return ETH + 40 + n;
}

// Transmits the chain built, waits for its completion (` tx-lost` if none), and resets the device if it asks.
static void transmit(void) {
  post(&net, TXQ, 0, 0);
  u32 id, len;
  if (!wait_used(&net, TXQ, &id, &len)) uart_puts(" tx-lost");
  if (needs_reset(&net)) uart_puts(" reset");
}
static void tx_frame(u32 n) {
  nchain = 0;
  RD(TX, HDR + n);
  transmit();
}

// The next frame received, put together at FRAME from its buffers (num_buffers with MRG_RXBUF), each buffer posted
// again; its length (0 when none comes), `bufs` its buffers and `lens` their used lengths.
static u32 bufs, lens[8];
static u32 receive(long spins) {
  u32 id, len, at = 0, nb = 0; // nb: num_buffers, once the header is in (a buffer may have taken none of it)
  long s = 0;
  bufs = 0;
  for (;;) {
    while (!poll_used(&net, RXQ, &id, &len))
      if (++s > spins) return at;
    if (bufs < 8) lens[bufs] = len;
    bufs++;
    memcpy((void *)(FRAME + at), (void *)rx_addr[id], len);
    at += len;
    rx_post((u16)id, rx_addr[id], rx_len[id], rx_flags[id]);
    if (!nb && at >= HDR) nb = net.features[0] & F_MRG_RXBUF ? mmio16(FRAME + 10) : 1;
    if (nb && bufs >= nb) return at;
  }
}

// The probe: a ping with sequence number 1000 + `seq`; then the frames up to its reply, printed: `rx=<count>` and
// what each was (`arp-reply`, `echo seq=<n> len=<frame bytes>`, `other len=`), ` dead` if the reply never came.
static void after(u32 seq) {
  header(0, 0, 0, 0, 0);
  tx_frame(ping(1000 + seq, 16));
  u32 n = 0;
  char line[200];
  int k = 0;
#define S(x) ({ const char *s_ = (x); while (*s_ && k < 190) line[k++] = *s_++; })
  for (;;) {
    u32 len = receive(1L << 24);
    if (!len) {
      uart_puts(" rx=");
      uart_dec(n);
      line[k] = 0;
      uart_puts(line);
      uart_puts(" dead");
      return;
    }
    u64 f = FRAME + HDR;
    u32 type = get16be(f + 12), flen = len - HDR;
    if (type == 0x0800 && mmio8(f + 23) == 1 && mmio8(f + 34) == 0 && get16be(f + 40) == 1000 + seq) break;
    n++;
    if (type == 0x0806 && get16be(f + 20) == 2) S(" arp-reply");
    else if (type == 0x0800 && mmio8(f + 23) == 1 && mmio8(f + 34) == 0) {
      char b[24], *p = b + 23;
      *p = 0;
      u32 v = flen;
      do *--p = '0' + v % 10; while (v /= 10);
      S(" echo seq=");
      char c[8], *q = c + 7;
      *q = 0;
      v = get16be(f + 40);
      do *--q = '0' + v % 10; while (v /= 10);
      S(q);
      S(" len=");
      S(p);
    } else S(" other");
    if (bufs > 1) S(" (buffers)");
  }
  line[k] = 0;
  uart_puts(" rx=");
  uart_dec(n);
  uart_puts(line);
#undef S
}

static u32 seq;
static void name(const char *s) {
  uart_puts(s);
  seq++;
}

int main(void) {
  net.base = dev_find(1, 0);
  check(net.base, 1);
  const u32 lo = F_CSUM | F_MAC | F_STATUS | F_HOST_TSO4 | F_HOST_TSO6 | F_HOST_ECN | F_MRG_RXBUF;
  init(lo);
  for (int i = 0; i < 6; i++) mac[i] = mmio8(net.base + CONFIG + i);
  uart_puts("net features=");
  hex(net.offered[0]);
  uart_puts(" ");
  hex(net.offered[1]);
  uart_puts(" link=");
  uart_dec(mmio8(net.base + CONFIG + 6));
  end();

  // ARP for the peer, and a ping: well-formed, for reference.
  name("arp");
  header(0, 0, 0, 0, 0);
  u64 f = TX + HDR;
  eth(f, (const u8[]){0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, 0x0806);
  put16be(f + 14, 1), put16be(f + 16, 0x0800), put8(f + 18, 6), put8(f + 19, 4), put16be(f + 20, 1);
  for (int i = 0; i < 6; i++) put8(f + 22 + i, mac[i]), put8(f + 32 + i, 0);
  for (int i = 0; i < 4; i++) put8(f + 28 + i, me[i]), put8(f + 38 + i, peer[i]);
  tx_frame(42);
  after(seq);
  end();
  name("ping");
  header(0, 0, 0, 0, 0);
  tx_frame(ping(seq, 56));
  after(seq);
  end();

  // A checksum to finish (NEEDS_CSUM) at the ICMP payload's byte 16, over the ICMP message: the echo shows it.
  name("csum");
  u32 n = ping(seq, 56);
  u64 icmp = TX + HDR + ETH + 20;
  put16be(icmp + 2, 0);
  put16be(icmp + 8 + 16, 0);
  u32 want = ~fold(sum(icmp, n - ETH - 20, 0)) & 0xffff;
  if (!want) want = 0xffff;
  header(1, 0, 0, ETH + 20, 8 + 16);
  tx_frame(n);
  after(seq);
  note("finished", get16be(FRAME + HDR + ETH + 20 + 8 + 16) == want);
  end();
  // Its place past the frame, and its start at 65535: dropped.
  name("csum-past-frame");
  n = ping(seq, 56);
  header(1, 0, 0, ETH + 20, n - ETH - 20 - 1);
  tx_frame(n);
  after(seq);
  end();
  name("csum-start-max");
  header(1, 0, 0, 0xffff, 0);
  tx_frame(ping(seq, 56));
  after(seq);
  end();

  // The chain: the header alone, part of one, nothing readable, the header in 3 buffers and the frame in 1-byte ones,
  // a writable buffer after the frame.
  name("header-only");
  header(0, 0, 0, 0, 0);
  nchain = 0;
  RD(TX, HDR);
  transmit();
  after(seq);
  end();
  name("header-5");
  nchain = 0;
  RD(TX, 5);
  transmit();
  after(seq);
  end();
  name("all-writable");
  n = ping(seq, 56);
  nchain = 0;
  WR(TX, HDR + n);
  transmit();
  after(seq);
  end();
  name("split");
  header(0, 0, 0, 0, 0);
  n = ping(seq, 56);
  nchain = 0;
  RD(TX, 4), RD(TX + 4, 4), RD(TX + 8, 4);
  for (u32 i = 0; i < n; i++) RD(TX + HDR + i, 1);
  transmit();
  after(seq);
  end();
  name("writable-after-frame");
  n = ping(seq, 56);
  nchain = 0;
  RD(TX, HDR + n);
  WR(SMALL, 64);
  transmit();
  after(seq);
  end();

  // Frames of 1518 bytes (the largest without GSO) and 1519.
  name("frame-1518");
  header(0, 0, 0, 0, 0);
  tx_frame(ping(seq, 1518 - ETH - 28));
  after(seq);
  end();
  name("frame-1519");
  tx_frame(ping(seq, 1519 - ETH - 28));
  after(seq);
  end();

  // GSO: TCPv4 on a ping, an unknown type (2) on one, an MSS of 0 on TCP; an MSS of 1 on 60,000 bytes of TCP (60,000
  // segments, which the loopback adapter ignores); a TCP packet past the largest (18 + 40 + 65535 bytes).
  name("gso-on-icmp");
  header(0, 1, 100, 0, 0);
  tx_frame(ping(seq, 1400));
  after(seq);
  end();
  name("gso-type-2");
  header(0, 2, 100, 0, 0);
  tx_frame(ping(seq, 1400));
  after(seq);
  end();
  name("gso-mss-0");
  header(1, 1, 0, ETH + 20, 16);
  tx_frame(tcp(4000));
  after(seq);
  end();
  name("gso-mss-1");
  header(1, 1, 1, ETH + 20, 16);
  tx_frame(tcp(60000));
  after(seq);
  end();
  name("gso-past-largest");
  header(1, 1, 1000, ETH + 20, 16);
  tx_frame(tcp(18 + 40 + 65535 + 1 - ETH - 40));
  after(seq);
  end();

  // Receive: a ping's reply (110 bytes with the header) over 32-byte mergeable buffers, alone in the queue.
  name("rx-merged");
  dev_init(&net, 0, 2, lo, F_HOST_USO_HI);
  for (u16 i = 0; i < 8; i++) rx_post(i, SMALL + i * 32UL, 32, D_WRITE);
  header(0, 0, 0, 0, 0);
  tx_frame(ping(seq, 56));
  n = receive(1L << 24);
  uart_puts(" bytes=");
  uart_dec(n);
  uart_puts(" buffers=");
  uart_dec(bufs);
  uart_puts(" num_buffers=");
  uart_dec(mmio16(FRAME + 10));
  note("data", n == HDR + 98 && get16be(FRAME + HDR + 40) == seq);
  end();
  // A readable buffer first, then the usual ones.
  name("rx-readable-first");
  dev_init(&net, 0, 2, lo, F_HOST_USO_HI);
  rx_post(0, SMALL, 64, 0);
  for (u16 i = 1; i < RXN; i++) rx_post(i, RXBUF + i * 0x800UL, 0x800, D_WRITE);
  tx_frame(ping(seq, 56));
  n = receive(1L << 24);
  uart_puts(" bytes=");
  uart_dec(n);
  uart_puts(" buffers=");
  uart_dec(bufs);
  uart_puts(" lens=");
  for (u32 i = 0; i < bufs && i < 8; i++) {
    if (i) uart_puts(",");
    uart_dec(lens[i]);
  }
  end();
  // Without MRG_RXBUF, a 64-byte buffer alone: the reply doesn't fit and is dropped, the buffer kept.
  name("rx-too-small");
  dev_init(&net, 0, 2, lo & ~F_MRG_RXBUF, F_HOST_USO_HI);
  rx_post(0, SMALL, 64, D_WRITE);
  tx_frame(ping(seq, 56));
  n = receive(1L << 20);
  uart_puts(" bytes=");
  uart_dec(n);
  // A buffer that fits, after it: the next reply still waits behind the small one, which no frame fits.
  rx_post(1, RXBUF, 0x800, D_WRITE);
  tx_frame(ping(seq, 16));
  n = receive(1L << 20);
  uart_puts(" then=");
  uart_dec(n);
  end();
  // And after a reset, as usual.
  name("after-reset");
  init(lo);
  after(seq);
  end();
  return 0;
}
