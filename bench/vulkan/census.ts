// VK4 T1's census of dEQP-VK (bench/vulkan/REPORT.md "VK4 T1"): every case that didn't pass in bench/gpu/deqp-run.ts's
// results (a sample of the mustpass list, run with DETAIL for dEQP's messages) classed by cause, the causes those of
// the Vulkan issues (https://github.com/gbl08ma/waarm64/issues?q=is%3Aissue+state%3Aopen+label%3Avulkan) (and the VK4 task that takes each), counted per host; the first rule
// that matches a case's name (and, where given, its messages) wins, so the rules go from the most specific.
//   node bench/vulkan/census.ts <host>=<dir of deqp-run.ts's results.json files (any *.json), searched recursively>... [--cases <cause>] [--json <out>]
// T1's: node bench/vulkan/census.ts swiftshader=bench/vulkan/results/vk4/t1/swiftshader m4=bench/vulkan/results/vk4/t1/m4
// --cases prints the cases (and their first messages) of one cause ("other": those no rule takes). --reasons [n] prints
// the n commonest reasons dEQP gave for NotSupported (runs with DETAIL_NOTSUPPORTED=1; VK4's census of 2026-11-05),
// per host, the format ones merged and split again by what dEQP asked of the format.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A cause: its rule, its issue's subject and the VK4 task. `tier` ranks by consequence (kickoff "How the tasks are
 * ranked"): 1 a crash or a lost device, 2 work dropped (WebGPU refuses it), 3 wrong results. */
interface Cause { id: string; what: string; task: string; tier: 1 | 2 | 3; name?: RegExp; detail?: RegExp; status?: RegExp; test?: (n: string) => boolean }

const INT = /(_uint|_sint)(_pack32)?\b|\.([iu])sampler|\b[iu]vec|\bu?int\b/;
const COMPRESSED = /(astc|etc2|eac|bc[1-7])_/;
/** image_to_image's `<dims>.<src format>.<dst format>.` with two formats: Vulkan's size-compatible copies. */
const twoFormats = (n: string) => {
  const m = /image_to_image\.(?:.*\.)?(?:color\.[0-9a-z_]+|dimensions\.[0-9a-z_]+)\.([0-9a-z_]+)\.([0-9a-z_]+)\.(?:general|optimal)/.exec(n);
  return !!m && m[1] !== m[2];
};

