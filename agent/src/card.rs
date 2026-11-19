//! CARDS (docs/devices.md "A card nothing else manages"): the page names the cards it has connected (at its HELLO and
//! whenever that changes), and the agent brings up a connected card that nothing in the guest manages, with busybox's
//! DHCPv6 client on it. It is for a guest whose network is configured card by card (Alpine's ifupdown-ng configures
//! only what `/etc/network/interfaces` lists, `eth0`), on which a second adapter the page connected (a demo machine's
//! room, docs/networking/adapters.md §1 rule 2) would otherwise stay down. The user's OK, 2026-11-19, for every guest
//! with the agent: a card nothing else manages, and only once the page connected it.
//!
//! A card is the agent's to bring up when all of these hold:
//! - the guest has no systemd (`/run/systemd/system`): on systemd the network manager (networkd, NetworkManager) or
//!   the user owns every card, and the agent's unit is sandboxed besides;
//! - neither networkd nor NetworkManager runs (`lease::Paths`' `networkd`, `nm`);
//! - the card is down (IFF_UP clear in `/sys/class/net/<card>/flags`): anything that configured it brought it up; or
//!   it is up but the agent brought it up before (its mark, `Paths::marks`), and the next rule finds its client gone;
//! - no ifupdown file names it (`/etc/network/interfaces` and the files of `/etc/network/interfaces.d`: any word of a
//!   line that isn't a comment, `auto eth1`, `iface eth1 inet6 …`, `allow-hotplug eth1`);
//! - no DHCP client runs for it (a udhcpc or udhcpc6 of the card's, a dhcpcd that manages it: src/lease.rs).
//!
//! Then, in a forked child (as LEASE's tools run): `accept_ra_rt_info_max_plen` 128 on the card (the kernel's default,
//! 0, ignores the Route Information options the page's gateway routes its prefixes by: the room's /48, tailcat's
//! /128s), the link up (`ip link set <card> up`), and `udhcpc6 -i <card> -b` with the agent's script
//! (`SCRIPT`, written to `script` first: busybox's default script on Alpine is IPv4's only), which adds the leased
//! address as a /128. IPv6 only: a gateway that isn't the primary gives no IPv4 route (adapters.md §4), and only the
//! primary gives default routes, so the card adds its network's routes and nothing else. The card's resolvers and
//! domains go to the agent's DNS forwarder (src/resolve.rs), not to `/etc/resolv.conf` (musl asks every server there
//! at once and takes the first answer, so another network's NXDOMAIN would race the room's). The agent never takes a card down: one the page disconnected keeps its client,
//! which asks until its network comes back. After a restore, LEASE renews its udhcpc6 as it does udhcpc.

use crate::lease::{Paths as LeasePaths, Step, dhcpcd_manages, found, processes, udhcpc_of};
use crate::prelude::*;

/// IFF_UP in a link's `flags`.
const IFF_UP: u32 = 0x1;

/// udhcpc6's script (busybox sh): the leased address as a /128 at `bound` and `renew`, and the lease's resolvers and
/// domains in `/run/waarm64-dns/<card>` (resolve::ROOM_DIR) for the agent's forwarder; the card's global addresses
/// flushed and its file removed at `deconfig` (udhcpc6's start, a lease lost). busybox's `ip` has `replace`.
pub const SCRIPT: &str = "#!/bin/sh
# From waarm64's guest agent (docs/devices.md, \"A card nothing else manages\"): udhcpc6's script for a card the agent
# brought up, which nothing else in the guest manages. The leased address, as a /128; routes come from the router's
# advertisements; the resolvers and domains go to /run/waarm64-dns/<card> for the agent's forwarder (src/resolve.rs).
PATH=/usr/sbin:/usr/bin:/sbin:/bin
d=/run/waarm64-dns
case \"$1\" in
deconfig)
	ip -6 addr flush dev \"$interface\" scope global
	rm -f \"$d/$interface\" ;;
