//! Block formation and emission: each instruction inline (`emit`, M5 step 4)
//! or a call to an interpreter helper.
//!
//! A block starts at a physical address and runs straight on: it ends after a
//! branch or a system-class instruction, before an exception-generating or
//! unallocated one, at the end of the 4 KiB page, or at [`CAP`] instructions.
//! Its words are read at compile time, so the block executes the words it saw.

use super::Config;
use super::emit;
use super::wasm::{F64, I32, I64, Module};
use crate::decode::{Op, decode};
use crate::mem::Mem;
use std::collections::HashMap;

/// Instructions per block, at most.
pub const CAP: usize = 32;

/// Block key bits beside the (4-aligned) PA: the EL, and the MMU copy of the
/// interpreter (`SCTLR_EL1.M` or `.A` set), which picks the helper.
pub const KEY_EL1: u64 = 1;
pub const KEY_MMU: u64 = 2;

/// Where an instruction ends a block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    No,
    /// The block includes it and ends there.
    After,
    /// The block ends before it; the interpreter runs it.
    Before,
}

/// Branches and most system-class instructions end a block after them;
/// exception-generating and unallocated encodings end it before them.
/// Hints that are NOPs here (PAC and BTI hint space, CSDB, …), MRS and the
/// data barriers and DC ZVA don't end one, nor do the MSRs of
/// [`crate::interp::sys::msr_continues`].
// ponytail: still conservative for the other system instructions (other MSRs,
// SYS, CLREX, the other DC); relax each with a profile that shows it (M6
// loop 1 did MRS, the barriers and DC ZVA; loop 7 the MSRs above).
pub fn end(w: u32) -> End {
    end_op(decode(w), w)
}

/// [`end`] of `w`, whose class is `op`.
pub fn end_op(op: Op, w: u32) -> End {
    use Op::*;
    match op {
        // DAIF masking and plain registers (M6 loop 7): inline or a helper
        // call that returns mid-block if it leaves.
        MSR_reg | MSR_imm if crate::interp::sys::msr_continues(w) => End::No,
        // MRS, the data barriers and DC ZVA don't end a block (M6 loop 1):
        // the barriers are no-ops for one vCPU, MRS changes nothing but its
        // register, DC ZVA is a 64-byte store, and one that leaves (a timer,
        // a trap, a fault) returns from the block through its helper call,
        // as a load from MMIO does.
        B_uncond | BL | B_cond | CBZ | CBNZ | TBZ | TBNZ | BR | BLR | RET | ERET | MSR_reg
        | MSR_imm | SYS | SYSL | DC_IVAC | DC_ISW | DC_CSW | DC_CISW | DC_CVAC | DC_CVAU
        | DC_CIVAC | IC_IALLU | IC_IALLUIS | IC_IVAU | WFE | WFI | YIELD | SEV | SEVL | CLREX
        | ISB => End::After,
        SVC | HVC | SMC | BRK | HLT | DCPS1 | DCPS2 | DCPS3 | DRPS | UnallocatedEncoding => {
            End::Before
        }
        _ => End::No,
    }
}

/// The words of the block at `pa` (empty if it would have none, or `pa` isn't RAM).
pub fn form(mem: &Mem, pa: u64) -> Vec<u32> {
    form_with(mem, pa, |w, _| w)
}

/// [`form`], each word (with its class) mapped through `f`: one decode a word
/// (the block interpreter's micro-ops).
pub fn form_with<T>(mem: &Mem, pa: u64, mut f: impl FnMut(u32, Op) -> T) -> Vec<T> {
    let mut out = Vec::new();
    let mut a = pa;
    while let Ok(w) = mem.read(a, 4) {
        let (w, op) = (w as u32, decode(w as u32));
        match end_op(op, w) {
            End::Before => break,
            End::After => {
                out.push(f(w, op));
                break;
            }
            End::No => out.push(f(w, op)),
        }
        a += 4;
        if a & 0xfff == 0 || out.len() == CAP {
            break;
        }
    }
    out
}

/// `n` words at `pa` (fewer if they leave RAM).
pub fn read(mem: &Mem, pa: u64, n: usize) -> Vec<u32> {
    (0..n as u64)
        .map_while(|k| mem.read(pa + 4 * k, 4).ok().map(|w| w as u32))
        .collect()
}

/// FNV-1a over a block's words, for the stale-code checker.
pub fn hash(words: &[u32]) -> u64 {
    words.iter().fold(0xcbf2_9ce4_8422_2325, |h, &w| {
        (h ^ w as u64).wrapping_mul(0x100_0000_01b3)
    })
}

/// A block to emit: its key (PA and regime bits), the VA it was first seen at
/// (for its name only) and its words.
pub struct Block {
    pub key: u64,
    pub va: u64,
    pub words: Vec<u32>,
}

/// A block's static successors, as byte offsets from its entry: the target of
/// a direct branch, both of a conditional one (taken, then not), or the next
/// instruction when the block just stops (its cap, the page's end, before an
/// exception-generating instruction) or ends on a system instruction that
/// can't change the regime (ISB, CLREX, YIELD/SEV, DC: when its
/// helper retires, the interpreter would go on to the next instruction in
/// the same regime). None after an indirect branch, ERET, MSR, SYS (TLBI, AT),
/// IC, WFI/WFE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    None,
    One(i64),
    Cond(i64, i64),
}

pub fn next(words: &[u32]) -> Next {
    use Op::*;
    let Some(&w) = words.last() else {
        return Next::None;
    };
    let at = 4 * (words.len() as i64 - 1);
    let (op, ofs) = (decode(w), |hi: u32, lo: u32, bits: u32| {
        crate::interp::sext((crate::interp::bits(w, hi, lo) << 2) as u64, bits) as i64
    });
    match op {
        B_uncond | BL => Next::One(at + ofs(25, 0, 28)),
        B_cond | CBZ | CBNZ => Next::Cond(at + ofs(23, 5, 21), at + 4),
        TBZ | TBNZ => Next::Cond(at + ofs(18, 5, 16), at + 4),
        _ if end(w) == End::No => Next::One(at + 4),
        ISB | CLREX | YIELD | SEV | SEVL | DC_IVAC | DC_ISW | DC_CSW | DC_CISW | DC_CVAC
        | DC_CVAU | DC_CIVAC => Next::One(at + 4),
        _ => Next::None,
    }
}

/// Blocks per region, at most (step 8).
pub const REGION: usize = 16;

/// A region (step 8): a head and other blocks of its page that static edges
/// reach from it, in reverse postorder (`blocks[0]` is the head), compiled
/// into one function. Every other member is reached only through the
/// region's own edges. Either the head's loop ([`region`]: the blocks that
/// lead back to it; without a loop through the head, the head alone), or a
/// forward region ([`forward`]: what the head reaches among the blocks
/// compiled with it).
pub struct Region {
    pub blocks: Vec<Block>,
    /// A loop head compiled alone until it's hot (step 8.3): the index of
    /// its hot word in a table's ([`emit::tier_up`]; its slot).
    pub tier: Option<u32>,
    /// Predicted returns ([`forward`]): the key of a member that ends in
    /// `ret`, reached through a call made in the region, and the VA after
    /// that call. When X30 holds it, the return is an edge to the member
    /// there instead of an indirect branch.
    pub returns: Vec<(u64, u64)>,
}

impl From<Block> for Region {
    fn from(b: Block) -> Region {
        Region {
            blocks: vec![b],
            tier: None,
            returns: vec![],
        }
    }
}

impl Region {
    fn of(blocks: Vec<Block>) -> Region {
        Region {
            blocks,
            tier: None,
            returns: vec![],
        }
    }

    /// The member a return from member `i` is predicted to go to, with the
    /// byte offset from `i`'s entry of the VA it returns to: a later member
    /// (the edge is a forward branch).
    fn returns_to(&self, i: usize) -> Option<(usize, i64)> {
        let b = &self.blocks[i];
        let &(_, va) = self.returns.iter().find(|r| r.0 == b.key)?;
        let j = self.blocks.iter().position(|m| m.va == va)?;
        (j > i).then_some((j, va.wrapping_sub(b.va) as i64))
    }

    /// The member that a static edge of member `i`, to byte offset `off`
    /// from its entry, goes to: the one at that VA (members' VAs are their
    /// offsets from the head's, wherever the region runs).
    fn target(&self, i: usize, off: i64) -> Option<usize> {
        let va = self.blocks[i].va.wrapping_add(off as u64);
        self.blocks.iter().position(|m| m.va == va)
    }

    /// Whether the edge from member `i` to member `j` must check that `j`'s
    /// VA maps to `j`'s page first (MMU on): not when `j` is where `i`'s own
    /// page has it (the code running is `i`'s) or where the head's has it
    /// (what entered the region found the head by its VA, and nothing inside
    /// a region changes a mapping). A member in another page was only found
    /// at that VA when the region was formed.
    fn checked(&self, i: usize, j: usize) -> bool {
        let (head, from, to) = (&self.blocks[0], &self.blocks[i], &self.blocks[j]);
        let follows = |a: &Block| {
            (a.key ^ to.key) >> 12 == 0
                && (to.key & !3).wrapping_sub(a.key & !3) == to.va.wrapping_sub(a.va)
        };
        head.key & KEY_MMU != 0 && !follows(from) && !follows(head)
    }

    /// The members that member `i`'s static edges go to.
    fn targets(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        offsets(&self.blocks[i].words)
            .into_iter()
            .filter_map(move |o| self.target(i, o))
    }
}

/// A block's static successors as byte offsets from its entry (the taken side first).
fn offsets(words: &[u32]) -> Vec<i64> {
    match next(words) {
        Next::None => vec![],
        Next::One(o) => vec![o],
        Next::Cond(t, n) => vec![t, n],
    }
}

