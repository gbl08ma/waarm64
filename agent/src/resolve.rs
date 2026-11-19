//! The room's names on a guest whose cards are configured by udhcpc (docs/devices.md "Names through the agent"): a
//! DNS forwarder of the agent's, a process of its own (forked by the root once it brought a room's card up,
//! src/card.rs), for a guest without per-link DNS. musl, Alpine's C library, asks every server in `/etc/resolv.conf`
//! at once and takes the first answer, an NXDOMAIN too, so the room's resolver beside another network's would race it;
//! and busybox's udhcpc rewrites the file at every lease. So the forwarder listens on `LISTEN` (UDP and TCP) and keeps
//! `/etc/resolv.conf` naming it alone: whenever udhcpc rewrites the file, its servers become the forwarder's
//! upstreams (kept in the file's comments, so a forwarder started again finds them) and the file is written again as
//! the forwarder's. A name under a room's domains (the search list udhcpc6 got on the room's card, which its script
//! writes to `ROOM_DIR/<card>`) goes to that room's resolvers; anything else to the upstreams, all at once, the first
//! answer that isn't SERVFAIL or REFUSED relayed (as musl itself would). The file is the forwarder's only while a
//! room has given its resolvers; when they go (the lease lost), and when the agent ends (the pipe from the root
//! closes: a crash, a stop), the file is written back with the upstreams alone. Queries over TCP (musl's after a
//! truncated answer) are answered by a child each, from the first upstream that takes a connection.

use crate::prelude::*;
use core::net::{IpAddr, Ipv4Addr, SocketAddr};
use core::str::FromStr;
use rustix::event::{PollFd, PollFlags, poll};
use rustix::fd::{AsFd, AsRawFd, OwnedFd};
use rustix::fs::inotify::{self, CreateFlags, WatchFlags};
use rustix::io::Errno;
use rustix::net::{AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType};
use rustix::process::{Pid, WaitOptions};

/// Where the forwarder listens: an address of loopback's own (all of 127/8 is), out of the way of a resolver the
/// user runs on 127.0.0.1.
pub const LISTEN: Ipv4Addr = Ipv4Addr::new(127, 0, 53, 53);
/// The first line of a `/etc/resolv.conf` the forwarder wrote.
pub const MARKER: &str =
    "# waarm64-agent: the room's names (docs/devices.md, \"Names through the agent\")";
/// Comment lines that keep an upstream server and the upstream's search domains.
const UPSTREAM: &str = "# upstream nameserver ";
const UPSTREAM_SEARCH: &str = "# upstream search ";
/// How long a query waits for an answer.
const QUERY_MS: u64 = 5_000;
/// Queries in flight at most (more are dropped: the client asks again).
const MAX_PENDING: usize = 64;
/// TCP connections answered at once at most (a child each; past them a connection is closed).
const MAX_TCP: usize = 8;

#[derive(Clone)]
pub struct Paths {
    pub resolv: String,
    /// The directory `resolv` is in (watched: udhcpc renames its new file into it).
    pub etc: String,
    /// Each room card's resolvers and domains, a file per card (`dns <addr>…` and `search <domain>…` lines).
    pub rooms: String,
    pub listen: SocketAddr,
    /// The port servers are asked on (53; the tests' servers are elsewhere).
    pub port: u16,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            resolv: "/etc/resolv.conf".into(),
            etc: "/etc".into(),
            rooms: ROOM_DIR.into(),
            listen: SocketAddr::new(IpAddr::V4(LISTEN), 53),
            port: 53,
        }
    }
}

/// Where udhcpc6's script (src/card.rs `SCRIPT`) writes each room card's resolvers and domains.
pub const ROOM_DIR: &str = "/run/waarm64-dns";

/// A `resolv.conf` read: its servers, search domains and other lines (`options`, kept as they are); `ours`: the
/// forwarder wrote it (its servers then are the upstreams its comments keep).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Resolv {
    pub servers: Vec<IpAddr>,
    pub search: Vec<String>,
    pub rest: Vec<String>,
    pub ours: bool,
}

pub fn parse_resolv(text: &str) -> Resolv {
    let mut r = Resolv {
        ours: text.lines().next() == Some(MARKER),
        ..Resolv::default()
    };
    for line in text.lines() {
        if let Some(a) = line.strip_prefix(UPSTREAM) {
            if r.ours
                && let Ok(ip) = IpAddr::from_str(a.trim())
            {
                r.servers.push(ip);
            }
            continue;
        }
        if let Some(a) = line.strip_prefix(UPSTREAM_SEARCH) {
            if r.ours {
                r.search.extend(a.split_whitespace().map(String::from));
            }
            continue;
        }
        let l = line.split('#').next().unwrap_or("").trim();
        let mut w = l.split_whitespace();
        match w.next() {
            Some("nameserver") if !r.ours => {
                if let Some(ip) = w.next().and_then(|a| IpAddr::from_str(a).ok()) {
                    r.servers.push(ip);
                }
            }
            Some("nameserver") => {}
            Some("search") | Some("domain") if r.ours => {} // the rooms' and the upstream's: the comment has the upstream's
            Some("search") | Some("domain") => {
                for d in w {
                    let d = d.trim_end_matches('.').to_ascii_lowercase();
                    if !r.search.contains(&d) {
                        r.search.push(d);
                    }
                }
            }
            Some(_) => r.rest.push(l.to_owned()),
            None => {}
        }
    }
    r
}

