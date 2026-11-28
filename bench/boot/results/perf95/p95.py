import json, sys
# p95.py <ab.json>: PERF loop 95's block ends at a system instruction, per 1000 steps (out of the function / to a member).
P95 = ['other', 'MSR TTBR0', 'MSR TTBR1', 'MSR TCR', 'MSR SCTLR', 'MSR CONTEXTIDR', 'MSR VBAR', 'MSR CPACR', 'MSR MDSCR', 'MSR FPCR', 'MSR FPSR', 'MSR NZCV', 'MSR CNTKCTL', 'MSR ICC_EOIR1', 'MSR ICC_SGI1R', 'MSR ICC_PMR', 'MSR ICC_DIR', 'MSR ICC other', 'MSR reg other', 'MSR PAN', 'MSR SPSel', 'MSR imm other', 'TLBI VMALLE1IS', 'TLBI VMALLE1', 'TLBI VAE1IS', 'TLBI VALE1IS', 'TLBI ASIDE1IS', 'TLBI VAAE1IS', 'TLBI VAALE1IS', 'TLBI local', 'TLBI range/OS', 'TLBI other', 'AT', 'SYS other', 'DC IVAC', 'DC set/way', 'DC CVAC', 'DC CVAU', 'DC CIVAC', 'IC IALLU', 'IC IALLUIS', 'IC IVAU', 'ISB', 'CLREX', 'YIELD', 'SEV', 'SEVL', 'WFE', 'WFI', 'ERET']
d = json.load(open(sys.argv[1]))
rows = d['rows'] if 'rows' in d else None
def show(name, steps, diag, jit):
    print(f'== {name}: {steps/1e6:.0f}M steps, JIT steps {jit.get("steps",0)/steps*100:.1f}%, dispatches {jit.get("dispatches",0)/steps*1000:.3f} a 1000 steps')
    tot = [0, 0]
    for k, n in enumerate(P95):
        o, e = diag[80 + 2 * k], diag[81 + 2 * k]
        if o or e:
            print(f'  {n:<16} {1000*o/steps:9.4f} / {1000*e:9.4f}'.replace(f'{1000*e:9.4f}', f'{1000*e/steps:9.4f}') + f'   ({o} / {e})')
            if n not in ('ERET', 'WFI', 'WFE', 'ISB'):
                tot[0] += o; tot[1] += e
    print(f'  in scope (all but ERET, WFx, ISB): {1000*tot[0]/steps:.4f} / {1000*tot[1]/steps:.4f}   ({tot[0]} / {tot[1]})')
if rows is not None:
    seen = set()
    for r in rows:
        if r.get('warm') or 'stats' not in r['s'] or (r['workload']) in seen: continue
        seen.add(r['workload'])
        st = r['s']['stats']
        show(r['workload'], st['steps'], st['jit']['diag'], st['jit'])
