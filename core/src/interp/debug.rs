//! Self-hosted debug (v8.0): breakpoints, watchpoints and software step,
//! raised by an interpreter of their own (docs/cpu.md "Self-hosted debug").
//!
//! Nothing here runs while nobody debugs. [`arm`] marks an EL whose code could
//! raise a debug exception (`Cpu::interp_only`); the JIT's dispatcher tests the
//! current EL's (`Cpu::dispatch`) where it tested `SCTLR_EL1.A`, and sends the
//! EL here. It
//! changes only through an MSR that ends its JIT block (and returns
//! `Exit::Resync` when it changes, which ends an interpreter's chunk), and the
//! EL changes only through the run loop or an ERET, which ends a block too.
//! The arming is coarse (a comparator enabled for the EL); the checks here are
//! exact.

use super::{Exit, R, exec_at};
use crate::cpu::{Cpu, DISPATCH_MMU, INTERP_ALIGN, INTERP_DEBUG, PSTATE_D, PSTATE_SS, sctlr};
use crate::mem::{Access, Fault, FaultKind, Host, Mem};
use crate::mmu::{Bus, Mmu, Tlb, Use};

/// MDSCR_EL1: SS, TDCC, KDE, MDE.
pub const MDSCR_SS: u64 = 1 << 0;
pub const MDSCR_TDCC: u64 = 1 << 12;
pub const MDSCR_KDE: u64 = 1 << 13;
pub const MDSCR_MDE: u64 = 1 << 15;
/// DBGBCR<n>_EL1's fields (v8.0): BT, LBN, SSC, HMC, BAS, PMC, E.
pub const BCR_MASK: u64 = 0x00ff_e1e7;
/// DBGWCR<n>_EL1's fields: MASK, WT, LBN, SSC, HMC, BAS, LSC, PAC, E.
pub const WCR_MASK: u64 = 0x1f1f_ffff;
/// The Software Step exception's ISS bits we keep: ISV (24) and EX (6).
pub const STEP_SYN: u64 = 1 << 24 | 1 << 6;
/// ESR's IFSC/DFSC for a debug exception.
const FSC_DEBUG: u32 = 0x22;
/// The bits of a VA a comparator compares (v8.0: 48 bits, and bit 48 for the
/// sign; DBGBVR/DBGWVR bits 63:49 are its sign extension).
const VA: u64 = (1 << 49) - 1;
/// Breakpoint types (DBGBCR.BT): unlinked and linked address match, unlinked
/// and linked context ID match.
const BT_ADDR: u64 = 0b0000;
const BT_ADDR_LINKED: u64 = 0b0001;
const BT_CTX: u64 = 0b0010;
const BT_CTX_LINKED: u64 = 0b0011;
/// The context-aware breakpoint: the highest-numbered (one context comparator).
const CTX_BP: usize = 1;

/// Recomputes `Cpu::interp_only` and `Cpu::dispatch` (after a write to
/// SCTLR_EL1, MDSCR_EL1, the OS lock or a comparator's control, and a restore). An EL is armed when a
/// debug exception could be raised there: step on, or MDE and an enabled
/// comparator for that EL, with the OS lock clear and, for EL1, KDE set.
/// `PSTATE.D` is left to the exact checks: it changes without ending a block.
pub fn arm(c: &mut Cpu) {
    let align = if c.sctlr_el1 & sctlr::A != 0 {
        INTERP_ALIGN
    } else {
        0
    };
    let md = c.mdscr_el1;
    let comparator = |el: u64| {
        let bp = (0..2).any(|n| {
            let bcr = c.dbgbcr[n];
            bcr & 1 != 0 && bt(bcr) != BT_CTX_LINKED && el_match(bcr, el)
        });
        // At EL1, any watchpoint: LDTR and STTR match those for EL0.
        let wp = (0..2).any(|n| c.dbgwcr[n] & 1 != 0 && (el == 1 || el_match(c.dbgwcr[n], el)));
        md & MDSCR_MDE != 0 && (bp || wp)
    };
    let on = c.os_lock == 0;
    let armed = |el: u64| {
        let ok = on && (el == 0 || md & MDSCR_KDE != 0);
        if ok && (md & MDSCR_SS != 0 || comparator(el)) {
            INTERP_DEBUG
        } else {
            0
        }
    };
    c.interp_only = [align | armed(0), align | armed(1)];
    c.dispatch = if c.sctlr_el1 & sctlr::M != 0 {
        DISPATCH_MMU
    } else {
        0
    };
    c.set_pstate(c.pstate); // the current EL's
}

/// Whether some EL is armed (the run loops without a JIT check this once a
/// chunk; with one, the dispatcher checks the current EL's).
#[inline(always)]
pub fn armed(c: &Cpu) -> bool {
    (c.interp_only[0] | c.interp_only[1]) & INTERP_DEBUG != 0
}

