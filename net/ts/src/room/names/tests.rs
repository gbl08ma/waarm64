//! The names' records and rules against a pretend Bitcoin: easy headers, cheap proof of work,
//! anchors made up to the headers' Merkle roots. One real anchored proof and its header
//! (bench/net/results/names0/proofs.json) checks the verifier against the calendars' format.

use k256::schnorr::SigningKey;

use super::{
    Invalid, Params,
    anchor::{Anchor, Calendar, Op, Pending, apply},
    chain::{Chain, Kept, Name, order},
    entry::{Entry, Kind, Pow, Stamped},
    header::{FOLLOWERS, Header, Run, target},
    id::{RoomNames, owner_key},
};

const HOUR: u32 = 3600;
const DAY: u32 = 24 * HOUR;
const T0: u32 = 1_800_000_000;
/// Regtest's target: half of all hashes are under it.
const EASY: u32 = 0x207f_ffff;

/// The spec's clock with cheap proof of work and a floor any pretend header meets.
fn params() -> Params {
    Params::TEST
}

/// A small seeded PRNG (SplitMix64): the property tests' only randomness.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }

    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut b = [0u8; N];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes()[..c.len()]);
        }
        b
    }

    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            v.swap(i, self.below(i as u64 + 1) as usize);
        }
    }
}

/// A header at `time` over `root`, mined to its own `bits`, after a made-up block.
fn header(rng: &mut Rng, time: u32, root: [u8; 32], bits: u32) -> Header {
    let prev = rng.bytes::<32>();
    after(prev, time, root, bits)
}

/// A header at `time` over `root` naming block `prev`, mined to its own `bits`.
fn after(prev: [u8; 32], time: u32, root: [u8; 32], bits: u32) -> Header {
    let t = target(bits).unwrap();
    let mut h = [0u8; 80];
    h[..4].copy_from_slice(&0x2000_0000u32.to_le_bytes());
    h[4..36].copy_from_slice(&prev);
    h[36..68].copy_from_slice(&root);
    h[68..72].copy_from_slice(&time.to_le_bytes());
    h[72..76].copy_from_slice(&bits.to_le_bytes());
    for nonce in 0u32.. {
        h[76..].copy_from_slice(&nonce.to_le_bytes());
        let mut x = Header(h).hash();
        x.reverse();
        if x <= t {
            break;
        }
    }
    Header(h)
}

/// The pretend Bitcoin, a room and a name.
struct World {
    rng: Rng,
    params: Params,
    names: RoomNames,
    pow: Pow,
}

/// A clock past every pretend time, for checks that don't test the future.
const LATE: u64 = u32::MAX as u64;

impl World {
    fn new(seed: u64) -> World {
        let params = params();
        World {
            rng: Rng(seed),
            pow: Pow::new(&params),
            params,
            names: RoomNames::derive("names test room"),
        }
    }

    fn key(&self, secret: u8, name: &str) -> SigningKey {
        owner_key(&[secret; 32], &self.names, name)
    }

    /// An entry made after a `ref` block at `ref_time`, worked and signed, checked; no anchor.
    fn entry(
        &mut self,
        kind: Kind,
        key: &SigningKey,
        name: &str,
        prev: [u8; 32],
        ref_time: u32,
    ) -> Stamped {
        let root = self.rng.bytes();
        let r = header(&mut self.rng, ref_time, root, EASY);
        let owner = key.verifying_key().to_bytes().into();
        let mut e = Entry::new(
            &self.names,
            kind,
            self.names.name_id(name),
            owner,
            prev,
            r.hash(),
        );
        e.nonce = self.rng.next();
        assert!(self.pow.mine(&mut e, 1 << 20));
        e.sign(key, &self.names);
        Stamped::check(e, r, &self.names, &self.params, &mut self.pow, LATE).unwrap()
    }

    /// An anchor for `id` in a block at `time`: a calendar's kind of path to a made-up root.
    fn anchor(&mut self, id: &[u8; 32], time: u32) -> (Anchor, Run) {
        let ops = vec![
            Op::Append(self.rng.bytes::<16>().to_vec()),
            Op::Sha256,
            Op::Prepend(self.rng.bytes::<32>().to_vec()),
            Op::Sha256,
        ];
        let root: [u8; 32] = apply(&ops, id).unwrap().try_into().unwrap();
        (
            Anchor {
                ops,
                height: 900_000,
            },
            self.run(time, root),
        )
    }

    /// A block at `time` over `root` and the six after it, ten minutes apart, each naming the one before.
    fn run(&mut self, time: u32, root: [u8; 32]) -> Run {
        let block = header(&mut self.rng, time, root, EASY);
        let mut next = Vec::new();
        let mut prev = block.hash();
        for k in 1..=FOLLOWERS as u32 {
            let root = self.rng.bytes();
            let h = after(prev, time + 600 * k, root, EASY);
            prev = h.hash();
            next.push(h);
        }
        Run { block, next }
    }

    /// An entry anchored at `time` (its `ref` an hour before).
    fn at(
        &mut self,
        kind: Kind,
        key: &SigningKey,
        name: &str,
        prev: [u8; 32],
        time: u32,
    ) -> Stamped {
        let mut s = self.entry(kind, key, name, prev, time - HOUR);
        let (a, h) = self.anchor(&s.id(), time);
        assert_eq!(s.offer_anchor(a, h, &self.params, LATE), Ok(true));
        s
    }

    fn name(&self, name: &str, entries: &[&Stamped]) -> Name {
        let mut n = Name::new(self.names.name_id(name));
        for e in entries {
            n.insert((*e).clone(), &self.params, T0 as u64);
        }
        n
    }
}

// ---- The real vector: alice's proof of a digest stamped 2026-11-16 19:11 UTC, in block 976,177.

const DIGEST: &str = "51994eeccde4fb254be6781ff2a85ad917625b7069369a4eb92c3bcd3a60409d";
const RECEIPT: &str = "f00871f3dd11c1886a1d08f120a4e7df56dcb1785edb793ea9b3813b815196e5c2102fcb09abe470a5b6b820fb08f010d54edbe103d66a18db6333f51efda14d08f120909d8a8d2e7048e24a79fcad9bfcb9f59dcf5b5b761f9c3b5dd10034d8caca8c08f0200f9c45fe985f3feb06760202ee6ba4a6d074aa7ff2572741eef746d48b537df708f1046afb5546f0084797e7e5587dee400083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267";
const COMMITMENT: &str =
    "6afb5546f4d1e4ec5dc6d801e0e39b06577e21e4b294659794f0dc91b10f0e751c14d7144797e7e5587dee40";
