//! The native twin of web/9p.ts: a 9P2000.L server over an in-memory tree,
//! answering exactly as that one does (node ids in creation order, readdir
//! offsets and qid versions counted the same way, the same POSIX ACL rules;
//! every timestamp is EPOCH, as there in deterministic mode, unless a Tsetattr
//! gives one).

use std::collections::HashMap;

pub const EPOCH: u64 = 1788220800;
const MSIZE: u32 = 1 << 20;

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

const ENOENT: u32 = 2;
const E2BIG: u32 = 7;
const EBADF: u32 = 9;
const EACCES: u32 = 13;
const EEXIST: u32 = 17;
const ENOTDIR: u32 = 20;
const EISDIR: u32 = 21;
const EINVAL: u32 = 22;
const ENOSPC: u32 = 28;
const ERANGE: u32 = 34;
const ENOTEMPTY: u32 = 39;
const ENODATA: u32 = 61;
const EOPNOTSUPP: u32 = 95;

const XATTR_CREATE: u32 = 1;
const XATTR_REPLACE: u32 = 2;
const XATTR_NAME_MAX: usize = 255;
const XATTR_SIZE_MAX: u64 = 65536;

const ACL_ACCESS: &str = "system.posix_acl_access";
const ACL_DEFAULT: &str = "system.posix_acl_default";
const ACL_USER_OBJ: u16 = 1;
const ACL_USER: u16 = 2;
const ACL_GROUP_OBJ: u16 = 4;
const ACL_GROUP: u16 = 8;
const ACL_MASK: u16 = 0x10;
const ACL_OTHER: u16 = 0x20;

/// A POSIX ACL's entries as (tag, perm), or None if it isn't a valid one (web/9p.ts `aclEntries`).
fn acl_entries(v: &[u8]) -> Option<Vec<(u16, u16)>> {
    if v.len() < 4
        || !(v.len() - 4).is_multiple_of(8)
        || u32::from_le_bytes(v[..4].try_into().unwrap()) != 2
    {
        return None;
    }
    let e: Vec<(u16, u16)> = v[4..]
        .chunks(8)
        .map(|c| {
            (
                u16::from_le_bytes([c[0], c[1]]),
                u16::from_le_bytes([c[2], c[3]]),
            )
        })
        .collect();
    let tags = [
        ACL_USER_OBJ,
        ACL_USER,
        ACL_GROUP_OBJ,
        ACL_GROUP,
        ACL_MASK,
        ACL_OTHER,
    ];
    if e.iter().any(|&(t, p)| !tags.contains(&t) || p > 7) {
        return None;
    }
    let count = |tag| e.iter().filter(|&&(t, _)| t == tag).count();
    if count(ACL_USER_OBJ) != 1
        || count(ACL_GROUP_OBJ) != 1
        || count(ACL_OTHER) != 1
        || count(ACL_MASK) > 1
    {
        return None;
    }
    if count(ACL_USER) + count(ACL_GROUP) > 0 && count(ACL_MASK) == 0 {
        return None;
    }
    Some(e)
}

/// The ACL with each entry's perm set by `perm(tag, old)`.
fn acl_map(v: &[u8], perm: impl Fn(u16, u16) -> u16) -> Vec<u8> {
    let mut out = v.to_vec();
    for c in out[4..].chunks_mut(8) {
        let p = perm(
            u16::from_le_bytes([c[0], c[1]]),
            u16::from_le_bytes([c[2], c[3]]),
        );
        c[2..4].copy_from_slice(&p.to_le_bytes());
    }
    out
}

fn acl_mode(e: &[(u16, u16)]) -> u32 {
    let perm = |tag| {
        e.iter()
            .find(|&&(t, _)| t == tag)
            .map_or(0, |&(_, p)| p as u32)
    };
    let group = if e.iter().any(|&(t, _)| t == ACL_MASK) {
        perm(ACL_MASK)
    } else {
        perm(ACL_GROUP_OBJ)
    };
    perm(ACL_USER_OBJ) << 6 | group << 3 | perm(ACL_OTHER)
}

fn acl_group(v: &[u8]) -> u16 {
    if acl_entries(v).unwrap().iter().any(|&(t, _)| t == ACL_MASK) {
        ACL_MASK
    } else {
        ACL_GROUP_OBJ
    }
}

