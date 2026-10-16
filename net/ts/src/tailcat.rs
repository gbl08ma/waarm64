//! tailcat's side of the protocol (github.com/tailscale/tailcat, BSD-3-Clause,
//! v0.7.0): its addresses (`wire.go`, `ParseAddr` in `tailcat.go`), the "meow"
//! handshake over DERP (`disco.go`) and the tunnel addresses derived from node
//! keys (`tcAddrForKey`). Reimplemented from those files, not copied.

use std::collections::BTreeMap;

use base64::Engine;
use serde::Deserialize;

use crate::cbor::{self, Value};

/// One DERP server of a region.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DerpNode {
    pub host_name: String,
    /// The certificate's name when it isn't `host_name`; a browser can't
    /// check against another name, so such a node can't be used from one.
    pub cert_name: String,
    pub derp_port: u16,
}

impl DerpNode {
    /// The WebSocket URL of the node's DERP service (Go's derphttp client in
    /// js/wasm uses the same: https on the node's port, path /derp).
    pub fn url(&self) -> String {
        match self.derp_port {
            0 | 443 => format!("wss://{}/derp", self.host_name),
            p => format!("wss://{}:{p}/derp", self.host_name),
        }
    }

    /// The URL, if a browser can use the node: it checks the certificate
    /// against the host name, so a node with another certificate name can't be.
    pub fn browser_url(&self) -> Option<String> {
        (!self.host_name.is_empty()
            && (self.cert_name.is_empty() || self.cert_name == self.host_name))
            .then(|| self.url())
    }
}

/// What a tailcat address says.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnInfo {
    pub server: [u8; 32],
    pub server_disco: Option<[u8; 32]>,
    pub psk: Option<[u8; 32]>,
    /// The region in the public DERP map, when the address doesn't carry its nodes.
    pub region_id: i64,
    /// The nodes of the address's own region(s), in order.
    pub nodes: Vec<DerpNode>,
}

fn key32(v: Option<&Value>, what: &str) -> Result<Option<[u8; 32]>, String> {
    match v {
        None => Ok(None),
        Some(Value::Bytes(b)) => b
            .as_slice()
            .try_into()
            .map(Some)
            .map_err(|_| format!("{what}: {} bytes, not 32", b.len())),
        Some(_) => Err(format!("{what} isn't a byte string")),
    }
}

fn text(m: &BTreeMap<String, Value>, k: &str) -> String {
    match m.get(k) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    }
}

fn int(m: &BTreeMap<String, Value>, k: &str) -> i64 {
    match m.get(k) {
        Some(Value::Uint(n)) => i64::try_from(*n).unwrap_or(0),
        Some(Value::Nint(n)) => *n,
        _ => 0,
    }
}

