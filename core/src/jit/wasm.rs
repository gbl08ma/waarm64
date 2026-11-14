//! A minimal WebAssembly binary encoder: just what the JIT emits. Modules
//! import their functions, memory and table from the core, define functions of
//! a few types, export them as `f0`, `f1`, … and name them in the name section
//! (guest PCs, so DevTools and `perf` profiles read).

pub const I32: u8 = 0x7f;
pub const I64: u8 = 0x7e;
pub const F32: u8 = 0x7d;
pub const F64: u8 = 0x7c;
pub const V128: u8 = 0x7b;
const FUNCREF: u8 = 0x70;

pub fn uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            return out.push(b);
        }
        out.push(b | 0x80);
    }
}

pub fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) {
            return out.push(b);
        }
        out.push(b | 0x80);
    }
}

fn name(out: &mut Vec<u8>, s: &str) {
    uleb(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn section(out: &mut Vec<u8>, id: u8, count: usize, body: &[u8]) {
    if count == 0 {
        return;
    }
    let mut v = Vec::with_capacity(body.len() + 5);
    uleb(&mut v, count as u64);
    v.extend_from_slice(body);
    out.push(id);
    uleb(out, v.len() as u64);
    out.extend(v);
}

/// A function body under construction: locals, then instructions.
#[derive(Default)]
pub struct Code {
    pub b: Vec<u8>,
    /// Where each local index operand is in `b` (one byte: indices < 128),
    /// for [`Code::compact_locals`].
    locals: Vec<usize>,
    /// Branch hints (M6): where an `if` or `br_if` is in `b`, and whether
    /// it's likely taken; the module's `metadata.code.branch_hint` section.
    hints: Vec<(usize, bool)>,
    /// The memory guest RAM accesses ([`Code::ram`] and its kin) name: 0,
    /// or a spill memory's index while a load's or store's spill arm is
    /// emitted (docs/spill-memories.md "The JIT's spill arm").
    pub ram_mem: u32,
    /// Where the last [`Code::mark`] was taken or [`Code::rewind`] returned to: a
    /// `local.set` that ends there isn't merged with a `local.get` after it
    /// ([`Code::local_get`]), or a rewind to that mark would keep the merged
    /// `local.tee`'s value on the stack. Marks nest, so the latest is the only
    /// one the code can be at.
    fence: core::cell::Cell<usize>,
    /// Where the last `i32.const 0` or `i64.const 0` ends (0: none), so an
    /// `add`, `sub`, `or` or `xor` of it drops both ([`Code::op`]).
    zero: usize,
}

impl Code {
    /// Where the code is now, for [`Code::rewind`].
    pub fn mark(&self) -> (usize, usize, usize) {
        self.fence.set(self.b.len());
        (self.b.len(), self.locals.len(), self.hints.len())
    }
    /// Drops what was emitted since `m`.
    pub fn rewind(&mut self, m: (usize, usize, usize)) {
        self.b.truncate(m.0);
        self.fence.set(m.0);
        self.zero = 0;
        self.locals.truncate(m.1);
        self.hints.truncate(m.2);
    }
    /// Hints the `if` or `br_if` emitted next: its condition is likely true
    /// (or not). V8 moves the unlikely side out of line as deferred code,
    /// where TurboFan's register allocator puts the spills a call there needs
    /// instead of on the hot path.
    pub fn hint(&mut self, likely: bool) -> &mut Self {
        self.hints.push((self.b.len(), likely));
        self
    }
}

/// Instruction encoders; each appends one instruction.
impl Code {
    pub fn op(&mut self, op: u8) -> &mut Self {
        let n = self.b.len();
        // x + 0, x - 0, x | 0, x ^ 0 (i32: 0x6a, 0x6b, 0x72, 0x73; i64 0x7c, 0x7d, 0x84, 0x85).
        if self.zero == n
            && self.fence.get() != n
            && matches!(op, 0x6a | 0x6b | 0x72 | 0x73 | 0x7c | 0x7d | 0x84 | 0x85)
        {
            self.b.truncate(n - 2);
            self.zero = 0;
            return self;
        }
        self.b.push(op);
        self
    }
    /// A load or store `op` with its alignment hint (log2) and constant offset.
    pub fn memarg(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(op);
        uleb(&mut self.b, align as u64);
        uleb(&mut self.b, offset as u64);
        self
    }
    /// [`Code::memarg`] on guest RAM: in memory [`Code::ram_mem`] (multi-memory:
    /// bit 6 of the alignment field says a memory index follows it).
    pub fn ram(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(op);
        self.ram_memarg(align, offset)
    }
    fn ram_memarg(&mut self, align: u32, offset: u32) -> &mut Self {
        if self.ram_mem == 0 {
            uleb(&mut self.b, align as u64);
        } else {
            uleb(&mut self.b, (align | 0x40) as u64);
            uleb(&mut self.b, self.ram_mem as u64);
        }
        uleb(&mut self.b, offset as u64);
        self
    }
    /// [`Code::simd_mem`] on guest RAM.
    pub fn ram_simd(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(0xfd);
        uleb(&mut self.b, op as u64);
        self.ram_memarg(align, offset)
    }
    /// [`Code::atomic`] on guest RAM.
    pub fn ram_atomic(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(0xfe);
        self.ram(op, align, offset)
    }
    /// A SIMD memory instruction (`0xfd` prefix): v128.load (0), v128.store
    /// (11), v128.load32_zero (92), v128.load64_zero (93).
    pub fn simd_mem(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(0xfd);
        uleb(&mut self.b, op as u64);
        uleb(&mut self.b, align as u64);
        uleb(&mut self.b, offset as u64);
        self
    }
    /// A SIMD instruction without immediates (`0xfd` prefix, LEB opcode).
    pub fn simd(&mut self, op: u32) -> &mut Self {
        self.b.push(0xfd);
        uleb(&mut self.b, op as u64);
        self
    }
    /// A SIMD lane instruction (extract_lane, replace_lane) on lane `lane`.
    pub fn simd_lane(&mut self, op: u32, lane: u8) -> &mut Self {
        self.simd(op);
        self.b.push(lane);
        self
    }
    pub fn f32_const(&mut self, v: f32) -> &mut Self {
        self.b.push(0x43);
        self.b.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn f64_const(&mut self, v: f64) -> &mut Self {
        self.b.push(0x44);
        self.b.extend_from_slice(&v.to_le_bytes());
        self
    }
    /// v128.const.
    pub fn v128_const(&mut self, v: u128) -> &mut Self {
        self.simd(0x0c);
        self.b.extend_from_slice(&v.to_le_bytes());
        self
    }
    /// i8x16.shuffle: byte `k` of the result is byte `lanes[k]` of a:b (b's are 16–31).
    pub fn shuffle(&mut self, lanes: [u8; 16]) -> &mut Self {
        self.simd(0x0d);
        self.b.extend_from_slice(&lanes);
        self
    }
    /// An atomic load or store (threads proposal, `0xfe` prefix) of
    /// `1 << align` bytes: wasm requires the natural alignment as the hint,
    /// and traps on a misaligned address.
    pub fn atomic(&mut self, op: u8, align: u32, offset: u32) -> &mut Self {
        self.b.push(0xfe);
        self.memarg(op, align, offset)
    }
    /// atomic.fence (`0xfe 0x03 0x00`): a sequentially consistent fence
    /// (`dmb ish` on arm64 in V8).
    pub fn atomic_fence(&mut self) -> &mut Self {
        self.b.extend_from_slice(&[0xfe, 0x03, 0x00]);
        self
    }
    /// A local's index as a placeholder byte (up to 255), which
    /// [`Code::compact_locals`] renumbers to one under 128 (one byte of LEB128).
    fn local(&mut self, op: u8, i: u32) -> &mut Self {
        assert!(i < 256);
        self.b.push(op);
        self.locals.push(self.b.len());
        self.b.push(i as u8);
        self
    }
    /// `local.get`; right after a `local.set` of the same local (and no
    /// [`Code::mark`] between them), the set becomes a `local.tee` instead.
    pub fn local_get(&mut self, i: u32) -> &mut Self {
        let n = self.b.len();
        if n >= 2
            && self.locals.last() == Some(&(n - 1))
            && self.b[n - 2] == 0x21
            && self.b[n - 1] as u32 == i
            && self.fence.get() != n
        {
            self.b[n - 2] = 0x22;
            return self;
        }
        self.local(0x20, i)
    }
    pub fn global_get(&mut self, i: u32) -> &mut Self {
        self.op(0x23);
        uleb(&mut self.b, i as u64);
        self
    }
    pub fn local_set(&mut self, i: u32) -> &mut Self {
        self.local(0x21, i)
    }
    pub fn local_tee(&mut self, i: u32) -> &mut Self {
        self.local(0x22, i)
    }

    /// Whether the code reads or writes local `i`.
    pub fn uses_local(&self, i: u32) -> bool {
        self.locals.iter().any(|&p| self.b[p] as u32 == i)
    }

    /// Renumbers the locals the code uses so that only those are declared:
    /// `params[k]` (as emitted) becomes parameter `k`, `ty(i)` is local `i`'s
    /// type, and the other locals are grouped by type in order (every
    /// declared local costs Liftoff a zero-initialization per call). Returns
    /// the declarations.
    pub fn compact_locals(&mut self, params: &[u32], ty: impl Fn(u32) -> u8) -> Vec<(u32, u8)> {
        let mut used = [false; 256];
        for &p in &self.locals {
            used[self.b[p] as usize] = true;
        }
        let mut map = [0u16; 256];
        for (k, &p) in params.iter().enumerate() {
            used[p as usize] = false;
            map[p as usize] = k as u16;
        }
        let mut decls = Vec::new();
        let mut next = params.len() as u32;
        for t in [I64, I32, F64, F32, V128] {
            let n = next;
            for i in 0..256 {
                if used[i as usize] && ty(i) == t {
                    map[i as usize] = next as u16;
                    next += 1;
                }
            }
            if next > n {
                decls.push((next - n, t));
            }
        }
        if next <= 128 {
            for &p in &self.locals {
                self.b[p] = map[self.b[p] as usize] as u8;
            }
            return decls;
        }
        // More than one byte's worth (a region using nearly every local, with
        // the block type's four parameters): every index takes two, padded
        // LEB128 (valid wasm), and the hints move with the code after them.
        assert!(next <= 1 << 14, "{next} locals");
        let mut b = Vec::with_capacity(self.b.len() + self.locals.len());
        let (mut from, mut shift) = (0, 0);
        let mut hints = self.hints.iter_mut().peekable();
        for &p in &self.locals {
            while let Some(h) = hints.next_if(|h| h.0 <= p) {
                h.0 += shift;
            }
            b.extend_from_slice(&self.b[from..p]);
            let v = map[self.b[p] as usize] as u32;
            b.extend([(v & 0x7f) as u8 | 0x80, (v >> 7) as u8]);
            from = p + 1;
            shift += 1;
        }
        for h in hints {
            h.0 += shift;
        }
        b.extend_from_slice(&self.b[from..]);
        self.b = b;
        self.locals.clear();
        decls
    }
    pub fn call(&mut self, f: u32) -> &mut Self {
        self.b.push(0x10);
        uleb(&mut self.b, f as u64);
        self
    }
    /// An indirect call of type `ty` through table 0.
    pub fn call_indirect(&mut self, ty: u32) -> &mut Self {
        self.b.push(0x11);
        uleb(&mut self.b, ty as u64);
        self.b.push(0);
        self
    }
    /// An indirect tail call of type `ty` through table 0.
    pub fn return_call_indirect(&mut self, ty: u32) -> &mut Self {
        self.b.push(0x13);
        uleb(&mut self.b, ty as u64);
        self.b.push(0);
        self
    }
    /// A tail call (the tail-call proposal, in V8 since 11.2).
    pub fn return_call(&mut self, f: u32) -> &mut Self {
        self.b.push(0x12);
        uleb(&mut self.b, f as u64);
        self
    }
    /// `block` with no result type; closed by [`Code::end`].
    pub fn block(&mut self) -> &mut Self {
        self.b.extend([0x02, 0x40]);
        self
    }
    /// `block` with a result of type `ty`; closed by [`Code::end`].
    pub fn block_t(&mut self, ty: u8) -> &mut Self {
        self.b.extend([0x02, ty]);
        self
    }
    /// `loop` with no result type; closed by [`Code::end`].
    pub fn loop_(&mut self) -> &mut Self {
        self.b.extend([0x03, 0x40]);
        self
    }
    /// `br` to the label `depth` levels out.
    pub fn br(&mut self, depth: u32) -> &mut Self {
        self.b.push(0x0c);
        uleb(&mut self.b, depth as u64);
        self
    }
    /// `br_if` to the label `depth` levels out.
    pub fn br_if(&mut self, depth: u32) -> &mut Self {
        self.b.push(0x0d);
        uleb(&mut self.b, depth as u64);
        self
    }
    /// `if` with no result type; closed by [`Code::end`].
    pub fn if_(&mut self) -> &mut Self {
        self.b.extend([0x04, 0x40]);
        self
    }
    /// `if` with a result of type `ty`; needs an `else`.
    pub fn if_t(&mut self, ty: u8) -> &mut Self {
        self.b.extend([0x04, ty]);
        self
    }
    /// `else` of an [`Code::if_`].
    pub fn else_(&mut self) -> &mut Self {
        self.op(0x05)
    }
    /// Untyped `select` (i32 or i64 operands).
    pub fn select(&mut self) -> &mut Self {
        self.op(0x1b)
    }
    pub fn return_(&mut self) -> &mut Self {
        self.op(0x0f)
    }
    pub fn i32_const(&mut self, v: i32) -> &mut Self {
        self.b.push(0x41);
        sleb(&mut self.b, v as i64);
        if v == 0 {
            self.zero = self.b.len();
        }
        self
    }
    pub fn i64_const(&mut self, v: i64) -> &mut Self {
        self.b.push(0x42);
        sleb(&mut self.b, v);
        if v == 0 {
            self.zero = self.b.len();
        }
        self
    }
    pub fn i64_load(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x29, 3, offset)
    }
    pub fn i32_load(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x28, 2, offset)
    }
    pub fn i32_store(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x36, 2, offset)
    }
    pub fn i64_store(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x37, 3, offset)
    }
    pub fn i64_add(&mut self) -> &mut Self {
        self.op(0x7c)
    }
    pub fn i64_and(&mut self) -> &mut Self {
        self.op(0x83)
    }
    pub fn i32_wrap_i64(&mut self) -> &mut Self {
        self.op(0xa7)
    }
    pub fn i64_extend_i32_u(&mut self) -> &mut Self {
        self.op(0xad)
    }
    pub fn end(&mut self) -> &mut Self {
        self.op(0x0b)
    }
}