const PROOF: &str = "08f020c06e7e46640f7389ea43b3d3e6027ec80bfc0c16e276eea7a1157a39fd110ab008f120c5710348789028837c4703625a81c32966b0ce809ea247a9040995a54bcb10f308f1204fa4c554785b239a68b481fe9c516234c4b2b40aa58b34a426bb4979960423dc08f12018f556e63d75aa98a4883863e2dfab3290f14e94c1f17953a45a66a7ae3cf08a08f120fd9be4543c328cbc4081389a1483f508d63a0babc92194c10224cab4e7f5ed9708f120f3d665eda9e6b29d16fe0e9accc6e2c3a6269c996fff55a831215a24e17d4b1908f1209e70b7885eafca2aa0d5df35f63e2a34bdb1e15c6c075126155a2e6d63fcffa508f120454b4ba4d6cb68ee267584272a7d79a067e48ab3ca4add5ee4668d763ae8b1ad08f120b22a91eca16ea8bbe88843adcfeb8ef2f52cde43796381edee0633a40b12351a08f12063eecdb2d2b086be34ff7e070f00323c3bbedf4a65a8c9c8a5f1e0b7d051e9eb08f02052e7a0f006e0e8ea7d2592180f9e9c2c52e11a56b38f2044cb11cf7e5ed9164408f159010000000187c2c6da9611d9a7a0381cb1682130671bdb1a94ea1ade042197f8a296f685690000000000feffffff021d8700000000000016001453d088e4eaf66e03e98d609c6a0b6f4cad8a712f0000000000000000226a20f00430e50e000808f120379bacae14dff4596054486c8451a2c1b236e6f6d64b64ed4c04b91e02d282f00808f02059038a9679cbb3029e4c7d011f25446c167baef22f650460cf62f888271ca0400808f120899e1fac4e25482a178ce46c0519e1fc619ef7741315a702001cf59818a96d840808f120a1687408e28c2df828f950d72379842aea76eb5b07dc6248879327dd247e21e60808f02072bddd672d8d529fbc4bca471d78cc9ae01b3713f20b6ea04a75f06feda9f2530808f1208a6241e6385cb62b072876373f1b799ec28b7886644016c9a2d51caa711fa1120808f0201f48f915d5d3e960941e6a555e5c3c269c57895239597205f9f75a962018b9bf0808f120e1c22adbde684d84b3687e5defedda505cc0450980243b0debdda3c97f12f0480808f120d2935c21b42000c06eb21b61ec1efbb18fe473f319d2ffc9884812fa681611920808f1202c43fbb38fd7181244d41881fd94461d3c61e0bb07aa8f2b21fa0d511b41e4c00808f120e028db966f5679d81f562f1b07eafd908cc3b000b5223a8077be549c38441acf0808f02026a2de08435e4a7e8b89939f4efcfffc9dc7034a6de279761a0ce844ce8117650808000588960d73d7190103b1ca3b";
const HEADER: &str = "00e04c20f6374446b60d127305852f0442e4a807beda2bd7ad02010000000000000000006dd76bb5481c1e48d5d9a0ae3f274ac00c04adac65dfd3564b9d58328e34fbf9a158fb6a7316021794de0a2c";
/// Block 976,177's hash as explorers show it (reversed).
const BLOCK: &str = "000000000000000000008adf7ca4deb83e616d12638d86ddfffc6b27aec8cbe8";
/// 2026-11-16 19:25:21 UTC.
const BLOCK_TIME: u32 = 1_794_857_121;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

#[test]
fn a_real_anchor_and_its_header() {
    let p = Params::PRODUCTION;
    let digest: [u8; 32] = unhex(DIGEST).try_into().unwrap();
    let pending = Pending::from_receipt(Calendar::Alice, &unhex(RECEIPT), &digest).unwrap();
    assert_eq!(pending.commitment(&digest).unwrap(), unhex(COMMITMENT));
    assert_eq!(Pending::decode(&pending.encode()), Ok(pending.clone()));
    let anchors = pending.finish(&digest, &unhex(PROOF)).unwrap();
    assert_eq!(anchors.len(), 1);
    let a = &anchors[0];
    assert_eq!(a.height, 976_177);
    assert_eq!(a.ops.len(), 75);
    let bytes = a.encode();
    assert_eq!(
        bytes.len(),
        1068 + 13,
        "the ops as N0 measured them, and the attestation"
    );
    assert_eq!(Anchor::decode(&bytes).as_ref(), Ok(a));
    let h = Header::from_bytes(&unhex(HEADER)).unwrap();
    let mut shown = h.hash();
    shown.reverse();
    assert_eq!(shown.to_vec(), unhex(BLOCK));
    assert_eq!(a.root(&digest), Some(h.merkle_root()));
    assert_eq!(h.time(), BLOCK_TIME);
    assert_eq!(h.bits(), 0x1702_1673);
    // It proves itself at the production floor, from its time on (2 hours ahead allowed).
    assert_eq!(h.check(&p, BLOCK_TIME as u64), Ok(()));
    assert_eq!(h.check(&p, BLOCK_TIME as u64 - 2 * HOUR as u64), Ok(()));
    assert_eq!(
        h.check(&p, BLOCK_TIME as u64 - 2 * HOUR as u64 - 1),
        Err(Invalid::HeaderFuture)
    );
    // A bit flipped anywhere in the header breaks its work; in the anchor, its root.
    let mut x = h;
    x.0[40] ^= 1;
    assert_eq!(x.check(&p, LATE), Err(Invalid::HeaderWork));
    let mut b = a.clone();
    b.ops[3] = Op::Append(vec![0; 32]);
    assert_ne!(b.root(&digest), Some(h.merkle_root()));
    // A header whose work is real but far below a block's is under the floor.
    let mut rng = Rng(1);
    let easy = header(&mut rng, BLOCK_TIME, [0; 32], 0x1f00_ffff);
    assert_eq!(easy.check(&p, LATE), Err(Invalid::HeaderFloor));
}

#[test]
fn headers_and_the_floor() {
    let mut rng = Rng(2);
    let mut p = params();
    let h = header(&mut rng, T0, [1; 32], EASY);
    assert_eq!(h.check(&p, T0 as u64), Ok(()));
    // The floor raised (a harder target): the same header is under it.
    p.floor = &[(0, 0x1f00_ffff)];
    assert_eq!(h.check(&p, T0 as u64), Err(Invalid::HeaderFloor));
    let h2 = header(&mut rng, T0, [1; 32], 0x1f00_ffff);
    assert_eq!(h2.check(&p, T0 as u64), Ok(()));
    // No more than `drift` past now.
    assert_eq!(h2.check(&p, T0 as u64 - 2 * HOUR as u64), Ok(()));
    assert_eq!(
        h2.check(&p, T0 as u64 - 2 * HOUR as u64 - 1),
        Err(Invalid::HeaderFuture)
    );
    // A hash over its own target.
    let mut x = h2;
    loop {
        x.0[76] = x.0[76].wrapping_add(1);
        let mut v = x.hash();
        v.reverse();
        if v > target(0x1f00_ffff).unwrap() {
            break;
        }
    }
    assert_eq!(x.check(&p, LATE), Err(Invalid::HeaderWork));
    // A malformed target.
    let mut y = h2;
    y.0[72..76].copy_from_slice(&0x1f80_ffffu32.to_le_bytes());
    assert_eq!(y.check(&p, LATE), Err(Invalid::HeaderWork));
}

