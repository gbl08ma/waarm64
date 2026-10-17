//! webpc's tailnet client (docs/tailnet.md): the protocol state
//! of a node, sans I/O, for a browser worker that does the I/O. Built for
//! `wasm32-wasip1` so std's clocks and randomness work through a few WASI
//! imports the worker provides (`web/ts-wasi.ts`); natively for the tests.

pub mod cbor;
pub mod client;
pub mod control;
pub mod derp;
pub mod dns;
pub mod h2pipe;
pub mod ip;
pub mod nat46;
pub mod netmap;
pub mod noise;
pub mod store;
pub mod tailcat;
pub mod tailnet;

#[cfg(target_arch = "wasm32")]
mod wasm;