bound|renew)
	[ -n \"$ipv6\" ] && ip -6 addr replace \"$ipv6/128\" dev \"$interface\"
	mkdir -p \"$d\"
	if [ -n \"$dns\" ]; then
		printf 'dns %s\\nsearch %s\\n' \"$dns\" \"$search\" > \"$d/$interface.new\" && mv \"$d/$interface.new\" \"$d/$interface\"
	else
		rm -f \"$d/$interface\"
	fi ;;
esac
exit 0
";

/// Where the tools and files are (the tests' are directories of their own).
#[derive(Clone)]
pub struct Paths {
    /// Exists where systemd runs the guest.
    pub systemd: String,
    /// ifupdown's file and directory.
    pub interfaces: String,
    pub interfaces_d: String,
    /// The cards' IPv6 settings (`<dir>/<card>/accept_ra_rt_info_max_plen`).
    pub ipv6_conf: String,
    pub ip: Vec<String>,
    pub udhcpc6: Vec<String>,
    /// busybox itself, for its applets where no link to one is there.
    pub busybox: Vec<String>,
    /// Where `SCRIPT` is written (outside the agent's own tmpfs, which goes when it stops: udhcpc6 stays).
    pub script: String,
    /// A file per card the agent brought up (`mark`), outside its tmpfs too: such a card, up with no client, is the
    /// agent's to bring up again.
    pub marks: String,
}

impl Default for Paths {
    fn default() -> Paths {
        let bins = |n: &str| {
            ["/sbin", "/bin", "/usr/sbin", "/usr/bin"]
                .map(|d| format!("{d}/{n}"))
                .to_vec()
        };
        Paths {
            systemd: "/run/systemd/system".into(),
            interfaces: "/etc/network/interfaces".into(),
            interfaces_d: "/etc/network/interfaces.d".into(),
            ipv6_conf: "/proc/sys/net/ipv6/conf".into(),
            ip: bins("ip"),
            udhcpc6: bins("udhcpc6"),
            busybox: bins("busybox"),
            script: "/run/waarm64-udhcpc6.script".into(),
            marks: "/run/waarm64-cards".into(),
        }
    }
}

fn exists(p: &str) -> bool {
    rustix::fs::stat(p).is_ok()
}

/// Whether an ifupdown file's text names `card` (a word of a line that isn't a comment).
pub fn named(text: &str, card: &str) -> bool {
    text.lines().any(|l| {
        let l = l.split('#').next().unwrap_or("");
        l.split_whitespace().any(|w| w == card)
    })
}

/// Whether link `card` is up (IFF_UP in its sysfs `flags`, `0x1003`); unreadable counts as up (left alone).
fn up(net: &str, card: &str) -> bool {
    crate::rt::read_text(format!("{net}/{card}/flags"))
        .ok()
        .and_then(|f| u32::from_str_radix(f.trim().trim_start_matches("0x"), 16).ok())
        .is_none_or(|f| f & IFF_UP != 0)
}

/// Of the connected cards (`macs`, CARDS'), those that are the agent's to bring up (the module's rules).
pub fn unmanaged(lp: &LeasePaths, p: &Paths, macs: &[[u8; 6]]) -> Vec<String> {
    if macs.is_empty() || exists(&p.systemd) || exists(&lp.networkd) || exists(&lp.nm) {
        return Vec::new();
    }
    let mut ifupdown = crate::rt::read_text(&p.interfaces).unwrap_or_default();
    if let Ok(mut names) = crate::rt::dir_names(&p.interfaces_d) {
        crate::rt::sort(&mut names);
        for n in names {
            ifupdown.push('\n');
            ifupdown.push_str(
                &crate::rt::read_text(format!("{}/{n}", p.interfaces_d)).unwrap_or_default(),
            );
        }
    }
    let procs = processes(&lp.proc);
    let titles: Vec<String> = procs
        .iter()
        .filter(|(_, comm, _)| comm == "dhcpcd")
        .filter_map(|(pid, _, _)| {
            let raw = crate::rt::read_file(format!("{}/{}/cmdline", lp.proc, pid.as_raw_nonzero()))
                .ok()?;
            Some(String::from_utf8_lossy(&raw).replace('\0', " "))
        })
        .collect();
    let conf = crate::rt::read_text(&lp.dhcpcd_conf).unwrap_or_default();
    crate::lease::cards(&lp.net, macs)
        .into_iter()
        .filter(|c| !up(&lp.net, c) || exists(&format!("{}/{c}", p.marks)))
        .filter(|c| !named(&ifupdown, c))
        .filter(|c| !procs.iter().any(|(_, _, a)| udhcpc_of(a, c)))
        .filter(|c| !dhcpcd_manages(&titles, &conf, c))
        .collect()
}

/// What brings `cards` up (the module's steps); None without `ip` or udhcpc6 (busybox's applet).
pub fn steps(p: &Paths, cards: &[String]) -> Option<Vec<Step>> {
    if cards.is_empty() {
        return None;
    }
    let ip = found(&p.ip)?;
    let udhcpc6: Vec<String> = match found(&p.udhcpc6) {
        Some(t) => vec![t.clone()],
        None => vec![found(&p.busybox)?.clone(), "udhcpc6".into()],
    };
    let mut out = Vec::new();
    for c in cards {
        out.push(Step::Write(
            format!("{}/{c}/accept_ra_rt_info_max_plen", p.ipv6_conf),
            b"128\n".to_vec(),
        ));
        out.push(Step::Run(
            [ip.as_str(), "link", "set", c.as_str(), "up"]
                .map(String::from)
                .to_vec(),
        ));
        // Its first tries in the foreground (3, 2 s apart, as alpine-demo's udhcpc), then in the background (`-b`),
        // asking again every 3 s: the child ends within ~6 s, and the lease comes when the network has one.
        let mut run = udhcpc6.clone();
        run.extend(
            [
                "-i",
                c.as_str(),
                "-b",
                "-t",
                "3",
                "-T",
                "2",
                "-A",
                "3",
                "-s",
                p.script.as_str(),
            ]
            .map(String::from),
        );
        out.push(Step::Run(run));
    }
    Some(out)
}

/// Marks `cards` as the agent's (a file each in `p.marks`), before it brings them up.
pub fn mark(p: &Paths, cards: &[String]) -> Result<(), rustix::io::Errno> {
    use rustix::fs::{Mode, OFlags};
    match rustix::fs::mkdir(p.marks.as_str(), Mode::from_raw_mode(0o755)) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => {}
        Err(e) => return Err(e),
    }
    for c in cards {
        rustix::fs::open(
            format!("{}/{c}", p.marks).as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o644),
        )?;
    }
    Ok(())
}

