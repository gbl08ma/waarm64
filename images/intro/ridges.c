// ridges: a flight over a landscape drawn as its ridge lines, nearest first, each hiding what lies
// behind it. The heights are smoothed noise in two octaves; the ground moves toward the viewer.
// (images/intro/, the introduction's guest; ours, MIT.)
#include "screen.h"

static uint32_t seed;
// A fixed pseudo-random height in [0, 1) for a corner of the grid.
static float corner(int x, int z) {
  uint32_t h = (uint32_t)x * 0x9e3779b1u ^ (uint32_t)z * 0x85ebca6bu ^ seed;
  h ^= h >> 15, h *= 0x2c1b3c6du, h ^= h >> 12;
  return (h & 0xffff) * (1.0f / 65536);
}
// The height between corners, eased so the ground has no creases.
static float ground(float x, float z) {
  int xi = (int)x - (x < 0), zi = (int)z - (z < 0);
  float fx = x - xi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx), fz = fz * fz * (3 - 2 * fz);
  float a = corner(xi, zi), b = corner(xi + 1, zi), c = corner(xi, zi + 1), d = corner(xi + 1, zi + 1);
  return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fz;
}

int main(void) {
  enum { ROWS = 46 };
  screen_open();
  seed = dice();
  int *horizon = malloc(W * sizeof *horizon);
  float fly = 0;
  for (;;) {
    frame(30);
    fly += 0.045f;
    for (int x = 0; x < W; x++) horizon[x] = H;
    float whole = (int)fly, part = fly - whole;
    for (int row = 0; row < ROWS; row++) {
      // A row's distance, and with it where it sits on the screen and how wide the view is there.
      float z = 1 + row - part, depth = 5.5f / (z + 4.5f);
      float base = H * (0.20f + 0.90f * depth), span = 9 / depth, rise = H * 0.95f * depth;
      int light = 235 * (ROWS - row) / ROWS + 20;
      if (row == 0) light = light * (1 - part);        // the nearest row leaves,
      if (row == ROWS - 1) light = light * part;       // the farthest arrives
      int before = 0;
      for (int x = 0; x < W; x++) {
        float gx = ((float)x / W - 0.5f) * span, gz = z + whole + part;
        float h = ground(gx * 0.35f, gz * 0.22f) * 0.75f + ground(gx * 1.1f + 40, gz * 0.7f) * 0.25f;
        // A valley along the middle to fly through.
        float side = gx * 0.16f;
        h *= 0.25f + (side * side > 0.75f ? 0.75f : side * side);
        int y = base - rise * h;
        // Lit where it is above everything nearer; joined to its neighbor so steep slopes stay whole.
        if (y < horizon[x]) {
          int from = x && before < horizon[x] ? before : y, to = y;
          if (from > to) { int s = from; from = to, to = s; }
          if (to >= horizon[x]) to = horizon[x] - 1;
          for (int yy = from; yy <= to; yy++) dot(x, yy, light);
          horizon[x] = y;
        }
        before = y;
      }
    }
    show(0);
  }
}