/// The key of the block at byte offset `off` from the block at `key`.
fn succ(key: u64, off: i64) -> u64 {
    (key & !3).wrapping_add(off as u64) | (key & 3)
}

/// The keys of a block's static successors (the taken side first).
fn succs(key: u64, words: &[u32]) -> Vec<u64> {
    match next(words) {
        Next::None => vec![],
        Next::One(o) => vec![succ(key, o)],
        Next::Cond(t, n) => vec![succ(key, t), succ(key, n)],
    }
}

/// The region headed by the block at `key` (first seen at `va`): the blocks
/// in its page that `hot(key)` admits, up to [`REGION`], that lead back to
/// the head; empty if the head would have no words.
pub fn region(mem: &Mem, key: u64, va: u64, hot: &dyn Fn(u64) -> bool) -> Region {
    fn visit(
        mem: &Mem,
        b: Block,
        hot: &dyn Fn(u64) -> bool,
        seen: &mut Vec<u64>,
        post: &mut Vec<Block>,
    ) {
        for s in succs(b.key, &b.words) {
            if (s ^ b.key) >> 12 != 0 || seen.contains(&s) || seen.len() >= REGION || !hot(s) {
                continue;
            }
            let words = form(mem, s & !3);
            if !words.is_empty() {
                seen.push(s);
                let va = b.va.wrapping_add(s & !3).wrapping_sub(b.key & !3);
                visit(mem, Block { key: s, va, words }, hot, seen, post);
            }
        }
        post.push(b);
    }
    let words = form(mem, key & !3);
    let mut blocks = vec![];
    if !words.is_empty() {
        visit(
            mem,
            Block { key, va, words },
            hot,
            &mut vec![key],
            &mut blocks,
        );
    }
    blocks.reverse();
    // No words (the code at `key` changed since it was queued): no region.
    if blocks.is_empty() {
        return Region::of(blocks);
    }
    // Only the loop: the blocks from which the head is reachable.
    let mut keep = vec![false; blocks.len()];
    keep[0] = true;
    let mut changed = true;
    while changed {
        changed = false;
        for i in 1..blocks.len() {
            let kept = |s: u64| blocks.iter().zip(&keep).any(|(m, &k)| k && m.key == s);
            if !keep[i] && succs(blocks[i].key, &blocks[i].words).into_iter().any(kept) {
                (keep[i], changed) = (true, true);
            }
        }
    }
    let mut k = keep.into_iter();
    blocks.retain(|_| k.next().expect("one per block"));
    Region::of(blocks)
}

/// The forward region headed by the block at `key`: the blocks that static
/// edges reach from it and `member` admits, up to [`REGION`], in reverse
/// postorder. `member(va, key)` gets a successor's VA and, when it is in its
/// predecessor's page, its key; it gives the key of the block to take (for
/// one in another page: the block it knows at that VA, which the emitted
/// edge checks is still there, [`Region::checked`]).
///
/// **Calls are followed**, and a `ret` (of X30) in what a call reaches is
/// predicted to return after that call: the block there is taken as the
/// `ret` block's successor ([`Region::returns`]), so a call and its return
/// can both stay inside the function. A callee reached from a second call
/// keeps its first prediction.
///
/// Where [`region`] is a loop, compiled once its head is hot, this is
/// straight-line code, its branches and its calls, compiled together the
/// first time (`Cache::plan`): the edges between its blocks keep registers
/// and flags in locals instead of leaving one function for the next. Empty
/// if the head would have no words.
pub fn forward(
    mem: &Mem,
    key: u64,
    va: u64,
    member: &dyn Fn(u64, Option<u64>) -> Option<u64>,
) -> Region {
    struct Walk<'a> {
        mem: &'a Mem,
        member: &'a dyn Fn(u64, Option<u64>) -> Option<u64>,
        /// The blocks taken so far: (key, VA).
        seen: Vec<(u64, u64)>,
        post: Vec<Block>,
        returns: Vec<(u64, u64)>,
    }
    impl Walk<'_> {
        /// Takes the block at `va` (`near`: its key, if it's in the page of
        /// the block that leads to it) unless it or its VA is taken, and
        /// what it reaches; `calls` are the returns pending: the VA after
        /// each call on the way here, and its key if it's in the call's page.
        fn take(&mut self, va: u64, near: Option<u64>, calls: &[(u64, Option<u64>)]) {
            if self.seen.len() >= REGION {
                return;
            }
            let Some(key) = (self.member)(va, near) else {
                return;
            };
            if self.seen.iter().any(|&(k, v)| k == key || v == va) {
                return;
            }
            let words = form(self.mem, key & !3);
            if !words.is_empty() {
                self.seen.push((key, va));
                self.visit(Block { key, va, words }, calls);
            }
        }

        fn visit(&mut self, b: Block, calls: &[(u64, Option<u64>)]) {
            let last = b.words.last().copied().unwrap_or(0);
            let after = 4 * b.words.len() as i64;
            match decode(last) {
                Op::BL => {
                    let k = succ(b.key, after);
                    let near = ((k ^ b.key) >> 12 == 0).then_some(k);
                    let mut calls = calls.to_vec();
                    calls.push((b.va.wrapping_add(after as u64), near));
                    for o in offsets(&b.words) {
                        self.edge(&b, o, &calls);
                    }
                }
                Op::RET if crate::interp::bits(last, 9, 5) == 30 => {
                    if let Some((&(va, near), calls)) = calls.split_last() {
                        self.returns.push((b.key, va));
                        self.take(va, near, calls);
                    }
                }
                _ => {
                    for o in offsets(&b.words) {
                        self.edge(&b, o, calls);
                    }
                }
            }
            self.post.push(b);
        }

        fn edge(&mut self, b: &Block, o: i64, calls: &[(u64, Option<u64>)]) {
            let k = succ(b.key, o);
            let near = ((k ^ b.key) >> 12 == 0).then_some(k);
            self.take(b.va.wrapping_add(o as u64), near, calls);
        }
    }
    let mut w = Walk {
        mem,
        member,
        seen: vec![(key, va)],
        post: vec![],
        returns: vec![],
    };
    let words = form(mem, key & !3);
    if !words.is_empty() {
        w.visit(Block { key, va, words }, &[]);
    }
    w.post.reverse();
    Region {
        blocks: w.post,
        tier: None,
        returns: w.returns,
    }
}

impl Region {
    /// Whether a member branches back to the head.
    pub fn looped(&self) -> bool {
        self.back_edges() > 0
    }

    /// The members (not the head) that no member branches back to: none
    /// heads an inner loop.
    pub fn inner_free(&self) -> Vec<u64> {
        let back = |j: usize| (j..self.blocks.len()).any(|i| self.targets(i).any(|t| t == j));
        (1..self.blocks.len())
            .filter(|&j| !back(j))
            .map(|j| self.blocks[j].key)
            .collect()
    }

    /// The edges back to the head.
    pub fn back_edges(&self) -> usize {
        (0..self.blocks.len())
            .map(|i| self.targets(i).filter(|&t| t == 0).count())
            .sum()
    }
}

/// What [`module`] emitted: the module; for each region its inline
/// instruction count and the keys of the blocks it chains to; the flag counts.
pub struct Emitted {
    pub bytes: Vec<u8>,
    pub inl: Vec<u32>,
    pub links: Vec<Vec<u64>>,
    pub counts: emit::Counts,
}

/// What every region of a module is emitted against.
struct Env<'a> {
    /// The functions of successors outside a region: this batch's own, or imports.
    funcs: &'a HashMap<u64, (u32, u32)>,
    cx: emit::Ctx,
    /// The block function type, the checker's import, whether there's a jump cache.
    bt: u32,
    checker: Option<u32>,
    jc: bool,
    /// `jit_hot`, for the tier-up prologues.
    hot: Option<u32>,
    /// The transfer cache's miss functions for EL0 and EL1 with the MMU on
    /// ([`miss_module`]), imported by a module with a jump cache and such blocks.
    xmiss: [Option<u32>; 2],
    /// RAM's host base and guest PA.
    base: u64,
    phys: u64,
    /// Each member's groups of accesses ([`emit::plan`]).
    plans: Vec<Vec<emit::Role>>,
}

impl Env<'_> {
    /// The miss function for a block (with the MMU on) at `key`.
    fn miss(&self, key: u64) -> u32 {
        self.xmiss[(key & KEY_EL1) as usize].expect("a miss function for the block's regime")
    }
}

