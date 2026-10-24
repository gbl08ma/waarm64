import type { Options, Sample } from './benchmarks.ts';

type Suite = { runAll: (o: Options) => Promise<Sample[]>; suite: Record<string, (o: Options) => Sample[] | Promise<Sample[]>> };

self.onmessage = async (e: MessageEvent<{ quick: boolean; only: string | null; suite: string }>) => {
  const log = (m: string) => self.postMessage({ log: m });
  try {
    const { quick, only } = e.data;
    const { runAll, suite } = (await import(/* @vite-ignore */ e.data.suite)) as Suite;
    const results: Sample[] = only ? await suite[only]({ quick, log }) : await runAll({ quick, log });
    self.postMessage({ results, crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent });
  } catch (err) {
    self.postMessage({ error: String((err as Error).stack ?? err) });
  }
};
