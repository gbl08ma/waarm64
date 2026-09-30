// M8 phase B: the variable store's CFI flash bank at 0x0400_0000 (QEMU virt's
// bank 1; ours in the firmware configuration), driven as EDK2's
// VirtNorFlashDxe does: 32-bit accesses, every command in both 16-bit halves
// (two interleaved x16 chips), the status register polled for ready (bit 7).
// flash
#include "lib.h"

#define FLASH 0x04000000UL
#define BLOCK (256UL << 10)
#define W(a) mmio32(FLASH + (a))
#define READY 0x00800080u

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(100 + vec);
}

static void cmd(u64 at, u32 c) { W(at) = c | c << 16; }

// Polls the status register until both chips are ready; returns it.
static u32 status(void) {
  cmd(0, 0x70);
  u32 s;
  for (int i = 0; i < 1000000; i++)
    if (((s = W(0)) & READY) == READY) return s;
  return s;
}

static void erase(u64 block, int code) {
  cmd(block, 0x20);
  cmd(block, 0xd0);
  check(status() == READY, code);
  cmd(0, 0xff);
}

int main(void) {
  // Block erase: every word of the block reads all ones.
  erase(0, 1);
  check(W(0) == ~0u && W(0x100) == ~0u && W(BLOCK - 4) == ~0u, 2);
  erase(BLOCK, 3);

  // Word program, then back to read array.
  cmd(0x100, 0x40);
  W(0x100) = 0x12345678;
  check(status() == READY, 10);
  cmd(0, 0xff);
  check(W(0x100) == 0x12345678, 11);
  check(W(0x104) == ~0u && W(0xfc) == ~0u, 12);
  check(mmio8(FLASH + 0x101) == 0x56, 13);

  // Buffered program: setup at the target (the status then says the buffer
  // is available), the word count - 1, the words, confirm.
  cmd(BLOCK, 0xe8);
  check((W(BLOCK) & READY) == READY, 20);
  cmd(BLOCK, 7);
  for (u32 i = 0; i < 8; i++) W(BLOCK + 4 * i) = 0xa5000000u | i;
  cmd(0, 0xd0);
  check(status() == READY, 21);
  cmd(0, 0xff);
  for (u32 i = 0; i < 8; i++) check(W(BLOCK + 4 * i) == (0xa5000000u | i), 22);
  check(W(BLOCK + 32) == ~0u, 23);

  // Erasing block 1 leaves block 0 alone.
  erase(BLOCK, 30);
  check(W(BLOCK) == ~0u && W(BLOCK + 28) == ~0u, 31);
  check(W(0x100) == 0x12345678, 32);

  // Unlock (setup, then 0xD0) completes; the identifier space says unlocked.
  cmd(0, 0x60);
  cmd(0, 0xd0);
  check(status() == READY, 40);
  cmd(8, 0x90);
  check(W(8) == 0, 41); // block lock status
  check(W(0) == 0x00890089, 42); // manufacturer: Intel
  cmd(0, 0xff);

  // CFI query: "QRY" at words 0x10-0x12 of each chip.
  cmd(0, 0x98);
  check(W(0x40) == 0x00510051 && W(0x44) == 0x00520052 && W(0x48) == 0x00590059, 50);
  cmd(0, 0xff);
  check(W(0x100) == 0x12345678, 51);

  // Clear status (0x50) returns to read array.
  cmd(0, 0x50);
  check(W(0x100) == 0x12345678, 60);
  return 0;
}