/// The forwarder's `resolv.conf`: the marker, the upstreams kept, the upstream's domains then the rooms', the
/// forwarder alone as the server, the other lines.
pub fn ours(up: &Resolv, rooms: &[Room], listen: IpAddr) -> String {
    let mut out = format!("{MARKER}\n");
    for s in &up.servers {
        out.push_str(&format!("{UPSTREAM}{s}\n"));
    }
    if !up.search.is_empty() {
        out.push_str(&format!("{UPSTREAM_SEARCH}{}\n", up.search.join(" ")));
    }
    let mut search: Vec<String> = Vec::new();
    // The upstream's domains first: musl stops at the first search domain whose query fails (a SERVFAIL, a timeout),
    // so a room that doesn't answer (its adapter disconnected) would otherwise fail every dotless name.
    for d in up
        .search
        .iter()
        .chain(rooms.iter().flat_map(|r| r.domains.iter()))
    {
        if !search.contains(d) {
            search.push(d.clone());
        }
    }
    if !search.is_empty() {
        out.push_str(&format!("search {}\n", search.join(" ")));
    }
    out.push_str(&format!("nameserver {listen}\n"));
    for l in &up.rest {
        out.push_str(l);
        out.push('\n');
    }
    out
}

/// The `resolv.conf` written back: the upstreams alone, as udhcpc wrote them.
pub fn plain(up: &Resolv) -> String {
    let mut out = String::new();
    if !up.search.is_empty() {
        out.push_str(&format!("search {}\n", up.search.join(" ")));
    }
    for s in &up.servers {
        out.push_str(&format!("nameserver {s}\n"));
    }
    for l in &up.rest {
        out.push_str(l);
        out.push('\n');
    }
    out
}

/// A room card's resolvers and domains (`ROOM_DIR/<card>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Room {
    pub servers: Vec<IpAddr>,
    pub domains: Vec<String>,
}

pub fn parse_room(text: &str) -> Room {
    let mut r = Room {
        servers: Vec::new(),
        domains: Vec::new(),
    };
    for line in text.lines() {
        let mut w = line.split_whitespace();
        match w.next() {
            Some("dns") => r.servers.extend(w.filter_map(|a| IpAddr::from_str(a).ok())),
            Some("search") => r.domains.extend(
                w.map(|d| d.trim_end_matches('.').to_ascii_lowercase())
                    .filter(|d| !d.is_empty()),
            ),
            _ => {}
        }
    }
    r
}

/// The rooms that have given resolvers (each card's file in `dir`, sorted by card).
pub fn rooms(dir: &str) -> Vec<Room> {
    let Ok(mut names) = crate::rt::dir_names(dir) else {
        return Vec::new();
    };
    crate::rt::sort(&mut names);
    names
        .iter()
        .filter(|n| !n.ends_with(".new"))
        .filter_map(|n| crate::rt::read_text(format!("{dir}/{n}")).ok())
        .map(|t| parse_room(&t))
        .filter(|r| !r.servers.is_empty())
        .collect()
}

/// A query's name (its first question's), lowercase, dotted, without the root's dot; None if it doesn't read.
pub fn qname(q: &[u8]) -> Option<String> {
    if q.len() < 12 || u16::from_be_bytes([q[4], q[5]]) == 0 {
        return None;
    }
    let mut at = 12;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let n = *q.get(at)? as usize;
        if n == 0 {
            break;
        }
        if n > 63 {
            return None; // a pointer or an extended label: not in a question's first name
        }
        let l = q.get(at + 1..at + 1 + n)?;
        labels.push(String::from_utf8_lossy(l).to_ascii_lowercase());
        at += 1 + n;
    }
    Some(labels.join("."))
}

/// The servers a name goes to: the first room whose domains it's under (or is), else the upstreams.
pub fn route<'a>(name: &str, rooms: &'a [Room], up: &'a [IpAddr]) -> &'a [IpAddr] {
    rooms
        .iter()
        .find(|r| {
            r.domains
                .iter()
                .any(|d| name == d || name.ends_with(&format!(".{d}")))
        })
        .map(|r| r.servers.as_slice())
        .unwrap_or(up)
}

/// An answer's RCODE (the low 4 bits of byte 3).
fn rcode(a: &[u8]) -> u8 {
    a.get(3).map_or(2, |b| b & 0x0f)
}

/// A SERVFAIL for query `q`: its header with QR, RA and RCODE 2, its question kept.
fn servfail(q: &[u8]) -> Vec<u8> {
    let mut a = q.to_vec();
    if a.len() >= 12 {
        a[2] |= 0x80;
        a[3] = (a[3] & 0x70) | 0x80 | 2;
        a[6..12].fill(0);
    }
    a
}

