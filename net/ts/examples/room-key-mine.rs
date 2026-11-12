//! Mines a room connection's node key for an address (docs/networking/rooms.md): a member's address is the room's
//! /48 and the first 80 bits of its WireGuard public key (`room::Room::addr`), so keys are tried until the address
//! has the chosen hex digits at its start (`--prefix`) or its end (`--suffix`), or matches a regular expression
//! (`--regex`, on the address written out whole: 8 groups of 4 digits; `--compressed`: as the page writes it, the
//! longest run of zero groups as `::`). All given must hold. The key goes into the wizard's "A key to paste" (Create
//! a room or Join a room, Advanced): for a member others type the address of, such as a directory service.
//!
//! Each thread draws one random clamped scalar `s`, computes `s·B` once, then steps by `8·B` (a point addition: the
//! key `s + 8i`; 8, as clamping clears the low three bits) and converts a batch of points at a time to X25519's
//! Montgomery form with one field inversion between them. A match is derived again the ordinary way (X25519 of the
//! key) before it's printed. Each hex digit chosen costs 16 times the keys. The progress lines (every 10 s, the first
//! after 2 s) give the rate and the average time to a match: 16 to the digits fixed, times the odds against the
//! regular expression, which a sample of random addresses estimates (the 80 bits are uniform). Every key is a fresh
//! try, so the time to the next match is that average whenever it's asked.
//!
//! Usage: cargo run --release -p webpc_ts --example room-key-mine -- <room link or public room's name>
//!          [--prefix HEX] [--suffix HEX] [--regex RE [--compressed]] [--count N] [--threads N]
//! HEX: digits of the 80 bits after the room's /48 (the room's own 12 may lead a prefix), groups of 4 written whole
//! (`cafe:0000:12` is a prefix, `1:0053` a suffix). The key printed is a secret: whoever has it can be that member.

use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::edwards::EdwardsPoint;
use curve25519_dalek::montgomery::MontgomeryPoint;
use curve25519_dalek::scalar::Scalar;
use regex::Regex;
use std::net::Ipv6Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use webpc_ts::room::Room;
use webpc_ts::room::link::Link;

/// Points converted to Montgomery form at once (one inversion between them).
const BATCH: usize = 512;
/// Steps from one random scalar before drawing another (far from the clamp's bit 254 changing).
const STEPS: u64 = 1 << 32;

/// The 80 bits after the room's /48 (the public key's first 10 bytes) that must be `value` under `mask`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Nibbles {
    mask: u128,
    value: u128,
}

impl Nibbles {
    fn hit(&self, bits: u128) -> bool {
        bits & self.mask == self.value
    }
    /// How many hex digits are fixed.
    fn digits(&self) -> u32 {
        self.mask.count_ones() / 4
    }
}

/// The 80 bits as a number: the public key's first 10 bytes, big-endian (the address's order).
fn bits80(public: &[u8; 32]) -> u128 {
    public[..10].iter().fold(0u128, |a, &b| a << 8 | b as u128)
}

/// `--prefix`/`--suffix`'s digits in the address's order: bare digits, or groups split by colons, each of 4 written
/// whole but the open end's (a prefix's last, a suffix's first); a prefix may start with the room's own 12 digits,
/// which are dropped.
fn digits_of(s: &str, room: &[u8; 6], suffix: bool) -> Result<Vec<u8>, String> {
    let groups: Vec<&str> = s.split(':').collect();
    for (i, g) in groups.iter().enumerate() {
        let open = groups.len() == 1
            || if suffix {
                i == 0
            } else {
                i == groups.len() - 1
            };
        if g.is_empty() || (groups.len() > 1 && g.len() > 4) || (!open && g.len() != 4) {
            return Err(format!(
                "{s}: write groups of 4 digits whole (only the open end's may be shorter, no ::)"
            ));
        }
    }
    let mut d = Vec::new();
    for c in groups.concat().chars() {
        d.push(c.to_digit(16).ok_or_else(|| format!("{s}: not hex"))? as u8);
    }
    let own: Vec<u8> = room.iter().flat_map(|b| [b >> 4, b & 15]).collect();
    if !suffix && d.len() > 20 && d.starts_with(&own) {
        d.drain(..12);
    }
    if d.len() > 20 {
        return Err(format!(
            "{s}: the address has 20 digits after the room's /48"
        ));
    }
    Ok(d)
}

