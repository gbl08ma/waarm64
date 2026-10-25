// VK1 step 1 (bench/vulkan/REPORT.md "VK1"): a ninja file that builds Mesa's NIR, spirv_to_nir (vtn), util and
// KosmicKrisp's NIR → MSL compiler for wasm, from the native Mesa build's compile_commands.json (its generated
// sources are the same for any target). build.sh runs it; nothing here reaches the page.
//   node bench/vulkan/nir/gen.ts <native build dir> <out dir> <toolchain: wasi|emscripten|native> <toolchain root>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

const [nativeDir, outDir, toolchain, tcRoot] = process.argv.slice(2);
if (!nativeDir || !outDir || !toolchain) {
  console.error('usage: gen.ts <native build dir> <out dir> <wasi|emscripten|native> <toolchain root>');
  process.exit(2);
}
const native = resolve(nativeDir);
const out = resolve(outDir);
const here = import.meta.dirname;
mkdirSync(out, { recursive: true });

interface Entry { directory: string; command: string; file: string; output: string }
const entries: Entry[] = JSON.parse(readFileSync(`${native}/compile_commands.json`, 'utf8'));

// The libraries the spike links; gc-sections drops what the harness never reaches.
const LIBS = [
  'src/compiler/nir/libnir.a', 'src/compiler/spirv/libvtn.a', 'src/util/libmesa_util.a',
  'src/compiler/libcompiler.a', 'src/c11/impl/libmesa_util_c11.a', 'src/util/blake3/libblake3.a',
];
// util pieces a translator never calls that need what WASI lacks (files, processes, shared memory, dlopen, xml).
const SKIP = /\/(os_memory_fd|os_socket|u_process|disk_cache|disk_cache_os|xmlconfig|mesa_cache_db|mesa_cache_db_multipart|fossilize_db|u_debug_stack|u_debug_stack_android|u_debug_symbol|os_file_notify|anon_file|u_dl|futex|perf\/.*|ralloc_test|u_sync_provider|blake3_neon|cache_ops_aarch64|os_misc)\.c$/;

// Linux/glibc features meson found natively that WASI hasn't, and flags that make no sense there.
const DROP = new Set([
  '-DMESA_SYSTEM_HAS_KMS_DRM=1', '-DALLOW_KCMP', '-DENABLE_SHADER_CACHE', '-DMAJOR_IN_SYSMACROS', '-DHAS_SCHED_H',
  '-DHAS_SCHED_GETAFFINITY', '-DHAVE_LINUX_FUTEX_H', '-DHAVE_DLFCN_H', '-DHAVE_SYS_SHM_H', '-DHAVE_POLL_H',
  '-DHAVE_SYS_INOTIFY_H', '-DHAVE_LINUX_UDMABUF_H', '-DHAVE_MKOSTEMP', '-DHAVE_MEMFD_CREATE', '-DHAVE_RANDOM_R',
  '-DHAVE_FLOCK', '-DHAVE_GETRANDOM', '-DHAVE_POSIX_FALLOCATE', '-DHAVE_SECURE_GETENV', '-DHAVE_GNU_QSORT_R',
  '-DHAVE_PROGRAM_INVOCATION_NAME', '-DHAVE_DLADDR', '-DHAVE_DL_ITERATE_PHDR', '-DHAVE_ZLIB', '-DHAVE_ZSTD',
  '-DHAVE_COMPRESSION', '-DHAVE_PTHREAD_SETAFFINITY', '-DHAVE_LIBDRM', '-DHAVE_SPIRV_TOOLS', '-DUSE_LIBELF',
  '-DHAVE_DRI2', '-DHAVE_RENDERDOC_INTEGRATION=1', '-DHAVE___BUILTIN_AARCH64_GET_FPCR',
  '-DHAVE___BUILTIN_AARCH64_SET_FPCR', '-DHAVE_FMEMOPEN', '-DHAVE_STRTOD_L', '-DHAVE_ISSIGNALING', '-flifetime-dse=1', '-DBLAKE3_USE_NEON=1',
  '-DHAVE___BUILTIN_ADD_OVERFLOW_P', '-DHAVE___BUILTIN_SUB_OVERFLOW_P',
  '-mtls-dialect=desc', '-fPIC', '-pthread', '-I/usr/include/libdrm', '-Winvalid-pch', '-fdiagnostics-color=always',
  '-Wno-error=maybe-uninitialized', '-Wno-format-truncation', '-Wno-nonnull-compare', '-Wno-override-init',
  '-Wno-misleading-indentation', '-Wmisleading-indentation',
]);

