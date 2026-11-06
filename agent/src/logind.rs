//! The active session on seat0, from logind's state files (docs/plans/clipboard.md §3.2), without D-Bus:
//! `/run/systemd/seats/seat0` says `ACTIVE=<session id>`, and `/run/systemd/sessions/<id>` the session's `UID=` and
//! `CLASS=` (and an X11 session's `DISPLAY=`, the display a session child looks for first: src/x11.rs). logind writes each file whole and renames it into place, so the agent watches both directories for
//! IN_MOVED_TO and IN_DELETE (not IN_CREATE, which its temporary files would wake it for). Whatever the session's
//! TYPE (a user who logs in on a tty and runs sway has `TYPE=tty`), its user's runtime directory is where a display's
//! socket is: `/run/user/<uid>`, once the user's tmpfs is mounted there (owned by the user), which the agent learns
//! from its mount table changing (`/proc/self/mountinfo` polls POLLPRI then).

use rustix::fs::{AtFlags, CWD, FileType, Stat, statat};
use rustix::process::{Gid, Uid};
use std::fs::read_to_string;

pub const MOUNTS: &str = "/proc/self/mountinfo";

/// Where logind's files and the users' runtime directories are (the tests' own directories stand in for them).
#[derive(Clone, Debug)]
pub struct Paths {
    pub seats: String,
    pub sessions: String,
    /// The users' runtime directories' parent: `<users>/<uid>`.
    pub users: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            seats: "/run/systemd/seats".into(),
            sessions: "/run/systemd/sessions".into(),
            users: "/run/user".into(),
        }
    }
}

/// The active session on seat0 whose user's runtime directory is ready: what a session child serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Active {
    pub session: String,
    pub uid: u32,
    pub gid: u32,
    pub runtime: String,
    /// The session file's `DISPLAY=` (a display manager's X11 session), as its number.
    pub display: Option<u32>,
}

/// A `KEY=value` file's value for `key`.
pub fn value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
}

/// A seat file's active session, if it has one.
pub fn seat_active(seat: &str) -> Option<&str> {
    value(seat, "ACTIVE").filter(|s| valid_id(s))
}

/// A session file's user, if the session is a user's (not a greeter's, a lock screen's or a background one's).
pub fn session_uid(session: &str) -> Option<u32> {
    let class = value(session, "CLASS").unwrap_or("user");
    if class != "user" && !class.starts_with("user-") {
        return None;
    }
    if value(session, "STATE") == Some("closing") {
        return None;
    }
    value(session, "UID")?.parse().ok()
}

