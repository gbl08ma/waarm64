// Grows the golden corpus: generates tests, runs them on an oracle, writes tests/corpus/<group>.txt.
//
//   node tools/corpus/run.ts [--oracle qemu|m4|both] [group...]
//
// `both` (the default) is authoritative: the M4's results are recorded, and a
// test where QEMU disagrees gets a `note qemu: ...` line. The M4 is the Lima VM
// `oracle` on macmini.lan (docs/testing.md "The golden corpus"); the harness is copied into it on each run.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { OUT_SIZE, applyOutput, formatFile, packInput, type Test } from "./corpus.ts";
import { GROUPS, generate } from "./gen.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const HARNESS = `${ROOT}target/harness/harness`;
const LIMACTL = "/opt/homebrew/bin/limactl";
const REMOTE = "/tmp/waarm64-harness";
const BATCH = 400;

function sh(cmd: string, args: string[], input?: Uint8Array): Buffer {
  const r = spawnSync(cmd, args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const ORACLES: Record<string, { setup(): void; cmd: [string, string[]] }> = {
  qemu: { setup() {}, cmd: ["qemu-aarch64", [HARNESS]] },
  m4: {
    setup() {
      sh("scp", ["-q", HARNESS, `macmini.lan:${REMOTE}`]);
      sh("ssh", ["macmini.lan", `${LIMACTL} copy ${REMOTE} oracle:${REMOTE} && ${LIMACTL} shell oracle chmod +x ${REMOTE}`]);
    },
    cmd: ["ssh", ["macmini.lan", LIMACTL, "shell", "oracle", REMOTE]],
  },
};

/** Runs tests on one oracle; returns copies with results filled in. */
function runOn(oracle: string, tests: Test[]): Test[] {
  const [cmd, args] = ORACLES[oracle].cmd;
  const done: Test[] = [];
  for (let i = 0; i < tests.length; i += BATCH) {
    const batch = tests.slice(i, i + BATCH).map((t) => ({ ...t, notes: [...t.notes] }));
    const out = sh(cmd, args, Buffer.concat(batch.map(packInput)));
    if (out.length !== batch.length * OUT_SIZE) throw new Error(`${oracle}: ${out.length} bytes for ${batch.length} tests`);
    batch.forEach((t, k) => applyOutput(t, out.subarray(k * OUT_SIZE, (k + 1) * OUT_SIZE)));
    done.push(...batch);
  }
  return done;
}

/** The result part of a test as text, for comparing oracles. */
function result(t: Test): string {
  return formatFile("", [{ ...t, notes: [] }]).split("\n").filter((l) => /^(out|mem|exit) /.test(l)).join("; ");
}

const argv = process.argv.slice(2);
let oracle = "both";
const k = argv.indexOf("--oracle");
if (k >= 0) oracle = argv.splice(k, 2)[1];
const groups = argv.length ? argv : Object.keys(GROUPS);

sh(`${ROOT}tests/harness/build.sh`, []);
const used = oracle === "both" ? ["m4", "qemu"] : [oracle];
for (const o of used) ORACLES[o].setup();
const date = new Date().toISOString().slice(0, 10);

for (const g of groups) {
  const tests = generate(g);
  const primary = runOn(used[0], tests);
  let disagree = 0;
  if (oracle === "both") {
    const q = runOn("qemu", tests);
    primary.forEach((t, i) => {
      const a = result(t), b = result(q[i]);
      if (a !== b) {
        t.notes.push(`qemu: ${b}`);
        disagree++;
      }
    });
  }
  writeFileSync(`${ROOT}tests/corpus/${g}.txt`, formatFile(`${used[0]} ${date}`, primary));
  console.log(`${g}: ${tests.length} tests` + (oracle === "both" ? `, qemu disagrees on ${disagree}` : ""));
}