const CAUSES: Cause[] = [
  { id: 'crash', what: 'deqp-vk crashed or hung (a lost device)', task: 'T2', tier: 1, status: /^(Crash|Timeout|InternalError|ResourceError)$/ },
  { id: 'feedback-loop', what: 'an attachment also read as an input attachment with a self-dependency (a feedback loop WebGPU refuses)', task: 'T12', tier: 2, name: /\.self_dep/ },
  { id: 'copy-formats', what: 'copies between formats (size-compatible, compressed ↔ uncompressed)', task: 'T10', tier: 2, test: (n) => twoFormats(n) || /diff_format/.test(n) },
  { id: 'copy-ms', what: 'copies of multisampled images', task: 'T10', tier: 2, name: /msaa_copy|multisample.*copy/ },
  { id: 'vertex-offset', what: 'vertex attribute offsets and strides that aren\'t multiples of 4 (the pipeline refused)', task: 'T5', tier: 2, name: /input_attribute_offset\.|vertex_input\.multiple_attributes\.|vertex_input\..*(stride|offset)_[0-9]*[13579]\b/ },
  { id: 'format-refused', what: 'a format advertised for the use but refused at image creation (`VK_ERROR_FORMAT_NOT_SUPPORTED`)', task: 'T12', tier: 2, detail: /VK_ERROR_FORMAT_NOT_SUPPORTED/ },
  { id: 'resolve-int', what: 'integer resolves', task: 'T10', tier: 2, name: /resolve.*(sint|uint)|(sint|uint).*resolve/ },
  { id: 'swizzle', what: 'component swizzles (image views\' component mapping)', task: 'T8', tier: 3, name: /component_swizzle\.(?!r_g_b_a$)|swizzle\.component_mapping\.(?!.*_rgba$)/ },
  { id: 'tex-offset', what: 'texture offsets that aren\'t constants after optimization (the stage refused)', task: 'T9', tier: 2, name: /glsl\.texture_functions\.[a-z]*offset\./ },
  { id: 'unnormalized', what: 'unnormalized coordinates', task: 'T8', tier: 3, name: /_unnormalized\./ },
  { id: 'border', what: 'border colours', task: 'T8', tier: 3, name: /clamp_to_border|border_color/ },
  { id: 'mirror-once', what: 'mirror-once (mirror clamp to edge)', task: 'T8', tier: 3, name: /mirror_clamp_to_edge/ },
  { id: 'query-lod', what: '`textureQueryLod`', task: 'T9', tier: 3, name: /texturequerylod/ },
  { id: 'compressed', what: 'compressed images whose size isn\'t whole blocks (ASTC\'s 5-, 6-, 10- and 12-texel blocks): the texture padded to whole blocks, so coordinates land wrong and cube views of it are refused', task: 'T18', tier: 3, name: COMPRESSED },
  { id: 'int-cube', what: 'integer cube textures sampled with a sampler (the stage refused: "an integer texture sampled with a sampler")', task: 'T8', tier: 2, test: (n) => INT.test(n) && /view_type\.cube|samplercube/.test(n) },
  { id: 'int-sampler', what: 'integer textures sampled with a sampler (address modes, LOD: fetched at clamp-to-edge)', task: 'T8', tier: 3, test: (n) => INT.test(n) && /pipeline\.[a-z_]+\.(sampler|image_view|image)\.|texture_functions|texture\.(filtering|mipmap|swizzle)/.test(n) },
  { id: 'lod', what: 'the sampler\'s LOD bias and min/max LOD', task: 'T8', tier: 3, name: /\.lod\.(select_bias|select_min|select_max|equal_min)|lod_bias|min_lod|max_lod/ },
  { id: 'ms-array', what: 'multisampled images of several layers (WebGPU has no multisampled arrays: the texture refused)', task: 'T12', tier: 2, name: /image_clearing\..*multiple_layers.*sample_count/ },
  { id: 'clear-layers', what: 'clears of several layers or array layers past the first (another layer\'s value, or none)', task: 'T12', tier: 3, name: /image_clearing\..*(multiple_layers|cube_layers|remaining_array_layers|_layers_)/ },
  { id: 'clear-ms', what: 'clears of multisampled integer attachments', task: 'T12', tier: 3, name: /image_clearing\..*sample_count/ },
  { id: 'mipmap-blit', what: 'blits generating mipmaps (on the M4 over 6 layers; 32-bit float linear)', task: 'T12', tier: 3, name: /generate_mipmaps/ },
  { id: 'blit', what: 'other blits (32-bit float and 16-bit unorm filtering, 3D)', task: 'T10', tier: 3, name: /blit_image\./ },
  { id: 'd16', what: 'depth16unorm\'s copies and clears (its half-word texels)', task: 'T10', tier: 3, name: /d16_unorm/ },
  { id: 'ssbo16', what: '16-bit types in storage buffer layouts', task: 'T12', tier: 3, name: /ssbo\..*(16bit|int16|float16)/ },
  { id: 'query', what: 'queries (clears counted, pools side by side)', task: 'T12', tier: 3, name: /query_pool\./ },
  { id: 'blend-constants', what: 'blends with both CONSTANT_COLOR and CONSTANT_ALPHA (WebGPU has one constant)', task: 'T12', tier: 3, test: (n) => /\.blend\./.test(n) && /_(1m)?cc_/.test(n) && /_(1m)?ca_/.test(n) },
  { id: 'clip-frag', what: '`gl_ClipDistance` read in a fragment shader (inputs past the varyings)', task: 'T9', tier: 2, name: /clip_cull_distance.*fragmentshader_read|clip_distance.*fragmentshader_read/ },
  { id: 'push-descriptor', what: 'push descriptors pushed twice for one binding (`numcalls2`)', task: 'T12', tier: 3, name: /push_descriptor\..*numcalls2/ },
  { id: 'descriptorset-random', what: '`descriptorset_random`\'s sets of four (a copy buffer reads zeros)', task: 'T12', tier: 3, name: /descriptorset_random/ },
  { id: 'multisample', what: 'multisampled rendering (several subpasses, sample masks)', task: 'T12', tier: 3, name: /\.multisample\./ },
];

interface Case { host: string; name: string; status: string; detail: string[] }
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const showCases = opt('--cases');
const jsonOut = opt('--json');
const reasonsAt = args.indexOf('--reasons');
const reasonsN = reasonsAt < 0 ? 0 : /^\d+$/.test(args[reasonsAt + 1] ?? '') ? Number(args.splice(reasonsAt, 2)[1]) : (args.splice(reasonsAt, 1), 40);
const hosts = args.map((a) => a.split('='));
const files = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? files(p) : f.endsWith('.json') ? [p] : [];
});

