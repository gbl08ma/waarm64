//! The names agent's operations (names.md "The names agent"): what the page's agent (web/names.ts) asks of the
//! module to make and keep a title, as pure functions over a title's item (wire.rs `Item`: every entry of the title,
//! each with its anchor (and its block's header) or a pending one, and the zone). No state: the page keeps the title and the
//! owners' secret. The wasm exports (`ts_names_*`, wasm.rs) take and give JSON through [`call`], bytes in hex.
//!
//! - `key`: a name's owner key and id from the owners' secret.
//! - `make`, `mine`, `sign`: an entry made, its proof of work (in slices of tries, so a worker stays responsive), its
//!   signature.
//! - `add`: an entry checked (form, room, signature, proof of work) and added to the title.
//! - `pending`: a calendar's receipt made a pending anchor, signed by the owner key (servers keep only signed ones) and
//!   offered to the title's entry; `commitment` and `finish`: what to ask the calendar for, and the anchors its finished
//!   proof gives; `anchor`: one checked with its block's header and taken.
//! - `zone`: a zone sealed and signed, put on the title.
//! - `status`: the title's entries, its chains and the owner now, for the agent's decisions.
//! - `judge`: what a server showed (a `better` answer to a put), checked whole, against the title: the title's own
//!   chain (`ours`), another branch of it (`branch`: taken into the title), or a better chain of another key's
//!   (`lost`).
//! - `drop`: entries taken out of the title (one that can no longer link).

use std::{cell::RefCell, collections::BTreeSet};

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Invalid, Params,
    anchor::{Anchor, Calendar, Pending},
    chain::{Chain, Name, order},
    entry::{Entry, Kind, Pow, Stamped, sign_pending},
    header::Header,
    id::{RoomNames, acceptable, owner_key},
    wire::{Item, WireEntry},
    zone::Zone,
};

thread_local! {
    /// The proof of work's memory (1 MiB in production), kept between calls.
    static POW: RefCell<Option<(Params, Pow)>> = const { RefCell::new(None) };
}

fn with_pow<R>(params: &Params, f: impl FnOnce(&mut Pow) -> R) -> R {
    POW.with_borrow_mut(|p| {
        if p.as_ref().is_none_or(|(q, _)| q != params) {
            *p = Some((params.clone(), Pow::new(params)));
        }
        f(&mut p.as_mut().unwrap().1)
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("hex".into());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| "hex".to_string()))
        .collect()
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    unhex(s)?.try_into().map_err(|_| "a 32-byte value".into())
}

fn code(e: Invalid) -> String {
    format!("{e:?}")
}

/// The owners' secret's key for `name` in the room: the signing key, its public key and the name's id.
pub fn key(
    room: &str,
    secret: &[u8; 32],
    name: &str,
) -> Result<(k256::schnorr::SigningKey, [u8; 32]), String> {
    if !acceptable(name) {
        return Err("Name".into());
    }
    let names = RoomNames::derive(room);
    Ok((owner_key(secret, &names, name), names.name_id(name)))
}

fn kind_of(s: &str) -> Result<Kind, String> {
    match s {
        "claim" => Ok(Kind::Claim),
        "renew" => Ok(Kind::Renew),
        "release" => Ok(Kind::Release),
        _ => Err("a kind: claim, renew or release".into()),
    }
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Claim => "claim",
        Kind::Renew => "renew",
        Kind::Release => "release",
    }
}

/// A title's item as entries (each as stored: the agent checked it when it took it).
fn name_of(item: &Item) -> Name {
    let mut n = Name::new(item.id);
    for w in &item.entries {
        n.insert(w.clone().trusted());
    }
    n
}

fn item_of(name: &Name, zone: Option<Zone>) -> Item {
    Item {
        id: name.id,
        entries: name.entries().map(WireEntry::of).collect(),
        zone,
    }
}

fn read_item(s: &str) -> Result<Item, String> {
    Item::decode(&unhex(s)?).map_err(code)
}

fn chain_json(c: &Chain) -> Value {
    json!({
        "ids": c.ids.iter().map(|i| hex(i)).collect::<Vec<_>>(),
        "owner": hex(&c.owner),
        "seniority": c.seniority,
        "resolveEnd": c.resolve_end,
        "coverEnd": c.cover_end,
        "released": c.released,
    })
}

