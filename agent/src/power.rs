//! POWER (docs/devices.md "Power off and restart from the guest"): the page asks the guest to power off or reboot
//! itself, as a clean shutdown does, so that its programs end and its disks are written out before the machine stops.
//! The agent asks systemd-logind (running: `/run/systemd/seats`), through `busctl` (systemd's), as `systemctl
//! poweroff` does: `org.freedesktop.login1.Manager.PowerOffWithFlags` (or `RebootWithFlags`) with
//! `SD_LOGIND_ROOT_CHECK_INHIBITORS`, so that a block inhibitor refuses it even to root and a delay inhibitor
//! holds it for its time (logind's `InhibitDelayMaxSec`). Without logind or busctl, `shutdown now` (`shutdown -r now`)
//! where it is. logind checks the caller's CAP_SYS_BOOT (the unit's bounding set keeps it for that). The tool runs in a
//! forked child (src/lease.rs `spawn`) whose end the root process's loop hears; POWERED answers (`status`). A request
//! taken may stop the agent before POWERED leaves: the page takes the connection's end as the guest's shutdown under
//! way.

use crate::prelude::*;

/// POWERED's statuses.
pub mod status {
    /// The guest took it: its shutdown (or reboot) is under way, or waits on a delay inhibitor.
    pub const TAKEN: u8 = 0;
    /// logind or shutdown refused it (a block inhibitor, a shutdown already under way) or failed.
    pub const REFUSED: u8 = 1;
    /// Neither logind with busctl nor `shutdown` is here.
    pub const NO_TOOL: u8 = 2;
    /// An earlier request is still running (one the page gave up waiting for): this one isn't taken.
    pub const BUSY: u8 = 3;
}

/// logind's flag (systemd's src/basic/login-util.h): inhibitors hold for root too.
const ROOT_CHECK_INHIBITORS: &str = "1";

/// Where logind, busctl and shutdown are (the tests' are files of their own).
#[derive(Clone)]
pub struct Paths {
    pub logind: String,
    pub busctl: Vec<String>,
    pub shutdown: Vec<String>,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            logind: "/run/systemd/seats".into(),
            busctl: crate::keymap::places("busctl"),
            shutdown: crate::keymap::places("shutdown"),
        }
    }
}

/// The command that asks the guest to power off (or `reboot`); None without a tool for it.
pub fn command(p: &Paths, reboot: bool) -> Option<Vec<String>> {
    if rustix::fs::stat(p.logind.as_str()).is_ok()
        && let Some(busctl) = crate::keymap::found(&p.busctl)
    {
        let method = if reboot {
            "RebootWithFlags"
        } else {
            "PowerOffWithFlags"
        };
        return Some(
            [
                busctl.as_str(),
                "call",
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                "org.freedesktop.login1.Manager",
                method,
                "t",
                ROOT_CHECK_INHIBITORS,
            ]
            .map(String::from)
            .to_vec(),
        );
    }
    let shutdown = crate::keymap::found(&p.shutdown)?;
    Some(if reboot {
        vec![shutdown, "-r".into(), "now".into()]
    } else {
        vec![shutdown, "now".into()]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_logind_else_shutdown() {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-power-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = |n: &str| dir.join(n).to_str().unwrap().to_owned();
        let p = Paths {
            logind: s("seats"),
            busctl: vec![s("busctl")],
            shutdown: vec![s("no-shutdown"), s("shutdown")],
        };
        let tool = |n: &str| {
            std::fs::write(dir.join(n), "#!/bin/sh\n").unwrap();
            rustix::fs::chmod(s(n).as_str(), rustix::fs::Mode::from_raw_mode(0o755)).unwrap();
        };
        assert_eq!(command(&p, false), None, "no tool");
        tool("shutdown");
        assert_eq!(command(&p, false), Some(vec![s("shutdown"), "now".into()]));
        assert_eq!(
            command(&p, true),
            Some(vec![s("shutdown"), "-r".into(), "now".into()])
        );
        // busctl without logind running: shutdown still.
        tool("busctl");
        assert_eq!(command(&p, false).unwrap()[0], s("shutdown"));
        std::fs::create_dir(dir.join("seats")).unwrap();
        let c = command(&p, true).unwrap();
        assert_eq!(c[0], s("busctl"));
        assert_eq!(
            &c[1..],
            [
                "call",
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                "org.freedesktop.login1.Manager",
                "RebootWithFlags",
                "t",
                "1"
            ]
        );
        assert_eq!(command(&p, false).unwrap()[5], "PowerOffWithFlags");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
