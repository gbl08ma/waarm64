//! OS (docs/devices.md "The guest's OS"): the guest's operating system as its `os-release` names it, for the page's
//! status bar, sent after the agent's HELLO to a page that takes it. The file is `/etc/os-release`, else
//! `/usr/lib/os-release` (os-release(5)), read at each connection (a few hundred bytes): an upgrade between two
//! connections shows.

use crate::prelude::*;

/// Where the file is looked for, in order (the tests' are theirs).
#[derive(Clone)]
pub struct Paths {
    pub files: Vec<String>,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            files: vec!["/etc/os-release".into(), "/usr/lib/os-release".into()],
        }
    }
}

/// A value as os-release(5) writes it, a shell's: unquoted, in single quotes (as it is), or in double quotes (`\"`,
/// `\\`, `` \` `` and `\$` taken as the character escaped).
fn unquote(v: &str) -> String {
    let v = v.trim();
    if let Some(s) = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return s.into();
    }
    let Some(s) = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return v.into();
    };
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(e @ ('"' | '\\' | '`' | '$')) => out.push(e),
                Some(e) => {
                    out.push('\\');
                    out.push(e);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The value of `key` in an os-release file's text (its last assignment), unquoted.
pub fn field(text: &str, key: &str) -> Option<String> {
    text.lines()
        .filter_map(|l| l.trim_start().strip_prefix(key)?.strip_prefix('='))
        .next_back()
        .map(unquote)
}

/// What the page shows: PRETTY_NAME, else NAME and VERSION, else NAME, else "Linux" (os-release(5)'s defaults); ID and
/// VERSION_ID beside it.
pub fn names(text: &str) -> [String; 3] {
    let pretty = field(text, "PRETTY_NAME")
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let name = field(text, "NAME").filter(|s| !s.is_empty())?;
            Some(match field(text, "VERSION").filter(|s| !s.is_empty()) {
                Some(v) => format!("{name} {v}"),
                None => name,
            })
        })
        .unwrap_or_else(|| "Linux".into());
    [
        pretty,
        field(text, "ID").unwrap_or_else(|| "linux".into()),
        field(text, "VERSION_ID").unwrap_or_default(),
    ]
}

/// A string as the frames carry it: a u8 length (at most 255 bytes, cut between characters), then its UTF-8.
fn push_str(s: &str, out: &mut Vec<u8>) {
    let mut n = s.len().min(255);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    out.push(n as u8);
    out.extend_from_slice(&s.as_bytes()[..n]);
}

/// OS's payload: the pretty name, ID and VERSION_ID (each a u8 length and its UTF-8); a guest without the file is
/// "Linux" (os-release(5)'s default).
pub fn payload(p: &Paths) -> Vec<u8> {
    let text = p
        .files
        .iter()
        .find_map(|f| crate::rt::read_text(f.as_str()).ok())
        .unwrap_or_default();
    let mut out = Vec::new();
    for s in names(&text) {
        push_str(&s, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_os_release_as_a_shell_would() {
        // Debian 13's, as it ships.
        let debian = "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"13\"\nVERSION=\"13 (trixie)\"\nVERSION_CODENAME=trixie\nDEBIAN_VERSION_FULL=13.1\nID=debian\n";
        assert_eq!(
            names(debian),
            ["Debian GNU/Linux 13 (trixie)", "debian", "13"].map(String::from)
        );
        // Arch's: no VERSION_ID.
        let arch = "NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\nBUILD_ID=rolling\n";
        assert_eq!(names(arch), ["Arch Linux", "arch", ""].map(String::from));
        // No pretty name: NAME and VERSION; nothing: os-release(5)'s defaults.
        assert_eq!(
            names("NAME=Foo\nVERSION='1 (x)'\n")[0],
            "Foo 1 (x)",
            "single quotes as they are"
        );
        assert_eq!(names("NAME=Foo\n")[0], "Foo");
        assert_eq!(names(""), ["Linux", "linux", ""].map(String::from));
        // Escapes in double quotes; a key that only starts like another; the last assignment.
        assert_eq!(
            field(r#"PRETTY_NAME="A \"b\" \$c \\ \n""#, "PRETTY_NAME").as_deref(),
            Some(r#"A "b" $c \ \n"#)
        );
        assert_eq!(field("IDX=1\nID=a\nID=b\n", "ID").as_deref(), Some("b"));
        assert_eq!(field("# ID=c\n", "ID"), None);
    }

    #[test]
    fn its_payload_cuts_long_names_between_characters() {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-os-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (etc, lib) = (dir.join("etc"), dir.join("lib"));
        let p = Paths {
            files: [&etc, &lib]
                .map(|f| f.to_str().unwrap().to_owned())
                .to_vec(),
        };
        assert_eq!(payload(&p), b"\x05Linux\x05linux\x00", "no file");
        std::fs::write(&lib, "ID=lib\n").unwrap();
        assert_eq!(payload(&p), b"\x05Linux\x03lib\x00", "/usr/lib's");
        let long = format!("{}é", "x".repeat(254));
        std::fs::write(&etc, format!("PRETTY_NAME={long}\nID=etc\nVERSION_ID=1\n")).unwrap();
        let got = payload(&p);
        assert_eq!(got[0], 254, "the é not cut in two");
        assert_eq!(&got[255..], b"\x03etc\x011");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
