import type { Sample } from '../spike/benchmarks.ts';

self.onmessage = async (e: MessageEvent<{ quick: boolean; only: string | null; file: File }>) => {
  const log = (m: string) => self.postMessage({ log: m });
  try {
    const { quick, only, file } = e.data;
    const { suite } = (await import('./suite.ts')) as { suite: Record<string, (o: { quick: boolean; log: typeof log; file: File }) => Promise<Sample[]>> };
    const results = await suite[only ?? 'io']({ quick, log, file });
    self.postMessage({ results, crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent });
  } catch (err) {
    self.postMessage({ error: String((err as Error).stack ?? err) });
  }
};
