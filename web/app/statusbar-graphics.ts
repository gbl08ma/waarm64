// The status bar's graphics (docs/frontend.md "The status bar"): the screen's last second from its reports, and what
// the graphics group's elements (renderer, frame rate, video, Vulkan) draw of it. DOM-free, for tests/statusbar.test.ts.
import { msg, t, type Msg } from '../i18n.ts';
import type { IconName } from './icons.ts';
import { piece, type Live, type Piece } from './statusbar-piece.ts';

/** A video stream as the GPU worker reports it (web/virgl-video.ts `VideoStream`), with its pictures a second. */
type Stream = {
  id: number;
  profile: string;
  width: number;
  height: number;
  hardware: boolean;
  open: boolean;
  decoded: number;
  fps?: number;
};
/**
 * The screen's last second: a 3D machine's GPU worker `stats` (web/gpu-worker.ts), or a 2D machine's presenter's
 * `screen-stats` (web/gpu-present.ts; `webgl2` or `canvas2d`), or a machine without virtio-gpu's simple framebuffer
 * (`framebuffer`: its machine worker's `screen-stats`, web/app/worker-start.ts `showScreen`). `fps`: presents a second; the video's decoded pictures a
 * second, all streams and each. `hardware` is what a decoder asked for: WebCodecs doesn't say what it got (Chromium's
 * `prefer-hardware` fails rather than fall back).
 */
export type Graphics = {
  mode: '3d' | 'webgl2' | 'canvas2d' | 'framebuffer';
  renderer?: string;
  vendor?: string;
  software?: boolean;
  presents: number;
  fps?: number;
  video?: Video;
  /** A Vulkan machine's Venus (web/gpu-worker.ts `VulkanReport`), its submits and draws a second. */
  vulkan?: Vulkan;
};
type Video = { enabled: boolean; decoded: number; fps?: number; decoderErrors: number; streams: Stream[] };
type Vulkan = {
  contexts: number;
  submits: number;
  draws: number;
  device: boolean;
  adapter?: string;
  software?: boolean;
  submitRate?: number;
  drawRate?: number;
};
type GpuReport = {
  renderer?: string;
  vendor?: string;
  software?: boolean;
  presents: number;
  video?: { enabled: boolean; decoded: number; decoderErrors: number; streams: Omit<Stream, 'fps'>[] };
  vulkan?: Omit<Vulkan, 'submitRate' | 'drawRate'>;
};
/** A report received at `at` (ms), after `prev` (the same run's last). */
export function graphics(
  mode: Graphics['mode'],
  m: GpuReport,
  at: number,
  prev?: { g: Graphics; at: number },
): Graphics {
  const dt = prev?.g.mode === mode ? (at - prev.at) / 1000 : 0;
  const rate = (now: number, then: number | undefined) =>
    then !== undefined && dt > 0 && now >= then ? (now - then) / dt : undefined;
  const v = m.video;
  return {
    mode,
    renderer: m.renderer,
    vendor: m.vendor,
    software: m.software,
    presents: m.presents,
    fps: rate(m.presents, prev?.g.presents),
    video: v && {
      enabled: v.enabled,
      decoded: v.decoded,
      decoderErrors: v.decoderErrors,
      fps: rate(v.decoded, prev?.g.video?.decoded),
      streams: v.streams.map((st) => ({
        ...st,
        fps: rate(st.decoded, prev?.g.video?.streams.find((o) => o.id === st.id)?.decoded),
      })),
    },
    vulkan: m.vulkan && {
      ...m.vulkan,
      submitRate: rate(m.vulkan.submits, prev?.g.vulkan?.submits),
      drawRate: rate(m.vulkan.draws, prev?.g.vulkan?.draws),
    },
  };
}

/** The renderer and its vendor, a line of its own under a tooltip's title. */
function rendererLine(g: Graphics) {
  if (!g.renderer) return '';
  return g.vendor
    ? t('statusbar:statusbar-graphics.gpu.renderer.vendor', { renderer: g.renderer, vendor: g.vendor })
    : t('statusbar:statusbar-graphics.gpu.renderer', { renderer: g.renderer });
}

/** WebGL2's words, 3D or 2D, hardware or software. */
function webglWords(is3d: boolean, software: boolean): { text: string; title: string } {
  if (software)
    return is3d
      ? {
          text: t('statusbar:statusbar-graphics.gpu.software.3d'),
          title: t('statusbar:statusbar-graphics.gpu.software.3d.title'),
        }
      : {
          text: t('statusbar:statusbar-graphics.gpu.software.2d'),
          title: t('statusbar:statusbar-graphics.gpu.software.2d.title'),
        };
  return is3d
    ? {
        text: t('statusbar:statusbar-graphics.gpu.webgl2.3d'),
        title: t('statusbar:statusbar-graphics.gpu.webgl2.3d.title'),
      }
    : {
        text: t('statusbar:statusbar-graphics.gpu.webgl2.2d'),
        title: t('statusbar:statusbar-graphics.gpu.webgl2.2d.title'),
      };
}

/** How the screen is drawn: the framebuffer, a canvas, or WebGL2 (3D or 2D, amber in software). */
export function gpuPiece(icon: IconName | undefined, live: Live): Piece[] {
  const g = live.gpu;
  if (!g) return [];
  if (g.mode === 'framebuffer')
    return piece(
      icon,
      t('statusbar:statusbar-graphics.gpu.framebuffer'),
      t('statusbar:statusbar-graphics.gpu.2d'),
      t('statusbar:statusbar-graphics.gpu.framebuffer.title'),
    );
  if (g.mode === 'canvas2d')
    return piece(
      icon,
      t('statusbar:statusbar-graphics.gpu.canvas'),
      t('statusbar:statusbar-graphics.gpu.2d'),
      t('statusbar:statusbar-graphics.gpu.canvas.title'),
      { tone: 'off' },
    );
  const is3d = g.mode === '3d';
  const software = g.software ?? false;
  const what = is3d ? t('statusbar:statusbar-graphics.gpu.3d') : t('statusbar:statusbar-graphics.gpu.2d');
  const words = webglWords(is3d, software);
  const by = rendererLine(g);
  const tone = software ? 'busy' : is3d ? 'ok' : undefined;
  return piece(icon, words.text, what, by ? `${words.title}\n${by}` : words.title, { tone });
}

