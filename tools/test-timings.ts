// A node:test reporter that writes each test file's wall time (its process, start-up and hooks included) and its
// tests' counts as JSON: `--test-reporter=./tools/test-timings.ts --test-reporter-destination=target/ci/timings.json`
// beside the spec reporter. scripts/ci.sh writes target/ci/timings.json on every run; tests/areas.ts's check reads it
// to keep the fast lane's smoke set to the quick files (docs/testing.md "Tiers").
import { relative } from 'node:path';

interface FileTime {
  s: number;
  tests: number;
  skipped: number;
  failed: number;
}

interface Event {
  type: string;
  data: { name?: string; file?: string; nesting?: number; skip?: unknown; todo?: unknown; details?: { duration_ms?: number } };
}

export default async function* timings(source: AsyncIterable<Event>): AsyncGenerator<string> {
  const files: Record<string, FileTime> = {};
  const of = (file: string) => (files[relative(process.cwd(), file)] ??= { s: 0, tests: 0, skipped: 0, failed: 0 });
  for await (const { type, data } of source) {
    if (!data.file) continue;
    const f = of(data.file);
    // The file's own entry (its process, named by its path) comes only as test:complete and carries the wall time;
    // its tests are at nesting 0 too, as test:pass or test:fail.
    if (data.name === relative(process.cwd(), data.file) || data.name === data.file) {
      if (type === 'test:complete') f.s = Math.round(data.details?.duration_ms ?? 0) / 1000;
    } else if (data.nesting === 0 && (type === 'test:pass' || type === 'test:fail')) {
      f.tests++;
      if (data.skip !== undefined || data.todo !== undefined) f.skipped++;
      if (type === 'test:fail') f.failed++;
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  yield `${JSON.stringify({ date: new Date().toISOString(), files: sorted }, null, 1)}\n`;
}