/// Runs up to `n` instructions as [`super::steps`] does, raising the debug
/// exceptions. With `armed_only` (the JIT's dispatcher), it returns as soon
/// as the EL it's at isn't armed. Cold and never inlined: the dispatcher's
/// code stays as it was but for the call.
#[cold]
#[inline(never)]
pub(crate) fn steps(
    cpu: &mut Cpu,
    mem: &Mem,
    tlb: Option<&mut Tlb>,
    n: u64,
    armed_only: bool,
) -> (u64, Option<Exit>) {
    fn go(cpu: &mut Cpu, m: &mut impl Bus, n: u64, armed_only: bool) -> (u64, Option<Exit>) {
        for done in 0..n {
            if armed_only && cpu.interp_only[(cpu.el() & 1) as usize] & INTERP_DEBUG == 0 {
                return (done, None);
            }
            if let Err(e) = step(cpu, m) {
                return (done, Some(e));
            }
        }
        (n, None)
    }
    // One copy of the interpreter: `Mmu` also covers the MMU off.
    go(cpu, &mut Watch(Mmu::new(mem, tlb)), n, armed_only)
}

/// [`enabled_for`] the current PSTATE at `el`.
fn enabled(c: &Cpu, el: u64) -> bool {
    enabled_for(c, c.pstate & !0xc | el << 2)
}

/// Whether debug exceptions can be taken with PSTATE `p` (EL_D is EL1): the
/// OS lock clear, and at EL1 itself `MDSCR_EL1.KDE` set and `PSTATE.D` clear.
/// ERET checks its target's for software step.
pub(crate) fn enabled_for(c: &Cpu, p: u64) -> bool {
    c.os_lock == 0 && (p & 0xc == 0 || c.mdscr_el1 & MDSCR_KDE != 0 && p & PSTATE_D == 0)
}

/// Whether the instruction at the PC is stepped: software step is enabled
/// at the current EL. One that reaches an exception was active-not-pending
/// (pending, `step` takes the step exception instead).
pub(crate) fn stepping(c: &Cpu) -> bool {
    enabled(c, c.el()) && c.mdscr_el1 & MDSCR_SS != 0
}

/// An exception's EC for a class taken from EL0 (`ec`) or EL1 (`ec` + 1).
fn ec(ec: u32, el: u64) -> u32 {
    (ec + el as u32) << 26
}

/// One instruction, in the order of the architecture's priorities: a pending
/// Software Step exception, then the PC alignment fault and the instruction
/// abort, then a breakpoint; a stepped instruction that completes leaves the
/// step pending.
fn step(c: &mut Cpu, m: &mut impl Bus) -> R {
    let (pc, el) = (c.pc, c.el());
    let on = enabled(c, el);
    let stepping = stepping(c);
    if stepping && c.pstate & PSTATE_SS == 0 {
        return Err(Exit::Trap(ec(0x32, el) | c.step_syn as u32 | FSC_DEBUG));
    }
    if pc & 3 != 0 {
        return Err(Exit::Fetch(Fault {
            addr: pc,
            access: Access::Read,
            kind: FaultKind::Align,
        }));
    }
    let insn = m.fetch(c, pc).map_err(Exit::Fetch)?;
    if on && c.mdscr_el1 & MDSCR_MDE != 0 && breakpoint(c, pc, el) {
        return Err(Exit::Trap(ec(0x30, el) | FSC_DEBUG));
    }
    if !stepping {
        return exec_at(c, m, insn, pc);
    }
    // Active-not-pending: the instruction completes, or takes an exception
    // that leaves it to run again (SPSR.SS = 1). An SVC or HVC completes it, as
    // does what the run loop finishes (the platform's registers, WFI, MMIO).
    // `FaultKind::Bus` is MMIO's too: `take_exception` sets SS for a real
    // external abort.
    c.pstate &= !PSTATE_SS;
    c.step_syn = 1 << 24 | (load_exclusive(insn) as u64) << 6;
    let r = exec_at(c, m, insn, pc);
    if let Err(
        Exit::Undefined
        | Exit::Trap(_)
        | Exit::Brk(_)
        | Exit::Fetch(_)
        | Exit::Fault(Fault {
            kind:
                FaultKind::Align
                | FaultKind::AddressSize(_)
                | FaultKind::Translation(_)
                | FaultKind::AccessFlag(_)
                | FaultKind::Permission(_)
                | FaultKind::WalkBus(_)
                | FaultKind::Watch,
            ..
        }),
    ) = r
    {
        c.pstate |= PSTATE_SS;
    }
    r
}

