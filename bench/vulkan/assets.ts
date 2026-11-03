// VK0's scene assets (bench/vulkan/REPORT.md): the WebGL Aquarium's models and textures (WebGLSamples, BSD-3-Clause,
// THIRD_PARTY.json), fetched at a pinned commit and converted into one binary pack that every arm reads: the native
// Vulkan scene, the GLES port, the WebGPU pages. Textures are decoded by a headless Chromium (WebGL, no colour or alpha
// conversion), stored as RGBA8 with their mip chains (a 2x2 box filter, as GL's generateMipmap does), in GL's memory
// order: the scene's textures flipped as the Aquarium uploads them (UNPACK_FLIP_Y), the rest not.
//   node bench/vulkan/assets.ts [out.pack]     -> target/vulkan/aquarium.pack (the source in target/vulkan/aquarium-src)
// CHROMIUM picks the browser (default /usr/bin/chromium); AQUARIUM_SRC an existing checkout of the repository.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const AQUARIUM_REPO = 'https://github.com/WebGLSamples/WebGLSamples.github.io.git';
export const AQUARIUM_COMMIT = '4c87dfea3cff6bf9f351c5ed4a191f86ceed8bbc';

// The scenes, in the order the pack lists them (the Aquarium's g_sceneInfo, aquarium.js).
export const SCENES = [
  'SmallFishA', 'MediumFishA', 'MediumFishB', 'BigFishA', 'BigFishB', 'Arch', 'Coral', 'CoralStoneA', 'CoralStoneB',
  'EnvironmentBox', 'FloorBase_Baked', 'FloorCenter', 'GlobeBase', 'GlobeInner', 'GlobeOuter', 'RockA', 'RockB',
  'RockC', 'RuinColumn', 'Skybox', 'Stone', 'Stones', 'SunknShip', 'SunknSub', 'SupportBeams', 'SeaweedA', 'SeaweedB',
  'TreasureChest',
];
const SKYBOX = ['positive_x', 'negative_x', 'positive_y', 'negative_y', 'positive_z', 'negative_z'].map((f) => `assets/GlobeOuter_EM_${f}.jpg`);
const EXTRA = [ // [name in the pack, file, flipped]
  ['bubble', 'static_assets/bubble.png', false],
  ['lightray', 'assets/LightRay.png', false],
  ['beam', 'static_assets/beam.png', false],
] as const;

function fetchSource(dir: string) {
  if (existsSync(join(dir, 'aquarium/assets/PropPlacement.js'))) return;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  git('init', '-q');
  git('remote', 'add', 'origin', AQUARIUM_REPO);
  git('config', 'core.sparseCheckout', 'true');
  writeFileSync(join(dir, '.git/info/sparse-checkout'), 'LICENSE.md\naquarium/assets/\naquarium/static_assets/\n');
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', AQUARIUM_COMMIT);
  git('checkout', '-q', 'FETCH_HEAD');
}

type Image = { width: number; height: number; rgba: Uint8Array };

