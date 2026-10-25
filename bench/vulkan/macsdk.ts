// The parts of LunarG's Vulkan SDK for macOS that VK0's Mac arm needs (bench/vulkan/mac.sh), unpacked in the dev VM so
// nothing is installed on the Mac: the loader, KosmicKrisp (Mesa's Vulkan on Metal) and MoltenVK with their ICD files,
// the headers, glslc, the validation and GFXReconstruct layers, and GFXReconstruct's tools. The SDK ships as a Qt
// installer whose payload (installer.dat) holds 7z archives; they are carved out by their signature and the files
// taken from the "vulkan" one with 7z (7zip from zypper).
//   node bench/vulkan/macsdk.ts      -> target/vulkan/macsdk/ (bin, include, lib, share), the download cached beside it
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SDK_VERSION = '1.4.363.0';
const OUT = join(ROOT, 'target/vulkan/macsdk');
const CACHE = join(ROOT, 'target/vulkan/download');
const WANT = [
  'macOS/lib/libvulkan.1.4.363.dylib', 'macOS/lib/libvulkan.1.dylib', 'macOS/lib/libvulkan.dylib',
  'macOS/lib/libvulkan_kosmickrisp.dylib', 'macOS/lib/libMoltenVK.dylib',
  'macOS/lib/libVkLayer_khronos_validation.dylib', 'macOS/lib/libVkLayer_gfxreconstruct.dylib',
  'macOS/share/vulkan/icd.d/libkosmickrisp_icd.json', 'macOS/share/vulkan/icd.d/MoltenVK_icd.json',
  'macOS/share/vulkan/explicit_layer.d/VkLayer_khronos_validation.json',
  'macOS/share/vulkan/explicit_layer.d/VkLayer_gfxreconstruct.json',
  'macOS/include/vulkan', 'macOS/include/vk_video',
  'macOS/bin/glslc', 'macOS/bin/gfxrecon-convert', 'macOS/bin/gfxrecon-info', 'macOS/bin/gfxrecon-replay',
];

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

/** The 7z archives inside a Qt installer's payload: each from its signature to the end its header gives. */
export function carve7z(dat: Buffer): Buffer[] {
  const sig = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  const out: Buffer[] = [];
  for (let at = dat.indexOf(sig); at >= 0; at = dat.indexOf(sig, at + 1)) {
    const end = at + 32 + Number(dat.readBigUInt64LE(at + 12)) + Number(dat.readBigUInt64LE(at + 20));
    if (end > dat.length) continue;
    out.push(dat.subarray(at, end));
    at = end - 1;
  }
  return out;
}

if (import.meta.main) {
  if (existsSync(join(OUT, 'lib/libvulkan_kosmickrisp.dylib'))) {
    console.log(`${OUT}: already there`);
    process.exit(0);
  }
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, `vulkansdk-macos-${SDK_VERSION}.zip`);
  if (!existsSync(zip)) run('curl', ['-sSfLo', zip, `https://sdk.lunarg.com/sdk/download/${SDK_VERSION}/mac/vulkansdk-macos-${SDK_VERSION}.zip`]);
  const work = join(CACHE, 'macsdk-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  run('7z', ['x', '-y', `-o${work}`, zip, `vulkansdk-macOS-${SDK_VERSION}.app/Contents/Resources/installer.dat`]);
  const dat = readFileSync(join(work, `vulkansdk-macOS-${SDK_VERSION}.app/Contents/Resources/installer.dat`));
  const archives = carve7z(dat);
  const vulkan = archives.reduce((a, b) => (b.length > a.length ? b : a));  // the SDK itself; the other is the helpers
  writeFileSync(join(work, 'vulkan.7z'), vulkan);
  run('7z', ['x', '-y', `-o${join(work, 'x')}`, join(work, 'vulkan.7z'), ...WANT]);
  rmSync(OUT, { recursive: true, force: true });
  renameSync(join(work, 'x/macOS'), OUT);
  rmSync(work, { recursive: true, force: true });
  console.log(`${OUT}: the macOS SDK ${SDK_VERSION}'s loader, KosmicKrisp, MoltenVK, layers and tools`);
}