/// LDXR, LDAXR, LDXP, LDAXP (any size): the step's EX bit. The group's
/// o2 = 0, L = 1 (bits 29:22) with o1 (bit 21) set is a pair, LDXP/LDAXP
/// with bit 31 set and CASP with it clear (which isn't a Load-Exclusive).
fn load_exclusive(i: u32) -> bool {
    i & 0x3fc0_0000 == 0x0840_0000 && (i >> 31 == 1 || i >> 21 & 1 == 0)
}

/// DBGBCR.BT.
fn bt(bcr: u64) -> u64 {
    bcr >> 20 & 0xf
}

/// Whether a comparator's PMC/PAC and SSC let it match at `el` (HMC only
/// adds EL2; SSC 0b10, Secure only, never matches: there's no Secure state).
fn el_match(cr: u64, el: u64) -> bool {
    cr >> 14 & 3 != 0b10 && cr >> 1 & (if el == 0 { 2 } else { 1 }) != 0
}

/// Whether context breakpoint `n` (enabled, of type `ty`) matches CONTEXTIDR_EL1.
fn context(c: &Cpu, n: usize, ty: u64) -> bool {
    let bcr = c.dbgbcr[n];
    n == CTX_BP && bcr & 1 != 0 && bt(bcr) == ty && c.dbgbvr[n] as u32 == c.contextidr_el1 as u32
}

/// Whether a breakpoint matches the instruction at `pc`, fetched at `el`.
fn breakpoint(c: &Cpu, pc: u64, el: u64) -> bool {
    (0..2).any(|n| {
        let bcr = c.dbgbcr[n];
        let addr = || bcr >> 5 & 0xf != 0 && (pc & VA) >> 2 == (c.dbgbvr[n] & VA) >> 2;
        bcr & 1 != 0
            && el_match(bcr, el)
            && match bt(bcr) {
                BT_ADDR => addr(),
                BT_ADDR_LINKED => addr() && context(c, (bcr >> 16 & 0xf) as usize, BT_CTX_LINKED),
                BT_CTX => context(c, n, BT_CTX),
                _ => false,
            }
    })
}

/// The first of `size` bytes at `va` a watchpoint matches, accessed with
/// `el`'s permissions (EL0 for LDTR/STTR), a store if `write`: the address
/// the exception reports (QEMU's too).
fn watchpoint(c: &Cpu, va: u64, size: u64, el: u64, write: bool) -> Option<u64> {
    let on: [bool; 2] = core::array::from_fn(|n| {
        let wcr = c.dbgwcr[n];
        let lsc = wcr >> 3 & 3;
        wcr & 1 != 0
            && lsc & if write { 2 } else { 1 } != 0
            && el_match(wcr, el)
            && (wcr >> 20 & 1 == 0 || context(c, (wcr >> 16 & 0xf) as usize, BT_CTX_LINKED))
    });
    if on == [false; 2] {
        return None;
    }
    let hit = |n: usize, b: u64| {
        let (wcr, wvr) = (c.dbgwcr[n], c.dbgwvr[n] & VA);
        let mask = (wcr >> 24 & 0x1f) as u32;
        // BAS selects bytes of the doubleword at WVR[48:3], or (WVR[2] set)
        // of the word at WVR[48:2]; MASK, when it's 3 or more, a 2^MASK block.
        let bas = wcr >> 5 & 0xff;
        let bytes = if wvr & 4 != 0 { (bas & 0xf) << 4 } else { bas };
        match mask {
            0 => b >> 3 == wvr >> 3 && bytes >> (b & 7) & 1 != 0,
            1 | 2 => false, // reserved
            _ => b >> mask == wvr >> mask,
        }
    };
    (0..size)
        .map(|k| va.wrapping_add(k))
        .find(|&a| (0..2).any(|n| on[n] && hit(n, a & VA)))
}

/// The bus the debug interpreter goes through: an [`Mmu`], with each data
/// access checked against the watchpoints. The access translates first (its
/// alignment, translation, access flag and permission faults come before a
/// watchpoint, `AArch64.TranslateAddress`), then a watchpoint is taken before
/// anything is read or written, a device access's included (what isn't RAM
/// reaches its bus here as `FaultKind::Bus`, which a watchpoint precedes). No
/// `fast` path: every access comes through here.
pub(crate) struct Watch<'a>(pub Mmu<'a>);

/// What a data access does, for the watchpoints' LSC.
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Load,
    Store,
    /// An atomic read-modify-write (LSE's LD<op>, SWP, CAS and CASP, a
    /// failing CAS too): a watchpoint for loads or for stores matches it, and
    /// WnR is 0 if one for loads would (ESR_ELx.ISS.WnR).
    Rmw,
}