#[derive(Default)]
pub struct Module {
    types: Vec<(Vec<u8>, Vec<u8>)>,
    imports: Vec<u8>,
    nimports: usize,
    nfunc_imports: u32,
    funcs: Vec<u32>,
    /// Functions defined past these aren't exported ([`Module::internal`]).
    nexported: Option<usize>,
    code: Vec<u8>,
    globals: Vec<u8>,
    nglobals: usize,
    names: Vec<u8>,
    /// The branch-hint section's entries, and how many functions have some.
    hints: Vec<u8>,
    nhinted: usize,
}

impl Module {
    /// The index of the function type `params -> results`, added if new.
    pub fn ty(&mut self, params: &[u8], results: &[u8]) -> u32 {
        let t = (params.to_vec(), results.to_vec());
        let i = self.types.iter().position(|x| *x == t).unwrap_or_else(|| {
            self.types.push(t);
            self.types.len() - 1
        });
        i as u32
    }

    fn import(&mut self, module: &str, field: &str, kind: u8) {
        name(&mut self.imports, module);
        name(&mut self.imports, field);
        self.imports.push(kind);
        self.nimports += 1;
    }

    /// Imports a function; returns its index. Imports come before any `func`.
    pub fn import_func(&mut self, module: &str, field: &str, ty: u32) -> u32 {
        assert!(self.funcs.is_empty());
        self.import(module, field, 0);
        uleb(&mut self.imports, ty as u64);
        self.nfunc_imports += 1;
        self.nfunc_imports - 1
    }

