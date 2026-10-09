# M8 graphics G4: breadth and correctness (kickoff, 2026-10-09)

Written from the proposal in `M8-GRAPHICS-HANDOVER.md` and the user's answers the same day. Read first:
docs/plans/graphics.md §1, §7, §8 and §20; docs/devices.md "virgl"; docs/frontend.md "A 3D machine". CLAUDE.md's
conventions and working rules apply; `scripts/ci.sh` passes at every commit (`scripts/ci-debian.sh` too for the page,
the device and the renderer). Work in loops (one slice, one commit, a short report each) without check-ins.

## Decisions (the user's, 2026-10-09; don't re-ask)

1. **Firefox first.** Firefox opens on a 3D machine, uses the acceleration (WebRender on GLES through virgl, WebGL
   on "Mesa -- virgl (webpc)") and is made faster: its performance is underwhelming today. Measured on the page with
   the user's Arch image with Firefox (`bench/results/local/myarch3.qcow2`; its disk may be grown and packages added
   through QEMU with a network), on SwiftShader and on the Mac host's GPU. Watch for the glycin hang
   (`glycin-svg --dbus-fd …` at 100% of a core, Firefox not opening).
2. **After Firefox: GTK4 applications** (gtk4-demo, GSK's GL renderer), **on the Arch image**. Chromium's GPU
   process and a full desktop (KWin, Mutter) are not G4's priority; what they need is written down if seen.
3. **A dEQP subset, GLES2 and GLES3, is G4's correctness gate** (VK-GL-CTS, Apache-2.0, a guest workload run on the
   page under the JIT, the expected results from the oracle's vtest): a pass list committed, the failures sorted by
   cause and fixed by how many tests each fixes.
4. **Snapshots while 3D is in use stay refused in G4**; rebuilding them is G5's.
5. **3D stays the page's default where WebGL2 is**, and the page's menu gets a 2D/3D choice beside `?gpu=2d`.

## Loops

- **Loop 0, Firefox measured:** the image ready (larger disk, the tools the harness needs); a harness like
  `bench/gpu/sway-load.ts` for Firefox under sway (frames a second scrolling a page, the guest's CPU per process,
  the renderer's time, WebGL on and off), on SwiftShader and the Mac's GPU; what Firefox's GL stream asks of the
  renderer (errors, refusals, readbacks, shader compiles).
- **Loop 1, Firefox faster:** the costs loop 0 finds, by size, fixed and measured A/B.
- **Loop 2, the menu's 2D/3D choice** (decision 5).
- **Loop 3, dEQP:** GLES2 and GLES3 subsets built into a guest image, run on the page and on vtest; the pass list.
- **Loop 4, the failures:** the renderer's and translator's gaps dEQP finds, by how many tests each fixes.
- **Loop 5, GTK4:** gtk4-demo with GSK's GL renderer on the Arch image; what it needs.
- **Loop 6, cost:** shader compiles (a cache by TGSI and key, `KHR_parallel_shader_compile`), and the guest
  kernel's submit path with a finer instrument (a PC published more often than once a chunk, or exits counted by PC).
- **Exit:** Firefox's numbers before and after, the dEQP pass rate, the applications that work, in graphics.md;
  G5's outline (performance, snapshots in use).
