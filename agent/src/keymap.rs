//! KEYMAP (docs/frontend.md "The keyboard layout"): the machine's keyboard layout setting, as the page resolved it, for
//! the running session. The guest's disk gets it at every boot without the agent (the page's credentials:
//! `/etc/environment`'s `XKB_DEFAULT_*`, localed's or Debian's `/etc/default/keyboard`, the console's keymap); the agent
//! applies it at once, where the session's layout isn't it: a snapshot restored onto another setting, the setting
//! saved while the machine runs. The root keeps what the session has (`Current`: the boot's `/etc/environment`, then
//! what it last applied) and does nothing for a layout it has; else the session child sets it in the running session
//! (sway through its IPC socket, which the agent speaks itself; an X11 session's server through `setxkbmap`, where the
//! guest has it), and the root the text consoles' (`loadkeys`, where kbd is there). GNOME and KDE keep their own
//! settings and aren't told (docs/backlog.md).

use crate::prelude::*;
use rustix::fd::{AsFd, OwnedFd};
use rustix::io::Errno;
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType};

/// A layout, as KEYMAP carries it: XKB's layout, model and variant (the variant may be empty), and the console's keymap
/// (kbd's name; empty: none).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Keymap {
    pub layout: String,
    pub model: String,
    pub variant: String,
    pub vc: String,
}

/// A name the agent passes on (to sway's command parser, to a tool's argument): XKB's and kbd's names are of these
/// characters, and nothing else may reach a command line (a `;` would be another sway command).
fn plain(s: &str) -> bool {
    s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-+.,:()".contains(&b))
}

impl Keymap {
    /// KEYMAP's payload: four strings, each a u8 length and its bytes (layout, model, variant, vc). None: not one
    /// (no layout, a name that isn't plain).
    pub fn decode(p: &[u8]) -> Option<Keymap> {
        let mut at = 0;
        let mut next = || -> Option<String> {
            let n = *p.get(at)? as usize;
            let s = core::str::from_utf8(p.get(at + 1..at + 1 + n)?).ok()?;
            at += 1 + n;
            plain(s).then(|| s.to_owned())
        };
        let k = Keymap {
            layout: next()?,
            model: next()?,
            variant: next()?,
            vc: next()?,
        };
        (!k.layout.is_empty()).then_some(k)
    }

    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::new();
        for s in [&self.layout, &self.model, &self.variant, &self.vc] {
            o.push(s.len() as u8);
            o.extend_from_slice(s.as_bytes());
        }
        o
    }

    /// Whether the session's layout is this one: XKB's names (the console's isn't in `/etc/environment`).
    pub fn same_xkb(&self, o: &Keymap) -> bool {
        self.layout == o.layout && self.model == o.model && self.variant == o.variant
    }

    /// sway's commands that set it on every keyboard: the variant emptied first (a layout with the old one's variant
    /// may not compile), then the model, the layout and its variant.
    pub fn sway_commands(&self) -> String {
        let k = "input type:keyboard";
        let mut c = format!(
            "{k} xkb_variant \"\"; {k} xkb_model {}; {k} xkb_layout {}",
            self.model, self.layout
        );
        if !self.variant.is_empty() {
            c += &format!("; {k} xkb_variant {}", self.variant);
        }
        c
    }
}

