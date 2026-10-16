//! webpc's tailnet client (docs/plans/tailnet-client.md): the protocol state
//! of a node, sans I/O, for a browser worker that does the I/O. Built for
//! `wasm32-wasip1` so std's clocks and randomness work through a few WASI
//! imports the worker provides (`web/ts-wasi.ts`); natively for the tests.

pub mod cbor;
pub mod client;
pub mod derp;
pub mod nat46;
pub mod tailcat;

#[cfg(target_arch = "wasm32")]
mod wasm;
