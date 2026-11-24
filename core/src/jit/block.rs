//! Block formation and emission: each instruction inline (`emit`, M5 step 4)
//! or a call to an interpreter helper.
//!
//! A block starts at a physical address and runs straight on: it ends after a
//! branch or a system-class instruction, before an exception-generating or
//! unallocated one, at the end of the 4 KiB page, or at [`CAP`] instructions.
//! Its words are read at compile time, so the block executes the words it saw.

use super::Config;
use super::emit;
use super::emit::Xfer;
use super::wasm::{F64, I32, I64, Module};
use crate::decode::{Op, decode};
use crate::mem::Mem;
use crate::tally;
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

/// [`end`] of `w`, whose class is `op`: one load from [`ENDS`] (a match over
/// the classes was a tree of compares, 13% of decoding a block natively:
/// bench/interp/REPORT.md "The block interpreter on the Mac, loop 4").
#[inline]
pub fn end_op(op: Op, w: u32) -> End {
    match ENDS[op as usize] {
        END_MSR if crate::interp::sys::msr_continues(w) => End::No,
        END_MSR | END_AFTER => End::After,
        END_BEFORE => End::Before,
        _ => End::No,
    }
}

const END_NO: u8 = 0;
const END_AFTER: u8 = 1;
const END_BEFORE: u8 = 2;
/// An MSR: [`End::After`] unless [`crate::interp::sys::msr_continues`].
const END_MSR: u8 = 3;

/// [`end_op`] by class, made at compile time from [`end_class`].
static ENDS: [u8; Op::ALL.len()] = {
    let mut t = [END_NO; Op::ALL.len()];
    let mut i = 0;
    while i < t.len() {
        t[Op::ALL[i] as usize] = end_class(Op::ALL[i]);
        i += 1;
    }
    t
};

const fn end_class(op: Op) -> u8 {
    use Op::*;
    match op {
        // DAIF masking and plain registers (M6 loop 7): inline or a helper
        // call that returns mid-block if it leaves.
        MSR_reg | MSR_imm => END_MSR,
        // MRS, the data barriers and DC ZVA don't end a block (M6 loop 1):
        // the barriers are no-ops for one vCPU, MRS changes nothing but its
        // register, DC ZVA is a 64-byte store, and one that leaves (a timer,
        // a trap, a fault) returns from the block through its helper call,
        // as a load from MMIO does.
        B_uncond | BL | B_cond | CBZ | CBNZ | TBZ | TBNZ | BR | BLR | RET | ERET | SYS | SYSL
        | DC_IVAC | DC_ISW | DC_CSW | DC_CISW | DC_CVAC | DC_CVAU | DC_CIVAC | IC_IALLU
        | IC_IALLUIS | IC_IVAU | WFE | WFI | YIELD | SEV | SEVL | CLREX | ISB => END_AFTER,
        SVC | HVC | SMC | BRK | HLT | DCPS1 | DCPS2 | DCPS3 | DRPS | UnallocatedEncoding => {
            END_BEFORE
        }
        _ => END_NO,
    }
}

/// The words of the block at `pa` (empty if it would have none, or `pa` isn't RAM).
pub fn form(mem: &Mem, pa: u64) -> Vec<u32> {
    form_with(mem, pa, |w, _| w)
}

/// [`form`], each word (with its class) mapped through `f`: one decode a word
/// (the block interpreter's micro-ops).
pub fn form_with<T>(mem: &Mem, pa: u64, f: impl FnMut(u32, Op) -> T) -> Vec<T> {
    let mut out = Vec::new();
    form_into(mem, pa, &mut out, f);
    out
}

/// [`form_with`] into `out` (cleared first), so that a caller decoding block
/// after block reuses one buffer.
pub fn form_into<T>(mem: &Mem, pa: u64, out: &mut Vec<T>, mut f: impl FnMut(u32, Op) -> T) {
    out.clear();
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
/// can't change the regime (ISB, CLREX, YIELD/SEV, DC: when it retires,
/// inline as ISB outside parallel SMP or through its helper, the interpreter
/// would go on to the next instruction in the same regime). None after an indirect branch, ERET, MSR, SYS (TLBI, AT),
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
        _ if end(w) == End::No || goes_on(op) => Next::One(at + 4),
        _ => Next::None,
    }
}

/// The system instructions that end a block but go on to the next
/// instruction in the same regime ([`next`]).
fn goes_on(op: Op) -> bool {
    use Op::*;
    matches!(
        op,
        ISB | CLREX
            | YIELD
            | SEV
            | SEVL
            | DC_IVAC
            | DC_ISW
            | DC_CSW
            | DC_CISW
            | DC_CVAC
            | DC_CVAU
            | DC_CIVAC
    )
}

/// Blocks per region, at most (step 8).
pub const REGION: usize = 64;

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
    /// The followed calls ([`forward`]): the keys of the members ending in
    /// a BL whose callee the walk took through that BL. Their BL is a
    /// branch to the callee; every other call is a host call.
    pub follows: Vec<u64>,
}

impl From<Block> for Region {
    fn from(b: Block) -> Region {
        Region {
            blocks: vec![b],
            tier: None,
            returns: vec![],
            follows: vec![],
        }
    }
}