/// One query in flight: who asked, a socket per server it went to, when it gives up, the last failure heard.
struct Pending {
    client: SocketAddr,
    socks: Vec<OwnedFd>,
    until: u64,
    query: Vec<u8>,
    failed: Option<Vec<u8>>,
}

fn now_ms() -> u64 {
    let t = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    t.tv_sec as u64 * 1000 + t.tv_nsec as u64 / 1_000_000
}

fn udp_to(server: SocketAddr) -> Result<OwnedFd, Errno> {
    let family = if server.is_ipv4() {
        AddressFamily::INET
    } else {
        AddressFamily::INET6
    };
    let fd = rustix::net::socket_with(
        family,
        SocketType::DGRAM,
        SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
        None,
    )?;
    rustix::net::connect(&fd, &server)?;
    Ok(fd)
}

/// Writes `text` to `path` whole (a file beside it, renamed over it).
fn write_file(path: &str, text: &str) -> Result<(), Errno> {
    use rustix::fs::{Mode, OFlags};
    let tmp = format!("{path}.waarm64");
    let fd = rustix::fs::open(
        tmp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o644),
    )?;
    let mut rest = text.as_bytes();
    while !rest.is_empty() {
        let n = rustix::io::write(&fd, rest)?;
        rest = &rest[n..];
    }
    drop(fd);
    rustix::fs::rename(tmp.as_str(), path)
}

/// The forwarder's state: the upstreams, the rooms, what it last wrote.
pub struct Forwarder {
    p: Paths,
    up: Resolv,
    rooms: Vec<Room>,
    /// The file is the forwarder's now.
    holding: bool,
}

impl Forwarder {
    pub fn new(p: Paths) -> Forwarder {
        Forwarder {
            p,
            up: Resolv::default(),
            rooms: Vec::new(),
            holding: false,
        }
    }

    /// `/etc/resolv.conf` and the rooms read again, and the file written as the forwarder's (while a room has
    /// resolvers) or back as the upstreams' (when none has).
    pub fn sync(&mut self) {
        let text = crate::rt::read_text(&self.p.resolv).unwrap_or_default();
        let r = parse_resolv(&text);
        if !r.ours || self.up == Resolv::default() {
            // udhcpc's (or the forwarder's from before a restart: its kept upstreams).
            self.up = Resolv { ours: false, ..r };
        }
        self.rooms = rooms(&self.p.rooms);
        let want = if self.rooms.is_empty() {
            plain(&self.up)
        } else {
            ours(&self.up, &self.rooms, self.p.listen.ip())
        };
        let was_ours = text.lines().next() == Some(MARKER);
        if self.rooms.is_empty() && !was_ours {
            self.holding = false;
            return; // not ours, and nothing to take it for
        }
        if text != want {
            match write_file(&self.p.resolv, &want) {
                Ok(()) => crate::log(
                    if self.rooms.is_empty() {
                        "resolve: resolv.conf given back"
                    } else {
                        "resolve: resolv.conf names the agent's forwarder"
                    },
                    None,
                ),
                Err(e) => crate::log("resolve: resolv.conf", Some(e)),
            }
        }
        self.holding = !self.rooms.is_empty();
    }

    /// The file written back with the upstreams alone, if it's the forwarder's (the agent ended).
    pub fn give_back(&mut self) {
        let text = crate::rt::read_text(&self.p.resolv).unwrap_or_default();
        if text.lines().next() == Some(MARKER) {
            let _ = write_file(&self.p.resolv, &plain(&self.up));
        }
        self.holding = false;
    }

    /// The servers for query `q`.
    fn servers(&self, q: &[u8]) -> Vec<SocketAddr> {
        let name = qname(q).unwrap_or_default();
        route(&name, &self.rooms, &self.up.servers)
            .iter()
            .map(|ip| SocketAddr::new(*ip, self.p.port))
            .collect()
    }
}

