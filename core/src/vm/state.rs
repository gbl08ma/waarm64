//! A VM's saved state (docs/abi.md "M8 phase C: snapshots"): everything but
//! guest RAM, which the host copies, in `snapshot`'s format. Both run modes
//! save one form, so a realtime snapshot restores under either.
//!
//! A snapshot is taken with every vCPU out of the core and the backends done
//! with every request they don't hold, so there is nothing in a ring to save.
//! Not in it: TLBs, code caches, parallel mode's maintenance queues and DSB
//! waits (a restored VM starts with empty TLBs and caches: nothing to
//! maintain), counters, exits, signal bits.

use super::*;
use crate::snapshot::{self, Error, Reader, Writer};

impl Vm {
    /// Whether the vCPUs have FEAT_RNG, whose streams a snapshot keeps: in
    /// realtime mode a restored VM goes on with its own key, so a machine
    /// loaded twice doesn't repeat its numbers; deterministic mode's runs
    /// through a snapshot repeat the run without one.
    fn rng(&self) -> bool {
        self.cfg.features & crate::cpu::FEATURE_RNG != 0
    }

    /// Empties every vCPU's TLB, with no vCPU in the core: what a restore does
    /// to translations, on a VM that runs on. Architecturally invisible, but
    /// not to a step count: Linux clears a page's access flag without a TLBI
    /// and takes the fault only once the entry is gone. The tests compare a
    /// run through snapshots with a run through these.
    pub fn flush_tlbs(&mut self) {
        self.vcpus.iter_mut().for_each(|v| v.tlb.flush_all());
    }

    /// The words of the configuration a snapshot is tied to: a VM restores
    /// only a snapshot taken on the same machine. `jit` is free (the tiers
    /// run the same machine), as are `smp` in realtime mode (one saved form),
    /// `rtc`'s value and the fw_cfg files (the snapshot's replace them).
    fn config_words(&mut self) -> Vec<u64> {
        let c = &self.cfg;
        let mut w = vec![
            c.ram_size,
            c.deterministic,
            c.cntfrq,
            c.ticks_per_insn,
            c.fb_width,
            c.fb_height,
            c.features,
            c.ncpus.max(1),
            c.has_rtc() as u64,
            c.firmware,
            c.flash_size,
        ];
        // Only on a machine with an xHCI: the others' states (and their snapshots) are as they were.
        if c.xhci != 0 {
            w.push(c.xhci);
        }
        // Only on a machine with spill memories (docs/spill-memories.md), likewise.
        if c.spill[0] != 0 {
            w.extend(c.spill.iter().take_while(|&&s| s != 0));
        }
        let virtio = &self.plat.get_mut().virtio;
        w.push(virtio.len() as u64);
        for t in virtio {
            let e = t.entry();
            w.extend([
                e.device_id,
                e.features,
                e.queues,
                e.queue_size,
                e.config_len,
            ]);
        }
        w
    }

    /// Gets the VM ready to be saved and returns its state's size: takes the
    /// completions the backends left, as the run loop would at its next
    /// boundary. 0 if the devices aren't quiet (that posted chains which
    /// hadn't fit a request ring, or the host hasn't served the doorbell):
    /// the host serves it and calls again. `u64::MAX` if the chains the
    /// backends hold couldn't be posted again by a restore: this VM can't be
    /// saved now.
    pub fn snapshot_size(&mut self) -> u64 {
        self.shared
            .signal
            .fetch_and(!SIGNAL_DEVICE, Ordering::AcqRel);
        let parallel = self.parallel();
        let ns = self.ns();
        let p = self.plat.get_mut();
        // New requests it posted (chains that hadn't fit) leave the device not quiet.
        complete(p, &self.mem, &self.shared, ns);
        // The xHCI's completions don't wait for their latency: nothing runs.
        if let (Some(x), Some(sh)) = (&mut p.xhci, &self.shared.xhci) {
            x.tick(ns, true, &self.mem, sh);
        }
        if parallel {
            // The interrupts of what completed, for vCPUs that idle.
            self.refresh_all();
        }
        // A device on the xHCI can't be in a snapshot: the host detaches it first (docs/usb.md).
        // Asked first: such a device may hold a TD for good, and never be quiet.
        if self
            .plat
            .get_mut()
            .xhci
            .as_ref()
            .is_some_and(|x| !x.saveable())
        {
            return u64::MAX;
        }
        if !self.quiet() {
            return 0;
        }
        let p = self.plat.get_mut();
        if !p.virtio.iter_mut().all(|t| t.repostable(&self.mem)) {
            return u64::MAX;
        }
        self.state().len() as u64
    }