/// An anchor's block's header from the hex the agent fetched.
fn header_of(h: &str) -> Result<Header, String> {
    Header::from_bytes(&unhex(h)?).ok_or_else(|| code(Invalid::Encoding))
}

#[derive(Deserialize)]
struct In {
    #[serde(default)]
    room: String,
    secret: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    prev: Option<String>,
    entry: Option<String>,
    tries: Option<u64>,
    item: Option<String>,
    other: Option<String>,
    id: Option<String>,
    calendar: Option<u8>,
    receipt: Option<String>,
    pending: Option<String>,
    proof: Option<String>,
    anchor: Option<String>,
    header: Option<String>,
    /// A zone's `seq`, in decimal: it is 64 bits, past what a JavaScript number holds.
    seq: Option<String>,
    #[serde(default)]
    points: Vec<Point>,
    #[serde(default)]
    wide: bool,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    now: u64,
}

#[derive(Deserialize)]
struct Point {
    label: Option<String>,
    key: String,
}

fn need<'a, T>(v: &'a Option<T>, what: &str) -> Result<&'a T, String> {
    v.as_ref().ok_or_else(|| format!("no {what}"))
}

impl In {
    fn secret(&self) -> Result<[u8; 32], String> {
        unhex32(need(&self.secret, "secret")?)
    }

    fn name(&self) -> Result<&str, String> {
        need(&self.name, "name").map(String::as_str)
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::decode(&unhex(need(&self.entry, "entry")?)?).map_err(code)
    }

    fn item(&self) -> Result<Item, String> {
        read_item(need(&self.item, "item")?)
    }

    fn id(&self) -> Result<[u8; 32], String> {
        unhex32(need(&self.id, "id")?)
    }
}