#[test]
fn an_entry_is_checked_whole() {
    let mut w = World::new(3);
    let key = w.key(1, "test123");
    let good = w.entry(Kind::Claim, &key, "test123", [0; 32], T0);
    let (e, r) = (good.entry.clone(), good.ref_header);
    let (names, params) = (w.names.clone(), w.params.clone());
    let mut check =
        |e: Entry, r: Header| Stamped::check(e, r, &names, &params, &mut w.pow, LATE).map(|_| ());
    assert_eq!(check(e.clone(), r), Ok(()));
    // Another key's signature, a field changed after signing.
    let mut x = e.clone();
    x.sign(&owner_key(&[9; 32], &w.names, "test123"), &w.names);
    assert_eq!(check(x, r), Err(Invalid::Signature));
    let mut x = e.clone();
    x.name[0] ^= 1;
    assert_eq!(check(x, r), Err(Invalid::Signature));
    // Another room's record.
    let mut x = e.clone();
    x.room[0] ^= 1;
    assert_eq!(check(x, r), Err(Invalid::Room));
    // A claim naming an entry before it; a renewal naming none.
    let mut x = e.clone();
    x.prev = [1; 32];
    x.sign(&key, &w.names);
    assert_eq!(check(x, r), Err(Invalid::Prev));
    let mut x = e.clone();
    x.kind = Kind::Renew;
    x.sign(&key, &w.names);
    assert_eq!(check(x, r), Err(Invalid::Prev));
    // `ref`'s header must be `ref`'s block, and prove itself.
    let other = header(&mut Rng(4), T0, [2; 32], EASY);
    assert_eq!(check(e.clone(), other), Err(Invalid::RefHeader));
    // A nonce whose work falls short.
    let mut pow = Pow::new(&w.params);
    let mut x = e.clone();
    while pow.ok(&x) {
        x.nonce += 1;
    }
    x.sign(&key, &w.names);
    assert_eq!(check(x, r), Err(Invalid::Work));
}

#[test]
fn an_anchor_must_fall_in_its_refs_window() {
    let mut w = World::new(5);
    let key = w.key(1, "test123");
    let p = w.params.clone();
    let s = w.entry(Kind::Claim, &key, "test123", [0; 32], T0);
    let rt = s.ref_header.time();
    for (dt, ok) in [
        (0i64, true),
        (p.ref_window as i64, true),
        (p.ref_window as i64 + 1, false),
        (-(p.drift as i64), true),
        (-(p.drift as i64) - 1, false),
    ] {
        let mut s = s.clone();
        let (a, h) = w.anchor(&s.id(), (rt as i64 + dt) as u32);
        let r = s.offer_anchor(a, h, &p, LATE);
        assert_eq!(r.is_ok(), ok, "{dt}: {r:?}");
        if !ok {
            assert_eq!(r, Err(Invalid::AnchorWindow));
            assert_eq!(s.time(), None);
        }
    }
    // An anchor for another entry; a header in the future.
    let mut s2 = s.clone();
    let (a, h) = w.anchor(&[7; 32], rt);
    assert_eq!(s2.offer_anchor(a, h, &p, LATE), Err(Invalid::AnchorRoot));
    let (a, h) = w.anchor(&s.id(), rt + HOUR);
    assert_eq!(
        s2.offer_anchor(a, h, &p, rt as u64 - 2 * HOUR as u64),
        Err(Invalid::HeaderFuture)
    );
}

#[test]
fn the_earliest_anchor_is_kept_whatever_the_order() {
    let mut w = World::new(6);
    let key = w.key(1, "test123");
    let p = w.params.clone();
    let s = w.entry(Kind::Claim, &key, "test123", [0; 32], T0);
    let early = w.anchor(&s.id(), T0 + HOUR);
    let late = w.anchor(&s.id(), T0 + 3 * HOUR);
    let mut a = s.clone();
    assert_eq!(
        a.offer_anchor(late.0.clone(), late.1.clone(), &p, LATE),
        Ok(true)
    );
    assert_eq!(
        a.offer_anchor(early.0.clone(), early.1.clone(), &p, LATE),
        Ok(true)
    );
    let mut b = s.clone();
    assert_eq!(
        b.offer_anchor(early.0.clone(), early.1.clone(), &p, LATE),
        Ok(true)
    );
    assert_eq!(
        b.offer_anchor(late.0.clone(), late.1.clone(), &p, LATE),
        Ok(false)
    );
    assert_eq!(a, b);
    assert_eq!(a.time(), Some(T0 + HOUR));
    // The same through merging copies.
    let mut c = s.clone();
    c.offer_anchor(late.0, late.1, &p, LATE).unwrap();
    let mut d = s.clone();
    d.merge(c.clone(), &p, LATE);
    d.merge(b.clone(), &p, LATE);
    let mut e = s.clone();
    e.merge(b, &p, LATE);
    e.merge(c, &p, LATE);
    assert_eq!(d, e);
    assert_eq!(d.time(), Some(T0 + HOUR));
}

#[test]
fn a_pending_anchor_proves_nothing() {
    let mut w = World::new(7);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    // B's claim is earlier but only pending; A's is anchored: A owns.
    let mut held_back = w.entry(Kind::Claim, &b, "test123", [0; 32], T0 - DAY);
    let pending = Pending {
        calendar: Calendar::Bob,
        ops: vec![Op::Append(vec![1; 8]), Op::Sha256],
        sig: [0; 64],
    };
    assert!(held_back.offer_pending(pending.clone(), &p, T0 as u64));
    assert_eq!(held_back.time(), None);
    let claim = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let n = w.name("test123", &[&held_back, &claim]);
    let o = n.owner(&p, T0 as u64 + DAY as u64).unwrap();
    assert_eq!(o.ids, vec![claim.id()]);
    assert_eq!(n.chains(&p).len(), 1);
    // Once it has an anchor (in its window), it counts, and its pending goes.
    let (an, h) = w.anchor(&held_back.id(), T0 - DAY);
    held_back.offer_anchor(an, h, &p, LATE).unwrap();
    assert_eq!(held_back.pending(), None);
    assert!(
        !held_back.offer_pending(pending.clone(), &p, T0 as u64),
        "not on an anchored entry"
    );
    let n = w.name("test123", &[&held_back, &claim]);
    assert_eq!(
        n.owner(&p, T0 as u64 + DAY as u64).unwrap().ids,
        vec![held_back.id()]
    );
    // A pending is dropped once its entry could no longer be anchored in its window.
    let mut s = w.entry(Kind::Claim, &a, "test123", [0; 32], T0);
    let stale = T0 as u64 + p.ref_window as u64 + p.pending_slack as u64;
    assert!(s.offer_pending(pending.clone(), &p, stale));
    assert!(!s.clone().offer_pending(pending.clone(), &p, stale + 1));
    let mut n = w.name("test123", &[&s]);
    n.prune(&p, stale);
    assert!(n.get(&s.id()).unwrap().pending().is_some());
    n.prune(&p, stale + 1);
    assert!(
        n.is_empty(),
        "an entry that can't be anchored any more goes"
    );
    // On a chain's last entry only: an anchored entry takes none, and an unanchored one keeps
    // its pending only while nothing anchored follows it.
    let c = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    assert!(!c.clone().offer_pending(pending.clone(), &p, T0 as u64));
    let mut r = w.entry(Kind::Renew, &a, "test123", c.id(), T0 + 14 * DAY);
    assert!(r.offer_pending(pending.clone(), &p, T0 as u64));
    let mut n = w.name("test123", &[&c, &r]);
    n.prune(&p, T0 as u64 + 14 * DAY as u64);
    assert!(n.get(&r.id()).unwrap().pending().is_some());
    let r2 = w.at(Kind::Renew, &a, "test123", r.id(), T0 + 15 * DAY);
    let mut n = w.name("test123", &[&c, &r, &r2]);
    n.prune(&p, T0 as u64 + 15 * DAY as u64);
    assert!(n.get(&r.id()).unwrap().pending().is_none());
}

