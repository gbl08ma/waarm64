// The scene's toolkit-shaped setting (bench/vulkan/REPORT.md): a frame shaped like GTK4's on its Vulkan renderer (GSK)
// rather than a game's. Many textured quads, few pipelines: widgets in a scrolling grid, each a rounded background, an
// icon, a label's glyphs and two separators, drawn as instanced quads whose data is rebuilt every frame, in batches
// that change pipeline or texture where the widget's next part needs another (GSK merges only adjacent operations).
// No depth. Header-only, no libc.
#ifndef TOOLKIT_H
#define TOOLKIT_H

#include "scene.h"
#include "sim.h"

enum { TK_PIPE_TEXTURE, TK_PIPE_COLOR, TK_PIPE_ROUNDED, TK_PIPE_COUNT };
#define CMD_TK_DRAW 16  // a: first instance, b: instances
#define TK_TEXTURES 8   // textures 0-5 icons, 6-7 glyph atlases
#define TK_TEXTURE_SIZE 256
#define TK_QUADS_PER_WIDGET 20

// One quad: where (pixels), what part of its texture, its colour. 48 bytes, an instance.
typedef struct {
  float rect[4];   // x, y, width, height
  float uv[4];     // u0, v0, u1, v1 (the rounded rectangles: their radius and border in uv[0], uv[1])
  float color[4];
} ToolkitQuad;

typedef struct {
  int count;  // quads
  int widgets;
  int width, height;
} Toolkit;

static void toolkit_init(Toolkit *t, int quads, int width, int height) {
  t->widgets = (quads + TK_QUADS_PER_WIDGET - 1) / TK_QUADS_PER_WIDGET;
  t->count = t->widgets * TK_QUADS_PER_WIDGET;
  t->width = width;
  t->height = height;
}

// A texture's pixels (RGBA8): icons are rings and discs in a colour of their own, the atlases rows of glyph-like
// strokes, both with soft alpha edges.
static void toolkit_texture(uint32_t index, uint8_t *px) {
  for (int y = 0; y < TK_TEXTURE_SIZE; y++) {
    for (int x = 0; x < TK_TEXTURE_SIZE; x++) {
      uint8_t *p = px + (y * TK_TEXTURE_SIZE + x) * 4;
      int a;
      if (index < 6) {
        int dx = x - 128, dy = y - 128, d2 = dx * dx + dy * dy;
        int ring = (d2 < 120 * 120 && d2 > 90 * 90) || d2 < (40 + 8 * (int)index) * (40 + 8 * (int)index);
        a = ring ? 255 : 0;
        p[0] = (uint8_t)(60 + 30 * index); p[1] = (uint8_t)(200 - 25 * index); p[2] = (uint8_t)(90 + 20 * index);
      } else {
        int cell = (x / 16) + (y / 16) * 16, gx = x % 16, gy = y % 16;
        int stroke = ((cell * 7 + (int)index) % 5 == 0 && gx > 3 && gx < 6) || ((cell % 3) == 0 && gy > 9 && gy < 12) ||
                     ((cell % 4) == 1 && gx == gy);
        a = stroke && gx > 1 && gx < 15 && gy > 1 && gy < 15 ? 255 : 0;
        p[0] = p[1] = p[2] = 255;
      }
      p[3] = (uint8_t)a;
    }
  }
}

static void tk_quad(ToolkitQuad *q, float x, float y, float w, float h, float u0, float v0, float u1, float v1,
                    float r, float g, float b, float a) {
  q->rect[0] = x; q->rect[1] = y; q->rect[2] = w; q->rect[3] = h;
  q->uv[0] = u0; q->uv[1] = v0; q->uv[2] = u1; q->uv[3] = v1;
  q->color[0] = r; q->color[1] = g; q->color[2] = b; q->color[3] = a;
}

// Builds a frame: the quads into out (t->count), the commands into cmds; returns their number. Sets the frame's
// uniforms' viewProjection to the pixels-to-clip transform (y down, GL's clip space).
static uint32_t toolkit_frame(const Toolkit *t, Sim *s, SceneCmd *cmds, ToolkitQuad *out) {
  float *m = s->globals.viewProjection;
  for (int i = 0; i < 16; i++) m[i] = 0;
  m[0] = 2.0f / t->width; m[5] = -2.0f / t->height; m[10] = 1; m[12] = -1; m[13] = 1; m[15] = 1;
  SceneOut o = {cmds, 0, -1, -1};
  int cols = t->width / 240;
  if (cols < 1) cols = 1;
  float scroll = (float)(s->frame % 600) * 2.0f;
  int q = 0;
  uint32_t batchStart = 0, batchPipe = (uint32_t)-1, batchTex = (uint32_t)-1;
#define TK_PART(pipe, tex)                                                                 \
  do {                                                                                     \
    if ((pipe) != batchPipe || ((pipe) == TK_PIPE_TEXTURE && (tex) != batchTex)) {         \
      if (q > (int)batchStart) scene_emit(&o, CMD_TK_DRAW, batchStart, (uint32_t)q - batchStart, 0); \
      scene_emit(&o, CMD_PIPELINE, (pipe), 0, 0);                                          \
      if ((pipe) == TK_PIPE_TEXTURE) scene_emit(&o, CMD_MATERIAL, (tex), 0, 0);            \
      batchStart = (uint32_t)q; batchPipe = (pipe); batchTex = (tex);                      \
    }                                                                                      \
  } while (0)
  for (int w = 0; w < t->widgets; w++) {
    float x = 16 + (float)(w % cols) * 240, y = 16 + (float)(w / cols) * 72 - scroll;
    TK_PART(TK_PIPE_ROUNDED, 0u);
    tk_quad(&out[q++], x, y, 224, 64, 8, 1, 0, 0, 0.98f, 0.98f, 1.0f, 1);
    uint32_t icon = (uint32_t)(w % 6);
    TK_PART(TK_PIPE_TEXTURE, icon);
    tk_quad(&out[q++], x + 8, y + 8, 48, 48, 0, 0, 1, 1, 1, 1, 1, 1);
    uint32_t atlas = 6 + (uint32_t)(w % 2);
    TK_PART(TK_PIPE_TEXTURE, atlas);
    for (int g = 0; g < 16; g++) {
      int cell = (w * 5 + g * 3) % 256;
      float u = (float)(cell % 16) / 16, v = (float)(cell / 16) / 16;
      tk_quad(&out[q++], x + 64 + g * 9, y + 14 + (g / 16) * 18, 10, 16, u, v, u + 1.0f / 16, v + 1.0f / 16, 0.1f, 0.1f, 0.15f, 1);
    }
    TK_PART(TK_PIPE_COLOR, 0u);
    tk_quad(&out[q++], x, y + 64, 224, 1, 0, 0, 0, 0, 0.8f, 0.8f, 0.82f, 1);
    tk_quad(&out[q++], x + 223, y, 1, 64, 0, 0, 0, 0, 0.8f, 0.8f, 0.82f, 1);
  }
  if (q > (int)batchStart) scene_emit(&o, CMD_TK_DRAW, batchStart, (uint32_t)q - batchStart, 0);
#undef TK_PART
  return o.n;
}

#endif
