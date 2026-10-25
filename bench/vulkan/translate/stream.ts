// The command stream of arm 3's prototype (bench/vulkan/REPORT.md): what convert.ts writes and replay.ts translates,
// words a command (an op, then its arguments; blobs as a length and padded words). Browser-safe: no Node imports.
export const OP = {
  FILL: 1, UPDATE_DESC: 2, BEGIN_RP: 3, END_RP: 4, VIEWPORT: 5, SCISSOR: 6, BIND_PIPELINE: 7, BIND_SETS: 8, PUSH: 9,
  BIND_VB: 10, BIND_IB: 11, DRAW: 12, DRAW_INDEXED: 13, COPY_BUFFER: 14, COPY_BUF_TO_IMG: 15, SUBMIT: 16, BEGIN_CB: 17,
  END_CB: 18,
} as const;
export const DESC = { UNIFORM_BUFFER: 0, UNIFORM_BUFFER_DYNAMIC: 1, COMBINED_IMAGE_SAMPLER: 2, SAMPLED_IMAGE: 3, SAMPLER: 4, STORAGE_BUFFER: 5, STORAGE_BUFFER_DYNAMIC: 6 } as const;

/** The words an op takes, its own included. */
export function opLength(w: ArrayLike<number>, i: number): number {
  const op = w[i];
  switch (op) {
    case OP.FILL: return 4 + ((w[i + 3] + 3) >> 2);
    case OP.UPDATE_DESC: {
      let j = i + 2;
      for (let k = 0; k < w[i + 1]; k++) {
        const t = w[j + 3], n = w[j + 4];
        j += 5 + n * (t === DESC.COMBINED_IMAGE_SAMPLER || t === DESC.SAMPLED_IMAGE || t === DESC.SAMPLER ? 2 : 3);
      }
      return j - i;
    }
    case OP.BEGIN_RP: return 8 + w[i + 7] * 5;
    case OP.END_RP: return 1;
    case OP.VIEWPORT: return 7;
    case OP.SCISSOR: return 5;
    case OP.BIND_PIPELINE: return 2;
    case OP.BIND_SETS: { const n = w[i + 3]; return 5 + n + w[i + 4 + n]; }
    case OP.PUSH: return 5 + ((w[i + 4] + 3) >> 2);
    case OP.BIND_VB: return 3 + 2 * w[i + 2];
    case OP.BIND_IB: return 4;
    case OP.DRAW: return 5;
    case OP.DRAW_INDEXED: return 6;
    case OP.COPY_BUFFER: return 4 + 3 * w[i + 3];
    case OP.COPY_BUF_TO_IMG: return 4 + 10 * w[i + 3];
    case OP.SUBMIT: return 2 + w[i + 1];
    case OP.BEGIN_CB: case OP.END_CB: return 2;
    default: throw new Error(`bad op ${op} at ${i}`);
  }
}

