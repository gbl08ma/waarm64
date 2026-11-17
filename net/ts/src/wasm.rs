//! The module's exports (`web/ts-client.ts` is the other side). One thread,
//! clients by handle. Bytes cross through the module's memory: the host
//! allocates with `ts_alloc` for inputs, and reads each action `ts_poll`
//! returns from `ts_buf()`:
//!
//! | byte 0 | bytes 1..5 (LE) | rest |
//! |---|---|---|
//! | 1 open WebSocket | conn | protocol, NUL, URL |
//! | 2 send on WebSocket | conn | the data |
//! | 3 close WebSocket | conn | |
//! | 4 fetch | id | URL |
//! | 5 packet for the guest | 0 | the IP packet |
//! | 6 event | 0 | JSON |
//! | 7 open a WebRTC connection (a room's) | rtc | 1 to make the offer, 0 to answer |
//! | 8 a peer's description or candidate for it | rtc | JSON |
//! | 9 send on its data channel | rtc | the message |
//! | 10 close it | rtc | |
//! | 11 store a room's registry record (room/names/store.rs) | 0 | the name id (32 bytes), then the record; none: delete it |
//!
//! `ts_new`'s JSON makes a tailcat client (`addr`, `serve`) or, with `control`, a Tailscale one
//! (tailnet.rs) on the kept node `state` (the store's entries as the page keeps them: hex); with
//! `room`, a room's (room.rs), whose WebRTC connections come back through `ts_rtc_*`; with
//! `room.names`, a server of the room's registry, whose stored records come back through
//! `ts_room_names_load` before the first tick; with `room.publish`, a publisher (a names client alone, no guest: the
//! page's names agent puts titles through it with `ts_room_names_put`, each answer a `names-put` event).
//!
//! The names agent's operations (`ts_names_*`, room/names/agent.rs) are pure: JSON in at `ptr`, JSON out in `ts_buf()`
//! (its length), or minus the length of why not.

use std::{cell::RefCell, collections::BTreeMap, time::Instant};

use serde::Deserialize;

use crate::{
    client::{Action, Client, Config, DEFAULT_DERP_MAP, GUEST4, Serve},
    control, room, tailcat, tailnet,
};

/// Either kind of client, behind one set of exports.
enum Any {
    Tailcat(Client),
    Tailnet(Box<tailnet::Client>),
    Room(Box<room::Client>),
}

macro_rules! each {
    ($c:expr, $x:ident => $e:expr) => {
        match $c {
            Any::Tailcat($x) => $e,
            Any::Tailnet($x) => $e,
            Any::Room($x) => $e,
        }
    };
}

