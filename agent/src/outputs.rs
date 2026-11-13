//! The screen's size on a Wayland compositor (DISPLAY: docs/devices.md "The guest's agent"): wlr-output-management
//! (`zwlr_output_manager_v1`, version 1, as `wlr-randr` speaks it; sway and other wlroots compositors have it) on the
//! session child's connection (src/session.rs), by hand. No program of the guest's is run: the compositor is told
//! directly, and one without the protocol (GNOME's, KDE's: expected to follow the display's size by themselves) is left
//! alone.
//!
//! The manager introduces its heads (an output each) and their modes, then `done` with a serial. Whenever the page's size
//! is known and an enabled head's current mode isn't that size, a configuration under the last serial enables each
//! enabled head at a custom mode of the page's size (the kernel's mode list isn't waited for: sway keeps its own once an
//! output is connected, docs/graphics.md "The console and the display size"), disables the disabled ones as they are,
//! and applies. The compositor answers succeeded (its heads' new state and a `done` follow), failed (logged; not tried
//! again until the size changes), or cancelled (its state changed under the serial: tried again at the next `done`).
//! One configuration is in flight at a time.

use crate::log;
use crate::prelude::*;
use crate::session::{Obj, Wl};
use crate::wire::Args;
use alloc::collections::BTreeMap;

/// The manager's interface, as the registry names it.
pub const MANAGER: &str = "zwlr_output_manager_v1";

/// Opcodes (wlr-output-management-unstable-v1.xml).
mod op {
    // The manager: requests, events.
    pub const CREATE_CONFIGURATION: u16 = 0;
    pub const HEAD: u16 = 0;
    pub const DONE: u16 = 1;
    pub const FINISHED: u16 = 2;
    // A head's events.
    pub const NAME: u16 = 0;
    pub const MODE: u16 = 3;
    pub const ENABLED: u16 = 4;
    pub const CURRENT_MODE: u16 = 5;
    pub const HEAD_FINISHED: u16 = 9;
    // A mode's events.
    pub const SIZE: u16 = 0;
    pub const MODE_FINISHED: u16 = 3;
    // A configuration: requests, events.
    pub const ENABLE_HEAD: u16 = 0;
    pub const DISABLE_HEAD: u16 = 1;
    pub const APPLY: u16 = 2;
    pub const DESTROY: u16 = 4;
    pub const SUCCEEDED: u16 = 0;
    pub const FAILED: u16 = 1;
    pub const CANCELLED: u16 = 2;
    // A configuration's head.
    pub const SET_CUSTOM_MODE: u16 = 1;
    // wl_registry.
    pub const BIND: u16 = 0;
}

/// The registry's id (session.rs makes it first).
const REGISTRY: u32 = 2;

#[derive(Default)]
struct Head {
    name: String,
    enabled: bool,
    current: Option<u32>,
}

/// What a connection knows of the compositor's outputs.
#[derive(Default)]
pub struct Outputs {
    /// The manager's global (its name in the registry), and our manager once bound.
    pub global: Option<u32>,
    manager: Option<u32>,
    heads: BTreeMap<u32, Head>,
    /// Each mode's size.
    modes: BTreeMap<u32, (i32, i32)>,
    /// The serial of the last `done`: the state a configuration is made against.
    serial: Option<u32>,
    /// The configuration in flight.
    config: Option<u32>,
    /// The size last asked for (succeeded or failed): not asked again until the page's size changes, so that a
    /// compositor that takes another size than asked isn't asked forever.
    asked: Option<(u32, u32)>,
    /// Logged once a connection: the compositor has no output management.
    told: bool,
}

impl Wl {
    /// Binds the output manager, if the compositor has one (the globals are all known).
    pub(crate) fn bind_outputs(&mut self) {
        let Some(name) = self.outputs.global else {
            if !self.outputs.told {
                self.outputs.told = true;
                log(
                    "session: the compositor has no zwlr_output_manager_v1: its outputs are left to it",
                    None,
                );
            }
            return;
        };
        if self.outputs.manager.is_some() {
            return;
        }
        let id = self.id(Obj::OutManager);
        self.msg(REGISTRY, op::BIND)
            .uint(name)
            .string(MANAGER)
            .uint(1)
            .object(id)
            .done();
        self.outputs.manager = Some(id);
    }

