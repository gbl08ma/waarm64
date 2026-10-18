// Alpine's UEFI cloud images through our EDK2 (M8 phase B, docs/firmware.md): the firmware
// configuration boots them (Limine, GRUB) to a root login on the serial console, which runs a
// command and powers off, as tools/uefi-oracle.ts does on QEMU. A NoCloud seed disk (web/fat.ts)
// unlocks root. The page's shape: 2 vCPU workers, realtime, the JIT, a framebuffer, a writable
// overlay (in memory in Node). Opt-in with WEBPC_DISTROS=alpine-uefi (images/build.sh alpine-uefi).
// Debian through the same firmware is the page tests' (tests/page-debian.test.ts: Chromium only);
// the deterministic EDK2 shell test is `edk2-shell` (tests/boot-node*.test.ts).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fatImage } from '../web/fat.ts';
import type { DeviceSpec } from '../web/devices.ts';
import { Exit, bootVm, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const DISTROS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);
const noEdk2 = !has('edk2/QEMU_EFI.fd') && 'SKIPPED: run images/build.sh edk2';
const CMD = (more = '') => `echo ==begin; cat /sys/class/rtc/rtc0/name; cat /proc/fb; ls -1 /sys/firmware /sys/firmware/qemu_fw_cfg/by_name/opt; nproc; ${more}echo ==end; poweroff`;
// What the card needs from Alpine: nothing. The image brings eth0 up with DHCP by itself, so the guest
// waits (up to 60 s) for the echo gateway's lease, then pings an address the echo backend answers for, over IPv4 and IPv6 (DHCPv6 and a router advertisement).
const NET = `for i in $(seq 60); do ip -4 addr show eth0 | grep -q inet && break; sleep 1; done; ip -4 addr show eth0 | sed -n 's/^ *inet /net: inet /p'; ip -6 addr show eth0 | sed -n 's/^ *inet6 /net: inet6 /p'; ip -4 route | sed -n 's/^default /net: route default /p'; ping -c 3 -W 5 100.64.1.2 >/dev/null && echo net: ping ok; ping -6 -c 3 -W 5 fd7a:115c:a1e0::2 >/dev/null && echo net: ping6 ok; `;
const LIMIT_MS = 240_000;

type Marks = Record<string, number>;
const STAGES: [string, RegExp][] = [
  ['boot manager', /BdsDxe: starting/], ['loader', /GNU GRUB|Limine/i], ['kernel', /Linux version/], ['login prompt', /login: ?$/m], ['power-off', /reboot: Power down/],
];

/**
 * Boots `o` and answers its serial console: Enter at the loader's menu, `root`
 * at the login prompt, then {@link CMD} (with `more`). Returns the console and each stage's
 * time in seconds.
 */
async function drive(o: BootOptions, more = ''): Promise<{ console: string; marks: Marks }> {
  const vm = await bootVm(WASM, { ...o, parallel: true, ncpus: 2, jit: 1, idleLimitMs: 120_000, framebuffer: { width: 640, height: 480 } });
  const t0 = performance.now();
  const marks: Marks = {};
  let all = '', tail = '', menu = false, logged = false, commanded = false;
  const later = (s: string) => setTimeout(() => vm.send(s), 300);
  try {
    for (;;) {
      const r = await vm.runAsync(100_000_000);
      const s = vm.drain();
      all += s;
      // Without escape sequences: Limine draws its menu a character at a time between cursor moves.
      tail = (tail + s).replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').slice(-2000);
      for (const [k, re] of STAGES) if (!(k in marks) && re.test(tail)) marks[k] = (performance.now() - t0) / 1000;
      if (!menu && 'loader' in marks) { menu = true; later('\r'); }
      if (!logged && /login: ?$/.test(tail)) { logged = true; tail = ''; later('root\r'); }
      else if (logged && !commanded && /[#$] ?$/.test(tail)) { commanded = true; later(`${CMD(more)}\r`); }
      if (r.kind === Exit.PSCI) break;
      assert.ok(r.kind !== Exit.UNIMPLEMENTED && r.kind !== Exit.STOP, `exit ${r.kind} at pc 0x${vm.pc().toString(16)}\n${all}`);
      assert.ok(performance.now() - t0 < LIMIT_MS, `still running after ${LIMIT_MS / 1000} s, marks ${JSON.stringify(marks)}\n${all.slice(-3000)}`);
    }
  } finally {
    vm.close();
  }
  console.log(`# ${Object.entries(marks).map(([k, t]) => `${k} ${t.toFixed(1)} s`).join(', ')}`);
  return { console: all.replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').replaceAll('\r', ''), marks };
}

/** What every image must show: the firmware's RTC, the framebuffer, EFI, both vCPUs, a clean power-off. */
function common(r: { console: string; marks: Marks }) {
  assert.ok('power-off' in r.marks, r.console);
  const out = r.console.split('==begin')[2]?.split('==end')[0] ?? assert.fail(r.console);
  assert.match(out, /^rtc-efi /m);
  assert.match(out, /^0 simple/m); // simplefb or simpledrm on the framebuffer above /memory
  assert.match(out, /^efi$/m);
  assert.match(out, /^2$/m);
  return out;
}

const disk = (rel: string, overlay: string): DeviceSpec => ({ type: 'blk', url: new URL(rel, IMAGES).href, overlay });
const firmware = () => readFileSync(new URL('edk2/QEMU_EFI.fd', IMAGES));

// Side by side: they're independent, and one after the other they set the file's (and CI's) time.
describe('Alpine through EDK2', { concurrency: 2 }, () => {
  for (const [name, loader] of [['alpine', 'Limine'], ['alpine-grub', 'GRUB']]) {
    test(`Alpine (${loader}) through EDK2 to a login, unlocked by a seed disk`, {
      skip: noEdk2 || (!DISTROS.includes('alpine-uefi') ? 'SKIPPED: set WEBPC_DISTROS=alpine-uefi' : !has(`alpine-uefi/${name}.qcow2`) && 'SKIPPED: run images/build.sh alpine-uefi'),
    }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'webpc-seed-'));
      try {
        const seed = join(dir, 'seed.img');
        writeFileSync(seed, fatImage('CIDATA', [{ name: 'meta-data', data: 'instance-id: webpc\nlocal-hostname: webpc\n' }, { name: 'user-data', data: '#!/bin/sh\npasswd -d root\n' }]));
        const r = await drive({
          ramSize: 1 << 30, kernel: firmware(), cmdline: '', devices: [disk(`alpine-uefi/${name}.qcow2`, `uefi-test-${name}`), { type: 'blk', url: pathToFileURL(seed).href }, { type: 'rng' }, { type: 'net', adapter: 'echo' }], firmware: {},
        }, NET);
        const out = common(r);
        assert.match(out, /^net: inet 198\.18\.0\.15\//m, out);
        assert.match(out, /^net: ping ok$/m, out);
        assert.match(out, /^net: inet6 fd00:5eb0::f\//m, out);
        assert.match(out, /^net: ping6 ok$/m, out);
        assert.match(out, /^net: route default via /m, out);
        assert.match(r.console, new RegExp(loader === 'GRUB' ? 'GNU GRUB' : 'Limine', 'i'));
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  }
});
