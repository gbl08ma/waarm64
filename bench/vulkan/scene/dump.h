// A frame's pixels out of the native programs (vk.c, gles.c): a PPM, and a thumbnail printed as hex for the guest's
// runs (bench/vulkan/guest.ts), whose files can't come back but whose terminal can: each tw x th block's mean RGB.
#ifndef DUMP_H
#define DUMP_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

// rgba: rows top first, 4 bytes a pixel.
static void dump_frame(const char *path, const uint8_t *rgba, int width, int height, int thumbW, int thumbH) {
  FILE *f = fopen(path, "wb");
  if (f) {
    fprintf(f, "P6\n%d %d\n255\n", width, height);
    for (int i = 0; i < width * height; i++) fwrite(rgba + (size_t)i * 4, 1, 3, f);
    fclose(f);
  }
  if (thumbW <= 0) return;
  printf("thumb %d %d ", thumbW, thumbH);
  for (int by = 0; by < thumbH; by++)
    for (int bx = 0; bx < thumbW; bx++) {
      int x0 = bx * width / thumbW, x1 = (bx + 1) * width / thumbW, y0 = by * height / thumbH, y1 = (by + 1) * height / thumbH;
      uint64_t sum[3] = {0, 0, 0}, n = 0;
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++, n++)
          for (int c = 0; c < 3; c++) sum[c] += rgba[((size_t)y * width + x) * 4 + c];
      for (int c = 0; c < 3; c++) printf("%02x", (unsigned)(sum[c] / (n ? n : 1)));
    }
  printf("\n");
  fflush(stdout);
}

#endif
