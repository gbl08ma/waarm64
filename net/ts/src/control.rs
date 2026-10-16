//! The control session (docs/plans/tailnet-client.md §5), sans I/O: the server's Noise key by
//! `fetch` (`/key`), the Noise channel over a WebSocket to `/ts2021` (the initiation in the URL,
//! as Tailscale's js/wasm client does: a browser can't set headers), HTTP/2 inside it, then
//! registration and the map stream (`/machine/map`, streaming, uncompressed). Tailscale's
//! `controlclient` and tailscale-rs's `ts_control` are the reference; the Go client and our
//! tests (tests/ts-handover.test.ts) the oracle. The node's keys come from and go back to the
//! Go client's store (store.rs).

use std::{
    collections::VecDeque,
    time::{Duration, Instant, SystemTime},
};

use serde_json::json;
use ts_control_serde::{HostInfo, MapRequest, NetInfo, RegisterAuth, RegisterRequest};
use ts_keys::{
    DiscoPublicKey, Export, ExportableKey, NetworkLockPublicKey, NodePrivateKey, NodePublicKey,
};

use crate::{
    client::Action,
    h2pipe,
    netmap::{Changed, NetMap},
    noise,
    store::{Kept, Login, Store},
};

/// Control's WebSocket IDs start here (DERP's start at 1).
pub const CONN_BASE: u32 = 1 << 30;
/// The `fetch` ID of the key fetch.
pub const KEY_FETCH: u32 = 1 << 30;
/// How long the map stream may be silent before the session is presumed dead (the server
/// sends a keep-alive about every minute).
const SILENCE: Duration = Duration::from_secs(150);
const EARLY_MAGIC: &[u8; 5] = b"\xff\xff\xffTS";

pub struct Config {
    /// The control server, `https://host[:port]`.
    pub url: String,
    pub auth_key: Option<String>,
    pub hostname: String,
    /// Ask for an ephemeral node (the control server removes it once it's gone).
    pub ephemeral: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    FetchingKey,
    Connecting,
    Registering,
    /// Waiting for the user to visit the login URL (the follow-up registration is long-polling).
    NeedsLogin,
    /// The map stream is open.
    Mapping,
    LoggingOut,
    LoggedOut,
    Failed,
}

/// What the session tells the client it belongs to.
#[derive(Debug, PartialEq)]
pub enum Update {
    Phase(Phase),
    Map(Changed),
    /// Gave up for good (a refused registration, a key the server rejects): why.
    Failed(String),
}

pub struct Session {
    cfg: Config,
    store: Store,
    pub kept: Kept,
    /// The node's current private key (kept, or new for a registration).
    node: [u8; 32],
    disco: [u8; 32],
    control_key: Option<[u8; 32]>,
    conn: Option<u32>,
    next_conn: u32,
    noise: Option<noise::Conn>,
    /// Plaintext before HTTP/2: the optional early payload is looked for there.
    early: Option<Vec<u8>>,
    h2: Option<h2pipe::Client>,
    register: Option<u32>,
    map: Option<u32>,
    map_buf: Vec<u8>,
    resp: Vec<u8>,
    followup: Option<String>,
    login_url: Option<String>,
    pub netmap: NetMap,
    pub phase: Phase,
    /// Whether the store has the login yet.
    saved: bool,
    /// The home DERP region the map requests name.
    home: Option<u32>,
    retry_at: Option<Instant>,
    silent_at: Option<Instant>,
    failures: u32,
    pub actions: VecDeque<Action>,
    pub updates: Vec<Update>,
}

fn percent(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn public(private: &[u8; 32]) -> [u8; 32] {
    *Export::<NodePrivateKey>::from_bytes(*private)
        .import()
        .public_key()
        .export()
        .as_bytes()
}

fn random32() -> [u8; 32] {
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).expect("randomness");
    k
}

