// scope: an oscilloscope in X-Y mode. Two signals, each the product of two sine waves, move a beam
// that leaves its light on the phosphor; the waves' frequencies stay in small whole ratios while
// their phases drift, so the figure turns and folds without repeating.
// (images/intro/, the introduction's guest; ours, MIT.)
#include "screen.h"
#include <math.h>

// A sine wave as a point turning on a circle: no sin() per sample.
struct wave { float c, s, dc, ds; };
static void wave_set(struct wave *w, float phase, float step) {
  w->c = cosf(phase), w->s = sinf(phase), w->dc = cosf(step), w->ds = sinf(step);
}
static inline float wave_next(struct wave *w) {
  float c = w->c * w->dc - w->s * w->ds;
  w->s = w->s * w->dc + w->c * w->ds, w->c = c;
  return w->s;
}

int main(void) {
  static const int ratios[][4] = {{3, 2, 1, 5}, {5, 4, 2, 1}, {2, 3, 7, 1}, {4, 3, 1, 2}, {5, 3, 3, 4}, {3, 4, 5, 2}};
  enum { N = 5000, FIGURES = sizeof ratios / sizeof *ratios, EACH = 420 };
  screen_open();
  int first = dice() % FIGURES;
  float size = (W < H ? W : H) * 0.46f * 256, turn = 6.2831853f / N;
  for (;;) {
    int n = frame(30);
    const int *r = ratios[(first + n / EACH) % FIGURES];
    float t = n * 0.004f;
    struct wave x1, x2, y1, y2;
    wave_set(&x1, t * 1.7f, turn * r[0]);
    wave_set(&y1, t, turn * r[1]);
    wave_set(&x2, 1.5708f + t * 0.31f, turn * r[2]);
    wave_set(&y2, 1.5708f - t * 0.23f, turn * r[3]);
    // The beam fades in and out around a change of figure.
    int k = n % EACH, edge = k < 30 ? k : EACH - k < 30 ? EACH - k : 30;
    int px = 0, py = 0;
    for (int i = 0; i <= N; i++) {
      int x = W * 128 + (int)(size * wave_next(&x1) * (0.72f + 0.28f * wave_next(&x2)));
      int y = H * 128 + (int)(size * wave_next(&y1) * (0.72f + 0.28f * wave_next(&y2)));
      // A slow beam lights the phosphor more than a fast one.
      if (i) {
        int d = abs(x - px) + abs(y - py);
        line(px, py, x, y, (d < 160 ? 56 : 9000 / d) * edge / 30);
      }
      px = x, py = y;
    }
    show(150);
  }
}