/// The watchpoint exception for `size` bytes at `va` accessed with `el`'s
/// permissions, if one matches and debug exceptions are enabled. The run
/// loop's `Io` checks a device access with it: an instruction that reaches a
/// device runs again there, past the accesses `Watch` checked.
pub(crate) fn hit(c: &Cpu, va: u64, size: u64, el: u64, kind: Kind) -> Option<Fault> {
    if c.mdscr_el1 & MDSCR_MDE == 0 || !enabled(c, c.el()) {
        return None;
    }
    let (addr, access) = match kind {
        Kind::Load => (watchpoint(c, va, size, el, false)?, Access::Read),
        Kind::Store => (watchpoint(c, va, size, el, true)?, Access::Write),
        Kind::Rmw => match watchpoint(c, va, size, el, false) {
            Some(a) => {
                // The first byte either kind matches.
                let w = watchpoint(c, va, size, el, true).unwrap_or(a);
                (a.min(w), Access::Read)
            }
            None => (watchpoint(c, va, size, el, true)?, Access::Write),
        },
    };
    Some(Fault {
        addr,
        access,
        kind: FaultKind::Watch,
    })
}

/// A translation's outcome as a probe sees it: what isn't RAM translated too.
fn translated<T>(r: Result<T, Fault>) -> Result<(), Fault> {
    match r {
        Err(f) if f.kind != FaultKind::Bus => Err(f),
        _ => Ok(()),
    }
}

impl Watch<'_> {
    /// A load or store: translated (without the access) before a watchpoint is taken.
    fn plain(&mut self, c: &Cpu, va: u64, size: u32, el: u64, kind: Kind) -> Result<(), Fault> {
        let Some(w) = hit(c, va, size as u64, el, kind) else {
            return Ok(());
        };
        let (access, u) = match kind {
            Kind::Load => (Access::Read, Use::Read),
            _ => (Access::Write, Use::Write),
        };
        translated(self.0.span(c, va, size, access, u, el))?;
        Err(w)
    }

    /// An atomic's host address, translated (a fault first) and then checked.
    fn atomic(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
        kind: Kind,
    ) -> Result<Host, Fault> {
        let r = self.0.host_aligned(c, va, len, access);
        translated(r)?;
        match hit(c, va, len, c.el(), kind) {
            Some(w) => Err(w),
            None => r,
        }
    }
}

impl Bus for Watch<'_> {
    fn mem(&self) -> &Mem {
        self.0.mem()
    }

    fn read_el(&mut self, c: &Cpu, va: u64, size: u32, el: u64) -> Result<u64, Fault> {
        self.plain(c, va, size, el, Kind::Load)?;
        self.0.read_el(c, va, size, el)
    }

    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault> {
        self.plain(c, va, size, el, Kind::Store)?;
        self.0.write_el(c, va, size, val, el)
    }

    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        self.0.fetch(c, pc)
    }

    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<Option<u64>, Fault> {
        self.0.maint(c, va, write)
    }

    /// The exclusives', LDAR's and STLR's, and STXR's (`store_exclusive`).
    fn host_aligned(&mut self, c: &Cpu, va: u64, len: u64, access: Access) -> Result<Host, Fault> {
        let kind = match access {
            Access::Read => Kind::Load,
            Access::Write => Kind::Store,
            Access::Maint => return self.0.host_aligned(c, va, len, access),
        };
        self.atomic(c, va, len, access, kind)
    }

    fn cas(&mut self, c: &Cpu, va: u64, size: u32, expected: u64, new: u64) -> Result<u64, Fault> {
        let p = self.atomic(c, va, size as u64, Access::Write, Kind::Rmw)?;
        // SAFETY: aligned RAM (host_aligned).
        Ok(unsafe { self.mem().cas(p, size, expected, new) })
    }

    fn rmw(&mut self, c: &Cpu, va: u64, size: u32, op: u32, v: u64) -> Result<u64, Fault> {
        let p = self.atomic(c, va, size as u64, Access::Write, Kind::Rmw)?;
        // SAFETY: as in cas.
        Ok(unsafe { self.mem().rmw(p, size, op, v) })
    }

    fn cas_pair(
        &mut self,
        c: &Cpu,
        va: u64,
        expected: [u64; 2],
        new: [u64; 2],
    ) -> Result<[u64; 2], Fault> {
        let p = self.atomic(c, va, 16, Access::Write, Kind::Rmw)?;
        // SAFETY: 16 aligned bytes of RAM (host_aligned).
        Ok(unsafe { self.mem().cas_pair(p, expected, new) })
    }

    fn fast(&mut self, _c: &Cpu, _va: u64, _size: u32, _u: Use) -> Option<*mut u8> {
        None
    }

    fn flush_all(&mut self) {
        self.0.flush_all()
    }

    fn flush_va(&mut self, va: u64) {
        self.0.flush_va(va)
    }

    fn flush_ng(&mut self) {
        self.0.flush_ng()
    }
}