fn acl_chmod(v: &[u8], mode: u32) -> Vec<u8> {
    let group = acl_group(v);
    let m = |s: u32| (mode >> s & 7) as u16;
    acl_map(v, |tag, old| match tag {
        ACL_USER_OBJ => m(6),
        ACL_OTHER => m(0),
        t if t == group => m(3),
        _ => old,
    })
}

/// A new entry's access ACL and mode from its directory's default ACL (posix_acl_create_masq).
fn acl_create(def: &[u8], mode: u32) -> (Vec<u8>, u32) {
    let group = acl_group(def);
    let m = |s: u32| (mode >> s) as u16;
    let acl = acl_map(def, |tag, old| match tag {
        ACL_USER_OBJ => old & m(6),
        ACL_OTHER => old & m(0),
        t if t == group => old & m(3),
        _ => old,
    });
    let mode = mode & !0o777 | acl_mode(&acl_entries(&acl).unwrap());
    (acl, mode)
}

/// Seconds and nanoseconds.
type Time = (u64, u64);
const NOW: Time = (EPOCH, 0);

/// Nodes live in `Server::nodes`, by id; directories keep their entries in
/// insertion order, each with its readdir offset (`.` 1, `..` 2, then from 3).
struct Node {
    mode: u32,
    uid: u32,
    gid: u32,
    data: Vec<u8>,
    target: String,
    children: Option<Vec<(String, usize, u64)>>,
    /// The last offset a directory gave an entry.
    offset: u64,
    parent: usize,
    nlink: u64,
    version: u32,
    /// Only a Tsetattr with explicit times moves these off EPOCH; anything
    /// that would set them to "now" (EPOCH here) puts them back.
    atime: Time,
    mtime: Time,
    xattrs: Vec<(String, Vec<u8>)>,
}

/// A fid: its node, whether it was opened, and the xattr it reads or writes.
struct Fid {
    node: usize,
    opened: bool,
    xattr: Option<Xattr>,
}

/// A Txattrwalk's value (`set` None), or a Txattrcreate's name, the value as written and the bytes written.
struct Xattr {
    data: Vec<u8>,
    set: Option<String>,
    written: usize,
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
        self.u8(t).u32(n.version).u64(id as u64)
    }
}

pub struct Server {
    nodes: HashMap<usize, Node>,
    next: usize,
    fids: HashMap<u32, Fid>,
}

const ROOT: usize = 1;

