//! The screen's size on an X server (DISPLAY: docs/devices.md "The guest's agent"): RandR 1.2 by hand on the session
//! child's X connection (src/x11.rs), for an X11 session (one with no Wayland compositor: Xwayland's outputs, a
//! compositor's to set, are left alone). No program of the guest's is run (no `xrandr`).
//!
//! When the page's size is known (and differs from the one last asked for): GetScreenResources (which has the server
//! probe its outputs: a kernel's mode of the new size, after the display event, is found), GetOutputInfo of each
//! output and GetGeometry of the root (the screen's size now). The output is the first connected one with a CRTC whose
//! name isn't Xwayland's; its mode the first of the output's own of the page's size, else any of the server's of that
//! size, else one made (CreateMode, named `WxH` as xrandr's `--newmode` habit has it, with CVT-like timings: the
//! virtual GPU reads none), which AddOutputMode gives the output. Then the screen is grown to hold the CRTC if it must
//! (SetScreenSize), the CRTC set (SetCrtcConfig at 0,0 with the mode, no rotation, the one output), and the screen
//! sized to the mode (its millimetres at 96 dpi). One such run at a time; a size that comes meanwhile runs after it.

use super::{Want, X, op, u16_at, u32_at};
use crate::log;
use crate::prelude::*;

/// RandR's minor opcodes.
mod minor {
    pub const QUERY_VERSION: u8 = 0;
    pub const SET_SCREEN_SIZE: u8 = 7;
    pub const GET_SCREEN_RESOURCES: u8 = 8;
    pub const GET_OUTPUT_INFO: u8 = 9;
    pub const CREATE_MODE: u8 = 16;
    pub const DESTROY_MODE: u8 = 17;
    pub const ADD_OUTPUT_MODE: u8 = 18;
    pub const DELETE_OUTPUT_MODE: u8 = 19;
    pub const SET_CRTC_CONFIG: u8 = 21;
}

/// The core's GetGeometry.
const GET_GEOMETRY: u8 = 14;
/// A size whose SetCrtcConfig is refused for a stale time (the configuration changed under the run: the display event's
/// probe, which the page's DISPLAY races) is tried again this many times.
const RETRIES: u8 = 3;

/// SetCrtcConfig's rotation: none.
const ROTATE_0: u16 = 1;

/// A reply of RandR's awaited.
#[derive(Clone, Copy, Debug)]
pub enum Step {
    Extension,
    Version,
    Resources,
    Output(u32),
    Geometry,
    Created,
    Crtc,
}

/// A mode the server has: its id and size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Mode {
    id: u32,
    width: u16,
    height: u16,
}

/// What a run has learnt so far.
#[derive(Default)]
struct Run {
    /// Its number (`Randr::runs`): its requests' replies say it, so that one a run that ended (an error mid-run) left
    /// awaited doesn't fill the next's.
    id: u32,
    size: (u32, u32),
    /// GetScreenResources answered.
    resources: bool,
    config_time: u32,
    modes: Vec<(Mode, String)>,
    outputs_left: usize,
    /// The output chosen, its CRTC, and its own modes.
    output: Option<(u32, u32, Vec<u32>)>,
    /// An output Xwayland's (none other chosen: the compositor's to set).
    xwayland: bool,
    /// The root's size now.
    screen: Option<(u16, u16)>,
    /// The output and the mode the run set; whether it made the mode.
    set: Option<(u32, u32)>,
    made: bool,
}

#[derive(Default)]
pub struct Randr {
    /// The job: the screen's size followed (the child's `Jobs::resize`).
    pub on: bool,
    major: Option<u8>,
    /// RandR 1.2 or later is there.
    ok: bool,
    /// The page's size, and the one last asked for (not again until the page's changes).
    want: Option<(u32, u32)>,
    asked: Option<(u32, u32)>,
    run: Option<Run>,
    /// The runs begun (the last one's `id`).
    runs: u32,
    told: bool,
    /// Tries again of the size asked (`RETRIES`).
    tries: u8,
    /// The mode made last (and its output), deleted once the screen is set to another: each size the window had would
    /// otherwise leave one behind.
    made: Option<(u32, u32)>,
}

impl Randr {
    pub fn new(on: bool) -> Randr {
        Randr {
            on,
            ..Default::default()
        }
    }

    /// The run under way's number (0: none).
    fn run_id(&self) -> u32 {
        self.run.as_ref().map_or(0, |r| r.id)
    }

    /// Whether a reply (or error) of `step` for run `run` is the run under way's (RandR's setup's are always taken).
    fn current(&self, run: u32, step: Step) -> bool {
        matches!(step, Step::Extension | Step::Version) || (run != 0 && run == self.run_id())
    }