/** Decodes every file with Chromium's decoders into RGBA8 as WebGL uploads it (no premultiplication, no colour conversion). */
async function decodeAll(files: { path: string; flip: boolean }[]): Promise<Image[]> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas></canvas>');
    const out: Image[] = [];
    for (const f of files) {
      const b64 = readFileSync(f.path).toString('base64');
      const type = f.path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const r = await page.evaluate(async ({ b64, type, flip }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: flip ? 'flipY' : 'from-image' });
        const gl = document.querySelector('canvas')!.getContext('webgl2')!;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const px = new Uint8Array(bmp.width * bmp.height * 4);
        gl.readPixels(0, 0, bmp.width, bmp.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(tex);
        let s = '';
        for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
        return { width: bmp.width, height: bmp.height, b64: btoa(s) };
      }, { b64, type, flip: f.flip });
      out.push({ width: r.width, height: r.height, rgba: new Uint8Array(Buffer.from(r.b64, 'base64')) });
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** The mip chain of one image, level 0 first: each level a 2x2 box filter of the one above (an odd edge clamps). */
function mips(img: Image): Image[] {
  const levels = [img];
  let cur = img;
  while (cur.width > 1 || cur.height > 1) {
    const w = Math.max(1, cur.width >> 1), h = Math.max(1, cur.height >> 1);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(cur.width - 1, x * 2), x1 = Math.min(cur.width - 1, x * 2 + 1);
        const y0 = Math.min(cur.height - 1, y * 2), y1 = Math.min(cur.height - 1, y * 2 + 1);
        for (let c = 0; c < 4; c++) {
          const s = cur.rgba[(y0 * cur.width + x0) * 4 + c] + cur.rgba[(y0 * cur.width + x1) * 4 + c] +
            cur.rgba[(y1 * cur.width + x0) * 4 + c] + cur.rgba[(y1 * cur.width + x1) * 4 + c];
          rgba[(y * w + x) * 4 + c] = (s + 2) >> 2;
        }
      }
    }
    cur = { width: w, height: h, rgba };
    levels.push(cur);
  }
  return levels;
}

// The pack (little-endian; scene/pack.h reads it):
//   header   32 bytes: "AQP1", version 1, textures, scenes, models, props, 2 reserved
//   texture  64 bytes: name[32], width, height, layers (1 or 6: a cube, +x -x +y -y +z -z), mips, u64 offset, u64 size;
//                      the data level by level, each level's layers in order, RGBA8 rows
//   scene    48 bytes: name[32], first model, model count, 2 reserved
//   model    64 bytes: scene, vertices, indices, diffuse, normal map, reflection map (0xffffffff: none),
//                      u64 vertex offset, u64 index offset, min[3], max[3] (f32);
//                      vertices 14 f32 each (position 3, normal 3, texCoord 2, tangent 3, binormal 3), indices u16
//   prop     68 bytes: scene, world[16] (f32, column-major as GL's)
const NONE = 0xffffffff;

