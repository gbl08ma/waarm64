/* The agent never unwinds (`panic = "abort"`, src/rt.rs), so its unwind tables are dead weight the guest would read
   over fw_cfg at every boot (~27 KiB: docs/plans/clipboard.md §3.3). Dropped here, the rest of lld's own layout kept
   (INSERT). musl's crtbegin.o names __register_frame_info only weakly, so nothing registers them. */
SECTIONS { /DISCARD/ : { *(.eh_frame) *(.eh_frame_hdr) } } INSERT AFTER .text;