/// The forwarder's loop, until `parent` (the root's pipe) closes: then the file given back.
pub fn serve(p: Paths, parent: OwnedFd) -> i32 {
    let mut f = Forwarder::new(p.clone());
    let Ok(ino) = inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK) else {
        return 1;
    };
    let watch = WatchFlags::CLOSE_WRITE
        | WatchFlags::MOVED_TO
        | WatchFlags::CREATE
        | WatchFlags::DELETE
        | WatchFlags::MOVED_FROM;
    let _ = rustix::fs::mkdir(p.rooms.as_str(), rustix::fs::Mode::from_raw_mode(0o755));
    let _ = inotify::add_watch(&ino, p.etc.as_str(), watch);
    let _ = inotify::add_watch(&ino, p.rooms.as_str(), watch);
    let family = if p.listen.is_ipv4() {
        AddressFamily::INET
    } else {
        AddressFamily::INET6
    };
    let bound = |t: SocketType| -> Result<OwnedFd, Errno> {
        let fd = rustix::net::socket_with(
            family,
            t,
            SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
            None,
        )?;
        rustix::net::sockopt::set_socket_reuseaddr(&fd, true)?;
        rustix::net::bind(&fd, &p.listen)?;
        Ok(fd)
    };
    let (udp, tcp) = match (bound(SocketType::DGRAM), bound(SocketType::STREAM)) {
        (Ok(u), Ok(t)) if rustix::net::listen(&t, 16).is_ok() => (u, t),
        (Err(e), _) | (_, Err(e)) => {
            crate::log("resolve: listen", Some(e));
            return 1;
        }
        _ => return 1,
    };
    f.sync();
    crate::log("resolve: forwarding", None);
    let mut pending: Vec<Pending> = Vec::new();
    let mut tcp_children: Vec<Pid> = Vec::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let mut fds = vec![
            PollFd::new(&parent, PollFlags::IN),
            PollFd::new(&ino, PollFlags::IN),
            PollFd::new(&udp, PollFlags::IN),
            PollFd::new(&tcp, PollFlags::IN),
        ];
        let mut owners = Vec::new();
        for (i, q) in pending.iter().enumerate() {
            for (k, s) in q.socks.iter().enumerate() {
                fds.push(PollFd::new(s, PollFlags::IN));
                owners.push((i, k));
            }
        }
        let timeout = rustix::time::Timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        match poll(&mut fds, Some(&timeout)) {
            Ok(_) | Err(Errno::INTR) => {}
            Err(e) => {
                crate::log("resolve: poll", Some(e));
                f.give_back();
                return 1;
            }
        }
        let ready: Vec<bool> = fds.iter().map(|x| !x.revents().is_empty()).collect();
        drop(fds);
        if ready[0] {
            // The root ended (or closed its end): the file back, and gone.
            f.give_back();
            return 0;
        }
        if ready[1] {
            let mut ev = [core::mem::MaybeUninit::<u8>::uninit(); 4096];
            let mut r = inotify::Reader::new(&ino, &mut ev);
            while r.next().is_ok() {}
            f.sync();
        }
        // Answers: the first that isn't a failure goes to the client; the query then done.
        let mut done: Vec<usize> = Vec::new();
        for (j, &(i, k)) in owners.iter().enumerate() {
            if !ready[4 + j] || done.contains(&i) {
                continue;
            }
            let Ok((n, _, _)) =
                rustix::net::recvfrom(&pending[i].socks[k], &mut buf[..], RecvFlags::DONTWAIT)
            else {
                continue;
            };
            let answer = buf[..n].to_vec();
            let q = &mut pending[i];
            if answer.len() < 12 || answer.get(..2) != q.query.get(..2) {
                continue;
            }
            if matches!(rcode(&answer), 2 | 5) {
                q.failed = Some(answer);
                continue;
            }
            let _ = rustix::net::sendto(&udp, &answer, SendFlags::DONTWAIT, &q.client);
            done.push(i);
        }
        let t = now_ms();
        let mut k = 0;
        pending.retain(|q| {
            let i = k;
            k += 1;
            if done.contains(&i) {
                return false;
            }
            if t >= q.until || q.failed.is_some() && q.socks.len() == 1 {
                let a = q.failed.clone().unwrap_or_else(|| servfail(&q.query));
                let _ = rustix::net::sendto(&udp, &a, SendFlags::DONTWAIT, &q.client);
                return false;
            }
            true
        });
        // Queries over UDP.
        if ready[2] {
            while let Ok((n, _, Some(from))) =
                rustix::net::recvfrom(&udp, &mut buf[..], RecvFlags::DONTWAIT)
            {
                if n < 12 {
                    continue; // not a query: no header to answer by
                }
                let q = buf[..n].to_vec();
                let Ok(client) = SocketAddr::try_from(from) else {
                    continue;
                };
                let servers = f.servers(&q);
                if servers.is_empty() || pending.len() >= MAX_PENDING {
                    let _ = rustix::net::sendto(&udp, &servfail(&q), SendFlags::DONTWAIT, &client);
                    continue;
                }
                let socks: Vec<OwnedFd> = servers
                    .iter()
                    .filter_map(|s| udp_to(*s).ok())
                    .filter(|s| rustix::net::send(s, &q, SendFlags::DONTWAIT).is_ok())
                    .collect();
                if socks.is_empty() {
                    let _ = rustix::net::sendto(&udp, &servfail(&q), SendFlags::DONTWAIT, &client);
                    continue;
                }
                pending.push(Pending {
                    client,
                    socks,
                    until: now_ms() + QUERY_MS,
                    query: q,
                    failed: None,
                });
            }
        }
        tcp_children.retain(|p| {
            !matches!(
                rustix::process::waitpid(Some(*p), WaitOptions::NOHANG),
                Ok(Some(_))
            )
        });
        // Queries over TCP: a child each, `MAX_TCP` at most (past them a connection is closed: musl falls back).
        if ready[3] {
            while let Ok(conn) = rustix::net::accept_with(&tcp, SocketFlags::CLOEXEC) {
                if tcp_children.len() >= MAX_TCP {
                    drop(conn);
                    continue;
                }
                if let Some(pid) = tcp_child(
                    &f,
                    conn,
                    &[
                        parent.as_raw_fd(),
                        ino.as_raw_fd(),
                        udp.as_raw_fd(),
                        tcp.as_raw_fd(),
                    ],
                ) {
                    tcp_children.push(pid);
                }
            }
        }
    }
}