#[test]
fn a_renewal_by_another_key_is_no_renewal() {
    let mut w = World::new(8);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    let claim = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let forged = w.at(Kind::Renew, &b, "test123", claim.id(), T0 + 20 * DAY);
    let n = w.name("test123", &[&claim, &forged]);
    // Past the claim's cover, B's entry stands alone: its own run, from its own time.
    let now = T0 as u64 + 40 * DAY as u64;
    let o = n.owner(&p, now).unwrap();
    assert_eq!(o.ids, vec![forged.id()]);
    assert_eq!(o.seniority, T0 + 20 * DAY);
    // While the claim covers, it wins: it is older.
    let o = n.owner(&p, T0 as u64 + 21 * DAY as u64).unwrap();
    assert_eq!(o.ids, vec![claim.id()]);
    // The owner's own renewal links.
    let renew = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + 20 * DAY);
    let n = w.name("test123", &[&claim, &forged, &renew]);
    let o = n.owner(&p, now).unwrap();
    assert_eq!(o.ids, vec![claim.id(), renew.id()]);
    assert_eq!(n.run(&renew.id(), &p).len(), 2);
}

#[test]
fn renewals_must_come_in_time_and_not_before() {
    let mut w = World::new(9);
    let a = w.key(1, "test123");
    let p = w.params.clone();
    let claim = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let tg = p.term + p.grace;
    let just = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + tg);
    let late = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + tg + 1);
    let n = w.name("test123", &[&claim, &just]);
    assert_eq!(n.chains(&p).len(), 1);
    let n = w.name("test123", &[&claim, &late]);
    assert_eq!(
        n.chains(&p).len(),
        2,
        "a renewal past the grace starts a run of its own"
    );
    // A renewal anchored before the entry it names (one stamped early and held) breaks too.
    let claim2 = w.at(Kind::Claim, &a, "test123", [0; 32], T0 + 10 * DAY);
    let mut early = w.entry(
        Kind::Renew,
        &a,
        "test123",
        claim2.id(),
        T0 + 10 * DAY - HOUR,
    );
    let (an, h) = w.anchor(&early.id(), T0 + 10 * DAY - 1);
    early.offer_anchor(an, h, &p, LATE).unwrap();
    let n = w.name("test123", &[&claim2, &early]);
    assert_eq!(n.chains(&p).len(), 2);
}

#[test]
fn the_earlier_claim_wins() {
    let mut w = World::new(10);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    let first = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let second = w.at(Kind::Claim, &b, "test123", [0; 32], T0 + HOUR);
    for order_ in [[&first, &second], [&second, &first]] {
        let n = w.name("test123", &order_);
        let o = n.owner(&p, T0 as u64 + 2 * HOUR as u64).unwrap();
        assert_eq!(o.ids, vec![first.id()]);
        assert!(o.resolves(T0 as u64 + 2 * HOUR as u64));
        // Past the first's term it resolves for nobody; past its grace the second owns.
        assert!(n.owner(&p, T0 as u64 + p.term as u64 + 1).unwrap().ids == vec![first.id()]);
        assert!(
            !n.owner(&p, T0 as u64 + p.term as u64 + 1)
                .unwrap()
                .resolves(T0 as u64 + p.term as u64 + 1)
        );
        let after = T0 as u64 + (p.term + p.grace) as u64;
        assert_eq!(n.owner(&p, after).unwrap().ids, vec![second.id()]);
    }
    // Before the first claim's time less `drift` (a block's time may run that far ahead), nothing covers.
    let n = w.name("test123", &[&first]);
    assert_eq!(n.owner(&p, (T0 - p.drift) as u64 - 1), None);
    assert!(n.owner(&p, (T0 - p.drift) as u64).is_some());
    // Equal times: the lower SHA-256 of the anchor block's hash and the id, whichever came first.
    let c1 = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let c2 = w.at(Kind::Claim, &b, "test123", [0; 32], T0);
    let n1 = w.name("test123", &[&c1, &c2]);
    let n2 = w.name("test123", &[&c2, &c1]);
    let (o1, o2) = (
        n1.owner(&p, T0 as u64).unwrap(),
        n2.owner(&p, T0 as u64).unwrap(),
    );
    assert_eq!(o1, o2);
    let chains = n1.chains(&p);
    let want = chains.iter().min_by_key(|c| c.tie).unwrap();
    assert_eq!(&o1, want);
}

#[test]
fn forks_and_releases() {
    let mut w = World::new(11);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    let claim = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let r1 = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + 15 * DAY);
    // A fork: two browsers renewed the same title.
    let f1 = w.at(Kind::Renew, &a, "test123", r1.id(), T0 + 30 * DAY);
    let f2 = w.at(Kind::Renew, &a, "test123", r1.id(), T0 + 31 * DAY);
    let n = w.name("test123", &[&claim, &r1, &f1, &f2]);
    let now = T0 as u64 + 32 * DAY as u64;
    assert_eq!(n.chains(&p).len(), 2);
    let o = n.owner(&p, now).unwrap();
    assert_eq!(o.last(), f2.id(), "the cover that ends later");
    let mut cs = n.chains(&p);
    cs.sort_by(order);
    assert_eq!(cs[0].last(), f2.id());
    // A release on the other branch doesn't end the title; on the owning one, it does.
    let rel1 = w.at(Kind::Release, &a, "test123", f1.id(), T0 + 31 * DAY + HOUR);
    let n = w.name("test123", &[&claim, &r1, &f1, &f2, &rel1]);
    assert_eq!(n.owner(&p, now).unwrap().last(), f2.id());
    // Released on the owning branch: the title ends at the release, and the stale copy without
    // it (the same entries) can't bring it back.
    let rel2 = w.at(Kind::Release, &a, "test123", f2.id(), T0 + 32 * DAY);
    let all = [&claim, &r1, &f1, &f2, &rel1, &rel2];
    let n = w.name("test123", &all);
    let after = T0 as u64 + 32 * DAY as u64 + 1;
    let o = n.owner(&p, after - 2).unwrap();
    assert_eq!(o.last(), rel2.id());
    assert!(o.resolves(after - 2), "until the release's time");
    // f1's branch was released too: nobody owns it now.
    assert_eq!(n.owner(&p, after), None);
    let stale = w.name("test123", &[&claim, &r1, &f2]);
    assert_eq!(
        stale.owner(&p, after).unwrap().last(),
        f2.id(),
        "the stale copy alone"
    );
    // The order puts a chain with its release before the same chain without it.
    let with = n
        .chains(&p)
        .into_iter()
        .find(|c| c.last() == rel2.id())
        .unwrap();
    let without = stale.chains(&p).into_iter().next().unwrap();
    assert_eq!(order(&with, &without), std::cmp::Ordering::Less);
    assert_eq!(order(&without, &with), std::cmp::Ordering::Greater);
    // A back-order: B claimed while A held the name, and renewed every term. It owns once A's
    // title ends.
    let bc = w.at(Kind::Claim, &b, "test123", [0; 32], T0 + 20 * DAY);
    let br = w.at(Kind::Renew, &b, "test123", bc.id(), T0 + 32 * DAY);
    let mut n = w.name("test123", &[&claim, &r1, &f1, &f2, &rel1, &rel2, &bc, &br]);
    assert_eq!(n.owner(&p, after - 2).unwrap().last(), rel2.id());
    assert_eq!(n.owner(&p, after).unwrap().ids, vec![bc.id(), br.id()]);
    // Nothing follows a release.
    let zombie = w.at(Kind::Renew, &a, "test123", rel2.id(), T0 + 33 * DAY);
    n.insert(zombie.clone(), &p, T0 as u64);
    assert_eq!(
        n.owner(&p, T0 as u64 + 34 * DAY as u64).unwrap().ids,
        vec![bc.id(), br.id()]
    );
    assert!(
        n.chains(&p).iter().any(|c| c.ids == vec![zombie.id()]),
        "a run of its own"
    );
    // The tombstone stays until the cover would have ended without the release.
    let until = T0 as u64 + (31 + 30 + 7) as u64 * DAY as u64;
    n.prune(&p, until - 1);
    assert!(n.get(&rel2.id()).is_some());
    n.prune(&p, until);
    assert!(n.get(&rel2.id()).is_none() && n.get(&claim.id()).is_none());
    assert!(n.get(&bc.id()).is_some(), "B's chain is alive");
}

