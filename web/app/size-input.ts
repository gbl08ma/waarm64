// A size as the user types it (web/app/ui/SizeField.svelte): a number and a binary unit, read as bytes. DOM-free, so
// Node's tests run it (tests/size-input.test.ts).

/** The units a size is typed in: binary, as the page writes sizes (web/app/bytes.ts). */
export const SIZE_UNITS = { MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40 } as const;
export type SizeUnit = keyof typeof SIZE_UNITS;

/** What's wrong with a size typed: no number (empty, not a number, zero or less), under its least or past its most. */
export type SizeProblem = 'empty' | 'small' | 'large';

/**
 * `amount` of `unit` in bytes, rounded up to a multiple of `round` (a MiB by default: the guest's partitions are
 * aligned to them); `undefined` for no size (empty, not a number, zero or less).
 */
export function toBytes(amount: number | null | undefined, unit: SizeUnit, round: number = SIZE_UNITS.MiB) {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return undefined;
  return Math.ceil((amount * SIZE_UNITS[unit]) / round) * round;
}

/**
 * How `bytes` is typed in one of `units` (smallest first): in the largest it's a whole number of, else in the largest it
 * is at least one of (to three decimals), else in the smallest.
 */
export function inUnits(bytes: number, units: readonly SizeUnit[]): { amount: number; unit: SizeUnit } {
  const big = [...units].sort((a, b) => SIZE_UNITS[b] - SIZE_UNITS[a]);
  const unit =
    big.find((u) => bytes >= SIZE_UNITS[u] && bytes % SIZE_UNITS[u] === 0) ??
    big.find((u) => bytes >= SIZE_UNITS[u]) ??
    big[big.length - 1];
  return { amount: round3(bytes / SIZE_UNITS[unit]), unit };
}

/** `amount` of `from` in `to`, to three decimals: the same size when the unit changes. */
export const convert = (amount: number, from: SizeUnit, to: SizeUnit) =>
  round3((amount * SIZE_UNITS[from]) / SIZE_UNITS[to]);

/** What's wrong with `bytes` (`toBytes`'s), if anything, between `min` and `max` (both included). */
export function sizeProblem(bytes: number | undefined, min?: number, max?: number): SizeProblem | undefined {
  if (bytes === undefined) return 'empty';
  if (min !== undefined && bytes < min) return 'small';
  if (max !== undefined && bytes > max) return 'large';
  return undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