/// One of the agent's operations: `op` with its JSON input, on `params` (the module's: `Params::BUILT`). Its JSON
/// output, or why not (an `Invalid`'s name where a record failed a check).
pub fn call(op: &str, input: &[u8], params: &Params) -> Result<Value, String> {
    let i: In = serde_json::from_slice(input).map_err(|e| format!("the input: {e}"))?;
    let names = RoomNames::derive(&i.room);
    match op {
        "key" => {
            let (k, id) = key(&i.room, &i.secret()?, i.name()?)?;
            Ok(json!({
                "key": hex(&k.to_bytes()),
                "owner": hex(&k.verifying_key().to_bytes()),
                "id": hex(&id),
            }))
        }
        "make" => {
            let (k, id) = key(&i.room, &i.secret()?, i.name()?)?;
            let kind = kind_of(need(&i.kind, "kind")?)?;
            let prev = match &i.prev {
                Some(p) => unhex32(p)?,
                None => [0; 32],
            };
            let owner: [u8; 32] = k.verifying_key().to_bytes().into();
            let mut e = Entry::new(&names, kind, id, owner, prev);
            let mut n = [0u8; 8];
            let _ = getrandom::fill(&mut n);
            e.nonce = u64::from_le_bytes(n);
            Ok(json!({ "entry": hex(&e.encode()) }))
        }
        "mine" => {
            let mut e = i.entry()?;
            let done = with_pow(params, |p| p.mine(&mut e, i.tries.unwrap_or(1).max(1)));
            Ok(json!({ "entry": hex(&e.encode()), "done": done }))
        }
        "sign" => {
            let (k, id) = key(&i.room, &i.secret()?, i.name()?)?;
            let mut e = i.entry()?;
            if e.name != id || e.owner != <[u8; 32]>::from(k.verifying_key().to_bytes()) {
                return Err(code(Invalid::Name));
            }
            e.sign(&k, &names);
            Ok(json!({ "entry": hex(&e.encode()), "id": hex(&e.id()) }))
        }
        "add" => {
            // Checking an entry: everything but its anchor, as a server would.
            let e = i.entry()?;
            let s = with_pow(params, |p| Stamped::check(e, &names, p)).map_err(code)?;
            let item = match &i.item {
                Some(h) => read_item(h)?,
                None => Item {
                    id: s.entry.name,
                    ..Default::default()
                },
            };
            if s.entry.name != item.id {
                return Err(code(Invalid::Name));
            }
            let id = s.id();
            let mut n = name_of(&item);
            n.insert(s);
            Ok(json!({ "item": hex(&item_of(&n, item.zone).encode()), "id": hex(&id) }))
        }
        "pending" => {
            let (k, _) = key(&i.room, &i.secret()?, i.name()?)?;
            let item = i.item()?;
            let id = i.id()?;
            let cal = *Calendar::ALL
                .get(*need(&i.calendar, "calendar")? as usize)
                .ok_or("a calendar's index")?;
            let mut p = Pending::from_receipt(cal, &unhex(need(&i.receipt, "receipt")?)?, &id)
                .map_err(code)?;
            sign_pending(&k, &names, &id, &mut p);
            let mut n = name_of(&item);
            let s = n.get_mut(&id).ok_or("no such entry")?;
            s.offer_pending(p.clone());
            Ok(
                json!({ "item": hex(&item_of(&n, item.zone).encode()), "pending": hex(&p.encode()) }),
            )
        }
        "commitment" => {
            let p = Pending::decode(&unhex(need(&i.pending, "pending")?)?).map_err(code)?;
            let c = p
                .commitment(&i.id()?)
                .ok_or_else(|| code(Invalid::AnchorFormat))?;
            Ok(json!({ "commitment": hex(&c), "calendar": p.calendar as u8 }))
        }
        "finish" => {
            let p = Pending::decode(&unhex(need(&i.pending, "pending")?)?).map_err(code)?;
            let id = i.id()?;
            let anchors = p
                .finish(&id, &unhex(need(&i.proof, "proof")?)?)
                .map_err(code)?;
            let out: Vec<Value> = anchors
                .iter()
                .filter_map(|a| {
                    // The Merkle root as a header carries it (bytes 36..68).
                    let root = a.root(&id)?;
                    Some(json!({ "anchor": hex(&a.encode()), "height": a.height, "root": hex(&root) }))
                })
                .collect();
            Ok(json!({ "anchors": out }))
        }
        "anchor" => {
            let item = i.item()?;
            let id = i.id()?;
            let a = Anchor::decode(&unhex(need(&i.anchor, "anchor")?)?).map_err(code)?;
            let h = header_of(need(&i.header, "header")?)?;
            let mut n = name_of(&item);
            let s = n.get_mut(&id).ok_or("no such entry")?;
            s.offer_anchor(a, h, params, i.now).map_err(code)?;
            let time = s.time();
            Ok(json!({ "item": hex(&item_of(&n, item.zone).encode()), "time": time }))
        }
        "zone" => {
            let (k, _) = key(&i.room, &i.secret()?, i.name()?)?;
            let points = i
                .points
                .iter()
                .map(|p| Ok((p.label.as_deref(), unhex32(&p.key)?)))
                .collect::<Result<Vec<_>, String>>()?;
            let z = Zone::seal(
                &names,
                &k,
                i.name()?,
                need(&i.seq, "seq")?
                    .parse::<u64>()
                    .map_err(|_| "seq".to_string())?,
                &points,
                i.wide,
            )
            .map_err(code)?;
            let item = match &i.item {
                Some(h) => {
                    let mut it = read_item(h)?;
                    it.zone = Some(z.clone());
                    Some(hex(&it.encode()))
                }
                None => None,
            };
            Ok(json!({ "zone": hex(&z.encode()), "item": item }))
        }
        "status" => {
            let item = i.item()?;
            Ok(status(&item, params, i.now))
        }
        "judge" => {
            let item = i.item()?;
            let other = read_item(need(&i.other, "other")?)?;
            judge(&names, &item, &other, params, i.now)
        }
        "drop" => {
            let item = i.item()?;
            let ids: BTreeSet<[u8; 32]> =
                i.ids.iter().map(|s| unhex32(s)).collect::<Result<_, _>>()?;
            let mut n = name_of(&item);
            n.retain(|id, _| !ids.contains(id));
            Ok(json!({ "item": hex(&item_of(&n, item.zone).encode()) }))
        }
        _ => Err(format!("no operation {op}")),
    }
}