thread_local! {
    static CLIENTS: RefCell<Vec<Option<Any>>> = const { RefCell::new(Vec::new()) };
    static BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The configuration `ts_new` takes, as JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsConfig {
    /// A tailcat server's address; empty or absent: none (serving only).
    #[serde(default)]
    addr: String,
    /// Let tailcat clients in.
    serve: Option<JsServe>,
    #[serde(rename = "derpMapURL")]
    derp_map_url: Option<String>,
    /// The node's private key, 64 hex digits; a fresh one when absent.
    key: Option<String>,
    #[serde(default)]
    dns4: Vec<[u8; 4]>,
    #[serde(default)]
    dns6: Vec<[u8; 16]>,
    /// A Tailscale client of this control server.
    control: Option<JsControl>,
    /// The kept node's store: `<StateKey>` → hex of the bytes.
    #[serde(default)]
    state: BTreeMap<String, String>,
    #[serde(default)]
    exit_node: String,
    /// Peers' subnet routes installed (default: yes, as Tailscale's own apps).
    accept_routes: Option<bool>,
    /// A room's member (room.rs).
    room: Option<JsRoom>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsRoom {
    /// The room's link (room/link.rs), or a bare ID.
    link: String,
    /// The home region: an index into the link's DERP regions (default: the nearest, probed).
    #[serde(default)]
    home: Option<usize>,
    /// Node keys known by hand (`nodekey:` and 64 hex digits): lookups to them are sealed to them.
    #[serde(default)]
    known: Vec<String>,
    #[serde(default)]
    relay_only: bool,
    /// Members may open connections to the guest (default: yes).
    incoming: Option<bool>,
    /// The wall clock at the start, Unix seconds (default: the system's, read each time): a
    /// benchmark's shifted clock, to put an hour's turn into a run (bench/net/room-scale.ts).
    unix_time: Option<u64>,
    /// The node's titles: it serves the room's registry (room/names/server.rs).
    names: Option<JsNames>,
    /// A publisher (room.rs `Config::publish`): a names client alone that puts the page's titles.
    #[serde(default)]
    publish: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsNames {
    #[serde(default)]
    titles: Vec<JsTitle>,
    max_names: Option<usize>,
    max_bytes: Option<usize>,
}

/// A title: the name's owner key (64 hex digits) and its item (room/names/wire.rs, hex).
#[derive(Deserialize)]
struct JsTitle {
    key: String,
    item: String,
}

fn node_keys(keys: &[String]) -> Result<Vec<[u8; 32]>, String> {
    keys.iter()
        .map(|k| match k.trim().strip_prefix("nodekey:") {
            Some(h) => unhex32(h),
            None => Err(format!("not a node key: {k}")),
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsControl {
    url: String,
    auth_key: Option<String>,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    ephemeral: bool,
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    (0..s.len() / 2)
        .map(|i| {
            u8::from_str_radix(&s[2 * i..2 * i + 2], 16)
                .map_err(|_| "a stored value isn't hex".to_string())
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsServe {
    /// The served address's pre-shared key, 64 hex digits.
    psk: String,
    /// The relay without an exit node: `host[:port]` of one's own derper, or empty for a
    /// region of the DERP map (`region`, default the map's first).
    #[serde(default)]
    relay: String,
    #[serde(default)]
    region: i64,
    /// The clients let in, as `tailcat serve --allow` takes them (`nodekey:` and 64 hex digits);
    /// empty: any client with the address.
    #[serde(default)]
    allow: Vec<String>,
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.strip_prefix("privkey:").unwrap_or(s);
    if s.len() != 64 {
        return Err("a key is 64 hex digits".into());
    }
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| "a key is 64 hex digits")?;
    }
    Ok(k)
}

/// The bytes the host wrote at `ptr` (from `ts_alloc`), taken back.
///
/// # Safety
/// `ptr` and `len` must come from one `ts_alloc(len)`, used once.
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }
    // SAFETY: the caller passes a buffer `ts_alloc` leaked with exactly this length and capacity.
    unsafe { Vec::from_raw_parts(ptr, len, len) }
}

fn with<R>(h: u32, f: impl FnOnce(&mut Any) -> R) -> Option<R> {
    CLIENTS.with_borrow_mut(|cs| cs.get_mut(h.wrapping_sub(1) as usize)?.as_mut().map(f))
}

fn set_buf(b: Vec<u8>) -> u32 {
    let n = b.len() as u32;
    BUF.set(b);
    n
}

/// A buffer of `len` bytes for an input; the call it's passed to frees it.
#[unsafe(no_mangle)]
pub extern "C" fn ts_alloc(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Where the last `ts_poll` or failed `ts_new` put its bytes.
#[unsafe(no_mangle)]
pub extern "C" fn ts_buf() -> *const u8 {
    BUF.with_borrow(|b| b.as_ptr())
}

/// A client from the JSON config at `ptr`: its handle (> 0), or minus the
/// length of an error message in `ts_buf()`.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_new(ptr: *mut u8, len: usize) -> i32 {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let json = unsafe { take(ptr, len) };
    let made = serde_json::from_slice::<JsConfig>(&json)
        .map_err(|e| format!("the configuration: {e}"))
        .and_then(|c| -> Result<Any, String> {
            if let Some(ctl) = c.control {
                let state = c
                    .state
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), unhex(v)?)))
                    .collect::<Result<_, String>>()?;
                let cfg = tailnet::Config {
                    control: control::Config {
                        url: ctl.url,
                        auth_key: ctl.auth_key,
                        hostname: if ctl.hostname.is_empty() {
                            "waarm64".into()
                        } else {
                            ctl.hostname
                        },
                        ephemeral: ctl.ephemeral,
                    },
                    state,
                    exit_node: c.exit_node,
                    accept_routes: c.accept_routes.unwrap_or(true),
                };
                return tailnet::Client::new(cfg, Instant::now())
                    .map(|t| Any::Tailnet(Box::new(t)));
            }
            let key = c.key.as_deref().map(unhex32).transpose()?;
            if let Some(r) = c.room {
                let cfg = room::Config {
                    link: room::Link::parse(&r.link)?,
                    key,
                    home: r.home,
                    derp_map_url: c.derp_map_url.unwrap_or_else(|| DEFAULT_DERP_MAP.into()),
                    known: node_keys(&r.known)?,
                    relay_only: r.relay_only,
                    incoming: r.incoming.unwrap_or(true),
                    unix_time: r.unix_time,
                    names: r.names.map(names_config).transpose()?,
                    params: room::names::Params::BUILT,
                    publish: r.publish,
                };
                return room::Client::new(cfg, Instant::now()).map(|r| Any::Room(Box::new(r)));
            }
            let serve = c
                .serve
                .map(|s| -> Result<Serve, String> {
                    let nodes = match s.relay.trim() {
                        "" => Vec::new(),
                        r => vec![tailcat::parse_relay(r)?],
                    };
                    Ok(Serve {
                        psk: unhex32(&s.psk)?,
                        nodes,
                        region_id: s.region,
                        allow: node_keys(&s.allow)?,
                    })
                })
                .transpose()?;
            let cfg = Config {
                addr: c.addr,
                serve,
                derp_map_url: c.derp_map_url.unwrap_or_else(|| DEFAULT_DERP_MAP.into()),
                key,
                guest4: GUEST4,
                dns4: c.dns4,
                dns6: c.dns6,
            };
            Client::new(cfg, Instant::now()).map(Any::Tailcat)
        });
    match made {
        Ok(c) => CLIENTS.with_borrow_mut(|cs| {
            cs.push(Some(c));
            cs.len() as i32
        }),
        Err(e) => -(set_buf(e.into_bytes()) as i32),
    }
}

/// The client's private key, 32 bytes in `ts_buf()` (to keep it).
#[unsafe(no_mangle)]
pub extern "C" fn ts_private_key(h: u32) -> u32 {
    with(h, |c| match c {
        Any::Tailcat(c) => set_buf(c.private_key().to_vec()),
        Any::Room(c) => set_buf(c.private_key().to_vec()),
        Any::Tailnet(_) => 0,
    })
    .unwrap_or(0)
}

/// The next action's length in `ts_buf()`, 0 when there's none.
#[unsafe(no_mangle)]
pub extern "C" fn ts_poll(h: u32) -> u32 {
    let Some(Some(a)) = with(h, |c| each!(c, x => x.poll())) else {
        return 0;
    };
    let (kind, n, rest): (u8, u32, Vec<u8>) = match a {
        Action::WsOpen {
            conn,
            url,
            protocol,
        } => (
            1,
            conn,
            [protocol.as_bytes(), &[0], url.as_bytes()].concat(),
        ),
        Action::WsSend { conn, data } => (2, conn, data),
        Action::WsClose { conn } => (3, conn, Vec::new()),
        Action::Fetch { id, url } => (4, id, url.into_bytes()),
        Action::ToGuest(p) => (5, 0, p),
        Action::Event(json) => (6, 0, json.into_bytes()),
        Action::RtcOpen { rtc, offer } => (7, rtc, vec![offer as u8]),
        Action::RtcSignal { rtc, data } => (8, rtc, data.into_bytes()),
        Action::RtcSend { rtc, data } => (9, rtc, data),
        Action::RtcClose { rtc } => (10, rtc, Vec::new()),
        Action::NamesStore { id, record } => {
            (11, 0, [&id[..], &record.unwrap_or_default()].concat())
        }
    };
    let mut b = Vec::with_capacity(5 + rest.len());
    b.push(kind);
    b.extend_from_slice(&n.to_le_bytes());
    b.extend_from_slice(&rest);
    set_buf(b)
}

/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_ws_message(h: u32, conn: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    with(
        h,
        |c| each!(c, x => x.ws_message(conn, &data, Instant::now())),
    );
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_ws_closed(h: u32, conn: u32) {
    with(h, |c| each!(c, x => x.ws_closed(conn, Instant::now())));
}

/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_fetched(h: u32, id: u32, ok: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let body = unsafe { take(ptr, len) };
    with(
        h,
        |c| each!(c, x => x.fetched(id, ok != 0, &body, Instant::now())),
    );
}

/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_guest(h: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let p = unsafe { take(ptr, len) };
    with(h, |c| each!(c, x => x.guest_packet(&p, Instant::now())));
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_tick(h: u32) {
    with(h, |c| each!(c, x => x.tick(Instant::now())));
}

/// Milliseconds until `ts_tick` must run, or -1 for never.
#[unsafe(no_mangle)]
pub extern "C" fn ts_deadline(h: u32) -> f64 {
    let now = Instant::now();
    with(h, |c| each!(c, x => x.deadline()))
        .flatten()
        .map_or(-1.0, |t| {
            t.saturating_duration_since(now).as_secs_f64() * 1000.0
        })
}

/// Closes the client (its WebSocket close actions are still to poll) and frees it after.
#[unsafe(no_mangle)]
pub extern "C" fn ts_close(h: u32) {
    with(h, |c| each!(c, x => x.close()));
}

/// Frees a closed client once its actions are polled.
#[unsafe(no_mangle)]
pub extern "C" fn ts_free(h: u32) {
    CLIENTS.with_borrow_mut(|cs| {
        if let Some(c) = cs.get_mut(h.wrapping_sub(1) as usize) {
            *c = None;
        }
    });
}

/// Logs a Tailscale node out (its key expired at the control server, the store told to forget it).
#[unsafe(no_mangle)]
pub extern "C" fn ts_logout(h: u32) {
    with(h, |c| {
        if let Any::Tailnet(t) = c {
            t.logout(Instant::now())
        }
    });
}

/// Uses the peer with this stable ID (UTF-8 at `ptr`) as a Tailscale node's exit node, or none
/// when it's empty; answered by an `exitnode` event.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_exit_node(h: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let id = unsafe { take(ptr, len) };
    let id = String::from_utf8_lossy(&id).into_owned();
    with(h, |c| {
        if let Any::Tailnet(t) = c {
            t.set_exit_node(&id, Instant::now())
        }
    });
}

/// Whether a Tailscale node installs its peers' subnet routes (0: no); the netmap event follows.
#[unsafe(no_mangle)]
pub extern "C" fn ts_accept_routes(h: u32, on: u32) {
    with(h, |c| {
        if let Any::Tailnet(t) = c {
            t.set_accept_routes(on != 0, Instant::now())
        }
    });
}

fn titles_of(titles: &[JsTitle]) -> Result<Vec<room::names::server::Title>, String> {
    titles
        .iter()
        .map(|t| {
            let item = room::names::wire::Item::decode(&unhex(&t.item)?)
                .map_err(|e| format!("a title's item: {e:?}"))?;
            Ok(room::names::server::Title {
                key: unhex32(&t.key)?,
                item,
            })
        })
        .collect::<Result<_, String>>()
}

fn names_config(n: JsNames) -> Result<room::names::server::Config, String> {
    let titles = titles_of(&n.titles)?;
    Ok(room::names::server::Config {
        params: room::names::Params::BUILT,
        titles,
        max_names: n.max_names.unwrap_or(room::names::server::MAX_NAMES),
        max_bytes: n.max_bytes.unwrap_or(room::names::server::MAX_BYTES),
    })
}

/// One stored record of a room's registry, streamed in before the first tick (a server's,
/// `room.names`): 1 when taken.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_room_names_load(h: u32, ptr: *mut u8, len: usize) -> u32 {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    let mut ok = false;
    with_room(h, |r, _| ok = r.names_load(&data));
    ok as u32
}

/// A publisher's item to put (room/names/wire.rs, at `ptr`): 1 when it was taken to be put.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_room_names_put(h: u32, ptr: *mut u8, len: usize) -> u32 {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    let mut ok = false;
    with_room(h, |r, now| ok = r.names_put(&data, now));
    ok as u32
}

