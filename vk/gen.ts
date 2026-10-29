// The renderer's wasm build (vk/build.sh): a ninja file, target/vk/wasm.ninja, that compiles Mesa's util and Vulkan
// runtime, virglrenderer's vkr and our own files for wasm32-wasip1 from the native builds' compile_commands.json (their
// generated sources are the same for any target), and links them into target/vk/venus.wasm.
//   node vk/gen.ts <target/vk> <wasi-sdk>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { VENUS_ARENA } from '../web/ram.ts';

const [W, SDK] = process.argv.slice(2).map((p) => resolve(p));
if (!W || !SDK) throw new Error('usage: gen.ts <target/vk> <wasi-sdk>');
const HERE = import.meta.dirname;
const MESA = `${W}/mesa`, VIRGL = `${W}/virglrenderer`;

interface Entry { directory: string; command: string; file: string; output: string }
const commands = (dir: string): Entry[] => JSON.parse(readFileSync(`${dir}/compile_commands.json`, 'utf8'));

// Linux/glibc features meson found natively that WASI hasn't, and flags that make no sense there.
const DROP = new Set([
  '-DMESA_SYSTEM_HAS_KMS_DRM=1', '-DALLOW_KCMP', '-DENABLE_SHADER_CACHE', '-DMAJOR_IN_SYSMACROS', '-DHAS_SCHED_H',
  '-DHAS_SCHED_GETAFFINITY', '-DHAVE_LINUX_FUTEX_H', '-DHAVE_DLFCN_H', '-DHAVE_SYS_SHM_H', '-DHAVE_POLL_H',
  '-DHAVE_SYS_INOTIFY_H', '-DHAVE_LINUX_UDMABUF_H', '-DHAVE_MKOSTEMP', '-DHAVE_MEMFD_CREATE', '-DHAVE_RANDOM_R',
  '-DHAVE_FLOCK', '-DHAVE_GETRANDOM', '-DHAVE_POSIX_FALLOCATE', '-DHAVE_SECURE_GETENV', '-DHAVE_GNU_QSORT_R',
  '-DHAVE_PROGRAM_INVOCATION_NAME', '-DHAVE_DLADDR', '-DHAVE_DL_ITERATE_PHDR', '-DHAVE_ZLIB', '-DHAVE_ZSTD',
  '-DHAVE_COMPRESSION', '-DHAVE_PTHREAD_SETAFFINITY', '-DHAVE_LIBDRM', '-DHAVE_SPIRV_TOOLS', '-DUSE_LIBELF',
  '-DHAVE_DRI2', '-DHAVE_RENDERDOC_INTEGRATION=1', '-DHAVE___BUILTIN_AARCH64_GET_FPCR',
  '-DHAVE___BUILTIN_AARCH64_SET_FPCR', '-DHAVE_FMEMOPEN', '-DHAVE_STRTOD_L', '-DHAVE_ISSIGNALING', '-flifetime-dse=1',
  '-DBLAKE3_USE_NEON=1', '-DHAVE___BUILTIN_ADD_OVERFLOW_P', '-DHAVE___BUILTIN_SUB_OVERFLOW_P', '-mtls-dialect=desc',
  '-fPIC', '-pthread', '-I/usr/include/libdrm', '-Winvalid-pch', '-fdiagnostics-color=always',
  '-Wno-error=maybe-uninitialized', '-Wno-format-truncation', '-Wno-nonnull-compare', '-Wno-override-init',
  '-Wno-misleading-indentation', '-Wmisleading-indentation', '-Werror=enum-int-mismatch', '-Wpedantic', '-Werror=pedantic',
  '-g',
  // An x86_64 host's (a cloud session's: docs/cloud.md).
  '-mtls-dialect=gnu2', '-DUSE_SSE41', '-DHAVE___BUILTIN_IA32_CLFLUSHOPT', '-DHAVE_CET_H', '-DHAVE_VALGRIND', '-DHAVE_OPENMP',
]);
// Files a renderer in a worker never calls that need what WASI lacks (files, processes, shared memory, dlopen, DRM).
const SKIP = /\/(os_memory_fd|os_socket|u_process|disk_cache|disk_cache_os|xmlconfig|mesa_cache_db|mesa_cache_db_multipart|fossilize_db|u_debug_stack|u_debug_stack_android|u_debug_symbol|os_file_notify|anon_file|u_dl|futex|perf\/.*|ralloc_test|u_sync_provider|blake3_neon|cache_ops_aarch64|os_misc|vk_drm_syncobj|vk_sync_timeline_drm|proxy\/.*)\.c$|_x86-64_unix\.S$/;

