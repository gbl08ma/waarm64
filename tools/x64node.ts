// An x86_64 Node for the dev VM (docs/devenv.md "Dev-only tools"): Node's official linux-x64 build of the version
// running this script, and Debian trixie's amd64 libc6, libstdc++6, libgcc-s1 and libatomic1 as its sysroot, run under
// qemu-user. For V8's x64 machine code of the JIT's modules (bench/jit/codestats.ts): the same V8 as the arm64 Node.
//   node tools/x64node.ts [--force]      -> target/x64node/{node-v<ver>-linux-x64,sysroot}; prints the command line
//   qemu-x86_64 -L target/x64node/sysroot target/x64node/node-v<ver>-linux-x64/bin/node <args>
// Each download is checked before use: Node's tarball against nodejs.org's SHASUMS256.txt, each .deb against the SHA256
// of trixie's Packages index (whose own signature isn't checked). Needs `xz`, `ar` and `tar` on the host.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
const ROOT = new URL('../target/x64node/', import.meta.url).pathname;
const VERSION = process.version; // v26.7.0
const NODE = `node-${VERSION}-linux-x64`;
const DEBIAN = 'https://deb.debian.org/debian';
const PACKAGES = ['libc6', 'libstdc++6', 'libgcc-s1', 'libatomic1'];
const sysroot = `${ROOT}sysroot`;
const node = `${ROOT}${NODE}/bin/node`;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function get(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return new Uint8Array(await r.arrayBuffer());
}
function checked(what: string, b: Uint8Array, want: string | undefined) {
  if (!want) throw new Error(`${what}: no checksum to check it against`);
  const got = sha256(b);
  if (got !== want) throw new Error(`${what}: SHA256 ${got}, expected ${want}`);
}

if (existsSync(node) && existsSync(`${sysroot}/lib64`) && !a.force) {
  console.log(`already there (--force fetches again):\n  qemu-x86_64 -L ${sysroot} ${node}`);
  process.exit(0);
}
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}debs`, { recursive: true });

// Node, against its SHASUMS256.txt.
const dist = `https://nodejs.org/dist/${VERSION}`;
const sums = new TextDecoder().decode(await get(`${dist}/SHASUMS256.txt`));
const tarball = `${NODE}.tar.xz`;
const tb = await get(`${dist}/${tarball}`);
checked(tarball, tb, sums.match(new RegExp(`^([0-9a-f]{64})  ${tarball.replace(/\./g, '\\.')}$`, 'm'))?.[1]);
writeFileSync(`${ROOT}${tarball}`, tb);
execFileSync('tar', ['-xJf', `${ROOT}${tarball}`, '-C', ROOT]);
rmSync(`${ROOT}${tarball}`);
console.log(`${NODE}: checked against SHASUMS256.txt`);

// The libraries, against trixie's Packages index.
const index = execFileSync('xz', ['-dc'], { input: await get(`${DEBIAN}/dists/trixie/main/binary-amd64/Packages.xz`), maxBuffer: 1 << 30 }).toString();
const stanzas = new Map<string, Record<string, string>>();
for (const s of index.split('\n\n')) {
  const f = Object.fromEntries(s.split('\n').filter((l) => /^[A-Za-z0-9-]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  if (PACKAGES.includes(f.Package)) stanzas.set(f.Package, f);
}
mkdirSync(sysroot, { recursive: true });
for (const p of PACKAGES) {
  const f = stanzas.get(p);
  if (!f) throw new Error(`${p}: not in trixie's Packages index`);
  const deb = await get(`${DEBIAN}/${f.Filename}`);
  checked(f.Filename, deb, f.SHA256);
  const dir = `${ROOT}debs/${p}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/p.deb`, deb);
  execFileSync('ar', ['x', 'p.deb'], { cwd: dir });
  const data = readdirSync(dir).find((n) => n.startsWith('data.tar'));
  if (!data) throw new Error(`${f.Filename}: no data.tar.*`);
  execFileSync('tar', ['-xf', `${dir}/${data}`, '-C', sysroot]);
  console.log(`${p} ${f.Version}: checked against the Packages index`);
}
rmSync(`${ROOT}debs`, { recursive: true });
// Debian's merged /usr: the dynamic linker is asked for as /lib64/ld-linux-x86-64.so.2, its libraries in /lib/….
for (const l of ['lib', 'lib64']) if (!existsSync(`${sysroot}/${l}`)) symlinkSync(`usr/${l}`, `${sysroot}/${l}`);
const v = execFileSync('qemu-x86_64', ['-L', sysroot, node, '-p', 'process.arch + " " + process.version + " V8 " + process.versions.v8']).toString().trim();
console.log(`${v}\n  qemu-x86_64 -L ${sysroot} ${node}`);