/// Parses a `tc…` address.
pub fn parse_addr(addr: &str) -> Result<ConnInfo, String> {
    let rest = addr
        .trim()
        .strip_prefix("tc")
        .ok_or("a tailcat address starts with \"tc\"")?;
    let b = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(rest)
        .map_err(|e| format!("not a tailcat address (base64: {e})"))?;
    let Value::Map(m) = cbor::decode(&b).map_err(|e| format!("not a tailcat address ({e})"))?
    else {
        return Err("not a tailcat address (not a map)".into());
    };
    let server = key32(m.get("p"), "the server's key")?.ok_or("the address has no server key")?;
    let mut nodes = Vec::new();
    if let Some(Value::Array(regions)) = m.get("r") {
        for r in regions {
            let Value::Map(r) = r else {
                return Err("invalid tailcat address: a region isn't a map".into());
            };
            let Some(Value::Array(ns)) = r.get("N") else {
                continue;
            };
            for n in ns {
                let Value::Map(n) = n else {
                    return Err("invalid tailcat address: a node isn't a map".into());
                };
                nodes.push(DerpNode {
                    host_name: text(n, "h"),
                    cert_name: text(n, "t"),
                    derp_port: int(n, "d").clamp(0, 65535) as u16,
                });
            }
        }
    }
    let region_id = int(&m, "i");
    if nodes.is_empty() && region_id == 0 {
        return Err("the address names no DERP relay".into());
    }
    Ok(ConnInfo {
        server,
        server_disco: key32(m.get("k"), "the disco key")?,
        psk: key32(m.get("q"), "the pre-shared key")?,
        region_id,
        nodes,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DerpMapJson {
    regions: BTreeMap<String, RegionJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RegionJson {
    #[serde(default)]
    nodes: Vec<NodeJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct NodeJson {
    #[serde(default)]
    host_name: String,
    #[serde(default)]
    cert_name: String,
    #[serde(rename = "DERPPort", default)]
    derp_port: u16,
    #[serde(rename = "STUNOnly", default)]
    stun_only: bool,
}

/// The nodes of region `id` in a DERP map (Tailscale's JSON `tailcfg.DERPMap`).
pub fn region_nodes(derp_map: &[u8], id: i64) -> Result<Vec<DerpNode>, String> {
    let dm: DerpMapJson =
        serde_json::from_slice(derp_map).map_err(|e| format!("the DERP map: {e}"))?;
    let r = dm
        .regions
        .get(&id.to_string())
        .ok_or_else(|| format!("the DERP map has no region {id}"))?;
    let nodes: Vec<_> = r
        .nodes
        .iter()
        .filter(|n| !n.stun_only && !n.host_name.is_empty())
        .map(|n| DerpNode {
            host_name: n.host_name.clone(),
            cert_name: n.cert_name.clone(),
            derp_port: n.derp_port,
        })
        .collect();
    if nodes.is_empty() {
        return Err(format!("region {id} of the DERP map has no DERP nodes"));
    }
    Ok(nodes)
}

/// The tunnel address of a node key: Tailscale's ULA prefix and the key's first 80 bits.
pub fn addr_for_key(k: &[u8; 32]) -> [u8; 16] {
    let mut a = [0u8; 16];
    a[..6].copy_from_slice(&[0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]);
    a[6..].copy_from_slice(&k[..10]);
    a
}

const MEOW: &[u8; 4] = b"meow";
const MEOW_PING: u8 = 1;
const MEOW_PONG: u8 = 2;

pub fn is_meow(p: &[u8]) -> bool {
    p.len() >= 4 && &p[..4] == MEOW
}

/// The client's hello: our node key and disco key.
pub fn meow_ping(node: &[u8; 32], disco: &[u8; 32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(69);
    b.extend_from_slice(MEOW);
    b.push(MEOW_PING);
    b.extend_from_slice(node);
    b.extend_from_slice(disco);
    b
}

pub fn is_meowed(p: &[u8]) -> bool {
    p.len() >= 5 && is_meow(p) && p[4] == MEOW_PONG
}

/// A client's hello, as a server sees it: its node key and disco key.
pub fn parse_meow_ping(p: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    if p.len() < 69 || !is_meow(p) || p[4] != MEOW_PING {
        return None;
    }
    let disco: [u8; 32] = p[37..69].try_into().unwrap();
    if disco == [0; 32] {
        return None;
    }
    Some((p[5..37].try_into().unwrap(), disco))
}

#[cfg(test)]
mod tests {
    use super::*;

    // An address printed by `tailcat serve --key=… exit-node` on a test DERP
    // (`--region=derp.test`); its server is long gone.
    const ADDR: &str = "tcpGFwWCD6tj4GWmabWiCU0q3bAIGiFEcL6Go87N0Qni4RXuJhJmFrWCBC_L02Yu8_NEGn0VTiLqGBwlkQrHPf6CSafFRGuItfa2FxWCDiOfsMhfnPU0l4J6uNzlWpHAiXT7YYZFkqTzlrMprJ5mFygaFhToGhYWhpZGVycC50ZXN0";

    fn hex(s: &str) -> [u8; 32] {
        let v: Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    #[test]
    fn parses_what_tailcat_printed() {
        // `tailcat parse` of the same address gave these.
        let ci = parse_addr(ADDR).unwrap();
        assert_eq!(
            ci.server,
            hex("fab63e065a669b5a2094d2addb0081a214470be86a3cecdd109e2e115ee26126")
        );
        assert_eq!(
            ci.server_disco,
            Some(hex(
                "42fcbd3662ef3f3441a7d154e22ea181c25910ac73dfe8249a7c5446b88b5f6b"
            ))
        );
        assert_eq!(
            ci.psk,
            Some(hex(
                "e239fb0c85f9cf53497827ab8dce55a91c08974fb61864592a4f396b329ac9e6"
            ))
        );
        assert_eq!(
            ci.nodes,
            vec![DerpNode {
                host_name: "derp.test".into(),
                ..Default::default()
            }]
        );
        assert_eq!(ci.nodes[0].url(), "wss://derp.test/derp");
        // The server's own log gave its address.
        assert_eq!(
            addr_for_key(&ci.server),
            [
                0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0xfa, 0xb6, 0x3e, 0x06, 0x5a, 0x66, 0x9b, 0x5a,
                0x20, 0x94
            ]
        );
    }

    #[test]
    fn rejects_non_addresses() {
        assert!(parse_addr("hello").is_err());
        assert!(parse_addr("tc!!!").is_err());
        assert!(parse_addr(&ADDR[..60]).is_err());
    }

    #[test]
    fn reads_a_region_from_a_derp_map() {
        let dm = br#"{"Regions":{"7":{"RegionID":7,"Nodes":[{"Name":"7s","HostName":"stun.x","STUNOnly":true},{"Name":"7a","HostName":"d.x","DERPPort":8443}]}}}"#;
        assert_eq!(
            region_nodes(dm, 7).unwrap(),
            vec![DerpNode {
                host_name: "d.x".into(),
                cert_name: String::new(),
                derp_port: 8443
            }]
        );
        assert!(region_nodes(dm, 8).is_err());
    }

    #[test]
    fn meows() {
        let p = meow_ping(&[1; 32], &[2; 32]);
        assert_eq!(parse_meow_ping(&p), Some(([1; 32], [2; 32])));
        assert!(is_meowed(b"meow\x02"));
        assert!(!is_meowed(&p));
    }
}