async function main() {
  const out = process.argv[2] ?? join(ROOT, 'target/vulkan/aquarium.pack');
  const src = process.env.AQUARIUM_SRC ?? join(ROOT, 'target/vulkan/aquarium-src');
  fetchSource(src);
  const A = join(src, 'aquarium');

  type Model = { scene: number; vertices: Float32Array; indices: Uint16Array; tex: number[]; min: number[]; max: number[] };
  const texFiles: { name: string; files: string[]; flip: boolean }[] = [];
  const texIndex = new Map<string, number>();
  const texture = (name: string, files: string[], flip: boolean) => {
    if (!texIndex.has(name)) { texIndex.set(name, texFiles.length); texFiles.push({ name, files, flip }); }
    return texIndex.get(name)!;
  };
  texture('skybox', SKYBOX, false);
  for (const [name, file, flip] of EXTRA) texture(name, [file], flip);

  const models: Model[] = [];
  const scenes: { name: string; first: number; count: number }[] = [];
  for (const [si, name] of SCENES.entries()) {
    const json = JSON.parse(readFileSync(join(A, 'assets', `${name}.js`), 'utf8')) as { models: { textures: Record<string, string>; fields: Record<string, { numComponents: number; data: number[] }> }[] };
    scenes.push({ name, first: models.length, count: json.models.length });
    for (const m of json.models) {
      const f = m.fields;
      const n = f.position.data.length / 3;
      const v = new Float32Array(n * 14);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        const put = (field: string, comps: number, at: number) => {
          for (let c = 0; c < comps; c++) v[i * 14 + at + c] = f[field]?.data[i * comps + c] ?? 0;
        };
        put('position', 3, 0); put('normal', 3, 3); put('texCoord', 2, 6); put('tangent', 3, 8); put('binormal', 3, 11);
        for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], v[i * 14 + c]); max[c] = Math.max(max[c], v[i * 14 + c]); }
      }
      const tex = ['diffuse', 'normalMap', 'reflectionMap'].map((k) => m.textures[k] ? texture(m.textures[k], [`assets/${m.textures[k]}`], true) : NONE);
      models.push({ scene: si, vertices: v, indices: Uint16Array.from(f.indices.data), tex, min, max });
    }
  }
  const placement = JSON.parse(readFileSync(join(A, 'assets/PropPlacement.js'), 'utf8')) as { objects: { name: string; worldMatrix: number[] }[] };
  const props = placement.objects.map((o) => {
    const scene = SCENES.indexOf(o.name);
    if (scene < 0) throw new Error(`placement names an unknown scene ${o.name}`);
    return { scene, world: o.worldMatrix };
  });

  const flat = texFiles.flatMap((t) => t.files.map((path) => ({ path: join(A, path), flip: t.flip })));
  const images = await decodeAll(flat);
  let k = 0;
  const textures = texFiles.map((t) => {
    const layers = t.files.map(() => mips(images[k++]));
    if (layers.some((l) => l[0].width !== layers[0][0].width || l[0].height !== layers[0][0].height)) throw new Error(`${t.name}: layers differ in size`);
    return { name: t.name, width: layers[0][0].width, height: layers[0][0].height, layers };
  });

  // Lay the file out.
  const align = (n: number) => (n + 15) & ~15;
  let at = align(32 + textures.length * 64 + scenes.length * 48 + models.length * 64 + props.length * 68);
  const texAt = textures.map((t) => {
    const size = t.layers[0].reduce((s, l) => s + l.rgba.length, 0) * t.layers.length;
    const o = at; at = align(at + size); return { o, size };
  });
  const modelAt = models.map((m) => {
    const vo = at; at = align(at + m.vertices.byteLength);
    const io = at; at = align(at + m.indices.byteLength);
    return { vo, io };
  });
  const buf = Buffer.alloc(at);
  let p = 0;
  const u32 = (x: number) => { buf.writeUInt32LE(x >>> 0, p); p += 4; };
  const u64 = (x: number) => { buf.writeBigUInt64LE(BigInt(x), p); p += 8; };
  const f32 = (x: number) => { buf.writeFloatLE(x, p); p += 4; };
  const name32 = (s: string) => { if (s.length > 31) throw new Error(`name too long: ${s}`); buf.write(s, p, 'latin1'); p += 32; };
  buf.write('AQP1', 0, 'latin1'); p = 4;
  u32(1); u32(textures.length); u32(scenes.length); u32(models.length); u32(props.length); u32(0); u32(0);
  for (const [i, t] of textures.entries()) { name32(t.name); u32(t.width); u32(t.height); u32(t.layers.length); u32(t.layers[0].length); u64(texAt[i].o); u64(texAt[i].size); }
  for (const s of scenes) { name32(s.name); u32(s.first); u32(s.count); u32(0); u32(0); }
  for (const [i, m] of models.entries()) {
    u32(m.scene); u32(m.vertices.length / 14); u32(m.indices.length); for (const t of m.tex) u32(t);
    u64(modelAt[i].vo); u64(modelAt[i].io); for (const x of [...m.min, ...m.max]) f32(x);
  }
  for (const pr of props) { u32(pr.scene); for (const x of pr.world) f32(x); }
  for (const [i, t] of textures.entries()) {
    let o = texAt[i].o;
    for (let level = 0; level < t.layers[0].length; level++) {
      for (const layer of t.layers) { buf.set(layer[level].rgba, o); o += layer[level].rgba.length; }
    }
  }
  for (const [i, m] of models.entries()) {
    buf.set(new Uint8Array(m.vertices.buffer), modelAt[i].vo);
    buf.set(new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), modelAt[i].io);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log(`${out}: ${textures.length} textures, ${scenes.length} scenes, ${models.length} models, ${props.length} props, ${(buf.length / 1048576).toFixed(1)} MiB`);
}

if (import.meta.main) await main();