/// The title as the agent decides by it: each entry (its kind, its time, until when it can link, whether it no longer
/// can), the chain that owns the name now among the title's own, the best chain of them whether or not it covers now,
/// and the zone's `seq`.
pub fn status(item: &Item, params: &Params, now: u64) -> Value {
    let n = name_of(item);
    let entries: Vec<Value> = n
        .entries()
        .map(|s| {
            json!({
                "id": hex(&s.id()),
                "kind": kind_name(s.entry.kind),
                "prev": hex(&s.entry.prev),
                "owner": hex(&s.entry.owner),
                "time": s.time(),
                // Until when an anchor can make it link: the entry before's `t + TERM + GRACE` (none for a claim).
                "linkEnd": n.link_end(s, params),
                // Unanchored and past that: it can never count.
                "stale": s.time().is_none() && n.stale(s, params, now),
                "pending": s.pending().is_some(),
            })
        })
        .collect();
    let chains = n.chains(params);
    let owner = chains
        .iter()
        .filter(|c| c.covers(now))
        .min_by(|a, b| order(a, b));
    let best = chains.iter().min_by(|a, b| order(a, b));
    json!({
        "id": hex(&item.id),
        "entries": entries,
        "owner": owner.map(chain_json),
        "best": best.map(chain_json),
        "zone": item.zone.as_ref().map(|z| json!({ "seq": z.seq.to_string(), "owner": hex(&z.owner) })),
        "term": params.term,
        "grace": params.grace,
        "drift": params.drift,
    })
}

