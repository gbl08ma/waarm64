//! The node's view of its tailnet, kept from the control server's map responses: parsed with
//! tailscale-rs's `ts_control_serde` (which borrows from each response) into owned state, with
//! the deltas applied as Tailscale's `controlclient` applies them (a full peer list replaces;
//! `PeersChanged` upserts, `PeersRemoved` removes, `PeersChangedPatch`/`OnlineChange` patch).

use std::{collections::BTreeMap, net::IpAddr};

use ipnet::IpNet;
use serde_json::json;
use ts_control_serde::{DerpIpUsage, MapResponse};
use ts_keys::ExportableKey;

use crate::tailcat::DerpNode;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Node {
    pub id: i64,
    pub stable_id: String,
    pub name: String,
    pub key: [u8; 32],
    pub disco: Option<[u8; 32]>,
    pub addresses: Vec<IpNet>,
    pub allowed_ips: Vec<IpNet>,
    pub home_derp: Option<u32>,
    pub online: Option<bool>,
    pub user: i64,
    pub hostname: String,
    pub machine_authorized: bool,
    pub expired: bool,
    /// Its node attributes (`CapMap`'s keys).
    pub caps: Vec<String>,
}

impl Node {
    /// Offers itself as an exit node: a default route among its AllowedIPs.
    pub fn exit_node_option(&self) -> bool {
        self.allowed_ips.iter().any(|n| n.prefix_len() == 0)
    }