    /// Imports a funcref table with at least `min` elements, no maximum.
    pub fn import_table(&mut self, module: &str, field: &str, min: u32) {
        self.import(module, field, 1);
        self.imports.extend([FUNCREF, 0]);
        uleb(&mut self.imports, min as u64);
    }

    /// Imports a shared memory (the core's; layout A) of `min` to `max` pages.
    pub fn import_memory(&mut self, module: &str, field: &str, min: u32, max: u32) {
        self.import(module, field, 2);
        self.imports.push(3); // shared, with a maximum
        uleb(&mut self.imports, min as u64);
        uleb(&mut self.imports, max as u64);
    }

    /// Imports the core's memory as `env.memory`: with exact limits when it
    /// has a fixed size of `pages` (`jit::Config::pages`), else 0 to 65536.
    pub fn import_core_memory(&mut self, pages: u32) {
        match pages {
            0 => self.import_memory("env", "memory", 0, 65536),
            n => self.import_memory("env", "memory", n, n),
        }
    }

    /// Defines a mutable i64 global holding 0 (never written); returns its
    /// index. V8 can't fold a mutable global's value, so `x & global` is zero
    /// yet still depends on `x` (the JIT's opaque zero: jit.md "Atomics").
    pub fn zero_global(&mut self) -> u32 {
        self.globals.extend([0x7e, 1, 0x42, 0, 0x0b]);
        self.nglobals += 1;
        self.nglobals as u32 - 1
    }