    /// Whether every device is quiet (`Transport::quiet`).
    fn quiet(&mut self) -> bool {
        let p = self.plat.get_mut();
        p.virtio
            .iter()
            .zip(&self.shared.devices)
            .all(|(t, sh)| t.quiet(sh))
            && match (&p.xhci, &self.shared.xhci) {
                (Some(x), Some(sh)) => x.quiet(sh),
                _ => true,
            }
    }

    /// The VM's state, or `None` while a device isn't quiet
    /// ([`Vm::snapshot_size`] says when it is). Changes nothing but the realtime clock, held at the reading it saves until a vCPU runs again.
    pub fn snapshot_save(&mut self) -> Option<Vec<u8>> {
        self.quiet().then(|| self.state())
    }

    fn state(&mut self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(snapshot::MAGIC);
        w.u32(snapshot::VERSION);
        let config = self.config_words();
        w.u32(config.len() as u32);
        config.iter().for_each(|&v| w.u64(v));
        // Time.
        w.u64(self.steps);
        w.u64(self.skipped);
        w.u32(self.cur as u32);
        // One vCPU has no quantum (it only counts down from `u64::MAX`).
        w.u64(if self.vcpus.len() > 1 {
            self.quantum
        } else {
            u64::MAX
        });
        // Held there: the saved VM runs on from this reading, as one restored from it does.
        w.u64(if self.realtime() {
            self.clock.hold()
        } else {
            0
        });
        // The vCPUs.
        for c in 0..self.vcpus.len() {
            self.vcpus[c].cpu.save(&mut w);
            let (on, wait, event, start) = if self.parallel() {
                let (on, wfi, start) = self.sched_par(c);
                (on, if wfi { Wait::Wfi } else { Wait::No }, false, start)
            } else {
                // A start is a woken SYSTEM_SUSPEND's (`wake_suspended`) the next run hasn't taken.
                let s = self.sched[c];
                let start = self.plat.get_mut().start[c];
                (s.power == Power::On, s.wait, s.event, start)
            };
            w.bool(on);
            w.u8(match wait {
                Wait::No => 0,
                Wait::Wfi => 1,
                Wait::Woken => 2,
            });
            w.bool(event);
            w.bool(start.is_some());
            let (entry, context) = start.unwrap_or_default();
            w.u64(entry);
            w.u64(context);
        }
        // Where each vCPU's RNDR stream stands (its key is the restoring VM's).
        if self.rng() {
            self.vcpus.iter().for_each(|v| w.u64(v.rng.counter));
        }
        // The devices.
        let p = self.plat.get_mut();
        p.gic.save(&mut w);
        p.uart.save(&mut w, &self.shared.console);
        if let Some(rtc) = &p.rtc {
            rtc.save(&mut w);
        }
        if let Some(flash) = &p.flash {
            flash.save(&mut w);
        }
        if let Some(fw_cfg) = &p.fw_cfg {
            fw_cfg.save(&mut w);
        }
        for (t, sh) in p.virtio.iter().zip(&self.shared.devices) {
            t.save(&mut w, sh);
        }
        if let Some(x) = &p.xhci {
            x.save(&mut w);
        }
        // A guest in PSCI SYSTEM_SUSPEND, last and only then (a state from before it had none).
        if let Some((c, entry, context)) = p.suspended {
            w.u32(c as u32);
            w.u64(entry);
            w.u64(context);
        }
        w.0
    }