/// One module with a function per region, `f(vcpu, acc, left) -> acc +
/// retired`, named `<va>_pa<pa>` after its head. Instruction *i* of a block
/// is inline or `if helper(vcpu, insn_i, pc + 4i) { return acc + i }`, with
/// `pc` read at entry: regions are keyed by PA, so one can run at any VA that
/// maps its page. Helpers set `Cpu::pc` themselves; a block that ends on an
/// inline instruction other than a branch stores it before returning.
/// Registers in locals are written back before each helper call and before
/// returns, and reloaded on use after a helper (which may have written any of
/// them); lazy flags are stored at the same points.
///
/// **Regions** (step 8): the blocks are nested wasm `block`s in reverse
/// postorder, and an edge to a later member is a `br` to its label when
/// `left` covers both blocks, adding the block's length to `acc` and taking
/// it from `left` on the way; register locals stay live across it (the edge
/// conforms them to the member's entry state, [`emit::Func::conform`]).
/// Other edges leave the region through the chaining tails below.
///
/// **Chaining** (step 7): a block whose successor is static and compiled (in
/// this batch, or already: `compiled(key)` gives its table index and length,
/// and the module imports it as `t.<index>`) tail-calls it with `acc + len`
/// and `left - len` when `left` covers both, so a chain retires exactly what
/// the dispatcher would have run. With the MMU on, a successor in another
/// page is chained behind an instruction-TLB check (keys are PAs: another
/// page may map elsewhere). A block that ends on BR, BLR or RET looks its
/// target up in the jump cache if `jc` (the vCPU's table's: the module's bytes
/// are the same in every table) and tail-calls it through
/// the table on a hit (`emit::indirect`). With `cfg.check`, each chained entry
/// calls `jit_check` first (the stale-code checker, as the dispatcher runs it);
/// the memory is imported as `cfg.pages` says.
pub fn module(
    regions: &[Region],
    mem: &Mem,
    compiled: impl Fn(u64) -> Option<(u32, u32)>,
    cfg: &Config,
    jc: bool,
    features: u64,
    xmiss: Option<u32>,
) -> Emitted {
    let crypto = features & crate::cpu::FEATURE_CRYPTO != 0;
    let sha3 = crate::cpu::has_sha3(features);
    let parallel = features & crate::cpu::FEATURE_PARALLEL != 0;
    let mut m = Module::default();
    let bt = m.ty(&[I32, I32, I32], &[I32]);
    let ht = m.ty(&[I32, I32, I64], &[I32]);
    let flat = m.import_func("env", "jit_exec_flat", ht);
    let mmu = m.import_func("env", "jit_exec_mmu", ht);
    let checker = cfg.check.then(|| {
        let ct = m.ty(&[I32, I64], &[]);
        m.import_func("env", "jit_check", ct)
    });
    let tiers = regions.iter().any(|r| r.tier.is_some());
    let hot = tiers.then(|| {
        let t = m.ty(&[I32, I64, I64], &[]);
        m.import_func("env", "jit_hot", t)
    });
    // Successors outside their region: this batch's heads, or imports.
    let heads = |k| regions.iter().any(|r| r.blocks[0].key == k);
    let mut funcs: HashMap<u64, (u32, u32)> = HashMap::new();
    for r in regions {
        for b in &r.blocks {
            for k in succs(b.key, &b.words) {
                if funcs.contains_key(&k) || heads(k) {
                    continue;
                }
                if let Some((idx, len)) = compiled(k) {
                    let f = m.import_func("t", &idx.to_string(), bt);
                    funcs.insert(k, (f, len));
                }
            }
        }
    }
    // The transfer cache's miss functions for the regimes with the MMU on.
    let mut misses = [None; 2];
    for (el, x) in misses.iter_mut().enumerate() {
        let regime = KEY_MMU | el as u64;
        if let Some(idx) = xmiss.filter(|_| jc)
            && regions.iter().any(|r| r.blocks[0].key & 3 == regime)
        {
            *x = Some(m.import_func("t", &(idx + el as u32).to_string(), bt));
        }
    }
    // The host clock, for a counter read (parallel SMP).
    let clock = (parallel
        && regions.iter().flat_map(|r| &r.blocks).any(|b| {
            b.words
                .iter()
                .any(|&w| crate::interp::sys::is_counter_mrs(w))
        }))
    .then(|| {
        let t = m.ty(&[], &[F64]);
        m.import_func("env", "now_ms", t)
    });
    m.import_core_memory(cfg.pages);
    // The spill memories with an inline arm (docs/spill-memories.md "The JIT's spill arm"): memories 1 to `spill`.
    let spill = cfg.inline_spill();
    for (k, &pages) in cfg.spill[..spill as usize].iter().enumerate() {
        m.import_memory("env", &format!("ram{}", k + 1), pages, pages);
    }
    if parallel {
        let z = m.zero_global();
        debug_assert_eq!(z, emit::ZERO_GLOBAL);
    }
    if jc || tiers {
        m.import_table("env", "table", 0);
    }
    let first = m.next_func();
    for (k, r) in regions.iter().enumerate() {
        let h = &r.blocks[0];
        funcs.insert(h.key, (first + k as u32, h.words.len() as u32));
    }

    let mut out = Emitted {
        bytes: vec![],
        inl: Vec::with_capacity(regions.len()),
        links: Vec::with_capacity(regions.len()),
        counts: emit::Counts::default(),
    };
    let (base, phys) = mem.base();
    let pair_locks = mem.pair_locks() as usize as u32;
    for r in regions {
        let head = &r.blocks[0];
        let cx = if head.key & KEY_MMU != 0 {
            let read = emit::tlb_array(head.key & KEY_EL1, 0);
            emit::Ctx {
                helper: mmu,
                bus: emit::Bus::Tlb { read },
                el1: head.key & KEY_EL1 != 0,
                crypto,
                sha3,
                parallel,
                pair_locks,
                clock,
                spill,
                groups: emit::GROUPS,
            }
        } else {
            let (base, size) = (base as usize as u32, mem.size());
            emit::Ctx {
                helper: flat,
                bus: emit::Bus::Flat { base, phys, size },
                el1: head.key & KEY_EL1 != 0,
                crypto,
                sha3,
                parallel,
                pair_locks,
                clock,
                spill: 0,
                groups: false,
            }
        };
        let env = Env {
            funcs: &funcs,
            cx,
            bt,
            checker,
            jc,
            hot,
            xmiss: misses,
            base: base as usize as u64,
            phys,
            plans: r.blocks.iter().map(|b| emit::plan(&b.words, &cx)).collect(),
        };
        // Twice: the first emission finds the registers to read plainly
        // (`Func::plain`) and what each member's edges carry into it, which
        // the second starts it with.
        //
        // A loop reads its registers on every iteration, so none is plain
        // there, and its entry states feed on each other (the head's comes
        // from the back-edges): emitted again until they settle (or four times).
        //
        // Flags likewise (step 8.4): the first emission finds the members
        // whose flags are dead at entry, and what lazy flags the edges carry.
        let n = r.blocks.len();
        let mem = vec![In::Mem; n];
        let first = emit_region(&env, r, 0, &vec![emit::Regs::default(); n], &mem);
        let plain = if r.looped() {
            0
        } else {
            first.c.read & !first.c.reused
        };
        let settle = |x: &Emission| -> (Vec<emit::Regs>, Vec<In>) {
            let regs = x.into.iter().map(|s| s.merge(*s, plain)).collect();
            let flags = (0..n)
                .map(|j| match x.flags[j] {
                    _ if first.dead[j] => In::Dead,
                    In::Lazy(k, sf) if j > 0 => In::Lazy(k, sf),
                    _ => In::Mem,
                })
                .collect();
            (regs, flags)
        };
        let (mut entry, mut flags) = settle(&first);
        if n > 1 {
            for _ in 0..4 {
                let next = settle(&emit_region(&env, r, plain, &entry, &flags));
                if next == (entry.clone(), flags.clone()) {
                    break;
                }
                (entry, flags) = next;
            }
        }
        let mut x = emit_region(&env, r, plain, &entry, &flags);
        if x.bad {
            // The lazy states didn't settle: flags in memory on every edge.
            let dead = |j: usize| if first.dead[j] { In::Dead } else { In::Mem };
            x = emit_region(
                &env,
                r,
                plain,
                &entry,
                &(0..n).map(dead).collect::<Vec<_>>(),
            );
            assert!(!x.bad);
        }
        let (mut c, n) = (x.c, x.inl);
        let name = format!("{:#x}_pa{:#x}", head.va, head.key & !3);
        let locals = c.locals();
        m.func(bt, &locals, &c.c, &name);
        out.inl.push(n);
        let mut links = vec![];
        for (i, b) in r.blocks.iter().enumerate() {
            for o in offsets(&b.words) {
                // What leaves the region for a compiled block, or may (an
                // edge whose check fails).
                let k = succ(b.key, o);
                let stays = r
                    .target(i, o)
                    .is_some_and(|j| (j > i || j == 0) && !r.checked(i, j));
                if !stays && funcs.contains_key(&k) && !links.contains(&k) {
                    links.push(k);
                }
            }
        }
        out.links.push(links);
        out.counts += c.counts;
    }
    out.bytes = m.finish();
    out
}

/// The transfer cache's miss functions (`emit::xmiss`) for a JIT cache: one
/// module, `f0` for EL0 and `f1` for EL1 (MMU on), and the stale-code
/// checker with `check`. A table installs it once, so it gets hot and
/// optimized (a copy in each module stayed in Liftoff).
pub fn miss_module(mem: &Mem, check: bool, pages: u32) -> Vec<u8> {
    let mut m = Module::default();
    let bt = m.ty(&[I32, I32, I32], &[I32]);
    let checker = check.then(|| {
        let ct = m.ty(&[I32, I64], &[]);
        m.import_func("env", "jit_check", ct)
    });
    m.import_core_memory(pages);
    m.import_table("env", "table", 0);
    let (base, phys) = mem.base();
    for el in 0..2 {
        let tlb = (emit::tlb_array(el, 2), base as usize as u64, phys);
        let mut c = emit::xmiss(KEY_MMU | el, tlb, bt, checker);
        let locals = c.locals();
        m.func(bt, &locals, &c.c, &format!("xmiss_el{el}"));
    }
    m.finish()
}

/// Where a region member's flags are at its entry (step 8.4): lazy from its
/// edges (every edge carries the same setter), in memory, or dead (a setter
/// comes before anything that reads them). The head's are never lazy: the
/// function starts with NZCV in memory. Merging edges: `Unset` is none yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum In {
    Unset,
    Lazy(emit::Kind, bool),
    Mem,
    Dead,
}

impl In {
    fn merge(self, o: In) -> In {
        match (self, o) {
            (In::Unset, x) | (x, In::Unset) => x,
            (a, b) if a == b => a,
            _ => In::Mem,
        }
    }
}

/// One emission of a region: the function, its inline instruction count,
/// each member's merged incoming register and flag states, whether each
/// member's flags are dead at its entry, and whether an edge carried lazy
/// flags other than its member's entry state (then emitted again, flags in
/// memory).
struct Emission {
    c: emit::Func,
    inl: u32,
    into: Vec<emit::Regs>,
    flags: Vec<In>,
    dead: Vec<bool>,
    bad: bool,
}