/// The mask and value of `digits` at the start (or end) of the 80 bits.
fn nibbles(digits: &[u8], suffix: bool) -> Nibbles {
    let mut n = Nibbles::default();
    for (i, &d) in digits.iter().enumerate() {
        let at = if suffix { 20 - digits.len() + i } else { i }; // nibble index from the left
        let shift = 4 * (19 - at);
        n.mask |= 0xf << shift;
        n.value |= (d as u128) << shift;
    }
    n
}

fn both(a: Nibbles, b: Nibbles) -> Result<Nibbles, String> {
    if (a.value ^ b.value) & a.mask & b.mask != 0 {
        return Err("the prefix and the suffix overlap and disagree".into());
    }
    Ok(Nibbles {
        mask: a.mask | b.mask,
        value: a.value | b.value,
    })
}

/// The address written out whole: 8 groups of 4 hex digits.
fn expanded(a: &[u8; 16]) -> String {
    let g: Vec<String> = a
        .chunks(2)
        .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
        .collect();
    g.join(":")
}

/// The key's scalar `s + 8·k`, little-endian, if it stays clamped (it does, short of a carry into bit 254).
fn stepped(s: &[u8; 32], k: u64) -> Option<[u8; 32]> {
    let mut out = *s;
    let mut carry = (k as u128) << 3;
    for b in out.iter_mut() {
        let x = *b as u128 + (carry & 0xff);
        *b = x as u8;
        carry = (carry >> 8) + (x >> 8);
    }
    (carry == 0 && out[31] & 0xc0 == 0x40 && out[0] & 7 == 0).then_some(out)
}

fn clamped_random() -> [u8; 32] {
    let mut s = [0u8; 32];
    getrandom::fill(&mut s).expect("randomness");
    s[0] &= 248;
    s[31] &= 127;
    s[31] |= 64;
    s
}

/// What a match must satisfy.
struct Want {
    nibbles: Nibbles,
    regex: Option<Regex>,
    compressed: bool,
}

impl Want {
    fn hit(&self, room: &Room, public: &[u8; 32]) -> bool {
        if !self.nibbles.hit(bits80(public)) {
            return false;
        }
        let Some(re) = &self.regex else { return true };
        let a = room.addr(public);
        if self.compressed {
            re.is_match(&Ipv6Addr::from(a).to_string())
        } else {
            re.is_match(&expanded(&a))
        }
    }
}

/// One thread: tries keys from random starting points, `found` each match (the key, the public key), until `stop`.
fn mine(
    room: &Room,
    want: &Want,
    tried: &AtomicU64,
    stop: &AtomicBool,
    found: &dyn Fn([u8; 32], [u8; 32]),
) {
    let step = ED25519_BASEPOINT_POINT * Scalar::from(8u8);
    while !stop.load(Ordering::Relaxed) {
        let s = clamped_random();
        let mut p = EdwardsPoint::mul_base_clamped(s);
        let mut points = [p; BATCH];
        let mut k = 0u64;
        while k < STEPS && !stop.load(Ordering::Relaxed) {
            for slot in points.iter_mut() {
                *slot = p;
                p += step;
            }
            for (i, u) in EdwardsPoint::to_montgomery_batch(&points)
                .iter()
                .enumerate()
            {
                if want.hit(room, u.as_bytes()) {
                    // Derived again the ordinary way: a stepping mistake can't print a wrong key.
                    if let Some(key) = stepped(&s, k + i as u64)
                        && MontgomeryPoint::mul_base_clamped(key) == *u
                    {
                        found(key, *u.as_bytes());
                    }
                }
            }
            k += BATCH as u64;
            tried.fetch_add(BATCH as u64, Ordering::Relaxed);
        }
    }
}

