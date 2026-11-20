// The vCPUs' optional features (docs/cpu.md): one table, from which the page's list, its defaults and the core's
// `VmConfig.features` mask all come. A feature is named by its key everywhere: the page's `?<feature>=0|1`, the start
// message's `cpu`, a snapshot's header `cpu`, a shape's `cpu`, `BootOptions.cpu`.

/**
 * Each feature's bit in `VmConfig.features` and whether a machine has it unless asked otherwise. In bit order: the
 * order of `CPU_FEATURES`, which a shape's `cpu` lists them in (and so its hash). Bit 0 is the crypto extensions
 * (`BootOptions.crypto`), always on for the page's machines: not one of these.
 */
export const CPU_BITS = {
  /** FEAT_RNG (`RNDR`, `RNDRRS`; ABI 35). */
  rng: { bit: 1, on: true },
  /** FEAT_E0PD, which spares a KASLR kernel KPTI (ABI 35). */
  e0pd: { bit: 2, on: true },
  /** FEAT_SHA512 and FEAT_SHA3 (with `crypto`; ABI 51). */
  sha3: { bit: 3, on: true },
  /** FEAT_JSCVT (`FJCVTZS`; ABI 59). */
  jscvt: { bit: 4, on: true },
  /** FEAT_LRCPC, FEAT_SB, FEAT_FlagM with FlagM2, FEAT_DIT, FEAT_FRINTTS (ABI 59). */
  rcpc: { bit: 5, on: true },
  sb: { bit: 6, on: true },
  flagm: { bit: 7, on: true },
  dit: { bit: 8, on: true },
  frintts: { bit: 9, on: true },
  /** FEAT_DotProd (ABI 60). */
  dotprod: { bit: 10, on: true },
  /** FEAT_I8MM (ABI 61): off unless asked for, measured slower than what guests do without it (docs/cpu.md). */
  i8mm: { bit: 11, on: false },
  /** FEAT_RDM (ABI 62). */
  rdm: { bit: 12, on: true },
  /** FEAT_LRCPC2 (with `rcpc` only; ABI 62). */
  rcpc2: { bit: 13, on: true },
  /** FEAT_FCMA (ABI 63): off unless asked for (docs/cpu.md). */
  fcma: { bit: 14, on: false },
  /** FEAT_FP16 (ABI 65): off unless asked for (docs/cpu.md). */
  fp16: { bit: 15, on: false },
  /** FEAT_FHM (with `fp16` only; ABI 65): off unless asked for (docs/cpu.md). */
  fhm: { bit: 16, on: false },
  /** FEAT_BF16 (ABI 66): off unless asked for (docs/cpu.md). */
  bf16: { bit: 17, on: false },
} as const satisfies Record<string, { bit: number; on: boolean }>;

export type CpuFeature = keyof typeof CPU_BITS;
/** Every feature, in bit order. */
export const CPU_FEATURES = Object.keys(CPU_BITS) as CpuFeature[];
/** The ones a machine has unless turned off (`?<feature>=0`); the rest only when asked for (`?<feature>=1`). */
export const CPU_DEFAULT: CpuFeature[] = CPU_FEATURES.filter((f) => CPU_BITS[f].on);

/** Whether `f` names a feature (a snapshot's header is checked with it). */
export const isCpuFeature = (f: unknown): f is CpuFeature => typeof f === 'string' && Object.hasOwn(CPU_BITS, f);

/** The features the query asks for: the defaults, less each `?<feature>=0`, with each `?<feature>=1` of the others. */
export const cpuFromQuery = (q: URLSearchParams): CpuFeature[] =>
  CPU_FEATURES.filter((f) => (CPU_BITS[f].on ? q.get(f) !== '0' : q.get(f) === '1'));

/**
 * The `VmConfig.features` mask: bit 0 unless `crypto` is false, then each feature's bit when `cpu` lists it (without
 * a list: each default one unless its option is false, each other one when its option is true).
 */
export function cpuMask(
  o: { crypto?: boolean; cpu?: readonly CpuFeature[] } & { [F in CpuFeature]?: boolean },
): bigint {
  let mask = o.crypto === false ? 0n : 1n;
  for (const f of CPU_FEATURES) {
    const on = o.cpu ? o.cpu.includes(f) : CPU_BITS[f].on ? o[f] !== false : o[f] === true;
    if (on) mask |= 1n << BigInt(CPU_BITS[f].bit);
  }
  return mask;
}