    /// SetCrtcConfig answered `status` (not Success): true if the size is to be asked again (InvalidConfigTime or
    /// InvalidTime, `RETRIES` times at most), as Wayland's `cancelled` is.
    fn refused(&mut self, status: u8) -> bool {
        if matches!(status, 1 | 2) && self.tries < RETRIES {
            self.tries += 1;
            self.asked = None;
            return true;
        }
        false
    }
}

/// CVT-like timings for a mode of `w`×`h` at 60 Hz: ModeInfo's fields after the size (dot clock in Hz, then
/// hsync start, end, total, skew, vsync start, end, total).
pub fn timings(w: u16, h: u16) -> (u32, [u16; 7]) {
    let (hs, he, ht) = (w + 48, w + 80, w + 160);
    let (vs, ve, vt) = (h + 3, h + 7, h + 25);
    let clock = ht as u64 * vt as u64 * 60;
    (clock as u32, [hs, he, ht, 0, vs, ve, vt])
}

impl X {
    /// At the setup: RandR asked for.
    pub(super) fn randr_start(&mut self) {
        self.req(
            op::QUERY_EXTENSION,
            0,
            Some(Want::Randr(0, Step::Extension)),
            |r| r.u16(5).u16(0).bytes(b"RANDR"),
        );
    }

    /// The page's size: set, once RandR is known, unless asked already.
    pub fn resize(&mut self, size: (u32, u32)) {
        if !self.randr.on {
            return;
        }
        if self.randr.want != Some(size) {
            self.randr.tries = 0;
        }
        self.randr.want = Some(size);
        self.randr_go();
    }

    fn randr_go(&mut self) {
        let r = &self.randr;
        let (Some(major), Some(want)) = (r.major, r.want) else {
            return;
        };
        if !r.ok || r.run.is_some() || r.asked == Some(want) {
            return;
        }
        let root = self.root;
        self.randr.asked = Some(want);
        self.randr.runs = self.randr.runs.wrapping_add(1).max(1);
        self.randr.run = Some(Run {
            id: self.randr.runs,
            size: want,
            ..Run::default()
        });
        self.req(
            major,
            minor::GET_SCREEN_RESOURCES,
            Some(Want::Randr(self.randr.run_id(), Step::Resources)),
            |r| r.u32(root),
        );
        self.req(
            GET_GEOMETRY,
            0,
            Some(Want::Randr(self.randr.run_id(), Step::Geometry)),
            |r| r.u32(root),
        );
    }

    /// A run ends (done, refused, or an error): the next size, if one came meanwhile.
    fn randr_end(&mut self, why: Option<&str>) {
        if let (Some(why), Some(run)) = (why, &self.randr.run) {
            let (w, h) = run.size;
            log(
                &format!("session: the X server's screen at {w}x{h}: {why}"),
                None,
            );
        }
        self.randr.run = None;
        self.randr_go();
    }

    pub(super) fn randr_error(&mut self, run: u32, step: Step, code: u8) {
        if !self.randr.current(run, step) {
            return;
        }
        match step {
            Step::Extension | Step::Version => self.randr.ok = false,
            _ => self.randr_end(Some(&format!("the X server's error {code}"))),
        }
    }

    pub(super) fn randr_reply(&mut self, run: u32, step: Step, r: &[u8]) {
        if !self.randr.current(run, step) {
            return;
        }
        match step {
            Step::Extension => {
                if r.len() < 12 || r[8] == 0 {
                    return log(
                        "session: the X server has no RandR: its screen left as it is",
                        None,
                    );
                }
                let major = r[9];
                self.randr.major = Some(major);
                self.req(
                    major,
                    minor::QUERY_VERSION,
                    Some(Want::Randr(0, Step::Version)),
                    |q| q.u32(1).u32(3),
                );
            }
            Step::Version => {
                let (maj, min) = (u32_at(r, 8), u32_at(r, 12));
                self.randr.ok = maj > 1 || (maj == 1 && min >= 2);
                if !self.randr.ok {
                    return log(
                        &format!(
                            "session: the X server's RandR is {maj}.{min}, not 1.2: its screen left as it is"
                        ),
                        None,
                    );
                }
                self.randr_go();
            }
            Step::Resources => self.resources(r),
            Step::Output(output) => self.output_info(output, r),
            Step::Geometry => {
                if let Some(run) = self.randr.run.as_mut() {
                    run.screen = Some((u16_at(r, 16), u16_at(r, 18)));
                }
                self.randr_plan();
            }
            Step::Created => {
                let mode = u32_at(r, 8);
                let Some((output, crtc, _)) =
                    self.randr.run.as_ref().and_then(|r| r.output.clone())
                else {
                    return self.randr_end(None);
                };
                let major = self.randr.major.unwrap();
                self.req(major, minor::ADD_OUTPUT_MODE, None, |q| {
                    q.u32(output).u32(mode)
                });
                if let Some(run) = self.randr.run.as_mut() {
                    run.made = true;
                }
                self.randr_set(output, crtc, mode);
            }
            Step::Crtc => {
                let status = r[1];
                let size = self.randr.run.as_ref().map(|r| r.size);
                if status == 0 {
                    if let Some((w, h)) = size {
                        log(
                            &format!("session: the X server's screen set to {w}x{h}"),
                            None,
                        );
                    }
                    self.randr.tries = 0;
                    self.forget_made();
                    self.randr_end(None);
                } else if self.randr.refused(status) {
                    // Its state changed under the run: asked again, from the resources.
                    self.randr_end(None);
                } else {
                    self.randr.tries = 0;
                    self.randr_end(Some(&format!("SetCrtcConfig's status {status}")));
                }
            }
        }
    }

