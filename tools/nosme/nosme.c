// tools/nosme: an LD_PRELOAD for Chromium on the dev VM (docs/testing.md): hides SME from getauxval(AT_HWCAP2). The M4
// under Lima has SME but no SVE, and Chromium's SME kernels (libyuv) begin with an SVE instruction (`cntd`), so reading a
// video frame's pixels (VideoFrame.copyTo, a WebGL upload, createImageBitmap) kills the renderer with SIGILL.
//   cc -O2 -shared -fPIC -o target/nosme/libnosme.so tools/nosme/nosme.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/auxv.h>

unsigned long getauxval(unsigned long type) {
  static unsigned long (*real)(unsigned long);
  if (!real) real = (unsigned long (*)(unsigned long))dlsym(RTLD_NEXT, "getauxval");
  unsigned long v = real(type);
  // HWCAP2_SME (23) and the SME feature bits: 24..30, SME2 and SME2P1 (37, 38), 39..42, 57..62.
  if (type == AT_HWCAP2) v &= ~((0xffUL << 23) | (0x3fUL << 37) | (0x3fUL << 57));
  return v;
}