/// Writes `SCRIPT` at `p.script` (0755, replaced whole).
pub fn write_script(p: &Paths) -> Result<(), rustix::io::Errno> {
    use rustix::fs::{Mode, OFlags};
    let tmp = format!("{}.new", p.script);
    let fd = rustix::fs::open(
        tmp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o755),
    )?;
    let mut rest = SCRIPT.as_bytes();
    while !rest.is_empty() {
        let n = rustix::io::write(&fd, rest)?;
        rest = &rest[n..];
    }
    drop(fd);
    rustix::fs::rename(tmp.as_str(), p.script.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A guest's files in a directory of the test's: `net/<card>/{device,address,flags}`, `proc`, the ifupdown files.
    struct Guest {
        dir: std::path::PathBuf,
    }

    impl Guest {
        fn new(name: &str) -> Guest {
            let dir =
                std::env::temp_dir().join(format!("waarm64-card-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            for d in ["net", "proc", "conf", "bin", "etc/interfaces.d"] {
                fs::create_dir_all(dir.join(d)).unwrap();
            }
            Guest { dir }
        }
        fn s(&self, p: &str) -> String {
            self.dir.join(p).to_str().unwrap().to_owned()
        }
        fn card(&self, name: &str, mac: &str, flags: &str) {
            let d = self.dir.join("net").join(name);
            fs::create_dir_all(d.join("device")).unwrap();
            fs::write(d.join("address"), format!("{mac}\n")).unwrap();
            fs::write(d.join("flags"), format!("{flags}\n")).unwrap();
        }
        fn process(&self, pid: u32, comm: &str, argv: &[&str]) {
            let d = self.dir.join("proc").join(pid.to_string());
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("comm"), format!("{comm}\n")).unwrap();
            let mut raw = argv.join("\0");
            raw.push('\0');
            fs::write(d.join("cmdline"), raw).unwrap();
        }
        fn paths(&self) -> (LeasePaths, Paths) {
            let lp = LeasePaths {
                networkd: self.s("networkd"),
                busctl: vec![],
                nm: self.s("nm"),
                nmcli: vec![],
                dhcpcd: vec![],
                dhcpcd_conf: self.s("etc/dhcpcd.conf"),
                net: self.s("net"),
                proc: self.s("proc"),
            };
            let p = Paths {
                systemd: self.s("systemd"),
                interfaces: self.s("etc/interfaces"),
                interfaces_d: self.s("etc/interfaces.d"),
                ipv6_conf: self.s("conf"),
                ip: vec![self.s("bin/ip")],
                udhcpc6: vec![self.s("bin/udhcpc6")],
                busybox: vec![self.s("bin/busybox")],
                script: self.s("udhcpc6.script"),
                marks: self.s("marks"),
            };
            (lp, p)
        }
    }

    impl Drop for Guest {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    const ETH0: [u8; 6] = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
    const ETH1: [u8; 6] = [0x52, 0x54, 0x00, 0xab, 0xcd, 0xef];

    /// Alpine's alpine-demo: eth0 up by ifupdown's udhcpc, eth1 down and named nowhere.
    fn alpine(name: &str) -> Guest {
        let g = Guest::new(name);
        g.card("eth0", "52:54:00:12:34:56", "0x1003");
        g.card("eth1", "52:54:00:ab:cd:ef", "0x1002");
        fs::write(
            g.dir.join("etc/interfaces"),
            "auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n\tudhcpc-opts -t 3\n# eth1 is not\n",
        )
        .unwrap();
        g.process(1, "init", &["/sbin/init"]);
        g.process(
            812,
            "udhcpc",
            &[
                "udhcpc",
                "-b",
                "-R",
                "-p",
                "/var/run/udhcpc.eth0.pid",
                "-i",
                "eth0",
                "-t",
                "3",
            ],
        );
        g
    }

    #[test]
    fn only_a_connected_card_nothing_manages() {
        let g = alpine("alpine");
        let (lp, p) = g.paths();
        assert_eq!(unmanaged(&lp, &p, &[ETH0, ETH1]), ["eth1"]);
        assert_eq!(
            unmanaged(&lp, &p, &[ETH0]),
            Vec::<String>::new(),
            "eth1 not connected"
        );
        assert_eq!(unmanaged(&lp, &p, &[]), Vec::<String>::new());
    }

    #[test]
    fn a_card_anything_else_has_is_left_alone() {
        let ifupdown =
            |g: &Guest, text: &str| fs::write(g.dir.join("etc/interfaces.d/eth1"), text).unwrap();
        // Up already (by hand, by a tool the agent doesn't know).
        let g = alpine("up");
        g.card("eth1", "52:54:00:ab:cd:ef", "0x1003");
        let (lp, p) = g.paths();
        assert!(unmanaged(&lp, &p, &[ETH1]).is_empty());
        // Named by ifupdown (a file of interfaces.d too), down until it brings it up (`auto` absent).
        for text in [
            "iface eth1 inet6 static\n",
            "allow-hotplug eth1\n",
            "auto eth1 eth2\n",
        ] {
            let g = alpine("named");
            ifupdown(&g, text);
            let (lp, p) = g.paths();
            assert!(unmanaged(&lp, &p, &[ETH1]).is_empty(), "{text}");
        }
        let g = alpine("comment");
        ifupdown(&g, "# auto eth1\niface eth10 inet dhcp\n");
        let (lp, p) = g.paths();
        assert_eq!(
            unmanaged(&lp, &p, &[ETH1]),
            ["eth1"],
            "a comment, another card"
        );
        // A DHCP client of its own (udhcpc6 the agent started before: a second CARDS), or dhcpcd's manager.
        let g = alpine("client");
        g.process(900, "udhcpc6", &["/sbin/udhcpc6", "-i", "eth1", "-b"]);
        let (lp, p) = g.paths();
        assert!(unmanaged(&lp, &p, &[ETH1]).is_empty());
        let g = alpine("dhcpcd");
        g.process(901, "dhcpcd", &["dhcpcd: [manager] [ip4] [ip6]"]);
        let (lp, p) = g.paths();
        assert!(unmanaged(&lp, &p, &[ETH1]).is_empty());
        // A network manager, or systemd.
        for f in ["networkd", "nm", "systemd"] {
            let g = alpine(f);
            fs::create_dir_all(g.dir.join(f)).unwrap();
            let (lp, p) = g.paths();
            assert!(unmanaged(&lp, &p, &[ETH1]).is_empty(), "{f}");
        }
    }

    /// A card the agent brought up before (its mark) that is up with no client (udhcpc6 didn't start, or died) is
    /// the agent's again; one up by anything else (no mark) stays left alone.
    #[test]
    fn a_card_the_agent_brought_up_whose_client_is_gone_is_tried_again() {
        let g = alpine("again");
        let (lp, p) = g.paths();
        assert_eq!(unmanaged(&lp, &p, &[ETH1]), ["eth1"]);
        mark(&p, &["eth1".into()]).unwrap();
        g.card("eth1", "52:54:00:ab:cd:ef", "0x1003");
        assert_eq!(
            unmanaged(&lp, &p, &[ETH1]),
            ["eth1"],
            "up, the agent's, no udhcpc6"
        );
        g.process(900, "udhcpc6", &["/sbin/udhcpc6", "-i", "eth1", "-b"]);
        assert!(unmanaged(&lp, &p, &[ETH1]).is_empty(), "its udhcpc6 runs");
        let g = alpine("again-named");
        let (lp, p) = g.paths();
        mark(&p, &["eth1".into()]).unwrap();
        g.card("eth1", "52:54:00:ab:cd:ef", "0x1003");
        fs::write(g.dir.join("etc/interfaces.d/eth1"), "auto eth1\n").unwrap();
        assert!(unmanaged(&lp, &p, &[ETH1]).is_empty(), "ifupdown's since");
    }

    #[test]
    fn brings_it_up_with_udhcpc6() {
        let g = alpine("steps");
        let (_, p) = g.paths();
        assert_eq!(steps(&p, &["eth1".into()]), None, "no ip, no udhcpc6");
        fs::write(g.dir.join("bin/ip"), "").unwrap();
        fs::write(g.dir.join("bin/busybox"), "").unwrap();
        for f in ["bin/ip", "bin/busybox"] {
            rustix::fs::chmod(g.s(f).as_str(), rustix::fs::Mode::from_raw_mode(0o755)).unwrap();
        }
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let want = |udhcpc6: &[&str]| {
            let mut run = s(udhcpc6);
            run.extend(s(&[
                "-i",
                "eth1",
                "-b",
                "-t",
                "3",
                "-T",
                "2",
                "-A",
                "3",
                "-s",
                &g.s("udhcpc6.script"),
            ]));
            vec![
                Step::Write(
                    g.s("conf/eth1/accept_ra_rt_info_max_plen"),
                    b"128\n".to_vec(),
                ),
                Step::Run(s(&[&g.s("bin/ip"), "link", "set", "eth1", "up"])),
                Step::Run(run),
            ]
        };
        // busybox's applet through busybox where no link to it is there; the link where it is.
        assert_eq!(
            steps(&p, &["eth1".into()]),
            Some(want(&[&g.s("bin/busybox"), "udhcpc6"]))
        );
        fs::write(g.dir.join("bin/udhcpc6"), "").unwrap();
        rustix::fs::chmod(
            g.s("bin/udhcpc6").as_str(),
            rustix::fs::Mode::from_raw_mode(0o755),
        )
        .unwrap();
        assert_eq!(
            steps(&p, &["eth1".into()]),
            Some(want(&[&g.s("bin/udhcpc6")]))
        );
        assert_eq!(steps(&p, &[]), None);
        write_script(&p).unwrap();
        assert_eq!(
            fs::read_to_string(g.dir.join("udhcpc6.script")).unwrap(),
            SCRIPT
        );
    }

    #[test]
    fn lease_renews_the_cards_udhcpc6() {
        let g = alpine("lease");
        g.process(
            900,
            "udhcpc6",
            &[
                "/sbin/udhcpc6",
                "-i",
                "eth1",
                "-b",
                "-s",
                "/run/waarm64-udhcpc6.script",
            ],
        );
        let (lp, _) = g.paths();
        let steps = crate::lease::commands(&lp, &[ETH0, ETH1]).unwrap();
        let pid = |n| rustix::process::Pid::from_raw(n).unwrap();
        assert_eq!(
            steps,
            [
                Step::Signal(pid(812), rustix::process::Signal::USR1),
                Step::Signal(pid(900), rustix::process::Signal::USR1)
            ]
        );
    }

    #[test]
    fn named_words_only() {
        assert!(named("auto lo eth1\n", "eth1"));
        assert!(!named("auto eth10\n", "eth1"));
        assert!(!named("  # iface eth1\n", "eth1"));
        assert!(named("iface eth1 inet dhcp # the room\n", "eth1"));
    }
}