/// A publisher's check for the dialog (room-names.md "A member resolving a name"): every id the room's servers hold
/// whose first byte is `first` (256: every id, the dialog's way), each server's answer a `names-ids` event. 1 when it was
/// taken to be asked.
#[unsafe(no_mangle)]
pub extern "C" fn ts_room_names_ids(h: u32, first: u32) -> u32 {
    let mut ok = false;
    with_room(h, |r, now| {
        ok = first <= 256 && r.names_ids(first as u16, now)
    });
    ok as u32
}

/// A room node's titles as they change (JSON: `[{key, item}]`, as the config's `names.titles`): 1 when taken.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_room_names_titles(h: u32, ptr: *mut u8, len: usize) -> u32 {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    let Ok(titles) = serde_json::from_slice::<Vec<JsTitle>>(&data)
        .map_err(|e| e.to_string())
        .and_then(|t| titles_of(&t))
    else {
        return 0;
    };
    with_room(h, |r, now| r.set_titles(titles, now));
    1
}

/// One of the names agent's operations on the JSON at `ptr`: the length of its JSON answer in `ts_buf()`, or minus the
/// length of why not.
///
/// # Safety
/// `ptr` and `len` as for `take`.
unsafe fn names_op(op: &str, ptr: *mut u8, len: usize) -> i32 {
    // SAFETY: the caller passes a buffer from ts_alloc(len).
    let input = unsafe { take(ptr, len) };
    match room::names::agent::call(op, &input, &room::names::Params::BUILT) {
        Ok(v) => set_buf(v.to_string().into_bytes()) as i32,
        Err(e) => -(set_buf(e.into_bytes()) as i32),
    }
}

