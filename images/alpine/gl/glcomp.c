// The llvmpipe benchmark's workload (images/alpine/gl, docs/benchmarking.md): a compositor's
// GLES2 load on Mesa without a display (EGL surfaceless, an FBO). Per frame: a client buffer's
// damage uploaded (glTexSubImage2D, 64 rows: a terminal scrolling), `quads` blended textured quads
// over the whole W x H target (wlroots' texture shader, roughly), and a glReadPixels that waits
// for the rasterizer as a flip would. "waarm64: <phase> start/end" lines time the phases for the
// host; the check line hashes pixels read back (the same on every llvmpipe thread count).
//   glcomp [frames] [quads] [w] [h] [dump]  (30 3 1376 762: sway's frame on the page's display)
// dump=1 prints the last frame's pixels too ("glcomp: px <row> <hex RGBA>", rows bottom-up as GL reads them): the
// reference for the virgl renderer's tests (tests/virgl/).
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static GLuint sh(GLenum k, const char *s) {
  GLuint o = glCreateShader(k); glShaderSource(o, 1, &s, 0); glCompileShader(o);
  GLint ok; glGetShaderiv(o, GL_COMPILE_STATUS, &ok); if (!ok) { char b[512]; glGetShaderInfoLog(o, 512, 0, b); fprintf(stderr, "%s\n", b); exit(1); }
  return o;
}
int main(int argc, char **argv) {
  int frames = argc > 1 ? atoi(argv[1]) : 30, quads = argc > 2 ? atoi(argv[2]) : 3;
  int w = argc > 3 ? atoi(argv[3]) : 1376, h = argc > 4 ? atoi(argv[4]) : 762, dump = argc > 5 ? atoi(argv[5]) : 0;
  PFNEGLGETPLATFORMDISPLAYEXTPROC gpd = (void *)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = gpd(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, 0);
  if (!eglInitialize(d, 0, 0)) { fprintf(stderr, "eglInitialize failed\n"); return 1; }
  eglBindAPI(EGL_OPENGL_ES_API);
  EGLint ca[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
  EGLContext c = eglCreateContext(d, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ca);
  if (!c || !eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, c)) { fprintf(stderr, "context failed\n"); return 1; }
  printf("glcomp: %s, %s, %dx%d, %d quads, %d frames\n", glGetString(GL_RENDERER), glGetString(GL_VERSION), w, h, quads, frames);
  GLuint fb, rt, tex;
  glGenTextures(1, &rt); glBindTexture(GL_TEXTURE_2D, rt);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0);
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rt, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "fbo incomplete\n"); return 1; }
  unsigned *px = malloc((size_t)w * h * 4);
  for (int i = 0; i < w * h; i++) px[i] = 0x80000000u | (i * 2654435761u >> 8);
  glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
  // wlroots' GLES2 texture shader, roughly: a sampled texture times an alpha.
  GLuint p = glCreateProgram();
  glAttachShader(p, sh(GL_VERTEX_SHADER, "attribute vec2 pos; uniform vec4 r; varying vec2 uv; void main() { uv = pos; gl_Position = vec4(r.xy + pos * r.zw, 0.0, 1.0); }"));
  glAttachShader(p, sh(GL_FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D t; uniform float a; void main() { gl_FragColor = texture2D(t, uv) * a; }"));
  glBindAttribLocation(p, 0, "pos"); glLinkProgram(p); glUseProgram(p);
  GLint ur = glGetUniformLocation(p, "r"), ua = glGetUniformLocation(p, "a");
  static const float q[] = { 0, 0, 1, 0, 0, 1, 1, 1 };
  glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, q); glEnableVertexAttribArray(0);
  glViewport(0, 0, w, h); glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
  unsigned sum = 0, rd[4];
  for (int pass = 0; pass < 2; pass++) {
    const char *name = pass ? "frames" : "warm";
    int n = pass ? frames : 3;
    printf("waarm64: %s start\n", name); fflush(stdout);
    double t0 = now(), worst = 0;
    for (int f = 0; f < n; f++) {
      double t = now();
      // the client's damage: a band of rows (a terminal scrolling)
      for (int i = 0; i < w * 64; i++) px[i] += 0x010101;
      glTexSubImage2D(GL_TEXTURE_2D, 0, 0, (f * 64) % (h - 64), w, 64, GL_RGBA, GL_UNSIGNED_BYTE, px);
      glClearColor(0.2f, 0.2f, 0.2f, 1); glClear(GL_COLOR_BUFFER_BIT);
      for (int k = 0; k < quads; k++) {
        float o = 0.05f * k;
        glUniform4f(ur, -1 + o, -1 + o, 2 - o, 2 - o); glUniform1f(ua, k ? 0.9f : 1.0f);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
      }
      glReadPixels(f % w, f % h, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, rd); // finishes the frame, like a flip that waits
      sum = sum * 31 + rd[0] + rd[3];
      t = now() - t; if (t > worst) worst = t;
    }
    double ms = now() - t0;
    printf("waarm64: %s end\n", name);
    printf("glcomp: %s: %d frames, %.1f ms a frame, worst %.1f, %.2f frames/s\n", name, n, ms / n, worst, 1e3 * n / ms);
  }
  printf("glcomp: check %08x\n", sum);
  if (dump) {
    unsigned char *all = malloc((size_t)w * h * 4);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, all);
    for (int y = 0; y < h; y++) {
      printf("glcomp: px %d ", y);
      for (int x = 0; x < w * 4; x++) printf("%02x", all[(size_t)y * w * 4 + x]);
      printf("\n");
    }
  }
  return 0;
}
