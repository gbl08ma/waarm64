// What the dEQP tests on the page (tests/page-deqp.test.ts, tests/page-deqp-vk.test.ts) take from a pass list: a
// seeded sample of it, or a slice of the whole list (docs/testing.md "dEQP", "dEQP-VK").

/** A seeded generator of 32-bit integers (mulberry32). */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A seed: `env`'s value when set, else a drawn one. */
export function seedFrom(env: string | undefined): number {
  return env !== undefined && env !== '' ? Number(env) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
}

/** Every `stride`-th case of each group (the name's second to fourth parts: `functional.shaders.loops`,
 * `pipeline.monolithic.blend`), from an offset per group the seed draws (a group shorter than its offset: one case of
 * it), in the list's order. */
export function sample(cases: string[], stride: number, seed: number): string[] {
  const groups = new Map<string, number[]>();
  cases.forEach((c, i) => {
    const g = c.split('.').slice(1, 4).join('.');
    let at = groups.get(g);
    if (!at) groups.set(g, (at = []));
    at.push(i);
  });
  const next = random(seed), keep = new Set<number>();
  for (const at of groups.values()) {
    const offset = next() % stride;
    if (offset >= at.length) keep.add(at[next() % at.length]);
    for (let k = offset; k < at.length; k += stride) keep.add(at[k]);
  }
  return cases.filter((_, i) => keep.has(i));
}

/** The `n`th (from 1) of `m` slices of `cases`, cut at multiples of `round` cases. */
export function phase(cases: string[], n: number, m: number, round: number): string[] {
  const rounds = Math.ceil(cases.length / round);
  const at = (k: number) => Math.round((rounds * k) / m) * round;
  return cases.slice(at(n - 1), at(n));
}

/** A pass list's cases (`#` lines are comments). */
export function cases(text: string): string[] {
  return text.split('\n').filter((l) => l && !l.startsWith('#'));
}