fn rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Session {
    /// A session for the node kept in `entries` (the store's `<StateKey>` → bytes).
    pub fn new(cfg: Config, store: Store, disco_public: [u8; 32]) -> Self {
        let mut store = store;
        let kept = store.load();
        let node = kept.node.unwrap_or_else(random32);
        let mut s = Session {
            cfg,
            store,
            node,
            kept,
            disco: disco_public,
            control_key: None,
            conn: None,
            next_conn: CONN_BASE,
            noise: None,
            early: None,
            h2: None,
            register: None,
            map: None,
            map_buf: Vec::new(),
            resp: Vec::new(),
            followup: None,
            login_url: None,
            netmap: NetMap::default(),
            phase: Phase::FetchingKey,
            saved: false,
            home: None,
            retry_at: None,
            silent_at: None,
            failures: 0,
            actions: VecDeque::new(),
            updates: Vec::new(),
        };
        s.flush_store();
        s
    }

    /// The node's private key (what WireGuard and DERP use).
    pub fn node_private(&self) -> [u8; 32] {
        self.node
    }

    /// The node's public key.
    pub fn node_public(&self) -> [u8; 32] {
        public(&self.node)
    }

    pub fn start(&mut self, now: Instant) {
        let _ = now;
        self.set_phase(Phase::FetchingKey);
        let (scheme, host) = self.origin();
        self.actions.push_back(Action::Fetch {
            id: KEY_FETCH,
            url: format!("{scheme}://{host}/key?v={}", noise::capability_version()),
        });
    }

    /// The control URL's scheme and `host[:port]`.
    fn origin(&self) -> (&str, &str) {
        let u = self.cfg.url.trim_end_matches('/');
        match u.split_once("://") {
            Some((s, rest)) => (s, rest.split('/').next().unwrap_or(rest)),
            None => ("https", u),
        }
    }

    fn set_phase(&mut self, p: Phase) {
        if self.phase != p {
            self.phase = p;
            self.updates.push(Update::Phase(p));
        }
    }

    fn event(&mut self, v: serde_json::Value) {
        self.actions.push_back(Action::Event(v.to_string()));
    }

    fn log(&mut self, msg: String) {
        self.event(json!({ "type": "log", "msg": msg }));
    }

    fn flush_store(&mut self) {
        for (key, value) in self.store.take_writes() {
            let hex: String = value.iter().map(|b| format!("{b:02x}")).collect();
            self.event(json!({ "type": "store", "key": key, "value": hex }));
        }
    }

    fn fail(&mut self, why: String) {
        self.close();
        self.set_phase(Phase::Failed);
        self.updates.push(Update::Failed(why));
    }

    /// The server's key fetched (or not).
    pub fn fetched(&mut self, ok: bool, body: &[u8], now: Instant) {
        if self.phase != Phase::FetchingKey {
            return;
        }
        let key = ok
            .then(|| serde_json::from_slice::<serde_json::Value>(body).ok())
            .flatten()
            .and_then(|v| {
                let s = v["publicKey"].as_str()?.strip_prefix("mkey:")?.to_string();
                let mut k = [0u8; 32];
                for (i, b) in k.iter_mut().enumerate() {
                    *b = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()?;
                }
                Some(k)
            });
        match key {
            Some(k) => {
                self.control_key = Some(k);
                self.connect(now);
            }
            None => self.retry(now, "couldn't get the control server's key (is the URL right, and does /key allow this origin?)".into()),
        }
    }

    fn connect(&mut self, now: Instant) {
        self.close_conn();
        let Some(control) = self.control_key else {
            return self.start(now);
        };
        let (n, init) = noise::Conn::new(self.kept.machine, control);
        let (scheme, host) = self.origin();
        let ws = if scheme == "http" { "ws" } else { "wss" };
        let url = format!(
            "{ws}://{host}/ts2021?X-Tailscale-Handshake={}",
            percent(&init)
        );
        let conn = self.next_conn;
        self.next_conn += 1;
        self.conn = Some(conn);
        self.noise = Some(n);
        self.early = Some(Vec::new());
        self.actions.push_back(Action::WsOpen {
            conn,
            url,
            protocol: "tailscale-control-protocol",
        });
        // A handshake that never completes is a failure like any other.
        self.silent_at = Some(now + Duration::from_secs(30));
        if self.phase != Phase::Mapping && self.phase != Phase::NeedsLogin {
            self.set_phase(Phase::Connecting);
        }
    }

    pub fn owns(&self, conn: u32) -> bool {
        self.conn == Some(conn)
    }

    pub fn ws_closed(&mut self, conn: u32, now: Instant) {
        if self.conn == Some(conn) {
            self.conn = None;
            self.retry(now, "the control connection closed".into());
        }
    }

    pub fn ws_message(&mut self, conn: u32, data: &[u8], now: Instant) {
        if self.conn != Some(conn) {
            return;
        }
        let Some(n) = self.noise.as_mut() else { return };
        let was_open = n.is_open();
        let plain = match n.input(data) {
            Ok(p) => p,
            Err(e) => return self.retry(now, e),
        };
        if !was_open && self.noise.as_ref().is_some_and(|n| n.is_open()) {
            let (scheme, host) = self.origin();
            let origin = format!("{scheme}://{host}");
            self.h2 = Some(h2pipe::Client::new(&origin));
            self.send_register(now);
        }
        let mut plain = plain;
        if let Some(early) = self.early.as_mut() {
            early.extend_from_slice(&std::mem::take(&mut plain));
            if early.len() < EARLY_MAGIC.len() {
                return self.pump(now);
            }
            if early.starts_with(EARLY_MAGIC) {
                // The early payload (a node-key challenge we don't use): skipped.
                if early.len() < 9 {
                    return self.pump(now);
                }
                let len = u32::from_be_bytes(early[5..9].try_into().unwrap()) as usize;
                if early.len() < 9 + len {
                    return self.pump(now);
                }
                plain = early.split_off(9 + len);
            } else {
                plain = std::mem::take(early);
            }
            self.early = None;
        }
        if let Some(h) = self.h2.as_mut() {
            h.input(&plain);
        }
        self.pump(now);
    }

    /// Runs HTTP/2 and handles what happened; sends what it wrote.
    fn pump(&mut self, now: Instant) {
        let Some(h) = self.h2.as_mut() else { return };
        let events = h.poll();
        let out = h.take_output();
        if !out.is_empty()
            && let (Some(conn), Some(n)) = (self.conn, self.noise.as_mut())
        {
            let data = n.seal(&out);
            self.actions.push_back(Action::WsSend { conn, data });
        }
        for e in events {
            self.http_event(e, now);
        }
        // Handling a response may have queued a request: send it.
        if let Some(h) = self.h2.as_mut() {
            let events = h.poll();
            let out = h.take_output();
            if !out.is_empty()
                && let (Some(conn), Some(n)) = (self.conn, self.noise.as_mut())
            {
                let data = n.seal(&out);
                self.actions.push_back(Action::WsSend { conn, data });
            }
            for e in events {
                self.http_event(e, now);
            }
        }
    }

    fn http_event(&mut self, e: h2pipe::Event, now: Instant) {
        use h2pipe::Event as E;
        match e {
            E::Status { id, status } if Some(id) == self.register && status != 200 => {
                self.register = None;
                self.resp.clear();
                self.retry(now, format!("registration: HTTP {status}"));
            }
            E::Status { id, status } if Some(id) == self.map && status != 200 => {
                self.map = None;
                self.retry(now, format!("the map request: HTTP {status}"));
            }
            E::Status { .. } => {}
            E::Data { id, data } if Some(id) == self.register => self.resp.extend_from_slice(&data),
            E::End { id } if Some(id) == self.register => {
                self.register = None;
                let body = std::mem::take(&mut self.resp);
                self.registered(&body, now);
            }
            E::Data { id, data } if Some(id) == self.map => {
                self.silent_at = Some(now + SILENCE);
                self.map_buf.extend_from_slice(&data);
                self.map_frames();
            }
            E::End { id } if Some(id) == self.map => {
                self.map = None;
                self.retry(now, "the map stream ended".into());
            }
            E::Failed { id, error } if Some(id) == self.register || Some(id) == self.map => {
                self.register = None;
                self.map = None;
                self.retry(now, error);
            }
            E::Data { .. } | E::End { .. } | E::Failed { .. } => {}
        }
    }

    fn host_info(&self) -> HostInfo<'_> {
        HostInfo {
            ipn_version: concat!("webpc-ts-", env!("CARGO_PKG_VERSION")),
            os: "js",
            app: "webpc",
            hostname: Some(self.cfg.hostname.as_str()),
            net_info: self.home.map(|h| NetInfo {
                preferred_derp: std::num::NonZeroU32::new(h).map(Into::into),
                ..NetInfo::default()
            }),
            ..HostInfo::default()
        }
    }

    fn send_register(&mut self, now: Instant) {
        let _ = now;
        if self.phase != Phase::LoggingOut {
            self.set_phase(if self.followup.is_some() {
                Phase::NeedsLogin
            } else {
                Phase::Registering
            });
        }
        // The auth key only for a node the server doesn't know yet (Go's client sends it on
        // a fresh login, not when a kept node comes back).
        let auth = if self.kept.node.is_none() {
            self.cfg.auth_key.as_deref().filter(|k| !k.is_empty())
        } else {
            None
        };
        let followup = self.followup.as_deref().and_then(|u| u.parse().ok());
        let expiry = (self.phase == Phase::LoggingOut)
            .then(|| chrono::DateTime::from_timestamp(123, 0).unwrap_or_default());
        let req = RegisterRequest {
            version: ts_capabilityversion::CapabilityVersion::CURRENT,
            node_key: NodePublicKey::from_bytes(public(&self.node)),
            old_node_key: self
                .kept
                .old_node
                .map(|k| NodePublicKey::from_bytes(public(&k))),
            nl_key: Some(NetworkLockPublicKey::from_bytes(self.kept.nl_public())),
            auth: auth.map(RegisterAuth::from),
            expiry,
            followup,
            hostinfo: self.host_info(),
            ephemeral: self.cfg.ephemeral,
            ..RegisterRequest::default()
        };
        let body = serde_json::to_vec(&req).expect("a register request");
        let lb = format!("nodekey:{}", hex(&public(&self.node)));
        if let Some(h) = self.h2.as_mut() {
            self.register = Some(h.post("/machine/register", &[("ts-lb", &lb)], body));
        }
    }

    fn registered(&mut self, body: &[u8], now: Instant) {
        // Only these fields are read (as tailscale-rs's `RegisterResponse` names them), so an
        // answer that leaves out the user's details still works.
        let r: serde_json::Value = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => return self.fail(format!("the registration's answer: {e}")),
        };
        let (error, auth_url) = (
            r["Error"].as_str().unwrap_or(""),
            r["AuthURL"].as_str().unwrap_or(""),
        );
        let (authorized, expired) = (
            r["MachineAuthorized"] == json!(true),
            r["NodeKeyExpired"] == json!(true),
        );
        if self.phase == Phase::LoggingOut {
            self.store.forget();
            self.flush_store();
            self.close();
            return self.set_phase(Phase::LoggedOut);
        }
        if !error.is_empty() {
            return self.fail(format!("the control server refused the node: {error}"));
        }
        if expired && self.kept.node.is_some() {
            // A new node key, the old one named so the server knows it's the same node.
            self.log("the node key expired: registering a new one".into());
            self.kept.old_node = self.kept.node.take();
            self.node = random32();
            return self.send_register(now);
        }
        if !authorized {
            if !auth_url.is_empty() {
                let url = auth_url.to_string();
                if self.login_url.as_deref() != Some(&url) {
                    self.login_url = Some(url.clone());
                    self.event(json!({ "type": "login", "url": url }));
                }
                self.followup = Some(url);
                // Long-polls until the user has logged in.
                return self.send_register(now);
            }
            return self.fail("the control server didn't authorize the node (an auth key, or an interactive login, is needed)".into());
        }
        self.followup = None;
        self.kept.node = Some(self.node);
        self.kept.old_node = None;
        self.failures = 0;
        self.send_map(now);
    }

    fn map_request(&self, stream: bool) -> Vec<u8> {
        let req = MapRequest {
            version: ts_capabilityversion::CapabilityVersion::CURRENT,
            node_key: NodePublicKey::from_bytes(public(&self.node)),
            disco_key: DiscoPublicKey::from_bytes(self.disco),
            stream,
            keep_alive: stream,
            omit_peers: !stream,
            host_info: Some(self.host_info()),
            ..MapRequest::default()
        };
        serde_json::to_vec(&req).expect("a map request")
    }

    fn send_map(&mut self, now: Instant) {
        let body = self.map_request(true);
        self.map_buf.clear();
        if let Some(h) = self.h2.as_mut() {
            self.map = Some(h.post("/machine/map", &[], body));
        }
        self.silent_at = Some(now + SILENCE);
        self.set_phase(Phase::Mapping);
    }

    /// Sets the home DERP region (what peers use to reach us), telling the server if it changed.
    pub fn set_home(&mut self, region: u32, now: Instant) {
        if self.home == Some(region) {
            return;
        }
        self.home = Some(region);
        if self.phase == Phase::Mapping {
            // A non-streaming map request updates the server's Hostinfo, as Go's client does.
            let body = self.map_request(false);
            if let Some(h) = self.h2.as_mut() {
                h.post("/machine/map", &[], body);
            }
            self.pump(now);
        }
    }

    /// Length-prefixed (32-bit little-endian) JSON map responses.
    fn map_frames(&mut self) {
        loop {
            if self.map_buf.len() < 4 {
                return;
            }
            let len = u32::from_le_bytes(self.map_buf[..4].try_into().unwrap()) as usize;
            if self.map_buf.len() < 4 + len {
                return;
            }
            let frame: Vec<u8> = self.map_buf.drain(..4 + len).skip(4).collect();
            match self.netmap.apply(&frame) {
                Ok(c) => {
                    if let Some(u) = &c.browse {
                        self.event(json!({ "type": "login", "url": u }));
                    }
                    if c.node {
                        self.save_login();
                    }
                    self.updates.push(Update::Map(c));
                }
                Err(e) => self.log(format!("control: {e}")),
            }
        }
    }

    /// The login in the store, once the node's identity is known (and when it changes).
    fn save_login(&mut self) {
        let Some(n) = self.netmap.node.clone() else {
            return;
        };
        let (login, display) = self.netmap.users.get(&n.user).cloned().unwrap_or_default();
        let magic = n
            .name
            .trim_end_matches('.')
            .split_once('.')
            .map(|(_, d)| d.to_string())
            .unwrap_or_default();
        let kept = Kept {
            node_id: n.stable_id.clone(),
            ..self.kept.clone()
        };
        let url = self.cfg.url.trim_end_matches('/').to_string();
        let domain = self.netmap.domain.clone();
        self.store.save(
            &kept,
            &Login {
                control_url: &url,
                hostname: &self.cfg.hostname,
                node_id: &n.stable_id,
                user: (n.user, &login, &display),
                magic_dns: &magic,
                domain: &domain,
                now: rfc3339(SystemTime::now()),
            },
        );
        self.kept = kept;
        self.saved = true;
        self.flush_store();
    }

    /// Logs the node out: a registration that expires its key now, then the store forgets it.
    pub fn logout(&mut self, now: Instant) {
        if self.h2.is_none() || self.kept.node.is_none() {
            self.store.forget();
            self.flush_store();
            self.close();
            return self.set_phase(Phase::LoggedOut);
        }
        if let (Some(id), Some(h)) = (self.map.take(), self.h2.as_mut()) {
            h.cancel(id);
        }
        self.set_phase(Phase::LoggingOut);
        self.followup = None;
        self.send_register(now);
        self.pump(now);
    }

    fn close_conn(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.actions.push_back(Action::WsClose { conn });
        }
        self.noise = None;
        self.h2 = None;
        self.early = None;
        self.register = None;
        self.map = None;
        self.resp.clear();
        self.map_buf.clear();
    }

    /// Lost the connection or the server misbehaved: again after a backoff.
    fn retry(&mut self, now: Instant, why: String) {
        if matches!(self.phase, Phase::Failed | Phase::LoggedOut) {
            return;
        }
        if self.phase == Phase::LoggingOut {
            // Logging out without a server: forget the node anyway.
            self.store.forget();
            self.flush_store();
            self.close();
            return self.set_phase(Phase::LoggedOut);
        }
        self.close_conn();
        self.failures += 1;
        self.log(format!("control: {why}"));
        self.silent_at = None;
        let backoff = Duration::from_millis(250u64 << self.failures.min(7));
        self.retry_at = Some(now + backoff.min(Duration::from_secs(30)));
    }

    pub fn tick(&mut self, now: Instant) {
        if self.retry_at.is_some_and(|t| t <= now) {
            self.retry_at = None;
            if self.control_key.is_some() {
                self.connect(now);
            } else {
                self.start(now);
            }
        }
        if self.silent_at.is_some_and(|t| t <= now) {
            self.silent_at = None;
            self.retry(now, "the control server went silent".into());
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        [self.retry_at, self.silent_at].into_iter().flatten().min()
    }

    pub fn close(&mut self) {
        self.close_conn();
        self.retry_at = None;
        self.silent_at = None;
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        future::Future,
        pin::Pin,
        rc::Rc,
        task::{Context, Poll, Waker},
    };

    use bytes::Bytes;

    use super::*;

    /// A control server: the Noise responder and an h2 server answering register and map.
    struct Control {
        key: ts_keys::X25519KeyPair,
        noise: Option<noise::testserver::Server>,
        h2: Option<H2Server>,
        registers: Vec<serde_json::Value>,
        maps: Vec<serde_json::Value>,
        /// Whether registrations are authorized, or answered with a login URL.
        authorize: bool,
        map_streams: Vec<h2::SendStream<Bytes>>,
    }

    #[derive(Default)]
    struct Buffers {
        input: std::collections::VecDeque<u8>,
        output: Vec<u8>,
    }
    struct Pipe(Rc<RefCell<Buffers>>);
    impl tokio::io::AsyncRead for Pipe {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let mut b = self.0.borrow_mut();
            if b.input.is_empty() {
                return Poll::Pending;
            }
            let n = b.input.len().min(buf.remaining());
            let d: Vec<u8> = b.input.drain(..n).collect();
            buf.put_slice(&d);
            Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncWrite for Pipe {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            d: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.0.borrow_mut().output.extend_from_slice(d);
            Poll::Ready(Ok(d.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }
    type Hs = Pin<Box<dyn Future<Output = Result<h2::server::Connection<Pipe, Bytes>, h2::Error>>>>;
    struct H2Server {
        buf: Rc<RefCell<Buffers>>,
        hs: Option<Hs>,
        conn: Option<h2::server::Connection<Pipe, Bytes>>,
        open: Vec<(
            String,
            h2::server::SendResponse<Bytes>,
            h2::RecvStream,
            Vec<u8>,
        )>,
    }

    impl Control {
        fn new(authorize: bool) -> Self {
            Control {
                key: noise::testserver::keypair(9),
                noise: None,
                h2: None,
                registers: Vec::new(),
                maps: Vec::new(),
                authorize,
                map_streams: Vec::new(),
            }
        }

        fn key_json(&self) -> Vec<u8> {
            format!(
                "{{\"publicKey\":\"mkey:{}\",\"legacyPublicKey\":\"mkey:{}\"}}",
                hex(self.key.public.as_bytes()),
                hex(&[0; 32])
            )
            .into_bytes()
        }

        /// The server's response to bytes from the client, sealed.
        fn input(&mut self, data: &[u8]) -> Vec<u8> {
            let s = self.noise.as_mut().unwrap();
            let plain = s.open(data);
            let h = self.h2.as_mut().unwrap();
            h.buf.borrow_mut().input.extend(plain);
            let mut cx = Context::from_waker(Waker::noop());
            for _ in 0..4 {
                if let Some(hs) = h.hs.as_mut()
                    && let Poll::Ready(r) = hs.as_mut().poll(&mut cx)
                {
                    h.conn = Some(r.unwrap());
                    h.hs = None;
                }
                if let Some(c) = h.conn.as_mut() {
                    while let Poll::Ready(Some(Ok((req, resp)))) = c.poll_accept(&mut cx) {
                        let path = req.uri().path().to_string();
                        h.open.push((path, resp, req.into_body(), Vec::new()));
                    }
                    let _ = c.poll_closed(&mut cx);
                }
                let mut done = Vec::new();
                for (i, (_, _, body, got)) in h.open.iter_mut().enumerate() {
                    loop {
                        match body.poll_data(&mut cx) {
                            Poll::Ready(Some(Ok(d))) => {
                                let _ = body.flow_control().release_capacity(d.len());
                                got.extend_from_slice(&d);
                            }
                            Poll::Ready(None) => {
                                done.push(i);
                                break;
                            }
                            _ => break,
                        }
                    }
                }
                for i in done.into_iter().rev() {
                    let (path, mut resp, _, got) = h.open.remove(i);
                    let req: serde_json::Value = serde_json::from_slice(&got).unwrap();
                    let ok = http::Response::builder().status(200).body(()).unwrap();
                    if path == "/machine/register" {
                        self.registers.push(req.clone());
                        let body = if self.authorize || req.get("Followup").is_some() {
                            json!({"User": {"ID": 1}, "Login": {"ID": 1}, "MachineAuthorized": true, "AuthURL": "", "Error": "", "NodeKeyExpired": false})
                        } else {
                            json!({"User": {"ID": 0}, "Login": {"ID": 0}, "MachineAuthorized": false, "AuthURL": "https://control.test/register/abc", "Error": "", "NodeKeyExpired": false})
                        };
                        // A follow-up long-polls until the user logs in: answered at once here.
                        let mut s = resp.send_response(ok, false).unwrap();
                        s.send_data(Bytes::from(body.to_string()), true).unwrap();
                    } else {
                        self.maps.push(req.clone());
                        let mut s = resp.send_response(ok, false).unwrap();
                        if req["Stream"] == json!(true) {
                            let map = json!({"Node": {"ID": 5, "StableID": "n5", "Name": "guest.tail.test.", "User": 1,
                                "Key": format!("nodekey:{}", hex(&[1; 32])), "Addresses": ["100.90.0.5/32", "fd7a:115c:a1e0::5/128"],
                                "Created": "2026-10-16T00:00:00Z", "MachineAuthorized": true},
                                "UserProfiles": [{"ID": 1, "LoginName": "tailnet", "DisplayName": "Tail Net"}]});
                            let j = map.to_string();
                            let mut frame = (j.len() as u32).to_le_bytes().to_vec();
                            frame.extend_from_slice(j.as_bytes());
                            s.send_data(Bytes::from(frame), false).unwrap();
                            self.map_streams.push(s);
                        } else {
                            s.send_data(Bytes::new(), true).unwrap();
                        }
                    }
                }
            }
            let out = std::mem::take(&mut h.buf.borrow_mut().output);
            if out.is_empty() {
                Vec::new()
            } else {
                s_seal(self, &out)
            }
        }
    }

    fn s_seal(c: &mut Control, d: &[u8]) -> Vec<u8> {
        c.noise.as_mut().unwrap().seal(d)
    }

    /// Runs the session against the server until nothing is left; its events.
    fn run(s: &mut Session, c: &mut Control, now: Instant) -> Vec<serde_json::Value> {
        let mut events = Vec::new();
        for _ in 0..50 {
            let Some(a) = s.actions.pop_front() else {
                break;
            };
            match a {
                Action::Fetch { id, url } => {
                    assert_eq!(
                        (id, url.as_str()),
                        (KEY_FETCH, "https://control.test:8443/key?v=130")
                    );
                    let body = c.key_json();
                    s.fetched(true, &body, now);
                }
                Action::WsOpen {
                    conn,
                    url,
                    protocol,
                } => {
                    assert_eq!(protocol, "tailscale-control-protocol");
                    let (base, q) = url.split_once("?X-Tailscale-Handshake=").unwrap();
                    assert_eq!(base, "wss://control.test:8443/ts2021");
                    let init = q
                        .replace("%2B", "+")
                        .replace("%2F", "/")
                        .replace("%3D", "=");
                    let (srv, resp) = noise::testserver::Server::accept(&c.key, &init);
                    c.noise = Some(srv);
                    let buf = Rc::new(RefCell::new(Buffers::default()));
                    c.h2 = Some(H2Server {
                        hs: Some(Box::pin(h2::server::handshake(Pipe(buf.clone())))),
                        buf,
                        conn: None,
                        open: Vec::new(),
                    });
                    // The early payload, then (in the same message) nothing else yet.
                    let mut first = resp;
                    let mut early = EARLY_MAGIC.to_vec();
                    let j = br#"{"nodeKeyChallenge":"chalpub:00"}"#;
                    early.extend_from_slice(&(j.len() as u32).to_be_bytes());
                    early.extend_from_slice(j);
                    first.extend(s_seal(c, &early));
                    s.ws_message(conn, &first, now);
                }
                Action::WsSend { conn, data } => {
                    let back = c.input(&data);
                    if !back.is_empty() {
                        s.ws_message(conn, &back, now);
                    }
                }
                Action::Event(e) => events.push(serde_json::from_str(&e).unwrap()),
                Action::WsClose { .. } | Action::ToGuest(_) => {}
            }
        }
        events
    }

    fn cfg() -> Config {
        Config {
            url: "https://control.test:8443".into(),
            auth_key: Some("tskey-test".into()),
            hostname: "guest".into(),
            ephemeral: false,
        }
    }

    #[test]
    fn registers_with_the_auth_key_maps_and_keeps_the_node() {
        let now = Instant::now();
        let mut c = Control::new(true);
        let mut s = Session::new(cfg(), Store::new(BTreeMap::new()), [3; 32]);
        s.start(now);
        let events = run(&mut s, &mut c, now);
        assert_eq!(s.phase, Phase::Mapping, "{:?} {events:?}", s.updates);
        assert_eq!(c.registers.len(), 1);
        let r = &c.registers[0];
        assert_eq!(r["Auth"]["AuthKey"], json!("tskey-test"));
        assert_eq!(r["Hostinfo"]["Hostname"], json!("guest"));
        assert_eq!(
            r["NodeKey"],
            json!(format!("nodekey:{}", hex(&s.node_public())))
        );
        assert!(r["NLKey"].as_str().unwrap().starts_with("nlpub:"));
        assert_eq!(c.maps[0]["Stream"], json!(true));
        assert_eq!(
            c.maps[0]["DiscoKey"],
            json!(format!("discokey:{}", hex(&[3; 32])))
        );
        assert_eq!(
            s.netmap.node.as_ref().unwrap().addresses[0].to_string(),
            "100.90.0.5/32"
        );
        // The store got the machine key, then the login.
        let store: BTreeMap<String, String> = events
            .iter()
            .filter(|e| e["type"] == "store")
            .map(|e| {
                (
                    e["key"].as_str().unwrap().to_string(),
                    e["value"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert!(store.contains_key("_machinekey") && store.contains_key("_profiles"));
        let entries: BTreeMap<String, Vec<u8>> = store
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    (0..v.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&v[i..i + 2], 16).unwrap())
                        .collect(),
                )
            })
            .collect();

        // The same store again: the same machine and node key, no auth key sent, no new login.
        let mut c2 = Control::new(true);
        let mut s2 = Session::new(cfg(), Store::new(entries), [4; 32]);
        assert_eq!(
            (s2.kept.machine, s2.node_public()),
            (s.kept.machine, s.node_public())
        );
        s2.start(now);
        let events = run(&mut s2, &mut c2, now);
        assert_eq!(s2.phase, Phase::Mapping);
        assert!(
            c2.registers[0].get("Auth").is_none(),
            "a kept node logs in by its keys"
        );
        assert!(
            !events.iter().any(|e| e["type"] == "store"),
            "nothing new to keep: {events:?}"
        );
    }

    #[test]
    fn without_a_key_the_user_is_sent_to_log_in() {
        let now = Instant::now();
        let mut c = Control::new(false);
        let mut s = Session::new(
            Config {
                auth_key: None,
                ..cfg()
            },
            Store::new(BTreeMap::new()),
            [3; 32],
        );
        s.start(now);
        let events = run(&mut s, &mut c, now);
        assert!(
            events
                .iter()
                .any(|e| e["type"] == "login" && e["url"] == "https://control.test/register/abc")
        );
        assert_eq!(c.registers.len(), 2, "the follow-up waits for the login");
        assert_eq!(
            c.registers[1]["Followup"],
            json!("https://control.test/register/abc")
        );
        assert!(s.updates.contains(&Update::Phase(Phase::NeedsLogin)));
        assert_eq!(s.phase, Phase::Mapping);
    }

    #[test]
    fn logout_expires_the_key_and_forgets_the_node() {
        let now = Instant::now();
        let mut c = Control::new(true);
        let mut s = Session::new(cfg(), Store::new(BTreeMap::new()), [3; 32]);
        s.start(now);
        run(&mut s, &mut c, now);
        s.logout(now);
        let events = run(&mut s, &mut c, now);
        assert_eq!(s.phase, Phase::LoggedOut);
        let last = c.registers.last().unwrap();
        assert!(last["Expiry"].as_str().unwrap().starts_with("1970-01-01"));
        assert!(
            events.iter().any(|e| e["type"] == "store"),
            "the node is forgotten"
        );
        assert_eq!(s.store.load().node, None);
    }
}
