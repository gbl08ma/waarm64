//! What a guest could do to the controller that it must survive (the review of 2026-10-18): each
//! test reproduced its finding before the fix.

use super::tests::*;
use super::*;
use crate::vm::RAM_BASE;

/// A ring of `n` TRBs at `base` for transfers, outside the harness's small ones.
const BIG: u64 = RAM_BASE + 0x20000;

/// Moves DCI `dci` of slot 1 to the ring at `ring` (Stop Endpoint, then Set TR Dequeue Pointer).
fn retarget(t: &mut T, dci: u32, ring: u64) {
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | dci << 16 | 1 << 24])
            .0,
        CC_SUCCESS
    );
    assert_eq!(
        t.command([ring as u32 | 1, 0, 0, T_SET_DEQ << 10 | dci << 16 | 1 << 24])
            .0,
        CC_SUCCESS
    );
}

#[test]
fn a_ring_of_no_ops_linked_to_itself_ends_each_walk() {
    // [No-Op (IOC), Link back without Toggle Cycle]: the same TD again and again.
    let mut t = configured();
    retarget(&mut t, 2, BULK_OUT);
    t.put(BULK_OUT, &[0, 0, 0, T_NOOP << 10 | C_IOC | 1]);
    t.put(BULK_OUT + 16, &[BULK_OUT as u32, 0, 0, T_LINK << 10 | 1]);
    t.wr(DBOFF + 4, 2);
    assert!(
        t.x.pending.len() <= MAX_PENDING,
        "events kept: {}",
        t.x.pending.len()
    );
    assert_eq!(t.x.due(), 0, "the endpoint walks on at the next boundary");
    let n = t.events().len();
    assert!(n > 0 && n < EVT_TRBS as usize);
    t.x.tick(0, false, &t.mem, &t.sh);
    assert!(!t.events().is_empty(), "it went on");
}

#[test]
fn a_command_ring_linked_to_itself_waits_for_the_event_ring() {
    // [No-Op Command, Link back]: a command per pass, for ever, unless it waits for room.
    let mut t = T::new();
    t.put(CMD, &[0, 0, 0, T_NOOP_CMD << 10 | 1]);
    t.put(CMD + 16, &[CMD as u32, 0, 0, T_LINK << 10 | 1]);
    t.wr(DBOFF, 0);
    assert!(t.x.pending.len() <= 1, "events kept: {}", t.x.pending.len());
    assert_eq!(t.events().len(), EVT_TRBS as usize - 1);
    // Room again: it goes on.
    assert_eq!(t.events().len(), EVT_TRBS as usize - 1);
    // With no event ring at all, nothing piles up either.
    let mut t = T::new();
    t.wr(RTSOFF + 0x28, 0);
    t.wr(RTSOFF + 0x30, ERST_TBL as u32);
    t.wr(RTSOFF + 0x34, 0);
    t.put(CMD, &[0, 0, 0, T_NOOP_CMD << 10 | 1]);
    t.put(CMD + 16, &[CMD as u32, 0, 0, T_LINK << 10 | 1]);
    t.wr(DBOFF, 0);
    assert!(t.x.pending.len() <= 1);
}

#[test]
fn events_that_never_find_room_stop_at_a_bound() {
    let mut t = T::new();
    for _ in 0..MAX_PENDING + 10 {
        t.x.event([0, 0, 0, T_PORT_EVENT << 10], true);
    }
    assert!(t.x.pending.len() <= MAX_PENDING);
    assert_ne!(t.rd(USBSTS) & STS_HSE, 0, "a host system error");
}

#[test]
fn a_control_td_needs_its_setup_stage() {
    // [No-Op (chained), Data Stage] on EP0: no setup packet for the device.
    let mut t = configured();
    let a = t.trb(EP0_RING, [0, 0, 0, T_NOOP << 10 | C_CH]);
    t.trb(EP0_RING, [BUF as u32, 0, 8, T_DATA << 10 | 1 << 16]);
    t.wr(DBOFF + 4, 1);
    assert!(t.requests().is_empty(), "nothing for the device");
    let ev = t.events();
    assert_eq!(transfer(&ev[0]).1, CC_TRB);
    let _ = a;
}