    #[allow(deprecated)] // the old DERP field, for older control servers
    fn from_wire(n: &ts_control_serde::Node<'_>) -> Self {
        let (v4, v6) = n.addresses;
        let addresses = vec![IpNet::V4(v4), IpNet::V6(v6)];
        let caps: Vec<String> = n.cap_map.keys().map(|k| k.to_string()).collect();
        Node {
            id: n.id,
            stable_id: n.stable_id.0.to_string(),
            name: n.name.to_string(),
            key: *n.key.export().as_bytes(),
            disco: n.disco_key.map(|k| *k.export().as_bytes()),
            allowed_ips: n.allowed_ips.clone().unwrap_or_else(|| addresses.clone()),
            addresses,
            home_derp: n.home_derp.or(n.legacy_derp_string).map(u32::from),
            online: n.online,
            user: n.user,
            hostname: n.host_info.hostname.unwrap_or_default().to_string(),
            machine_authorized: n.machine_authorized,
            expired: n.expired,
            caps,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Region {
    pub id: u32,
    pub code: String,
    pub nodes: Vec<DerpNode>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Dns {
    /// MagicDNS on (`Proxied`): the node answers at 100.100.100.100.
    pub magic: bool,
    /// Plain resolvers (IP and port); DoH ones as URLs.
    pub resolvers: Vec<String>,
    pub domains: Vec<String>,
    /// Split DNS: suffix → resolvers (empty: answered by MagicDNS).
    pub routes: BTreeMap<String, Vec<String>>,
    /// Extra records: name → address.
    pub extra: Vec<(String, IpAddr)>,
}

#[derive(Debug, Default)]
pub struct NetMap {
    pub node: Option<Node>,
    pub peers: BTreeMap<i64, Node>,
    pub regions: BTreeMap<u32, Region>,
    pub dns: Dns,
    pub domain: String,
    /// User ID → (login name, display name).
    pub users: BTreeMap<i64, (String, String)>,
    /// The packet filter's rules as the control server sent them (`PacketFilter`, and the
    /// named `PacketFilters` merged), JSON; the data plane parses them.
    pub filter: Option<serde_json::Value>,
    filters: BTreeMap<String, serde_json::Value>,
    /// The last response's sequence number, and whether it changed anything the page shows.
    pub seq: i64,
}

fn resolver(r: &ts_control_serde::DnsResolver<'_>) -> String {
    use ts_control_serde::DnsResolverAddr as A;
    match &r.addr {
        A::Plaintext(a) if a.port() == 53 => a.ip().to_string(),
        A::Plaintext(a) => a.to_string(),
        A::Https(u) | A::HttpWireguard(u) | A::Tls(u) => u.to_string(),
    }
}

/// What a map response changed.
#[derive(Debug, Default, PartialEq)]
pub struct Changed {
    pub node: bool,
    pub peers: bool,
    pub derp: bool,
    pub dns: bool,
    pub filter: bool,
    pub keep_alive: bool,
    /// A URL the control server wants the user to visit.
    pub browse: Option<String>,
}

impl NetMap {
    /// Applies one map response (its JSON).
    pub fn apply(&mut self, json: &[u8]) -> Result<Changed, String> {
        let r: MapResponse =
            serde_json::from_slice(json).map_err(|e| format!("a map response: {e}"))?;
        // The filter is kept as JSON: re-read it as values (the typed form borrows the response).
        let raw: serde_json::Value = serde_json::from_slice(json).unwrap_or_default();
        let mut c = Changed {
            keep_alive: r.keep_alive == Some(true),
            browse: r.pop_browser_url.map(str::to_string),
            ..Changed::default()
        };
        self.seq = r.seq;
        if let Some(n) = &r.node {
            self.node = Some(Node::from_wire(n));
            c.node = true;
        }
        if let Some(m) = &r.derp_map {
            self.regions = m
                .regions
                .values()
                .map(|reg| Region {
                    id: reg.id.into(),
                    code: reg.code.to_string(),
                    nodes: reg
                        .nodes
                        .iter()
                        .filter(|n| !n.stun_only)
                        .map(|n| {
                            // A node whose name doesn't resolve but which has an address: that.
                            let host = match (n.hostname, n.ipv4) {
                                ("", DerpIpUsage::FixedAddr(ip)) => ip.to_string(),
                                (h, _) => h.to_string(),
                            };
                            DerpNode {
                                host_name: host,
                                cert_name: n.cert_name.unwrap_or_default().to_string(),
                                derp_port: n.derp_port,
                            }
                        })
                        .collect(),
                })
                .map(|reg| (reg.id, reg))
                .collect();
            c.derp = true;
        }
        if let Some(peers) = &r.peers {
            self.peers = peers.iter().map(|n| (n.id, Node::from_wire(n))).collect();
            c.peers = true;
        }
        for n in r.peers_changed.iter().flatten() {
            self.peers.insert(n.id, Node::from_wire(n));
            c.peers = true;
        }
        for id in r.peers_removed.iter().flatten() {
            c.peers |= self.peers.remove(id).is_some();
        }
        for p in r.peers_changed_patch.iter().flatten() {
            let Some(n) = self.peers.get_mut(&p.node_id) else {
                continue;
            };
            if let Some(d) = p.derp_region {
                n.home_derp = Some(d.into());
            }
            if let Some(k) = p.key {
                n.key = *k.export().as_bytes();
            }
            if let Some(k) = p.disco_key {
                n.disco = Some(*k.export().as_bytes());
            }
            if let Some(o) = p.online {
                n.online = Some(o);
            }
            if let Some(m) = &p.cap_map {
                n.caps = m.keys().map(|k| k.to_string()).collect();
            }
            c.peers = true;
        }
        for (id, online) in &r.online_change {
            if let Some(n) = self.peers.get_mut(id) {
                n.online = Some(*online);
                c.peers = true;
            }
        }
        if let Some(d) = &r.dns_config {
            self.dns = Dns {
                magic: d.magic_dns,
                resolvers: d.resolvers.iter().flatten().map(resolver).collect(),
                domains: d.search_domains.iter().map(|s| s.to_string()).collect(),
                routes: d
                    .routes
                    .iter()
                    .map(|(k, v)| {
                        let rs = v.iter().flatten().flatten().map(resolver).collect();
                        (k.trim_end_matches('.').to_string(), rs)
                    })
                    .collect(),
                extra: d
                    .extra_records
                    .iter()
                    .filter_map(|e| {
                        use ts_control_serde::DnsRecord as R;
                        let (name, ip) = match e {
                            R::A { name, value } => (name, IpAddr::V4(*value)),
                            R::AAAA { name, value } => (name, IpAddr::V6(*value)),
                            R::Other { .. } => return None,
                        };
                        Some((name.trim_end_matches('.').to_string(), ip))
                    })
                    .collect(),
            };
            c.dns = true;
        }
        if !r.domain.is_empty() {
            self.domain = r.domain.to_string();
        }
        for u in &r.user_profiles {
            self.users.insert(
                u.id,
                (
                    u.login_name.to_string(),
                    u.display_name.unwrap_or_default().to_string(),
                ),
            );
        }
        // PacketFilter replaces the unnamed set; PacketFilters names sets (null deletes one,
        // "*": null clears all), as tailcfg.MapResponse documents.
        if let Some(f) = raw.get("PacketFilter").filter(|v| !v.is_null()) {
            self.filters.insert(String::new(), f.clone());
            c.filter = true;
        }
        if let Some(fs) = raw.get("PacketFilters").and_then(|v| v.as_object()) {
            for (name, rules) in fs {
                if name == "*" && rules.is_null() {
                    self.filters.clear();
                } else if rules.is_null() {
                    self.filters.remove(name);
                } else {
                    self.filters.insert(name.clone(), rules.clone());
                }
            }
            c.filter = true;
        }
        if c.filter {
            let all: Vec<serde_json::Value> = self
                .filters
                .values()
                .filter_map(|v| v.as_array())
                .flatten()
                .cloned()
                .collect();
            self.filter = Some(serde_json::Value::Array(all));
        }
        c.dns |= c.node; // the name and domains follow the node
        Ok(c)
    }

    /// The netmap as the page takes it (web/tailscale.ts `NetMap`, what the Go client reports).
    pub fn page_json(&self, mtu: usize, exit_node: &str) -> serde_json::Value {
        let Some(node) = &self.node else {
            return serde_json::Value::Null;
        };
        let addrs =
            |n: &Node| -> Vec<String> { n.addresses.iter().map(|a| a.to_string()).collect() };
        let peers: Vec<serde_json::Value> = self
            .peers
            .values()
            .map(|p| {
                let mut v = json!({
                    "id": p.stable_id, "name": p.name, "addresses": addrs(p),
                    "exitNodeOption": p.exit_node_option(),
                });
                if let Some(o) = p.online {
                    v["online"] = json!(o);
                }
                v
            })
            .collect();
        let mut dns: Vec<String> = Vec::new();
        if self.dns.magic {
            dns.push("100.100.100.100".into());
            dns.push("fd7a:115c:a1e0::53".into());
        }
        dns.extend(self.dns.resolvers.iter().cloned());
        json!({
            "name": node.name, "addresses": addrs(node), "peers": peers, "mtu": mtu,
            "dns": dns, "domains": self.dns.domains, "exitNode": exit_node,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A full map as headscale v0.29.4 sends it (trimmed), then deltas.
    const FULL: &str = r#"{
      "KeepAlive": false, "Seq": 1,
      "Node": {"ID": 2, "StableID": "2", "Name": "guest.tail.test.", "User": 1,
        "Key": "nodekey:0101010101010101010101010101010101010101010101010101010101010101",
        "Machine": "mkey:0202020202020202020202020202020202020202020202020202020202020202",
        "DiscoKey": "discokey:0303030303030303030303030303030303030303030303030303030303030303",
        "Addresses": ["100.90.0.2/32", "fd7a:115c:a1e0::2/128"],
        "AllowedIPs": ["100.90.0.2/32", "fd7a:115c:a1e0::2/128"],
        "HomeDERP": 999, "Hostinfo": {"Hostname": "guest"}, "Created": "2026-10-16T00:00:00Z",
        "MachineAuthorized": true, "CapMap": {"https://tailscale.com/cap/magicdns-aaaa": null}},
      "DERPMap": {"Regions": {"999": {"RegionID": 999, "RegionCode": "headscale", "RegionName": "x",
        "Nodes": [{"Name": "999a", "RegionID": 999, "HostName": "127.0.0.1", "IPv4": "127.0.0.1", "DERPPort": 8443}]}}},
      "Peers": [{"ID": 1, "StableID": "1", "Name": "peer.tail.test.", "User": 1,
        "Key": "nodekey:0404040404040404040404040404040404040404040404040404040404040404",
        "DiscoKey": "discokey:0505050505050505050505050505050505050505050505050505050505050505",
        "Addresses": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128"],
        "AllowedIPs": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128", "0.0.0.0/0", "::/0"],
        "HomeDERP": 999, "Online": true, "Hostinfo": {"Hostname": "peer"}, "Created": "2026-10-16T00:00:00Z"}],
      "DNSConfig": {"Resolvers": [{"Addr": "9.9.9.9"}], "Domains": ["tail.test"], "Proxied": true,
        "Routes": {"tail.test.": null}},
      "Domain": "headscale.net",
      "PacketFilter": [{"SrcIPs": ["*"], "DstPorts": [{"IP": "*", "Ports": {"First": 0, "Last": 65535}}]}],
      "UserProfiles": [{"ID": 1, "LoginName": "tailnet", "DisplayName": "tailnet"}]
    }"#;

    #[test]
    fn a_full_map_then_deltas() {
        let mut m = NetMap::default();
        let c = m.apply(FULL.as_bytes()).unwrap();
        assert!(c.node && c.peers && c.derp && c.dns && c.filter);
        let node = m.node.as_ref().unwrap();
        assert_eq!(node.name, "guest.tail.test.");
        assert_eq!(node.addresses[0].to_string(), "100.90.0.2/32");
        assert_eq!(node.caps, vec!["https://tailscale.com/cap/magicdns-aaaa"]);
        let peer = &m.peers[&1];
        assert!(peer.exit_node_option());
        assert_eq!((peer.home_derp, peer.key[0]), (Some(999), 4));
        assert_eq!(m.regions[&999].nodes[0].url(), "wss://127.0.0.1:8443/derp");
        assert_eq!(m.dns.resolvers, vec!["9.9.9.9"]);
        assert!(m.dns.routes["tail.test"].is_empty());
        assert_eq!(m.users[&1].0, "tailnet");
        assert_eq!(m.filter.as_ref().unwrap().as_array().unwrap().len(), 1);
        let page = m.page_json(1280, "");
        assert_eq!(
            page["dns"],
            json!(["100.100.100.100", "fd7a:115c:a1e0::53", "9.9.9.9"])
        );
        assert_eq!(page["peers"][0]["exitNodeOption"], json!(true));
        assert_eq!(page["peers"][0]["online"], json!(true));

        // A keep-alive changes nothing.
        let c = m.apply(br#"{"KeepAlive": true}"#).unwrap();
        assert_eq!(
            c,
            Changed {
                keep_alive: true,
                ..Changed::default()
            }
        );
        // Online and DERP patches, then removal.
        m.apply(br#"{"OnlineChange": {"1": false}, "PeersChangedPatch": [{"NodeID": 1, "DERPRegion": 7}]}"#)
            .unwrap();
        assert_eq!(
            (m.peers[&1].online, m.peers[&1].home_derp),
            (Some(false), Some(7))
        );
        let c = m.apply(br#"{"PeersRemoved": [1]}"#).unwrap();
        assert!(c.peers && m.peers.is_empty());
        // Named filters: one replaced, then all cleared.
        m.apply(br#"{"PacketFilters": {"base": [{"SrcIPs": ["100.90.0.1"], "DstPorts": [{"IP": "*", "Ports": {"First": 22, "Last": 22}}]}]}}"#).unwrap();
        assert_eq!(m.filter.as_ref().unwrap().as_array().unwrap().len(), 2);
        m.apply(br#"{"PacketFilters": {"*": null}}"#).unwrap();
        assert_eq!(m.filter.as_ref().unwrap().as_array().unwrap().len(), 0);
    }
}