    /// Restores a state [`Vm::snapshot_save`] wrote into this VM, which is
    /// fresh from [`Vm::with_devices`] with the same configuration and has
    /// guest RAM as it was saved (the transports read their in-flight chains
    /// from it and post them to the request rings again). After an error the
    /// VM is only good for dropping.
    pub fn snapshot_restore(&mut self, state: &[u8]) -> snapshot::Result<()> {
        let mut r = Reader(state);
        if r.u32().map_err(|_| Error::Format)? != snapshot::MAGIC {
            return Err(Error::Format);
        }
        let version = r.u32().map_err(|_| Error::Format)?;
        if !(snapshot::VERSION_MIN..=snapshot::VERSION).contains(&version) {
            return Err(Error::Format);
        }
        let config = self.config_words();
        if r.u32()? as usize != config.len() {
            return Err(Error::Config);
        }
        for &v in &config {
            if r.u64()? != v {
                return Err(Error::Config);
            }
        }
        let n = self.vcpus.len();
        // Time.
        let (steps, skipped) = (r.u64()?, r.u64()?);
        let (cur, quantum, ns) = (r.u32()? as usize, r.u64()?, r.u64()?);
        let counter = steps
            .checked_mul(self.cfg.ticks_per_insn)
            .and_then(|t| t.checked_add(skipped));
        if counter.is_none_or(|t| t >= TIME_MAX) || ns >= TIME_MAX || cur >= n {
            return Err(Error::Corrupt);
        }
        (self.steps, self.skipped, self.cur) = (steps, skipped, cur);
        self.quantum = if n > 1 {
            quantum.min(QUANTUM)
        } else {
            u64::MAX
        };
        if self.realtime() {
            self.clock = Clock::from(ns);
        }
        // The vCPUs.
        let mut scheds = Vec::with_capacity(n);
        for c in 0..n {
            self.vcpus[c].cpu.restore(&mut r)?;
            let on = r.bool()?;
            let wait = match r.u8()? {
                0 => Wait::No,
                1 => Wait::Wfi,
                // Only virtual time jumps to a deadline.
                2 if !self.realtime() => Wait::Woken,
                _ => return Err(Error::Corrupt),
            };
            let event = r.bool()?;
            let start = r.bool()?;
            let (entry, context) = (r.u64()?, r.u64()?);
            // A CPU_ON request is for a vCPU that is off (parallel mode, or a woken SYSTEM_SUSPEND).
            if start && (on || !self.realtime()) {
                return Err(Error::Corrupt);
            }
            scheds.push((on, wait, event, start.then_some((entry, context))));
        }
        if self.rng() {
            for v in &mut self.vcpus {
                v.rng.counter = r.u64()?;
            }
        }
        // The devices.
        let host = self.realtime().then_some((self.cfg.rtc, self.clock.ns()));
        let p = self.plat.get_mut();
        p.gic.restore(&mut r)?;
        p.uart.restore(&mut r, &self.shared.console)?;
        if let Some(rtc) = &mut p.rtc {
            rtc.restore(&mut r, host)?;
        }
        if let Some(flash) = &mut p.flash {
            flash.restore(&mut r)?;
        }
        if let Some(fw_cfg) = &mut p.fw_cfg {
            fw_cfg.restore(&mut r)?;
        }
        for (t, sh) in p.virtio.iter_mut().zip(&self.shared.devices) {
            t.restore(&mut r, &self.mem, sh)?;
        }
        if let Some(x) = &mut p.xhci {
            x.restore(&mut r, version)?;
        }
        if !r.0.is_empty() {
            let (c, entry, context) = (r.u32()? as usize, r.u64()?, r.u64()?);
            // Only one that suspended it may be (every vCPU off), and only from a CPU_ON-free state.
            if c >= n
                || scheds
                    .iter()
                    .any(|&(on, _, _, start)| on || start.is_some())
            {
                return Err(Error::Corrupt);
            }
            p.suspended = Some((c, entry, context));
            self.shared.suspended.store(true, Ordering::Release);
        }
        r.end()?;
        // Each vCPU's place in its run loop.
        for (c, (on, wait, event, start)) in scheds.into_iter().enumerate() {
            if self.parallel() {
                self.set_sched_par(c, on, wait == Wait::Wfi, start);
                continue;
            }
            self.sched[c] = Sched {
                power: if on { Power::On } else { Power::Off },
                wait,
                event,
            };
            // Round-robin starts a vCPU within the CPU_ON call.
            if let Some((entry, context)) = start {
                self.cpu_on(c, entry, context);
            }
        }
        if self.parallel() {
            self.refresh_all();
        } else {
            self.publish();
        }
        Ok(())
    }
}
