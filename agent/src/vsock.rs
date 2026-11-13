//! The agent's connection to the page: a vsock stream to the host (CID 2) on the agent's port (web/vsock-device.ts
//! `AGENT_PORT`). rustix has no vsock address, so this module has the C one (`struct sockaddr_vm`, linux/vm_sockets.h).

use rustix::fd::OwnedFd;
use rustix::io::Errno;
use rustix::net::addr::{SocketAddrArg, SocketAddrLen, SocketAddrOpaque};
use rustix::net::{AddressFamily, SocketFlags, SocketType, connect as connect_to, socket_with};

/// The host's CID (VMADDR_CID_HOST).
pub const HOST_CID: u32 = 2;
/// The host's port the agent connects to (web/vsock-device.ts `AGENT_PORT`).
#[cfg_attr(test, allow(dead_code))]
pub const AGENT_PORT: u32 = 8574;

/// `struct sockaddr_vm`: family, reserved, port, CID, flags, zero padding to `struct sockaddr`'s 16 bytes.
#[repr(C)]
struct SockaddrVm {
    family: u16,
    reserved: u16,
    port: u32,
    cid: u32,
    flags: u8,
    zero: [u8; 3],
}

/// A vsock address: a CID and a port.
pub struct VsockAddr {
    pub cid: u32,
    pub port: u32,
}

// SAFETY: the pointer handed to `f` points at a whole, initialized `sockaddr_vm` that lives through the call, and the
// length is its size.
unsafe impl SocketAddrArg for VsockAddr {
    unsafe fn with_sockaddr<R>(
        &self,
        f: impl FnOnce(*const SocketAddrOpaque, SocketAddrLen) -> R,
    ) -> R {
        let a = SockaddrVm {
            family: AddressFamily::VSOCK.as_raw(),
            reserved: 0,
            port: self.port,
            cid: self.cid,
            flags: 0,
            zero: [0; 3],
        };
        f(
            (&raw const a).cast(),
            size_of::<SockaddrVm>() as SocketAddrLen,
        )
    }
}

/// A stream connected to the host's `port` (blocking, close-on-exec).
#[cfg_attr(test, allow(dead_code))]
pub fn connect(port: u32) -> Result<OwnedFd, Errno> {
    let fd = socket_with(
        AddressFamily::VSOCK,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )?;
    connect_to(
        &fd,
        &VsockAddr {
            cid: HOST_CID,
            port,
        },
    )?;
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_sockaddr_vm() {
        assert_eq!(size_of::<SockaddrVm>(), 16);
        // SAFETY: `with_sockaddr` hands a pointer to `len` initialized bytes, valid through the closure.
        let bytes = unsafe {
            VsockAddr { cid: 2, port: 8574 }.with_sockaddr(|p, len| {
                core::slice::from_raw_parts(p.cast::<u8>(), len as usize).to_vec()
            })
        };
        let family = AddressFamily::VSOCK.as_raw().to_le_bytes();
        assert_eq!(
            bytes,
            [
                family[0], family[1], 0, 0, 0x7e, 0x21, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0
            ]
        );
    }
}