/// The layout the boot set (`/etc/environment`'s `XKB_DEFAULT_*`, the page's credentials' script writes them), if any.
pub fn booted(environment: &str) -> Option<Keymap> {
    let text = crate::rt::read_text(environment).ok()?;
    let mut k = Keymap {
        model: "pc105".into(),
        ..Keymap::default()
    };
    for line in text.lines() {
        let Some((key, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"').to_owned();
        match key.trim() {
            "XKB_DEFAULT_LAYOUT" => k.layout = v,
            "XKB_DEFAULT_MODEL" => k.model = v,
            "XKB_DEFAULT_VARIANT" => k.variant = v,
            _ => {}
        }
    }
    (!k.layout.is_empty()).then_some(k)
}

/// The root's: the layout the session has, and the page's KEYMAP that differs from it (to apply).
#[derive(Default)]
pub struct Current {
    /// What the session has: the boot's (read once, at the first KEYMAP), then what the agent applied.
    pub has: Option<Keymap>,
    read: bool,
    /// The page's layout where it isn't what the boot set, for every session child (theirs to apply).
    pub wanted: Option<Vec<u8>>,
}

impl Current {
    /// The page's KEYMAP: Some (the layout to apply) where the session doesn't have it.
    pub fn take(&mut self, payload: &[u8], environment: &str) -> Option<Keymap> {
        let k = Keymap::decode(payload)?;
        if !self.read {
            self.read = true;
            self.has = booted(environment);
        }
        if self.has.as_ref().is_some_and(|h| h.same_xkb(&k)) {
            return None;
        }
        self.has = Some(k.clone());
        self.wanted = Some(payload.to_vec());
        Some(k)
    }
}

/// sway's IPC socket in the user's runtime directory (`sway-ipc.<uid>.<pid>.sock`, its process alive), if there is one.
pub fn sway_socket(runtime: &str, uid: u32) -> Option<String> {
    let prefix = format!("sway-ipc.{uid}.");
    crate::rt::dir_names(runtime)
        .ok()?
        .into_iter()
        .filter(|n| n.starts_with(&prefix) && n.ends_with(".sock"))
        .find(|n| {
            let pid = &n[prefix.len()..n.len() - 5];
            !pid.is_empty() && rustix::fs::stat(format!("/proc/{pid}").as_str()).is_ok()
        })
        .map(|n| format!("{runtime}/{n}"))
}

/// i3's IPC (sway's): `i3-ipc`, the payload's length and the message's type (u32s in the host's order), the payload.
const MAGIC: &[u8; 6] = b"i3-ipc";
const RUN_COMMAND: u32 = 0;
/// How long sway may take to answer.
const IPC_WAIT_MS: i64 = 2000;

fn wait(fd: &OwnedFd, flags: rustix::event::PollFlags) -> Result<(), Errno> {
    let t = rustix::event::Timespec {
        tv_sec: IPC_WAIT_MS / 1000,
        tv_nsec: 0,
    };
    let mut f = [rustix::event::PollFd::new(fd, flags)];
    match rustix::event::poll(&mut f, Some(&t))? {
        0 => Err(Errno::TIMEDOUT),
        _ => Ok(()),
    }
}

/// Runs `commands` through sway's socket at `path`: whether each succeeded (its reply's `"success":true` each).
pub fn sway_run(path: &str, commands: &str) -> Result<bool, Errno> {
    let fd = rustix::net::socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )?;
    rustix::net::connect(&fd, &SocketAddrUnix::new(path)?)?;
    let mut msg = MAGIC.to_vec();
    msg.extend_from_slice(&(commands.len() as u32).to_ne_bytes());
    msg.extend_from_slice(&RUN_COMMAND.to_ne_bytes());
    msg.extend_from_slice(commands.as_bytes());
    let mut sent = 0;
    while sent < msg.len() {
        wait(&fd, rustix::event::PollFlags::OUT)?;
        sent += rustix::io::write(fd.as_fd(), &msg[sent..])?;
    }
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        if got.len() >= 14 {
            let len = u32::from_ne_bytes(got[6..10].try_into().unwrap()) as usize;
            if got[..6] != MAGIC[..] {
                return Err(Errno::PROTO);
            }
            if got.len() >= 14 + len {
                // Its JSON, spaced or not: `[{"success": true}, …]`, one a command.
                let body: String = core::str::from_utf8(&got[14..14 + len])
                    .map_err(|_| Errno::PROTO)?
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                return Ok(body.contains("\"success\":true") && !body.contains("\"success\":false"));
            }
        }
        wait(&fd, rustix::event::PollFlags::IN)?;
        match rustix::io::read(&fd, &mut buf)? {
            0 => return Err(Errno::PIPE),
            n => got.extend_from_slice(&buf[..n]),
        }
    }
}

/// Where a guest tool `name` may be, first found first.
pub fn places(name: &str) -> Vec<String> {
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]
        .iter()
        .map(|d| format!("{d}/{name}"))
        .collect()
}

/// The first of `places` that is an executable.
pub fn found(places: &[String]) -> Option<String> {
    places
        .iter()
        .find(|p| rustix::fs::access(p.as_str(), rustix::fs::Access::EXEC_OK).is_ok())
        .cloned()
}

/// Guest tool `name`, where the guest has it.
pub fn tool(name: &str) -> Option<String> {
    found(&places(name))
}

unsafe extern "C" {
    fn fork() -> i32;
    fn execve(
        path: *const core::ffi::c_char,
        argv: *const *const core::ffi::c_char,
        envp: *const *const core::ffi::c_char,
    ) -> i32;
}

fn cstrs(v: &[String]) -> Vec<Vec<u8>> {
    v.iter()
        .map(|s| {
            let mut b = s.as_bytes().to_vec();
            b.push(0);
            b
        })
        .collect()
}

