// The network's settings in the guest (web/app/guest-net.ts, docs/frontend.md "What the page sets in the guest"): the
// unit's credentials, and the script the guest runs, under dash on directories of its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DROPIN, netCredentials, netScript } from '../web/app/guest-net.ts';
import { oemStrings } from '../web/app/guest-unit.ts';

const hasDash = process.env.PATH?.split(':').some((p) => existsSync(join(p, 'dash')));

test('credentials: a unit before networkd, its drop-in on networkd and its script, as base64 SMBIOS strings', () => {
  const c = netCredentials();
  assert.deepEqual(c.map((x) => x.name), ['webpc.network.sh', 'systemd.extra-unit.webpc-network.service', 'systemd.unit-dropin.systemd-networkd.service~webpc-network']);
  assert.match(c[1].data, /^DefaultDependencies=no$/m);
  assert.match(c[1].data, /^Before=systemd-networkd\.service /m);
  assert.match(c[1].data, /^After=local-fs\.target systemd-network-generator\.service$/m);
  assert.match(c[1].data, /^ImportCredential=webpc\.network\.sh$/m);
  assert.match(c[1].data, /^ExecStart=\/bin\/sh %d\/webpc\.network\.sh$/m);
  assert.match(c[1].data, /^ConditionPathExists=!\/etc\/initrd-release$/m);
  assert.equal(c[2].data, '[Unit]\nWants=webpc-network.service\nAfter=webpc-network.service\n');
  for (const [i, x] of oemStrings(c).entries()) assert.equal(Buffer.from(x.split('=').slice(1).join('='), 'base64').toString(), c[i].data);
});

test("the script: every .network file in networkd's directories gets the drop-in in /run, the same again changes nothing", { skip: !hasDash && 'no dash' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'webpc-net-'));
  try {
    const at = (p: string) => join(root, p);
    // Arch's (sorts before the page's card.network), the page's own, a vendor's, and an example that isn't a .network.
    for (const [p, data] of [['etc/systemd/network/20-en.network', '[Match]\nName=en*\n[Network]\nDHCP=yes\n'], ['run/systemd/network/card.network', '[Match]\nName=e*\n'], ['usr/lib/systemd/network/80-container-host0.network', ''], ['usr/lib/systemd/network/89-ethernet.network.example', '']]) {
      mkdirSync(at(p.replace(/\/[^/]+$/, '')), { recursive: true });
      writeFileSync(at(p), data);
    }
    const script = join(root, 's.sh');
    // The script with its absolute paths moved under `root`.
    writeFileSync(script, netScript().replace(/(?<=[ =])\/(etc|run|usr|lib)\//g, `${root}/$1/`));
    const run = () => execFileSync('dash', [script], { stdio: 'pipe' });
    run();
    run();
    const dropins = readdirSync(at('run/systemd/network')).filter((d) => d.endsWith('.d')).sort();
    assert.deepEqual(dropins, ['20-en.network.d', '80-container-host0.network.d', 'card.network.d']);
    for (const d of dropins) {
      assert.deepEqual(readdirSync(at(`run/systemd/network/${d}`)), ['50-webpc.conf']);
      assert.equal(readFileSync(at(`run/systemd/network/${d}/50-webpc.conf`), 'utf8'), DROPIN);
    }
    assert.equal(readFileSync(at('etc/systemd/network/20-en.network'), 'utf8'), '[Match]\nName=en*\n[Network]\nDHCP=yes\n', "the guest's own file is left as it is");
    assert.equal(existsSync(at('etc/systemd/network/20-en.network.d')), false, 'nothing outside /run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