const split = (cmd: string): string[] => {
  const args: string[] = [];
  let cur = '', q = false, any = false;
  for (const c of cmd) {
    if (q) { if (c === "'") q = false; else cur += c; continue; }
    if (c === "'") { q = true; any = true; continue; }
    if (c === ' ') { if (cur || any) args.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) args.push(cur);
  return args;
};
const esc = (s: string) => s.replace(/\$/g, '$$$$').replace(/ /g, '$ ').replace(/:/g, '$:');
const shq = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** An entry's flags for wasm: the native ones but the dropped, include paths absolute (then `rewrite`n). */
function flags(e: Entry, rewrite: (inc: string) => string[] = (i) => [i]): string[] {
  const args = split(e.command).slice(1);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-MD') continue;
    if (a === '-MQ' || a === '-MF' || a === '-o' || a === '-c') { i++; continue; }
    if (a === '-imacros') { out.push('-imacros', `${HERE}/wasi/virgl/config.h`); i++; continue; }
    if (/^-O\d$/.test(a) || DROP.has(a)) continue;
    if (a.startsWith('-I')) { for (const r of rewrite(resolve(e.directory, a.slice(2)))) out.push(`-I${r}`); continue; }
    out.push(a);
  }
  return out;
}

// The threads target: a module on a shared memory needs atomics; no thread is ever started (the GPU worker polls).
const TARGET = ['--target=wasm32-wasip1-threads', `--sysroot=${SDK}/share/wasi-sysroot`];
const SHIMS = [`-I${HERE}/wasi/include`, '-include', `${HERE}/wasi/shim.h`, '-DDETECT_OS_POSIX=1', '-D_WASI_EMULATED_MMAN',
  '-D_WASI_EMULATED_PROCESS_CLOCKS', '-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_GETPID'];
const OPT = ['-O2', '-ffunction-sections', '-fdata-sections', '-Wno-unknown-warning-option', '-Wno-unused-command-line-argument',
  '-mllvm', '-wasm-enable-sjlj', '-mllvm', '-wasm-use-legacy-eh=false'];

const lines: string[] = [
  `cc = ${SDK}/bin/clang`, `cxx = ${SDK}/bin/clang++`,
  'rule cc', '  command = $cc $flags -MD -MF $out.d -c $in -o $out', '  depfile = $out.d', '  deps = gcc', '  description = CC $out',
  'rule cxx', '  command = $cxx $flags -MD -MF $out.d -c $in -o $out', '  depfile = $out.d', '  deps = gcc', '  description = CXX $out', '',
];
const objs: string[] = [];
let n = 0;
const compile = (src: string, f: string[]) => {
  const obj = `obj/${n++}-${basename(src)}.o`;
  objs.push(obj);
  lines.push(`build ${esc(obj)}: ${src.endsWith('.cpp') ? 'cxx' : 'cc'} ${esc(src)}`);
  lines.push(`  flags = ${[...TARGET, ...SHIMS, ...f, ...OPT].map(shq).join(' ').replace(/\$/g, '$$$$')}`);
};

// Mesa: util, its C11 threads, BLAKE3, vulkan util and the lite runtime.
const MESA_LIBS = ['src/util/libmesa_util.a', 'src/c11/impl/libmesa_util_c11.a', 'src/util/blake3/libblake3.a',
  'src/vulkan/util/libvulkan_util.a', 'src/vulkan/runtime/libvulkan_lite_runtime.a', 'src/vulkan/runtime/libvulkan_runtime.a',
  'src/vulkan/runtime/libvulkan_instance.a', 'src/compiler/nir/libnir.a', 'src/compiler/spirv/libvtn.a', 'src/compiler/libcompiler.a'];