const isNative = toolchain === 'native' || toolchain === 'native-asan';
const asan = toolchain === 'native-asan' ? ['-g', '-fsanitize=address', '-fno-omit-frame-pointer'] : [];
const cc = toolchain === 'wasi' ? `${tcRoot}/bin/clang` : toolchain === 'emscripten' ? `${tcRoot}/emcc` : 'cc';
const cxx = toolchain === 'wasi' ? `${tcRoot}/bin/clang++` : toolchain === 'emscripten' ? `${tcRoot}/em++` : 'c++';
const target = toolchain === 'wasi' ? ['--target=wasm32-wasip1', `--sysroot=${tcRoot}/share/wasi-sysroot`] : [];
// Our shims for what WASI's libc lacks (bench/vulkan/nir/wasi/), ahead of the system headers.
const extra = isNative ? [] : toolchain === 'emscripten' ? ['-DDETECT_OS_POSIX=1'] :
  [`-I${here}/wasi/include`, '-include', `${here}/wasi/shim.h`, '-DDETECT_OS_POSIX=1', '-D_WASI_EMULATED_MMAN',
  '-D_WASI_EMULATED_PROCESS_CLOCKS', '-D_WASI_EMULATED_SIGNAL'];
// spirv_to_nir fails by longjmp: WASI does it with wasm exception handling (libsetjmp).
const sjlj = toolchain === 'wasi' ? ['-mllvm', '-wasm-enable-sjlj', '-mllvm', '-wasm-use-legacy-eh=false']
  : toolchain === 'emscripten' ? ['-sSUPPORT_LONGJMP=wasm', '-sWASM_LEGACY_EXCEPTIONS=0'] : [];
const opt = [...sjlj, ...asan, asan.length ? '-O1' : '-O2', '-ffunction-sections', '-fdata-sections', '-Wno-unknown-warning-option',
  '-Wno-unused-command-line-argument'];

// Split a shell-quoted command line (meson quotes only with single quotes).
function split(cmd: string): string[] {
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
}
const esc = (s: string) => s.replace(/\$/g, '$$$$').replace(/ /g, '$ ').replace(/:/g, '$:');
const shq = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

const lines: string[] = [
  `cc = ${cc}`,
  `cxx = ${cxx}`,
  'rule cc',
  '  command = $cc $flags -MD -MF $out.d -c $in -o $out',
  '  depfile = $out.d',
  '  deps = gcc',
  '  description = CC $out',
  'rule cxx',
  '  command = $cxx $flags -MD -MF $out.d -c $in -o $out',
  '  depfile = $out.d',
  '  deps = gcc',
  '  description = CXX $out',
  '',
];
const objs: string[] = [];
let n = 0;
for (const e of entries) {
  const lib = LIBS.find((l) => e.output.startsWith(`${l}.p/`));
  if (!lib) continue;
  const src = resolve(e.directory, e.file);
  if (!isNative && SKIP.test(src)) continue;
  const args = split(e.command).slice(1);
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-MD') continue;
    if (a === '-MQ' || a === '-MF' || a === '-o') { i++; continue; }
    if (a === '-c') { i++; continue; }
    if (/^-O\d$/.test(a)) continue;
    if (!isNative && DROP.has(a)) continue;
    if (a.startsWith('-I')) { flags.push(`-I${resolve(e.directory, a.slice(2))}`); continue; }
    flags.push(a);
  }
  const obj = `obj/${n++}-${basename(src)}.o`;
  objs.push(obj);
  lines.push(`build ${esc(obj)}: ${src.endsWith('.cpp') ? 'cxx' : 'cc'} ${esc(src)}`);
  lines.push(`  flags = ${[...target, ...extra, ...flags, ...opt].map(shq).join(' ').replace(/\$/g, '$$$$')}`);
}