    /// GetScreenResources' reply: its modes kept, each output asked about.
    fn resources(&mut self, r: &[u8]) {
        if r.len() < 32 {
            return self.randr_end(Some("a short reply"));
        }
        let config_time = u32_at(r, 12);
        let (crtcs, outputs, modes, names) = (
            u16_at(r, 16) as usize,
            u16_at(r, 18) as usize,
            u16_at(r, 20) as usize,
            u16_at(r, 22) as usize,
        );
        let at_outputs = 32 + 4 * crtcs;
        let at_modes = at_outputs + 4 * outputs;
        let at_names = at_modes + 32 * modes;
        if r.len() < at_names + names {
            return self.randr_end(Some("a short reply"));
        }
        let mut list = Vec::with_capacity(modes);
        let mut name_at = at_names;
        for k in 0..modes {
            let m = &r[at_modes + 32 * k..at_modes + 32 * (k + 1)];
            let len = u16_at(m, 26) as usize;
            let name =
                String::from_utf8_lossy(r.get(name_at..name_at + len).unwrap_or(&[])).into_owned();
            name_at += len;
            list.push((
                Mode {
                    id: u32_at(m, 0),
                    width: u16_at(m, 4),
                    height: u16_at(m, 6),
                },
                name,
            ));
        }
        let ids: Vec<u32> = (0..outputs)
            .map(|k| u32_at(r, at_outputs + 4 * k))
            .collect();
        let major = self.randr.major.unwrap();
        let Some(run) = self.randr.run.as_mut() else {
            return;
        };
        run.resources = true;
        run.config_time = config_time;
        run.modes = list;
        run.outputs_left = ids.len();
        for id in ids {
            self.req(
                major,
                minor::GET_OUTPUT_INFO,
                Some(Want::Randr(self.randr.run_id(), Step::Output(id))),
                |q| q.u32(id).u32(config_time),
            );
        }
        self.randr_plan();
    }

    /// GetOutputInfo's reply: the output taken if it is the first connected one with a CRTC (not Xwayland's).
    fn output_info(&mut self, output: u32, r: &[u8]) {
        let Some(run) = self.randr.run.as_mut() else {
            return;
        };
        run.outputs_left = run.outputs_left.saturating_sub(1);
        if r.len() >= 36 {
            let crtc = u32_at(r, 12);
            let connected = r[24] == 0;
            let (crtcs, modes, clones, name_len) = (
                u16_at(r, 26) as usize,
                u16_at(r, 28) as usize,
                u16_at(r, 32) as usize,
                u16_at(r, 34) as usize,
            );
            let at_modes = 36 + 4 * crtcs;
            let at_name = at_modes + 4 * modes + 4 * clones;
            let name = r.get(at_name..at_name + name_len).unwrap_or(&[]);
            if name.starts_with(b"XWAYLAND") {
                run.xwayland = true;
            } else if connected && crtc != 0 && run.output.is_none() && r.len() >= at_name {
                let own = (0..modes).map(|k| u32_at(r, at_modes + 4 * k)).collect();
                run.output = Some((output, crtc, own));
            }
        }
        self.randr_plan();
    }

