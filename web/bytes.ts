// Small byte helpers the network code shares: comparing bytes in place and hex text.

/** Whether `a` holds `b` at `at` (per packet: an index loop, no copy). */
export const eq = (a: ArrayLike<number>, at: number, b: ArrayLike<number>) => {
  for (let k = 0; k < b.length; k++) if (a[at + k] !== b[k]) return false;
  return true;
};

/** Bytes as lowercase hex, two digits each. */
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