    /// Adds a function of type `ty` with `locals` (count, type) runs and
    /// `body` (ending in `end`), exported as `f<k>` for the k-th defined
    /// function and named `fname` in the name section. Returns its index.
    /// The index the next [`Module::func`] gets.
    pub fn next_func(&self) -> u32 {
        self.nfunc_imports + self.funcs.len() as u32
    }

    /// From here on, the functions defined aren't exported: the module's own
    /// helpers (the host installs every export as a block, `jit_install`).
    pub fn internal(&mut self) {
        self.nexported.get_or_insert(self.funcs.len());
    }

    pub fn func(&mut self, ty: u32, locals: &[(u32, u8)], body: &Code, fname: &str) -> u32 {
        let idx = self.nfunc_imports + self.funcs.len() as u32;
        self.funcs.push(ty);
        let mut f = Vec::with_capacity(body.b.len() + 8);
        uleb(&mut f, locals.len() as u64);
        for &(n, t) in locals {
            uleb(&mut f, n as u64);
            f.push(t);
        }
        // Hint offsets count from the body's start, its locals included.
        if !body.hints.is_empty() {
            uleb(&mut self.hints, idx as u64);
            uleb(&mut self.hints, body.hints.len() as u64);
            for &(at, likely) in &body.hints {
                uleb(&mut self.hints, (f.len() + at) as u64);
                self.hints.extend([1, likely as u8]);
            }
            self.nhinted += 1;
        }
        f.extend_from_slice(&body.b);
        uleb(&mut self.code, f.len() as u64);
        self.code.extend(f);
        uleb(&mut self.names, idx as u64);
        name(&mut self.names, fname);
        idx
    }