/// Whether `name` can be a session's id (logind's: letters and digits): the files beside them (`<id>.ref`,
/// temporary `.#…` files) aren't.
pub fn valid_id(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The active session now, as logind's files say, with its runtime directory ready (mounted: `ready`).
pub fn active(p: &Paths) -> Option<Active> {
    let seat = read_to_string(format!("{}/seat0", p.seats)).ok()?;
    let session = seat_active(&seat)?.to_owned();
    let file = read_to_string(format!("{}/{session}", p.sessions)).ok()?;
    let uid = session_uid(&file)?;
    let display = value(&file, "DISPLAY").and_then(crate::x11::display_number);
    let runtime = format!("{}/{uid}", p.users);
    // A stat, not an open: the directory is the user's alone (0700), and the agent's root has no CAP_DAC_OVERRIDE
    // (its unit's bounding set).
    let st = statat(CWD, runtime.as_str(), AtFlags::SYMLINK_NOFOLLOW).ok()?;
    let users = statat(CWD, p.users.as_str(), AtFlags::SYMLINK_NOFOLLOW).ok()?;
    ready(&st, &users, uid).then_some(Active {
        session,
        uid,
        gid: st.st_gid,
        runtime,
        display,
    })
}

/// Whether `dir`, the runtime directory of `uid` in `users`, is the user's tmpfs, mounted. Before the mount, the bare
/// directory is root's: its owner tells for every user but root, whose bare mount point is its own too; root's is
/// mounted once it is on another device than its parent.
pub fn ready(dir: &Stat, users: &Stat, uid: u32) -> bool {
    FileType::from_raw_mode(dir.st_mode) == FileType::Directory
        && dir.st_uid == uid
        && (uid != 0 || dir.st_dev != users.st_dev)
}

/// The ids as rustix takes them.
pub fn ids(a: &Active) -> (Uid, Gid) {
    (Uid::from_raw(a.uid), Gid::from_raw(a.gid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_logind_files() {
        // As logind 257 writes them (Debian 13: a user logged in on tty1 by getty).
        let seat = "# This is private data. Do not parse.\nIS_SEAT0=1\nCAN_MULTI_SESSION=1\nCAN_TTY=1\nCAN_GRAPHICAL=0\nACTIVE=3\nACTIVE_UID=1000\nSESSIONS=3 c1\nUIDS=1000 0\n";
        assert_eq!(seat_active(seat), Some("3"));
        assert_eq!(
            seat_active("IS_SEAT0=1\nCAN_TTY=1\n"),
            None,
            "no session active"
        );
        assert_eq!(seat_active("ACTIVE=../x\n"), None);
        let session = "# This is private data. Do not parse.\nUID=1000\nUSER=user\nACTIVE=1\nIS_DISPLAY=1\nSTATE=active\nREMOTE=0\nLEADER_FD_SAVED=1\nTYPE=tty\nORIGINAL_TYPE=tty\nCLASS=user\nSCOPE=session-3.scope\nFIFO=/run/systemd/sessions/3.ref\nSEAT=seat0\nTTY=tty1\nTTY_VALIDITY=from-pam\nSERVICE=login\nVTNR=1\nLEADER=751\n";
        assert_eq!(session_uid(session), Some(1000));
        assert_eq!(
            session_uid(&session.replace("CLASS=user", "CLASS=greeter")),
            None
        );
        assert_eq!(
            session_uid(&session.replace("CLASS=user", "CLASS=user-early")),
            Some(1000)
        );
        assert_eq!(
            session_uid(&session.replace("STATE=active", "STATE=closing")),
            None
        );
        assert_eq!(session_uid("USER=x\n"), None);
        // An X11 session's display (lightdm's: TYPE=x11, DISPLAY=:0).
        let x = session.replace("TYPE=tty", "TYPE=x11\nDISPLAY=:0");
        assert_eq!(
            value(&x, "DISPLAY").and_then(crate::x11::display_number),
            Some(0)
        );
        assert_eq!(value(session, "DISPLAY"), None);
        // `ACTIVE=` isn't `ACTIVE_UID=`.
        assert_eq!(value("ACTIVE_UID=5\nACTIVE=c2\n", "ACTIVE"), Some("c2"));
        assert!(valid_id("c12") && !valid_id("3.ref") && !valid_id(".#seat0abc") && !valid_id(""));
    }

    #[test]
    fn a_runtime_directory_is_ready_once_mounted() {
        // A directory and its parent as the tests find them (one device), owned as the cases want.
        let dir = std::env::temp_dir();
        let st = |uid: u32| {
            let mut s = statat(CWD, &dir, AtFlags::empty()).unwrap();
            s.st_uid = uid;
            s
        };
        let users = statat(CWD, &dir, AtFlags::empty()).unwrap();
        assert!(ready(&st(1000), &users, 1000), "the user's own");
        assert!(!ready(&st(0), &users, 1000), "the bare mount point, root's");
        // Root's: its bare mount point is root's too; only the device tells the tmpfs from it.
        assert!(!ready(&st(0), &users, 0), "root's bare mount point");
        let mut mounted = st(0);
        mounted.st_dev = users.st_dev.wrapping_add(1);
        assert!(ready(&mounted, &users, 0), "root's tmpfs, mounted");
        let mut file = st(1000);
        file.st_mode = (file.st_mode & !0o170000) | 0o100000;
        assert!(!ready(&file, &users, 1000), "not a directory");
    }
}