/// One emission of region `r` with the registers in `plain` read without a
/// local, each member starting in its `entry` register state and `fin` flag
/// state.
fn emit_region(e: &Env, r: &Region, plain: u64, entry: &[emit::Regs], fin: &[In]) -> Emission {
    let n = r.blocks.len();
    let head = r.blocks[0].va;
    let mut c = emit::Func::default();
    c.plain = plain;
    let mut into = vec![emit::Regs::default(); n];
    let mut flags = vec![In::Unset; n];
    let mut dead = vec![false; n];
    let mut bad = false;
    let mut inl = 0;
    c.local_get(0).i64_load(emit::PC).local_set(1);
    if let (Some(word), Some(hot)) = (r.tier, e.hot) {
        emit::tier_up(&mut c, word, r.blocks[0].key, e.bt, hot);
    }
    // The head's state: loaded once, before the loop.
    c.conform(entry[0]);
    let looped = r.looped();
    if looped {
        c.loop_();
    }
    for _ in 1..n {
        c.block();
    }
    for (i, b) in r.blocks.iter().enumerate() {
        if i > 0 {
            c.end(); // member i's label
        }
        c.base = b.va.wrapping_sub(head) as i64;
        c.regs = entry[i];
        c.fp_ok = false;
        c.fpa_ok = false;
        c.words.clone_from(&b.words);
        c.plan.clone_from(&e.plans[i]);
        c.enter_flags(match fin[i] {
            In::Lazy(k, sf) => Some((k, sf)),
            _ => None,
        });
        let len = b.words.len() as u32;
        let internal = |off: i64| r.target(i, off).filter(|&j| j > i || j == 0);
        // A successor that leaves the region: not a member, or one whose
        // edge has a check that may fail.
        let leaves = |off: i64| internal(off).is_none_or(|j| r.checked(i, j));
        let succs = next(&b.words);
        // An edge to member `j` with these lazy flags must store NZCV first.
        let store = |j: usize, lazy: Option<(emit::Kind, bool)>| match fin[j] {
            In::Dead => false,
            In::Lazy(k, sf) => lazy != Some((k, sf)),
            _ => true,
        };
        // A successor that's a member: the PC is stored only on the way out
        // (after the edges to members, which leave first), so a loop whose
        // back-edge is conditional doesn't store it every iteration.
        c.defer_pc = match succs {
            Next::One(o) => internal(o).is_some(),
            Next::Cond(t, o) => internal(t).is_some() || internal(o).is_some(),
            Next::None => false,
        };
        let mut last = false;
        let mut skip = false;
        for (k, &w) in b.words.iter().enumerate() {
            // The second word of a fused pair was emitted with the first.
            if core::mem::take(&mut skip) {
                inl += 1;
                continue;
            }
            let op = decode(w);
            // NZCV is stored before the block's branch (see `commit_flags`),
            // unless a successor is a member and none that is needs it: the
            // exits then store it on their own paths (`sync_flags` below), so
            // a loop that leaves on one side doesn't store it every iteration.
            if end(w) == End::After {
                let lazy = c.lazy();
                let keep = |o: i64| internal(o).map(|j| !store(j, lazy));
                let keep = match succs {
                    Next::One(o) => keep(o).unwrap_or(false),
                    Next::Cond(t, o) => match (keep(t), keep(o)) {
                        (None, None) => false,
                        (a, b) => a.unwrap_or(true) && b.unwrap_or(true),
                    },
                    Next::None => false,
                };
                if !keep {
                    c.commit_flags();
                }
            }
            c.next = b.words.get(k + 1).copied().unwrap_or(0);
            c.prev = if k > 0 { b.words[k - 1] } else { 0 };
            last = emit::inline(&mut c, w, op, k, &e.cx);
            skip = core::mem::take(&mut c.fused);
            if last {
                inl += 1;
                // Branches end blocks and set the PC.
                last = end(w) == End::No;
                continue;
            }
            assert!(!c.grouped(), "a helper call inside a group of accesses");
            c.flush();
            c.sync_flags();
            c.local_get(0).i32_const(w as i32);
            emit::pc_plus(&mut c, 4 * k as i64);
            c.call(e.cx.helper).hint(false).if_();
            c.ret(k as u32);
            c.end();
            c.forget(!0);
        }
        c.chain_close();
        if last && !c.defer_pc {
            emit::set_pc(&mut c, 4 * len as i64);
        }
        dead[i] = c.touched == Some(false);
        // Edges to later members and back to the head: NZCV stored on the
        // way unless the member's flags are dead or its edges' lazy ones.
        // `when`: an i32 on the stack that must hold too.
        let mut edge = |c: &mut emit::Func, j: usize, depth: u32, when: bool| {
            let to = &r.blocks[j];
            let jlen = to.words.len() as u32;
            c.local_get(emit::LEFT)
                .i32_const((len + jlen) as i32)
                .op(0x4f); // i32.ge_u
            if when {
                c.op(0x71); // i32.and
            }
            if r.checked(i, j) {
                let exec = emit::tlb_array(b.key & KEY_EL1, 2);
                let host = e.base.wrapping_add((to.key & !3) - e.phys);
                emit::maps_to(c, to.va.wrapping_sub(b.va) as i64, exec, host);
                c.op(0x71); // i32.and
            }
            c.hint(true).if_();
            let (here, fl) = (c.regs, c.flags);
            into[j] = into[j].merge(here, 0);
            let lazy = c.lazy();
            flags[j] = flags[j].merge(lazy.map_or(In::Mem, |(k, sf)| In::Lazy(k, sf)));
            if store(j, lazy) {
                c.commit_flags();
            }
            bad |= matches!(fin[j], In::Lazy(..)) && store(j, lazy);
            c.conform(entry[j]);
            c.local_get(emit::ACC).i32_const(len as i32).op(0x6a); // i32.add
            c.local_set(emit::ACC);
            c.local_get(emit::LEFT).i32_const(len as i32).op(0x6b); // i32.sub
            c.local_set(emit::LEFT);
            // Around a loop, the stale-code checker runs as at a chained entry.
            if let (0, Some(chk)) = (j, e.checker) {
                c.local_get(0).i64_const(r.blocks[0].key as i64).call(chk);
            }
            // The loop's label is outside every member's.
            let label = if j == 0 { n - 1 - i } else { j - i - 1 };
            c.br(label as u32 + depth + 1).end();
            (c.regs, c.flags) = (here, fl);
        };
        match succs {
            Next::One(o) => {
                if let Some(j) = internal(o) {
                    edge(&mut c, j, 0, false);
                }
            }
            Next::Cond(t, o) => match (internal(t), internal(o)) {
                (None, None) => {}
                (jt, jo) => {
                    c.local_get(emit::TAKEN);
                    if jt.is_none() {
                        c.op(0x45); // i32.eqz
                    }
                    c.if_();
                    edge(&mut c, jt.or(jo).expect("one side"), 1, false);
                    if let (Some(_), Some(j)) = (jt, jo) {
                        c.else_();
                        edge(&mut c, j, 1, false);
                    }
                    c.end();
                }
            },
            // A return predicted to its call's site.
            Next::None => {
                if let Some((j, off)) = r.returns_to(i) {
                    emit::returns_to(&mut c, off);
                    edge(&mut c, j, 0, true);
                }
            }
        }
        // The rest leave the region (or stay when `left` doesn't cover them).
        c.flush();
        c.sync_flags();
        if c.defer_pc {
            c.local_get(0);
            match succs {
                Next::One(o) => emit::pc_plus(&mut c, o),
                Next::Cond(t, o) => {
                    emit::pc_plus(&mut c, t);
                    emit::pc_plus(&mut c, o);
                    c.local_get(emit::TAKEN).select();
                }
                Next::None => unreachable!("members only"),
            }
            c.i64_store(emit::PC);
            c.defer_pc = false;
        }
        match succs {
            Next::One(o) => {
                if leaves(o) {
                    chain(e, &mut c, b, o);
                }
            }
            Next::Cond(t, o) => match (leaves(t), leaves(o)) {
                (true, true) => {
                    c.local_get(emit::TAKEN).if_();
                    chain(e, &mut c, b, t);
                    c.else_();
                    chain(e, &mut c, b, o);
                    c.end();
                }
                (false, false) => {}
                (lt, _) => {
                    c.local_get(emit::TAKEN);
                    if !lt {
                        c.op(0x45); // i32.eqz
                    }
                    c.if_();
                    chain(e, &mut c, b, if lt { t } else { o });
                    c.end();
                }
            },
            Next::None => {
                let op = b.words.last().map(|&w| decode(w));
                if e.jc && matches!(op, Some(Op::BR | Op::BLR | Op::RET)) {
                    let miss = (b.key & KEY_MMU != 0).then(|| e.miss(b.key));
                    emit::indirect(&mut c, b.key & 3, miss, len, e.bt, e.checker);
                }
            }
        }
        c.ret(len);
    }
    if looped {
        c.end().op(0x00); // the loop; unreachable
    }
    c.end();
    Emission {
        c,
        inl,
        into,
        flags,
        dead,
        bad,
    }
}

