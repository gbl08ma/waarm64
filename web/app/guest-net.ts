// The network's settings in the guest (docs/frontend.md "What the page sets in the guest"): a machine with the setting
// on (`MachineRecord.netConfig`, on unless false) has systemd-networkd take what each adapter's lease says, the MTU
// (DHCP option 26: a tailnet's 1280, not virtio-net's 1500) and the search domain (MagicDNS's), whatever .network file
// configures the adapter. The page's own .network credential (web/app/machine.ts `NETWORKD`) does that only where no
// file of the guest's sorts before it (Arch's 20-en*.network and netplan's 10-netplan-*.network, Debian's cloud image's
// and Ubuntu's, do). So the unit gives every .network file a drop-in in /run: nothing reaches the guest's disk, and a
// boot with the setting off has none.
// NetworkManager asks for the MTU (option 26) by default and applies it while the connection's MTU is automatic, as
// does Debian's dhclient: nothing to do there. Without the MTU the gateway's MSS clamp keeps TCP working (docs/frontend.md
// "Network"); UDP over IPv4 past 1280 bytes without DF is dropped.

import { guestUnit } from './guest-unit.ts';
import type { Credential } from './machine.ts';

/** Where networkd reads .network files (systemd.network(5)), /lib for older layouts. */
const DIRS = ['/etc/systemd/network', '/run/systemd/network', '/usr/local/lib/systemd/network', '/usr/lib/systemd/network', '/lib/systemd/network'];

/** What every .network file gets: the lease's MTU and search domains, v4 and v6. */
export const DROPIN = '[DHCPv4]\nUseMTU=yes\nUseDomains=yes\n\n[DHCPv6]\nUseDomains=yes\n';

/** The script the unit runs, before networkd. POSIX sh. */
export function netScript(): string {
  return `# From webpc: the machine's "Take the connection's settings" (its Network tab), run at every boot while it is on.
# Every .network file of systemd-networkd's takes the DHCP lease's MTU and search domain, by a drop-in in /run (gone at
# the next boot). A drop-in of the guest's own that sorts after 50-webpc.conf wins.
for f in ${DIRS.map((d) => `${d}/*.network`).join(' ')}; do
  [ -e "$f" ] || continue
  d=/run/systemd/network/\${f##*/}.d
  mkdir -p "$d" && printf '${DROPIN.replaceAll('\n', '\\n')}' >"$d/50-webpc.conf"
done
`;
}

/** The systemd credentials (web/app/guest-unit.ts: SMBIOS, systemd 256+) that have the guest take the leases' settings. */
export const netCredentials = (description: string): Credential[] =>
  guestUnit({
    name: 'webpc-network.service',
    description,
    script: netScript(),
    // Before networkd reads its files; after the generator writes the page's .network credential into /run.
    unit: 'DefaultDependencies=no\nAfter=local-fs.target systemd-network-generator.service\nBefore=systemd-networkd.service network-pre.target shutdown.target\nConflicts=shutdown.target\n',
    wantedBy: 'systemd-networkd.service',
  });
