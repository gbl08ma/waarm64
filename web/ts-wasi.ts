// The few WASI imports the tailnet client module (net/ts, built for
// wasm32-wasip1) uses: std's clocks and randomness, and stderr for panics.
// Nothing else of WASI is there: no files, no arguments, an empty environment.

/** WASI imports over `memory()`, the instance's memory once it exists. */
export function wasi(memory: () => WebAssembly.Memory, log: (line: string) => void = (l) => console.error(l)) {
  const view = () => new DataView(memory().buffer);
  let pending = '';
  const decoder = new TextDecoder();
  return {
    wasi_snapshot_preview1: {
      random_get(ptr: number, len: number) {
        // getRandomValues takes at most 64 KiB at a time, and not a shared buffer's view
        const bytes = new Uint8Array(memory().buffer, ptr, len);
        for (let at = 0; at < len; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(len, at + 65536)));
        return 0;
      },
      clock_time_get(id: number, _precision: bigint, out: number) {
        // 0: realtime, 1: monotonic (and the CPU clocks, which nothing here asks for)
        const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
        view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
        return 0;
      },
      environ_sizes_get(count: number, size: number) {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      fd_write(fd: number, iovs: number, n: number, written: number) {
        const v = view();
        let total = 0;
        for (let k = 0; k < n; k++) {
          const ptr = v.getUint32(iovs + 8 * k, true);
          const len = v.getUint32(iovs + 8 * k + 4, true);
          if (fd === 1 || fd === 2) pending += decoder.decode(new Uint8Array(memory().buffer, ptr, len));
          total += len;
        }
        for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
          log(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
        v.setUint32(written, total, true);
        return 0;
      },
      proc_exit(code: number) {
        throw new Error(`the tailnet client exited (${code})`);
      },
    },
  };
}