    /// An event on an output object of ours (`kind`).
    pub(crate) fn output_event(&mut self, kind: Obj, object: u32, opcode: u16, mut a: Args<'_>) {
        let o = &mut self.outputs;
        match (kind, opcode) {
            (Obj::OutManager, op::HEAD) => {
                if let Some(id) = a.object() {
                    self.objs.insert(id, Obj::Head);
                    o.heads.insert(id, Head::default());
                }
            }
            (Obj::OutManager, op::DONE) => o.serial = a.uint(),
            (Obj::OutManager, op::FINISHED) => {
                // The compositor stopped sending its outputs' state: nothing more is asked of it.
                self.objs.insert(object, Obj::Dead);
                o.manager = None;
                o.serial = None;
            }
            (Obj::Head, op::NAME) => {
                if let (Some(Some(n)), Some(h)) = (a.string(), o.heads.get_mut(&object)) {
                    h.name = n.to_owned();
                }
            }
            (Obj::Head, op::MODE) => {
                if let Some(id) = a.object() {
                    self.objs.insert(id, Obj::Mode);
                    o.modes.insert(id, (0, 0));
                }
            }
            (Obj::Head, op::ENABLED) => {
                if let (Some(e), Some(h)) = (a.uint(), o.heads.get_mut(&object)) {
                    h.enabled = e != 0;
                    if !h.enabled {
                        h.current = None;
                    }
                }
            }
            (Obj::Head, op::CURRENT_MODE) => {
                if let (Some(m), Some(h)) = (a.object(), o.heads.get_mut(&object)) {
                    h.current = Some(m);
                }
            }
            (Obj::Head, op::HEAD_FINISHED) => {
                o.heads.remove(&object);
                self.objs.remove(&object);
            }
            (Obj::Mode, op::SIZE) => {
                if let (Some(w), Some(h)) = (a.uint(), a.uint()) {
                    o.modes.insert(object, (w as i32, h as i32));
                }
            }
            (Obj::Mode, op::MODE_FINISHED) => {
                o.modes.remove(&object);
                self.objs.remove(&object);
            }
            (Obj::OutConfig, op::SUCCEEDED | op::FAILED | op::CANCELLED) => {
                self.msg(object, op::DESTROY).done();
                self.objs.insert(object, Obj::Dead);
                let o = &mut self.outputs;
                o.config = None;
                match opcode {
                    op::SUCCEEDED => {
                        if let Some((w, h)) = o.asked {
                            log(&format!("session: the outputs set to {w}x{h}"), None);
                        }
                    }
                    op::FAILED => {
                        if let Some((w, h)) = o.asked {
                            log(
                                &format!("session: the compositor refused the outputs at {w}x{h}"),
                                None,
                            );
                        }
                    }
                    // Its state changed under the serial: asked again at the next `done`.
                    _ => o.asked = None,
                }
            }
            _ => {}
        }
    }

    /// Sets the enabled outputs to `size` unless they have it, a configuration is in flight, or it was asked already.
    pub(crate) fn resize(&mut self, size: (u32, u32)) {
        let o = &mut self.outputs;
        let (Some(manager), Some(serial)) = (o.manager, o.serial) else {
            return;
        };
        if o.config.is_some() || o.asked == Some(size) {
            return;
        }
        let (w, h) = (size.0 as i32, size.1 as i32);
        let at_size = |h_: &Head| {
            h_.current
                .and_then(|m| o.modes.get(&m))
                .is_some_and(|&m| m == (w, h))
        };
        let enabled: Vec<u32> = o
            .heads
            .iter()
            .filter(|(_, h)| h.enabled)
            .map(|(&id, _)| id)
            .collect();
        if enabled.is_empty() || o.heads.values().filter(|h| h.enabled).all(at_size) {
            return;
        }
        let disabled: Vec<u32> = o
            .heads
            .iter()
            .filter(|(_, h)| !h.enabled)
            .map(|(&id, _)| id)
            .collect();
        let names: Vec<String> = enabled.iter().map(|id| o.heads[id].name.clone()).collect();
        o.asked = Some(size);
        let config = self.id(Obj::OutConfig);
        self.msg(manager, op::CREATE_CONFIGURATION)
            .object(config)
            .uint(serial)
            .done();
        for head in enabled {
            // Its configuration head has no events and no destructor: it goes with the configuration.
            let ch = self.id(Obj::Dead);
            self.msg(config, op::ENABLE_HEAD)
                .object(ch)
                .object(head)
                .done();
            self.msg(ch, op::SET_CUSTOM_MODE)
                .uint(w as u32)
                .uint(h as u32)
                .uint(0)
                .done();
        }
        for head in disabled {
            self.msg(config, op::DISABLE_HEAD).object(head).done();
        }
        self.msg(config, op::APPLY).done();
        self.outputs.config = Some(config);
        log(
            &format!("session: asking for {w}x{h} on {}", names.join(", ")),
            None,
        );
    }
}
