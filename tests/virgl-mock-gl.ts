// A recording stand-in for WebGL2 (tests/virgl.test.ts): every call is counted, objects are tokens, queries answer
// like a capable context. It checks the renderer's decoding and state handling in Node, not its pixels (those are
// tests/virgl-browser.test.ts's, on Chromium's WebGL2).
import { E } from '../web/gl-enums.ts';

export type MockGl = WebGL2RenderingContext & { calls: Map<string, number>; log: [string, unknown[]][]; keepLog: boolean };

const PARAMS: Record<number, unknown> = {
  [E.MAX_TEXTURE_SIZE]: 8192, [E.MAX_3D_TEXTURE_SIZE]: 2048, [E.MAX_CUBE_MAP_TEXTURE_SIZE]: 8192, [E.MAX_ARRAY_TEXTURE_LAYERS]: 256,
  [E.MAX_DRAW_BUFFERS]: 8, [E.MAX_COLOR_ATTACHMENTS]: 8, [E.MAX_SAMPLES]: 4, [E.MAX_VERTEX_UNIFORM_BLOCKS]: 12,
  [E.MAX_FRAGMENT_UNIFORM_BLOCKS]: 12, [E.MAX_UNIFORM_BLOCK_SIZE]: 16384, [E.MAX_UNIFORM_BUFFER_BINDINGS]: 24,
  [E.UNIFORM_BUFFER_OFFSET_ALIGNMENT]: 256, [E.MAX_VERTEX_ATTRIBS]: 16, [E.MAX_VARYING_VECTORS]: 15,
  [E.MAX_VERTEX_UNIFORM_VECTORS]: 256, [E.MAX_FRAGMENT_UNIFORM_VECTORS]: 224, [E.MIN_PROGRAM_TEXEL_OFFSET]: -8,
  [E.MAX_PROGRAM_TEXEL_OFFSET]: 7, [E.MAX_TEXTURE_LOD_BIAS]: 2, [E.ALIASED_POINT_SIZE_RANGE]: new Float32Array([1, 1024]),
  [E.ALIASED_LINE_WIDTH_RANGE]: new Float32Array([1, 1]), [E.MAX_TEXTURE_IMAGE_UNITS]: 16, [E.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16,
  [E.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32, [E.MAX_RENDERBUFFER_SIZE]: 8192, [E.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS]: 4,
  [E.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS]: 64, [E.MAX_VIEWPORT_DIMS]: new Int32Array([8192, 8192]), [E.MAX_ELEMENT_INDEX]: 0xffffffff,
};

export function mockGl(o: { extensions?: string[]; params?: Record<number, unknown> } = {}): MockGl {
  const calls = new Map<string, number>();
  const log: [string, unknown[]][] = [];
  let serial = 0;
  const extensions = new Set(o.extensions ?? ['EXT_color_buffer_float', 'EXT_texture_filter_anisotropic', 'OES_texture_float_linear']);
  const canvas = { width: 300, height: 150 };
  const answers: Record<string, (...a: unknown[]) => unknown> = {
    getParameter: (p) => o.params?.[p as number] ?? PARAMS[p as number] ?? 0,
    // An extension's functions are recorded as the context's are (`enableiOES`, `clipControlEXT`…).
    getExtension: (name) => (extensions.has(name as string) ? recorder({}) : null),
    getSupportedExtensions: () => [...extensions],
    checkFramebufferStatus: () => E.FRAMEBUFFER_COMPLETE,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformLocation: (_p, name) => ({ name }),
    getUniformBlockIndex: () => 0,
    getQueryParameter: (_q, p) => (p === E.QUERY_RESULT_AVAILABLE ? true : 1),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    isContextLost: () => false,
  };
  const target = { calls, log, keepLog: false, canvas } as unknown as MockGl;
  function recorder<T extends object>(o: T): T {
    return new Proxy(o, {
      get(t, name: string) {
        if (name in t) return (t as unknown as Record<string, unknown>)[name];
        if (/^[A-Z_0-9]+$/.test(name)) return (E as Record<string, number>)[name] ?? 0;
        return (...a: unknown[]) => {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          if (target.keepLog) log.push([name, a]);
          if (answers[name]) return answers[name](...a);
          if (name.startsWith('create')) return { obj: name.slice(6), id: ++serial };
          return undefined;
        };
      },
    });
  }
  return recorder(target);
}
