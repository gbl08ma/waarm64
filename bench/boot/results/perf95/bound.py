import json, gzip
# bound.py (run here): PERF loop 95's bound per workload from preempt-counts.json (boot, user), counts/ab.json (node,
# smp; the dev VM's Chromium) and pages-diag/jit.jsonl.gz (the Mac). Writes what bound.txt holds.
P95 = ['other', 'MSR TTBR0', 'MSR TTBR1', 'MSR TCR', 'MSR SCTLR', 'MSR CONTEXTIDR', 'MSR VBAR', 'MSR CPACR', 'MSR MDSCR', 'MSR FPCR', 'MSR FPSR', 'MSR NZCV', 'MSR CNTKCTL', 'MSR ICC_EOIR1', 'MSR ICC_SGI1R', 'MSR ICC_PMR', 'MSR ICC_DIR', 'MSR ICC other', 'MSR reg other', 'MSR PAN', 'MSR SPSel', 'MSR imm other', 'TLBI VMALLE1IS', 'TLBI VMALLE1', 'TLBI VAE1IS', 'TLBI VALE1IS', 'TLBI ASIDE1IS', 'TLBI VAAE1IS', 'TLBI VAALE1IS', 'TLBI local', 'TLBI range/OS', 'TLBI other', 'AT', 'SYS other', 'DC IVAC', 'DC set/way', 'DC CVAC', 'DC CVAU', 'DC CIVAC', 'IC IALLU', 'IC IALLUIS', 'IC IVAU', 'ISB', 'CLREX', 'YIELD', 'SEV', 'SEVL', 'WFE', 'WFI', 'ERET']
SCOPE = [n for n in P95[1:] if n not in ('ISB', 'WFE', 'WFI', 'ERET')]
# Exits whatever the block does: the GIC's registers (Exit::Platform), IC (Exit::Invalidate), TLBI IS with several
# vCPUs (Exit::TlbiIs); TTBR0/1 change the regime the next block's code is compiled for.
EXITS = {'MSR ICC_EOIR1', 'MSR ICC_SGI1R', 'MSR ICC_PMR', 'MSR ICC_DIR', 'MSR ICC other', 'IC IVAU', 'IC IALLU', 'IC IALLUIS', 'MSR TTBR0', 'MSR TTBR1'}
TLBI_IS = {'TLBI VMALLE1IS', 'TLBI VAE1IS', 'TLBI VALE1IS', 'TLBI ASIDE1IS', 'TLBI VAAE1IS', 'TLBI VAALE1IS'}
w = [(r['name'], r['steps'], r['t'], r['ncpus'] > 1) for r in json.load(open('preempt-counts.json'))['runs']]
seen = set()
for r in json.load(open('counts/ab.json'))['rows']:
    if r['workload'] in seen or 'stats' not in r['s']:
        continue
    seen.add(r['workload'])
    st = r['s']['stats']
    w.append((r['workload'], st['steps'], st['jit']['diag'], r['workload'] == 'smp'))
last = json.loads(gzip.open('pages-diag/jit.jsonl.gz').read().decode().strip().split('\n')[-1])
w.append(('pages (Mac, 4 vCPUs)', last['steps'], last['jit']['diag'], True))
EXIT_NS, EDGE_NS, STEP_NS = 130, 5, 1.6
print(f'bound: an out-end {EXIT_NS} ns (an exit to the run loop, PERF loop 8: the upper end), an edge {EDGE_NS} ns, a guest step {STEP_NS} ns of busy time')
for name, steps, t, smp in w:
    out = sum(t[80 + 2 * P95.index(n)] for n in SCOPE)
    edge = sum(t[81 + 2 * P95.index(n)] for n in SCOPE)
    ex = EXITS | (TLBI_IS if smp else set())
    rel = sum(t[80 + 2 * P95.index(n)] for n in SCOPE if n not in ex)
    k, busy = 1000 / steps, steps * STEP_NS
    print(f'{name:22} {steps/1e9:6.2f} G steps: in scope out {out*k:.4f} / to a member {edge*k:.4f} a 1000 steps; '
          f'not exiting anyway {rel*k:.4f}; bound all {(out*EXIT_NS+edge*EDGE_NS)/busy*100:.3f}%, relaxable {(rel*EXIT_NS+edge*EDGE_NS)/busy*100:.3f}%')