#[test]
fn pruning_changes_no_answer() {
    let mut w = World::new(12);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    let c1 = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let c2 = w.at(Kind::Claim, &b, "test123", [0; 32], T0 + 10 * DAY);
    let r2 = w.at(Kind::Renew, &b, "test123", c2.id(), T0 + 30 * DAY);
    let n = w.name("test123", &[&c1, &c2, &r2]);
    for d in (0..90).step_by(3) {
        let now = T0 as u64 + d * DAY as u64;
        let mut m = n.clone();
        m.prune(&p, now);
        for later in [now, now + DAY as u64, now + 20 * DAY as u64] {
            assert_eq!(m.owner(&p, later), n.owner(&p, later), "pruned at {d} days");
        }
    }
}

#[test]
fn a_member_keeps_what_it_verified() {
    let mut w = World::new(13);
    let a = w.key(1, "test123");
    let b = w.key(2, "test123");
    let p = w.params.clone();
    let claim = w.at(Kind::Claim, &a, "test123", [0; 32], T0);
    let r1 = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + 15 * DAY);
    let full = w.name("test123", &[&claim, &r1]);
    let now = T0 as u64 + 16 * DAY as u64;
    let mut kept = Kept::new(full.owner(&p, now).unwrap());
    assert_eq!(kept.earliest, T0);
    // After a reset, an impostor's younger chain is all a server shows: refused while A's
    // chain covers, even though the impostor's covers now too.
    let imp = w.at(Kind::Claim, &b, "test123", [0; 32], T0 + 10 * DAY);
    let imp_chain = w.name("test123", &[&imp]).owner(&p, now).unwrap();
    assert!(!kept.offer(&imp_chain, now));
    assert_eq!(kept.chain.owner, claim.entry.owner);
    // A's renewal shown alone (a run of one, younger): refused; with its run, taken.
    let r2 = w.at(Kind::Renew, &a, "test123", r1.id(), T0 + 30 * DAY);
    let later = T0 as u64 + 31 * DAY as u64;
    let alone = w.name("test123", &[&r2]).owner(&p, later).unwrap();
    assert!(!kept.offer(&alone, later));
    let run = w
        .name("test123", &[&claim, &r1, &r2])
        .owner(&p, later)
        .unwrap();
    assert!(kept.offer(&run, later));
    assert_eq!(kept.chain.last(), r2.id());
    // Its stale copy, cut short: nothing new.
    assert!(!kept.offer(&full.owner(&p, later).unwrap(), later));
    assert_eq!(kept.chain.last(), r2.id());
    // An older chain shown (a claim stamped earlier and held back): taken.
    let old = w.at(Kind::Claim, &b, "test123", [0; 32], T0 - DAY);
    let old_r = w.at(Kind::Renew, &b, "test123", old.id(), T0 + 25 * DAY);
    let older = w.name("test123", &[&old, &old_r]).owner(&p, later).unwrap();
    assert!(kept.offer(&older, later));
    assert_eq!(kept.earliest, T0 - DAY);
    // Once what is kept no longer covers now, anything alive replaces it.
    let mut k2 = Kept::new(full.owner(&p, now).unwrap());
    let gone = T0 as u64 + (15 + 37) as u64 * DAY as u64;
    let imp_r = w.at(Kind::Renew, &b, "test123", imp.id(), T0 + 40 * DAY);
    let imp_chain = w.name("test123", &[&imp, &imp_r]).owner(&p, gone).unwrap();
    assert!(k2.offer(&imp_chain, gone));
    // Another branch of the same title (a fork, the same owner key and claim): taken.
    let mut k3 = Kept::new(full.owner(&p, now).unwrap());
    let fork = w.at(Kind::Renew, &a, "test123", claim.id(), T0 + 16 * DAY);
    let branch = w
        .name("test123", &[&claim, &fork])
        .owner(&p, now + DAY as u64)
        .unwrap();
    assert!(k3.offer(&branch, now + DAY as u64));
}

// ---- Property: any order of merging the same chains, with any subsets of their anchors, gives
// the same owner (and the same state).

/// One entry of a scenario and the anchors it may get (two calendars' blocks, say).
struct Made {
    bare: Stamped,
    anchors: Vec<(Anchor, Run)>,
}