macro_rules! names_ops {
    ($($export:ident => $op:literal),* $(,)?) => {$(
        /// The names agent's operation of this name (room/names/agent.rs).
        ///
        /// # Safety
        /// `ptr` and `len` as for `take`.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $export(ptr: *mut u8, len: usize) -> i32 {
            // SAFETY: the host passes a buffer from ts_alloc(len).
            unsafe { names_op($op, ptr, len) }
        }
    )*};
}

names_ops! {
    ts_names_key => "key",
    ts_names_make => "make",
    ts_names_mine => "mine",
    ts_names_sign => "sign",
    ts_names_add => "add",
    ts_names_pending => "pending",
    ts_names_commitment => "commitment",
    ts_names_finish => "finish",
    ts_names_anchor => "anchor",
    ts_names_zone => "zone",
    ts_names_status => "status",
    ts_names_judge => "judge",
    ts_names_drop => "drop",
}

fn with_room(h: u32, f: impl FnOnce(&mut room::Client, Instant)) {
    with(h, |c| {
        if let Any::Room(r) = c {
            f(r, Instant::now())
        }
    });
}

/// A room's WebRTC connection `rtc`: the page's local description or candidate (JSON).
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_rtc_signal(h: u32, rtc: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    with_room(h, |r, now| r.rtc_signal(rtc, &data, now));
}

/// Connection `rtc`'s data channel opened.
#[unsafe(no_mangle)]
pub extern "C" fn ts_rtc_open(h: u32, rtc: u32) {
    with_room(h, |r, now| r.rtc_open(rtc, now));
}

/// A message on connection `rtc`'s data channel.
///
/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_rtc_message(h: u32, rtc: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let data = unsafe { take(ptr, len) };
    with_room(h, |r, now| r.rtc_message(rtc, &data, now));
}

/// Connection `rtc` closed or failed.
#[unsafe(no_mangle)]
pub extern "C" fn ts_rtc_closed(h: u32, rtc: u32) {
    with_room(h, |r, now| r.rtc_closed(rtc, now));
}

/// Whether this browser makes no direct paths now (1) or does again (0): `room::Client::rtc_blocked`.
#[unsafe(no_mangle)]
pub extern "C" fn ts_rtc_blocked(h: u32, blocked: u32) {
    with_room(h, |r, now| r.rtc_blocked(blocked != 0, now));
}