const cases: Case[] = [];
/** NotSupported reasons by host: dEQP's message without its source line, VK_FORMAT_ names as F. */
const reasons: Record<string, Map<string, { n: number; example: string }>> = {};
const totals: Record<string, Record<string, number>> = {};
for (const [host, dir] of hosts) {
  const t: Record<string, number> = (totals[host] = {});
  for (const f of files(dir)) {
    const r = JSON.parse(readFileSync(f, 'utf8')) as { counts: Record<string, number>; notPassed: string[]; detail?: string[] };
    for (const [k, v] of Object.entries(r.counts)) t[k] = (t[k] ?? 0) + v;
    const detail = new Map<string, string[]>();
    let cur: string[] | undefined;
    for (const l of r.detail ?? []) {
      if (l.startsWith('== ')) detail.set(l.slice(3), (cur = []));
      else cur?.push(l);
    }
    const rs = (reasons[host] ??= new Map());
    for (const [name, lines] of detail) {
      const m = lines.map((l) => /StatusCode="NotSupported">(.*)<\/Result>/.exec(l)).find(Boolean);
      if (!m) continue;
      const why = m[1].replace(/ at [\w./]+:\d+$/, '').replace(/VK_FORMAT_\w+/g, 'F').slice(0, 110);
      const e = rs.get(why) ?? { n: 0, example: name };
      e.n++;
      rs.set(why, e);
    }
    for (const np of r.notPassed) {
      const [name, status] = np.split(' ');
      if (status !== 'NotSupported') cases.push({ host, name, status, detail: detail.get(name) ?? [] });
    }
  }
}

const causeOf = (c: Case) => CAUSES.find((k) => (!k.status || k.status.test(c.status)) && (k.status || c.status === 'Fail' || c.status === 'QualityWarning' || c.status === 'CompatibilityWarning')
  && (!k.name || k.name.test(c.name)) && (!k.detail || k.detail.test(c.detail.join('\n'))) && (!k.test || k.test(c.name)))?.id ?? 'other';
const byCause = new Map<string, Case[]>();
for (const c of cases) {
  const id = causeOf(c);
  byCause.set(id, [...(byCause.get(id) ?? []), c]);
}

if (reasonsN) {
  for (const [host, rs] of Object.entries(reasons)) {
    const all = [...rs.values()].reduce((a, e) => a + e.n, 0);
    const formats = [...rs].filter(([w]) => /format/i.test(w)).reduce((a, [, e]) => a + e.n, 0);
    console.log(`${host}: ${all} reasons of ${totals[host].NotSupported ?? 0} NotSupported; ${formats} name a format`);
    for (const [w, e] of [...rs].sort((a, b) => b[1].n - a[1].n).slice(0, reasonsN)) console.log(`${String(e.n).padStart(6)} ${w}   [${e.example.replace('dEQP-VK.', '')}]`);
  }
  process.exit(0);
}
if (showCases) {
  for (const c of byCause.get(showCases) ?? []) console.log(`${c.host} ${c.name} ${c.status}\n    ${c.detail.slice(0, 2).join('\n    ')}`);
  process.exit(0);
}

const names = hosts.map(([h]) => h);
const supported = (h: string) => Object.entries(totals[h]).filter(([k]) => k !== 'NotSupported').reduce((a, [, v]) => a + v, 0);
const count = (id: string, h: string) => (byCause.get(id) ?? []).filter((c) => c.host === h).length;
console.log(`| host | cases | pass | fail | crash | not supported | not passed of supported |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const h of names) {
  const t = totals[h];
  const all = Object.values(t).reduce((a, b) => a + b, 0);
  const np = supported(h) - (t.Pass ?? 0);
  console.log(`| ${h} | ${all} | ${t.Pass ?? 0} | ${t.Fail ?? 0} | ${(t.Crash ?? 0) + (t.Timeout ?? 0)} | ${t.NotSupported ?? 0} | ${np} of ${supported(h)} (${(100 * np / supported(h)).toFixed(1)}%) |`);
}
console.log();
const rows = [...CAUSES, { id: 'other', what: 'not classed (below)', task: '—', tier: 3 as const }]
  .map((k) => ({ ...k, n: names.map((h) => count(k.id, h)) }))
  .filter((r) => r.n.some((x) => x))
  .sort((a, b) => a.tier - b.tier || Math.max(...b.n) - Math.max(...a.n));
console.log(`| cause | tier | ${names.join(' | ')} | task |`);
console.log(`|---|---|${names.map(() => '---').join('|')}|---|`);
for (const r of rows) console.log(`| ${r.what} | ${r.tier} | ${r.n.join(' | ')} | ${r.task} |`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ totals, causes: rows.map(({ id, what, task, tier, n }) => ({ id, what, task, tier, counts: Object.fromEntries(names.map((h, i) => [h, n[i]])) })), cases: Object.fromEntries([...byCause].map(([id, cs]) => [id, cs.map((c) => `${c.host} ${c.name} ${c.status}`)])) }, null, 1));