/** The screen's presents a second. */
export function fpsPiece(icon: IconName | undefined, live: Live): Piece[] {
  const f = live.gpu?.fps;
  if (f === undefined) return [];
  const fps = f.toFixed(0);
  return piece(
    icon,
    t('statusbar:statusbar-graphics.fps', { fps }),
    fps,
    t('statusbar:statusbar-graphics.fps.title', { fps }),
  );
}

/** A video's words: its codecs, decoded in hardware or software, and its pictures a second once known. */
function videoText(hw: boolean, codecs: string, fps: string | undefined) {
  if (hw)
    return fps === undefined
      ? t('statusbar:statusbar-graphics.video.hw', { codecs })
      : t('statusbar:statusbar-graphics.video.hw.fps', { codecs, fps });
  return fps === undefined
    ? t('statusbar:statusbar-graphics.video.sw', { codecs })
    : t('statusbar:statusbar-graphics.video.sw.fps', { codecs, fps });
}

/** A stream's line in the tooltip: its codec, its size, and what's known of its decoder. */
function streamLine(st: Stream) {
  const facts: Msg[] = [
    msg(
      st.hardware
        ? 'statusbar:statusbar-graphics.video.stream.hardware'
        : 'statusbar:statusbar-graphics.video.stream.software',
    ),
  ];
  if (!st.open) facts.push(msg('statusbar:statusbar-graphics.video.stream.closed'));
  if (st.fps !== undefined)
    facts.push(msg('statusbar:statusbar-graphics.video.stream.fps', { fps: st.fps.toFixed(0) }));
  return t('statusbar:statusbar-graphics.video.stream', {
    profile: st.profile,
    width: st.width,
    height: st.height,
    facts,
  });
}

/** The video decoder: idle, or its streams' codecs and pictures a second (green in hardware). */
export function videoPiece(icon: IconName | undefined, live: Live): Piece[] {
  const v = live.gpu?.video;
  if (!v?.enabled) return [];
  if (!v.streams.length)
    return piece(
      icon,
      t('statusbar:statusbar-graphics.video.idle'),
      '',
      t('statusbar:statusbar-graphics.video.idle.title'),
      { tone: 'off' },
    );
  const open = v.streams.filter((st) => st.open);
  const hw = open.length > 0 && open.every((st) => st.hardware);
  const codecs = [...new Set(v.streams.map((st) => st.profile))].join(', ');
  const fps = v.fps?.toFixed(0);
  const short =
    fps === undefined
      ? `${v.streams.length}`
      : t('statusbar:statusbar-graphics.video.short', { streams: v.streams.length, fps });
  const errors = v.decoderErrors ? [t('statusbar:statusbar-graphics.video.errors', { errors: v.decoderErrors })] : [];
  const title = [t('statusbar:statusbar-graphics.video.title'), ...v.streams.map(streamLine), ...errors].join('\n');
  return piece(icon, videoText(hw, codecs, fps), short, title, { tone: hw ? 'ok' : undefined });
}

/** Venus: no device, idle, or its programs and submits a second (amber on a software adapter). */
export function vulkanPiece(icon: IconName | undefined, live: Live): Piece[] {
  const k = live.gpu?.vulkan;
  if (!k) return [];
  if (!k.device)
    return piece(
      icon,
      t('statusbar:statusbar-graphics.vulkan.none'),
      '',
      t('statusbar:statusbar-graphics.vulkan.none.title'),
      { tone: 'bad' },
    );
  const on = k.adapter
    ? t(
        k.software
          ? 'statusbar:statusbar-graphics.vulkan.adapter.software'
          : 'statusbar:statusbar-graphics.vulkan.adapter',
        { adapter: k.adapter },
      )
    : '';
  const titled = (...lines: string[]) => [...lines, ...(on ? [on] : [])].join('\n');
  if (!k.contexts)
    return piece(
      icon,
      t('statusbar:statusbar-graphics.vulkan.idle'),
      '',
      titled(t('statusbar:statusbar-graphics.vulkan.idle.title')),
      { tone: 'off' },
    );
  return vulkanBusy(icon, k, titled);
}

/** Venus with programs running. */
function vulkanBusy(icon: IconName | undefined, k: Vulkan, titled: (...lines: string[]) => string): Piece[] {
  const head = t('statusbar:statusbar-graphics.vulkan.title', { count: k.contexts });
  const tone = k.software ? 'busy' : (k.submitRate ?? 0) > 0 ? 'ok' : undefined;
  const submits = k.submitRate?.toFixed(0);
  if (submits === undefined)
    return piece(
      icon,
      t('statusbar:statusbar-graphics.vulkan.programs', { count: k.contexts }),
      `${k.contexts}`,
      titled(head),
      { tone },
    );
  const draws = k.drawRate?.toFixed(0) ?? '0';
  return piece(
    icon,
    t('statusbar:statusbar-graphics.vulkan.programs.rate', { count: k.contexts, submits }),
    t('statusbar:statusbar-graphics.vulkan.short', { count: k.contexts, submits }),
    titled(head, t('statusbar:statusbar-graphics.vulkan.rates', { submits, draws })),
    { tone },
  );
}