impl Region {
    fn of(blocks: Vec<Block>) -> Region {
        Region {
            blocks,
            tier: None,
            returns: vec![],
            follows: vec![],
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

    /// The members a call in the region returns to, where the head's page has
    /// them (its PA page, at their PA offset from the head): a
    /// function's entries besides its head ([`emit::ENTRY_BIT`]), since a
    /// return reaches them from outside too (after anything that unwound the
    /// host calls: an exception, the chunk's end). None in a loop (its
    /// members are inside the `loop`, which only its head enters).
    pub fn entries(&self) -> Vec<usize> {
        if self.looped() {
            return vec![];
        }
        let head = &self.blocks[0];
        // Where the head's page has it: entered by its own VA, the function
        // then has the head's mapping too, which `checked` relies on.
        let at_head = |b: &Block| {
            (b.key ^ head.key) >> 12 == 0
                && (b.key & !3).wrapping_sub(head.key & !3) == b.va.wrapping_sub(head.va)
        };
        let mut v: Vec<usize> = (0..self.blocks.len())
            .filter_map(|i| {
                let a = call_after(&self.blocks[i].words)?;
                self.target(i, a).filter(|&j| j > i)
            })
            .filter(|&j| at_head(&self.blocks[j]))
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// The members that member `i`'s static edges go to (a call's target
    /// only if the call is followed).
    fn targets(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        let host = self.host_call(i);
        offsets(&self.blocks[i].words)
            .into_iter()
            .filter(move |_| !host)
            .filter_map(move |o| self.target(i, o))
    }

    /// Whether member `i` ends in a BL the region doesn't follow: a host call
    /// (docs/jit.md "Calls"), whose target is no edge even when it's a
    /// member (the head: recursion; a callee the walk took through another
    /// call).
    fn host_call(&self, i: usize) -> bool {
        let b = &self.blocks[i];
        b.words.last().is_some_and(|&w| decode(w) == Op::BL) && !self.follows.contains(&b.key)
    }

    /// The member that member `i`'s static edge to byte offset `off` branches
    /// to inside the function: a later member, or the head (a loop's
    /// back-edge); none for a host call's target.
    fn internal(&self, i: usize, off: i64) -> Option<usize> {
        if self.host_call(i) {
            return None;
        }
        self.target(i, off).filter(|&j| j > i || j == 0)
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

/// The keys of the blocks a block branches to in its loop ([`region`]): its
/// static successors, but none for a call (BL), whose target is a host
/// call's (recursion is no loop).
fn branches(key: u64, words: &[u32]) -> Vec<u64> {
    match words.last() {
        Some(&w) if decode(w) == Op::BL => vec![],
        _ => succs(key, words),
    }
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
        for s in branches(b.key, &b.words) {
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
            if !keep[i]
                && branches(blocks[i].key, &blocks[i].words)
                    .into_iter()
                    .any(kept)
            {
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
/// one in its predecessor's page that key or none; for one in another page:
/// the block it knows at that VA, which the emitted edge checks is still
/// there, [`Region::checked`]).
///
/// **Calls are followed**, and a `ret` (of X30) in what a call reaches is
/// predicted to return after that call: the block there is taken as the
/// `ret` block's successor ([`Region::returns`]), so a call and its return
/// can both stay inside the function. A call is followed only when the walk
/// takes its callee through it ([`Region::follows`]); a call to a block
/// taken already (the head: recursion; a callee another call took, whose
/// `ret` predicts that call's return) or not taken at all is called (a host
/// call, docs/jit.md "Calls"), and the block after the call is taken as
/// where that call returns: one of the region's entries
/// ([`Region::entries`]).
///
/// **A call is followed only if its callee can't leave the region** but by
/// its predicted return ([`Region::open_call`]): a member that the code of a
/// followed call can reach, by any path, and that branches to a block not
/// taken, branches indirectly, takes an edge that checks its target's
/// mapping, or ends on a `ret` not predicted to return after that call makes
/// the innermost call a host call, and the region is walked again. Followed,
/// that exit would be a tail call out of the function with the call's frame
/// still owed, and the callee's `ret` a host return to the region's caller,
/// one frame early: a return elsewhere than its continuation at every frame
/// up to the dispatcher (docs/jit.md "Calls"; PERF loops 36 and 37).
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
    let mut not = vec![];
    loop {
        let r = walk(mem, key, va, member, &not);
        match r.open_call() {
            Some(k) if !not.contains(&k) => not.push(k),
            _ => return r,
        }
    }
}

/// [`forward`]'s walk, with the callees of the calls that end the blocks at
/// `not` not taken.
fn walk(
    mem: &Mem,
    key: u64,
    va: u64,
    member: &dyn Fn(u64, Option<u64>) -> Option<u64>,
    not: &[u64],
) -> Region {
    /// A return pending: the VA after the call, and its key if it's in the
    /// call's page.
    type Call = (u64, Option<u64>);
    struct Walk<'a> {
        mem: &'a Mem,
        member: &'a dyn Fn(u64, Option<u64>) -> Option<u64>,
        not: &'a [u64],
        /// The blocks taken so far: (key, VA).
        seen: Vec<(u64, u64)>,
        post: Vec<Block>,
        returns: Vec<(u64, u64)>,
        follows: Vec<u64>,
    }
    impl Walk<'_> {
        /// Takes the block at `va` (`near`: its key, if it's in the page of
        /// the block that leads to it) unless it or its VA is taken, and
        /// what it reaches; `calls` are the returns pending on the way here.
        /// Whether it took it.
        fn take(&mut self, va: u64, near: Option<u64>, calls: &[Call]) -> bool {
            // Taken already: `member` isn't asked (it may form the block's
            // loop to see whether it heads one).
            let taken = |s: &[(u64, u64)], k: Option<u64>| {
                s.iter().any(|&(sk, v)| v == va || Some(sk) == k)
            };
            if self.seen.len() >= REGION || taken(&self.seen, near) {
                return false;
            }
            let Some(key) = (self.member)(va, near) else {
                return false;
            };
            if taken(&self.seen, Some(key)) {
                return false;
            }
            let words = form(self.mem, key & !3);
            if words.is_empty() {
                return false;
            }
            self.seen.push((key, va));
            self.visit(Block { key, va, words }, calls);
            true
        }

        fn visit(&mut self, b: Block, calls: &[Call]) {
            let last = b.words.last().copied().unwrap_or(0);
            let after = 4 * b.words.len() as i64;
            match decode(last) {
                Op::BL if !self.not.contains(&b.key) => {
                    let k = succ(b.key, after);
                    let near = ((k ^ b.key) >> 12 == 0).then_some(k);
                    let mut inner = calls.to_vec();
                    inner.push((b.va.wrapping_add(after as u64), near));
                    let o = offsets(&b.words)[0];
                    // Followed if the callee is taken through this call (its
                    // `ret` predicts the return); else a host call, which
                    // returns to the block after it.
                    if self.edge(&b, o, &inner) {
                        self.follows.push(b.key);
                    } else {
                        self.edge(&b, after, calls);
                    }
                }
                Op::BL | Op::BLR => {
                    self.edge(&b, after, calls);
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

        fn edge(&mut self, b: &Block, o: i64, calls: &[Call]) -> bool {
            let k = succ(b.key, o);
            let near = ((k ^ b.key) >> 12 == 0).then_some(k);
            self.take(b.va.wrapping_add(o as u64), near, calls)
        }
    }
    let mut w = Walk {
        mem,
        member,
        not,
        seen: vec![(key, va)],
        post: vec![],
        returns: vec![],
        follows: vec![],
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
        follows: w.follows,
    }
}

impl Region {
    /// A followed call whose callee [`forward`] took but whose code can leave
    /// the region other than by its predicted return (the key of its block),
    /// if any.
    ///
    /// Where the code of each followed call can run: the calls a member can
    /// run innermost in, by every path the region's edges give (a fixpoint:
    /// a member the walk took outside a call can be reached from inside one
    /// too), with the region's own frame for the head. A followed call's
    /// callee runs in that call; a host call's continuation, and a branch's
    /// target, where the block does; a predicted return that matches the
    /// call it's in, where that call's block does.
    fn open_call(&self) -> Option<u64> {
        /// The region's own frame: no followed call owed.
        const OWN: usize = usize::MAX;
        let n = self.blocks.len();
        // The VA a call's member returns to.
        let cont = |c: usize| {
            let b = &self.blocks[c];
            b.va.wrapping_add(4 * b.words.len() as u64)
        };
        // Where member `i`'s code goes on in the region when it runs inside
        // `c`: (member, the call it then runs inside).
        // A call's continuation, a later member: where a host call returns.
        let after = |i: usize| {
            call_after(&self.blocks[i].words)
                .and_then(|a| self.target(i, a))
                .filter(|&j| j > i)
        };
        // A followed call's callee, and whether its edge checks the
        // callee's mapping (failing, the call is a host call).
        let callee = |i: usize| {
            let j = self.target(i, offsets(&self.blocks[i].words)[0]);
            j.map(|j| (j, self.checked(i, j)))
        };
        let flows = |i: usize, c: usize, ctx: &[Vec<usize>]| -> Vec<(usize, usize)> {
            let b = &self.blocks[i];
            let Some(&w) = b.words.last() else {
                return vec![];
            };
            match decode(w) {
                Op::BL if !self.host_call(i) => match callee(i) {
                    Some((j, true)) => [(j, i)]
                        .into_iter()
                        .chain(after(i).map(|a| (a, c)))
                        .collect(),
                    Some((j, false)) => vec![(j, i)],
                    None => vec![],
                },
                Op::BL | Op::BLR => after(i).map(|j| (j, c)).into_iter().collect(),
                Op::RET => match self.returns_to(i) {
                    Some((j, _)) if c == OWN => vec![(j, OWN)],
                    Some((j, _)) if self.blocks[j].va == cont(c) => {
                        ctx[c].iter().map(|&p| (j, p)).collect()
                    }
                    _ => vec![],
                },
                _ => offsets(&b.words)
                    .into_iter()
                    .filter_map(|o| self.internal(i, o))
                    .map(|j| (j, c))
                    .collect(),
            }
        };
        let mut ctx: Vec<Vec<usize>> = vec![vec![]; n];
        if n > 0 {
            ctx[0].push(OWN);
        }
        let mut changed = true;
        while changed {
            changed = false;
            for i in 0..n {
                for k in 0..ctx[i].len() {
                    for (j, c) in flows(i, ctx[i][k], &ctx) {
                        if !ctx[j].contains(&c) {
                            ctx[j].push(c);
                            changed = true;
                        }
                    }
                }
            }
        }
        // What member `i` does when it runs inside call `c`: whether it can
        // leave the region other than by `c`'s return.
        let leaves = |i: usize, c: usize| {
            let b = &self.blocks[i];
            // An edge that can't fail to stay (but on the budget: that
            // returns to the dispatcher, through every host frame).
            let stays = |j: Option<usize>| j.is_some_and(|j| !self.checked(i, j));
            let Some(&w) = b.words.last() else {
                return false;
            };
            match decode(w) {
                Op::RET => match self.returns_to(i) {
                    Some((j, _)) => self.blocks[j].va != cont(c) || self.checked(i, j),
                    None => true,
                },
                Op::BR | Op::ERET => true,
                // The callee taken: an edge whose check fails is a host call,
                // returning after it.
                Op::BL if !self.host_call(i) => {
                    callee(i).is_some_and(|(_, checked)| checked) && !stays(after(i))
                }
                // A host call returning after it.
                Op::BL | Op::BLR => !stays(after(i)),
                _ => offsets(&b.words)
                    .into_iter()
                    .any(|o| !stays(self.internal(i, o))),
            }
        };
        (0..n).find_map(|i| {
            ctx[i]
                .iter()
                .find(|&&c| c != OWN && leaves(i, c))
                .map(|&c| self.blocks[c].key)
        })
    }

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
    /// Each region's entries besides its head ([`Region::entries`]): the
    /// member's key, its entry number and its length.
    pub entries: Vec<Vec<(u64, u32, u32)>>,
}

/// What every region of a module is emitted against.
struct Env<'a> {
    /// The functions of successors outside a region (this batch's own, or
    /// imports), with the block's length and its entry in the function.
    funcs: &'a HashMap<u64, (u32, u32, u32)>,
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
    /// The module's NZCV helpers ([`emit::nzcv_helper`]).
    nzcv: Option<[u32; emit::NZCV_HELPERS]>,
    /// `Config::polled`: no `left`, [`emit::poll`] where a cycle can close.
    polled: bool,
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
    let jscvt = features & crate::cpu::FEATURE_JSCVT != 0;
    let parallel = features & crate::cpu::FEATURE_PARALLEL != 0;
    let mut m = Module::default();
    let bt = m.ty(&[I32, I32, I32, I32], &[I32]);
    let ht = m.ty(&[I32, I32, I64], &[I32]);
    let flat = m.import_func("env", "jit_exec_flat", ht);
    let mmu = m.import_func("env", "jit_exec_mmu", ht);
    // Most modules have no group of accesses to call it.
    let groups = regions
        .iter()
        .filter(|r| r.blocks[0].key & KEY_MMU != 0)
        .flat_map(|r| &r.blocks)
        .any(|b| emit::may_group(&b.words));
    let span = groups.then(|| {
        let t = m.ty(&[I32, I64, I32, I64, I64, I64], &[I32]);
        m.import_func("env", "jit_exec_span", t)
    });
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
    let entries: Vec<Vec<usize>> = regions.iter().map(|r| r.entries()).collect();
    let local = |k: u64| {
        heads(k)
            || regions
                .iter()
                .zip(&entries)
                .any(|(r, e)| e.iter().any(|&j| r.blocks[j].key == k))
    };
    let mut funcs: HashMap<u64, (u32, u32, u32)> = HashMap::new();
    for r in regions {
        for b in &r.blocks {
            let after = call_after(&b.words).map(|a| succ(b.key, a));
            for k in succs(b.key, &b.words).into_iter().chain(after) {
                if funcs.contains_key(&k) || local(k) {
                    continue;
                }
                if let Some((idx, len)) = compiled(k) {
                    let name = (idx & super::IDX_MASK).to_string();
                    let f = m.import_func("t", &name, bt);
                    funcs.insert(k, (f, len, idx >> super::ENTRY_SHIFT));
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
        funcs.insert(h.key, (first + k as u32, h.words.len() as u32, 0));
    }
    for (k, (r, e)) in regions.iter().zip(&entries).enumerate() {
        for (n, &j) in e.iter().enumerate() {
            let b = &r.blocks[j];
            let f = (first + k as u32, b.words.len() as u32, n as u32 + 1);
            funcs.entry(b.key).or_insert(f);
        }
    }
    // The NZCV helpers follow the regions (docs/jit.md "Emission").
    let helpers = first + regions.len() as u32;
    let nzcv = Some(core::array::from_fn(|k| helpers + k as u32));
    // Defined only if a region calls one.
    let mut nzcv_used = false;

    let mut out = Emitted {
        bytes: vec![],
        inl: Vec::with_capacity(regions.len()),
        links: Vec::with_capacity(regions.len()),
        counts: emit::Counts::default(),
        entries: entries
            .iter()
            .zip(regions)
            .map(|(e, r)| {
                let b = |j: usize| &r.blocks[j];
                let at =
                    |(n, &j): (usize, &usize)| (b(j).key, n as u32 + 1, b(j).words.len() as u32);
                e.iter().enumerate().map(at).collect()
            })
            .collect(),
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
                jscvt,
                features,
                fma: cfg.fma,
                parallel,
                pair_locks,
                clock,
                spill,
                groups: emit::GROUPS,
                span: span.unwrap_or(0),
            }
        } else {
            let (base, size) = (base as usize as u32, mem.size());
            emit::Ctx {
                helper: flat,
                bus: emit::Bus::Flat { base, phys, size },
                el1: head.key & KEY_EL1 != 0,
                crypto,
                sha3,
                jscvt,
                features,
                fma: cfg.fma,
                parallel,
                pair_locks,
                clock,
                spill: 0,
                groups: false,
                span: 0,
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
            nzcv,
            polled: cfg.polled,
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
        //
        // An emission is a function of its arguments (`plain`, the entry
        // states): one with the arguments of the last is that one, kept
        // (`last`) rather than emitted again. A region whose states settled
        // ends with the emission that showed it, and a block whose first
        // emission found no register plain, nor its flags dead, with that one.
        let n = r.blocks.len();
        let (none, mem) = (vec![emit::Regs::default(); n], vec![In::Mem; n]);
        let first = emit_region(&env, r, 0, &none, &mem);
        let plain = if r.looped() {
            0
        } else {
            first.c.read & !first.c.reused
        };
        let dead = first.dead.clone();
        let settle = |x: &Emission| -> (Vec<emit::Regs>, Vec<In>) {
            let regs = x.into.iter().map(|s| s.merge(*s, plain)).collect();
            let flags = (0..n)
                .map(|j| match x.flags[j] {
                    _ if dead[j] => In::Dead,
                    In::Lazy(k, sf) if j > 0 => In::Lazy(k, sf),
                    _ => In::Mem,
                })
                .collect();
            (regs, flags)
        };
        let (mut entry, mut flags) = settle(&first);
        let mut last = Some((0, none, mem, first));
        let emit = |last: &mut Option<Last>, plain, entry: &[_], flags: &[_]| {
            if let Some((p, e, f, x)) = last.take()
                && (p, &e[..], &f[..]) == (plain, entry, flags)
            {
                return x;
            }
            emit_region(&env, r, plain, entry, flags)
        };
        if n > 1 {
            let mut settled = false;
            for _ in 0..4 {
                let x = emit(&mut last, plain, &entry, &flags);
                let next = settle(&x);
                if next == (entry.clone(), flags.clone()) {
                    settled = true;
                    last = Some((plain, entry.clone(), flags.clone(), x));
                    break;
                }
                (entry, flags) = next;
            }
            if !settled {
                // Edges may not have what an entry holds dirty in a shadow
                // alone: made clean, a form every edge conforms to.
                entry = entry.iter().map(|s| s.loose()).collect();
            }
        }
        let mut x = emit(&mut last, plain, &entry, &flags);
        if x.bad {
            // The lazy states didn't settle: flags in memory on every edge.
            let dead = |j: usize| if dead[j] { In::Dead } else { In::Mem };
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
        nzcv_used |= c.nzcv_used;
        let name = format!("{:#x}_pa{:#x}", head.va, head.key & !3);
        let locals = c.locals();
        m.func(bt, &locals, &c.c, &name);
        out.inl.push(n);
        let mut links = vec![];
        for (i, b) in r.blocks.iter().enumerate() {
            let after = call_after(&b.words);
            for o in offsets(&b.words).into_iter().chain(after) {
                // What leaves the region for a compiled block, or may (an
                // edge whose check fails); a call's continuation stays only
                // in a later member.
                let k = succ(b.key, o);
                let to = if after == Some(o) {
                    r.target(i, o).filter(|&j| j > i)
                } else {
                    r.internal(i, o)
                };
                let stays = to.is_some_and(|j| !r.checked(i, j));
                if !stays && funcs.contains_key(&k) && !links.contains(&k) {
                    links.push(k);
                }
            }
        }
        out.links.push(links);
        out.counts += c.counts;
    }
    if nzcv_used {
        m.internal();
        for k in 0..emit::NZCV_HELPERS {
            let (_, code, t) = emit::nzcv_helper(k);
            let ty = m.ty(&[t, t], &[I32]);
            m.func(ty, &[(1, t)], &code, &format!("nzcv{k}"));
        }
    }
    out.bytes = m.finish();
    out
}

/// The transfer cache's miss functions (`emit::xmiss`) for a JIT cache: one
/// module, `f0` for EL0 and `f1` for EL1 (MMU on), and the stale-code
/// checker with `check`. A table installs it once, so it gets hot and
/// optimized (a copy in each module stayed in Liftoff).
pub fn miss_module(mem: &Mem, check: bool, pages: u32, polled: bool) -> Vec<u8> {
    let mut m = Module::default();
    let bt = m.ty(&[I32, I32, I32, I32], &[I32]);
    let checker = check.then(|| {
        let ct = m.ty(&[I32, I64], &[]);
        m.import_func("env", "jit_check", ct)
    });
    m.import_core_memory(pages);
    m.import_table("env", "table", 0);
    let (base, phys) = mem.base();
    for el in 0..2 {
        let tlb = (emit::tlb_array(el, 2), base as usize as u64, phys);
        let mut c = emit::xmiss(KEY_MMU | el, tlb, bt, checker, polled);
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
/// An emission with the arguments it was emitted with (`plain`, the entry
/// states: [`emit_region`]).
type Last = (u64, Vec<emit::Regs>, Vec<In>, Emission);

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
    c.nzcv = e.nzcv;
    c.polled = e.polled;
    c.page = (head & 0xfff) as i64;
    // Each member's merged incoming state, over the edges seen so far
    // (`reached`): the head's starts with the function's entry, where
    // nothing is held and the `Cpu` holds every register (a merge with it
    // keeps no register dirty in a shadow alone, whose upper bits it would
    // zero: docs/jit.md "Scalar shadows").
    let mut into = vec![emit::Regs::default(); n];
    let mut reached = vec![false; n];
    reached[0] = true;
    let mut flags = vec![In::Unset; n];
    let mut dead = vec![false; n];
    let mut bad = false;
    let mut inl = 0;
    c.local_get(0).i64_load(emit::PC).local_set(1);
    if let (Some(word), Some(hot)) = (r.tier, e.hot) {
        // It runs before the entries' prologue below, as at the head.
        assert!(
            r.entries().is_empty(),
            "a hot word on a region with entries ({:#x})",
            r.blocks[0].key
        );
        emit::tier_up(&mut c, word, r.blocks[0].key, e.bt, hot);
    }
    let looped = r.looped();
    // Polled code keeps `acc` itself: it has no `left`.
    if (n > 1 || looped) && !e.polled {
        c.local_get(emit::ACC).local_get(emit::LEFT).op(0x6a); // i32.add
        c.local_set(emit::SUM);
        c.sum = true;
    }
    // The head's state: loaded once, before the loop.
    c.conform(entry[0]);
    if looped {
        c.loop_();
    }
    for _ in 1..n {
        c.block();
    }
    // Entries besides the head: the entry number from the depth's high bits
    // (cleared), the entry PC moved back to the head's, and on to the member
    // with the registers it starts with. Its flags are in memory.
    let ents = r.entries();
    if !ents.is_empty() {
        const E: u32 = 8; // i32 scratch
        let here = c.regs;
        c.local_get(emit::DEPTH)
            .i32_const(emit::ENTRY_BIT as i32)
            .op(0x76) // i32.shr_u
            .local_tee(E)
            .hint(false)
            .if_();
        c.local_get(emit::DEPTH)
            .i32_const((1 << emit::ENTRY_BIT) - 1)
            .op(0x71) // i32.and
            .local_set(emit::DEPTH);
        for (k, &j) in ents.iter().enumerate() {
            c.local_get(E).i32_const(k as i32 + 1).op(0x46).if_(); // i32.eq
            emit::enter_at(&mut c, r.blocks[j].va.wrapping_sub(head) as i64);
            into[j] = if reached[j] {
                into[j].merge(here, 0)
            } else {
                here
            };
            reached[j] = true;
            flags[j] = flags[j].merge(In::Mem);
            c.conform(entry[j]);
            // Member j's label, from inside the two `if`s.
            c.br(j as u32 + 1).end();
            c.regs = here;
        }
        c.op(0x00).end(); // unreachable
    }
    for (i, b) in r.blocks.iter().enumerate() {
        if i > 0 {
            c.end(); // member i's label
        }
        c.base = b.va.wrapping_sub(head) as i64;
        c.note(
            super::wasm::NOTE_BLOCK,
            b.va.wrapping_sub(head),
            b.words.len() as u64,
        );
        c.regs = entry[i];
        c.fp_ok = false;
        c.fpa_ok = false;
        c.fp16_ok = false;
        c.new_block(&b.words);
        c.plan.clone_from(&e.plans[i]);
        c.enter_flags(match fin[i] {
            In::Lazy(k, sf) => Some((k, sf)),
            _ => None,
        });
        let len = b.words.len() as u32;
        let internal = |off: i64| r.internal(i, off);
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
                c.note(super::wasm::NOTE_FUSED, i as u64, k as u64);
                inl += 1;
                continue;
            }
            c.note(super::wasm::NOTE_INSN, i as u64, k as u64);
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
                // Branches end blocks and set the PC; an inline ISB (outside
                // parallel SMP) ends one and goes on.
                last = end(w) == End::No || goes_on(op);
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
        c.note(super::wasm::NOTE_TAIL, i as u64, 0);
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
            // Polled code polls an edge to a member at or before this block's VA
            // (every cycle inside the region has one: the loop's back-edge, mostly;
            // and a cycle through other functions may take it as a forward `br`),
            // and one whose key isn't above this block's: a member in another page
            // was taken by its VA, so its PA may be lower, and a run forward through
            // VAs aliasing one page would close a cycle of keys with no poll
            // (docs/jit.md "Preemption"). In a looped region with a fresh read: one
            // of them is on every lap of the wasm `loop`, where V8 may keep a plain
            // load's value.
            let mut cond = when;
            if !e.polled || to.va.wrapping_sub(b.va) as i64 <= 0 || (to.key & !3) <= (b.key & !3) {
                if e.polled {
                    emit::poll(c, looped);
                } else {
                    c.local_get(emit::LEFT)
                        .i32_const((len + jlen) as i32)
                        .op(0x4f); // i32.ge_u
                }
                if cond {
                    c.op(0x71); // i32.and
                }
                cond = true;
            }
            if r.checked(i, j) {
                // The check's VA goes through ADDR: a RET's target is no
                // longer there for `indirect`, which then loads the PC.
                c.pc_in_addr = false;
                let exec = emit::tlb_array(b.key & KEY_EL1, 2);
                let host = e.base.wrapping_add((to.key & !3) - e.phys);
                emit::maps_to(c, to.va.wrapping_sub(b.va) as i64, exec, host);
                if cond {
                    c.op(0x71); // i32.and
                }
                cond = true;
            }
            if !cond {
                c.i32_const(1);
            }
            c.hint(true).if_();
            let (here, fl) = (c.regs, c.flags);
            into[j] = if reached[j] {
                into[j].merge(here, 0)
            } else {
                here
            };
            reached[j] = true;
            let lazy = c.lazy();
            flags[j] = flags[j].merge(lazy.map_or(In::Mem, |(k, sf)| In::Lazy(k, sf)));
            if store(j, lazy) {
                c.commit_flags();
            }
            bad |= matches!(fin[j], In::Lazy(..)) && store(j, lazy);
            c.conform(entry[j]);
            if !c.sum {
                c.local_get(emit::ACC).i32_const(len as i32).op(0x6a); // i32.add
                c.local_set(emit::ACC);
            }
            if !e.polled {
                c.local_get(emit::LEFT).i32_const(len as i32).op(0x6b); // i32.sub
                c.local_set(emit::LEFT);
            }
            emit::dbump(
                c,
                if j == 0 {
                    tally::BACK_EDGE
                } else {
                    tally::FWD_EDGE
                },
            );
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
        // A call's continuation once its callee returned (an i32 on the
        // stack: whether the PC is there): the member there, or its block's
        // function.
        let after = call_after(&b.words);
        let mut cont = |c: &mut emit::Func| {
            let a = after.expect("a call");
            match r.target(i, a).filter(|&j| j > i) {
                Some(j) => {
                    // The callee may have rewritten what follows (the
                    // checker's case): the region's code, checked as at an
                    // entry, before the members run on.
                    if let Some(chk) = e.checker {
                        c.local_get(0).i64_const(r.blocks[0].key as i64).call(chk);
                    }
                    edge(c, j, 2, true)
                }
                None => {
                    c.if_();
                    chain(e, c, b, a, Xfer::Tail);
                    c.end();
                }
            }
        };
        let op = b.words.last().map(|&w| decode(w));
        match succs {
            Next::One(o) => {
                if leaves(o) {
                    if after.is_some() {
                        call(
                            e,
                            &mut c,
                            b,
                            &mut |c| chain(e, c, b, o, Xfer::Call(0)),
                            &mut cont,
                        );
                    } else {
                        chain(e, &mut c, b, o, Xfer::Tail);
                    }
                }
            }
            Next::Cond(t, o) => match (leaves(t), leaves(o)) {
                (true, true) => {
                    c.local_get(emit::TAKEN).if_();
                    chain(e, &mut c, b, t, Xfer::Tail);
                    c.else_();
                    chain(e, &mut c, b, o, Xfer::Tail);
                    c.end();
                }
                (false, false) => {}
                (lt, _) => {
                    c.local_get(emit::TAKEN);
                    if !lt {
                        c.op(0x45); // i32.eqz
                    }
                    c.if_();
                    chain(e, &mut c, b, if lt { t } else { o }, Xfer::Tail);
                    c.end();
                }
            },
            Next::None => {
                if op == Some(Op::RET) {
                    emit::ret_up(&mut c, len);
                }
                if e.jc && matches!(op, Some(Op::BR | Op::BLR | Op::RET)) {
                    let miss = (b.key & KEY_MMU != 0).then(|| e.miss(b.key));
                    let (regime, bt, chk) = (b.key & 3, e.bt, e.checker);
                    if op == Some(Op::BLR) {
                        let mut probe = |c: &mut emit::Func| {
                            emit::indirect(c, regime, miss, len, bt, chk, Xfer::Call(0), true)
                        };
                        call(e, &mut c, b, &mut probe, &mut cont);
                    } else {
                        emit::indirect(&mut c, regime, miss, len, bt, chk, Xfer::Tail, true);
                    }
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
fn chain(e: &Env, c: &mut emit::Func, b: &Block, off: i64, x: Xfer) {
    let k = succ(b.key, off);
    let len = b.words.len() as u32;
    let f = e.funcs.get(&k);
    if f.is_none() && !e.jc {
        return;
    }
    let guarded = b.key & KEY_MMU != 0 && (k ^ b.key) >> 12 != 0;
    let exec = emit::tlb_array(b.key & KEY_EL1, 2);
    // The PC is in the `Cpu` by now: the successor's VA.
    let back = k & !3 <= b.key & !3;
    let by_va = |c: &mut emit::Func| {
        let miss = Some(e.miss(b.key));
        emit::dslot(
            c,
            if off <= 0 {
                tally::BYVA_BACK
            } else {
                tally::BYVA_FWD
            },
        );
        // Polled code polls every by-VA link, forward ones too: the target is
        // whatever the VA maps now, so a run forward through VAs that alias
        // pages already run reaches the same compiled blocks again with no
        // static transfer backward (docs/jit.md "Preemption").
        emit::indirect(c, b.key & 3, miss, len, e.bt, e.checker, x, true);
    };
    // Straight to the miss function (it reads the PC from the `Cpu`), the
    // way the chain transfers: a call's a host call, so its callee still
    // returns to the caller's continuation (docs/jit.md "Calls").
    let to_miss = |c: &mut emit::Func| {
        let miss = emit::To::Func(e.miss(b.key), 0);
        emit::transfer(c, x, len, e.bt, miss, 0);
    };
    let Some(&(f, tlen, entry)) = f else {
        if guarded {
            return by_va(c);
        }
        c.i32_const(1);
        emit::dslot(c, if back { tally::JC_BACK } else { tally::JC_FWD });
        return emit::via_jc(c, Some(k), len, e.bt, e.checker, x, off <= 0);
    };
    // Polled code polls a chain to a VA at or before the block's start: its
    // key is the block's plus `off`, so a run of forward chains only reaches
    // higher keys, and every cycle of them has a backward one.
    let mut cond = false;
    if !e.polled || off <= 0 {
        if e.polled {
            emit::poll(c, false);
        } else {
            c.local_get(emit::LEFT)
                .i32_const((len + tlen) as i32)
                .op(0x4f); // i32.ge_u
        }
        cond = true;
    }
    if guarded {
        let host = e.base.wrapping_add((k & !3) - e.phys);
        emit::maps_to(c, off, exec, host);
        if cond {
            c.op(0x71); // i32.and
        }
        cond = true;
    }
    if !cond {
        c.i32_const(1);
    }
    c.hint(true).if_();
    emit::dbump(
        c,
        if back {
            tally::CHAIN_BACK
        } else {
            tally::CHAIN_FWD
        },
    );
    if let Some(chk) = e.checker {
        c.local_get(0).i64_const(k as i64).call(chk);
    }
    emit::transfer(c, x, len, e.bt, emit::To::Func(f, entry), 1);
    c.end();
    // The guard failed (rare: the VA maps elsewhere now): the miss function
    // finds the block, without a transfer cache probe of its own here.
    if guarded && e.jc {
        to_miss(c);
    }
}

/// The byte offset of a call's continuation (the instruction after a BL or
/// BLR that ends block `words`), if it ends on one.
fn call_after(words: &[u32]) -> Option<i64> {
    let w = *words.last()?;
    matches!(decode(w), Op::BL | Op::BLR).then_some(4 * words.len() as i64)
}

/// A guest call's host call (docs/jit.md "Calls"): `probe` emits the
/// transfers to block `b`'s callee as [`Xfer::Call`] to the label right
/// outside it (a host call below [`emit::MAX_DEPTH`], else a tail call).
/// When the callee returns ([`emit::RETURNED`]), `cont` continues at the
/// call's continuation (an i32 on the stack: whether the PC is there; two
/// blocks are open around it); if it doesn't, the PC's block is found
/// through the transfer cache's miss function (MMU on; with it off, the
/// block returns). If nothing was called, falls through.
fn call(
    e: &Env,
    c: &mut emit::Func,
    b: &Block,
    probe: &mut dyn FnMut(&mut emit::Func),
    cont: &mut dyn FnMut(&mut emit::Func),
) {
    let len = b.words.len() as u32;
    let after = call_after(&b.words).expect("a call");
    c.block().block();
    probe(c);
    c.br(1).end();
    // The callee's registers are the `Cpu`'s now, and its flags.
    let regs = c.regs;
    c.forget(!0);
    emit::returned(c, len, after);
    cont(c);
    if e.jc && b.key & KEY_MMU != 0 {
        let miss = emit::To::Func(e.miss(b.key), 0);
        emit::transfer(c, Xfer::Tail, len, e.bt, miss, 0);
    }
    c.ret(len);
    emit::unreturned(c);
    c.end();
    c.regs = regs;
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
            (0xd50342ff, End::No),    // msr daifclr, #2
            (0xd503415f, End::No),    // msr dit, #1
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
            0x20, 0, 0x29, 3, 0x80, 2, 0x21, 4,     // local.get 0; i64.load 256; local.set 4
            0x42, 3, 0x21, 5,                       // movz inline: x1 (local 5) = 3
            0x20, 0, 0x20, 5, 0x37, 3, 8,           // written back before the helper
            0x20, 0, 0x41, 0x80, 0x84, 0xed, 0xa8, 0x7d, 0x20, 4, 0x42, 4, 0x7c, // msr, pc + 4
            0x10, 1, 0x04, 0x40,                    // call mmu; if (hinted unlikely, at 37):
            0x20, 1, 0x41, 1, 0x6a, 0x0f, 0x0b,     //   return acc + 1
            0x20, 1, 0x41, 2, 0x6a, 0x0f, 0x0b,     // return acc + 2 (MSR ends it: no chaining)
        ];
        let name = b"0xffff0100_pa0x40000100";
        #[rustfmt::skip]
        let mut want = vec![
            0, b'a', b's', b'm', 1, 0, 0, 0,
            1, 16, 2, 0x60, 4, I32, I32, I32, I32, 1, I32, 0x60, 3, I32, I32, I64, 1, I32, // types
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
            0x20, 0, 0x20, 4, 0x42, 8, 0x7c, 0x37, 3, 0x80, 2,
            0x20, 0, 0x20, 5, 0x37, 3, 8, 0x20, 1, 0x41, 2, 0x6a, 0x0f, 0x0b,
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
            0x20, 0, 0x29, 3, 16, 0x42, 3, 0x7c, 0x22, 5, // x1 = x2 + 3 (kept: a tee)
            0x42, 1, 0x7c, 0x21, 6,                       // x3 = x1 + 1
        ];
        assert!(has(&bytes, &body));
        assert!(has(
            &bytes,
            &[0x20, 0, 0x20, 5, 0x37, 3, 8, 0x20, 0, 0x20, 6, 0x37, 3, 24]
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
            0x20, 0, 0x20, 5, 0x37, 3, 8,                    // x1 written back
            0x20, 0, 0x41,                                    // helper(vcpu, insn, …)
        ];
        assert!(has(&bytes, &around));
        #[rustfmt::skip]
        let after = [
            0x0f, 0x0b,                                       // …; if: return 1; end
            0x20, 0, 0x29, 3, 8, 0x22, 5, 0x42, 1, 0x7c, 0x21, 6, // x3 = x1 (reloaded) + 1
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
        // Locals after compaction (after the four parameters): entry, one scratch (for the store), the flag locals.
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
        assert!(has(&bytes, &[0x20, 5, 0x41, 0, 0x47])); // the i32 result, after the entry PC
        // adds x0, x1, x2; adc x3, x3, x3: the carry in is x + y < x, unsigned.
        let (bytes, counts) = one(&[0xab020020, 0x9a030063]);
        assert!(has(&bytes, &[0x20, 8, 0x20, 9, 0x7c, 0x20, 8, 0x54])); // i64.lt_u
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
            0x20, 0, 0x20, 1, 0x41, 2, 0x6a, 0x20, 2, 0x41, 2, 0x6b, 0x20, 3, 0x12, 2, 0x0b, // return_call
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
        assert!(has(&e.bytes, &[0x22, 6, 0x04, 0x40])); // if TAKEN, teed (compacted: after entry and x1)
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
        assert!(!has(
            &e.bytes,
            &[0x28, 2, 8, 0x41, 0xff, 0xff, 0xff, 7, 0x71, 0x13]
        ));
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
        let tail = [0xa7, 0x41, 0xff, 0xff, 0xff, 7, 0x71, 0x13, 0, 0]; // i32.wrap_i64, & IDX_MASK, return_call_indirect
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
        assert!(
            !has(&e.bytes, &tag)
                && has(
                    &e.bytes,
                    &[0x28, 2, 8, 0x41, 0xff, 0xff, 0xff, 7, 0x71, 0x13]
                )
        );
        // Something compiled at the PA that follows: the direct call behind
        // its check first, then (the check failed) a tail call of the miss
        // function, no transfer cache probe of its own.
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
        let miss = e.bytes.windows(2).rposition(|w| w[0] == 0x12 && w[1] != 2);
        assert!(call.is_some() && call < miss, "{call:?} {miss:?}");
        assert!(!has(&e.bytes, &tag) && has(&e.bytes, &[1, b't', 2, b'4', b'0', 0]));
    }

    /// A call (BL) to another page whose guard fails still calls (PERF loop
    /// 20): the miss function is host-called ([`Xfer::Call`]) below the
    /// depth limit, the callee's return then checked as the guarded call's
    /// is, and tail-called only past it.
    #[test]
    fn a_calls_failed_guard_still_calls_the_miss_function() {
        let b = Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![MOVZ, 0x94000400], // bl .+0x1000
        };
        let e = module(
            &[b.into()],
            &test_mem(),
            |k| (k == 0x4000_1204 | KEY_MMU).then_some((9, 1)),
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            Some(40),
        );
        assert_eq!(e.links, [vec![0x4000_1204 | KEY_MMU]]);
        // The imports: the two exec helpers, the callee (2), the miss function (3).
        assert_eq!(func_imports(&e.bytes), 4);
        let miss = 3;
        // `call f; local.set RESULT; br` to the block that `returned()`
        // follows: from inside the guard's `if` for the callee (2), from
        // outside it for the miss function.
        let host_call = |f: u8| {
            let at = e.bytes.windows(3).position(|w| w == [0x10, f, 0x21])?;
            Some((e.bytes[at + 3], e.bytes[at + 4..at + 7].to_vec()))
        };
        let (result, br) = host_call(2).expect("the guarded host call");
        assert_eq!(br, [0x0c, 2, 0x0b]);
        assert_eq!(
            host_call(miss),
            Some((result, vec![0x0c, 1, 0x0b])),
            "the failed guard's host call of the miss function"
        );
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
            let miss = miss_module(&test_mem(), false, pages, false);
            assert!(has(&miss, &want), "miss module, {pages} pages");
        }
    }

    /// The miss functions read the instruction TLB of their EL and fill the
    /// transfer cache.
    #[test]
    fn the_miss_functions_read_the_instruction_tlb_and_fill_the_transfer_cache() {
        let bytes = miss_module(&test_mem(), false, 0, false);
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
        // when `left` covers the head (2) and the member (2), with left
        // updated on the way (acc is `acc + left` at entry less left).
        #[rustfmt::skip]
        let taken = [
            0x20, 2, 0x41, 4, 0x4f, 0x04, 0x40,             // if left >= 4:
            0x20, 2, 0x41, 2, 0x6b, 0x21, 2, 0x0c, 4, 0x0b, //   left -= 2; br 4
        ];
        assert!(has(&e.bytes, &taken));
        // The back-edge from 0x114 (member 2, inside its `if TAKEN`): the
        // budget for it (1) and the head (2), then br 3, the loop.
        #[rustfmt::skip]
        let back = [
            0x20, 2, 0x41, 3, 0x4f, 0x04, 0x40,
            0x20, 2, 0x41, 1, 0x6b, 0x21, 2, 0x0c, 3, 0x0b,
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

    /// An entry is found by its own VA, never the head's, so a member is one
    /// only where the head's page has it (its VA offset from the head is its
    /// PA offset): the edges `Region::checked` leaves unchecked because the
    /// head's page has their member then hold from the entry too. A
    /// continuation in the head's PA page reached through another VA page (a
    /// page mapped at two VAs) isn't an entry.
    #[test]
    fn an_aliased_continuation_is_no_entry() {
        // 0x1ff8: add x2, x2, #1; bl 0x3000 (not taken). The continuation's VA
        // 0x2000 maps to PA 0x1000, in the head's page: add x2, x2, #2; ret.
        let (_r, m) = mem_with(0x1ff8, &[0x91000442, 0x94000401]);
        m.write(0x1000, 4, 0x91000842).unwrap();
        m.write(0x1004, 4, 0xd65f03c0).unwrap();
        let alias = |va: u64, k: Option<u64>| match va {
            0x3000 => None,
            0x2000 => Some(0x1000 | KEY_MMU | KEY_EL1),
            _ => k,
        };
        let head = 0x1ff8 | KEY_MMU | KEY_EL1;
        let r = forward(&m, head, 0x1ff8, &alias);
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key & !3).collect();
        assert_eq!(keys, [0x1ff8, 0x1000]);
        assert_eq!(r.entries(), [] as [usize; 0]);
    }

    /// A loop-carried scalar stays in its shadow across the head (docs/jit.md
    /// "Scalar shadows"): clean there, since the function's entry reaches it
    /// with the `Cpu`'s value, so the back-edge stores the shadow and the
    /// zeros above it, with no lane op in the loop.
    #[test]
    fn a_loop_carried_scalar_keeps_its_shadow() {
        // 0x100: ldr d1, [x0], #8; fadd d0, d0, d1; subs x2, x2, #1; b.ne 0x100
        // 0x110: ret
        let words = [0xfc408401, 0x1e612800, 0xf1000442, 0x54ffffa1, 0xd65f03c0];
        let (_r, m) = mem_with(0x100, &words);
        let r = region(&m, 0x100, 0x100, &|_| true);
        assert_eq!(r.back_edges(), 1);
        let e = module(
            &[r],
            &test_mem(),
            |_| None,
            &Config::DEFAULT,
            false,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!(e.inl, [4]);
        // From the loop on: v128.const, the splats and the lanes' extracts
        // and replaces (0xfd 0x0c to 0x22).
        let lp = e.bytes.windows(2).position(|w| w == [0x03, 0x40]).unwrap();
        let lane = |w: &[u8]| w[0] == 0xfd && (0x0c..=0x22).contains(&w[1]);
        let ops = e.bytes[lp..].windows(2).filter(|w| lane(w)).count();
        assert_eq!(ops, 0, "lane ops from the loop on");
        // V0's shadow is loaded before the loop (and again only after the
        // FADD's helper, in its slow arm); the back-edge stores it, the
        // shadow and the zeros above (f64.store, i64.store of 0).
        let v = core::mem::offset_of!(crate::cpu::Cpu, v) as u32;
        let memarg = |op: u8, align: u8, off: u32| {
            let mut b = vec![op, align];
            let mut x = off;
            while x >= 0x80 {
                b.push(x as u8 | 0x80);
                x >>= 7;
            }
            b.push(x as u8);
            b
        };
        let load = memarg(0x2b, 3, v);
        let first = e.bytes.windows(load.len()).position(|w| w == load);
        assert!(first.is_some_and(|k| k < lp), "V0's f64.load at {first:?}");
        let mut back = memarg(0x39, 3, v);
        back.extend([0x20, 0, 0x42, 0]);
        back.extend(memarg(0x37, 3, v + 8));
        assert!(has(&e.bytes[lp..], &back));
    }

    /// A hot word's check runs before the entries' prologue (`emit::tier_up`
    /// passes the depth on with the entry bits, and the PC as the head's), so
    /// only a region without entries may have one: a loop head compiled
    /// alone. Anything else is refused at emission.
    #[test]
    #[should_panic(expected = "a hot word on a region with entries")]
    fn a_region_with_entries_takes_no_hot_word() {
        let words = [0x91000442, 0x94000040, 0x91000842, 0xd65f03c0];
        let (_r, m) = mem_with(0x100, &words);
        let mut r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x204));
        assert_eq!(r.entries(), [1]);
        r.tier = Some(1);
        module(
            &[r],
            &test_mem(),
            |k| (k == 0x204).then_some((9, 1)),
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            None,
        );
    }

    #[test]
    fn a_call_not_taken_returns_to_an_entry() {
        // 0x100: add x2, x2, #1; bl 0x204
        // 0x108: add x2, x2, #2; ret
        // 0x204: (not admitted: compiled elsewhere)
        let words = [0x91000442, 0x94000040, 0x91000842, 0xd65f03c0];
        let (_r, m) = mem_with(0x100, &words);
        let r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x204));
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key).collect();
        assert_eq!(keys, [0x100, 0x108]);
        assert_eq!(r.entries(), [1]);
        // The callee compiled (table index 9, entry 0): called directly, and
        // the module reports the entry; the prologue branches to it.
        let e = module(
            &[r],
            &test_mem(),
            |k| (k == 0x204).then_some((9, 1)),
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!(e.entries, [vec![(0x108, 1, 2)]]);
        assert!(has(&e.bytes, &[0x10, 2])); // call t.9 (function 2)
        // A loop has no entries besides its head.
        let (_r, m) = mem_with(0x100, &[0x94000040, 0x17ffffff]); // bl 0x200; b 0x100
        let r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x200));
        assert!(r.looped() && r.entries().is_empty());
    }

    #[test]
    fn a_callee_that_can_leave_the_region_is_called() {
        // 0x100: bl 0x120; 0x104: ret
        // 0x120: bl 0x140; 0x124: ret
        // 0x140: b 0x200 (not admitted)
        let mut words = [0u32; 17];
        words[0] = 0x94000008;
        words[1] = 0xd65f03c0;
        words[8] = 0x94000008;
        words[9] = 0xd65f03c0;
        words[16] = 0x14000030;
        let (_r, m) = mem_with(0x100, &words);
        let keys = |r: &Region| r.blocks.iter().map(|b| b.key).collect::<Vec<_>>();
        // 0x140 leaves for 0x200: had both calls been followed, its tail call
        // there would have left their host frames behind, so the inner call
        // is a host call (its continuation taken) and the outer one, whose
        // callee now returns as predicted, stays followed.
        let r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x200));
        assert_eq!(keys(&r), [0x100, 0x120, 0x124, 0x104]);
        assert_eq!(r.returns, [(0x124, 0x104)]);
        assert_eq!(r.entries(), [2, 3]);
        // Admitted, 0x200 (a `udf`: no words) leaves too.
        let r = forward(&m, 0x100, 0x100, &|_, k| k);
        assert_eq!(keys(&r), [0x100, 0x120, 0x124, 0x104]);
        // A callee whose `ret` isn't X30's.
        words[9] = 0xd65f0020; // ret x1
        let (_r, m) = mem_with(0x100, &words);
        let r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x200));
        assert_eq!((keys(&r), r.returns.len()), (vec![0x100, 0x104], 0));
    }

    /// A second call to a callee the walk took through a first one is a host
    /// call, its continuation taken: the callee's `ret` predicts only the
    /// first call's return.
    #[test]
    fn a_second_call_to_a_callee_taken_is_a_host_call() {
        // 0x100: cbz x1, 0x10c (the taken side walked first)
        // 0x104: bl 0x120; 0x108: ret
        // 0x10c: bl 0x120; 0x110: ret
        // 0x120: ret
        let mut words = [0u32; 9];
        words[0] = 0xb4000061;
        words[1] = 0x94000007;
        words[2] = 0xd65f03c0;
        words[3] = 0x94000005;
        words[4] = 0xd65f03c0;
        words[8] = 0xd65f03c0;
        let (_r, m) = mem_with(0x100, &words);
        let asked = core::cell::Cell::new(0);
        let r = forward(&m, 0x100, 0x100, &|_, k| {
            asked.set(asked.get() + 1);
            k
        });
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key).collect();
        assert_eq!(keys, [0x100, 0x104, 0x108, 0x10c, 0x120, 0x110]);
        assert_eq!(r.returns, [(0x120, 0x110)]);
        assert_eq!(r.entries(), [2, 5]);
        // `member` isn't asked again for a VA taken.
        assert_eq!(asked.get(), 5);
        // Were the callee compiled too, the call at 0x104 would call its
        // function (a link); the one at 0x10c branches to the member.
        let e = module(
            &[r],
            &test_mem(),
            |k| (k == 0x120).then_some((9, 1)),
            &Config::DEFAULT,
            true,
            crate::cpu::FEATURES,
            None,
        );
        assert_eq!(e.links, [vec![0x120]]);
    }

    /// A callee whose code reaches a block taken outside it, and can leave the
    /// region from there, is called; so is one whose code reaches another
    /// call's callee, whose `ret` predicts the other call's return.
    #[test]
    fn a_callee_that_leaves_through_a_block_taken_elsewhere_is_called() {
        // 0x100: cbz x1, 0x110 (a tail call, walked first)
        // 0x104: bl 0x120; 0x108: ret
        // 0x110: b 0x200 (not admitted)
        // 0x120: cbz x2, 0x110 (the callee tail-calls too); 0x124: ret
        let mut words = [0u32; 10];
        words[0] = 0xb4000081;
        words[1] = 0x94000007;
        words[2] = 0xd65f03c0;
        words[4] = 0x1400003c;
        words[8] = 0xb4ffff82;
        words[9] = 0xd65f03c0;
        let (_r, m) = mem_with(0x100, &words);
        let keys = |r: &Region| r.blocks.iter().map(|b| b.key).collect::<Vec<_>>();
        let r = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x200));
        assert_eq!(
            (keys(&r), r.returns.len()),
            (vec![0x100, 0x104, 0x108, 0x110], 0)
        );
        // 0x100: cbz x1, 0x10c
        // 0x104: bl 0x130; 0x108: ret
        // 0x10c: bl 0x120; 0x110: ret
        // 0x120: ret
        // 0x130: b 0x120 (the second callee tail-calls the first)
        let mut words = [0u32; 13];
        words[0] = 0xb4000061;
        words[1] = 0x9400000b;
        words[2] = 0xd65f03c0;
        words[3] = 0x94000005;
        words[4] = 0xd65f03c0;
        words[8] = 0xd65f03c0;
        words[12] = 0x17fffffc;
        let (_r, m) = mem_with(0x100, &words);
        let r = forward(&m, 0x100, 0x100, &|_, k| k);
        assert_eq!(keys(&r), [0x100, 0x104, 0x108, 0x10c, 0x120, 0x110]);
        assert_eq!(r.returns, [(0x120, 0x110)]);
    }

    /// A call back to the head is a call, not a loop's back-edge: neither
    /// [`region`] nor [`forward`] makes recursion a loop.
    #[test]
    fn recursion_to_the_head_is_called() {
        // 0x100: cbz x0, 0x110
        // 0x104: sub x0, x0, #1; bl 0x100
        // 0x10c: ret; 0x110: ret
        let words = [0xb4000080, 0xd1000400, 0x97fffffe, 0xd65f03c0, 0xd65f03c0];
        let (_r, m) = mem_with(0x100, &words);
        let r = region(&m, 0x100, 0x100, &|_| true);
        assert_eq!((r.blocks.len(), r.looped()), (1, false));
        // Across pages (MMU off): 0x1000 calls 0x2000, which calls 0x1000.
        // 0x1000: cbz x0, 0x100c; 0x1004: bl 0x2000; 0x1008: ret; 0x100c: ret
        // 0x2000: sub x0, x0, #1; bl 0x1000; 0x2008: ret
        let (_r, m) = mem_with(0x1000, &[0xb4000060, 0x940003ff, 0xd65f03c0, 0xd65f03c0]);
        m.write(0x2000, 4, 0xd1000400).unwrap();
        m.write(0x2004, 4, 0x97fffbff).unwrap();
        m.write(0x2008, 4, 0xd65f03c0).unwrap();
        let r = forward(&m, 0x1000, 0x1000, &|va, k| k.or(Some(va)));
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key).collect();
        assert!(!r.looped(), "{keys:x?}");
        assert_eq!(r.returns, [(0x2008, 0x1008)]);
        assert!(
            keys.contains(&0x2008) && keys.contains(&0x1008),
            "{keys:x?}"
        );
    }

    /// An edge inside a followed callee that checks the member's mapping may
    /// leave the region (the check fails): the call is a host call.
    #[test]
    fn a_callee_with_a_checked_edge_is_called() {
        // VA 0x7000 at PA 0x1000: bl 0x7100; ret
        // VA 0x7100 at PA 0x1100: b 0x8000
        // VA 0x8000 at PA 0x3000: ret
        let (_r, m) = mem_with(0x1000, &[0x94000040, 0xd65f03c0]);
        m.write(0x1100, 4, 0x140003c0).unwrap();
        m.write(0x3000, 4, 0xd65f03c0).unwrap();
        let bits = KEY_MMU | KEY_EL1;
        let r = forward(&m, 0x1000 | bits, 0x7000, &|va, k| match va {
            0x8000 => Some(0x3000 | bits),
            _ => k,
        });
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key & !3).collect();
        assert_eq!((keys, r.returns.len()), (vec![0x1000, 0x1004], 0));
    }

    /// A followed call whose edge checks the callee's mapping is a host call
    /// when the check fails; then its continuation's own check may fail too,
    /// a chain out of the call it is in: that call is a host call.
    #[test]
    fn a_checked_call_whose_continuation_is_checked_is_called_in_a_call() {
        // VA 0x7000 at PA 0x1000: bl 0x7ff8; ret
        // VA 0x7ff8 at PA 0x1ff8: nop; bl 0x8100 (its continuation in the next page)
        // VA 0x8100 at PA 0x3100: ret
        // VA 0x8000 at PA 0x3000: ret
        let (_r, m) = mem_with(0x1000, &[0x940003fe, 0xd65f03c0]);
        m.write(0x1ff8, 4, NOP as u64).unwrap();
        m.write(0x1ffc, 4, 0x94000041).unwrap();
        m.write(0x3100, 4, 0xd65f03c0).unwrap();
        m.write(0x3000, 4, 0xd65f03c0).unwrap();
        let bits = KEY_MMU | KEY_EL1;
        let member = |va: u64, k: Option<u64>| match va {
            0x8000.. => Some((va - 0x5000) | bits),
            _ => k,
        };
        let r = forward(&m, 0x1000 | bits, 0x7000, &member);
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key & !3).collect();
        // The outer call is called; the inner one, its callee's edge checked,
        // is followed in a region of its own.
        assert_eq!((keys, r.returns.len()), (vec![0x1000, 0x1004], 0));
        let r = forward(&m, 0x1ff8 | bits, 0x7ff8, &member);
        let keys: Vec<u64> = r.blocks.iter().map(|b| b.key & !3).collect();
        assert_eq!(keys, [0x1ff8, 0x3100, 0x3000]);
        assert!(r.checked(0, 1) && r.checked(0, 2) && !r.checked(1, 2));
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
        // Without the block after the call the return isn't an edge, so the
        // callee isn't taken: called, it returns to its host call.
        let r5 = forward(&m, 0x100, 0x100, &|_, k| k.filter(|&k| k != 0x118));
        assert_eq!(
            (keys(&r5), r5.returns.len()),
            (vec![0x100, 0x104, 0x110, 0x10c], 0)
        );
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
            0x20, 4, 0x42, 0x18, 0x7c, 0x51,          // … == entry PC + 0x18
            0x20, 2, 0x41, 2, 0x4f, 0x71, 0x04, 0x40, // and left >= 2: if
        ];
        let at = e
            .bytes
            .windows(predicted.len())
            .position(|w| w == predicted);
        let indirect = e
            .bytes
            .windows(10)
            .rposition(|w| w == [0x28, 2, 8, 0x41, 0xff, 0xff, 0xff, 7, 0x71, 0x13]);
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
            [8]
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
            follows: vec![],
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
        let (_r, m) = mem_with(0x100, &[0x14000001; 2 * REGION]);
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
            follows: vec![],
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
        let mut head = vec![0x20, 0, 0x29, 3, 0x80, 2, 0x21, 4, 0x20, 0, 0x28, 2];
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

