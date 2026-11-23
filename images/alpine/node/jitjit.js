// A JIT inside the emulator's JIT (images/alpine/node; docs/benchmarking.md "The paired A/B"): fixed work whose cost
// is machine code that V8 writes while it runs, as a browser's does. Each part prints nothing; the last line is
// "jitjit: <checksum> <functions made>", the same for a given scale on every run.
//   node jitjit.js [scale=100]
// - churn: distinct functions from a template (operators, constants, branches and loop shapes vary with their
//   number), each called past V8's tiers (the interpreter, Sparkplug, Maglev, TurboFan), then dropped: fresh code
//   all the time, and code the collector frees.
// - deopt: functions optimized for small integers, then given doubles, strings and objects of other shapes: code
//   thrown away and compiled again.
// - dispatch: one call site over closures and objects of many shapes, new ones each round: indirect transfers into
//   new code, inline caches patched from monomorphic to megamorphic.
// - regexp: distinct regular expressions (each compiled to machine code) over generated text.
// - runtime: what a page does between its own code: JSON, strings, Maps, sorts, typed arrays, the collector.
'use strict';
const scale = +(process.argv[2] ?? 100);
let sum = 0, made = 0;
const mix = (x) => { sum = (Math.imul(sum ^ x, 0x01000193) + 0x9e3779b9) | 0; };

const OPS = ['+', '-', '^', '|', '&', '*'];
function make(k) {
  const m = 3 + (k % 9);
  let body = `let a = x | 0, b = ${k % 997}, s = ${k & 255};\nfor (let i = 0; i < n; i++) {\n`;
  for (let j = 0; j < m; j++) {
    const op = OPS[((k >> (j % 13)) + j) % OPS.length], c = (k * 31 + j * 17) % 4093;
    switch ((k + j) % 4) {
      case 0: body += `a = (a ${op} (b + ${c})) | 0; s = (s + a) | 0;\n`; break;
      case 1: body += `if ((a & ${c}) > ${c >> 1}) { s = (s ${op} a) | 0; } else { a = (a ${op} ${c}) | 0; }\n`; break;
      case 2: body += `for (let j${j} = 0; j${j} < ${1 + (c & 3)}; j${j}++) b = (b ${op} (i + j${j} + ${c})) | 0;\n`; break;
      default: body += `switch ((a + i) & 3) { case 0: a = (a + ${c}) | 0; break; case 1: s = (s ${op} ${c}) | 0; break; default: b = (b ^ a) | 0; }\n`;
    }
  }
  body += `b = (b + i) | 0;\n}\nreturn (s ^ a ^ b) | 0;`;
  made++;
  return new Function('x', 'n', `// jitjit ${k}\n${body}`);
}

function churn(count) {
  for (let k = 0; k < count; k++) {
    const f = make(k);
    let s = 0;
    for (let i = 0; i < 1500; i++) s = (s + f(i, 40)) | 0;
    mix(s);
  }
}

function deopt(count) {
  for (let k = 0; k < count; k++) {
    const f = new Function('a', 'b', `// deopt ${k}\nlet s = a.v + b.v; for (let i = 0; i < 8; i++) s = s + a.v * ${1 + (k % 7)} - b.v; return s;`);
    made++;
    const ints = { v: k }, more = { v: 3 };
    let s = 0;
    for (let i = 0; i < 4000; i++) s += f(ints, more); // small integers: optimized for them
    const dbl = { v: 0.5 + k }, other = { w: 1, v: 2 }, str = { v: 'x' };
    for (let i = 0; i < 4000; i++) s += f(dbl, more); // doubles: thrown away, compiled again
    for (let i = 0; i < 4000; i++) s += f(other, dbl); // another shape
    s += f(str, more).length; // a string: once more
    for (let i = 0; i < 2000; i++) s += f(ints, other);
    mix(Math.round(s) | 0);
  }
}

function dispatch(rounds) {
  for (let r = 0; r < rounds; r++) {
    const things = [];
    for (let k = 0; k < 24; k++) {
      // Each object its own shape (its property names) and its own method's code.
      const o = { [`p${r}_${k}`]: k };
      o.go = new Function('x', `// dispatch ${r} ${k}\nreturn (x * ${k + 3} + ${r}) ${OPS[k % OPS.length]} ${k * 7 + 1};`);
      made++;
      things.push(o);
    }
    let s = 0;
    for (let i = 0; i < 30000; i++) s = (s + things[i % things.length].go(i)) | 0; // one site, 24 targets
    for (let k = 0; k < things.length; k++) for (let i = 0; i < 600; i++) s = (s + things[k].go(i)) | 0;
    mix(s);
  }
}

function regexp(count) {
  let text = '';
  for (let i = 0; i < 400; i++) text += `key${i % 37}=${(i * 2654435761) >>> 7};path/${i % 11}/item-${i}.html?q=${i & 15} `;
  for (let k = 0; k < count; k++) {
    const re = new RegExp(`(key${k % 37})=(\\d{${1 + (k % 4)},})|item-(\\d*${k % 10})\\.html|\\?q=(${k & 15})\\b`, 'g');
    let n = 0, m;
    for (let pass = 0; pass < 3; pass++) while ((m = re.exec(text))) n = (n + m.index + m[0].length) | 0;
    mix(n + text.replace(re, (a) => a.length).length);
  }
}

function runtime(rounds) {
  for (let r = 0; r < rounds; r++) {
    const rows = [];
    for (let i = 0; i < 1500; i++) rows.push({ id: i, name: `n${(i * 7919 + r) % 1000}`, tags: [i & 3, i % 5, r], score: ((i * 31 + r) % 977) / 7 });
    const back = JSON.parse(JSON.stringify(rows));
    back.sort((a, b) => a.score - b.score || a.id - b.id);
    const by = new Map();
    for (const x of back) by.set(x.name, (by.get(x.name) ?? 0) + x.tags.reduce((a, b) => a + b, 0));
    const words = back.map((x) => x.name.toUpperCase().padStart(6, '_')).join(',').split(',').filter((w) => w.endsWith(String(r % 10)));
    const f = new Float64Array(4096);
    for (let i = 0; i < f.length; i++) f[i] = Math.sin(i * 0.01 + r) * back[i % back.length].score;
    f.sort();
    mix(by.size + words.length + back[r % back.length].id + Math.round(f[100] * 1000));
  }
}

// The parts interleaved, as a page's work is: new code arrives while older code runs and dies.
const steps = Math.max(1, Math.round(scale / 10));
for (let s = 0; s < steps; s++) {
  churn(30);
  deopt(6);
  dispatch(4);
  regexp(20);
  runtime(2);
}
console.log(`jitjit: ${(sum >>> 0).toString(16).padStart(8, '0')} ${made}`);