const mesa = commands(`${W}/build-mesa`);
let runtimeFlags: string[] = [];
let nativeFlags: string[] = [];
for (const e of mesa) {
  const lib = MESA_LIBS.find((l) => e.output.startsWith(`${l}.p/`));
  if (!lib) continue;
  const src = resolve(e.directory, e.file);
  if (SKIP.test(src)) continue;
  const f = flags(e);
  if (lib.endsWith('libvulkan_runtime.a') && !runtimeFlags.length) { runtimeFlags = f; nativeFlags = split(e.command).slice(1); }
  // The pipeline caches look up what they miss in our disk cache (vk/wasi/disk_cache.c: the worker's store).
  compile(src, src.endsWith('/vk_pipeline_cache.c') ? [...f, '-DENABLE_SHADER_CACHE'] : f);
}

// virglrenderer: vkr, the parts of the library it uses and its own copy of Mesa's util (an older subset, whose API
// vkr is written against). The copy's symbols are renamed in every virglrenderer file (a header of `#define`s from the
// native objects' names) so that they never meet Mesa's own util, which the runtime links.
const virgl = commands(`${W}/build-virgl`);
const utilObjs = readdirSync(`${W}/build-virgl/src/mesa/libmesa.a.p`).filter((f) => f.endsWith('.o')).map((f) => `${W}/build-virgl/src/mesa/libmesa.a.p/${f}`);
const names = [...new Set(execFileSync('nm', ['-g', '--defined-only', ...utilObjs]).toString().split('\n')
  .map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 3 && /[TDBR]/.test(p[1])).map((p) => p[2]))].sort();
mkdirSync(`${W}/gen`, { recursive: true });
const PREFIX = `${W}/gen/virgl-util-names.h`;
writeFileSync(PREFIX, `/* vk/gen.ts: virglrenderer's copy of Mesa's util, renamed apart from Mesa's own. */\n#pragma once\n${names.map((n) => `#define ${n} vkr_util_${n}`).join('\n')}\n`);
const toWasmConfig = (inc: string) => inc === `${W}/build-virgl` ? [`${HERE}/wasi/virgl`, inc] : [inc];
let vkrFlags: string[] = [];
for (const e of virgl) {
  if (!e.output.startsWith('src/libvirgl.a.p/') && !e.output.startsWith('src/mesa/libmesa.a.p/')) continue;
  const src = resolve(e.directory, e.file);
  if (SKIP.test(src)) continue;
  const f = [...flags(e, toWasmConfig), '-include', PREFIX];
  if (src.includes('/venus/') && !vkrFlags.length) vkrFlags = f;
  compile(src, f);
}

// Ours: the driver (on the runtime's headers) and the glue (vkr's too). The driver's build ID is a hash of what makes
// its shaders (this directory's sources and patches, and the build script with Mesa's and virglrenderer's versions):
// the shader caches' identity (vk/README.md "The shader cache"), so that a translator change misses every entry.
const hashed = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? hashed(`${dir}/${d.name}`) : /\.(c|h|patch|ts|sh)$/.test(d.name) ? [`${dir}/${d.name}`] : []);
const id = createHash('sha256');
for (const f of hashed(HERE).sort()) id.update(f.slice(HERE.length)).update(readFileSync(f));
const BUILD_ID = id.digest('hex').slice(0, 32);
compile(`${W}/gen/wg_entrypoints.c`, [...runtimeFlags, `-I${W}/gen`]);
for (const f of readdirSync(`${HERE}/driver`).filter((f) => f.endsWith('.c')).sort()) {
  compile(`${HERE}/driver/${f}`, [...runtimeFlags, `-I${W}/gen`, `-I${HERE}/driver`, `-I${HERE}/compiler`, `-DWG_BUILD_ID="${BUILD_ID}"`]);
}
compile(`${HERE}/wasi/disk_cache.c`, [...runtimeFlags, '-DENABLE_SHADER_CACHE']);
for (const f of readdirSync(`${HERE}/compiler`).filter((f) => f.endsWith('.c')).sort()) {
  compile(`${HERE}/compiler/${f}`, [...runtimeFlags, `-I${HERE}/compiler`]);
}
compile(`${HERE}/wasi/os_misc.c`, runtimeFlags);
compile(`${HERE}/wasi/os_misc_virgl.c`, ['-include', PREFIX]);
compile(`${HERE}/wasi/arena.c`, []);
compile(`${HERE}/glue.c`, [...vkrFlags, `-I${HERE}/driver`]);