    /// The function imports of a module (its import section's entries of kind 0).
    fn func_imports(m: &[u8]) -> u32 {
        let uleb = |p: &mut usize| {
            let (mut v, mut sh) = (0u64, 0);
            loop {
                let b = m[*p];
                *p += 1;
                v |= ((b & 0x7f) as u64) << sh;
                sh += 7;
                if b & 0x80 == 0 {
                    return v;
                }
            }
        };
        let mut p = 8;
        while p < m.len() {
            let (id, size) = (m[p], {
                p += 1;
                uleb(&mut p) as usize
            });
            if id != 2 {
                p += size;
                continue;
            }
            let mut funcs = 0;
            for _ in 0..uleb(&mut p) {
                for _ in 0..2 {
                    let n = uleb(&mut p) as usize;
                    p += n;
                }
                let kind = m[p];
                p += 1;
                match kind {
                    0 => {
                        uleb(&mut p);
                        funcs += 1;
                    }
                    1 => {
                        p += 1; // the reftype
                        let flags = m[p];
                        p += 1;
                        uleb(&mut p);
                        if flags & 1 != 0 {
                            uleb(&mut p);
                        }
                    }
                    2 => {
                        let flags = m[p];
                        p += 1;
                        uleb(&mut p);
                        if flags & 1 != 0 {
                            uleb(&mut p);
                        }
                    }
                    _ => p += 2, // a global: its type and mutability
                }
            }
            return funcs;
        }
        0
    }