#[test]
fn walking_goes_on_once_tds_leave_flight() {
    // More TDs than MAX_TDS on one ring, completed with latency: tick, not complete, frees the
    // tags, and the rest must still be posted.
    let mut t = configured();
    t.x.latency = LATENCY_NS;
    retarget(&mut t, 2, BIG);
    let n = MAX_TDS + 50;
    for k in 0..n as u64 {
        t.put(
            BIG + 16 * k,
            &[BUF as u32, 0, 8, T_NORMAL << 10 | C_IOC | 1],
        );
    }
    t.wr(DBOFF + 4, 2);
    // WALK_TDS a walk, on at each boundary (tick) until MAX_TDS are in flight.
    let mut r = t.requests();
    while r.len() < MAX_TDS {
        assert_eq!(t.x.due(), 0);
        t.x.tick(0, false, &t.mem, &t.sh);
        r.extend(t.requests());
    }
    assert_eq!(r.len(), MAX_TDS);
    t.x.tick(0, false, &t.mem, &t.sh);
    assert!(t.requests().is_empty(), "no more than MAX_TDS");
    // Nothing to do until a TD leaves flight: no boundary is due (an idle parallel vCPU waits on
    // `due`, and spun on a 0 for as long as a backend held 1024 TDs).
    for _ in 0..1000 {
        t.x.tick(0, false, &t.mem, &t.sh);
        assert_eq!(t.x.due(), u64::MAX, "nothing due while the TDs are held");
    }
    for q in &r {
        t.done(q, CC_SUCCESS, 8);
    }
    assert!(t.requests().is_empty());
    // Their events, read as the guest would; walking waits while too many wait for room.
    let mut rest = 0;
    for _ in 0..200 {
        t.x.tick(LATENCY_NS, false, &t.mem, &t.sh);
        rest += t.requests().len();
        t.events();
    }
    assert_eq!(rest, 50, "the rest of the ring");
}

#[test]
fn a_record_too_big_for_the_request_ring_is_a_trb_error() {
    let mut t = configured();
    retarget(&mut t, 2, BIG);
    // 1025 chained TRBs of immediate data: neither a TD nor a record that fits.
    for k in 0..1025u64 {
        let ch = if k < 1024 { C_CH } else { C_IOC };
        t.put(BIG + 16 * k, &[1, 2, 8, T_NORMAL << 10 | C_IDT | ch | 1]);
    }
    t.wr(DBOFF + 4, 2);
    assert!(t.requests().is_empty());
    assert_eq!(transfer(&t.events()[0]).1, CC_TRB);
    // Immediate data in a TD of more than one TRB is a TRB Error too.
    let mut t = configured();
    t.trb(BULK_OUT, [1, 2, 8, T_NORMAL << 10 | C_IDT | C_CH]);
    t.trb(BULK_OUT, [BUF as u32, 0, 8, T_NORMAL << 10 | C_IOC]);
    t.wr(DBOFF + 4, 2);
    assert!(t.requests().is_empty());
    assert_eq!(transfer(&t.events()[0]).1, CC_TRB);
    // And USB still works on another endpoint.
    t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    assert_eq!(t.requests().len(), 1);
}

#[test]
fn tags_in_use_are_never_given_again() {
    let mut t = configured();
    t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    let held = t.requests()[0].tag;
    assert_eq!(held, 1);
    t.x.next_tag = (1 << 24) - 1;
    t.trb(BULK_OUT, [BUF as u32, 0, 8, T_NORMAL << 10 | C_IOC]);
    t.trb(BULK_OUT, [BUF as u32, 0, 8, T_NORMAL << 10 | C_IOC]);
    t.wr(DBOFF + 4, 2);
    let tags: Vec<u32> = t.requests().iter().map(|r| r.tag).collect();
    assert_eq!(tags, [(1 << 24) - 1, 2], "1 is the IN TD's");
}