// The module runs on memory 0 at the arena (vk/README.md): data and stack at its fixed base (memory 0's top less
// web/ram.ts VENUS_ARENA, 0xF010_0000), the heap after them.
const ARENA = 2 ** 32 - VENUS_ARENA;
const EXPORTS = [`${HERE}/glue.c`, `${HERE}/compiler/wgsl_test.c`, `${HERE}/driver/wg_test.c`].flatMap((f) => readFileSync(f, 'utf8').match(/^EXPORT[^(]*\b(\w+)\(/gm)!.map((l) => l.match(/(\w+)\($/)![1]));
const link = `$cxx --target=wasm32-wasip1-threads --sysroot=${SDK}/share/wasi-sysroot -mexec-model=reactor -O2 ` +
  '-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -Wl,--gc-sections ' + (process.env.VK_NAMES ? '' : '-Wl,--strip-all ') +
  `-Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 -Wl,--global-base=${ARENA} -Wl,--no-stack-first -Wl,-z,stack-size=4194304 ` +
  EXPORTS.map((e) => `-Wl,--export=${e}`).join(' ') +
  ' -lsetjmp -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-signal -lwasi-emulated-getpid $in -o $out';
lines.push('', 'rule link', `  command = ${link}`, '  description = LINK $out', '');
lines.push(`build venus.wasm: link ${objs.map(esc).join(' ')}`, 'default venus.wasm', '');
writeFileSync(`${W}/wasm.ninja`, lines.join('\n'));

// The translator natively (target/vk/wgsl: one stage's WGSL, for debugging with ASan; gdb can't run in the dev VM),
// on the native build's own libraries.
const keep = (a: string) => !/^-(o|c|MD|MQ|MF)$/.test(a) && !a.startsWith('-O');
const nflags: string[] = [];
for (let i = 0; i < nativeFlags.length; i++) {
  const a = nativeFlags[i];
  if (a === '-o' || a === '-MQ' || a === '-MF' || a === '-c') { i++; continue; }
  if (!keep(a)) continue;
  nflags.push(a.startsWith('-I') ? `-I${resolve(`${W}/build-mesa`, a.slice(2))}` : a);
}
const nlibs = ['src/vulkan/runtime/libvulkan_runtime.a', 'src/vulkan/util/libvulkan_util.a', 'src/compiler/spirv/libvtn.a', 'src/compiler/nir/libnir.a', 'src/compiler/libcompiler.a', 'src/util/libmesa_util.a',
  'src/c11/impl/libmesa_util_c11.a', 'src/util/blake3/libblake3.a'].map((l) => `${W}/build-mesa/${l}`);
writeFileSync(`${W}/native.ninja`, [
  'rule cc', `  command = cc ${nflags.map(shq).join(' ').replace(/\$/g, '$$$$')} -I${HERE}/compiler -O1 -g -fsanitize=address -fno-omit-frame-pointer $in ${nlibs.join(' ')} -lSPIRV-Tools -lzstd -lz -ldl -lstdc++ -lm -lpthread -o $out`,
  `build wgsl: cc ${readdirSync(`${HERE}/compiler`).filter((f) => f.endsWith('.c')).sort().map((f) => esc(`${HERE}/compiler/${f}`)).join(' ')}`, '',
].join('\n'));
console.log(`target/vk/wasm.ninja: ${objs.length} objects -> venus.wasm`);