unsafe extern "C" {
    /// The C library's (musl's), as in src/lease.rs.
    fn fork() -> i32;
    /// The C library's: SIGALRM (whose default ends the process) in `secs` seconds.
    fn alarm(secs: u32) -> u32;
}

/// A TCP child's whole life at most (each read and write is bounded by `QUERY_MS` besides): a client that trickles
/// its bytes doesn't hold one longer.
const TCP_CHILD_S: u32 = 3 * (QUERY_MS / 1000) as u32;

/// A TCP query on `conn`, answered by a child: read whole (its length first), asked of the first of its servers that
/// takes a connection, the answer written back. Every step bounded by the socket's 5 s timeouts, the whole by
/// `TCP_CHILD_S`; it ends with the forwarder.
fn tcp_child(f: &Forwarder, conn: OwnedFd, close: &[i32]) -> Option<Pid> {
    // SAFETY: the forwarder is one thread; the child exits without returning.
    let pid = unsafe { fork() };
    if pid != 0 {
        return Pid::from_raw(pid);
    }
    let _ = rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL));
    // SAFETY: a plain syscall wrapper; SIGALRM's default action ends the child.
    unsafe { alarm(TCP_CHILD_S) };
    for &fd in close {
        // SAFETY: the parent's descriptors, which the child never uses.
        unsafe { drop(<OwnedFd as rustix::fd::FromRawFd>::from_raw_fd(fd)) };
    }
    let t = Some(core::time::Duration::from_millis(QUERY_MS));
    let _ = rustix::net::sockopt::set_socket_timeout(&conn, rustix::net::sockopt::Timeout::Recv, t);
    let _ = rustix::net::sockopt::set_socket_timeout(&conn, rustix::net::sockopt::Timeout::Send, t);
    let ok = (|| -> Option<()> {
        let msg = read_msg(&conn)?;
        for s in f.servers(&msg[2..]) {
            let family = if s.is_ipv4() {
                AddressFamily::INET
            } else {
                AddressFamily::INET6
            };
            let Ok(up) =
                rustix::net::socket_with(family, SocketType::STREAM, SocketFlags::CLOEXEC, None)
            else {
                continue;
            };
            let _ = rustix::net::sockopt::set_socket_timeout(
                &up,
                rustix::net::sockopt::Timeout::Recv,
                t,
            );
            let _ = rustix::net::sockopt::set_socket_timeout(
                &up,
                rustix::net::sockopt::Timeout::Send,
                t,
            );
            if rustix::net::connect(&up, &s).is_err() || !write_all(&up, &msg) {
                continue;
            }
            let a = read_msg(&up)?;
            write_all(&conn, &a).then_some(())?;
            return Some(());
        }
        None
    })();
    crate::rt::exit(if ok.is_some() { 0 } else { 1 });
}

/// A DNS message over TCP: its 2-byte length and the bytes, read whole.
fn read_msg(fd: impl AsFd) -> Option<Vec<u8>> {
    let mut len = [0u8; 2];
    read_exact(&fd, &mut len)?;
    let n = u16::from_be_bytes(len) as usize;
    let mut m = vec![0u8; 2 + n];
    m[..2].copy_from_slice(&len);
    read_exact(&fd, &mut m[2..])?;
    (n >= 12).then_some(m)
}

fn read_exact(fd: impl AsFd, mut b: &mut [u8]) -> Option<()> {
    while !b.is_empty() {
        match rustix::io::read(&fd, &mut *b) {
            Ok(0) | Err(_) => return None,
            Ok(n) => b = &mut b[n..],
        }
    }
    Some(())
}

fn write_all(fd: impl AsFd, mut b: &[u8]) -> bool {
    while !b.is_empty() {
        match rustix::io::write(&fd, b) {
            Ok(n) if n > 0 => b = &b[n..],
            _ => return false,
        }
    }
    true
}

/// The forwarder, running (the root's: its process, its pidfd, when it started, and the pipe whose closing ends it).
pub struct Running {
    pub pid: Pid,
    /// Readable once it ended (the root's poll hears it: `ended`); none if the kernel gave none (descriptors ran out).
    pub pidfd: Option<OwnedFd>,
    started: u64,
    /// Held, never written: its closing (the root's end, a crash too) ends the forwarder.
    _pipe: OwnedFd,
}

/// A forwarder that ended sooner than this after its start isn't started again at once (one that can't run: the next
/// CARDS tries again).
const YOUNG_MS: u64 = 10_000;

/// Forks the forwarder (`serve`); the root keeps the pipe's write end, and the child exits when it closes.
pub fn spawn(p: &Paths) -> Result<Running, Errno> {
    let (read, write) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;
    // SAFETY: the agent is one thread; the child never returns to the parent's frames.
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        drop(write);
        crate::rt::close_inherited_but(read.as_raw_fd());
        crate::rt::exit(serve(p.clone(), read));
    }
    drop(read);
    let pid = Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    Ok(Running {
        pid,
        pidfd: rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()).ok(),
        started: now_ms(),
        _pipe: write,
    })
}

