//! What the clipboard's sharing decides, apart from its protocols (docs/plans/clipboard.md §2, §3.2, §4.4): the types
//! the agent takes and offers, the size caps, the hash that suppresses echoes.

/// The page's type for text, and the one the agent offers it.
pub const TEXT: &str = "text/plain;charset=utf-8";

/// The types a guest program may ask the host's text for: what the agent's data source offers (X11's names too, as
/// Xwayland's bridge and wl-clipboard use them).
pub const TEXT_ALIASES: [&str; 6] = [TEXT, "text/plain", "UTF8_STRING", "TEXT", "STRING", "text"];

/// The most text that crosses (plan §3.2), checked against an offer's size before any bytes do, and against what
/// has come so far while a size isn't known.
pub const TEXT_CAP: usize = 16 << 20;
/// The page's one image type, which the agent prefers among a guest program's (plan §4.4).
pub const PNG: &str = "image/png";
/// The most image bytes that cross (plan §4.4), checked as `TEXT_CAP` is.
pub const IMAGE_CAP: usize = 64 << 20;
/// The image types the page takes from the guest after PNG, which it converts to PNG (what `createImageBitmap`
/// decodes): passed through as the guest's program offered them (the agent converts nothing).
const IMAGES: [&str; 7] = [
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/x-bmp",
    "image/x-ms-bmp",
    "image/gif",
    "image/avif",
];

/// Text up to this size comes inline in its OFFER (plan §2), saving a round trip.
pub const INLINE: usize = 4096;
/// The host's text up to this size is kept once it has crossed, so that repeated pastes don't cross again (plan
/// §3.3 "Streaming").
pub const CACHE: usize = 64 << 10;

/// Of the types a guest program offers, the one the agent reads its text as: UTF-8 first, a name without a charset
/// (taken as UTF-8, as wl-clipboard does) next. None: no text (an image alone: `pick_image`).
pub fn pick_text<'a>(types: &[&'a str]) -> Option<&'a str> {
    let utf8 = |t: &str| {
        t.eq_ignore_ascii_case("text/plain;charset=utf-8")
            || t.eq_ignore_ascii_case("text/plain; charset=utf-8")
    };
    let rank = |t: &str| -> Option<u8> {
        Some(match t {
            _ if utf8(t) => 0,
            "UTF8_STRING" => 1,
            "text/plain" => 2,
            "STRING" | "TEXT" | "text" => 3,
            _ => return None,
        })
    };
    types
        .iter()
        .filter_map(|&t| Some((rank(t)?, t)))
        .min_by_key(|&(r, _)| r)
        .map(|(_, t)| t)
}

/// Of the types a guest program offers, the image the agent offers the page: `image/png` first, else the first of
/// the others the page converts (`IMAGES`, in their order). None: no image the page takes (SVG, TIFF).
pub fn pick_image<'a>(types: &[&'a str]) -> Option<&'a str> {
    if let Some(&t) = types.iter().find(|t| t.eq_ignore_ascii_case(PNG)) {
        return Some(t);
    }
    IMAGES
        .iter()
        .find_map(|i| types.iter().find(|t| t.eq_ignore_ascii_case(i)).copied())
}

/// Whether `t` is an image type (images pass through the agent: never cached, never hashed).
pub fn is_image(t: &str) -> bool {
    t.len() > 6 && t.as_bytes()[..6].eq_ignore_ascii_case(b"image/")
}

/// The most bytes of type `mime` that cross: an image's cap, else text's.
pub fn cap(mime: &str) -> usize {
    if is_image(mime) { IMAGE_CAP } else { TEXT_CAP }
}

/// What the guest's new selection becomes, from its first bytes (`first`, up to `INLINE` + 1 of them; `complete`: all
/// of it) and the hash of the host's last text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Announce {
    /// An OFFER with the bytes.
    Inline,
    /// An OFFER without them (longer than `INLINE`): the page requests them.
    Lazy,
    /// Nothing: empty, or the host's own text back (echo suppression).
    Nothing,
}

