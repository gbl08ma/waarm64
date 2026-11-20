// life: Conway's Game of Life on a torus, seeded at random; a cell that dies leaves its light to
// fade. When the population settles into a loop the board is seeded again.
// (images/intro/, the introduction's guest; ours, MIT.)
#include "screen.h"

enum { CELL = 4 };
static int cw, ch;
static uint8_t *now, *next;

static void sow(void) {
  for (int i = 0; i < cw * ch; i++) now[i] = dice() % 100 < 28;
}

int main(void) {
  screen_open();
  cw = W / CELL, ch = H / CELL;
  now = malloc(cw * ch), next = malloc(cw * ch);
  int ox = (W - cw * CELL) / 2, oy = (H - ch * CELL) / 2;
  sow();
  int counts[8] = {0}, age = 0;
  for (;;) {
    int n = frame(30);
    // The living cells, lit: a square each, a seam between neighbors.
    for (int y = 0; y < ch; y++)
      for (int x = 0; x < cw; x++)
        if (now[y * cw + x])
          for (int j = 0; j < CELL - 1; j++)
            memset(&lum[(oy + y * CELL + j) * W + ox + x * CELL], 220, CELL - 1);
    show(214);
    if (n % 3) continue; // ten generations a second
    int alive = 0;
    for (int y = 0; y < ch; y++) {
      const uint8_t *up = &now[(y ? y - 1 : ch - 1) * cw], *row = &now[y * cw], *down = &now[(y + 1 < ch ? y + 1 : 0) * cw];
      for (int x = 0; x < cw; x++) {
        int l = x ? x - 1 : cw - 1, r = x + 1 < cw ? x + 1 : 0;
        int around = up[l] + up[x] + up[r] + row[l] + row[r] + down[l] + down[x] + down[r];
        alive += next[y * cw + x] = around == 3 || (around == 2 && row[x]);
      }
    }
    uint8_t *t = now;
    now = next, next = t;
    // Settled: the population repeats one of its last few values for a while.
    int settled = 0;
    for (int i = 0; i < 8; i++) settled += counts[i] == alive;
    counts[age++ & 7] = alive;
    if ((settled >= 4 && age > 600) || age > 3000) sow(), age = 0;
  }
}
