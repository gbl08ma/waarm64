// A resolver for the tailcat client's IPv6 probe (web/reach6.ts) to ask in the tests: on this machine's IPv6 address
// (`host`, not link-local; the exit node is on this machine and dials it), answering every DNS query with itself.
// `off()` stands for an exit node whose IPv6 doesn't reach the internet, `on()` for one whose does, on the same port.
// (No stand-in works without such an address: the exit node drops `::1` and `::ffff:127.0.0.1`, and answers from
// `64:ff9b::/96` reach the guest as IPv4, so a machine without IPv6 tests only the probe lost.)
import { createSocket, type Socket } from 'node:dgram';

export type ProbeResolver = { to: string; port: number; on(): Promise<void>; off(): Promise<void> };

export async function probeResolver(host: string): Promise<ProbeResolver> {
  let sock: Socket | undefined;
  let port = 0;
  const on = () => new Promise<void>((resolve, reject) => {
    if (sock) return resolve();
    const s = createSocket('udp6');
    s.on('message', (m, from) => {
      if (m.length < 12) return;
      m[2] |= 0x80; // QR: an answer
      s.send(m, from.port, from.address);
    });
    s.once('error', reject);
    s.bind(port, host, () => {
      port = s.address().port;
      sock = s;
      resolve();
    });
  });
  const off = () => new Promise<void>((resolve) => {
    const s = sock;
    sock = undefined;
    if (s) s.close(() => resolve());
    else resolve();
  });
  await on();
  return { to: host, port, on, off };
}