    pub fn finish(self) -> Vec<u8> {
        let mut out = b"\0asm\x01\0\0\0".to_vec();
        let mut types = Vec::new();
        for (p, r) in &self.types {
            types.push(0x60);
            uleb(&mut types, p.len() as u64);
            types.extend(p);
            uleb(&mut types, r.len() as u64);
            types.extend(r);
        }
        section(&mut out, 1, self.types.len(), &types);
        section(&mut out, 2, self.nimports, &self.imports);
        let mut funcs = Vec::new();
        let mut exports = Vec::new();
        let nexported = self.nexported.unwrap_or(self.funcs.len());
        for (k, &t) in self.funcs.iter().enumerate() {
            uleb(&mut funcs, t as u64);
            if k < nexported {
                name(&mut exports, &format!("f{k}"));
                exports.push(0);
                uleb(&mut exports, self.nfunc_imports as u64 + k as u64);
            }
        }
        section(&mut out, 3, self.funcs.len(), &funcs);
        section(&mut out, 6, self.nglobals, &self.globals);
        section(&mut out, 7, nexported, &exports);
        if self.nhinted > 0 {
            // Branch hints, before the code they describe.
            let mut body = Vec::new();
            name(&mut body, "metadata.code.branch_hint");
            uleb(&mut body, self.nhinted as u64);
            body.extend(&self.hints);
            out.push(0);
            uleb(&mut out, body.len() as u64);
            out.extend(body);
        }
        section(&mut out, 10, self.funcs.len(), &self.code);
        if !self.funcs.is_empty() {
            // The name section: subsection 1, function names.
            let mut sub = Vec::new();
            uleb(&mut sub, self.funcs.len() as u64);
            sub.extend(&self.names);
            let mut body = Vec::new();
            name(&mut body, "name");
            body.push(1);
            uleb(&mut body, sub.len() as u64);
            body.extend(sub);
            out.push(0);
            uleb(&mut out, body.len() as u64);
            out.extend(body);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(v: u64) -> Vec<u8> {
        let mut b = Vec::new();
        uleb(&mut b, v);
        b
    }
    fn s(v: i64) -> Vec<u8> {
        let mut b = Vec::new();
        sleb(&mut b, v);
        b
    }

    #[test]
    fn leb128() {
        assert_eq!(u(0), [0]);
        assert_eq!(u(127), [0x7f]);
        assert_eq!(u(128), [0x80, 1]);
        assert_eq!(u(624485), [0xe5, 0x8e, 0x26]);
        assert_eq!(u(u64::MAX).len(), 10);
        assert_eq!(s(-1), [0x7f]);
        assert_eq!(s(63), [0x3f]);
        assert_eq!(s(64), [0xc0, 0]);
        assert_eq!(s(-64), [0x40]);
        assert_eq!(s(-65), [0xbf, 0x7f]);
        assert_eq!(s(-123456), [0xc0, 0xbb, 0x78]);
        assert_eq!(
            s(i64::MIN),
            [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f]
        );
    }

    #[test]
    fn compact_locals_past_128() {
        // 130 locals used besides 4 parameters: every index two bytes
        // (padded LEB128), and a hint after them moved by as many bytes.
        let mut c = Code::default();
        for i in 0..4 {
            c.local_get(i);
        }
        for i in 10..140 {
            c.local_get(i);
        }
        c.hint(true).if_().end();
        let before = c.b.len();
        let decls = c.compact_locals(&[0, 1, 2, 3], |_| I64);
        assert_eq!(decls, [(130, I64)]);
        assert_eq!(c.b.len(), before + 134);
        assert_eq!(&c.b[..4], &[0x20, 0x80, 0, 0x20]); // local.get 0, padded
        let last = 3 * 133;
        assert_eq!(&c.b[last..last + 4], &[0x20, 0x80 | (133 & 0x7f), 1, 0x04]); // local.get 133; if
        assert_eq!(c.hints, [(last + 3, true)]);
    }

    #[test]
    fn compact_locals() {
        // Params 0 and 100 (the second); locals 3 (i32), 5 and 9 (i64) used.
        let mut c = Code::default();
        c.local_get(0)
            .local_get(9)
            .local_set(3)
            .local_tee(5)
            .local_get(9)
            .local_get(100);
        let decls = c.compact_locals(&[0, 100], |i| if i == 3 { I32 } else { I64 });
        assert_eq!(decls, [(2, I64), (1, I32)]);
        assert_eq!(c.b, [0x20, 0, 0x20, 3, 0x21, 4, 0x22, 2, 0x20, 3, 0x20, 1]);
    }

    #[test]
    fn module_bytes() {
        let mut m = Module::default();
        let t = m.ty(&[I32], &[I32]);
        assert_eq!(m.ty(&[I32], &[I32]), t); // deduplicated
        let h = m.import_func("env", "h", t);
        m.import_memory("env", "memory", 1, 2);
        let mut c = Code::default();
        c.local_get(0).end();
        assert_eq!(m.func(t, &[(1, I64)], &c, "0x40"), h + 1);
        #[rustfmt::skip]
        let want = [
            0, b'a', b's', b'm', 1, 0, 0, 0,
            1, 6, 1, 0x60, 1, I32, 1, I32, // type section
            2, 24, 2, // import section
            3, b'e', b'n', b'v', 1, b'h', 0, 0,
            3, b'e', b'n', b'v', 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 3, 1, 2,
            3, 2, 1, 0, // function section
            7, 6, 1, 2, b'f', b'0', 0, 1, // export section
            10, 8, 1, 6, 1, 1, I64, 0x20, 0, 0x0b, // code section
            0, 14, 4, b'n', b'a', b'm', b'e', 1, 7, 1, 1, 4, b'0', b'x', b'4', b'0', // names
        ];
        assert_eq!(m.finish(), want);
    }

    #[test]
    fn branch_hints() {
        let mut m = Module::default();
        let t = m.ty(&[I32], &[]);
        let mut c = Code::default();
        // local.get 0; if (unlikely) end; local.get 0; if (likely) end; end
        c.local_get(0).hint(false).if_().end();
        let mark = c.mark();
        c.local_get(0).hint(true).if_().end();
        c.rewind(mark); // a rewound hint goes with its code
        c.local_get(0).hint(true).if_().end().end();
        m.func(t, &[(1, I64)], &c, "f");
        let b = m.finish();
        // The section, before the code section: function 0, two hints; the
        // `if`s at 2 and 7 in the code, after the 3 bytes of locals.
        #[rustfmt::skip]
        let want = [
            0, 35, 25, b'm', b'e', b't', b'a', b'd', b'a', b't', b'a', b'.', b'c', b'o', b'd', b'e', b'.',
            b'b', b'r', b'a', b'n', b'c', b'h', b'_', b'h', b'i', b'n', b't',
            1, 0, 2, 5, 1, 0, 10, 1, 1,
            10,
        ];
        let at = b.windows(want.len()).position(|w| w == want);
        assert!(at.is_some(), "{b:x?}");
    }

    #[test]
    fn peepholes() {
        // local.set 3; local.get 3 is local.tee 3; local.get of another local isn't merged.
        let mut c = Code::default();
        c.local_get(0)
            .local_set(3)
            .local_get(3)
            .local_set(4)
            .local_get(5);
        assert_eq!(c.b, [0x20, 0, 0x22, 3, 0x21, 4, 0x20, 5]);
        // Not across a mark: a rewind to it must find the set as it was.
        let mut c = Code::default();
        c.local_get(0).local_set(3);
        let m = c.mark();
        c.local_get(3);
        assert_eq!(c.b, [0x20, 0, 0x21, 3, 0x20, 3]);
        c.rewind(m);
        assert_eq!(c.b, [0x20, 0, 0x21, 3]);
        // Nor right after a rewind to one (an outer mark may be there too).
        c.i32_const(1).local_set(6);
        let m = c.mark();
        c.local_get(7);
        c.rewind(m);
        c.local_get(6);
        assert_eq!(c.b, [0x20, 0, 0x21, 3, 0x41, 1, 0x21, 6, 0x20, 6]);
        // x + 0, x | 0 (i32 and i64) drop the zero; 0 - x and x * 0 don't.
        let mut c = Code::default();
        c.local_get(0).i64_const(0).op(0x7c).i32_const(0).op(0x72);
        assert_eq!(c.b, [0x20, 0]);
        c.i64_const(0).local_get(1).op(0x7d).i64_const(0).op(0x7e);
        assert_eq!(c.b, [0x20, 0, 0x42, 0, 0x20, 1, 0x7d, 0x42, 0, 0x7e]);
        // A zero before a mark stays: the rewind's code may need it.
        let mut c = Code::default();
        c.local_get(0).i64_const(0);
        let m = c.mark();
        c.op(0x7c);
        assert_eq!(c.b, [0x20, 0, 0x42, 0, 0x7c]);
        c.rewind(m);
        c.local_get(1).op(0x7c);
        assert_eq!(c.b, [0x20, 0, 0x42, 0, 0x20, 1, 0x7c]);
    }
}
