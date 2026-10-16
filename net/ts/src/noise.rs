//! The control server's Noise channel (Tailscale's `controlbase`, "ts2021"), sans I/O: the
//! Noise IK handshake is tailscale-rs's `ts_noise` (as `ts_control_noise` uses it); the framing
//! around it is `ts_control_noise`'s, rewritten here without its tokio codec (tokio's runtime
//! doesn't build for wasm). Over a browser's WebSocket the initiation goes in the URL
//! (`X-Tailscale-Handshake`), so this side only reads the response and then trades records:
//! a 3-byte header (type, big-endian length) and a ChaCha20-Poly1305 body with a counter nonce.

use base64::Engine;
use chacha20poly1305::{AeadInPlace, ChaCha20Poly1305, KeyInit, Nonce};
use ts_keys::{Export, MachineKeyPair, MachinePrivateKey, MachinePublicKey};
use ts_noise::ik::SentHandshake;

const INITIATION: u8 = 1;
const RESPONSE: u8 = 2;
const ERROR: u8 = 3;
const RECORD: u8 = 4;
/// A record's largest size on the wire.
const MAX_MESSAGE: usize = 4096;
const TAG: usize = 16;
const MAX_CHUNK: usize = MAX_MESSAGE - 3 - TAG;

/// The capability version this client claims (tailscale-rs's).
pub fn capability_version() -> u16 {
    ts_capabilityversion::CapabilityVersion::CURRENT.into()
}

/// The handshake's prologue, which names the protocol version.
fn prologue() -> String {
    format!("Tailscale Control Protocol v{}", capability_version())
}

struct Cipher {
    aead: ChaCha20Poly1305,
    nonce: u64,
}

impl Cipher {
    fn next(&mut self) -> Nonce {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&self.nonce.to_be_bytes());
        self.nonce += 1;
        n.into()
    }
}

/// One Noise connection to a control server.
pub struct Conn {
    machine: MachineKeyPair,
    hs: Option<SentHandshake>,
    tx: Option<Cipher>,
    rx: Option<Cipher>,
    inbuf: Vec<u8>,
}

impl Conn {
    /// Starts a handshake with the server's key; the second value is the initiation, base64 as
    /// the `X-Tailscale-Handshake` parameter carries it.
    pub fn new(machine_private: [u8; 32], control: [u8; 32]) -> (Self, String) {
        let machine =
            MachineKeyPair::from(Export::<MachinePrivateKey>::from_bytes(machine_private).import());
        let mut init = [0u8; SentHandshake::INIT_SIZE];
        let hs = SentHandshake::new(
            machine.to_x25519_dalek(),
            MachinePublicKey::from_bytes(control).to_x25519_dalek(),
            prologue().as_bytes(),
            &mut init,
        );
        let mut msg = Vec::with_capacity(5 + init.len());
        msg.extend_from_slice(&capability_version().to_be_bytes());
        msg.push(INITIATION);
        msg.extend_from_slice(&(init.len() as u16).to_be_bytes());
        msg.extend_from_slice(&init);
        let b64 = base64::engine::general_purpose::STANDARD.encode(msg);
        (
            Conn {
                machine,
                hs: Some(hs),
                tx: None,
                rx: None,
                inbuf: Vec::new(),
            },
            b64,
        )
    }

    pub fn is_open(&self) -> bool {
        self.rx.is_some()
    }

    /// Bytes from the server: the plaintext they carry (nothing until the handshake is done).
    pub fn input(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        self.inbuf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if self.inbuf.len() < 3 {
                return Ok(out);
            }
            let len = u16::from_be_bytes([self.inbuf[1], self.inbuf[2]]) as usize;
            if self.inbuf.len() < 3 + len {
                return Ok(out);
            }
            let typ = self.inbuf[0];
            let mut body: Vec<u8> = self.inbuf.drain(..3 + len).skip(3).collect();
            match (typ, self.hs.take()) {
                (RESPONSE, Some(hs)) => {
                    match hs.try_finish(&mut body, self.machine.to_x25519_dalek()) {
                        Ok(s) => {
                            // We are the initiator: we send with the first key, read with the second.
                            self.tx = Some(Cipher {
                                aead: ChaCha20Poly1305::new(&s.initiator_to_responder),
                                nonce: 0,
                            });
                            self.rx = Some(Cipher {
                                aead: ChaCha20Poly1305::new(&s.responder_to_initiator),
                                nonce: 0,
                            });
                        }
                        Err(_) => return Err("the control server's Noise handshake failed".into()),
                    }
                }
                (RECORD, None) if len >= TAG => {
                    let rx = self.rx.as_mut().ok_or("a record before the handshake")?;
                    let nonce = rx.next();
                    let tag = body.split_off(body.len() - TAG);
                    rx.aead
                        .decrypt_in_place_detached(&nonce, &[], &mut body, tag.as_slice().into())
                        .map_err(|_| "a control record didn't decrypt")?;
                    out.extend_from_slice(&body);
                }
                (ERROR, _) => {
                    return Err(format!(
                        "the control server: {}",
                        String::from_utf8_lossy(&body)
                    ));
                }
                (t, _) => return Err(format!("an unexpected Noise message (type {t})")),
            }
        }
    }

    /// Seals `data` into records for the wire.
    pub fn seal(&mut self, data: &[u8]) -> Vec<u8> {
        let tx = self.tx.as_mut().expect("seal before the handshake");
        let mut out = Vec::with_capacity(data.len() + (data.len() / MAX_CHUNK + 1) * (3 + TAG));
        for chunk in data.chunks(MAX_CHUNK) {
            out.push(RECORD);
            out.extend_from_slice(&((chunk.len() + TAG) as u16).to_be_bytes());
            let start = out.len();
            out.extend_from_slice(chunk);
            let nonce = tx.next();
            let tag = tx
                .aead
                .encrypt_in_place_detached(&nonce, &[], &mut out[start..])
                .expect("a chunk fits");
            out.extend_from_slice(&tag);
        }
        out
    }
}