/// The keys a match takes on average: 16 to the digits fixed, times one over the share of random addresses that have
/// them and match the regular expression, sampled until 100 do (a tenth's error) or `budget` passes; false: none of
/// the sample did, so the odds are worse than one in its size.
fn keys_per_match(room: &Room, want: &Want, budget: Duration) -> (f64, bool) {
    let digits = 16f64.powi(want.nibbles.digits() as i32);
    if want.regex.is_none() {
        return (digits, true);
    }
    let (mut hits, mut samples) = (0u64, 0u64);
    let t0 = Instant::now();
    let mut public = [0u8; 32];
    let mut seed = [0u8; 16];
    getrandom::fill(&mut seed).expect("randomness");
    let mut x = u128::from_le_bytes(seed) | 1;
    while hits < 100 && t0.elapsed() < budget {
        for _ in 0..10_000 {
            // xorshift: uniform enough for odds, and far faster than drawing randomness for each.
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let bits = (x & ((1 << 80) - 1) & !want.nibbles.mask) | want.nibbles.value;
            public[..10].copy_from_slice(&bits.to_be_bytes()[6..]);
            hits += want.hit(room, &public) as u64;
        }
        samples += 10_000;
    }
    match hits {
        0 => (digits * samples as f64, false),
        h => (digits * samples as f64 / h as f64, true),
    }
}

