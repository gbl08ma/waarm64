// The UEFI oracle (M8 phase B, docs/plans/uefi.md): boots an unmodified disk
// image through our EDK2 build (images/build.sh edk2) on qemu-system-aarch64,
// set up like our machine: ArmVirtQemuKernel entered like a kernel with the DT
// in x0 (QEMU's virt DT without PCIe and the platform bus), a variable store in
// the second flash bank, virtio-mmio disks, a Cortex-A57 (ARMv8.0, no RNDR or
// PAuth, like our CPU). It answers the serial console: presses Enter at the
// loader's menu, logs in as root, runs a command, and expects a power-off.
// Prints each stage's time and writes the console log.
//   node tools/uefi-oracle.ts [options] <debian|alpine|alpine-grub|path.qcow2>...
//     --acpi         QEMU's ACPI tables instead of the DT (fw_cfg's table-loader)
//     --no-fw-cfg    drop fw_cfg from the DT (then no credentials; stock ArmVirtQemu couldn't boot)
//     --no-creds     no systemd credentials (Debian stops at systemd-firstboot)
//     --no-seed      no NoCloud seed disk (Alpine's root stays locked)
//     --menu-wait    let the loader's menu time out instead of pressing Enter
//     --cmd '<sh>'   what to run after logging in (default: a summary, then poweroff)
//     --smp N --mem MiB --timeout s
// Debian's image is target/images/debian/disk.qcow2 (images/build.sh debian);
// Alpine's are downloaded into target/images/dl (images/alpine-uefi.json).
// Credentials go to Debian through fw_cfg (opt/io.systemd.credentials/*: no
// firstboot prompts, root without a password, as the page's command line does
// today); Alpine gets a CIDATA seed disk whose user-data unlocks root (needs
// mkfs.vfat and mcopy). Logs: target/uefi-oracle/<name>.log. Exit code 0 if
// every image logged in and powered off.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { download, ROOT, type Pin } from './debian.ts';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    acpi: { type: 'boolean', default: false },
    'no-fw-cfg': { type: 'boolean', default: false },
    'no-creds': { type: 'boolean', default: false },
    'no-seed': { type: 'boolean', default: false },
    'menu-wait': { type: 'boolean', default: false },
    cmd: { type: 'string' },
    smp: { type: 'string', default: '2' },
    mem: { type: 'string', default: '1024' },
    timeout: { type: 'string', default: '300' },
  },
});
if (positionals.length === 0) {
  console.error('usage: node tools/uefi-oracle.ts [options] <debian|alpine|alpine-grub|path.qcow2>...');
  process.exit(2);
}

const OUT = join(ROOT, 'target/uefi-oracle');
const FIRMWARE = join(ROOT, 'target/images/edk2/QEMU_EFI.fd');
const CMD = opt.cmd ?? 'echo ==begin; cat /proc/cmdline; ls /sys/firmware; nproc; cat /sys/class/rtc/rtc0/name; ' +
  'dmesg | grep -E "Machine model|psci: probing|smp: Brought|console \\[" | cut -c1-120; echo ==end; poweroff';
const QEMU = ['qemu-system-aarch64', '-M', `virt,gic-version=3,acpi=${opt.acpi ? 'on' : 'off'}`, '-cpu', 'cortex-a57',
  '-smp', opt.smp, '-m', opt.mem, '-nographic', '-nodefaults', '-serial', 'stdio'];
const ALPINE = JSON.parse(await readFile(join(ROOT, 'images/alpine-uefi.json'), 'utf8')) as { images: Record<string, Pin & { loader: string }> };
const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

/** QEMU's virt DT for this machine, without the nodes our machine doesn't have. */
async function deviceTree(dir: string) {
  const dtb = join(dir, 'qemu.dtb');
  run(QEMU[0], [...QEMU.slice(1), '-M', `virt,dumpdtb=${dtb}`]);
  let dts = run('dtc', ['-q', '-I', 'dtb', '-O', 'dts', dtb]);
  const drop = (name: string, indent = '\t') => {
    const i = dts.indexOf(`\n${indent}${name} {`) + 1;
    if (i === 0) return;
    let depth = 0, j = i;
    for (; ; j++) {
      if (dts[j] === '{') depth++;
      else if (dts[j] === '}' && --depth === 0) break;
    }
    dts = dts.slice(0, i) + dts.slice(j + 3); // past "};\n"
  };
  // None of these are on our machine. (With acpi=off QEMU adds a PL061 GPIO and a gpio-keys power
  // button: probing them cost the Debian boot seconds, loop 1.)
  for (const n of ['pcie@10000000', 'platform-bus@c000000', 'pmu', 'gpio-keys', 'pl061@9030000']) drop(n);
  drop('its@8080000', '\t\t'); // the GIC's ITS
  dts = dts.replace(/^\t\t(kaslr-seed|rng-seed) = .*\n/gm, ''); // our DT has no seeds (backlog)
  if (opt['no-fw-cfg']) drop('fw-cfg@9020000');
  const out = join(dir, 'webpc.dtb');
  run('dtc', ['-q', '-I', 'dts', '-O', 'dtb', '-o', out], dts);
  return out;
}