pub fn announce(first: &[u8], complete: bool, last_host: Option<Hash>) -> Announce {
    if !complete || first.len() > INLINE {
        Announce::Lazy
    } else if first.is_empty() || last_host == Some(Hash::of(first)) {
        Announce::Nothing
    } else {
        Announce::Inline
    }
}

/// Whether the page's type `t` is text the agent takes.
pub fn is_page_text(t: &str) -> bool {
    t == TEXT || t == "text/plain"
}

/// FNV-1a, 64 bits: the hash a side remembers of the last thing it received, so that the same thing offered back
/// (the host's text pasted, then copied again) isn't sent (plan §2 "Echo suppression").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hash(u64);

impl Default for Hash {
    fn default() -> Hash {
        Hash(0xcbf2_9ce4_8422_2325)
    }
}

impl Hash {
    pub fn of(bytes: &[u8]) -> Hash {
        let mut h = Hash::default();
        h.add(bytes);
        h
    }

    pub fn add(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_utf8_text_first() {
        assert_eq!(
            pick_text(&["text/plain", "UTF8_STRING", "text/plain;charset=utf-8"]),
            Some("text/plain;charset=utf-8")
        );
        assert_eq!(
            pick_text(&["TEXT", "text/plain;charset=UTF-8"]),
            Some("text/plain;charset=UTF-8")
        );
        assert_eq!(
            pick_text(&["STRING", "text/plain", "UTF8_STRING"]),
            Some("UTF8_STRING")
        );
        assert_eq!(pick_text(&["TEXT", "text/plain"]), Some("text/plain"));
        assert_eq!(pick_text(&["image/png", "text/html"]), None);
        assert_eq!(pick_text(&[]), None);
        assert!(TEXT_ALIASES.iter().all(|t| pick_text(&[t]).is_some()));
        assert!(is_page_text(TEXT) && is_page_text("text/plain") && !is_page_text("image/png"));
    }

    #[test]
    fn picks_png_first_then_the_images_the_page_converts() {
        assert_eq!(
            pick_image(&["text/plain", "image/jpeg", "image/png"]),
            Some("image/png")
        );
        assert_eq!(pick_image(&["image/bmp", "image/jpeg"]), Some("image/jpeg"));
        assert_eq!(pick_image(&["IMAGE/PNG"]), Some("IMAGE/PNG"));
        assert_eq!(pick_image(&["image/x-ms-bmp"]), Some("image/x-ms-bmp"));
        assert_eq!(pick_image(&["image/svg+xml", "text/html"]), None);
        assert_eq!(pick_image(&["image/tiff"]), None);
        assert_eq!((cap(PNG), cap("image/jpeg")), (IMAGE_CAP, IMAGE_CAP));
        assert_eq!(cap(TEXT), TEXT_CAP);
        assert!(is_image("image/png") && !is_image("image/") && !is_image(TEXT));
    }

    #[test]
    fn the_guests_selection_is_announced_unless_it_is_the_hosts_own() {
        let host = Some(Hash::of(b"from the host"));
        assert_eq!(announce(b"from the guest", true, host), Announce::Inline);
        assert_eq!(
            announce(b"from the host", true, host),
            Announce::Nothing,
            "an echo"
        );
        assert_eq!(announce(b"from the host", true, None), Announce::Inline);
        assert_eq!(announce(b"", true, None), Announce::Nothing);
        assert_eq!(announce(&[b'x'; INLINE], true, None), Announce::Inline);
        assert_eq!(announce(&[b'x'; INLINE + 1], false, None), Announce::Lazy);
        assert_eq!(announce(&[b'x'; INLINE + 1], true, None), Announce::Lazy);
    }

    #[test]
    fn the_hash_is_fnv1a_and_streams() {
        // FNV-1a 64's published values.
        assert_eq!(Hash::of(b""), Hash(0xcbf2_9ce4_8422_2325));
        assert_eq!(Hash::of(b"a"), Hash(0xaf63_dc4c_8601_ec8c));
        assert_eq!(Hash::of(b"foobar"), Hash(0x8594_4171_f739_67e8));
        let mut h = Hash::default();
        h.add(b"foo");
        h.add(b"bar");
        assert_eq!(h, Hash::of(b"foobar"), "in pieces as whole");
    }
}