/// The chaining tail of block `b` to its successor at `off`: a direct tail
/// call if it's compiled, else (with a jump cache) through the jump cache,
/// which has it once it's compiled and entered. With the MMU on, a successor
/// in another page is wherever its VA maps: the block's PA plus `off` (`k`)
/// only if the two pages are contiguous physically too (the kernel's image,
/// not a process's file pages). So the direct call to `k` is behind a check
/// that the VA maps there (the instruction TLB of the block's EL), and
/// otherwise the successor is found as an indirect branch's target is, by
/// its VA in the transfer cache.
fn chain(e: &Env, c: &mut emit::Func, b: &Block, off: i64) {
    let k = succ(b.key, off);
    let len = b.words.len() as u32;
    let f = e.funcs.get(&k);
    if f.is_none() && !e.jc {
        return;
    }
    let guarded = b.key & KEY_MMU != 0 && (k ^ b.key) >> 12 != 0;
    let exec = emit::tlb_array(b.key & KEY_EL1, 2);
    // The PC is in the `Cpu` by now: the successor's VA.
    let by_va = |c: &mut emit::Func| {
        let miss = Some(e.miss(b.key));
        emit::indirect(c, b.key & 3, miss, len, e.bt, e.checker);
    };
    let Some(&(f, tlen)) = f else {
        if guarded {
            return by_va(c);
        }
        c.i32_const(1);
        return emit::via_jc(c, Some(k), len, e.bt, e.checker);
    };
    c.local_get(emit::LEFT)
        .i32_const((len + tlen) as i32)
        .op(0x4f); // i32.ge_u
    if guarded {
        let host = e.base.wrapping_add((k & !3) - e.phys);
        emit::maps_to(c, off, exec, host);
        c.op(0x71); // i32.and
    }
    c.hint(true).if_();
    if let Some(chk) = e.checker {
        c.local_get(0).i64_const(k as i64).call(chk);
    }
    c.local_get(0);
    c.local_get(emit::ACC).i32_const(len as i32).op(0x6a); // i32.add
    c.local_get(emit::LEFT).i32_const(len as i32).op(0x6b); // i32.sub
    c.return_call(f).end();
    if guarded && e.jc {
        by_va(c);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOP: u32 = 0xd503201f;
    const ADD: u32 = 0x91000c41; // add x1, x2, #3
    const PACIASP: u32 = 0xd503233f;
    const MOVZ: u32 = 0xd2800061; // movz x1, #3
    const MSR: u32 = 0xd51b4200; // msr nzcv, x0

    fn mem_with(at: u64, words: &[u32]) -> (Vec<u128>, Mem) {
        let mut ram = vec![0u128; 0x4000 / 16];
        // SAFETY: `ram` outlives the Mem in each test and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x4000) };
        for (k, &w) in words.iter().enumerate() {
            mem.write(at + 4 * k as u64, 4, w as u64).unwrap();
        }
        (ram, mem)
    }

    /// A module of one block, nothing else compiled.
    fn build(b: Block) -> Emitted {
        module(
            &[b.into()],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        )
    }

    fn test_mem() -> Mem {
        // SAFETY: never accessed (module only reads its layout).
        unsafe { Mem::new(core::ptr::dangling_mut::<u128>().cast(), 0) }
    }

    #[test]
    fn end_rules() {
        for (w, e) in [
            (0x14000000, End::After),  // b .
            (0x94000000, End::After),  // bl .
            (0x54000041, End::After),  // b.ne
            (0xb4000000, End::After),  // cbz x0
            (0x36000000, End::After),  // tbz w0, #0
            (0xd61f0000, End::After),  // br x0
            (0xd63f0000, End::After),  // blr x0
            (0xd65f03c0, End::After),  // ret
            (0xd69f03e0, End::After),  // eret
            (0xd53b4200, End::No),     // mrs x0, nzcv (M6 loop 1)
            (0xd51b4200, End::After),  // msr nzcv, x0
            (0xd508871f, End::After),  // tlbi vmalle1
            (0xd50b7520, End::After),  // ic ivau, x0
            (0xd503207f, End::After),  // wfi
            (0xd5033bbf, End::No),     // dmb ish (M6 loop 1)
            (0xd5033fdf, End::After),  // isb
            (0xd4000001, End::Before), // svc #0
            (0xd4000002, End::Before), // hvc #0
            (0xd4200000, End::Before), // brk #0
            (0x00000000, End::Before), // udf #0
            (NOP, End::No),
            (PACIASP, End::No),
            (ADD, End::No),
            (0xf9400020, End::No),    // ldr x0, [x1]
            (0xd50343df, End::No),    // msr daifset, #3
            (0xd51b4220, End::No),    // msr daif, x0
            (0xd5184020, End::No),    // msr elr_el1, x0
            (0xd50342ff, End::After), // msr daifclr, #2
            (0xd51b4200, End::After), // msr nzcv, x0
            (0xd5181040, End::After), // msr cpacr_el1, x0
        ] {
            assert_eq!(end(w), e, "{w:#010x}");
        }
    }

    #[test]
    fn formation() {
        let (_r, m) = mem_with(0x100, &[ADD, PACIASP, 0x54000041, ADD]);
        assert_eq!(form(&m, 0x100), [ADD, PACIASP, 0x54000041]); // ends after b.ne
        let (_r, m) = mem_with(0x100, &[ADD, ADD, 0xd4000001, ADD]);
        assert_eq!(form(&m, 0x100), [ADD, ADD]); // ends before svc
        assert_eq!(form(&m, 0x108), []); // starts on svc: no block
        // The page's end, and the cap.
        let (_r, m) = mem_with(0xff8, &[ADD, ADD, ADD]);
        assert_eq!(form(&m, 0xff8), [ADD, ADD]);
        let (_r, m) = mem_with(0x1000, &[NOP; 40]);
        assert_eq!(form(&m, 0x1000).len(), CAP);
        // Outside RAM.
        assert_eq!(form(&m, 0x4000), []);
        let (_r, m) = mem_with(0x3ffc, &[ADD]);
        assert_eq!(form(&m, 0x3ffc), [ADD]);
    }

    #[test]
    fn two_instruction_block_bytes() {
        let b = Block {
            key: 0x4000_0100 | KEY_EL1 | KEY_MMU,
            va: 0xffff_0100,
            words: vec![MOVZ, MSR],
        };
        let Emitted { bytes, inl, .. } = build(b);
        assert_eq!(inl, [1]);
        #[rustfmt::skip]
        let body = [
            1, 2, I64,                              // locals: the entry PC and x1, all it uses
            0x20, 0, 0x29, 3, 0x80, 2, 0x21, 3,     // local.get 0; i64.load 256; local.set 3
            0x42, 3, 0x21, 4,                       // movz inline: x1 (local 4) = 3
            0x20, 0, 0x20, 4, 0x37, 3, 8,           // written back before the helper
            0x20, 0, 0x41, 0x80, 0x84, 0xed, 0xa8, 0x7d, 0x20, 3, 0x42, 4, 0x7c, // msr, pc + 4
            0x10, 1, 0x04, 0x40,                    // call mmu; if (hinted unlikely, at 37):
            0x20, 1, 0x41, 1, 0x6a, 0x0f, 0x0b,     //   return acc + 1
            0x20, 1, 0x41, 2, 0x6a, 0x0f, 0x0b,     // return acc + 2 (MSR ends it: no chaining)
        ];
        let name = b"0xffff0100_pa0x40000100";
        #[rustfmt::skip]
        let mut want = vec![
            0, b'a', b's', b'm', 1, 0, 0, 0,
            1, 15, 2, 0x60, 3, I32, I32, I32, 1, I32, 0x60, 3, I32, I32, I64, 1, I32, // types
            2, 57, 3, // imports
            3, b'e', b'n', b'v', 13, b'j', b'i', b't', b'_', b'e', b'x', b'e', b'c', b'_', b'f', b'l', b'a', b't', 0, 1,
            3, b'e', b'n', b'v', 12, b'j', b'i', b't', b'_', b'e', b'x', b'e', b'c', b'_', b'm', b'm', b'u', 0, 1,
            3, b'e', b'n', b'v', 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 3, 0, 0x80, 0x80, 4,
            3, 2, 1, 0, // function section
            7, 6, 1, 2, b'f', b'0', 0, 2, // export f0 = function 2
            0, 32, 25, // branch hints: function 2, one hint, at 37, unlikely
            b'm', b'e', b't', b'a', b'd', b'a', b't', b'a', b'.', b'c', b'o', b'd', b'e', b'.',
            b'b', b'r', b'a', b'n', b'c', b'h', b'_', b'h', b'i', b'n', b't', 1, 2, 1, 37, 1, 0,
            10, 2 + body.len() as u8, 1, body.len() as u8,
        ];
        want.extend(body);
        want.extend([0, 7 + 3 + name.len() as u8, 4, b'n', b'a', b'm', b'e', 1]);
        want.extend([3 + name.len() as u8, 1, 2, name.len() as u8]);
        want.extend(name);
        assert_eq!(bytes, want);
    }

    #[test]
    fn a_block_ending_inline_stores_the_pc() {
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![MOVZ, MOVZ],
        };
        let Emitted { bytes, inl, .. } = build(b);
        assert_eq!(inl, [2]);
        // vcpu; entry + 8; i64.store 256; x1 written back; return acc + 2 (the
        // next block isn't compiled: nothing to chain to)
        #[rustfmt::skip]
        let tail = [
            0x20, 0, 0x20, 3, 0x42, 8, 0x7c, 0x37, 3, 0x80, 2,
            0x20, 0, 0x20, 4, 0x37, 3, 8, 0x20, 1, 0x41, 2, 0x6a, 0x0f, 0x0b,
        ];
        assert!(bytes.windows(tail.len()).any(|w| w == tail));
    }

    fn has(bytes: &[u8], w: &[u8]) -> bool {
        bytes.windows(w.len()).any(|x| x == w)
    }

    #[test]
    fn registers_stay_in_locals() {
        // add x1, x2, #3; add x3, x1, #1: the second reads x1 from its local,
        // and both results are written back once, at the end. x2, read once,
        // is a plain load (no local).
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![ADD, 0x91000423],
        };
        let Emitted { bytes, .. } = build(b);
        #[rustfmt::skip]
        let body = [
            0x20, 0, 0x29, 3, 16, 0x42, 3, 0x7c, 0x21, 4, // x1 = x2 + 3
            0x20, 4, 0x42, 1, 0x7c, 0x21, 5,              // x3 = x1 + 1
        ];
        assert!(has(&bytes, &body));
        assert!(has(
            &bytes,
            &[0x20, 0, 0x20, 4, 0x37, 3, 8, 0x20, 0, 0x20, 5, 0x37, 3, 24]
        ));
        assert_eq!(bytes.windows(2).filter(|w| *w == [0x29, 3]).count(), 2); // the PC and x2
    }

    #[test]
    fn a_helper_writes_back_and_forgets() {
        // add x1, x2, #3; ldsmax x0, x1, [x2] (a helper); add x3, x1, #1: x1 is
        // written back before the call and loaded again after it.
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![ADD, 0xf8204041, 0x91000423],
        };
        let Emitted { bytes, inl, .. } = build(b);
        assert_eq!(inl, [2]);
        #[rustfmt::skip]
        let around = [
            0x20, 0, 0x20, 4, 0x37, 3, 8,                    // x1 written back
            0x20, 0, 0x41,                                    // helper(vcpu, insn, …)
        ];
        assert!(has(&bytes, &around));
        #[rustfmt::skip]
        let after = [
            0x0f, 0x0b,                                       // …; if: return 1; end
            0x20, 0, 0x29, 3, 8, 0x22, 4, 0x42, 1, 0x7c, 0x21, 5, // x3 = x1 (reloaded) + 1
        ];
        assert!(has(&bytes, &after));
    }

    /// The number of NZCV stores (`i64.store 264`) in `bytes`.
    fn nzcv_stores(bytes: &[u8]) -> usize {
        bytes.windows(3).filter(|w| *w == [0x37, 3, 0x88]).count()
    }

    fn one(words: &[u32]) -> (Vec<u8>, emit::Counts) {
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: words.to_vec(),
        };
        let Emitted { bytes, counts, .. } = build(b);
        (bytes, counts)
    }

    #[test]
    fn dead_flags_and_direct_conditions() {
        // cmp x1, x2; cmp x3, x4; b.lt: the first compare's flags are dead,
        // b.lt is i64.lt_s on the second's operands, and NZCV is stored once,
        // at the end (live out of every block).
        let (bytes, counts) = one(&[0xeb02003f, 0xeb04007f, 0x5400000b]);
        // Locals after compaction: entry, two scratch (for the store), the flag locals.
        assert!(has(&bytes, &[0x20, 6, 0x20, 7, 0x53])); // i64.lt_s
        assert_eq!(nzcv_stores(&bytes), 1);
        assert!(!has(&bytes, &[0x28, 2, 0x88, 2])); // NZCV never loaded
        // Stored before the branch's PC store (`commit_flags`), not after it.
        let nzcv = bytes.windows(3).position(|w| w == [0x37, 3, 0x88]).unwrap();
        let pc = bytes.windows(3).position(|w| w == [0x37, 3, 0x80]).unwrap();
        assert!(nzcv < pc);
        let want = emit::Counts {
            flags_stored: 1,
            flags_elided: 1,
            cond_direct: 1,
            ..Default::default()
        };
        assert_eq!(counts, want);
        // tst w1, #1; b.ne: the i32 result against zero (i32.ne).
        let (bytes, _) = one(&[0x7200003f, 0x54000001]);
        assert!(has(&bytes, &[0x20, 4, 0x41, 0, 0x47])); // the i32 result, after the entry PC
        // adds x0, x1, x2; adc x3, x3, x3: the carry in is x + y < x, unsigned.
        let (bytes, counts) = one(&[0xab020020, 0x9a030063]);
        assert!(has(&bytes, &[0x20, 7, 0x20, 8, 0x7c, 0x20, 7, 0x54])); // i64.lt_u
        assert_eq!(counts.cond_direct, 1);
        // Flags from outside the block come from memory.
        let (_, counts) = one(&[0x5400000b]);
        assert_eq!(counts.cond_memory, 1);
        // adcs x0, x0, x0; b.vs: no direct form, NZCV computed in registers.
        let (_, counts) = one(&[0xba000000, 0x54000006]);
        assert_eq!(counts.cond_computed, 1);
    }

    #[test]
    fn flags_are_stored_before_helpers_and_on_failure_returns() {
        // cmp x1, x2; ldsmax x0, x1, [x2] (a helper): NZCV stored before the call;
        // the helper may write it, so nothing is left to store at the end.
        let (bytes, counts) = one(&[0xeb02003f, 0xf8204041]);
        assert_eq!(nzcv_stores(&bytes), 1);
        let at = bytes.windows(3).position(|w| w == [0x37, 3, 0x88]).unwrap();
        assert!(bytes[at..].windows(2).any(|w| w == [0x10, 0])); // the call comes after
        assert_eq!(counts.flags_stored, 1);
        // cmp x1, x2; ldr x0, [x1]: stored on the load's failure return (by the
        // failure chain, which returns acc + 1), and at the end.
        let (bytes, counts) = one(&[0xeb02003f, 0xf9400020]);
        assert_eq!(nzcv_stores(&bytes), 2);
        // i32.const 1; br to the failure chain
        let ret = bytes
            .windows(4)
            .position(|w| w == [0x41, 1, 0x0c, 2])
            .unwrap();
        let back = ret
            + bytes[ret..]
                .windows(4)
                .position(|w| w == [0x20, 1, 0x6a, 0x0f])
                .unwrap();
        assert_eq!(nzcv_stores(&bytes[..ret]), 0);
        assert_eq!(nzcv_stores(&bytes[ret..back]), 1);
        assert_eq!((counts.flags_stored, counts.flags_elided), (1, 0));
    }

    #[test]
    fn chaining() {
        const B8: u32 = 0x14000002; // b .+8
        // movz x1, #3; b .+8 at 0x4000_0200, flat: the target, 0x4000_020c, is
        // compiled (table index 77, 3 instructions), so the module imports it
        // as t.77 (function 2, after the two helpers) and tail-calls it when
        // `left` covers 2 + 3 steps, passing acc + 2 and left - 2.
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![MOVZ, B8],
        };
        let e = module(
            &[b.into()],
            &test_mem(),
            |k| (k == 0x4000_020c).then_some((77, 3)),
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!(e.links, [vec![0x4000_020c]]);
        assert!(has(&e.bytes, &[1, b't', 2, b'7', b'7', 0, 0])); // import t.77, type 0
        #[rustfmt::skip]
        let tail = [
            0x20, 2, 0x41, 5, 0x4f, 0x04, 0x40,           // if left >= 5:
            0x20, 0, 0x20, 1, 0x41, 2, 0x6a, 0x20, 2, 0x41, 2, 0x6b, 0x12, 2, 0x0b, // return_call
            0x20, 1, 0x41, 2, 0x6a, 0x0f, 0x0b,           // else return acc + 2
        ];
        assert!(has(&e.bytes, &tail));
        // A loop onto itself is a wasm loop (step 8), no link.
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![MOVZ, 0x17ffffff], // b .-4
        };
        let e = build(b);
        assert_eq!(e.links, [Vec::<u64>::new()]);
        assert!(has(&e.bytes, &[0x03, 0x40]) && has(&e.bytes, &[0x21, 2, 0x0c, 1, 0x0b]));
        // A conditional branch chains the side it can (here: itself when
        // taken, a loop; 0x4000_1000, not taken, isn't compiled).
        let b = Block {
            key: 0x4000_0ff8 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0x54ffffe0], // b.eq .-4
        };
        let e = build(b);
        assert_eq!(e.links, [Vec::<u64>::new()]);
        assert!(has(&e.bytes, &[0x20, 5, 0x04, 0x40])); // if TAKEN (compacted: after entry and x1)
        assert!(has(&e.bytes, &[0x0c, 2, 0x0b])); // the loop, from inside `if TAKEN`
        assert_eq!(e.bytes.iter().filter(|&&b| b == 0x12).count(), 0);
        // With the MMU on, a successor in another page is chained only while
        // its VA maps to its PA: the instruction TLB of the block's EL (EL0
        // here) is checked first.
        let b = Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0x14000400], // b .+0x1000
        };
        let e = module(
            &[b.into()],
            &test_mem(),
            |k| (k == 0x4000_1204 | KEY_MMU).then_some((9, 1)),
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        let mut tag = vec![0x29, 3];
        crate::jit::wasm::uleb(&mut tag, emit::tlb_array(0, 2) as u64);
        assert!(has(&e.bytes, &tag));
        assert!(has(&e.bytes, &[0x12, 2, 0x0b])); // the tail call behind it
        // No jump cache here (a module built without one), so nothing else.
        assert!(!has(&e.bytes, &[0x28, 2, 8, 0x13]));
    }

    /// With the MMU on, a direct branch to another page finds its target by
    /// the target's VA (the transfer cache), since the
    /// page needn't follow the block's physically: alone if nothing is
    /// compiled at the PA that would follow, and after the guarded direct
    /// call if something is.
    #[test]
    fn a_successor_in_another_page_is_found_by_its_va() {
        let block = || Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0x14000400], // b .+0x1000
        };
        // The transfer cache's tag and target loads, its generation's, and
        // the target's table index behind `return_call_indirect`.
        let off = |f: usize| (core::mem::offset_of!(crate::mmu::Vcpu, tlb) + f) as u64;
        let load = |o: u64| {
            let mut l = vec![0x29, 3];
            crate::jit::wasm::uleb(&mut l, o);
            l
        };
        let tag = load(emit::XC_LO as u64);
        let to = load(emit::XC_LO as u64 + 8);
        let xgen = load(off(core::mem::offset_of!(crate::mmu::Tlb, xgen)));
        let tail = [0xa7, 0x13, 0, 0]; // i32.wrap_i64, return_call_indirect
        // A miss tail-calls the cache's miss function for EL0, imported by
        // its table index.
        const XMISS: u32 = 40;
        let by_va = |bytes: &[u8]| {
            has(bytes, &tag)
                && has(bytes, &to)
                && has(bytes, &xgen)
                && has(bytes, &tail)
                && has(bytes, &[1, b't', 2, b'4', b'0', 0])
        };
        let e = module(
            &[block().into()],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            Some(XMISS),
        );
        assert_eq!(e.links, [Vec::<u64>::new()]);
        assert!(by_va(&e.bytes));
        // The same block in one page with its successor: the successor's
        // key is known, so its jump-cache entry is at a constant address and
        // the transfer cache isn't read.
        let near = Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0x14000004], // b .+0x10
        };
        let e = module(
            &[near.into()],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            Some(XMISS),
        );
        assert!(!has(&e.bytes, &tag) && has(&e.bytes, &[0x28, 2, 8, 0x13]));
        // Something compiled at the PA that follows: the direct call behind
        // its check first, then the lookup by VA.
        let e = module(
            &[block().into()],
            &test_mem(),
            |k| (k == 0x4000_1204 | KEY_MMU).then_some((9, 1)),
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            Some(XMISS),
        );
        assert_eq!(e.links, [vec![0x4000_1204 | KEY_MMU]]);
        let call = e.bytes.windows(3).position(|w| w == [0x12, 2, 0x0b]);
        let ind = e.bytes.windows(4).position(|w| w == tail);
        assert!(call.is_some() && call < ind, "{call:?} {ind:?}");
        assert!(by_va(&e.bytes));
    }

    /// A fixed-size memory (`Config::pages`) is imported with exact limits,
    /// by region modules and the miss functions alike; else as growable.
    #[test]
    fn a_fixed_memory_is_imported_with_exact_limits() {
        // `memory` (import kind 2), shared with a maximum (3), then the limits.
        let import = |min: u32, max: u32| {
            let mut l = b"\x06memory\x02\x03".to_vec();
            crate::jit::wasm::uleb(&mut l, min as u64);
            crate::jit::wasm::uleb(&mut l, max as u64);
            l
        };
        let b = || Block {
            key: 0x4000_0100 | KEY_EL1 | KEY_MMU,
            va: 0xffff_0100,
            words: vec![MOVZ, MSR],
        };
        for pages in [0, 32_769] {
            let want = match pages {
                0 => import(0, 65536),
                n => import(n, n),
            };
            let region = module(
                &[b().into()],
                &test_mem(),
                |_| None,
                &Config {
                    pages,
                    ..Config::DEFAULT
                },
                false,
                crate::cpu::FEATURES,
                None,
            );
            assert!(has(&region.bytes, &want), "region module, {pages} pages");
            let miss = miss_module(&test_mem(), false, pages);
            assert!(has(&miss, &want), "miss module, {pages} pages");
        }
    }

    /// The miss functions read the instruction TLB of their EL and fill the
    /// transfer cache.
    #[test]
    fn the_miss_functions_read_the_instruction_tlb_and_fill_the_transfer_cache() {
        let bytes = miss_module(&test_mem(), false, 0);
        let at = |op: u8, o: u64| {
            let mut l = vec![op, 3];
            crate::jit::wasm::uleb(&mut l, o);
            l
        };
        let xc = emit::XC_LO as u64;
        for el in 0..2 {
            assert!(has(&bytes, &at(0x29, emit::tlb_array(el, 2) as u64)));
        }
        assert!(has(&bytes, &at(0x37, xc)) && has(&bytes, &at(0x37, xc + 8)));
        assert!(has(&bytes, b"xmiss_el0") && has(&bytes, b"xmiss_el1"));
    }

    #[test]
    fn a_region_is_a_loop_with_registers_across_its_edges() {
        // 0x100: add x1, x1, #1; cbz x2, 0x110
        // 0x108: add x3, x1, #1; b 0x114
        // 0x110: add x3, x1, #2
        // 0x114: cbnz x3, 0x100
        // 0x118: ret
        let words = [
            0x91000421, 0xb4000062, 0x91000423, 0x14000002, 0x91000823, 0xb5ffff63, 0xd65f03c0,
        ];
        let (_r, m) = mem_with(0x100, &words);
        let r = region(&m, 0x100, 0x100, &|_| true);
        // Reverse postorder: the head, the fall-through side and its
        // successor, the taken side (which runs on to 0x114); not the ret
        // block, which doesn't lead back to the head.
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key).collect();
        assert_eq!(keys, [0x100, 0x108, 0x114, 0x110]);
        assert_eq!(r.blocks[3].words, [0x91000823, 0xb5ffff63]);
        assert_eq!(r.back_edges(), 2);
        let e = module(
            &[r],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        // The head's edges, both inside the `if TAKEN` (depth 1): to the taken
        // side (member 3, br 4) and the fall-through (member 1, br 2), each
        // when `left` covers the head (2) and the member (2), with acc and
        // left updated on the way.
        #[rustfmt::skip]
        let taken = [
            0x20, 2, 0x41, 4, 0x4f, 0x04, 0x40,             // if left >= 4:
            0x20, 1, 0x41, 2, 0x6a, 0x21, 1,                //   acc += 2
            0x20, 2, 0x41, 2, 0x6b, 0x21, 2, 0x0c, 4, 0x0b, //   left -= 2; br 4
        ];
        assert!(has(&e.bytes, &taken));
        // The back-edge from 0x114 (member 2, inside its `if TAKEN`): the
        // budget for it (1) and the head (2), then br 3, the loop.
        #[rustfmt::skip]
        let back = [
            0x20, 2, 0x41, 3, 0x4f, 0x04, 0x40,
            0x20, 1, 0x41, 1, 0x6a, 0x21, 1, 0x20, 2, 0x41, 1, 0x6b, 0x21, 2, 0x0c, 3, 0x0b,
        ];
        assert!(has(&e.bytes, &back));
        // x1 and x2 are loaded once, before the loop, and stay in their
        // locals across every edge; x1 and x3 are written back where the
        // loop is left (0x110 and 0x114 to 0x118, or the budget).
        let lp = e.bytes.windows(2).position(|w| w == [0x03, 0x40]).unwrap();
        for x in [8, 16] {
            let at: Vec<usize> = (0..e.bytes.len() - 2)
                .filter(|&k| e.bytes[k..k + 3] == [0x29, 3, x])
                .collect();
            assert!(at.len() == 1 && at[0] < lp, "x{} loaded at {at:?}", x / 8);
        }
        assert!(has(&e.bytes, &[0x37, 3, 8]) && has(&e.bytes, &[0x37, 3, 24]));
        assert_eq!(e.inl, [7]);
        assert_eq!(e.links, [Vec::<u64>::new()]);
        // Without a loop through the head, a region is the head alone.
        let (_r, m) = mem_with(0x100, &[ADD, 0xb4000061, ADD, 0xd65f03c0]);
        assert_eq!(region(&m, 0x100, 0, &|_| true).blocks.len(), 1);
        // Nor past the page.
        let (_r, m) = mem_with(0xff8, &[ADD, 0x14000002, ADD, ADD, 0xd65f03c0]);
        assert_eq!(region(&m, 0xff8, 0, &|_| true).blocks.len(), 1);
        // A head whose words would make no block (it was queued, then the
        // code at it changed: an Alpine boot with threshold 2 found it) has
        // no region.
        let (_r, m) = mem_with(0x100, &[0xd4000001]); // svc #0
        assert!(region(&m, 0x100, 0, &|_| true).blocks.is_empty());
    }

    #[test]
    fn a_forward_region_is_the_blocks_in_reach_with_calls_and_their_returns() {
        // 0x100: cbz x1, 0x10c
        // 0x104: add x2, x2, #1; b 0x110
        // 0x10c: add x2, x2, #2
        // 0x110: add x3, x2, #1; bl 0x120
        // 0x118: ret
        // 0x120: ret
        let words = [
            0xb4000061, 0x91000442, 0x14000002, 0x91000842, 0x91000443, 0x94000003, 0xd65f03c0, 0,
            0xd65f03c0,
        ];
        let (_r, m) = mem_with(0x100, &words);
        let keys = |r: &Region| r.blocks.iter().map(|b| b.key).collect::<Vec<_>>();
        // Reverse postorder: the head, its fall-through side and where that
        // branches, the taken side (a block runs on to its branch: the one
        // at 0x10c holds 0x110's words too), the function both call, and
        // the block after the call, where its `ret` is predicted to return.
        let r = forward(&m, 0x100, 0x100, &|_, k| k);
        assert_eq!(keys(&r), [0x100, 0x104, 0x110, 0x10c, 0x120, 0x118]);
        assert_eq!(r.blocks[3].words.len(), 3);
        assert_eq!(r.returns, [(0x120, 0x118)]);
        assert_eq!(r.returns_to(4), Some((5, -8)));
        assert!(!r.looped());
        // Only the blocks admitted, and what they reach.
        let only = |f: &dyn Fn(u64) -> bool| {
            let r = forward(&m, 0x100, 0, &|_, k| k.filter(|&k| f(k)));
            (keys(&r), r.returns.len())
        };
        assert_eq!(only(&|k| k != 0x104), (vec![0x100, 0x10c, 0x120, 0x118], 1));
        assert_eq!(only(&|k| k == 0x104), (vec![0x100, 0x104], 0));
        // Without the block after the call the return isn't an edge.
        let r5 = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x118));
        assert_eq!((r5.blocks.len(), r5.returns_to(4)), (5, None));
        // One function without a loop, every instruction inline. The
        // callee's return to the block after the call is an edge: taken when
        // x30 is that address (the entry PC + 0x18) and the steps left cover
        // both blocks, with the `ret`'s indirect branch behind it.
        let e = module(
            &[r],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!(e.inl, [10]);
        assert!(!has(&e.bytes, &[0x03, 0x40]));
        #[rustfmt::skip]
        let predicted = [
            0x20, 3, 0x42, 0x18, 0x7c, 0x51,          // … == entry PC + 0x18
            0x20, 2, 0x41, 2, 0x4f, 0x71, 0x04, 0x40, // and left >= 2: if
        ];
        let at = e
            .bytes
            .windows(predicted.len())
            .position(|w| w == predicted);
        let indirect = e.bytes.windows(4).rposition(|w| w == [0x28, 2, 8, 0x13]);
        assert!(at.is_some() && at < indirect, "{at:?} {indirect:?}");
        assert_eq!(
            module(
                &[r5],
                &test_mem(),
                |_| None,
                &Config::DEFAULT,
                false,
                crate::cpu::FEATURES,
                None,
            )
            .inl,
            [9]
        );
        // Not past the page, and nothing where the head has no words.
        let (_r, m) = mem_with(0xff8, &[ADD, 0x14000002, ADD, ADD, 0xd65f03c0]);
        assert_eq!(forward(&m, 0xff8, 0xff8, &|_, k| k).blocks.len(), 1);
        // A block of another page is the one `member` knows at that VA.
        // With the MMU off that's its PA, and the edge needs no check; with
        // it on, the edge checks the mapping unless the member is where its
        // predecessor's page, or the head's, has it.
        let r = forward(&m, 0xff8, 0xff8, &|va, k| k.or(Some(va)));
        assert_eq!(keys(&r), [0xff8, 0x1004]);
        assert!(!r.checked(0, 1));
        let mmu = |keys: [u64; 3]| Region {
            blocks: [(keys[0], 0x7000), (keys[1], 0x8000), (keys[2], 0x7100)]
                .map(|(k, va)| Block {
                    key: k | KEY_MMU,
                    va,
                    words: vec![NOP],
                })
                .into(),
            tier: None,
            returns: vec![],
        };
        // 0x7000 at PA 0x3000, 0x8000 at PA 0x9000, and back in the head's page.
        let r = mmu([0x3000, 0x9000, 0x3100]);
        assert!(r.checked(0, 1) && !r.checked(1, 2) && !r.checked(1, 0));
        // The member at 0x7100 isn't where the head's page has it: checked,
        // even from the head (a block another address space had at that VA).
        let r = mmu([0x3000, 0x9000, 0x5100]);
        assert!(r.checked(0, 2) && r.checked(1, 2));
        let (_r, m) = mem_with(0x100, &[0xd4000001]); // svc #0
        assert!(forward(&m, 0x100, 0, &|_, k| k).blocks.is_empty());
        // At most REGION blocks: a chain of branches to the next word.
        let (_r, m) = mem_with(0x100, &[0x14000001; 40]);
        assert_eq!(forward(&m, 0x100, 0, &|_, k| k).blocks.len(), REGION);
    }

    #[test]
    fn flags_cross_region_edges_lazily() {
        // 0x100: cmp x1, x2; b 0x10c
        // 0x10c: b.lt 0x100 (then ret)
        // b.lt reads the compare's operands across the edge (i64.lt_s, no
        // NZCV load); the head sets flags before anything reads them, so the
        // back-edge stores none. NZCV is stored before b.lt (the way out of
        // the loop) and where the head returns when `left` doesn't cover its
        // edge, not on the edge itself.
        let words = [0xeb02003f, 0x14000002, 0xd4200000, 0x54ffffab, 0xd65f03c0];
        let (_r, m) = mem_with(0x100, &words);
        let r = region(&m, 0x100, 0x100, &|_| true);
        assert_eq!(r.blocks.len(), 2);
        let e = module(
            &[r],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!((e.counts.cond_direct, e.counts.cond_memory), (1, 0));
        assert!(!has(&e.bytes, &[0x28, 2, 0x88, 2])); // NZCV never loaded
        assert!(has(&e.bytes, &[0x53])); // i64.lt_s
        assert_eq!(nzcv_stores(&e.bytes), 2);
        let edge = e.bytes.windows(2).position(|w| w == [0x0c, 1]).unwrap(); // br to b.lt
        assert_eq!(nzcv_stores(&e.bytes[..edge]), 0);
        // Nor the PC (step 8.5): the head's `b` goes to a member, so only its
        // way out stores it (i64.store 256, once, after the edge).
        let pc = |b: &[u8]| b.windows(4).filter(|w| *w == [0x37, 3, 0x80, 2]).count();
        let body = e.bytes.windows(2).position(|w| w == [0x03, 0x40]).unwrap(); // the loop
        assert_eq!(pc(&e.bytes[body..edge]), 0);
        assert!(pc(&e.bytes[edge..]) >= 2); // the head's exit, b.lt's select
    }

    #[test]
    fn an_inner_loop_head_is_not_inner_free() {
        // 0x100 outer: movz x6, #50; add x1, x1, #1; b 0x118
        // 0x10c        subs x5, x5, #1; b.ne 0x100
        // 0x114        brk
        // 0x118        subs x6, x6, #1; b.ne 0x104 (inner: add; b 0x118)
        // 0x120        b 0x10c
        let words = [
            0xd2800646, 0x91000421, 0x14000004, 0xf10004a5, 0x54ffff81, 0xd4200000, 0xf10004c6,
            0x54ffff41, 0x17fffffb,
        ];
        let (_r, m) = mem_with(0x100, &words);
        let r = region(&m, 0x100, 0x100, &|_| true);
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key).collect();
        assert_eq!(keys, [0x100, 0x118, 0x120, 0x10c, 0x104]);
        // 0x104 branches back to 0x118, which heads the inner loop: it keeps
        // its own tier-up (the region leaves on that edge).
        assert_eq!(r.inner_free(), [0x120, 0x10c, 0x104]);
    }

    #[test]
    fn a_loop_head_compiled_alone_counts_its_entries() {
        // A head with a hot word at 0x2000 (step 8.3): the module imports
        // jit_hot and the table; the function starts by loading the word,
        // tail-calls the region its low bits name when the top bit is set,
        // else counts down and calls jit_hot at 1.
        let r = Region {
            blocks: vec![Block {
                key: 0x4000_0200,
                va: 0,
                words: vec![MOVZ, 0x14000002],
            }],
            tier: Some(0x2000),
            returns: vec![],
        };
        let e = module(
            &[r],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        assert!(has(&e.bytes, b"\x07jit_hot"));
        assert!(has(
            &e.bytes,
            &[3, b'e', b'n', b'v', 5, b't', b'a', b'b', b'l', b'e', 1]
        ));
        // The entry PC, then the table's hot words (through the vCPU), and
        // word 0x2000 of them (locals are renumbered: not matched).
        let mut head = vec![0x20, 0, 0x29, 3, 0x80, 2, 0x21, 3, 0x20, 0, 0x28, 2];
        crate::jit::wasm::uleb(&mut head, emit::HOT_PTR as u64);
        assert!(has(&e.bytes, &head));
        assert!(has(&e.bytes, &[0x28, 2, 0x80, 0x80, 2]));
        assert!(has(
            &e.bytes,
            &[0x41, 0xff, 0xff, 0xff, 0xff, 7, 0x71, 0x13, 0, 0, 0x0b]
        ));
        assert!(has(&e.bytes, &[0x41, 1, 0x6b, 0x36, 2, 0x80, 0x80, 2])); // word - 1, stored
        // Without a hot word, none of it.
        let e = build(Block {
            key: 0x4000_0200,
            va: 0,
            words: vec![MOVZ, 0x14000002],
        });
        let mut hot = vec![0x28, 2];
        crate::jit::wasm::uleb(&mut hot, emit::HOT_PTR as u64);
        assert!(!has(&e.bytes, b"jit_hot") && !has(&e.bytes, &hot));
    }

    #[test]
    fn indirect_branches_look_up_the_jump_cache() {
        // movz x1, #3; ret with a jump cache: the module imports the
        // table, and the block ends in return_call_indirect (type 0, table 0),
        // with the MMU on of the transfer cache's table index.
        let b = Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0xd65f03c0],
        };
        let e = module(
            &[b.into()],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            Some(40),
        );
        assert!(has(
            &e.bytes,
            &[3, b'e', b'n', b'v', 5, b't', b'a', b'b', b'l', b'e', 1]
        ));
        assert!(has(&e.bytes, &[0xa7, 0x13, 0, 0, 0x0b]));
        // A static successor that isn't compiled: probed in the jump cache
        // (the vCPU's table's) at its own entry, jc + ((key >> 2) & (JC - 1)) * 16.
        let b = Block {
            key: 0x4000_0200,
            va: 0,
            words: vec![MOVZ, 0x14000002], // b .+8 (0x4000_020c)
        };
        let e = module(
            &[b.into()],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            None,
        );
        let mut entry = vec![0x20, 0, 0x28, 2];
        crate::jit::wasm::uleb(&mut entry, emit::JC_PTR as u64);
        entry.push(0x41);
        let at = ((0x4000_020c_u64 >> 2) as u32 & (crate::jit::JC as u32 - 1)) * 16;
        crate::jit::wasm::sleb(&mut entry, at as i32 as i64);
        entry.push(0x6a);
        assert!(has(&e.bytes, &entry));
        assert!(has(&e.bytes, &[0x13, 0, 0, 0x0b]));
        assert_eq!(e.links, [Vec::<u64>::new()]);
        // Without a jump cache, it just returns.
        let b = Block {
            key: 0x4000_0200,
            va: 0,
            words: vec![MOVZ, 0xd65f03c0],
        };
        assert!(!has(&build(b).bytes, &[0x13, 0, 0]));
    }
}