/// The file written back with the upstreams its comments keep, if it's a forwarder's (the root's, for one that died:
/// it could not).
pub fn give_back(p: &Paths) {
    let text = crate::rt::read_text(&p.resolv).unwrap_or_default();
    if text.lines().next() == Some(MARKER) {
        let up = Resolv {
            ours: false,
            ..parse_resolv(&text)
        };
        match write_file(&p.resolv, &plain(&up)) {
            Ok(()) => crate::log("resolve: resolv.conf given back", None),
            Err(e) => crate::log("resolve: resolv.conf", Some(e)),
        }
    }
}

/// Forwarder `r` ended (its pidfd readable) at `now`, or is ended: reaped, and the file given back, so names resolve
/// through the upstreams meanwhile. Whether to start it again: not when it died young (`YOUNG_MS`).
pub fn ended(r: Running, p: &Paths, now: u64) -> bool {
    let _ = rustix::process::kill_process(r.pid, rustix::process::Signal::KILL);
    let _ = rustix::process::waitpid(Some(r.pid), WaitOptions::empty());
    give_back(p);
    now >= r.started + YOUNG_MS
}

/// Now, in the monotonic clock's milliseconds (`ended`'s `now`).
pub fn now() -> u64 {
    now_ms()
}

/// Whether the forwarder still runs (reaped if it ended).
pub fn alive(r: &Running) -> bool {
    matches!(
        rustix::process::waitpid(Some(r.pid), WaitOptions::NOHANG),
        Ok(None)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDHCPC: &str =
        "search lan\nnameserver 192.168.127.1\nnameserver 192.168.127.2\noptions ndots:1\n";

    fn room() -> Room {
        Room {
            servers: vec![IpAddr::from_str("fd81:4c4:489d::53").unwrap()],
            domains: vec!["global.p2p.internal".into()],
        }
    }

    #[test]
    fn resolv_conf_taken_and_given_back() {
        let up = parse_resolv(UDHCPC);
        assert!(!up.ours);
        assert_eq!(up.servers.len(), 2);
        assert_eq!(up.search, ["lan"]);
        assert_eq!(up.rest, ["options ndots:1"]);
        // The rooms' domains after the upstream's: musl stops at the first search domain that fails (SERVFAIL, a
        // timeout), so a room that doesn't answer (its adapter disconnected) mustn't come before the names the
        // upstream's domains find.
        let mine = ours(&up, &[room()], IpAddr::V4(LISTEN));
        assert_eq!(
            mine,
            format!(
                "{MARKER}\n# upstream nameserver 192.168.127.1\n# upstream nameserver 192.168.127.2\n# upstream search lan\nsearch lan global.p2p.internal\nnameserver 127.0.53.53\noptions ndots:1\n"
            )
        );
        // Read back (a forwarder started again): its upstreams from the comments, not the forwarder.
        let again = parse_resolv(&mine);
        assert!(again.ours);
        assert_eq!(again.servers, up.servers);
        assert_eq!(
            again.search,
            ["lan"],
            "the upstream's search, not the rooms'"
        );
        assert_eq!(
            plain(&Resolv {
                ours: false,
                ..again
            }),
            UDHCPC
        );
        assert_eq!(plain(&up), UDHCPC);
    }

    #[test]
    fn a_rooms_names_go_to_its_resolver_the_rest_upstream() {
        let up = parse_resolv(UDHCPC).servers;
        let rooms = [room()];
        assert_eq!(
            route("abc.global.p2p.internal", &rooms, &up),
            rooms[0].servers.as_slice()
        );
        assert_eq!(
            route("git.test123.global.p2p.internal", &rooms, &up),
            rooms[0].servers.as_slice()
        );
        assert_eq!(
            route("global.p2p.internal", &rooms, &up),
            rooms[0].servers.as_slice()
        );
        assert_eq!(route("dl-cdn.alpinelinux.org", &rooms, &up), up.as_slice());
        assert_eq!(
            route("xglobal.p2p.internal", &rooms, &up),
            up.as_slice(),
            "a label, not a suffix of one"
        );
        assert_eq!(
            parse_room("dns fd81:4c4:489d::53\nsearch global.p2p.internal. p2p.internal\n"),
            Room {
                servers: room().servers,
                domains: vec!["global.p2p.internal".into(), "p2p.internal".into()]
            }
        );
    }

    #[test]
    fn a_querys_name() {
        // id 0x1234, RD, one question: Abc.Example. A IN
        let q = [
            0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 3, b'A', b'b', b'c', 7, b'E', b'x', b'a',
            b'm', b'p', b'l', b'e', 0, 0, 1, 0, 1,
        ];
        assert_eq!(qname(&q).as_deref(), Some("abc.example"));
        assert_eq!(qname(&q[..14]), None, "cut short");
        assert_eq!(qname(&q[..11]), None);
        let f = servfail(&q);
        assert_eq!((f[0], f[1], f[2] & 0x80, rcode(&f)), (0x12, 0x34, 0x80, 2));
    }

    /// A forwarder of the tests' on loopback: a room's server and an upstream (on 127.0.0.x ports, `base` apart from
    /// another test's), a resolv.conf naming the upstream and a room's file; returned once it holds the file.
    struct Harness {
        dir: std::path::PathBuf,
        roomsrv: std::net::UdpSocket,
        upsrv: std::net::UdpSocket,
        listen: SocketAddr,
        write: Option<OwnedFd>,
        t: Option<std::thread::JoinHandle<i32>>,
    }

    impl Harness {
        fn start(name: &str, listen_ip: &str) -> Harness {
            use std::net::UdpSocket;
            let dir = std::env::temp_dir().join(format!("waarm64-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("rooms")).unwrap();
            let roomsrv = UdpSocket::bind("127.0.0.2:0").unwrap();
            let port = roomsrv.local_addr().unwrap().port();
            let upsrv = UdpSocket::bind(format!("127.0.0.3:{port}")).unwrap();
            std::fs::write(dir.join("resolv.conf"), "nameserver 127.0.0.3\n").unwrap();
            std::fs::write(
                dir.join("rooms/eth1"),
                "dns 127.0.0.2\nsearch global.p2p.internal\n",
            )
            .unwrap();
            let listen: SocketAddr = format!("{listen_ip}:{}", port + 1).parse().unwrap();
            let p = Paths {
                resolv: dir.join("resolv.conf").to_str().unwrap().into(),
                etc: dir.to_str().unwrap().into(),
                rooms: dir.join("rooms").to_str().unwrap().into(),
                listen,
                port,
            };
            let (read, write) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).unwrap();
            let t = std::thread::Builder::new()
                .name(name.into())
                .spawn(move || serve(p, read))
                .unwrap();
            let h = Harness {
                dir,
                roomsrv,
                upsrv,
                listen,
                write: Some(write),
                t: Some(t),
            };
            assert!(h.until(|f| f.starts_with(MARKER)), "the file taken");
            h
        }

        fn resolv(&self) -> String {
            std::fs::read_to_string(self.dir.join("resolv.conf")).unwrap()
        }

        /// Whether the file came to be as `ok` wants within 2 s.
        fn until(&self, ok: impl Fn(&str) -> bool) -> bool {
            for _ in 0..100 {
                if ok(&self.resolv()) {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            false
        }

        fn running(&self) -> bool {
            !self.t.as_ref().unwrap().is_finished()
        }

        /// The root's pipe closed: the forwarder's exit status.
        fn end(&mut self) -> i32 {
            drop(self.write.take());
            self.t.take().unwrap().join().unwrap()
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            drop(self.write.take());
            if let Some(t) = self.t.take() {
                let _ = t.join();
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A query for `name` (AAAA, id 0xabcd).
    fn query(name: &[u8]) -> Vec<u8> {
        let mut q = vec![0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split(|&b| b == b'.') {
            q.push(l.len() as u8);
            q.extend_from_slice(l);
        }
        q.extend_from_slice(&[0, 0, 28, 0, 1]);
        q
    }

    /// The forwarder end to end on loopback: resolv.conf taken, a query to each server routed there and answered,
    /// the file given back when the room's lease goes and when the pipe closes.
    #[test]
    fn forwards_and_gives_back() {
        use std::net::UdpSocket;
        let mut h = Harness::start("resolve", "127.0.53.54");
        let (listen, roomsrv, upsrv, dir) = (h.listen, &h.roomsrv, &h.upsrv, h.dir.clone());
        assert!(h.resolv().contains("nameserver 127.0.53.54"));
        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let ask = |name: &[u8], srv: &UdpSocket| {
            client.send_to(&query(name), listen).unwrap();
            let mut b = [0u8; 512];
            let (n, from) = srv.recv_from(&mut b).unwrap();
            let mut a = b[..n].to_vec();
            a[2] |= 0x80;
            srv.send_to(&a, from).unwrap();
            let (n, _) = client.recv_from(&mut b).unwrap();
            b[..n].to_vec()
        };
        let a = ask(b"abc.global.p2p.internal", roomsrv);
        assert_eq!(
            (a[0], a[1], a[2] & 0x80),
            (0xab, 0xcd, 0x80),
            "the room's answer relayed"
        );
        let a = ask(b"dl-cdn.alpinelinux.org", upsrv);
        assert_eq!((a[0], a[1]), (0xab, 0xcd), "the upstream's");
        // The room's lease lost: the file given back; then the agent ends.
        std::fs::remove_file(dir.join("rooms/eth1")).unwrap();
        assert!(
            h.until(|f| f == "nameserver 127.0.0.3\n"),
            "given back: {}",
            h.resolv()
        );
        std::fs::write(
            dir.join("rooms/eth1"),
            "dns 127.0.0.2\nsearch global.p2p.internal\n",
        )
        .unwrap();
        assert!(h.until(|f| f.starts_with(MARKER)), "taken again");
        assert_eq!(h.end(), 0);
        assert_eq!(
            std::fs::read_to_string(dir.join("resolv.conf")).unwrap(),
            "nameserver 127.0.0.3\n",
            "given back when the agent ends"
        );
    }

    /// A datagram shorter than a DNS header isn't forwarded (an upstream that answers anything would have the
    /// forwarder compare the answer's ID with a query that has none).
    #[test]
    fn a_runt_query_is_dropped() {
        let h = Harness::start("resolve-runt", "127.0.53.55");
        let up = h.upsrv.try_clone().unwrap();
        up.set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        // An upstream that answers anything with a header (twice: the runt, if it came, then the real query).
        let echo = std::thread::spawn(move || {
            let mut b = [0u8; 512];
            let mut heard = Vec::new();
            for _ in 0..2 {
                let Ok((n, from)) = up.recv_from(&mut b) else {
                    break;
                };
                heard.push(n);
                let mut a = if n >= 12 {
                    b[..n].to_vec()
                } else {
                    vec![0u8; 12]
                };
                a[2] |= 0x80;
                up.send_to(&a, from).unwrap();
            }
            heard
        });
        let client = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        client.send_to(&[0x12], h.listen).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(h.running(), "the forwarder still runs after a 1-byte query");
        let q = query(b"dl-cdn.alpinelinux.org");
        client.send_to(&q, h.listen).unwrap();
        let mut b = [0u8; 512];
        let (n, _) = client.recv_from(&mut b).expect("a real query answered");
        assert_eq!((n, b[0], b[1]), (q.len(), 0xab, 0xcd));
        assert_eq!(
            echo.join().unwrap(),
            [q.len()],
            "the runt never went upstream"
        );
    }

    /// The children of this process's thread named `name` (a forwarder's: its TCP children are forked by the thread
    /// it runs on).
    fn children(name: &str) -> usize {
        std::fs::read_dir("/proc/self/task")
            .unwrap()
            .filter_map(|t| {
                let t = t.ok()?.path();
                (std::fs::read_to_string(t.join("comm")).ok()?.trim() == name)
                    .then(|| std::fs::read_to_string(t.join("children")).ok())?
            })
            .map(|c| c.split_whitespace().count())
            .sum()
    }

    /// Connections over TCP are answered by MAX_TCP children at most: past them, a connection is closed at once (a
    /// local user can't fork the agent's cgroup out of memory).
    #[test]
    fn tcp_children_are_bounded() {
        let h = Harness::start("resolve-tcp", "127.0.53.56");
        let conns: Vec<std::net::TcpStream> = (0..MAX_TCP * 3)
            .map(|_| std::net::TcpStream::connect(h.listen).unwrap())
            .collect();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let n = children("resolve-tcp");
        assert!(n <= MAX_TCP, "{n} children for {} connections", conns.len());
        assert!(n > 0, "the first ones answered by a child");
        assert!(h.running());
    }

    /// A forwarder that dies (the OOM killer, an abort) leaves the file naming an address nobody listens on: the root
    /// hears it end (its pidfd) and gives the file back with the upstreams its comments keep, and says whether to start
    /// it again (not when it died young: a forwarder that can't run).
    #[test]
    fn a_forwarder_that_dies_gives_the_file_back() {
        let dir = std::env::temp_dir().join(format!("waarm64-resolve-dies-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("rooms")).unwrap();
        std::fs::write(
            dir.join("resolv.conf"),
            "search lan\nnameserver 127.0.0.3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("rooms/eth1"),
            "dns 127.0.0.2\nsearch global.p2p.internal\n",
        )
        .unwrap();
        let p = Paths {
            resolv: dir.join("resolv.conf").to_str().unwrap().into(),
            etc: dir.to_str().unwrap().into(),
            rooms: dir.join("rooms").to_str().unwrap().into(),
            listen: "127.0.53.57:5353".parse().unwrap(),
            port: 5353,
        };
        let read = || std::fs::read_to_string(dir.join("resolv.conf")).unwrap();
        let r = spawn(&p).unwrap();
        for _ in 0..100 {
            if read().starts_with(MARKER) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(read().starts_with(MARKER), "taken: {}", read());
        rustix::process::kill_process(r.pid, rustix::process::Signal::KILL).unwrap();
        let pidfd = r.pidfd.as_ref().expect("a pidfd to hear its end on");
        let mut fds = [PollFd::new(pidfd, PollFlags::IN)];
        let t = rustix::time::Timespec {
            tv_sec: 5,
            tv_nsec: 0,
        };
        assert_eq!(poll(&mut fds, Some(&t)).unwrap(), 1, "its end heard");
        assert_eq!(
            read().lines().next(),
            Some(MARKER),
            "still the dead forwarder's"
        );
        let again = ended(r, &p, now_ms());
        assert_eq!(
            read(),
            "search lan\nnameserver 127.0.0.3\n",
            "given back by the root"
        );
        assert!(!again, "died young: not started again at once");
        let r = spawn(&p).unwrap();
        assert!(
            ended(r, &p, now_ms() + 60_000),
            "after a while: started again"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
