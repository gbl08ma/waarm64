//! The little CBOR (RFC 8949) a tailcat address needs: definite-length maps,
//! arrays, byte and text strings, integers and booleans. Anything else is an
//! error, as are indefinite lengths and nesting deeper than a few levels.
//! `encode` writes the same subset, with the shortest heads (RFC 8949 §4.2.1).

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Uint(u64),
    Nint(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Value>),
    Map(BTreeMap<String, Value>),
    Bool(bool),
    Null,
}

const MAX_DEPTH: usize = 8;

/// Decodes one value that must take all of `b`.
pub fn decode(b: &[u8]) -> Result<Value, String> {
    let mut at = 0;
    let v = item(b, &mut at, 0)?;
    if at != b.len() {
        return Err(format!("{} bytes after the CBOR value", b.len() - at));
    }
    Ok(v)
}

fn take<'a>(b: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8], String> {
    let end = at
        .checked_add(n)
        .filter(|&e| e <= b.len())
        .ok_or("CBOR value truncated")?;
    let s = &b[*at..end];
    *at = end;
    Ok(s)
}

/// The argument of an initial byte with additional info `ai`.
fn argument(b: &[u8], at: &mut usize, ai: u8) -> Result<u64, String> {
    Ok(match ai {
        0..=23 => ai as u64,
        24 => take(b, at, 1)?[0] as u64,
        25 => u16::from_be_bytes(take(b, at, 2)?.try_into().unwrap()) as u64,
        26 => u32::from_be_bytes(take(b, at, 4)?.try_into().unwrap()) as u64,
        27 => u64::from_be_bytes(take(b, at, 8)?.try_into().unwrap()),
        _ => return Err(format!("unsupported CBOR additional info {ai}")),
    })
}

fn item(b: &[u8], at: &mut usize, depth: usize) -> Result<Value, String> {
    if depth > MAX_DEPTH {
        return Err("CBOR nested too deeply".into());
    }
    let ib = take(b, at, 1)?[0];
    let (major, ai) = (ib >> 5, ib & 31);
    if major == 7 {
        return match ai {
            20 => Ok(Value::Bool(false)),
            21 => Ok(Value::Bool(true)),
            22 => Ok(Value::Null),
            _ => Err(format!("unsupported CBOR simple value {ai}")),
        };
    }
    let n = argument(b, at, ai)?;
    // Every element takes at least a byte: a count over what's left is a lie.
    let count = |n: u64| -> Result<usize, String> {
        if n > (b.len() - *at) as u64 {
            Err("CBOR length past the end".into())
        } else {
            Ok(n as usize)
        }
    };
    match major {
        0 => Ok(Value::Uint(n)),
        1 => i64::try_from(n)
            .map(|n| Value::Nint(-1 - n))
            .map_err(|_| "CBOR integer out of range".into()),
        2 => Ok(Value::Bytes(take(b, at, count(n)?)?.to_vec())),
        3 => String::from_utf8(take(b, at, count(n)?)?.to_vec())
            .map(Value::Text)
            .map_err(|_| "CBOR text isn't UTF-8".into()),
        4 => (0..count(n)?)
            .map(|_| item(b, at, depth + 1))
            .collect::<Result<_, _>>()
            .map(Value::Array),
        5 => {
            let mut m = BTreeMap::new();
            for _ in 0..count(n)? {
                let Value::Text(k) = item(b, at, depth + 1)? else {
                    return Err("CBOR map key isn't text".into());
                };
                let v = item(b, at, depth + 1)?;
                m.insert(k, v);
            }
            Ok(Value::Map(m))
        }
        _ => Err(format!("unsupported CBOR major type {major}")),
    }
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(m | 26);
            out.extend_from_slice(&(n as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&n.to_be_bytes());
        }
    }
}

/// Encodes `v` (map keys in `BTreeMap` order).
pub fn encode(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(&mut out, v);
    out
}

fn encode_into(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Uint(n) => head(out, 0, *n),
        Value::Nint(n) => head(out, 1, (-1 - *n) as u64),
        Value::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
        Value::Text(t) => {
            head(out, 3, t.len() as u64);
            out.extend_from_slice(t.as_bytes());
        }
        Value::Array(a) => {
            head(out, 4, a.len() as u64);
            for x in a {
                encode_into(out, x);
            }
        }
        Value::Map(m) => {
            head(out, 5, m.len() as u64);
            for (k, x) in m {
                encode_into(out, &Value::Text(k.clone()));
                encode_into(out, x);
            }
        }
        Value::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
        Value::Null => out.push(0xf6),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_basic_types() {
        let v = decode(&[
            0xa3, 0x61, b'a', 0x18, 0x64, 0x61, b'b', 0x42, 1, 2, 0x61, b'c', 0x82, 0x20, 0xf5,
        ])
        .unwrap();
        let Value::Map(m) = v else { panic!() };
        assert_eq!(m["a"], Value::Uint(100));
        assert_eq!(m["b"], Value::Bytes(vec![1, 2]));
        assert_eq!(
            m["c"],
            Value::Array(vec![Value::Nint(-1), Value::Bool(true)])
        );
    }

    #[test]
    fn encodes_what_it_decodes() {
        let b = [
            0xa3, 0x61, b'a', 0x18, 0x64, 0x61, b'b', 0x42, 1, 2, 0x61, b'c', 0x82, 0x20, 0xf5,
        ];
        assert_eq!(encode(&decode(&b).unwrap()), b);
        for n in [0, 23, 24, 255, 256, 65535, 65536, u32::MAX as u64 + 1] {
            assert_eq!(decode(&encode(&Value::Uint(n))).unwrap(), Value::Uint(n));
        }
        assert_eq!(encode(&Value::Uint(500)), [0x19, 1, 0xf4]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(decode(&[0x5a, 0xff, 0xff, 0xff, 0xff]).is_err()); // a byte string longer than the input
        assert!(decode(&[0x9f]).is_err()); // indefinite length
        assert!(decode(&[0xa1, 0x01, 0x01]).is_err()); // integer map key
        assert!(decode(&[0x01, 0x01]).is_err()); // trailing bytes
        assert!(decode(&[0x81; 20]).is_err()); // too deep
    }
}
