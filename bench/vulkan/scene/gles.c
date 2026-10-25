// VK0's scene in OpenGL ES 3.0 (bench/vulkan/REPORT.md, arm 4: what Vulkan competes with in the guest, on virgl):
// the same simulation and draw order as vk.c (sim.h, scene.h, toolkit.h), written the way GL programs are. A program
// per pipeline with its state set when it changes, the frame's uniforms and the objects' in uniform buffers (an object
// bound by glBindBufferRange, as engines do for per-object data), a fish's 48 bytes in one glUniform4fv, a sync object
// a frame and two frames in flight, offscreen on EGL's surfaceless platform (an FBO; with --msaa 4, multisampled
// renderbuffers resolved by a blit). The shaders come from gles-shaders.ts.
//
//   gles --pack aquarium.pack --shaders dir [--fish N] [--toolkit N] [--width W --height H] [--msaa 1|4]
//        [--warmup F] [--samples S] [--frames F] [--dump FRAME:out.ppm [--thumb WxH]] [--json out.json] [--label s]
//
// Run with EGL_PLATFORM=surfaceless. Measures as vk.c does, without the GPU's time (GLES 3.0 has no timer queries).
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "pack.h"
#include "scene.h"
#include "sim.h"
#include "toolkit.h"
#include "dump.h"

#define FRAMES_IN_FLIGHT 2
#define MAX_SAMPLES 256

static double now_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static double cpu_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static char *read_file(const char *dir, const char *name) {
  char path[1024];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "can't open %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *s = malloc((size_t)n + 1);
  if (fread(s, 1, (size_t)n, f) != (size_t)n) exit(1);
  s[n] = 0;
  fclose(f);
  return s;
}

static GLuint compile(GLenum type, const char *dir, const char *name, int nofog) {
  char *src = read_file(dir, name);
  // The define goes after the #version line.
  char *nl = strchr(src, '\n');
  const char *parts[3] = {src, nofog ? "#define NOFOG\n" : "", nl + 1};
  GLint lens[3] = {(GLint)(nl + 1 - src), -1, -1};
  GLuint s = glCreateShader(type);
  glShaderSource(s, 3, parts, lens);
  glCompileShader(s);
  GLint ok;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[4096];
    glGetShaderInfoLog(s, sizeof log, NULL, log);
    fprintf(stderr, "%s: %s\n", name, log);
    exit(1);
  }
  free(src);
  return s;
}

typedef enum { BLEND_NONE, BLEND_ALPHA, BLEND_ADD } Blend;

typedef struct {
  const char *vs, *fs;
  int fog, cull, depthWrite;
  Blend blend;
  int input;  // 0: the models' vertices; 1: the bubbles' instances; 2: the toolkit's instances
} PipeDesc;

