// What the page's machine runs with (docs/frontend.md "Query parameters"): its display, resolved from the address, the
// record, the Preferences and what this browser can do. Pure (no `location`, no storage): tests/config.test.ts runs it
// in Node.
import type { Display } from '../shape.ts';

/** A machine's display as it runs: none without a virtio-gpu, 3D or 2D with one; Vulkan (Venus) only beside 3D. */
export type RunDisplay = { display: Display | 'none'; vulkan: boolean };

/**
 * The display a machine runs with on this page. `gpu`: its kind has a virtio-gpu (`MachineSpec.display`); `simple`:
 * the address's `?display=simple` (none, the simple framebuffer). 3D where it's asked for (the address's `asked` over
 * the record's over the Preferences' `setting`, 3D by default) and not refused (no WebGL2, or `refused`: the GPU worker
 * failed), else 2D. `vulkan`: Vulkan asked for (the record's, `?gpu=vulkan`).
 */
export function effectiveDisplay(o: {
  gpu: boolean;
  simple: boolean;
  asked?: Display;
  record?: Display;
  setting?: Display;
  webgl2: boolean;
  refused?: boolean;
  vulkan: boolean;
}): RunDisplay {
  if (!o.gpu || o.simple) return { display: 'none', vulkan: false };
  const three = wants3d(o) && o.webgl2 && !o.refused;
  return { display: three ? '3d' : '2d', vulkan: three && o.vulkan };
}

/** Whether 3D is asked for (before what the browser can do): the address's, else the record's, else the Preferences'. */
export const wants3d = (o: { gpu: boolean; simple: boolean; asked?: Display; record?: Display; setting?: Display }) =>
  o.gpu && !o.simple && (o.asked ?? o.record ?? o.setting ?? '3d') === '3d';