/// A name's history: A's title (renewed, sometimes broken by a late renewal, sometimes forked
/// between two browsers, sometimes released), B's back-order or held-back claim, a renewal by
/// another key.
fn scenario(w: &mut World, rng: &mut Rng) -> Vec<Made> {
    let keys = [w.key(1, "prop"), w.key(2, "prop"), w.key(3, "prop")];
    let mut made: Vec<Made> = Vec::new();
    let mut add =
        |w: &mut World, rng: &mut Rng, kind: Kind, k: usize, prev: [u8; 32], t: u32| -> [u8; 32] {
            let bare = w.entry(kind, &keys[k], "prop", prev, t - HOUR);
            let mut anchors = vec![w.anchor(&bare.id(), t)];
            if rng.chance(0.5) {
                // A second calendar's block, a little later (or, rarely, the same time).
                let dt = if rng.chance(0.2) {
                    0
                } else {
                    1 + rng.below(3 * HOUR as u64) as u32
                };
                anchors.push(w.anchor(&bare.id(), t + dt));
            }
            let id = bare.id();
            made.push(Made { bare, anchors });
            id
        };
    let day = |rng: &mut Rng, lo: u32, hi: u32| {
        (lo + rng.below((hi - lo) as u64) as u32) * DAY + rng.below(DAY as u64) as u32
    };
    // A's title.
    let mut t = T0;
    let mut prev = add(w, rng, Kind::Claim, 0, [0; 32], t);
    let mut ids = vec![(prev, t)];
    for _ in 0..rng.below(4) {
        // Mostly in time, sometimes past the grace.
        t += if rng.chance(0.85) {
            day(rng, 10, 30)
        } else {
            day(rng, 38, 45)
        };
        prev = add(w, rng, Kind::Renew, 0, prev, t);
        ids.push((prev, t));
    }
    if rng.chance(0.5) {
        // A fork from one of the entries.
        let (from, ft) = ids[rng.below(ids.len() as u64) as usize];
        let t2 = ft + day(rng, 5, 30);
        let f = add(w, rng, Kind::Renew, 0, from, t2);
        if rng.chance(0.4) {
            let tr = t2 + day(rng, 0, 10);
            add(w, rng, Kind::Release, 0, f, tr);
        }
    }
    if rng.chance(0.4) {
        let tr = t + day(rng, 0, 20);
        add(w, rng, Kind::Release, 0, prev, tr);
    }
    // B: a claim before, during or after A's, renewed.
    let mut tb = (T0 as i64 + rng.below(80) as i64 * DAY as i64 - 20 * DAY as i64) as u32;
    let mut pb = add(w, rng, Kind::Claim, 1, [0; 32], tb);
    for _ in 0..rng.below(4) {
        tb += day(rng, 10, 30);
        pb = add(w, rng, Kind::Renew, 1, pb, tb);
    }
    // A renewal by another key, naming one of A's entries.
    if rng.chance(0.3) {
        let (from, ft) = ids[rng.below(ids.len() as u64) as usize];
        let tf = ft + day(rng, 1, 20);
        add(w, rng, Kind::Renew, 2, from, tf);
    }
    made
}

/// A copy of some entries, each with some of its anchors (maybe none: it stays unanchored), and
/// sometimes a pending.
fn copy(made: &[Made], rng: &mut Rng, p: &Params) -> Vec<Stamped> {
    let mut out = Vec::new();
    for m in made {
        if !rng.chance(0.6) {
            continue;
        }
        let mut s = m.bare.clone();
        for (a, h) in &m.anchors {
            if rng.chance(0.6) {
                s.offer_anchor(a.clone(), h.clone(), p, LATE).unwrap();
            }
        }
        if rng.chance(0.2) {
            let pending = Pending {
                calendar: Calendar::ALL[rng.below(3) as usize],
                ops: vec![Op::Append(vec![rng.below(4) as u8; 4])],
                sig: [0; 64],
            };
            s.offer_pending(pending, p, T0 as u64);
        }
        out.push(s);
    }
    out
}

#[test]
fn any_merge_order_gives_the_same_owner() {
    let mut w = World::new(14);
    let mut rng = Rng(0x5eed);
    let p = w.params.clone();
    let id = w.names.name_id("prop");
    let (mut owners_a, mut owners_b, mut none, mut forks, mut released) = (0, 0, 0, 0, 0);
    for case in 0..60 {
        let made = scenario(&mut w, &mut rng);
        let copies: Vec<Vec<Stamped>> = (0..2 + rng.below(4))
            .map(|_| copy(&made, &mut rng, &p))
            .collect();
        let merge = |order_: &[usize]| {
            let mut n = Name::new(id);
            for &i in order_ {
                for s in &copies[i] {
                    n.insert(s.clone(), &p, T0 as u64);
                }
            }
            n
        };
        let mut idx: Vec<usize> = (0..copies.len()).collect();
        let reference = merge(&idx);
        let nows: Vec<u64> = (0..12)
            .map(|_| T0 as u64 - 30 * DAY as u64 + rng.below(200 * DAY as u64))
            .collect();
        let owners: Vec<Option<Chain>> = nows.iter().map(|&now| reference.owner(&p, now)).collect();
        for _ in 0..6 {
            rng.shuffle(&mut idx);
            // Within a copy, any order too.
            let mut flat: Vec<Stamped> = idx
                .iter()
                .flat_map(|&i| copies[i].iter().cloned())
                .collect();
            rng.shuffle(&mut flat);
            let mut n = Name::new(id);
            for s in flat {
                n.insert(s, &p, T0 as u64);
            }
            assert_eq!(n, reference, "case {case}: the same state");
            for (now, o) in nows.iter().zip(&owners) {
                assert_eq!(&n.owner(&p, *now), o, "case {case} at {now}");
            }
            assert_eq!(merge(&idx), reference);
        }
        let ka: [u8; 32] = w.key(1, "prop").verifying_key().to_bytes().into();
        for o in &owners {
            match o {
                Some(c) if c.owner == ka => owners_a += 1,
                Some(_) => owners_b += 1,
                None => none += 1,
            }
        }
        let cs = reference.chains(&p);
        forks += cs
            .iter()
            .filter(|c| {
                cs.iter()
                    .any(|d| d.first() == c.first() && d.last() != c.last())
            })
            .count()
            .min(1);
        released += cs.iter().any(|c| c.released) as usize;
    }
    // The scenarios reach every case.
    assert!(
        owners_a > 20 && owners_b > 20 && none > 20,
        "{owners_a} {owners_b} {none}"
    );
    assert!(forks > 3 && released > 3, "{forks} {released}");
}

#[test]
fn the_order_is_total() {
    // Every pair of chains of a scenario's union compares one way, and sorting agrees with
    // `owner` on the chains that cover.
    let mut w = World::new(15);
    let mut rng = Rng(0x0dd);
    let p = w.params.clone();
    let id = w.names.name_id("prop");
    for _ in 0..20 {
        let made = scenario(&mut w, &mut rng);
        let mut n = Name::new(id);
        for m in &made {
            let mut s = m.bare.clone();
            for (a, h) in &m.anchors {
                s.offer_anchor(a.clone(), h.clone(), &p, LATE).unwrap();
            }
            n.insert(s, &p, T0 as u64);
        }
        let cs = n.chains(&p);
        for a in &cs {
            for b in &cs {
                assert_eq!(order(a, b), order(b, a).reverse());
                assert_eq!(order(a, b) == std::cmp::Ordering::Equal, a == b);
            }
        }
    }
}

// ---- An anchor's block and the six after it; the floor by header time (review 1, finding 6).

/// The block after 976,177 (bench/net/results/names0/proofs.json): it names 976,177.
const HEADER_976178: &str = "00000020e8cbc8ae276bfcffdd868d63126d613eb8dea47cdf8a000000000000000000003e711f9fec3134bd040b3f5e1960bf3f2c8b9024e8eda0740502e90a1cb287e59d5bfb6a73160217706d51ab";
/// A target 12 bits under the top (about 4,096 hashes a header): the schedules' points below.
const HARD: u32 = 0x1f0f_ffff;
/// Exactly twice [`HARD`]'s target.
const HALF_HARD: u32 = 0x1f1f_fffe;

/// A run at `time` over `root`, the six after it mined to `bits` with `dt` seconds between them.
fn run_of(rng: &mut Rng, time: u32, root: [u8; 32], bits: u32, dt: u32) -> Run {
    let block = after(rng.bytes(), time, root, bits);
    let mut next = Vec::new();
    let mut prev = block.hash();
    for k in 1..=FOLLOWERS as u32 {
        let h = after(prev, time + dt * k, rng.bytes(), bits);
        prev = h.hash();
        next.push(h);
    }
    Run { block, next }
}

