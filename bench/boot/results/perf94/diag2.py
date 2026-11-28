# Applies PERF loop 94's second diagnostic to core/src/jit/block.rs (the change applied): counts the guest
# instructions (words) the settling emissions emit, skip and add, packed into the JIT's flag counters (words.py):
# whole emissions' words (the first, whole settling ones, the last), the partial ones' emitted and skipped words, and
# the last emissions' words that the base would have kept (a region that settled in a partial emission).
import sys
p = sys.argv[1]
s = open(p).read()
def sub(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
sub("""        let n = r.blocks.len();
        let (none, mem) = (vec![emit::Regs::default(); n], vec![In::Mem; n]);""",
"""        let n = r.blocks.len();
        let dw: Vec<u64> = r.blocks.iter().map(|b| b.words.len() as u64).collect();
        let dall: u64 = dw.iter().sum();
        let (mut dwhole, mut dred, mut dskip, mut dextra) = (dall, 0u64, 0u64, 0u64);
        let (none, mem) = (vec![emit::Regs::default(); n], vec![In::Mem; n]);""")
sub("""                    let part = (!all && todo.contains(&false)).then_some((&p, &todo[..]));""",
"""                    let part = (!all && todo.contains(&false)).then_some((&p, &todo[..]));
                    if part.is_some() {
                        for i in 0..n {
                            if todo[i] { dred += dw[i] } else { dskip += dw[i] }
                        }
                    } else {
                        dwhole += dall;
                    }""")
sub("""                    if x.whole {
                        last = Some((plain, entry.clone(), flags.clone(), x));
                    }""", """                    if x.whole {
                        last = Some((plain, entry.clone(), flags.clone(), x));
                    } else {
                        dextra += dall;
                    }""")
sub("""        let (mut c, n) = (x.c, x.inl);""", """        let (mut c, n) = (x.c, x.inl);
        if last.is_none() || r.blocks.len() > 0 {
            // the last emission: emitted unless kept (`emit` took `last`)
        }
        c.counts = emit::Counts {
            cond_direct: dwhole,
            flags_stored: dred,
            flags_elided: dskip,
            cond_computed: dextra,
            cond_memory: dall,
        };""")
# the last emission's words: count it when `emit` emitted (not kept)
sub("""                return x;
            }
            emit_region(&env, r, plain, entry, flags, None)
        };""", """                return x;
            }
            DLAST.with(|c| c.set(true));
            emit_region(&env, r, plain, entry, flags, None)
        };""")
sub("""        let mut x = emit(&mut last, plain, &entry, &flags);""", """        DLAST.with(|c| c.set(false));
        let mut x = emit(&mut last, plain, &entry, &flags);
        if DLAST.with(|c| c.get()) {
            dwhole += dall;
        }""")
sub("""/// An emission with the arguments it was emitted with""", """std::thread_local! { static DLAST: core::cell::Cell<bool> = const { core::cell::Cell::new(false) }; }

/// An emission with the arguments it was emitted with""")
open(p, 'w').write(s)