/// What a server showed for the title's name, checked whole (each entry the title doesn't hold as shown: signature,
/// proof of work, anchor), against the title. `ours`: the owner now is the title's own chain as held;
/// `branch`: another branch of the title's own key owns it (a title forked between two browsers): its entries are
/// taken into the title, as is a newer zone of the title's key; `lost`: another key's chain owns it; `none`: no chain
/// covers now. A forged answer is an error (the server lies: nothing is taken).
pub fn judge(
    names: &RoomNames,
    title: &Item,
    other: &Item,
    params: &Params,
    now: u64,
) -> Result<Value, String> {
    if other.id != title.id && !other.entries.is_empty() {
        return Err(code(Invalid::Name));
    }
    let mine = name_of(title);
    // The claim's key (any entry of the title is its key's, but the claim says so: review 2).
    let owner_key = (title.entries.iter())
        .find(|w| w.entry.kind == Kind::Claim)
        .or(title.entries.first())
        .map(|w| w.entry.owner)
        .ok_or("an empty title")?;
    let mut all = mine.clone();
    let mut shown = Vec::new();
    for w in &other.entries {
        if w.entry.name != title.id {
            return Err(code(Invalid::Name));
        }
        let held = mine.get(&w.entry.id());
        let s = match held {
            Some(h)
                if w.anchor.as_ref().is_none_or(|(a, r)| {
                    h.anchor().is_some_and(|b| b.anchor == *a && b.header == *r)
                }) =>
            {
                h.clone()
            }
            _ => {
                let mut s = with_pow(params, |p| Stamped::check(w.entry.clone(), names, p))
                    .map_err(code)?;
                if let Some((a, r)) = w.anchor.clone() {
                    s.offer_anchor(a, r, params, now).map_err(code)?;
                }
                s
            }
        };
        shown.push(s.clone());
        all.insert(s);
    }
    if let Some(z) = &other.zone
        && (z.name != title.id || !z.verify(names))
    {
        return Err(code(Invalid::Zone));
    }
    let held_pending = shown.iter().any(|s| s.pending().is_some());
    let Some(o) = all.owner(params, now) else {
        return Ok(
            json!({ "verdict": "none", "item": hex(&title.encode()), "pending": held_pending }),
        );
    };
    if o.owner != owner_key {
        // The winning chain's first block, as an explorer names it, and its header: the agent checks it at an explorer
        // before it calls the title lost (review 3, finding 5: a forged header a server would refuse, shown by liars).
        let first = all.get(&o.first()).and_then(Stamped::anchor);
        return Ok(json!({
            "verdict": "lost", "item": hex(&title.encode()), "by": hex(&o.owner), "owner": chain_json(&o),
            "pending": held_pending,
            "block": first.map(|a| { let mut h = a.header.hash(); h.reverse(); hex(&h) }),
            "header": first.map(|a| hex(&a.header.0)),
        }));
    }
    let have: BTreeSet<[u8; 32]> = mine.entries().map(Stamped::id).collect();
    let branch = o.ids.iter().any(|id| !have.contains(id));
    let mut merged = mine;
    for s in shown.into_iter().filter(|s| s.entry.owner == owner_key) {
        merged.insert(s);
    }
    let mut zone = title.zone.clone();
    if let Some(z) = &other.zone
        && z.owner == owner_key
        && zone.as_ref().is_none_or(|t| z.beats(t))
    {
        zone = Some(z.clone());
    }
    let item = item_of(&merged, zone);
    Ok(json!({
        "verdict": if branch { "branch" } else { "ours" },
        "item": hex(&item.encode()),
        "owner": chain_json(&o),
        "pending": held_pending,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::names::testkit::{Bitcoin, DAY, params};

    const ROOM: &str = "agent room";

    fn run(op: &str, v: Value) -> Result<Value, String> {
        call(op, v.to_string().as_bytes(), &params())
    }

    fn ok(op: &str, v: Value) -> Value {
        run(op, v).unwrap_or_else(|e| panic!("{op}: {e}"))
    }

    fn s(v: &Value, k: &str) -> String {
        v[k].as_str()
            .unwrap_or_else(|| panic!("no {k} in {v}"))
            .to_string()
    }

    /// An entry made, mined and signed through the operations, added to title `item` (a new one when None).
    fn make(
        secret: &str,
        name: &str,
        kind: &str,
        prev: Option<&str>,
        item: Option<&str>,
        now: u64,
    ) -> (String, String) {
        let m = ok(
            "make",
            json!({ "room": ROOM, "secret": secret, "name": name, "kind": kind, "prev": prev }),
        );
        let mut e = s(&m, "entry");
        loop {
            let x = ok("mine", json!({ "entry": e, "tries": 3 }));
            e = s(&x, "entry");
            if x["done"] == true {
                break;
            }
        }
        // Unsigned: refused.
        assert_eq!(
            run(
                "add",
                json!({ "room": ROOM, "entry": e, "item": item, "now": now })
            ),
            Err("Signature".into())
        );
        let e = s(
            &ok(
                "sign",
                json!({ "room": ROOM, "secret": secret, "name": name, "entry": e }),
            ),
            "entry",
        );
        let a = ok(
            "add",
            json!({ "room": ROOM, "entry": e, "item": item, "now": now }),
        );
        (s(&a, "item"), s(&a, "id"))
    }

    /// A claim made through the operations, on a new title.
    fn claim(secret: &str, name: &str, now: u64) -> (String, String) {
        make(secret, name, "claim", None, None, now)
    }

    /// An anchor for entry `id` in a pretend block at `time`, as the agent would collect it: the anchor's hex and its
    /// block's header.
    fn anchor_for(b: &mut Bitcoin, id: &str, time: u32) -> (String, String) {
        let (a, h) = b.anchor(&unhex32(id).unwrap(), time);
        (hex(&a.encode()), hex(&h.0))
    }

    #[test]
    fn a_title_is_made_through_the_operations_and_anchored() {
        let mut b = Bitcoin::new(ROOM, 1);
        let secret = "11".repeat(32);
        let now = 1_800_000_000u64;
        let (item, id) = claim(&secret, "test123", now);
        let st = ok("status", json!({ "item": item, "now": now }));
        assert_eq!(st["owner"], Value::Null, "not anchored: no chain");
        // A claim can always link: never stale, however long it waits.
        assert_eq!(st["entries"][0]["stale"], false);
        assert_eq!(st["entries"][0]["linkEnd"], Value::Null);
        let late = now + 400 * DAY as u64;
        assert_eq!(
            ok("status", json!({ "item": item, "now": late }))["entries"][0]["stale"],
            false
        );
        // An anchor any time after it was made is taken (no window); a header from the future, or none, isn't.
        let (a, h) = anchor_for(&mut b, &id, now as u32 + 3 * DAY);
        assert_eq!(
            run(
                "anchor",
                json!({ "item": item, "id": id, "anchor": a, "header": h, "now": now })
            ),
            Err("HeaderFuture".into())
        );
        assert_eq!(
            run(
                "anchor",
                json!({ "item": item, "id": id, "anchor": a, "now": now + 3 * DAY as u64 })
            ),
            Err("no header".into())
        );
        let x = ok(
            "anchor",
            json!({ "item": item, "id": id, "anchor": a, "header": h, "now": now + 3 * DAY as u64 }),
        );
        assert_eq!(x["time"], now + 3 * DAY as u64);
        let (a, h) = anchor_for(&mut b, &id, now as u32);
        let x = ok(
            "anchor",
            json!({ "item": s(&x, "item"), "id": id, "anchor": a, "header": h, "now": now + 3600 }),
        );
        assert_eq!(x["time"], now, "the earlier anchor");
        let item = s(&x, "item");
        let st = ok("status", json!({ "item": item, "now": now + 3600 }));
        assert_eq!(st["owner"]["ids"][0], id.as_str());
        assert_eq!(st["owner"]["seniority"], now);
        // A renewal links until the claim's `t + TERM + GRACE`: stale past it.
        let p = params();
        let (item, rid) = make(&secret, "test123", "renew", Some(&id), Some(&item), now);
        let end = now + p.term as u64 + p.grace as u64;
        let st = ok("status", json!({ "item": item, "now": end }));
        let r = (st["entries"].as_array().unwrap().iter())
            .find(|e| e["id"] == rid.as_str())
            .unwrap();
        assert_eq!(r["linkEnd"], end);
        assert_eq!(r["stale"], false);
        let st = ok("status", json!({ "item": item, "now": end + 1 }));
        let r = (st["entries"].as_array().unwrap().iter())
            .find(|e| e["id"] == rid.as_str())
            .unwrap();
        assert_eq!(r["stale"], true);
        // The key: the owner key's public half is the entry's.
        let k = ok(
            "key",
            json!({ "room": ROOM, "secret": secret, "name": "test123" }),
        );
        assert_eq!(st["owner"], Value::Null, "past the cover");
        assert_eq!(st["best"]["owner"], k["owner"]);
        assert_eq!(
            run(
                "key",
                json!({ "room": ROOM, "secret": secret, "name": "wpad" })
            ),
            Err("Name".into())
        );
    }

    #[test]
    fn a_pending_anchor_is_signed_by_the_owner_key() {
        use crate::room::names::{
            anchor::{Op, leaves},
            entry::pending_ok,
        };
        let secret = "22".repeat(32);
        let now = 1_800_000_000u64;
        let (item, id) = claim(&secret, "mine", now);
        // A receipt as a calendar gives it: append, SHA-256, then a pending attestation.
        let mut receipt = vec![0xf0, 16];
        receipt.extend([9u8; 16]);
        receipt.push(0x08);
        receipt.extend([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
        let uri = b"https://alice.btc.calendar.opentimestamps.org";
        receipt.push((uri.len() + 1) as u8);
        receipt.push(uri.len() as u8);
        receipt.extend(uri);
        assert!(leaves(&receipt, &unhex32(&id).unwrap()).is_ok());
        let p = ok(
            "pending",
            json!({ "room": ROOM, "secret": secret, "name": "mine", "item": item, "id": id, "calendar": 0, "receipt": hex(&receipt), "now": now }),
        );
        let pending = Pending::decode(&unhex(&s(&p, "pending")).unwrap()).unwrap();
        assert_eq!(pending.ops[0], Op::Append(vec![9; 16]));
        let names = RoomNames::derive(ROOM);
        let k = ok(
            "key",
            json!({ "room": ROOM, "secret": secret, "name": "mine" }),
        );
        let owner = unhex32(&s(&k, "owner")).unwrap();
        assert!(
            pending_ok(&names, &owner, &unhex32(&id).unwrap(), &pending),
            "signed by the owner key"
        );
        let st = ok("status", json!({ "item": s(&p, "item"), "now": now }));
        assert_eq!(st["entries"][0]["pending"], true, "on the title's entry");
        let c = ok(
            "commitment",
            json!({ "pending": s(&p, "pending"), "id": id }),
        );
        assert_eq!(c["calendar"], 0);
        assert_eq!(s(&c, "commitment").len(), 64);
    }

    /// Two titles of one name, as two browsers that hold the same title make them, and another owner's.
    #[test]
    fn a_server_shows_the_titles_own_chain_another_branch_of_it_or_a_better_chain() {
        let mut b = Bitcoin::new(ROOM, 3);
        let now = 1_800_000_000u32;
        let key = b.key(5, "shared");
        let claim = b.at(Kind::Claim, &key, "shared", [0; 32], now - 20 * DAY);
        let r1 = b.at(Kind::Renew, &key, "shared", claim.id(), now - 4 * DAY);
        let r2 = b.at(Kind::Renew, &key, "shared", claim.id(), now - 4 * DAY + 600);
        let mine = b.item("shared", &[claim.clone(), r1.clone()], None);
        let theirs = b.item("shared", &[claim.clone(), r2.clone()], None);
        let names = b.names.clone();
        let p = params();
        let t = now as u64;
        // The same chain: ours.
        let v = judge(&names, &mine, &mine, &p, t).unwrap();
        assert_eq!(v["verdict"], "ours");
        // The other branch (the room settled on it): taken into the title.
        let v = judge(&names, &mine, &theirs, &p, t).unwrap();
        let winner = if v["verdict"] == "branch" {
            r2.id()
        } else {
            r1.id()
        };
        let merged = read_item(v["item"].as_str().unwrap()).unwrap();
        let st = status(&merged, &p, t);
        assert_eq!(st["owner"]["ids"][1], hex(&winner));
        assert_eq!(merged.entries.len(), 3, "both branches held");
        // A chain of another key's, claimed earlier: lost.
        let other = b.key(6, "shared");
        let oc = b.at(Kind::Claim, &other, "shared", [0; 32], now - 25 * DAY);
        let or = b.at(Kind::Renew, &other, "shared", oc.id(), now - 5 * DAY);
        let better = b.item("shared", &[oc, or], None);
        let v = judge(&names, &mine, &better, &p, t).unwrap();
        assert_eq!(v["verdict"], "lost");
        assert_eq!(
            read_item(v["item"].as_str().unwrap()).unwrap(),
            mine,
            "nothing of theirs taken"
        );
        // A forged one (a signature broken): an error, nothing taken.
        let mut forged = better.clone();
        forged.entries[1].entry.sig[0] ^= 1;
        assert_eq!(
            judge(&names, &mine, &forged, &p, t),
            Err("Signature".into())
        );
        // One that came later: ours still.
        let late = b.at(Kind::Claim, &other, "shared", [0; 32], now - 2 * DAY);
        let v = judge(&names, &mine, &b.item("shared", &[late], None), &p, t).unwrap();
        assert_eq!(v["verdict"], "ours");
    }

    #[test]
    fn a_zone_is_sealed_with_its_seq_and_put_on_the_title() {
        let secret = "44".repeat(32);
        let now = 1_800_000_000u64;
        let (item, _) = claim(&secret, "zoned", now);
        let node = "ab".repeat(32);
        let z = ok(
            "zone",
            json!({ "room": ROOM, "secret": secret, "name": "zoned", "seq": 0x1234_5678_9abc_def0u64.to_string(), "item": item,
                    "points": [{ "label": null, "key": node }, { "label": "git", "key": node }] }),
        );
        let it = read_item(z["item"].as_str().unwrap()).unwrap();
        let zone = it.zone.clone().unwrap();
        assert_eq!(zone.seq, 0x1234_5678_9abc_def0);
        let names = RoomNames::derive(ROOM);
        assert!(zone.verify(&names));
        assert_eq!(
            zone.open(&names, "git.zoned"),
            Some(unhex32(&node).unwrap())
        );
        // Entries dropped by id.
        let st = status(&it, &params(), now);
        let id = st["entries"][0]["id"].as_str().unwrap().to_string();
        let d = ok("drop", json!({ "item": hex(&it.encode()), "ids": [id] }));
        assert!(
            read_item(d["item"].as_str().unwrap())
                .unwrap()
                .entries
                .is_empty()
        );
    }
}
