# The `Vcpu`'s fixed offsets within V8's reach (2026-10-16)

`bench/boot/REPORT.md` "M8: the `Vcpu`'s fixed offsets within V8's reach".

- `sessions/`: each Firefox pages session's `results.json` (`a`: before; `b`: the TLB arrays interleaved; `c`: also
  the state before the arrays and the transfer cache's OR), and `stalls.txt`: `bench/gpu/stalls.ts` on each
  session's timeline (busy MIPS). `a-1` waited 330 s for Firefox's first page (not counted).
- `gates/`: `bench/run.ts` JSON, three alternating rounds: `ab-*` before against (a), `ac-*` before against all three.