    /// Once the outputs and the screen's size are known: the mode found or made, then set.
    fn randr_plan(&mut self) {
        let Some(run) = self.randr.run.as_ref() else {
            return;
        };
        if !run.resources || run.outputs_left > 0 || run.screen.is_none() {
            return;
        }
        let Some((output, crtc, own)) = run.output.clone() else {
            if run.xwayland && !self.randr.told {
                self.randr.told = true;
                log(
                    "session: the X server is Xwayland: its screen is the compositor's",
                    None,
                );
            }
            return self.randr_end(if run.xwayland {
                None
            } else {
                Some("no output to set")
            });
        };
        let (w, h) = (
            run.size.0.min(u16::MAX as u32) as u16,
            run.size.1.min(u16::MAX as u32) as u16,
        );
        if run.screen == Some((w, h)) {
            return self.randr_end(None);
        }
        let sized = |m: &Mode| m.width == w && m.height == h;
        let found = own
            .iter()
            .find_map(|id| run.modes.iter().find(|(m, _)| m.id == *id && sized(m)))
            .map(|(m, _)| (m.id, true))
            .or_else(|| {
                run.modes
                    .iter()
                    .find(|(m, _)| sized(m))
                    .map(|(m, _)| (m.id, false))
            });
        let name = format!("{w}x{h}");
        let named = run
            .modes
            .iter()
            .find(|(_, n)| *n == name)
            .map(|(m, _)| m.id);
        let major = self.randr.major.unwrap();
        match found {
            Some((mode, true)) => self.randr_set(output, crtc, mode),
            Some((mode, false)) => {
                self.req(major, minor::ADD_OUTPUT_MODE, None, |q| {
                    q.u32(output).u32(mode)
                });
                self.randr_set(output, crtc, mode);
            }
            // A mode of that name but another size (someone's own): not ours to replace.
            None if named.is_some() => self.randr_end(Some("a mode of that name has another size")),
            None => {
                let (clock, t) = timings(w, h);
                let root = self.root;
                self.req(
                    major,
                    minor::CREATE_MODE,
                    Some(Want::Randr(self.randr.run_id(), Step::Created)),
                    |q| {
                        let mut q = q.u32(root).u32(0).u16(w).u16(h).u32(clock);
                        for v in t {
                            q = q.u16(v);
                        }
                        q.u16(name.len() as u16).u32(0).bytes(name.as_bytes())
                    },
                );
            }
        }
    }

    /// The CRTC set (the run's `set`): the mode made before deleted if the screen left it, this run's kept as made.
    fn forget_made(&mut self) {
        let Some(run) = self.randr.run.as_ref() else {
            return;
        };
        let (set, made) = (run.set, run.made);
        if let Some((output, old)) = self.randr.made
            && set.is_some_and(|(_, m)| m != old)
        {
            let major = self.randr.major.unwrap();
            self.req(major, minor::DELETE_OUTPUT_MODE, None, |q| {
                q.u32(output).u32(old)
            });
            self.req(major, minor::DESTROY_MODE, None, |q| q.u32(old));
            self.randr.made = None;
        }
        if made {
            self.randr.made = set;
        }
    }