/// A test responder: the control server's side of the handshake and records.
#[cfg(test)]
pub mod testserver {
    use super::*;
    use ts_keys::X25519KeyPair;
    use ts_noise::ik::ReceivedHandshake;

    pub struct Server {
        tx: Cipher,
        rx: Cipher,
        pub client: [u8; 32],
        inbuf: Vec<u8>,
    }

    pub fn keypair(seed: u8) -> X25519KeyPair {
        let private = x25519_dalek::StaticSecret::from([seed; 32]);
        let public = x25519_dalek::PublicKey::from(&private);
        X25519KeyPair { public, private }
    }

    impl Server {
        /// Accepts the base64 initiation; returns the server and its response bytes.
        pub fn accept(key: &X25519KeyPair, init_b64: &str) -> (Server, Vec<u8>) {
            let msg = base64::engine::general_purpose::STANDARD
                .decode(init_b64)
                .unwrap();
            assert_eq!(u16::from_be_bytes([msg[0], msg[1]]), capability_version());
            assert_eq!(msg[2], INITIATION);
            let mut init = msg[5..].to_vec();
            let rh = ReceivedHandshake::new(&mut init, prologue().as_bytes(), key).unwrap();
            let client = rh.peer_static_pub.to_bytes();
            let mut resp = [0u8; ReceivedHandshake::RESP_SIZE];
            let s = rh.finish(&mut resp);
            let mut out = vec![RESPONSE];
            out.extend_from_slice(&(resp.len() as u16).to_be_bytes());
            out.extend_from_slice(&resp);
            (
                Server {
                    tx: Cipher {
                        aead: ChaCha20Poly1305::new(&s.responder_to_initiator),
                        nonce: 0,
                    },
                    rx: Cipher {
                        aead: ChaCha20Poly1305::new(&s.initiator_to_responder),
                        nonce: 0,
                    },
                    client,
                    inbuf: Vec::new(),
                },
                out,
            )
        }

        pub fn seal(&mut self, data: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            for chunk in data.chunks(MAX_CHUNK) {
                out.push(RECORD);
                out.extend_from_slice(&((chunk.len() + TAG) as u16).to_be_bytes());
                let start = out.len();
                out.extend_from_slice(chunk);
                let nonce = self.tx.next();
                let tag = self
                    .tx
                    .aead
                    .encrypt_in_place_detached(&nonce, &[], &mut out[start..])
                    .unwrap();
                out.extend_from_slice(&tag);
            }
            out
        }

        pub fn open(&mut self, bytes: &[u8]) -> Vec<u8> {
            self.inbuf.extend_from_slice(bytes);
            let mut out = Vec::new();
            while self.inbuf.len() >= 3 {
                let len = u16::from_be_bytes([self.inbuf[1], self.inbuf[2]]) as usize;
                if self.inbuf.len() < 3 + len {
                    break;
                }
                assert_eq!(self.inbuf[0], RECORD);
                let mut body: Vec<u8> = self.inbuf.drain(..3 + len).skip(3).collect();
                let tag = body.split_off(body.len() - TAG);
                let nonce = self.rx.next();
                self.rx
                    .aead
                    .decrypt_in_place_detached(&nonce, &[], &mut body, tag.as_slice().into())
                    .unwrap();
                out.extend_from_slice(&body);
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_keys::ExportableKey;

    #[test]
    fn handshake_and_records_both_ways_in_pieces() {
        let key = testserver::keypair(5);
        let (mut c, init) = Conn::new([3; 32], key.public.to_bytes());
        let (mut s, resp) = testserver::Server::accept(&key, &init);
        let machine_pub = *Export::<MachinePrivateKey>::from_bytes([3; 32])
            .import()
            .public_key()
            .export()
            .as_bytes();
        assert_eq!(s.client, machine_pub, "the server learns our machine key");
        // The response and a record, split at every byte.
        let mut wire = resp;
        let big: Vec<u8> = (0..10_000u32).map(|i| i as u8).collect();
        wire.extend(s.seal(&big));
        let mut got = Vec::new();
        for b in &wire {
            got.extend(c.input(&[*b]).unwrap());
        }
        assert!(c.is_open());
        assert!(got == big, "three records' worth, back in one piece");
        let sealed = c.seal(b"hello control");
        assert_eq!(s.open(&sealed), b"hello control");
        // A tampered record is refused.
        let mut bad = s.seal(b"x");
        let n = bad.len();
        bad[n - 1] ^= 1;
        assert!(c.input(&bad).is_err());
    }
}