#[test]
fn a_lone_header_at_the_floor_backdates_nothing() {
    // Review 1, finding 6: a header mined in private at the floor, timed 36 days back, its Merkle root the forger's,
    // anchors a claim that beats a chain claimed since and renewed with a real stamp today. Now an anchor's block
    // needs the six headers after it, each naming the one before: a lone header anchors nothing.
    let mut w = World::new(40);
    let p = w.params.clone();
    let honest = w.key(1, "test123");
    let forger = w.key(2, "test123");
    let now = T0 + 30 * DAY;
    let claim = w.at(Kind::Claim, &honest, "test123", [0; 32], T0);
    let back = now - 36 * DAY;
    let mut forged = w.entry(Kind::Claim, &forger, "test123", [0; 32], back - HOUR);
    let (a, mut run) = w.anchor(&forged.id(), back);
    run.next.clear();
    let r = forged.offer_anchor(a, run, &p, now as u64);
    let renew = {
        let mut s = w.entry(Kind::Renew, &forger, "test123", forged.id(), now - HOUR);
        let (a, h) = w.anchor(&s.id(), now);
        let _ = s.offer_anchor(a, h, &p, now as u64);
        s
    };
    let n = w.name("test123", &[&claim, &forged, &renew]);
    let o = n.owner(&p, now as u64).unwrap();
    assert_eq!(r, Err(Invalid::HeaderRun), "a lone header anchors nothing");
    assert_eq!(forged.time(), None);
    assert_eq!(o.ids, vec![claim.id()], "the honest claim still owns");
}

#[test]
fn an_anchors_block_comes_with_the_six_after_it() {
    let mut w = World::new(41);
    let p = w.params.clone();
    let key = w.key(1, "test123");
    let s = w.entry(Kind::Claim, &key, "test123", [0; 32], T0 - HOUR);
    let (a, good) = w.anchor(&s.id(), T0);
    let offer = |run: Run, now: u64| s.clone().offer_anchor(a.clone(), run, &p, now);
    assert_eq!(offer(good.clone(), LATE), Ok(true));
    assert_eq!(good.check(&p, LATE), Ok(()));
    // Fewer than six, or more.
    for k in 0..FOLLOWERS {
        let mut r = good.clone();
        r.next.truncate(k);
        assert_eq!(offer(r, LATE), Err(Invalid::HeaderRun), "{k}");
    }
    let mut r = good.clone();
    let last = *r.next.last().unwrap();
    r.next.push(after(last.hash(), T0 + 4200, [3; 32], EASY));
    assert_eq!(offer(r, LATE), Err(Invalid::HeaderRun), "seven");
    // A link broken: one of the six names another block (its own work fine).
    for k in 0..FOLLOWERS {
        let mut r = good.clone();
        let h = r.next[k];
        r.next[k] = after([7; 32], h.time(), h.merkle_root(), EASY);
        assert_eq!(offer(r, LATE), Err(Invalid::HeaderRun), "link {k}");
    }
    // Six that follow another block, linked among themselves.
    let other = w.run(T0, [5; 32]);
    let r = Run {
        block: good.block,
        next: other.next.clone(),
    };
    assert_eq!(offer(r, LATE), Err(Invalid::HeaderRun), "another block's");
    // In another order.
    let mut r = good.clone();
    r.next.swap(2, 3);
    assert_eq!(offer(r, LATE), Err(Invalid::HeaderRun), "out of order");
    // Timed where the block can't be followed: before it by more than `drift`, or past it by more than `run_span`.
    let mut rng = Rng(42);
    let span = |first: u32, dt: u32, rng: &mut Rng| {
        let mut prev = good.block.hash();
        let next = (0..FOLLOWERS as u32)
            .map(|k| {
                let h = after(prev, first + dt * k, rng.bytes(), EASY);
                prev = h.hash();
                h
            })
            .collect();
        Run {
            block: good.block,
            next,
        }
    };
    assert_eq!(offer(span(T0 - p.drift, 0, &mut rng), LATE), Ok(true));
    assert_eq!(
        offer(span(T0 - p.drift - 1, 0, &mut rng), LATE),
        Err(Invalid::HeaderRun)
    );
    assert_eq!(
        offer(span(T0 + 600, (p.run_span - 600) / 5, &mut rng), LATE),
        Ok(true)
    );
    assert_eq!(
        offer(span(T0 + 601, (p.run_span - 600) / 5, &mut rng), LATE),
        Err(Invalid::HeaderRun)
    );
    // Each of the six proves itself: its own work, and no further past now than `drift`.
    let mut r = good.clone();
    let mut x = r.next[4];
    loop {
        x.0[76] = x.0[76].wrapping_add(1);
        let mut v = x.hash();
        v.reverse();
        if v > target(EASY).unwrap() {
            break;
        }
    }
    r.next[4] = x;
    r.next[5] = after(x.hash(), r.next[5].time(), r.next[5].merkle_root(), EASY);
    assert_eq!(offer(r, LATE), Err(Invalid::HeaderWork));
    let latest = good.next.iter().map(Header::time).max().unwrap();
    assert_eq!(offer(good.clone(), (latest - p.drift) as u64), Ok(true));
    assert_eq!(
        offer(good.clone(), (latest - p.drift) as u64 - 1),
        Err(Invalid::HeaderFuture)
    );
    // Through the wire: an item whose anchor lists five decodes, and is refused when checked.
    let mut st = s.clone();
    st.offer_anchor(a.clone(), good.clone(), &p, LATE).unwrap();
    let mut we = super::wire::WireEntry::of(&st);
    we.anchor.as_mut().unwrap().1.next.pop();
    let item = super::wire::Item {
        id: st.entry.name,
        entries: vec![we],
        zone: None,
    };
    let back = super::wire::Item::decode(&item.encode()).unwrap();
    let (a2, r2) = back.entries[0].anchor.clone().unwrap();
    assert_eq!(r2.next.len(), 5);
    assert_eq!(
        s.clone().offer_anchor(a2, r2, &p, LATE),
        Err(Invalid::HeaderRun)
    );
}

