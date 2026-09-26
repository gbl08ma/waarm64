//! The native twin of web/9p.ts: a 9P2000.L server over an in-memory tree,
//! answering exactly as that one does (node ids in creation order; every
//! timestamp is EPOCH, as there in deterministic mode).

use std::collections::HashMap;

pub const EPOCH: u64 = 1788220800;
const MSIZE: u32 = 1 << 20;

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

const ENOENT: u32 = 2;
const EBADF: u32 = 9;
const EEXIST: u32 = 17;
const ENOTDIR: u32 = 20;
const EISDIR: u32 = 21;
const EINVAL: u32 = 22;
const ENOTEMPTY: u32 = 39;
const EOPNOTSUPP: u32 = 95;

/// Nodes live in `Server::nodes`, by id; directories keep their entries in insertion order.
struct Node {
    mode: u32,
    uid: u32,
    gid: u32,
    data: Vec<u8>,
    target: String,
    children: Option<Vec<(String, usize)>>,
    parent: usize,
    nlink: u64,
    /// Only a Tsetattr with explicit times moves these off EPOCH; anything
    /// that would set them to "now" (EPOCH here) puts them back.
    atime: u64,
    mtime: u64,
}

impl Node {
    fn kind(&self) -> u32 {
        self.mode & S_IFMT
    }
}

struct Reader<'a> {
    b: &'a [u8],
    k: usize,
}

type R<T> = Result<T, u32>;

impl Reader<'_> {
    fn take(&mut self, n: usize) -> R<&[u8]> {
        let s = self.b.get(self.k..self.k + n).ok_or(EINVAL)?;
        self.k += n;
        Ok(s)
    }
    fn u8(&mut self) -> R<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> R<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> R<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> R<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn str(&mut self) -> R<String> {
        let n = self.u16()? as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
}

#[derive(Default)]
struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend(v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend(v.to_le_bytes());
        self
    }
    fn u64(&mut self, v: u64) -> &mut Self {
        self.0.extend(v.to_le_bytes());
        self
    }
    fn str(&mut self, s: &str) -> &mut Self {
        self.u16(s.len() as u16);
        self.0.extend(s.as_bytes());
        self
    }
    fn qid(&mut self, id: usize, n: &Node) -> &mut Self {
        let t = match n.kind() {
            S_IFDIR => 0x80,
            S_IFLNK => 0x02,
            _ => 0,
        };
        self.u8(t).u32(0).u64(id as u64)
    }
}

pub struct Server {
    nodes: HashMap<usize, Node>,
    next: usize,
    fids: HashMap<u32, usize>,
}

const ROOT: usize = 1;

impl Server {
    /// A tree holding `files` (path, contents), directories made as needed.
    pub fn new(files: &[(&str, &str)]) -> Server {
        let mut s = Server {
            nodes: HashMap::new(),
            next: 0,
            fids: HashMap::new(),
        };
        s.node(S_IFDIR | 0o755, None, 0);
        for (path, text) in files {
            let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
            let mut dir = ROOT;
            for p in &parts[..parts.len() - 1] {
                dir = match s.lookup(dir, p) {
                    Some(d) => d,
                    None => {
                        let d = s.node(S_IFDIR | 0o755, Some(dir), 0);
                        s.link(dir, p, d);
                        d
                    }
                };
            }
            let f = s.node(S_IFREG | 0o644, Some(dir), 0);
            s.link(dir, parts[parts.len() - 1], f);
            s.nodes.get_mut(&f).unwrap().data = text.as_bytes().to_vec();
        }
        s
    }

    fn node(&mut self, mode: u32, parent: Option<usize>, gid: u32) -> usize {
        self.next += 1;
        let dir = mode & S_IFMT == S_IFDIR;
        let n = Node {
            mode,
            uid: 0,
            gid,
            data: Vec::new(),
            target: String::new(),
            children: dir.then(Vec::new),
            parent: parent.unwrap_or(self.next),
            nlink: if dir { 2 } else { 1 },
            atime: EPOCH,
            mtime: EPOCH,
        };
        self.nodes.insert(self.next, n);
        self.next
    }

