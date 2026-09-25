//! A minimal flattened device tree (DTB) writer: header, an empty memory
//! reservation map, the structure block and the strings block
//! (devicetree-specification v0.4, chapter 5). Big-endian throughout.

const MAGIC: u32 = 0xd00d_feed;
const BEGIN_NODE: u32 = 1;
const END_NODE: u32 = 2;
const PROP: u32 = 3;
const END: u32 = 9;
const HEADER: usize = 40;
const RSVMAP: usize = 16; // one terminating {0, 0} entry

#[derive(Default)]
pub struct Fdt {
    st: Vec<u8>,
    strings: Vec<u8>,
}

impl Fdt {
    fn word(&mut self, v: u32) {
        self.st.extend_from_slice(&v.to_be_bytes());
    }

    fn pad(&mut self) {
        while !self.st.len().is_multiple_of(4) {
            self.st.push(0);
        }
    }

    pub fn begin(&mut self, name: &str) {
        self.word(BEGIN_NODE);
        self.st.extend_from_slice(name.as_bytes());
        self.st.push(0);
        self.pad();
    }

    pub fn end(&mut self) {
        self.word(END_NODE);
    }

    pub fn prop(&mut self, name: &str, value: &[u8]) {
        let off = self.name_offset(name);
        self.word(PROP);
        self.word(value.len() as u32);
        self.word(off);
        self.st.extend_from_slice(value);
        self.pad();
    }

    /// An offset into the strings block, sharing an earlier copy of `name`.
    fn name_offset(&mut self, name: &str) -> u32 {
        let mut want = name.as_bytes().to_vec();
        want.push(0);
        let mut start = 0;
        for (i, &b) in self.strings.iter().enumerate() {
            if b == 0 {
                if self.strings[start..=i] == want[..] {
                    return start as u32;
                }
                start = i + 1;
            }
        }
        let off = self.strings.len() as u32;
        self.strings.extend_from_slice(&want);
        off
    }

    /// Empty property (a flag such as `interrupt-controller`).
    pub fn flag(&mut self, name: &str) {
        self.prop(name, &[]);
    }

    pub fn cells(&mut self, name: &str, v: &[u32]) {
        let b: Vec<u8> = v.iter().flat_map(|c| c.to_be_bytes()).collect();
        self.prop(name, &b);
    }

    /// 64-bit values as two cells each (`#address-cells` = `#size-cells` = 2).
    pub fn cells64(&mut self, name: &str, v: &[u64]) {
        let b: Vec<u8> = v.iter().flat_map(|c| c.to_be_bytes()).collect();
        self.prop(name, &b);
    }

    /// A string list: each NUL-terminated.
    pub fn strs(&mut self, name: &str, v: &[&str]) {
        let b: Vec<u8> = v.iter().flat_map(|s| s.bytes().chain([0])).collect();
        self.prop(name, &b);
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.word(END);
        let off_struct = HEADER + RSVMAP;
        let off_strings = off_struct + self.st.len();
        let total = off_strings + self.strings.len();
        let header = [
            MAGIC,
            total as u32,
            off_struct as u32,
            off_strings as u32,
            HEADER as u32, // memory reservation map
            17,            // version
            16,            // last compatible version
            0,             // boot CPU
            self.strings.len() as u32,
            self.st.len() as u32,
        ];
        let mut out: Vec<u8> = header.iter().flat_map(|w| w.to_be_bytes()).collect();
        out.resize(off_struct, 0);
        out.extend_from_slice(&self.st);
        out.extend_from_slice(&self.strings);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_and_shared_names() {
        let mut f = Fdt::default();
        f.begin("");
        f.cells("#size-cells", &[2]);
        f.begin("a@1");
        f.cells("#size-cells", &[1]);
        f.strs("compatible", &["x", "yz"]);
        f.end();
        f.end();
        let b = f.finish();
        let w = |o: usize| u32::from_be_bytes(b[o..o + 4].try_into().unwrap());
        assert_eq!(
            (w(0), w(4) as usize, w(20), w(32)),
            (MAGIC, b.len(), 17, 23)
        );
        assert_eq!(&b[w(12) as usize..], b"#size-cells\0compatible\0");
        // Root node: BEGIN_NODE, "" padded to 4, then PROP len 4, nameoff 0, value 2.
        assert_eq!(
            (w(56), w(60), w(64), w(68), w(72), w(76)),
            (1, 0, 3, 4, 0, 2)
        );
        assert_eq!(w(w(12) as usize - 4), END);
    }
}