#[test]
fn the_floor_is_the_schedules_at_each_headers_time() {
    // A schedule of one point at T0, its target HARD, doubling every 21 days five times at most.
    let mut p = params();
    p.floor = &[(T0, HARD)];
    let step = p.floor_step;
    let mut rng = Rng(43);
    let at = |t: u32, bits: u32, rng: &mut Rng| after(rng.bytes(), t, [1; 32], bits);
    // At the point, a header of half its difficulty is under the floor; one at it passes.
    assert_eq!(at(T0, HARD, &mut rng).check(&p, LATE), Ok(()));
    assert_eq!(
        at(T0, HALF_HARD, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    // A step past the point, half the difficulty passes; not a second before.
    assert_eq!(
        at(T0 + step - 1, HALF_HARD, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    assert_eq!(at(T0 + step, HALF_HARD, &mut rng).check(&p, LATE), Ok(()));
    // Older than the schedule covers: the first point's floor, not none.
    assert_eq!(at(T0 - 400 * DAY, HARD, &mut rng).check(&p, LATE), Ok(()));
    assert_eq!(
        at(T0 - 400 * DAY, HALF_HARD, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    assert_eq!(
        at(1, EASY, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    // Past the last point: future times keep working, down to 1/32 of the point's difficulty and no lower.
    let far = T0 + 1000 * DAY;
    let thirty_second = 0x2001_ffff; // HARD's target times 32, rounded down to a compact target
    assert_eq!(at(far, thirty_second, &mut rng).check(&p, LATE), Ok(()));
    assert_eq!(
        at(far, 0x2003_ffff, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    assert_eq!(
        at(T0 + 4 * step, thirty_second, &mut rng).check(&p, LATE),
        Err(Invalid::HeaderFloor)
    );
    assert_eq!(
        at(T0 + 5 * step, thirty_second, &mut rng).check(&p, LATE),
        Ok(())
    );
    // An anchor's run is held to the floor at each header's own time, the block's included: a run of half the
    // difficulty fails at the point and passes a step later, its followers too.
    let mut w = World::new(44);
    let key = w.key(1, "test123");
    let s = w.entry(Kind::Claim, &key, "test123", [0; 32], T0 + step);
    let root = |s: &Stamped, a: &Anchor| -> [u8; 32] { a.root(&s.id()).unwrap() };
    let (a, _) = w.anchor(&s.id(), T0 + step);
    let r = run_of(&mut rng, T0 + step + HOUR, root(&s, &a), HALF_HARD, 600);
    assert_eq!(s.clone().offer_anchor(a.clone(), r, &p, LATE), Ok(true));
    // The block meets the floor, one follower doesn't: refused.
    let mut r = run_of(&mut rng, T0 + step + HOUR, root(&s, &a), HALF_HARD, 600);
    let h3 = r.next[3];
    r.next[3] = after(r.next[2].hash(), h3.time(), h3.merkle_root(), 0x1f3f_fffc);
    for k in 4..FOLLOWERS {
        let h = r.next[k];
        r.next[k] = after(r.next[k - 1].hash(), h.time(), h.merkle_root(), HALF_HARD);
    }
    assert_eq!(
        s.clone().offer_anchor(a.clone(), r, &p, LATE),
        Err(Invalid::HeaderFloor)
    );
    // Each of the six at the floor of its own time: a block just before a step at the point's difficulty, its six
    // past the step at half of it.
    let s2 = w.entry(Kind::Claim, &key, "test123", [0; 32], T0 + step - HOUR);
    let (a2, _) = w.anchor(&s2.id(), T0 + step - 60);
    let block = after(rng.bytes(), T0 + step - 60, root(&s2, &a2), HARD);
    let mut next = Vec::new();
    let mut prev = block.hash();
    for k in 1..=FOLLOWERS as u32 {
        let h = after(prev, T0 + step - 60 + 600 * k, rng.bytes(), HALF_HARD);
        prev = h.hash();
        next.push(h);
    }
    let r = Run { block, next };
    assert_eq!(s2.clone().offer_anchor(a2, r, &p, LATE), Ok(true));
    // A schedule raised in a later release (a point appended) leaves this run as it was.
    let mut q = p.clone();
    q.floor = &[(T0, HARD), (T0 + 100 * DAY, 0x1e0f_ffff)];
    let r = run_of(&mut rng, T0 + step + HOUR, root(&s, &a), HALF_HARD, 600);
    assert_eq!(
        s.clone().offer_anchor(a.clone(), r.clone(), &q, LATE),
        Ok(true)
    );
    // Past the new point the floor is the new point's.
    let late = at(T0 + 100 * DAY, HALF_HARD, &mut rng);
    assert_eq!(late.check(&p, LATE), Ok(()));
    assert_eq!(late.check(&q, LATE), Err(Invalid::HeaderFloor));
}

#[test]
fn the_real_block_and_the_one_after_it() {
    // proofs.json holds blocks 976,177 and 976,178 only, not the five after those: the real pair is checked here,
    // the rest of a run is pretend (and so can't meet production's floor).
    let p = Params::PRODUCTION;
    let b = Header::from_bytes(&unhex(HEADER)).unwrap();
    let f = Header::from_bytes(&unhex(HEADER_976178)).unwrap();
    assert_eq!(f.prev(), b.hash(), "976,178 names 976,177");
    assert!(f.time() > b.time() && f.time() - b.time() < p.run_span);
    assert_eq!(f.check(&p, LATE), Ok(()));
    assert_eq!(b.check(&p, LATE), Ok(()));
    // Both meet production's floor at their time, with room: half of 976,177's difficulty.
    assert_eq!(
        super::header::floor(&p, b.time()),
        {
            let mut t = target(0x1702_1673).unwrap();
            let mut c = 0;
            for x in t.iter_mut().rev() {
                let n = *x >> 7;
                *x = (*x << 1) | c;
                c = n;
            }
            t
        },
        "twice its target"
    );
    // A run of the real two and five pretend: the link and spans hold (checked against a floor pretend headers
    // meet); against production's, the first pretend one is under the floor.
    let mut rng = Rng(45);
    let mut next = vec![f];
    let mut prev = f.hash();
    for k in 1..FOLLOWERS as u32 {
        let h = after(prev, f.time() + 600 * k, rng.bytes(), EASY);
        prev = h.hash();
        next.push(h);
    }
    let run = Run { block: b, next };
    assert_eq!(run.check(&params(), LATE), Ok(()));
    assert_eq!(run.check(&p, LATE), Err(Invalid::HeaderFloor));
    // The real block alone, as an anchor once was: refused.
    let lone = Run {
        block: b,
        next: vec![f],
    };
    assert_eq!(lone.check(&p, LATE), Err(Invalid::HeaderRun));
}

#[test]
fn two_runs_of_one_block_settle_on_the_same() {
    // One block, two sets of six after it (a fork among its followers): every node keeps the same, whatever came first.
    let mut w = World::new(46);
    let p = w.params.clone();
    let key = w.key(1, "test123");
    let s = w.entry(Kind::Claim, &key, "test123", [0; 32], T0 - HOUR);
    let (a, r1) = w.anchor(&s.id(), T0);
    let mut r2 = r1.clone();
    let mut prev = r2.block.hash();
    for h in r2.next.iter_mut() {
        *h = after(prev, h.time(), [9; 32], EASY);
        prev = h.hash();
    }
    assert_ne!(r1, r2);
    let mut x = s.clone();
    x.offer_anchor(a.clone(), r1.clone(), &p, LATE).unwrap();
    x.offer_anchor(a.clone(), r2.clone(), &p, LATE).unwrap();
    let mut y = s.clone();
    y.offer_anchor(a.clone(), r2.clone(), &p, LATE).unwrap();
    let only2 = y.clone();
    y.offer_anchor(a.clone(), r1.clone(), &p, LATE).unwrap();
    assert_eq!(x, y);
    // What a `get` says it holds tells the two apart, so servers holding one each exchange them.
    let mut only1 = s.clone();
    only1.offer_anchor(a, r1, &p, LATE).unwrap();
    assert_ne!(
        super::store::anchor_tag(&only1),
        super::store::anchor_tag(&only2)
    );
}
