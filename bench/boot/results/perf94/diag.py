# Applies PERF loop 94's diagnostic to core/src/jit/block.rs (at the loop's base): counts, per region of several
# blocks, the members whose inputs changed each settle iteration, the cost of re-emitting only those, and how many
# unsettled regions would settle given 8 or 16 iterations. Packs them into the JIT's flag counters (counts.py).
import re, sys
p = sys.argv[1]
s = open(p).read()
def sub(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
sub("""        let first = emit_region(&env, r, 0, &none, &mem);""",
"""        let first = emit_region(&env, r, 0, &none, &mem);
        let mut dins: Vec<(Vec<emit::Regs>, Vec<In>)> = vec![(none.clone(), mem.clone())];
        let dedges = first.dedges.clone();""")
sub("""            for _ in 0..4 {
                let x = emit(&mut last, plain, &entry, &flags);""",
"""            for _ in 0..4 {
                dins.push((entry.clone(), flags.clone()));
                let x = emit(&mut last, plain, &entry, &flags);""")
sub("""            if !settled {
                // Edges""",
"""            if !settled {
                // DIAG: Jacobi on, full emissions, to 16 iterations in all.
                let (mut de, mut df) = (entry.clone(), flags.clone());
                for it in 5..=16u64 {
                    let nx = settle(&emit_region(&env, r, plain, &de, &df));
                    if nx == (de.clone(), df.clone()) {
                        dext = it;
                        break;
                    }
                    (de, df) = nx;
                }
                // Edges""")
sub("""        let mut last = Some((0, none, mem, first));""",
"""        let mut last = Some((0, none, mem, first));
        let mut dext = 0u64;""")
sub("""        let (mut c, n) = (x.c, x.inl);
        nzcv_used""",
"""        let (mut c, n) = (x.c, x.inl);
        {
            // DIAG94
            let nb = r.blocks.len() as u64;
            let mut d = emit::Counts::default();
            if nb > 1 {
                let iters = dins.len() as u64 - 1;
                let settled_at = if dins.len() >= 2 && last.is_none() { 0 } else { 0 };
                let _ = settled_at;
                // settled: the loop broke (fewer than 4 iterations, or the 4th showed it)
                let unset = dunset_flag(&dins, &entry, &flags);
                let ch = |a: &(Vec<emit::Regs>, Vec<In>), b: &(Vec<emit::Regs>, Vec<In>)| -> u64 {
                    (0..nb as usize)
                        .filter(|&i| {
                            a.0[i] != b.0[i]
                                || a.1[i] != b.1[i]
                                || dedges.iter().any(|&(f, j)| f == i && a.1[j] != b.1[j])
                        })
                        .count() as u64
                };
                let chs: Vec<u64> = (1..dins.len()).map(|k| ch(&dins[k - 1], &dins[k])).collect();
                let today = nb * (1 + iters + unset as u64);
                let a = nb + chs.iter().sum::<u64>() + nb;
                let b = nb + nb + chs[1..].iter().sum::<u64>() + if !unset && iters == 1 { 0 } else { nb };
                d.cond_direct = today | (if unset { today } else { 0 }) << 32;
                d.flags_stored = unset as u64 | 1 << 32;
                d.flags_elided = a | b << 32;
                if unset {
                    d.cond_computed = a | b << 32;
                    d.cond_memory = (dext > 0 && dext <= 8) as u64 | ((dext > 0) as u64) << 32;
                }
            }
            c.counts = d;
        }
        nzcv_used""")
# unsettled iff 4 iterations ran and the last didn't match: recompute from dins (the 4th input != what came out)
sub("""/// An emission with the arguments it was emitted with""",
"""/// DIAG94: whether the settle loop ended unsettled: four iterations and the final entry isn't the 4th's input
/// (loosened, or moved on).
fn dunset_flag(dins: &[(Vec<emit::Regs>, Vec<In>)], entry: &[emit::Regs], flags: &[In]) -> bool {
    dins.len() == 5 && (&dins[4].0[..], &dins[4].1[..]) != (entry, flags)
}

/// An emission with the arguments it was emitted with""")
sub("""    dead: Vec<bool>,
    bad: bool,
}""", """    dead: Vec<bool>,
    bad: bool,
    dedges: Vec<(usize, usize)>,
}""")
sub("""        dead,
        bad,
    }
}""", """        dead,
        bad,
        dedges,
    }
}""")
sub("""    let mut bad = false;
    let mut inl = 0;""", """    let mut bad = false;
    let mut inl = 0;
    let mut dedges = vec![];""")
sub("""            c.hint(true).if_();
            let (here, fl) = (c.regs, c.flags);""", """            c.hint(true).if_();
            dedges.push((i, j));
            let (here, fl) = (c.regs, c.flags);""")
open(p, 'w').write(s)