/// Runs `argv` (its first the program's path) with `env`, waiting up to `ms` for it (then killed): whether it exited
/// with 0. The caller's process is one thread (the session child, the root).
pub fn run(argv: &[String], env: &[String], ms: u64) -> bool {
    let (a, e) = (cstrs(argv), cstrs(env));
    let mut ap: Vec<*const core::ffi::c_char> = a.iter().map(|s| s.as_ptr().cast()).collect();
    ap.push(core::ptr::null());
    let mut ep: Vec<*const core::ffi::c_char> = e.iter().map(|s| s.as_ptr().cast()).collect();
    ep.push(core::ptr::null());
    // SAFETY: one thread; the child only closes descriptors, execs (with strings and arrays that outlive the call) or
    // exits.
    let pid = unsafe { fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        crate::rt::close_inherited();
        // SAFETY: as above.
        unsafe { execve(ap[0], ap.as_ptr(), ep.as_ptr()) };
        crate::rt::exit(127);
    }
    let Some(pid) = rustix::process::Pid::from_raw(pid) else {
        return false;
    };
    let start = crate::rt::Instant::now();
    loop {
        match rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::NOHANG) {
            Ok(Some((_, st))) => return st.exit_status() == Some(0),
            Ok(None) => {}
            Err(Errno::INTR) => continue,
            Err(_) => return false,
        }
        if start.elapsed().as_millis() as u64 > ms {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
            let _ = rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::empty());
            return false;
        }
        let _ = rustix::thread::nanosleep(&rustix::time::Timespec {
            tv_sec: 0,
            tv_nsec: 20_000_000,
        });
    }
}

/// An X11 session's layout, set by `setxkbmap` (where the guest has it) on display `n`, with the cookie's file `auth`.
pub fn setxkbmap(k: &Keymap, n: u32, auth: Option<&str>) -> Option<bool> {
    let tool = tool("setxkbmap")?;
    let argv = [
        tool,
        "-model".into(),
        k.model.clone(),
        "-layout".into(),
        k.layout.clone(),
        "-variant".into(),
        k.variant.clone(),
    ];
    let mut env = vec![format!("DISPLAY=:{n}"), "PATH=/usr/bin:/bin".into()];
    env.extend(auth.map(|a| format!("XAUTHORITY={a}")));
    Some(run(&argv, &env, 5000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn km(layout: &str, model: &str, variant: &str, vc: &str) -> Keymap {
        Keymap {
            layout: layout.into(),
            model: model.into(),
            variant: variant.into(),
            vc: vc.into(),
        }
    }

    #[test]
    fn decodes_plain_names_only() {
        let k = km("de", "pc105", "nodeadkeys", "de-latin1-nodeadkeys");
        assert_eq!(Keymap::decode(&k.encode()), Some(k));
        assert_eq!(
            Keymap::decode(&km("us", "pc105", "", "").encode()),
            Some(km("us", "pc105", "", ""))
        );
        assert_eq!(
            Keymap::decode(&km("", "pc105", "", "us").encode()),
            None,
            "no layout"
        );
        assert_eq!(
            Keymap::decode(&km("us; exec rm", "pc105", "", "").encode()),
            None,
            "another command"
        );
        assert_eq!(
            Keymap::decode(&km("us", "pc105", "a\"b", "").encode()),
            None
        );
        assert_eq!(Keymap::decode(&[2, b'u']), None, "short");
    }

    #[test]
    fn pins_the_pages_bytes() {
        // tests/agent.test.ts pins the same.
        let mut want = vec![2, b'd', b'e', 5];
        want.extend_from_slice(b"pc105");
        want.extend_from_slice(&[3, b'n', b'e', b'o', 9]);
        want.extend_from_slice(b"de-latin1");
        assert_eq!(
            Keymap::decode(&want),
            Some(km("de", "pc105", "neo", "de-latin1"))
        );
    }

    #[test]
    fn sways_commands_empty_the_variant_first() {
        assert_eq!(
            km("de", "pc105", "nodeadkeys", "").sway_commands(),
            "input type:keyboard xkb_variant \"\"; input type:keyboard xkb_model pc105; input type:keyboard xkb_layout de; input type:keyboard xkb_variant nodeadkeys"
        );
        assert!(
            !km("us", "pc105", "", "")
                .sway_commands()
                .ends_with("xkb_variant ")
        );
    }

    #[test]
    fn applies_only_what_the_session_hasnt() {
        let dir = std::env::temp_dir().join(format!("waarm64-keymap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let env = dir.join("environment");
        std::fs::write(&env, "PATH=/bin\nXKB_DEFAULT_LAYOUT=\"de\"\nXKB_DEFAULT_MODEL=pc105\nXKB_DEFAULT_VARIANT=nodeadkeys\n").unwrap();
        let env = env.to_str().unwrap();
        let mut c = Current::default();
        assert_eq!(
            c.take(&km("de", "pc105", "nodeadkeys", "x").encode(), env),
            None,
            "the boot's"
        );
        assert_eq!(c.wanted, None);
        let pt = km("pt", "pc105", "", "pt-latin1");
        assert_eq!(c.take(&pt.encode(), env), Some(pt.clone()));
        assert_eq!(c.wanted, Some(pt.encode()));
        assert_eq!(c.take(&pt.encode(), env), None, "applied already");
        assert_eq!(
            c.take(&km("de", "pc105", "nodeadkeys", "").encode(), env)
                .map(|k| k.layout),
            Some("de".into()),
            "back"
        );
        // A boot that set none: whatever the page says is applied.
        let mut c = Current::default();
        assert!(
            c.take(&pt.encode(), dir.join("none").to_str().unwrap())
                .is_some()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
