// The guest-image tests' deterministic step counts (tests/steps.txt, shared with
// the native runners in core/tests).
import { readFileSync } from 'node:fs';

export const STEPS: Record<string, number> = Object.fromEntries(
  readFileSync(new URL('steps.txt', import.meta.url), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { const [name, n] = l.trim().split(/\s+/); return [name, Number(n)]; }),
);
