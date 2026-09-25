import { runAll, suite, type Sample } from './benchmarks.ts';

self.onmessage = async (e: MessageEvent<{ quick: boolean; only: string | null }>) => {
  const log = (m: string) => self.postMessage({ log: m });
  try {
    const { quick, only } = e.data;
    const results: Sample[] = only ? await suite[only]({ quick, log }) : await runAll({ quick, log });
    self.postMessage({ results, crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent });
  } catch (err) {
    self.postMessage({ error: String((err as Error).stack ?? err) });
  }
};
