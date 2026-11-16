//! Registered names in a room (docs/plans/room-names.md), the records and the rules: pure, no
//! I/O, nothing exported from the module yet.
//!
//! - [`id`]: a name's rules (one label, the reserved list), its id (BLAKE2s keyed with a key from
//!   the room's ID), the room's value that signatures take, and an owner key per name.
//! - [`entry`]: `claim`, `renew` and `release`: 207 bytes, a BIP-340 signature over a tagged hash
//!   that takes the room's value, and Argon2id proof of work salted with `ref`; [`entry::Stamped`]
//!   is an entry checked, with its headers, its one anchor (the earliest) and at most one pending.
//! - [`anchor`]: an OpenTimestamps verifier written from the format (append, prepend, SHA-256 and
//!   the Bitcoin attestation; anything else invalid; 4 KiB at most), and pending anchors.
//! - [`header`]: an 80-byte Bitcoin header: its hash, its work against its own target, that
//!   target against a compiled floor, its time not past now by more than [`Params::drift`].
//! - [`zone`]: where a name points, 4 or 16 slots sealed under the full name and `seq`.
//! - [`chain`]: unbroken runs, cover, seniority, the owner now (a total order: forks and
//!   releases), and what a member keeps.
//!
//! Times are Unix seconds: an entry's is its anchor's block header's; `now` is the caller's
//! clock.

pub mod anchor;
pub mod chain;
pub mod entry;
pub mod header;
pub mod id;
pub mod server;
pub mod store;
pub mod wire;
pub mod zone;

#[cfg(test)]
mod server_tests;
#[cfg(test)]
pub(crate) mod testkit;
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
    /// The floor: the easiest target (Bitcoin's compact form) a header may claim.
    pub floor: u32,
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
    /// The spec's values (N0, provisional). The floor is 1/16 of the difficulty of block 976,177
    /// (2026-11-16, bits `0x17021673`): sixteen times its target.
    pub const PRODUCTION: Params = Params {
        term: 30 * DAY,
        grace: 7 * DAY,
        ref_window: 48 * HOUR,
        drift: 2 * HOUR,
        pending_slack: 4 * HOUR,
        floor: 0x1721_6730,
        pow_m_kib: 1024,
        pow_t: 1,
        pow_p: 1,
        pow_bits: 16,
    };
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