    fn n(&self, id: usize) -> &Node {
        &self.nodes[&id]
    }

    fn m(&mut self, id: usize) -> &mut Node {
        self.nodes.get_mut(&id).unwrap()
    }

    fn lookup(&self, dir: usize, name: &str) -> Option<usize> {
        let c = self.n(dir).children.as_ref()?;
        c.iter().find(|(n, _)| n == name).map(|&(_, id)| id)
    }

    fn link(&mut self, dir: usize, name: &str, id: usize) {
        self.m(dir).mtime = EPOCH;
        let c = self.m(dir).children.as_mut().unwrap();
        match c.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = id,
            None => c.push((name.to_owned(), id)),
        }
    }

    fn fid(&self, r: &mut Reader) -> R<usize> {
        self.fids.get(&r.u32()?).copied().ok_or(EBADF)
    }

    fn dir(&self, r: &mut Reader) -> R<usize> {
        let d = self.fid(r)?;
        if self.n(d).children.is_none() {
            return Err(ENOTDIR);
        }
        Ok(d)
    }

    fn create(&mut self, dir: usize, name: &str, mode: u32, gid: u32) -> R<usize> {
        if self.lookup(dir, name).is_some() {
            return Err(EEXIST);
        }
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(EINVAL);
        }
        let id = self.node(mode, Some(dir), gid);
        self.link(dir, name, id);
        Ok(id)
    }

    fn unlink(&mut self, dir: usize, name: &str, rmdir: bool) -> R<()> {
        let id = self.lookup(dir, name).ok_or(ENOENT)?;
        let n = self.n(id);
        match &n.children {
            Some(_) if !rmdir => return Err(EISDIR),
            None if rmdir => return Err(ENOTDIR),
            Some(c) if !c.is_empty() => return Err(ENOTEMPTY),
            _ => {}
        }
        self.m(dir)
            .children
            .as_mut()
            .unwrap()
            .retain(|(n, _)| n != name);
        self.m(dir).mtime = EPOCH;
        let n = self.m(id);
        n.nlink = if n.children.is_some() { 0 } else { n.nlink - 1 };
        Ok(())
    }

    /// Answers the T-message `m` into at most `room` bytes.
    pub fn handle(&mut self, m: &[u8], room: usize) -> Vec<u8> {
        let mut w = Writer(vec![0; 7]);
        let ty = match self.op(m[4], &mut Reader { b: m, k: 7 }, &mut w, room) {
            Ok(()) => m[4] + 1,
            Err(e) => {
                w = Writer(vec![0; 7]);
                w.u32(e);
                7
            }
        };
        let len = w.0.len() as u32;
        w.0[..4].copy_from_slice(&len.to_le_bytes());
        w.0[4] = ty;
        w.0[5..7].copy_from_slice(&m[5..7]);
        w.0
    }

    fn op(&mut self, ty: u8, r: &mut Reader, w: &mut Writer, room: usize) -> R<()> {
        match ty {
            100 => {
                let msize = r.u32()?;
                self.fids.clear();
                let v = if r.str()? == "9P2000.L" {
                    "9P2000.L"
                } else {
                    "unknown"
                };
                w.u32(msize.min(MSIZE)).str(v);
            }
            104 => {
                self.fids.insert(r.u32()?, ROOT);
                w.qid(ROOT, self.n(ROOT));
            }
            110 => {
                let mut n = self.fid(r)?;
                let newfid = r.u32()?;
                let names: Vec<_> = (0..r.u16()?).map(|_| r.str()).collect::<R<_>>()?;
                let mut qids = Vec::new();
                for name in &names {
                    let next = match (&self.n(n).children, name.as_str()) {
                        (None, _) => None,
                        (_, "..") => Some(self.n(n).parent),
                        (_, ".") => Some(n),
                        _ => self.lookup(n, name),
                    };
                    let Some(next) = next else { break };
                    n = next;
                    qids.push(n);
                }
                if qids.is_empty() && !names.is_empty() {
                    return Err(ENOENT);
                }
                if qids.len() == names.len() {
                    self.fids.insert(newfid, n);
                }
                w.u16(qids.len() as u16);
                for q in qids {
                    w.qid(q, self.n(q));
                }
            }
            12 => {
                let n = self.fid(r)?;
                if r.u32()? & 0o1000 != 0 && self.n(n).children.is_none() {
                    self.m(n).data.clear();
                }
                w.qid(n, self.n(n)).u32(0);
            }
            14 => {
                let k = r.k;
                let d = self.dir(r)?;
                let name = r.str()?;
                r.u32()?;
                let mode = r.u32()?;
                let f = self.create(d, &name, S_IFREG | (mode & 0o7777), r.u32()?)?;
                r.k = k;
                self.fids.insert(r.u32()?, f);
                w.qid(f, self.n(f)).u32(0);
            }
            116 => {
                let n = self.fid(r)?;
                if self.n(n).children.is_some() {
                    return Err(EISDIR);
                }
                let off = r.u64()? as usize;
                let count = (r.u32()? as usize).min(room - 11);
                self.m(n).atime = EPOCH;
                let d = &self.n(n).data;
                let data = d.get(off..(off + count).min(d.len())).unwrap_or(&[]);
                w.u32(data.len() as u32);
                w.0.extend(data);
            }
            118 => {
                let n = self.fid(r)?;
                if self.n(n).children.is_some() {
                    return Err(EISDIR);
                }
                let off = r.u64()? as usize;
                let len = r.u32()? as usize;
                let data = r.take(len)?.to_vec();
                self.m(n).mtime = EPOCH;
                let d = &mut self.m(n).data;
                if off + len > d.len() {
                    d.resize(off + len, 0);
                }
                d[off..off + len].copy_from_slice(&data);
                w.u32(len as u32);
            }
            40 => {
                let d = self.dir(r)?;
                let off = r.u64()? as usize;
                let count = (r.u32()? as usize).min(room - 11);
                let mut all = vec![(".".to_owned(), d), ("..".to_owned(), self.n(d).parent)];
                all.extend(self.n(d).children.clone().unwrap());
                let mut e = Writer::default();
                for (k, (name, id)) in all.iter().enumerate().skip(off) {
                    let n = self.n(*id);
                    let t = match n.kind() {
                        S_IFDIR => 4,
                        S_IFLNK => 10,
                        S_IFREG => 8,
                        _ => 0,
                    };
                    let before = e.0.len();
                    e.qid(*id, n).u64(k as u64 + 1).u8(t).str(name);
                    if e.0.len() > count {
                        e.0.truncate(before);
                        break;
                    }
                }
                w.u32(e.0.len() as u32);
                w.0.extend(e.0);
            }
            24 => {
                let id = self.fid(r)?;
                let n = self.n(id);
                let size = if n.kind() == S_IFLNK {
                    n.target.len()
                } else {
                    n.data.len()
                } as u64;
                w.u64(0x7ff)
                    .qid(id, n)
                    .u32(n.mode)
                    .u32(n.uid)
                    .u32(n.gid)
                    .u64(n.nlink);
                w.u64(0).u64(size).u64(4096).u64(size.div_ceil(512));
                for t in [n.atime, n.mtime, EPOCH, 0] {
                    w.u64(t).u64(0);
                }
                w.u64(0).u64(0);
            }
            26 => {
                let id = self.fid(r)?;
                let (valid, mode, uid, gid, size) =
                    (r.u32()?, r.u32()?, r.u32()?, r.u32()?, r.u64()?);
                let (atime, _, mtime) = (r.u64()?, r.u64()?, r.u64()?);
                let n = self.m(id);
                if valid & 1 != 0 {
                    n.mode = n.mode & S_IFMT | mode & 0o7777;
                }
                if valid & 2 != 0 {
                    n.uid = uid;
                }
                if valid & 4 != 0 {
                    n.gid = gid;
                }
                if valid & 8 != 0 {
                    if n.children.is_some() {
                        return Err(EISDIR);
                    }
                    n.data.resize(size as usize, 0);
                    n.mtime = EPOCH;
                }
                if valid & 16 != 0 {
                    n.atime = if valid & 128 != 0 { atime } else { EPOCH };
                }
                if valid & 32 != 0 {
                    n.mtime = if valid & 256 != 0 { mtime } else { EPOCH };
                }
            }
            72 => {
                let d = self.dir(r)?;
                let name = r.str()?;
                let mode = r.u32()?;
                let n = self.create(d, &name, S_IFDIR | (mode & 0o7777), r.u32()?)?;
                self.m(d).nlink += 1;
                w.qid(n, self.n(n));
            }
            16 => {
                let d = self.dir(r)?;
                let (name, target) = (r.str()?, r.str()?);
                let n = self.create(d, &name, S_IFLNK | 0o777, r.u32()?)?;
                self.m(n).target = target;
                w.qid(n, self.n(n));
            }
            18 => {
                let d = self.dir(r)?;
                let name = r.str()?;
                let mode = r.u32()?;
                r.u32()?;
                r.u32()?;
                if matches!(mode & S_IFMT, S_IFDIR | S_IFLNK) {
                    return Err(EINVAL);
                }
                let n = self.create(d, &name, mode, r.u32()?)?;
                w.qid(n, self.n(n));
            }
            22 => {
                let n = self.fid(r)?;
                if self.n(n).kind() != S_IFLNK {
                    return Err(EINVAL);
                }
                let t = self.n(n).target.clone();
                w.str(&t);
            }
            70 => {
                let d = self.dir(r)?;
                let n = self.fid(r)?;
                if self.n(n).children.is_some() {
                    return Err(EISDIR);
                }
                let name = r.str()?;
                if self.lookup(d, &name).is_some() {
                    return Err(EEXIST);
                }
                self.link(d, &name, n);
                self.m(n).nlink += 1;
            }
            74 => {
                let od = self.dir(r)?;
                let oname = r.str()?;
                let nd = self.dir(r)?;
                let nname = r.str()?;
                let n = self.lookup(od, &oname).ok_or(ENOENT)?;
                let old = self.lookup(nd, &nname);
                if old == Some(n) {
                    return Ok(());
                }
                if let Some(o) = old {
                    let rmdir = self.n(o).children.is_some();
                    self.unlink(nd, &nname, rmdir)?;
                }
                self.m(od)
                    .children
                    .as_mut()
                    .unwrap()
                    .retain(|(k, _)| *k != oname);
                self.link(nd, &nname, n);
                self.m(od).mtime = EPOCH;
                if self.n(n).children.is_some() {
                    self.m(od).nlink -= 1;
                    self.m(nd).nlink += 1;
                    self.m(n).parent = nd;
                }
            }
            76 => {
                let d = self.dir(r)?;
                let name = r.str()?;
                let rmdir = r.u32()? & 0x200 != 0;
                self.unlink(d, &name, rmdir)?;
                if rmdir {
                    self.m(d).nlink -= 1;
                }
            }
            120 => {
                self.fids.remove(&r.u32()?).ok_or(EBADF)?;
            }
            122 => {
                let k = r.k;
                let n = self.fid(r)?;
                r.k = k;
                self.fids.remove(&r.u32()?);
                let p = self.n(n).parent;
                let name = self
                    .n(p)
                    .children
                    .as_ref()
                    .unwrap()
                    .iter()
                    .find(|e| e.1 == n);
                let name = name
                    .map(|e| e.0.clone())
                    .filter(|_| n != ROOT)
                    .ok_or(ENOENT)?;
                let dir = self.n(n).children.is_some();
                self.unlink(p, &name, dir)?;
                if dir {
                    self.m(p).nlink -= 1;
                }
            }
            108 | 50 => {}
            8 => {
                self.fid(r)?;
                w.u32(0x01021997)
                    .u32(4096)
                    .u64(1 << 18)
                    .u64(1 << 18)
                    .u64(1 << 18);
                w.u64(1 << 16).u64(1 << 16).u64(0).u32(255);
            }
            52 => {
                w.u8(0);
            }
            54 => {
                self.fid(r)?;
                r.u8()?;
                let (start, len, pid, client) = (r.u64()?, r.u64()?, r.u32()?, r.str()?);
                w.u8(2).u64(start).u64(len).u32(pid).str(&client);
            }
            _ => return Err(EOPNOTSUPP),
        }
        Ok(())
    }
}