// KosmicKrisp's compiler isn't in the native build (its driver builds only for macOS): its files with libnir's flags
// plus its own include, and msl_nir_algebraic.c generated by build.sh.
const nirEntry = entries.find((e) => e.output.startsWith('src/compiler/nir/libnir.a.p/'))!;
const mesaSrc: string = JSON.parse(readFileSync(`${native}/meson-info/meson-info.json`, 'utf8')).directories.source;
const kk = `${mesaSrc}/src/kosmickrisp/compiler`;
const kkFiles = ['nir_to_msl.c', 'msl_type_inference.c', 'msl_iomap.c', 'msl_nir_gather_common.c',
  'msl_nir_lower_common.c', 'msl_nir_lower_subgroups.c'].map((f) => `${kk}/${f}`);
kkFiles.push(`${out}/gen/msl_nir_algebraic.c`);
const nirFlags = (() => {
  const args = split(nirEntry.command).slice(1);
  const f: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-MD') continue;
    if (a === '-MQ' || a === '-MF' || a === '-o' || a === '-c') { i++; continue; }
    if (/^-O\d$/.test(a) || (!isNative && DROP.has(a))) continue;
    if (a.startsWith('-I')) { f.push(`-I${resolve(nirEntry.directory, a.slice(2))}`); continue; }
    f.push(a);
  }
  return f;
})();
const harnessFlags = [...target, ...extra, ...nirFlags, `-I${kk}`, `-I${mesaSrc}/src/kosmickrisp`,
  `-I${mesaSrc}/src/compiler/spirv`, `-I${native}/src/compiler/spirv`, ...opt];
for (const src of [...kkFiles, `${here}/spike.c`, ...(isNative ? [] : [`${here}/wasi/os_misc.c`])]) {
  const obj = `obj/${n++}-${basename(src)}.o`;
  objs.push(obj);
  lines.push(`build ${esc(obj)}: cc ${esc(src)}`);
  lines.push(`  flags = ${harnessFlags.filter((a) => a !== '-Werror=missing-prototypes').map(shq).join(' ').replace(/\$/g, '$$$$')}`);
}

// Linking: a reactor module exporting the harness's entry points (wasi), or a native executable for comparison.
const exportsList = ['spike_init', 'spike_alloc', 'spike_free', 'spike_run', 'spike_result', 'spike_result_len',
  'spike_phase_ns'];
let link: string;
if (toolchain === 'wasi') {
  link = `$cxx --target=wasm32-wasip1 --sysroot=${tcRoot}/share/wasi-sysroot -mexec-model=reactor -O2 ` +
    `-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -Wl,--gc-sections -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 ` +
    exportsList.map((e) => `-Wl,--export=${e}`).join(' ') +
    ' -lsetjmp -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-signal $in -o $out';
} else if (toolchain === 'emscripten') {
  link = `$cxx -O2 -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=0 -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=1048576 --no-entry -Wl,--gc-sections ` +
    `-sEXPORTED_FUNCTIONS=${exportsList.map((e) => `_${e}`).join(',')} $in -o $out`;
} else {
  link = `$cxx -O2 ${asan.join(' ')} -Wl,--gc-sections $in -o $out -lm -lpthread -lSPIRV-Tools`;
}
lines.push('', 'rule link', `  command = ${link}`, '  description = LINK $out', '');
const product = isNative ? 'spike' : 'spike.wasm';
lines.push(`build ${product}: link ${objs.map(esc).join(' ')}`, `default ${product}`, '');
writeFileSync(`${out}/build.ninja`, lines.join('\n'));
console.log(`${relative(process.cwd(), out)}/build.ninja: ${objs.length} objects -> ${product}`);
