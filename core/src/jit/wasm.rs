//! A minimal WebAssembly binary encoder: just what the JIT emits. Modules
//! import their functions, memory and table from the core, define functions of
//! a few types, export them as `f0`, `f1`, … and name them in the name section
//! (guest PCs, so DevTools and `perf` profiles read).

pub const I32: u8 = 0x7f;
pub const I64: u8 = 0x7e;
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
}

/// Instruction encoders; each appends one instruction.
impl Code {
    pub fn op(&mut self, op: u8) -> &mut Self {
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
    fn local(&mut self, op: u8, i: u32) -> &mut Self {
        assert!(i < 128);
        self.b.push(op);
        self.locals.push(self.b.len());
        self.b.push(i as u8);
        self
    }
    pub fn local_get(&mut self, i: u32) -> &mut Self {
        self.local(0x20, i)
    }
    pub fn local_set(&mut self, i: u32) -> &mut Self {
        self.local(0x21, i)
    }
    pub fn local_tee(&mut self, i: u32) -> &mut Self {
        self.local(0x22, i)
    }

    /// Renumbers the locals the code uses so that only those are declared:
    /// `ty(i)` is local `i`'s type, locals below `params` stay as they are,
    /// and the rest are grouped by type in order (every declared local costs
    /// Liftoff a zero-initialization per call). Returns the declarations.
    pub fn compact_locals(&mut self, params: u32, ty: impl Fn(u32) -> u8) -> Vec<(u32, u8)> {
        let mut used = [false; 128];
        for &p in &self.locals {
            used[self.b[p] as usize] = true;
        }
        let mut map = [0u8; 128];
        let mut decls = Vec::new();
        let mut next = params;
        for t in [I64, I32] {
            let n = next;
            for i in params..128 {
                if used[i as usize] && ty(i) == t {
                    map[i as usize] = next as u8;
                    next += 1;
                }
            }
            if next > n {
                decls.push((next - n, t));
            }
        }
        for i in 0..params {
            map[i as usize] = i as u8;
        }
        for &p in &self.locals {
            self.b[p] = map[self.b[p] as usize];
        }
        decls
    }
    pub fn call(&mut self, f: u32) -> &mut Self {
        self.b.push(0x10);
        uleb(&mut self.b, f as u64);
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
        self
    }
    pub fn i64_const(&mut self, v: i64) -> &mut Self {
        self.b.push(0x42);
        sleb(&mut self.b, v);
        self
    }
    pub fn i64_load(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x29, 3, offset)
    }
    pub fn i32_load(&mut self, offset: u32) -> &mut Self {
        self.memarg(0x28, 2, offset)
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
    code: Vec<u8>,
    names: Vec<u8>,
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

    /// Adds a function of type `ty` with `locals` (count, type) runs and
    /// `body` (ending in `end`), exported as `f<k>` for the k-th defined
    /// function and named `fname` in the name section. Returns its index.
    pub fn func(&mut self, ty: u32, locals: &[(u32, u8)], body: &Code, fname: &str) -> u32 {
        let idx = self.nfunc_imports + self.funcs.len() as u32;
        self.funcs.push(ty);
        let mut f = Vec::with_capacity(body.b.len() + 8);
        uleb(&mut f, locals.len() as u64);
        for &(n, t) in locals {
            uleb(&mut f, n as u64);
            f.push(t);
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
        for (k, &t) in self.funcs.iter().enumerate() {
            uleb(&mut funcs, t as u64);
            name(&mut exports, &format!("f{k}"));
            exports.push(0);
            uleb(&mut exports, self.nfunc_imports as u64 + k as u64);
        }
        section(&mut out, 3, self.funcs.len(), &funcs);
        section(&mut out, 7, self.funcs.len(), &exports);
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
    fn compact_locals() {
        // Param 0; locals 3 (i32), 5 and 9 (i64) used.
        let mut c = Code::default();
        c.local_get(0)
            .local_get(9)
            .local_set(3)
            .local_tee(5)
            .local_get(9);
        let decls = c.compact_locals(1, |i| if i == 3 { I32 } else { I64 });
        assert_eq!(decls, [(2, I64), (1, I32)]);
        assert_eq!(c.b, [0x20, 0, 0x20, 2, 0x21, 3, 0x22, 1, 0x20, 2]);
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
}