#[test]
fn stop_endpoint_after_a_held_stall_leaves_it_halted() {
    let mut t = configured();
    t.x.latency = LATENCY_NS;
    t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.done(&r[0], CC_STALL, 0);
    assert!(t.events().is_empty(), "held for its latency");
    // Linux stops it (a URB unlinked): the stall comes out first, and the endpoint stays halted.
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_CONTEXT_STATE, 1)
    );
    assert_eq!(t.ep_state(3), EP_HALTED);
    assert_eq!(
        t.command([0, 0, 0, T_RESET_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
}

#[test]
fn an_isochronous_error_doesnt_halt() {
    let mut t = configured();
    // Isoch IN on DCI 3 instead of bulk.
    t.put(IN_CTX, &[1 << 3, 1 << 3, 0, 0, 0, 0, 0, 0]);
    t.put(
        IN_CTX + 32 * 4,
        &[0, 5 << 3 | 1024 << 16, BULK_IN as u32 | 1, 0, 0, 0, 0, 0],
    );
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_CONFIGURE << 10 | 1 << 24])
            .0,
        CC_SUCCESS
    );
    t.requests();
    t.rings.remove(&BULK_IN);
    let a = t.trb(BULK_IN, [BUF as u32, 0, 64, T_ISOCH << 10 | C_IOC | C_ISP]);
    let b = t.trb(BULK_IN, [BUF as u32, 0, 64, T_ISOCH << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    assert_eq!(r.len(), 2);
    t.done(&r[0], CC_TRANSACTION, 0);
    t.done(&r[1], CC_SUCCESS, 64);
    let ev = t.events();
    assert_eq!(transfer(&ev[0]), (a, CC_TRANSACTION, 64, 3));
    assert_eq!(transfer(&ev[1]), (b, CC_SUCCESS, 0, 3));
    assert_eq!(t.ep_state(3), EP_RUNNING);
}

#[test]
fn guest_addresses_near_the_top_dont_overflow() {
    let mut t = T::new();
    // DCBAAP near the top: Address Device reads DCBAA[slot] there.
    t.attach(0, SPEED_HIGH);
    t.wr(PORTSC, P_PP | P_CSC | P_PR);
    t.events();
    t.wr64(OP + 0x30, !0x3f);
    for k in 1..=8 {
        assert_eq!(t.command([0, 0, 0, T_ENABLE_SLOT << 10]), (CC_SUCCESS, k));
    }
    t.put(IN_CTX, &[0, 3, 0, 0, 0, 0, 0, 0]);
    t.put(IN_CTX + 32, &[1 << 27, 1 << 16, 0, 0]);
    t.put(IN_CTX + 64, &[0, 4 << 3 | 64 << 16, EP0_RING as u32 | 1, 0]);
    // DCBAA[8] is past the top: a parameter error, not an overflow.
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_ADDRESS << 10 | 8 << 24]),
        (CC_PARAMETER, 8)
    );
    // A segment at the top, and ERDP in it: DESI's segment search.
    t.put(ERST_TBL, &[!0x3f, !0, 16, 0]);
    t.wr64(RTSOFF + 0x30, ERST_TBL);
    t.wr64(RTSOFF + 0x38, !0xf);
    let _ = t.rd(RTSOFF + 0x38);
}

#[test]
fn configure_endpoint_is_all_or_nothing() {
    let mut t = configured();
    t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    t.requests();
    // Drop DCI 3, add DCI 4 (fine) and DCI 5 (control: a parameter error).
    t.put(IN_CTX, &[1 << 3, 1 << 4 | 1 << 5, 0, 0, 0, 0, 0, 0]);
    t.put(
        IN_CTX + 32 * 5,
        &[0, 2 << 3 | 512 << 16, BULK_OUT as u32 | 1, 0, 0, 0, 0, 0],
    );
    t.put(
        IN_CTX + 32 * 6,
        &[0, 4 << 3 | 64 << 16, BULK_OUT as u32 | 1, 0, 0, 0, 0, 0],
    );
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_CONFIGURE << 10 | 1 << 24]),
        (CC_PARAMETER, 1)
    );
    assert_eq!((t.ep_state(3), t.ep_state(4)), (EP_RUNNING, EP_DISABLED));
    assert!(
        t.requests().is_empty(),
        "nothing cancelled, nothing configured"
    );
}

#[test]
fn a_snapshot_keeps_a_half_written_register() {
    let mut t = T::new();
    t.wr(RTSOFF + 0x30, ERST_TBL as u32); // ERSTBA's low half, the high one not yet
    let mut w = Writer::default();
    t.x.save(&mut w);
    let mut x2 = Xhci::new();
    x2.restore(&mut Reader(&w.0), snapshot::VERSION).unwrap();
    assert_eq!(x2.lo, t.x.lo);
}
