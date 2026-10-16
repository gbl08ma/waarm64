//! The Tailscale client (docs/plans/tailnet-client.md §5), sans I/O like the tailcat one
//! (client.rs), whose actions it shares: the control session (control.rs) and, on top of the
//! netmap it keeps, the data plane.

use std::{collections::BTreeMap, time::Instant};

use serde_json::json;

use crate::{
    client::Action,
    control::{self, Phase, Session, Update},
    store::Store,
};

pub const MTU: usize = 1280;

pub struct Config {
    pub control: control::Config,
    /// The kept node: the store's entries (`<StateKey>` → bytes).
    pub state: BTreeMap<String, Vec<u8>>,
    /// A peer's stable ID to use as the exit node ('' for none).
    pub exit_node: String,
}

pub struct Client {
    session: Session,
    exit_node: String,
    /// The state the page last heard (Go's `ipn.State` names).
    state: &'static str,
    actions: std::collections::VecDeque<Action>,
}

impl Client {
    pub fn new(cfg: Config, now: Instant) -> Result<Self, String> {
        if cfg.control.url.trim().is_empty() {
            return Err("no control server".into());
        }
        let mut disco = [0u8; 32];
        getrandom::fill(&mut disco).map_err(|e| format!("no randomness: {e}"))?;
        let disco_public = *crypto_box::SecretKey::from(disco).public_key().as_bytes();
        let mut c = Client {
            session: Session::new(cfg.control, Store::new(cfg.state), disco_public),
            exit_node: cfg.exit_node,
            state: "",
            actions: Default::default(),
        };
        c.set_state("Starting");
        c.session.start(now);
        c.after(now);
        Ok(c)
    }

    fn event(&mut self, v: serde_json::Value) {
        self.actions.push_back(Action::Event(v.to_string()));
    }

    fn set_state(&mut self, s: &'static str) {
        if self.state != s {
            self.state = s;
            self.event(json!({ "type": "state", "state": s }));
        }
    }

    /// Takes in what the session did.
    fn after(&mut self, _now: Instant) {
        self.actions.extend(self.session.actions.drain(..));
        for u in std::mem::take(&mut self.session.updates) {
            match u {
                Update::Phase(Phase::NeedsLogin) => self.set_state("NeedsLogin"),
                Update::Phase(Phase::LoggedOut) => {
                    self.set_state("NeedsLogin");
                    self.event(json!({ "type": "loggedout" }));
                }
                Update::Phase(_) => {}
                Update::Failed(why) => {
                    self.event(json!({ "type": "state", "state": "Failed", "error": why }));
                    self.state = "Failed";
                }
                Update::Map(c) => {
                    if c.node || c.peers || c.dns {
                        let nm = self.session.netmap.page_json(MTU, &self.exit_node);
                        if !nm.is_null() {
                            self.event(json!({ "type": "netmap", "netmap": nm }));
                            self.set_state("Running");
                        }
                    }
                }
            }
        }
    }

    pub fn fetched(&mut self, id: u32, ok: bool, body: &[u8], now: Instant) {
        if id == control::KEY_FETCH {
            self.session.fetched(ok, body, now);
        }
        self.after(now);
    }

    pub fn ws_message(&mut self, conn: u32, data: &[u8], now: Instant) {
        if self.session.owns(conn) {
            self.session.ws_message(conn, data, now);
        }
        self.after(now);
    }

    pub fn ws_closed(&mut self, conn: u32, now: Instant) {
        if self.session.owns(conn) {
            self.session.ws_closed(conn, now);
        }
        self.after(now);
    }

    pub fn guest_packet(&mut self, _p: &[u8], _now: Instant) {}

    pub fn tick(&mut self, now: Instant) {
        self.session.tick(now);
        self.after(now);
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.session.deadline()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    pub fn logout(&mut self, now: Instant) {
        self.session.logout(now);
        self.after(now);
    }

    pub fn close(&mut self) {
        self.session.close();
        self.actions.extend(self.session.actions.drain(..));
    }
}