    #[test]
    fn failure_chains_take_nzcv_from_the_module_helpers() {
        // subs x0, x1, x2; ldr x3, [x4]; b.eq .+8 (MMU on): the load's failure
        // chain stores the SUBS's NZCV by calling the 64-bit SUBS helper
        // (`nzcv1`, the second function after the module's one region); the
        // commit before the branch stays inline. The helpers aren't exported:
        // one export, f0.
        let b = Block {
            key: 0x4000_0200 | KEY_MMU,
            va: 0,
            words: vec![0xeb020020, 0xf9400083, 0x54000040],
        };
        let e = build(b);
        assert!(has(&e.bytes, b"nzcv1"));
        let at = e
            .bytes
            .windows(3)
            .position(|w| w == [2, b'f', b'0'])
            .expect("export f0");
        assert_eq!(e.bytes[at - 1], 1, "one export");
        let mut call = vec![0x10];
        crate::jit::wasm::uleb(&mut call, func_imports(&e.bytes) as u64 + 2);
        let calls = e
            .bytes
            .windows(call.len())
            .filter(|w| *w == &call[..])
            .count();
        assert_eq!(calls, 1, "the chain's end calls nzcv1");
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
        assert!(has(
            &e.bytes,
            &[0xa7, 0x41, 0xff, 0xff, 0xff, 7, 0x71, 0x13, 0, 0, 0x0b]
        ));
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
