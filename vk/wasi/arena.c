/* The renderer's heap (vk/README.md): the module lives in a fixed arena at the bottom of memory 1, of a fixed size, with
 * the host-visible window after it, so malloc (wasi-libc's dlmalloc) must never grow the memory nor reach the window.
 * dlmalloc starts with the memory past the module's stack and data that its initial size gives (`__heap_base` to
 * `__heap_end`) and calls sbrk for more, which hands out the arena from there to its end (`ARENA_END`: web/ram.ts
 * VENUS_ARENA, from vk/gen.ts) instead of growing the memory. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

extern unsigned char __heap_end;
#define ARENA_END ((uint64_t)VENUS_ARENA_END)

static uintptr_t brk_at;

void *
sbrk(intptr_t increment)
{
   if (!brk_at)
      brk_at = (uintptr_t)&__heap_end;
   uintptr_t old = brk_at;
   if (increment < 0 || (uint64_t)old + (uint64_t)increment > ARENA_END) {
      static int said;
      if (!said++)
         fprintf(stderr, "the renderer's arena is full: %lld more bytes at %#llx\n", (long long)increment,
                 (unsigned long long)old);
      errno = ENOMEM;
      return (void *)-1;
   }
   brk_at += (uintptr_t)increment;
   return (void *)old;
}
