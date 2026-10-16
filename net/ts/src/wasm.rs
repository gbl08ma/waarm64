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

use std::{cell::RefCell, time::Instant};

use serde::Deserialize;

use crate::client::{Action, Client, Config, DEFAULT_DERP_MAP, GUEST4};

thread_local! {
    static CLIENTS: RefCell<Vec<Option<Client>>> = const { RefCell::new(Vec::new()) };
    static BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The configuration `ts_new` takes, as JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsConfig {
    addr: String,
    #[serde(rename = "derpMapURL")]
    derp_map_url: Option<String>,
    /// The node's private key, 64 hex digits; a fresh one when absent.
    key: Option<String>,
    #[serde(default)]
    dns4: Vec<[u8; 4]>,
    #[serde(default)]
    dns6: Vec<[u8; 16]>,
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

fn with<R>(h: u32, f: impl FnOnce(&mut Client) -> R) -> Option<R> {
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
        .and_then(|c| {
            let key = c.key.as_deref().map(unhex32).transpose()?;
            let cfg = Config {
                addr: c.addr,
                derp_map_url: c.derp_map_url.unwrap_or_else(|| DEFAULT_DERP_MAP.into()),
                key,
                guest4: GUEST4,
                dns4: c.dns4,
                dns6: c.dns6,
            };
            Client::new(cfg, Instant::now())
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
    with(h, |c| set_buf(c.private_key().to_vec())).unwrap_or(0)
}

/// The next action's length in `ts_buf()`, 0 when there's none.
#[unsafe(no_mangle)]
pub extern "C" fn ts_poll(h: u32) -> u32 {
    let Some(Some(a)) = with(h, |c| c.poll()) else {
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
    with(h, |c| c.ws_message(conn, &data, Instant::now()));
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_ws_closed(h: u32, conn: u32) {
    with(h, |c| c.ws_closed(conn, Instant::now()));
}

/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_fetched(h: u32, id: u32, ok: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let body = unsafe { take(ptr, len) };
    with(h, |c| c.fetched(id, ok != 0, &body, Instant::now()));
}

/// # Safety
/// `ptr` and `len` as for `take`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ts_guest(h: u32, ptr: *mut u8, len: usize) {
    // SAFETY: the host passes a buffer from ts_alloc(len).
    let p = unsafe { take(ptr, len) };
    with(h, |c| c.guest_packet(&p, Instant::now()));
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_tick(h: u32) {
    with(h, |c| c.tick(Instant::now()));
}

/// Milliseconds until `ts_tick` must run, or -1 for never.
#[unsafe(no_mangle)]
pub extern "C" fn ts_deadline(h: u32) -> f64 {
    let now = Instant::now();
    with(h, |c| c.deadline()).flatten().map_or(-1.0, |t| {
        t.saturating_duration_since(now).as_secs_f64() * 1000.0
    })
}

/// Closes the client (its WebSocket close actions are still to poll) and frees it after.
#[unsafe(no_mangle)]
pub extern "C" fn ts_close(h: u32) {
    with(h, |c| c.close());
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
