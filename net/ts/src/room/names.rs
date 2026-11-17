//! Registered names in a room (docs/plans/room-names.md): the records and the rules, and the registry's two sides, sans
//! I/O (room.rs carries them through names clients).
//!
//! - [`id`]: a name's rules (one label, the reserved list), its id (BLAKE2s keyed with a key from
//!   the room's ID), the room's value that signatures take, and an owner key per name.
//! - [`entry`]: `claim`, `renew` and `release`: 207 bytes, a BIP-340 signature over a tagged hash
//!   that takes the room's value, and Argon2id proof of work salted with `ref`; [`entry::Stamped`]
//!   is an entry checked, with its headers, its one anchor (the earliest) and at most one pending.
//! - [`anchor`]: an OpenTimestamps verifier written from the format (append, prepend, SHA-256 and
//!   the Bitcoin attestation; anything else invalid; 4 KiB at most), and pending anchors.
//! - [`header`]: an 80-byte Bitcoin header: its hash, its work against its own target, that
//!   target against the compiled floor at its own time, its time not past now by more than
//!   [`Params::drift`]; an anchor's block's header and the six after it, linked.
//! - [`zone`]: where a name points, 4 or 16 slots sealed under the full name and `seq`.
//! - [`chain`]: unbroken runs, cover, seniority, the owner now (a total order: forks and
//!   releases), and what a member keeps.
//! - [`wire`], [`store`], [`server`]: what the registry sends, what a server holds, a server's side.
//! - [`member`]: a member's side: what the resolver asks for a name that isn't a key, and what it keeps.
//!
//! Times are Unix seconds: an entry's is its anchor's block header's; `now` is the caller's
//! clock.

pub mod anchor;
pub mod chain;
pub mod entry;
pub mod header;
pub mod id;
pub mod member;
pub mod server;
pub mod store;
pub mod wire;
pub mod zone;

#[cfg(test)]
mod member_tests;
#[cfg(test)]
mod server_tests;
#[cfg(any(test, feature = "test-params"))]
pub mod testkit;
#[cfg(test)]
mod tests;

/// The clock's and the proof of work's parameters (room-names.md "Who owns a name", "Records",
/// "Bitcoin as the clock"). [`Params::PRODUCTION`] is the spec's; tests run a pretend Bitcoin of
/// easy headers and cheap proof of work through their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    /// An entry at time `t` holds its name until `t + term`...
    pub term: u32,
    /// ...and keeps it from others until `t + term + grace`.
    pub grace: u32,
    /// The latest an entry's anchor may be, from its `ref` block's time.
    pub ref_window: u32,
    /// How far block times may run ahead: a header's time may be this far past now, and an
    /// anchor this far before its `ref` block's time.
    pub drift: u32,
    /// A pending anchor is dropped once now is past `ref`'s time + `ref_window` + this: a block's
    /// time can trail the moment it was mined, and a calendar serves a proof six blocks later.
    pub pending_slack: u32,
    /// The floor by header time (header.rs `floor`): points of (Unix seconds, the easiest target a header of that
    /// time may claim in Bitcoin's compact form), earliest first. A release only appends points (at past times, about
    /// half of the difficulty then), so a header that met the floor once still does.
    pub floor: &'static [(u32, u32)],
    /// Past a point, its target doubles every `floor_step` seconds...
    pub floor_step: u32,
    /// ...`floor_steps` times at most.
    pub floor_steps: u32,
    /// An anchor's followers are timed at most this far past its block (and at most `drift` before it).
    pub run_span: u32,
    /// Argon2id's memory in KiB, passes and lanes.
    pub pow_m_kib: u32,
    pub pow_t: u32,
    pub pow_p: u32,
    /// The leading zero bits an entry's proof of work needs.
    pub pow_bits: u32,
}

const HOUR: u32 = 3600;
const DAY: u32 = 24 * HOUR;

impl Params {
    /// The spec's values (N0, provisional). The floor's one point is half of the difficulty of block 976,177
    /// (2026-11-16 19:25:21 UTC, bits `0x17021673`): twice its target; past it the floor halves every 21 days, five
    /// times at most, to 1/64 of that block's difficulty (room-names.md "Bitcoin as the clock").
    pub const PRODUCTION: Params = Params {
        term: 30 * DAY,
        grace: 7 * DAY,
        ref_window: 48 * HOUR,
        drift: 2 * HOUR,
        pending_slack: 4 * HOUR,
        floor: &[(1_794_857_121, 0x1704_2ce6)],
        floor_step: 21 * DAY,
        floor_steps: 5,
        run_span: 12 * HOUR,
        pow_m_kib: 1024,
        pow_t: 1,
        pow_p: 1,
        pow_bits: 16,
    };

    /// The tests' pretend Bitcoin: the spec's clock with cheap proof of work (8 KiB, 2 bits) and a floor any pretend
    /// header meets (regtest's target). Compiled only into the tests and a `test-params` build.
    #[cfg(any(test, feature = "test-params"))]
    pub const TEST: Params = Params {
        floor: &[(0, 0x207f_ffff)],
        pow_m_kib: 8,
        pow_bits: 2,
        ..Params::PRODUCTION
    };

    /// What the module runs on (wasm.rs): production's. A build with the `test-params` feature (the page tests' module,
    /// target/net/ts-test.wasm, never shipped) runs on [`Params::TEST`] instead; no configuration chooses them.
    #[cfg(not(feature = "test-params"))]
    pub const BUILT: Params = Params::PRODUCTION;
    #[cfg(feature = "test-params")]
    pub const BUILT: Params = Params::TEST;

    /// What the room's `self` event says the module runs on: `production`, or `test`.
    pub fn label(&self) -> &'static str {
        if *self == Params::PRODUCTION {
            "production"
        } else {
            "test"
        }
    }
}

/// Why a record is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    /// Not the format: wrong length, version, kind or a field out of range.
    Encoding,
    /// A claim that names an entry before it, or a renewal or release that names none.
    Prev,
    /// Another room's record.
    Room,
    /// Another name's record.
    Name,
    Signature,
    /// Its proof of work falls short.
    Work,
    /// A header whose hash isn't under its own target, or whose target is malformed.
    HeaderWork,
    /// A header whose target is easier than the floor.
    HeaderFloor,
    /// A header whose time is too far past now.
    HeaderFuture,
    /// An anchor's block without the six headers after it: fewer or more, one that doesn't name the one before, or
    /// one timed outside the block's span.
    HeaderRun,
    /// The header given for `ref` isn't `ref`'s block.
    RefHeader,
    /// An anchor that isn't one: an operation or attestation other than the four, too big, or
    /// bytes after it.
    AnchorFormat,
    /// An anchor that doesn't reach its header's Merkle root.
    AnchorRoot,
    /// An anchor whose block's time is outside its `ref`'s window.
    AnchorWindow,
    /// A zone without room for what it is asked to hold, or a label that isn't one.
    Zone,
}

/// `N` bytes of `b` from `at` (the caller checked the length).
fn arr<const N: usize>(b: &[u8], at: usize) -> [u8; N] {
    b[at..at + N].try_into().unwrap()
}