/** A 2 MiB FAT disk labelled CIDATA: tiny-cloud's (and cloud-init's) NoCloud seed. */
async function seedDisk(dir: string) {
  const img = join(dir, 'seed.img');
  await writeFile(join(dir, 'meta-data'), 'instance-id: webpc-oracle\nlocal-hostname: webpc\n');
  await writeFile(join(dir, 'user-data'), '#!/bin/sh\npasswd -d root\n');
  await writeFile(img, new Uint8Array(2 << 20));
  run('mkfs.vfat', ['-n', 'CIDATA', img]);
  run('mcopy', ['-i', img, join(dir, 'meta-data'), join(dir, 'user-data'), '::']);
  return img;
}

type Result = { name: string; ok: boolean; marks: Record<string, number>; log: string };

async function boot(what: string): Promise<Result> {
  const alpine = ALPINE.images[what];
  const name = alpine || what === 'debian' ? what : basename(what).replace(/\.qcow2$/, '');
  const base = what === 'debian' ? join(ROOT, 'target/images/debian/disk.qcow2')
    : alpine ? await download({ ...alpine, label: `Alpine (${alpine.loader})`, pinFile: 'images/alpine-uefi.json' }) : what;
  if (!existsSync(base)) throw new Error(`${base}: not there (images/build.sh debian?)`);
  const dir = join(OUT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const disk = join(dir, 'disk.qcow2');
  run('qemu-img', ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base, disk]);
  // An erased (all-ones) bank: the firmware formats its variable store on the first boot.
  const vars = join(dir, 'vars.bin');
  await writeFile(vars, new Uint8Array(64 << 20).fill(0xff));
  const args = [...QEMU.slice(1), '-kernel', FIRMWARE, '-dtb', await deviceTree(dir),
    '-drive', `if=pflash,format=raw,unit=1,file=${vars}`,
    '-drive', `if=none,id=d0,file=${disk}`, '-device', 'virtio-blk-device,drive=d0'];
  if (what === 'debian' && !opt['no-creds'] && !opt['no-fw-cfg']) {
    const empty = join(dir, 'empty');
    await writeFile(empty, '');
    const c = 'opt/io.systemd.credentials';
    args.push('-fw_cfg', `name=${c}/login.noauth,string=yes`, '-fw_cfg', `name=${c}/firstboot.timezone,string=UTC`,
      '-fw_cfg', `name=${c}/firstboot.locale,string=C.UTF-8`, '-fw_cfg', `name=${c}/passwd.hashed-password.root,file=${empty}`);
  }
  if (alpine && !opt['no-seed']) {
    args.push('-drive', `if=none,id=s0,format=raw,readonly=on,file=${await seedDisk(dir)}`, '-device', 'virtio-blk-device,drive=s0');
  }

  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0) / 1000;
  const marks: Record<string, number> = {};
  const stages: [string, RegExp][] = [
    ['firmware', /UEFI firmware/], ['boot manager', /BdsDxe: starting/], ['loader', /GNU GRUB|Limine/i],
    ['kernel', /Linux version/], ['init', /Run \/init|Freeing unused kernel/], ['login prompt', /login: ?$/m], ['power-off', /reboot: Power down/],
  ];
  const q = spawn(QEMU[0], args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let all = '', tail = '', logged = false, menu = false;
  const send = (s: string) => setTimeout(() => q.stdin.write(s), 300);
  const onData = (b: Buffer) => {
    const s = b.toString('latin1');
    all += s;
    // Without escape sequences: Limine draws its menu a character at a time between cursor moves.
    tail = (tail + s).replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').slice(-2000);
    for (const [k, re] of stages) if (!(k in marks) && re.test(tail)) marks[k] = now();
    if (!menu && !opt['menu-wait'] && 'loader' in marks) { menu = true; send('\r'); }
    if (/Press any key to proceed/.test(tail)) { tail = ''; send('\r'); } // systemd-firstboot, with --no-creds
    if (!logged && /login: ?$/.test(tail)) { logged = true; tail = ''; send('root\r'); }
    else if (logged && !('command' in marks) && /[#$] ?$/.test(tail)) { marks.command = now(); send(CMD + '\r'); }
  };
  q.stdout.on('data', onData);
  q.stderr.on('data', onData);
  const timer = setTimeout(() => q.kill(), Number(opt.timeout) * 1000);
  await new Promise((r) => q.on('close', r));
  clearTimeout(timer);
  const log = join(OUT, `${name}.log`);
  await writeFile(log, all);
  return { name, ok: 'power-off' in marks && 'command' in marks, marks, log };
}

await mkdir(OUT, { recursive: true });
if (!existsSync(FIRMWARE)) throw new Error(`${FIRMWARE}: not there (images/build.sh edk2)`);
// The images boot at once (a TCG boot takes ~40 s on 2 vCPUs, mostly one host thread each).
const results = await Promise.all(positionals.map(boot));
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${Object.entries(r.marks).map(([k, t]) => `${k} ${t.toFixed(1)} s`).join(', ')}`);
  const out = (await readFile(r.log, 'latin1')).split('==begin')[2]?.split('==end')[0];
  if (out && !opt.cmd) console.log(out.replace(/\r/g, '').trim().replace(/^/gm, '     '));
  if (!r.ok) console.log(`     log: ${r.log}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