    /// The screen grown if the mode doesn't fit it, the CRTC set, the screen made the mode's size.
    fn randr_set(&mut self, output: u32, crtc: u32, mode: u32) {
        let Some(run) = self.randr.run.as_mut() else {
            return;
        };
        run.set = Some((output, mode));
        let run = &*run;
        let (w, h) = (run.size.0 as u16, run.size.1 as u16);
        let (sw, sh) = run.screen.unwrap_or((w, h));
        let config_time = run.config_time;
        let (major, root) = (self.randr.major.unwrap(), self.root);
        let mm = |px: u16| (px as u32 * 254).div_ceil(960);
        let set_size = |x: &mut X, w: u16, h: u16| {
            x.req(major, minor::SET_SCREEN_SIZE, None, |q| {
                q.u32(root).u16(w).u16(h).u32(mm(w)).u32(mm(h))
            });
        };
        let (gw, gh) = (sw.max(w), sh.max(h));
        if (gw, gh) != (sw, sh) {
            set_size(self, gw, gh);
        }
        self.req(
            major,
            minor::SET_CRTC_CONFIG,
            Some(Want::Randr(self.randr.run_id(), Step::Crtc)),
            |q| {
                q.u32(crtc)
                    .u32(0)
                    .u32(config_time)
                    .u16(0)
                    .u16(0)
                    .u32(mode)
                    .u16(ROTATE_0)
                    .u16(0)
                    .u32(output)
            },
        );
        if (gw, gh) != (w, h) {
            set_size(self, w, h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An X on a listening socket of the test's own (nothing answers: the test hands it the replies), RandR known.
    fn x_with_randr(name: &str) -> (X, std::os::unix::net::UnixListener, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let l = std::os::unix::net::UnixListener::bind(dir.join("X6")).unwrap();
        let jobs = crate::session::Jobs {
            clip: false,
            resize: true,
            desktop: false,
            keymap: false,
        };
        let me = rustix::process::getuid().as_raw();
        let mut x = X::connect(dir.to_str().unwrap(), 6, None, me, jobs).unwrap();
        (x.randr.major, x.randr.ok, x.root) = (Some(140), true, 0x3d1);
        (x, l, dir)
    }

    /// The awaited RandR reply that `pick` takes (the last such): its run and step.
    fn awaited(x: &X, pick: impl Fn(&Step) -> bool) -> (u32, Step) {
        x.replies
            .iter()
            .rev()
            .find_map(|(_, w)| match w {
                Want::Randr(run, step) if pick(step) => Some((*run, *step)),
                _ => None,
            })
            .expect("awaited")
    }

    /// GetScreenResources' reply: one CRTC, `outputs`, no modes.
    fn resources(outputs: &[u32]) -> Vec<u8> {
        let mut r = vec![0u8; 32];
        r[16..18].copy_from_slice(&1u16.to_ne_bytes());
        r[18..20].copy_from_slice(&(outputs.len() as u16).to_ne_bytes());
        r.extend_from_slice(&0x60u32.to_ne_bytes());
        for o in outputs {
            r.extend_from_slice(&o.to_ne_bytes());
        }
        r
    }

    /// GetOutputInfo's reply: connected, on CRTC 0x60, no modes, no name.
    fn output_info() -> Vec<u8> {
        let mut r = vec![0u8; 36];
        r[12..16].copy_from_slice(&0x60u32.to_ne_bytes());
        r
    }

    #[test]
    fn a_runs_late_replies_do_not_fill_the_next_run() {
        let (mut x, _l, dir) = x_with_randr("randr-late");
        x.resize((1024, 768));
        let (run1, _) = awaited(&x, |s| matches!(s, Step::Resources));
        let (_, geometry1) = awaited(&x, |s| matches!(s, Step::Geometry));
        x.randr_reply(run1, Step::Resources, &resources(&[0x70, 0x71]));
        // The first output's GetOutputInfo fails: the run ends, the second's reply and the root's still to come.
        x.randr_error(run1, Step::Output(0x70), 3);
        assert!(x.randr.run.is_none(), "the run ended");
        // A new size: the next run, its own requests out.
        x.resize((800, 600));
        let run2 = x.randr.run.as_ref().map(|r| r.id).unwrap();
        assert_ne!(run2, run1);
        // The first run's late replies.
        x.randr_reply(run1, Step::Output(0x71), &output_info());
        let mut geometry = vec![0u8; 32];
        geometry[16..18].copy_from_slice(&1024u16.to_ne_bytes());
        geometry[18..20].copy_from_slice(&768u16.to_ne_bytes());
        x.randr_reply(run1, geometry1, &geometry);
        let run = x.randr.run.as_ref().expect("the second run goes on");
        assert_eq!(run.size, (800, 600));
        assert!(run.output.is_none(), "an output of the first run's");
        assert!(run.screen.is_none(), "the root's size the first run asked");
        assert!(!run.resources);
        // Its own replies are taken.
        x.randr_reply(run2, Step::Geometry, &geometry);
        assert_eq!(x.randr.run.as_ref().unwrap().screen, Some((1024, 768)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crtc_refused_for_a_stale_config_time_is_tried_again_a_few_times() {
        let mut r = Randr::new(true);
        r.want = Some((1024, 768));
        r.asked = Some((1024, 768));
        // InvalidConfigTime (1), InvalidTime (2): the configuration changed under the run (the display event's probe).
        for _ in 0..RETRIES {
            assert!(r.refused(1), "tried again");
            assert_eq!(r.asked, None);
            r.asked = Some((1024, 768));
        }
        assert!(!r.refused(2), "not past RETRIES");
        assert_eq!(r.asked, Some((1024, 768)));
        // Failed (3): not tried again.
        let mut r = Randr::new(true);
        r.asked = Some((800, 600));
        assert!(!r.refused(3));
        assert_eq!(r.asked, Some((800, 600)));
    }

    #[test]
    fn timings_are_a_modes() {
        let (clock, t) = timings(1280, 720);
        let [hs, he, ht, skew, vs, ve, vt] = t;
        assert!(1280 < hs && hs < he && he < ht && skew == 0);
        assert!(720 < vs && vs < ve && ve < vt);
        assert_eq!(clock, ht as u32 * vt as u32 * 60);
    }
}
