// A GL program that waits on occlusion queries (PERF loop 16, bench/gpu/REPORT.md "PERF loop 16: virgl's query poll"):
// per frame a full-target quad, then `queries` small quads each inside an ANY_SAMPLES_PASSED query whose result is
// waited for at once (glGetQueryObjectuiv(GL_QUERY_RESULT): an occlusion culler testing a bounding box before it draws
// what's inside), then a glFinish (the frame's end, a fence with no query pending: the fence's own way back).
//   glquery [frames] [queries] [w] [h]  (60 4 640 480)
// Prints each wait's and finish's median and quartiles (ms) and the frames a second; GLES 3.0 on EGL surfaceless.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static int cmp(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static void stats(const char *name, double *v, int n) {
  qsort(v, n, sizeof *v, cmp);
  printf("glquery: %s n=%d p25 %.3f median %.3f p75 %.3f max %.3f ms\n", name, n, v[n / 4], v[n / 2], v[3 * n / 4], v[n - 1]);
}
static GLuint sh(GLenum k, const char *s) {
  GLuint o = glCreateShader(k); glShaderSource(o, 1, &s, 0); glCompileShader(o);
  GLint ok; glGetShaderiv(o, GL_COMPILE_STATUS, &ok); if (!ok) { char b[512]; glGetShaderInfoLog(o, 512, 0, b); fprintf(stderr, "%s\n", b); exit(1); }
  return o;
}
int main(int argc, char **argv) {
  int frames = argc > 1 ? atoi(argv[1]) : 60, queries = argc > 2 ? atoi(argv[2]) : 4;
  int w = argc > 3 ? atoi(argv[3]) : 640, h = argc > 4 ? atoi(argv[4]) : 480;
  PFNEGLGETPLATFORMDISPLAYEXTPROC gpd = (void *)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = gpd(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, 0);
  if (!eglInitialize(d, 0, 0)) { fprintf(stderr, "eglInitialize failed\n"); return 1; }
  eglBindAPI(EGL_OPENGL_ES_API);
  EGLint ca[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
  EGLContext c = eglCreateContext(d, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ca);
  if (!c || !eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, c)) { fprintf(stderr, "context failed\n"); return 1; }
  printf("glquery: %s, %s, %dx%d, %d queries, %d frames\n", glGetString(GL_RENDERER), glGetString(GL_VERSION), w, h, queries, frames);
  GLuint fb, rt;
  glGenTextures(1, &rt); glBindTexture(GL_TEXTURE_2D, rt);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0);
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rt, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "fbo incomplete\n"); return 1; }
  GLuint p = glCreateProgram();
  glAttachShader(p, sh(GL_VERTEX_SHADER, "attribute vec2 pos; uniform vec4 r; void main() { gl_Position = vec4(r.xy + pos * r.zw, 0.0, 1.0); }"));
  glAttachShader(p, sh(GL_FRAGMENT_SHADER, "precision mediump float; uniform vec4 col; void main() { gl_FragColor = col; }"));
  glBindAttribLocation(p, 0, "pos"); glLinkProgram(p); glUseProgram(p);
  GLint ur = glGetUniformLocation(p, "r"), uc = glGetUniformLocation(p, "col");
  static const float q[] = { 0, 0, 1, 0, 0, 1, 1, 1 };
  glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, q); glEnableVertexAttribArray(0);
  glViewport(0, 0, w, h);
  GLuint *qs = malloc(sizeof *qs * (queries ? queries : 1));
  glGenQueries(queries ? queries : 1, qs);
  double *waits = malloc(sizeof *waits * (frames * queries + 1)), *finishes = malloc(sizeof *finishes * (frames + 1));
  unsigned passed = 0;
  for (int pass = 0; pass < 2; pass++) {
    const char *name = pass ? "frames" : "warm";
    int n = pass ? frames : 5, nw = 0;
    printf("waarm64: %s start\n", name); fflush(stdout);
    double t0 = now();
    for (int f = 0; f < n; f++) {
      glClearColor(0.2f, 0.2f, 0.2f, 1); glClear(GL_COLOR_BUFFER_BIT);
      glUniform4f(ur, -1, -1, 2, 2); glUniform4f(uc, 0.3f, 0.4f, 0.5f, 1); glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
      for (int k = 0; k < queries; k++) {
        float x = -0.9f + 0.4f * (k % 4), y = -0.9f + 0.4f * ((k / 4) % 4);
        glBeginQuery(GL_ANY_SAMPLES_PASSED, qs[k]);
        glUniform4f(ur, x, y, 0.3f, 0.3f); glUniform4f(uc, 0.9f, 0.5f, 0.1f, 1); glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        glEndQuery(GL_ANY_SAMPLES_PASSED);
        double t = now();
        GLuint r = 0;
        glGetQueryObjectuiv(qs[k], GL_QUERY_RESULT, &r);
        if (pass) waits[nw++] = now() - t;
        passed += r != 0;
      }
      double t = now();
      glFinish();
      if (pass) finishes[f] = now() - t;
    }
    double ms = now() - t0;
    printf("waarm64: %s end\n", name);
    printf("glquery: %s: %d frames, %.2f ms a frame, %.2f frames/s\n", name, n, ms / n, 1e3 * n / ms);
    if (pass) {
      if (nw) stats("wait", waits, nw);
      stats("finish", finishes, n);
    }
  }
  printf("glquery: passed %u of %d\n", passed, (frames + 5) * queries);
  return 0;
}