/// A duration in words: seconds, minutes, hours, days or years.
fn span(s: f64) -> String {
    match s {
        s if s < 90.0 => format!("{s:.0} s"),
        s if s < 90.0 * 60.0 => format!("{:.0} min", s / 60.0),
        s if s < 48.0 * 3600.0 => format!("{:.1} h", s / 3600.0),
        s if s < 730.0 * 86400.0 => format!("{:.0} days", s / 86400.0),
        s => format!("{:.0} years", s / (365.0 * 86400.0)),
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut input, mut prefix, mut suffix, mut regex) = (None, None, None, None);
    let (mut compressed, mut count, mut threads) = (false, 1usize, None);
    let usage = "usage: room-key-mine <room link or public room's name> [--prefix HEX] [--suffix HEX] [--regex RE [--compressed]] [--count N] [--threads N]";
    let fail = |m: &str| -> ! {
        eprintln!("{m}\n{usage}");
        std::process::exit(2)
    };
    while let Some(a) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| fail(&format!("{a} needs a value")))
        };
        match a.as_str() {
            "--prefix" => prefix = Some(value()),
            "--suffix" => suffix = Some(value()),
            "--regex" => regex = Some(value()),
            "--compressed" => compressed = true,
            "--count" => {
                count = value()
                    .parse()
                    .unwrap_or_else(|_| fail("--count: a number"))
            }
            "--threads" => {
                threads = Some(
                    value()
                        .parse()
                        .unwrap_or_else(|_| fail("--threads: a number")),
                )
            }
            _ if a.starts_with("--") => fail(&format!("unknown option {a}")),
            _ => input = Some(a),
        }
    }
    let input = input.unwrap_or_else(|| fail("no room"));
    let link = Link::parse(&input).unwrap_or_else(|e| fail(&format!("not a room's link: {e}")));
    let room = Room::derive(&link.id);
    if prefix.is_none() && suffix.is_none() && regex.is_none() {
        fail("nothing to mine for: give --prefix, --suffix or --regex");
    }
    let side = |s: &Option<String>, suffix: bool| match s {
        Some(s) => digits_of(s, &room.prefix, suffix)
            .map(|d| nibbles(&d, suffix))
            .unwrap_or_else(|e| fail(&e)),
        None => Nibbles::default(),
    };
    let nibbles = both(side(&prefix, false), side(&suffix, true)).unwrap_or_else(|e| fail(&e));
    let regex = regex.map(|r| Regex::new(&r).unwrap_or_else(|e| fail(&format!("--regex: {e}"))));
    let want = Arc::new(Want {
        nibbles,
        regex,
        compressed,
    });
    let threads = threads
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
        .max(1);
    let mut zero = room.prefix.to_vec();
    zero.resize(16, 0);
    println!(
        "room {:?}: its /48 is {}/48; {threads} threads",
        link.id,
        Ipv6Addr::from(<[u8; 16]>::try_from(zero).unwrap())
    );
    let (per_match, measured) = keys_per_match(&room, &want, Duration::from_secs(1));
    println!(
        "a match takes {}{:.3e} keys on average{}",
        if measured { "about " } else { "more than " },
        per_match,
        if want.regex.is_some() {
            " (the expression's odds from a sample of random addresses)"
        } else {
            ""
        }
    );

    let room = Arc::new(room);
    let tried = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let results = Arc::new(Mutex::new(0usize));
    let t0 = Instant::now();
    let workers: Vec<_> = (0..threads)
        .map(|_| {
            let (room, want, tried, stop, results) = (room.clone(), want.clone(), tried.clone(), stop.clone(), results.clone());
            std::thread::spawn(move || {
                let found = |key: [u8; 32], public: [u8; 32]| {
                    let mut n = results.lock().unwrap();
                    if *n >= count {
                        return;
                    }
                    *n += 1;
                    let a = room.addr(&public);
                    println!(
                        "\nkey       {}\naddress   {}\nexpanded  {}\nname      {}\n(after {} keys, {:.1} s)",
                        hex(&key),
                        Ipv6Addr::from(a),
                        expanded(&a),
                        room.name(&public),
                        tried.load(Ordering::Relaxed),
                        t0.elapsed().as_secs_f64()
                    );
                    if *n >= count {
                        stop.store(true, Ordering::Relaxed);
                    }
                };
                mine(&room, &want, &tried, &stop, &found);
            })
        })
        .collect();
    let mut next = Duration::from_secs(2);
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
        if t0.elapsed() >= next {
            next += Duration::from_secs(10);
            let n = tried.load(Ordering::Relaxed) as f64;
            let rate = n / t0.elapsed().as_secs_f64();
            let left = (count - *results.lock().unwrap()) as f64;
            eprintln!(
                "  {:.1} M keys in {:.0} s, {:.2} M/s: a match every {}{} on average{}",
                n / 1e6,
                t0.elapsed().as_secs_f64(),
                rate / 1e6,
                if measured { "" } else { "more than " },
                span(per_match / rate),
                if left > 1.0 {
                    format!(", {} for the {left} left", span(left * per_match / rate))
                } else {
                    String::new()
                }
            );
        }
    }
    for w in workers {
        w.join().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The public key the module computes from a private one (X25519, as x25519-dalek's `StaticSecret`).
    fn public_of(key: [u8; 32]) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(key)).to_bytes()
    }

    fn unhex(s: &str) -> [u8; 32] {
        let v: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    #[test]
    fn stepping_gives_the_keys_x25519_gives() {
        let s = clamped_random();
        let mut p = EdwardsPoint::mul_base_clamped(s);
        let step = ED25519_BASEPOINT_POINT * Scalar::from(8u8);
        let mut points = Vec::new();
        for _ in 0..40 {
            points.push(p);
            p += step;
        }
        for (k, u) in EdwardsPoint::to_montgomery_batch(&points)
            .iter()
            .enumerate()
        {
            let key = stepped(&s, k as u64).unwrap();
            assert_eq!(*u.as_bytes(), public_of(key), "step {k}");
        }
    }

    #[test]
    fn a_key_s_address_and_name_are_the_module_s() {
        // What the module said for this key in this room (a member's `self` event, 2026-11-11).
        let room = Room::derive("gbltest-3osfmkgjp2ipy24462wsg6vase");
        let public = public_of(unhex(
            "d63de5f704da4c84c7d36d7d8f9e37656639f759ae0b8c075000b4bd8d9203d6",
        ));
        let a = room.addr(&public);
        assert_eq!(
            Ipv6Addr::from(a).to_string(),
            "fd1f:9d04:b403:a7eb:711b:9fde:d80e:a798"
        );
        assert_eq!(expanded(&a), "fd1f:9d04:b403:a7eb:711b:9fde:d80e:a798");
        assert_eq!(
            room.name(&public),
            "u7vxcg4733ma5j4y4bdn6opo5ncyk6nl7dof3ec42hkjdb42qzna.d6oqjnad.p2p.internal"
        );
        assert_eq!(bits80(&public), 0xa7eb_711b_9fde_d80e_a798);
    }

    #[test]
    fn prefixes_and_suffixes() {
        let room = [0xfd, 0x1f, 0x9d, 0x04, 0xb4, 0x03];
        let p = |s: &str| nibbles(&digits_of(s, &room, false).unwrap(), false);
        let x = |s: &str| nibbles(&digits_of(s, &room, true).unwrap(), true);
        let bits = 0xa7eb_711b_9fde_d80e_a798;
        assert!(p("a7eb").hit(bits) && p("a7eb:71").hit(bits) && p("a").hit(bits));
        assert!(
            p("a7eb711b9f").hit(bits) && x("d80ea798").hit(bits),
            "bare digits, no colons"
        );
        assert!(
            p("fd1f9d04b403a7eb711b9fde").hit(bits),
            "bare, with the room's own digits"
        );
        assert!(
            p("fd1f:9d04:b403:a7eb:711b:9fde").hit(bits),
            "the room's own digits may lead"
        );
        assert!(!p("a7ec").hit(bits));
        assert!(x("a798").hit(bits) && x("e:a798").hit(bits) && x("8").hit(bits));
        assert!(!x("a799").hit(bits));
        assert!(both(p("a7eb"), x("a798")).unwrap().hit(bits));
        assert_eq!(both(p("a7eb"), x("a798")).unwrap().digits(), 8);
        assert!(
            both(p("a7eb:711b:9fde:d80e:a798"), x("0")).is_err(),
            "overlapping and disagreeing"
        );
        for bad in ["a7:eb", "a7eb::1", "xyz", "a7eb:711b:9fde:d80e:a798:1"] {
            assert!(digits_of(bad, &room, false).is_err(), "{bad}");
        }
        assert!(
            digits_of("1:0053", &room, true).is_ok() && digits_of("0053:1", &room, true).is_err()
        );
    }

    #[test]
    fn the_keys_a_match_takes() {
        let room = Room::derive("lobby");
        let only = |n: Nibbles| Want {
            nibbles: n,
            regex: None,
            compressed: false,
        };
        let s = Duration::from_secs(1);
        assert_eq!(
            keys_per_match(&room, &only(nibbles(&[1, 2, 3], false)), s),
            (4096.0, true)
        );
        // One digit's odds through the expression (1 in 16), and through both (the regex's odds on top of the digits').
        let re = |n: Nibbles, r: &str| Want {
            nibbles: n,
            regex: Some(Regex::new(r).unwrap()),
            compressed: false,
        };
        // 100 hits: within a third of 16 in all but the rarest runs (four standard errors).
        let (k, ok) = keys_per_match(&room, &re(Nibbles::default(), "a$"), s);
        assert!(ok && (11.0..24.0).contains(&k), "{k}");
        let (k, ok) = keys_per_match(&room, &re(nibbles(&[0xc], false), "a$"), s);
        assert!(ok && (11.0 * 16.0..24.0 * 16.0).contains(&k), "{k}");
        // What the prefix already fixes doesn't count twice.
        let (k, _) = keys_per_match(&room, &re(nibbles(&[0xc], false), ":c"), s);
        assert_eq!(k, 16.0);
        let (k, ok) = keys_per_match(
            &room,
            &re(Nibbles::default(), "^nothing"),
            Duration::from_millis(50),
        );
        assert!(
            !ok && k >= 10_000.0,
            "a sample of at least one round, none matching: {k}"
        );
        assert_eq!(span(30.0), "30 s");
        assert_eq!(span(3600.0), "60 min");
        assert_eq!(span(86400.0), "24.0 h");
        assert_eq!(span(86400.0 * 10.0), "10 days");
    }

    #[test]
    fn a_mined_key_matches_and_is_the_x25519_key() {
        let room = Room::derive("lobby");
        for want in [
            Want {
                nibbles: nibbles(&[0xc, 0xa], false),
                regex: None,
                compressed: false,
            },
            Want {
                nibbles: nibbles(&[0x5, 0x3], true),
                regex: None,
                compressed: false,
            },
            Want {
                nibbles: Nibbles::default(),
                regex: Some(Regex::new(":0[0-9a-f]{3}$").unwrap()),
                compressed: false,
            },
        ] {
            let (tried, stop) = (AtomicU64::new(0), AtomicBool::new(false));
            let got = Mutex::new(None);
            // A broken miner finds nothing: stopped after 5 s (a match takes a few hundred keys), it fails, not hangs.
            std::thread::scope(|t| {
                t.spawn(|| {
                    let t0 = Instant::now();
                    while !stop.load(Ordering::Relaxed) && t0.elapsed() < Duration::from_secs(5) {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    stop.store(true, Ordering::Relaxed);
                });
                mine(&room, &want, &tried, &stop, &|key, public| {
                    *got.lock().unwrap() = Some((key, public));
                    stop.store(true, Ordering::Relaxed);
                });
            });
            let (key, public) = got.into_inner().unwrap().expect("a match within 5 s");
            assert_eq!(public, public_of(key));
            assert!(want.hit(&room, &public));
        }
    }
}