impl Fid {
    fn new(node: usize) -> Fid {
        Fid {
            node,
            opened: false,
            xattr: None,
        }
    }
}

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
            s.m(f).data = text.as_bytes().to_vec();
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
            offset: 2,
            parent: parent.unwrap_or(self.next),
            nlink: if dir { 2 } else { 1 },
            version: 0,
            atime: NOW,
            mtime: NOW,
            xattrs: Vec::new(),
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
        c.iter().find(|(n, ..)| n == name).map(|&(_, id, _)| id)
    }

    /// `name` in `dir` is `id` now: a new name takes the next offset, one there already keeps its own.
    fn link(&mut self, dir: usize, name: &str, id: usize) {
        let d = self.m(dir);
        d.mtime = NOW;
        d.version += 1;
        let c = d.children.as_mut().unwrap();
        match c.iter_mut().find(|(n, ..)| n == name) {
            Some(e) => e.1 = id,
            None => {
                d.offset += 1;
                c.push((name.to_owned(), id, d.offset));
            }
        }
    }

    fn unlinked(&mut self, dir: usize, name: &str) {
        let d = self.m(dir);
        d.children.as_mut().unwrap().retain(|(n, ..)| n != name);
        d.version += 1;
    }

    /// The fid's number, checked.
    fn fid_no(&self, r: &mut Reader) -> R<u32> {
        let f = r.u32()?;
        if self.fids.contains_key(&f) {
            Ok(f)
        } else {
            Err(EBADF)
        }
    }

    fn fid(&self, r: &mut Reader) -> R<usize> {
        self.fids.get(&r.u32()?).map(|f| f.node).ok_or(EBADF)
    }

    fn xattr(&self, id: usize, name: &str) -> Option<&Vec<u8>> {
        self.n(id)
            .xattrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    }

    fn put_xattr(&mut self, id: usize, name: &str, value: Option<Vec<u8>>) {
        let x = &mut self.m(id).xattrs;
        match (x.iter_mut().find(|(k, _)| k == name), value) {
            (Some(e), Some(v)) => e.1 = v,
            (None, Some(v)) => x.push((name.to_owned(), v)),
            (_, None) => x.retain(|(k, _)| k != name),
        }
    }

    /// web/9p.ts `MemoryTree.setxattr`.
    fn setxattr(&mut self, id: usize, name: &str, mut value: Option<Vec<u8>>) -> R<()> {
        let acl = name == ACL_ACCESS || name == ACL_DEFAULT;
        match &value {
            Some(v) if acl => {
                let e = acl_entries(v).ok_or(EINVAL)?;
                if name == ACL_DEFAULT && self.n(id).children.is_none() {
                    return Err(EACCES);
                }
                if name == ACL_ACCESS {
                    let n = self.m(id);
                    n.mode = n.mode & !0o777 | acl_mode(&e);
                    if e.len() == 3 {
                        value = None;
                    }
                }
            }
            None if self.xattr(id, name).is_none() => return Err(ENODATA),
            _ => {}
        }
        self.put_xattr(id, name, value);
        Ok(())
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
        if let Some(def) = self.xattr(dir, ACL_DEFAULT).cloned()
            && mode & S_IFMT != S_IFLNK
        {
            let (acl, mode) = acl_create(&def, mode);
            self.m(id).mode = mode;
            if acl_entries(&acl).unwrap().len() != 3 {
                self.put_xattr(id, ACL_ACCESS, Some(acl));
            }
            if self.n(id).children.is_some() {
                self.put_xattr(id, ACL_DEFAULT, Some(def));
            }
        }
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
        self.unlinked(dir, name);
        self.m(dir).mtime = NOW;
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
                self.fids.insert(r.u32()?, Fid::new(ROOT));
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
                    self.fids.insert(newfid, Fid::new(n));
                }
                w.u16(qids.len() as u16);
                for q in qids {
                    w.qid(q, self.n(q));
                }
            }
            12 => {
                let f = self.fid_no(r)?;
                let n = self.fids[&f].node;
                if r.u32()? & 0o1000 != 0 && self.n(n).children.is_none() {
                    self.m(n).data.clear();
                    self.m(n).version += 1;
                }
                self.fids.get_mut(&f).unwrap().opened = true;
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
                let mut fid = Fid::new(f);
                fid.opened = true;
                self.fids.insert(r.u32()?, fid);
                w.qid(f, self.n(f)).u32(0);
            }
            116 => {
                let f = self.fid_no(r)?;
                let off = r.u64()? as usize;
                let count = (r.u32()? as usize).min(room - 11);
                if let Some(x) = &self.fids[&f].xattr {
                    let d: &[u8] = if x.set.is_some() { &[] } else { &x.data };
                    let data = &d[off.min(d.len())..(off + count).min(d.len())];
                    w.u32(data.len() as u32);
                    w.0.extend(data);
                    return Ok(());
                }
                let n = self.fids[&f].node;
                if self.n(n).children.is_some() {
                    return Err(EISDIR);
                }
                self.m(n).atime = NOW;
                let d = &self.n(n).data;
                let data = d.get(off..(off + count).min(d.len())).unwrap_or(&[]);
                w.u32(data.len() as u32);
                w.0.extend(data);
            }
            118 => {
                let f = self.fid_no(r)?;
                let off = r.u64()? as usize;
                let len = r.u32()? as usize;
                let data = r.take(len)?.to_vec();
                if let Some(x) = &mut self.fids.get_mut(&f).unwrap().xattr {
                    if x.set.is_none() {
                        return Err(EBADF);
                    }
                    if off > x.data.len() {
                        return Err(ENOSPC);
                    }
                    let len = len.min(x.data.len() - off);
                    x.data[off..off + len].copy_from_slice(&data[..len]);
                    x.written += len;
                    w.u32(len as u32);
                    return Ok(());
                }
                let n = self.fids[&f].node;
                if self.n(n).children.is_some() {
                    return Err(EISDIR);
                }
                let node = self.m(n);
                node.mtime = NOW;
                if off + len > node.data.len() {
                    node.data.resize(off + len, 0);
                    node.version += 1;
                }
                node.data[off..off + len].copy_from_slice(&data);
                node.version += 1;
                w.u32(len as u32);
            }
            40 => {
                let d = self.dir(r)?;
                let off = r.u64()? as usize;
                let count = (r.u32()? as usize).min(room - 11);
                let mut all = vec![
                    (".".to_owned(), d, 1),
                    ("..".to_owned(), self.n(d).parent, 2),
                ];
                all.extend(self.n(d).children.clone().unwrap());
                let mut e = Writer::default();
                for (name, id, next) in all.iter().filter(|e| e.2 > off as u64) {
                    let n = self.n(*id);
                    let t = match n.kind() {
                        S_IFDIR => 4,
                        S_IFLNK => 10,
                        S_IFREG => 8,
                        _ => 0,
                    };
                    let before = e.0.len();
                    e.qid(*id, n).u64(*next).u8(t).str(name);
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
                for (s, ns) in [n.atime, n.mtime, NOW, (0, 0)] {
                    w.u64(s).u64(ns);
                }
                w.u64(0).u64(0);
            }
            26 => {
                let id = self.fid(r)?;
                let (valid, mode, uid, gid, size) =
                    (r.u32()?, r.u32()?, r.u32()?, r.u32()?, r.u64()?);
                let (atime, mtime) = ((r.u64()?, r.u64()?), (r.u64()?, r.u64()?));
                if valid & 1 != 0 {
                    let n = self.m(id);
                    n.mode = n.mode & S_IFMT | mode & 0o7777;
                    let mode = n.mode;
                    if let Some(acl) = self.xattr(id, ACL_ACCESS) {
                        let acl = acl_chmod(acl, mode);
                        self.put_xattr(id, ACL_ACCESS, Some(acl));
                    }
                }
                let n = self.m(id);
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
                    n.version += 1;
                    n.mtime = NOW;
                }
                if valid & 16 != 0 {
                    n.atime = if valid & 128 != 0 { atime } else { NOW };
                }
                if valid & 32 != 0 {
                    n.mtime = if valid & 256 != 0 { mtime } else { NOW };
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
                self.unlinked(od, &oname);
                self.link(nd, &nname, n);
                self.m(od).mtime = NOW;
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
                let f = self.fids.remove(&r.u32()?).ok_or(EBADF)?;
                if let Some(Xattr {
                    data,
                    set: Some(name),
                    written,
                }) = f.xattr
                {
                    if written != data.len() {
                        return Err(EINVAL);
                    }
                    let value = (!data.is_empty()).then_some(data);
                    self.setxattr(f.node, &name, value)?;
                }
            }
            30 => {
                let n = self.fid(r)?;
                let newfid = r.u32()?;
                let name = r.str()?;
                let data = if name.is_empty() {
                    let mut l = Vec::new();
                    for (k, _) in &self.n(n).xattrs {
                        l.extend(k.as_bytes());
                        l.push(0);
                    }
                    l
                } else {
                    self.xattr(n, &name).cloned().ok_or(ENODATA)?
                };
                if data.len() as u64 > XATTR_SIZE_MAX {
                    return Err(E2BIG);
                }
                w.u64(data.len() as u64);
                let mut fid = Fid::new(n);
                fid.xattr = Some(Xattr {
                    data,
                    set: None,
                    written: 0,
                });
                self.fids.insert(newfid, fid);
            }
            32 => {
                let f = self.fid_no(r)?;
                let (name, size, flags) = (r.str()?, r.u64()?, r.u32()?);
                if name.is_empty() || flags & !(XATTR_CREATE | XATTR_REPLACE) != 0 {
                    return Err(EINVAL);
                }
                if name.len() > XATTR_NAME_MAX {
                    return Err(ERANGE);
                }
                if size > XATTR_SIZE_MAX {
                    return Err(E2BIG);
                }
                let fid = &self.fids[&f];
                if fid.opened || fid.xattr.is_some() {
                    return Err(EINVAL);
                }
                let had = self.xattr(fid.node, &name).is_some();
                if flags & XATTR_CREATE != 0 && had {
                    return Err(EEXIST);
                }
                if flags & XATTR_REPLACE != 0 && !had {
                    return Err(ENODATA);
                }
                self.fids.get_mut(&f).unwrap().xattr = Some(Xattr {
                    data: vec![0; size as usize],
                    set: Some(name),
                    written: 0,
                });
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