static const PipeDesc PIPES[PIPE_COUNT] = {
  [PIPE_DIFFUSE] = {"object.vert", "diffuse.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_DIFFUSE_NOFOG] = {"object.vert", "diffuse.frag", 0, 1, 1, BLEND_NONE, 0},
  [PIPE_NORMALMAP] = {"object.vert", "normalmap.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_REFLECTION] = {"object.vert", "reflection.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_FISH_NORMAL] = {"fish.vert", "fishnormal.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_FISH_REFLECT] = {"fish.vert", "fishreflect.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_SEAWEED] = {"seaweed.vert", "seaweed.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_INNER] = {"object.vert", "inner.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_OUTER] = {"object.vert", "outer.frag", 0, 1, 1, BLEND_ALPHA, 0},
  [PIPE_BUBBLE] = {"bubble.vert", "bubble.frag", 0, 0, 0, BLEND_ADD, 1},
  [PIPE_RAY] = {"ray.vert", "ray.frag", 0, 0, 0, BLEND_ADD, 0},
};

static const PipeDesc TK_PIPES[TK_PIPE_COUNT] = {
  [TK_PIPE_TEXTURE] = {"tk.vert", "tktexture.frag", 0, 0, 0, BLEND_ALPHA, 2},
  [TK_PIPE_COLOR] = {"tk.vert", "tkcolor.frag", 0, 0, 0, BLEND_ALPHA, 2},
  [TK_PIPE_ROUNDED] = {"tk.vert", "tkrounded.frag", 0, 0, 0, BLEND_ALPHA, 2},
};

typedef struct {
  GLuint prog;
  GLint fish, setWorld, rayWorld, rayColor;
} Program;

static Program program_new(const char *dir, PipeDesc d) {
  Program p;
  GLuint vs = compile(GL_VERTEX_SHADER, dir, d.vs, 0), fs = compile(GL_FRAGMENT_SHADER, dir, d.fs, !d.fog);
  p.prog = glCreateProgram();
  glAttachShader(p.prog, vs);
  glAttachShader(p.prog, fs);
  glLinkProgram(p.prog);
  GLint ok;
  glGetProgramiv(p.prog, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[4096];
    glGetProgramInfoLog(p.prog, sizeof log, NULL, log);
    fprintf(stderr, "%s+%s: %s\n", d.vs, d.fs, log);
    exit(1);
  }
  glDeleteShader(vs);
  glDeleteShader(fs);
  // Blocks and samplers by name: the frame's uniforms at binding 0, an object's at 1; textures on units 0-2, the
  // skybox on 3.
  GLuint b = glGetUniformBlockIndex(p.prog, "Globals");
  if (b != GL_INVALID_INDEX) glUniformBlockBinding(p.prog, b, 0);
  b = glGetUniformBlockIndex(p.prog, "Object");
  if (b != GL_INVALID_INDEX) glUniformBlockBinding(p.prog, b, 1);
  glUseProgram(p.prog);
  const char *samplers[5] = {"diffuse", "normalMap", "reflectionMap", "skybox", "colorMap"};
  const int units[5] = {0, 1, 2, 3, 0};
  for (int i = 0; i < 5; i++) {
    GLint loc = glGetUniformLocation(p.prog, samplers[i]);
    if (loc >= 0) glUniform1i(loc, units[i]);
  }
  p.fish = glGetUniformLocation(p.prog, "fishData");
  p.setWorld = glGetUniformLocation(p.prog, "setWorld");
  p.rayWorld = glGetUniformLocation(p.prog, "rayWorld");
  p.rayColor = glGetUniformLocation(p.prog, "rayColorMult");
  return p;
}

static GLuint texture_new(const PackTexture *t, const uint8_t *data) {
  GLuint tex;
  glGenTextures(1, &tex);
  GLenum target = t->layers == 6 ? GL_TEXTURE_CUBE_MAP : GL_TEXTURE_2D;
  glBindTexture(target, tex);
  glTexStorage2D(target, (GLsizei)t->mips, GL_RGBA8, (GLsizei)t->width, (GLsizei)t->height);
  const uint8_t *p = data;
  for (uint32_t l = 0; l < t->mips; l++) {
    uint32_t w = t->width >> l, h = t->height >> l;
    w = w ? w : 1;
    h = h ? h : 1;
    for (uint32_t layer = 0; layer < t->layers; layer++) {
      GLenum face = t->layers == 6 ? GL_TEXTURE_CUBE_MAP_POSITIVE_X + layer : GL_TEXTURE_2D;
      glTexSubImage2D(face, (GLint)l, 0, 0, (GLsizei)w, (GLsizei)h, GL_RGBA, GL_UNSIGNED_BYTE, p);
      p += (size_t)w * h * 4;
    }
  }
  return tex;
}

static void usage(void) {
  fprintf(stderr, "usage: gles --pack file --shaders dir [--fish N | --toolkit N] [--width W] [--height H] [--msaa 1|4]\n"
                  "            [--warmup F] [--samples S] [--frames F] [--dump FRAME:file.ppm] [--json file] [--label s]\n");
  exit(2);
}

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

static void stats(double *v, int n, double *median, double *iqr) {
  double s[MAX_SAMPLES];
  memcpy(s, v, n * sizeof *v);
  qsort(s, n, sizeof *s, cmp_double);
  *median = n % 2 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  *iqr = s[(3 * n) / 4] - s[n / 4];
}

static void json_array(FILE *f, const char *name, double *v, int n) {
  fprintf(f, "\"%s\": [", name);
  for (int i = 0; i < n; i++) fprintf(f, "%s%.4f", i ? ", " : "", v[i]);
  fprintf(f, "]");
}

int main(int argc, char **argv) {
  const char *packPath = NULL, *shaderDir = NULL, *dumpPath = NULL, *jsonPath = NULL, *label = "";
  int fishTotal = 1000, toolkit = 0, width = 1920, height = 1080, msaa = 1, warmup = 60, samples = 10, frames = 60;
  int dumpFrame = -1, thumbW = 0, thumbH = 0;
  for (int i = 1; i < argc; i += 2) {  // every option takes a value
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!v) usage();
    if (!strcmp(a, "--pack")) packPath = v;
    else if (!strcmp(a, "--shaders")) shaderDir = v;
    else if (!strcmp(a, "--fish")) fishTotal = atoi(v);
    else if (!strcmp(a, "--toolkit")) toolkit = atoi(v);
    else if (!strcmp(a, "--width")) width = atoi(v);
    else if (!strcmp(a, "--height")) height = atoi(v);
    else if (!strcmp(a, "--msaa")) msaa = atoi(v);
    else if (!strcmp(a, "--warmup")) warmup = atoi(v);
    else if (!strcmp(a, "--samples")) samples = atoi(v);
    else if (!strcmp(a, "--frames")) frames = atoi(v);
    else if (!strcmp(a, "--json")) jsonPath = v;
    else if (!strcmp(a, "--label")) label = v;
    else if (!strcmp(a, "--device")) (void)0;
    else if (!strcmp(a, "--thumb")) {
      thumbW = atoi(v);
      const char *c = strchr(v, 'x');
      thumbH = c ? atoi(c + 1) : 0;
    } else if (!strcmp(a, "--dump")) {
      dumpFrame = atoi(v);
      const char *c = strchr(v, ':');
      if (!c) usage();
      dumpPath = c + 1;
    } else usage();
  }
  if (!packPath || !shaderDir || (msaa != 1 && msaa != 4) || samples > MAX_SAMPLES || samples < 1) usage();

  Pack pack;
  {
    FILE *f = fopen(packPath, "rb");
    if (!f) { fprintf(stderr, "can't open %s\n", packPath); return 1; }
    fseek(f, 0, SEEK_END);
    size_t n = (size_t)ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *data = malloc(n);
    if (!data || fread(data, 1, n, f) != n || pack_parse(&pack, data, n)) { fprintf(stderr, "bad pack %s\n", packPath); return 1; }
    fclose(f);
  }

  // EGL without a surface: a GLES 3.0 context made current with none.
  EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL)) { fprintf(stderr, "no EGL display\n"); return 1; }
  eglBindAPI(EGL_OPENGL_ES_API);
  EGLint cfgAttrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE};
  EGLConfig cfg;
  EGLint ncfg = 0;
  eglChooseConfig(dpy, cfgAttrs, &cfg, 1, &ncfg);
  EGLint ctxAttrs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
  EGLContext ctx = eglCreateContext(dpy, ncfg ? cfg : EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ctxAttrs);
  if (ctx == EGL_NO_CONTEXT || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) {
    fprintf(stderr, "no GLES 3 context (0x%x)\n", eglGetError());
    return 1;
  }
  const char *renderer = (const char *)glGetString(GL_RENDERER), *version = (const char *)glGetString(GL_VERSION);
  fprintf(stderr, "renderer: %s (%s)\n", renderer, version);

  // The render target.
  GLuint fbo, color, msFbo = 0, msColor = 0, depth;
  glGenFramebuffers(1, &fbo);
  glGenTextures(1, &color);
  glBindTexture(GL_TEXTURE_2D, color);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, width, height);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
  glGenRenderbuffers(1, &depth);
  glBindRenderbuffer(GL_RENDERBUFFER, depth);
  if (msaa == 4) {
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, 4, GL_DEPTH_COMPONENT24, width, height);
    glGenFramebuffers(1, &msFbo);
    glGenRenderbuffers(1, &msColor);
    glBindFramebuffer(GL_FRAMEBUFFER, msFbo);
    glBindRenderbuffer(GL_RENDERBUFFER, msColor);
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, 4, GL_RGBA8, width, height);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, msColor);
  } else {
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, width, height);
  }
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "incomplete framebuffer\n"); return 1; }

  // Programs.
  Program progs[PIPE_COUNT];
  uint32_t nprogs = toolkit ? TK_PIPE_COUNT : PIPE_COUNT;
  double tPipes = now_s();
  for (uint32_t i = 0; i < nprogs; i++) progs[i] = program_new(shaderDir, toolkit ? TK_PIPES[i] : PIPES[i]);
  glFinish();
  tPipes = now_s() - tPipes;
  const PipeDesc *descs = toolkit ? TK_PIPES : PIPES;

  // Textures; samplers: the scene's repeat with trilinear filtering, the rest clamp.
  GLuint *textures = calloc(pack.textureCount, sizeof *textures);
  GLuint tkTextures[TK_TEXTURES];
  int skyboxTex = pack_texture(&pack, "skybox"), bubbleTex = pack_texture(&pack, "bubble"), rayTex = pack_texture(&pack, "lightray");
  GLuint samplers[2];
  glGenSamplers(2, samplers);
  for (int i = 0; i < 2; i++) {
    GLint wrap = i == 0 ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    glSamplerParameteri(samplers[i], GL_TEXTURE_WRAP_S, wrap);
    glSamplerParameteri(samplers[i], GL_TEXTURE_WRAP_T, wrap);
    glSamplerParameteri(samplers[i], GL_TEXTURE_WRAP_R, wrap);
    glSamplerParameteri(samplers[i], GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
    glSamplerParameteri(samplers[i], GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  }
  if (toolkit) {
    uint8_t *px = malloc(TK_TEXTURE_SIZE * TK_TEXTURE_SIZE * 4);
    for (uint32_t i = 0; i < TK_TEXTURES; i++) {
      toolkit_texture(i, px);
      PackTexture t = {.width = TK_TEXTURE_SIZE, .height = TK_TEXTURE_SIZE, .layers = 1, .mips = 1};
      tkTextures[i] = texture_new(&t, px);
    }
    free(px);
  } else {
    for (uint32_t i = 0; i < pack.textureCount; i++) textures[i] = texture_new(&pack.textures[i], pack.data + pack.textures[i].offset);
  }

  // Geometry: one vertex buffer, one index buffer with each model's indices rebased (GLES 3.0 has no base vertex).
  Sim sim;
  sim_init(&sim, toolkit ? 0 : fishTotal, width, height);
  uint64_t vbytes = sizeof SCENE_RAY_VERTICES, nidx = 6;
  for (uint32_t m = 0; m < pack.modelCount; m++) {
    vbytes += pack.models[m].vertexCount * 56ull;
    nidx += pack.models[m].indexCount;
  }
  uint8_t *vdata = malloc(vbytes);
  uint16_t *idata = malloc(nidx * 2);
  uint32_t *firstIndex = calloc(pack.modelCount + 1, sizeof *firstIndex);
  uint64_t vo = 0, io = 0;
  for (uint32_t m = 0; m <= pack.modelCount; m++) {
    const void *v = m < pack.modelCount ? pack.data + pack.models[m].vertexOffset : (const void *)SCENE_RAY_VERTICES;
    const uint16_t *ix = m < pack.modelCount ? (const uint16_t *)(pack.data + pack.models[m].indexOffset) : SCENE_RAY_INDICES;
    uint32_t nv = m < pack.modelCount ? pack.models[m].vertexCount : 4, ni = m < pack.modelCount ? pack.models[m].indexCount : 6;
    memcpy(vdata + vo, v, nv * 56ull);
    uint32_t base = (uint32_t)(vo / 56);
    for (uint32_t i = 0; i < ni; i++) idata[io + i] = (uint16_t)(ix[i] + base);
    firstIndex[m] = (uint32_t)io;
    vo += nv * 56ull;
    io += ni;
  }
  GLuint vaos[3], vbuf, ibuf, bubbleBuf, quadBuf[FRAMES_IN_FLIGHT] = {0};
  glGenVertexArrays(3, vaos);
  glGenBuffers(1, &vbuf);
  glGenBuffers(1, &ibuf);
  glGenBuffers(1, &bubbleBuf);
  glBindVertexArray(vaos[0]);
  glBindBuffer(GL_ARRAY_BUFFER, vbuf);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)vbytes, vdata, GL_STATIC_DRAW);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibuf);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)(nidx * 2), idata, GL_STATIC_DRAW);
  static const int offs[5] = {0, 3, 6, 8, 11}, comps[5] = {3, 3, 2, 3, 3};
  for (int i = 0; i < 5; i++) {
    glEnableVertexAttribArray((GLuint)i);
    glVertexAttribPointer((GLuint)i, comps[i], GL_FLOAT, GL_FALSE, 56, (void *)(intptr_t)(offs[i] * 4));
  }
  free(vdata);
  free(idata);
  glBindVertexArray(vaos[1]);
  glBindBuffer(GL_ARRAY_BUFFER, bubbleBuf);
  glBufferData(GL_ARRAY_BUFFER, sizeof sim.bubbles, sim.bubbles, GL_STATIC_DRAW);
  for (int i = 0; i < 4; i++) {
    glEnableVertexAttribArray((GLuint)i);
    glVertexAttribPointer((GLuint)i, 4, GL_FLOAT, GL_FALSE, sizeof(SimBubble), (void *)(intptr_t)(i * 16));
    glVertexAttribDivisor((GLuint)i, 1);
  }
  Toolkit tk = {0};
  if (toolkit) {
    toolkit_init(&tk, toolkit, width, height);
    glGenBuffers(FRAMES_IN_FLIGHT, quadBuf);
    for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
      glBindBuffer(GL_ARRAY_BUFFER, quadBuf[i]);
      glBufferData(GL_ARRAY_BUFFER, tk.count * (GLsizeiptr)sizeof(ToolkitQuad), NULL, GL_STREAM_DRAW);
    }
    glBindVertexArray(vaos[2]);
    for (int i = 0; i < 3; i++) {
      glEnableVertexAttribArray((GLuint)i);
      glVertexAttribDivisor((GLuint)i, 1);
    }
  }
  glBindVertexArray(0);

  // Uniform buffers, one set per frame in flight: the frame's and the objects' (each at the alignment's multiple).
  GLint align = 256;
  glGetIntegerv(GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT, &align);
  uint32_t stride = (uint32_t)((sizeof(SimObject) + (size_t)align - 1) / (size_t)align * (size_t)align);
  uint32_t objectSlots = pack.propCount;
  GLuint globalsUbo[FRAMES_IN_FLIGHT], objectUbo[FRAMES_IN_FLIGHT];
  glGenBuffers(FRAMES_IN_FLIGHT, globalsUbo);
  glGenBuffers(FRAMES_IN_FLIGHT, objectUbo);
  for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
    glBindBuffer(GL_UNIFORM_BUFFER, globalsUbo[i]);
    glBufferData(GL_UNIFORM_BUFFER, sizeof(SimGlobals), NULL, GL_STREAM_DRAW);
    glBindBuffer(GL_UNIFORM_BUFFER, objectUbo[i]);
    glBufferData(GL_UNIFORM_BUFFER, (GLsizeiptr)(objectSlots ? objectSlots : 1) * stride, NULL, GL_STREAM_DRAW);
  }
  uint8_t *objectData = calloc(objectSlots ? objectSlots : 1, stride);
  uint32_t maxCmds = scene_max_commands(&pack, &sim);
  if (toolkit && maxCmds < (uint32_t)tk.widgets * 12 + 16) maxCmds = (uint32_t)tk.widgets * 12 + 16;
  SceneCmd *cmds = malloc(maxCmds * sizeof *cmds);
  SimObject *objects = calloc(objectSlots ? objectSlots : 1, sizeof *objects);
  SimFish *fish = calloc(fishTotal > 0 ? (size_t)fishTotal : 1, sizeof *fish);
  ToolkitQuad *quads = toolkit ? malloc(tk.count * sizeof *quads) : NULL;
  GLsync fences[FRAMES_IN_FLIGHT] = {0};

  int total = dumpFrame >= 0 ? dumpFrame + 1 : warmup + samples * frames;
  double wall[MAX_SAMPLES], cpu[MAX_SAMPLES], tSample = 0, cSample = 0;
  uint64_t draws = 0, uploadBytes = 0;
  glViewport(0, 0, width, height);
  glDepthFunc(GL_LESS);
  for (int frame = 0; frame < total; frame++) {
    int slot = frame % FRAMES_IN_FLIGHT;
    if (fences[slot]) {
      glClientWaitSync(fences[slot], GL_SYNC_FLUSH_COMMANDS_BIT, UINT64_MAX);
      glDeleteSync(fences[slot]);
      fences[slot] = 0;
    }
    if (frame >= warmup && dumpFrame < 0 && (frame - warmup) % frames == 0) {
      int k = (frame - warmup) / frames;
      double t = now_s(), c = cpu_s();
      if (k > 0) {
        wall[k - 1] = (t - tSample) * 1000 / frames;
        cpu[k - 1] = (c - cSample) * 1000 / frames;
      }
      tSample = t;
      cSample = c;
    }

    sim_step(&sim);
    // A dump draws only its frame: the frames before it change nothing but the simulation's state.
    if (dumpFrame >= 0 && frame < dumpFrame) continue;
    uint32_t ncmds;
    if (toolkit) {
      ncmds = toolkit_frame(&tk, &sim, cmds, quads);
      glBindBuffer(GL_ARRAY_BUFFER, quadBuf[slot]);
      glBufferSubData(GL_ARRAY_BUFFER, 0, tk.count * (GLsizeiptr)sizeof *quads, quads);
      uploadBytes += tk.count * sizeof *quads;
    } else {
      ncmds = scene_frame(&pack, &sim, cmds, objects, fish);
      for (uint32_t i = 0; i < objectSlots; i++) memcpy(objectData + i * stride, &objects[i], sizeof *objects);
      glBindBuffer(GL_UNIFORM_BUFFER, objectUbo[slot]);
      glBufferSubData(GL_UNIFORM_BUFFER, 0, (GLsizeiptr)objectSlots * stride, objectData);
      uploadBytes += objectSlots * stride;
    }
    glBindBuffer(GL_UNIFORM_BUFFER, globalsUbo[slot]);
    glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof sim.globals, &sim.globals);
    uploadBytes += sizeof sim.globals;
    glBindBufferBase(GL_UNIFORM_BUFFER, 0, globalsUbo[slot]);

    glBindFramebuffer(GL_FRAMEBUFFER, msaa == 4 ? msFbo : fbo);
    glDepthMask(GL_TRUE);
    if (toolkit) glClearColor(0.96f, 0.96f, 0.96f, 1);
    else glClearColor(0, 0.8f, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glActiveTexture(GL_TEXTURE3);
    if (!toolkit) glBindTexture(GL_TEXTURE_CUBE_MAP, textures[skyboxTex]);
    int current = -1, vao = -1;
    for (uint32_t i = 0; i < ncmds; i++) {
      const SceneCmd *c = &cmds[i];
      switch (c->op) {
      case CMD_PIPELINE: {
        const PipeDesc *d = &descs[c->a];
        glUseProgram(progs[c->a].prog);
        current = (int)c->a;
        if (d->blend == BLEND_NONE) glDisable(GL_BLEND);
        else {
          glEnable(GL_BLEND);
          glBlendFunc(GL_SRC_ALPHA, d->blend == BLEND_ADD ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
        }
        if (d->cull) glEnable(GL_CULL_FACE);
        else glDisable(GL_CULL_FACE);
        if (d->input == 2) glDisable(GL_DEPTH_TEST);
        else glEnable(GL_DEPTH_TEST);
        glDepthMask(d->depthWrite ? GL_TRUE : GL_FALSE);
        if (d->input != vao) {
          glBindVertexArray(vaos[d->input]);
          vao = d->input;
        }
        break;
      }
      case CMD_MATERIAL:
        if (toolkit) {
          glActiveTexture(GL_TEXTURE0);
          glBindTexture(GL_TEXTURE_2D, tkTextures[c->a]);
          glBindSampler(0, samplers[1]);
        } else {
          uint32_t tex[3];
          GLuint sampler = samplers[0];
          if (c->a < pack.modelCount) {
            const PackModel *pm = &pack.models[c->a];
            tex[0] = pm->diffuse;
            tex[1] = pm->normalMap != PACK_NONE ? pm->normalMap : pm->diffuse;
            tex[2] = pm->reflectionMap != PACK_NONE ? pm->reflectionMap : pm->diffuse;
          } else {
            tex[0] = tex[1] = tex[2] = (uint32_t)(c->a == MAT_BUBBLE(&pack) ? bubbleTex : rayTex);
            sampler = samplers[1];
          }
          for (int k = 0; k < 3; k++) {
            glActiveTexture(GL_TEXTURE0 + (GLenum)k);
            glBindTexture(GL_TEXTURE_2D, textures[tex[k]]);
            glBindSampler((GLuint)k, sampler);
          }
          glBindSampler(3, samplers[1]);
        }
        break;
      case CMD_DRAW_OBJECT:
        glBindBufferRange(GL_UNIFORM_BUFFER, 1, objectUbo[slot], (GLintptr)c->b * stride, sizeof(SimObject));
        glDrawElements(GL_TRIANGLES, (GLsizei)pack.models[c->a].indexCount, GL_UNSIGNED_SHORT, (void *)(uintptr_t)(firstIndex[c->a] * 2));
        draws++;
        break;
      case CMD_DRAW_FISH: {
        float rec[12];
        memcpy(rec, &fish[c->b], sizeof(SimFish));
        memcpy(rec + 8, &sim.species[c->c], sizeof(SimSpecies));
        glUniform4fv(progs[current].fish, 3, rec);
        glDrawElements(GL_TRIANGLES, (GLsizei)pack.models[c->a].indexCount, GL_UNSIGNED_SHORT, (void *)(uintptr_t)(firstIndex[c->a] * 2));
        draws++;
        break;
      }
      case CMD_DRAW_BUBBLES:
        glUniform4fv(progs[current].setWorld, 1, sim.bubbleSets[c->a].world);
        glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, SIM_BUBBLES);
        draws++;
        break;
      case CMD_DRAW_RAY:
        glUniformMatrix4fv(progs[current].rayWorld, 1, GL_FALSE, sim.lightRays[c->a].world);
        glUniform4fv(progs[current].rayColor, 1, sim.lightRays[c->a].colorMult);
        glDrawElements(GL_TRIANGLES, 6, GL_UNSIGNED_SHORT, (void *)(uintptr_t)(firstIndex[pack.modelCount] * 2));
        draws++;
        break;
      case CMD_TK_DRAW:
        // GLES 3.0 has no base instance: the batch's instances are pointed at.
        glBindBuffer(GL_ARRAY_BUFFER, quadBuf[slot]);
        for (int k = 0; k < 3; k++)
          glVertexAttribPointer((GLuint)k, 4, GL_FLOAT, GL_FALSE, sizeof(ToolkitQuad), (void *)(uintptr_t)(c->a * sizeof(ToolkitQuad) + k * 16));
        glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, (GLsizei)c->b);
        draws++;
        break;
      }
    }
    if (msaa == 4) {
      glBindFramebuffer(GL_READ_FRAMEBUFFER, msFbo);
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
      glBlitFramebuffer(0, 0, width, height, 0, 0, width, height, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
    // The depth (and the multisampled colour) needn't survive the frame.
    GLenum discard[2] = {GL_DEPTH_ATTACHMENT, GL_COLOR_ATTACHMENT0};
    glBindFramebuffer(GL_FRAMEBUFFER, msaa == 4 ? msFbo : fbo);
    glInvalidateFramebuffer(GL_FRAMEBUFFER, msaa == 4 ? 2 : 1, discard);
    fences[slot] = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    glFlush();
  }
  glFinish();
  if (dumpFrame < 0) {
    wall[samples - 1] = (now_s() - tSample) * 1000 / frames;
    cpu[samples - 1] = (cpu_s() - cSample) * 1000 / frames;
  }

  if (dumpPath) {  // GL's rows come bottom first: written top first, as vk.c's
    uint8_t *px = malloc((size_t)width * height * 4);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, px);
    uint8_t *top = malloc((size_t)width * height * 4);
    for (int y = 0; y < height; y++) memcpy(top + (size_t)y * width * 4, px + (size_t)(height - 1 - y) * width * 4, (size_t)width * 4);
    dump_frame(dumpPath, top, width, height, thumbW, thumbH);
    fprintf(stderr, "frame %d -> %s\n", dumpFrame, dumpPath);
  } else {
    double wm, wi, cm, ci;
    stats(wall, samples, &wm, &wi);
    stats(cpu, samples, &cm, &ci);
    int measured = total;
    fprintf(stderr, "%s %s: %.3f ms a frame (IQR %.3f), CPU %.3f ms, %.0f draws a frame\n", label, toolkit ? "toolkit" : "aquarium",
            wm, wi, cm, (double)draws / measured);
    if (jsonPath) {
      FILE *f = fopen(jsonPath, "w");
      fprintf(f, "{\"arm\": \"gles\", \"label\": \"%s\", \"renderer\": \"%s\", \"version\": \"%s\", ", label, renderer, version);
      fprintf(f, "\"scene\": \"%s\", \"fish\": %d, \"quads\": %d, \"width\": %d, \"height\": %d, \"msaa\": %d, ",
              toolkit ? "toolkit" : "aquarium", toolkit ? 0 : fishTotal, toolkit, width, height, msaa);
      fprintf(f, "\"warmup\": %d, \"frames\": %d, \"pipelineMs\": %.3f, ", warmup, frames, tPipes * 1000);
      fprintf(f, "\"drawsPerFrame\": %.1f, \"uploadBytesPerFrame\": %.0f, ", (double)draws / measured, (double)uploadBytes / measured);
      fprintf(f, "\"frameMs\": {\"median\": %.4f, \"iqr\": %.4f}, \"cpuMs\": {\"median\": %.4f, \"iqr\": %.4f}, ", wm, wi, cm, ci);
      json_array(f, "frameSamples", wall, samples);
      fprintf(f, ", ");
      json_array(f, "cpuSamples", cpu, samples);
      fprintf(f, "}\n");
      fclose(f);
    }
  }
  return 0;
}
