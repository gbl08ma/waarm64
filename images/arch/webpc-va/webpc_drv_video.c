// webpc's VA-API driver for the desktop guest (docs/plans/video.md §1): Mesa's virgl driver (virtio_gpu_drv_video.so)
// with only the surface formats real decoders offer. Mesa's virgl lists every 4:2:0 format whose planes it can sample
// and render (NV12, YV12, I420), FFmpeg's VA-API decoder then picks I420 for H.264 and VP9 (the codecs' own software
// format), and Firefox's VA-API path takes NV12, YV12, P010 and P016 only, so it falls back to software. This driver
// loads Mesa's, and drops I420 and YV12 from what vaQuerySurfaceAttributes says: decoders then use NV12. Selected with
// LIBVA_DRIVER_NAME=webpc (the package sets it for every session).
//
// And AV1 with film grain decoded into the surface that's shown. A decoder applying grain decodes into a reference
// surface (VA's current_frame) and shows another (current_display_picture), and Mesa's VA frontend sends the frame to
// the host before it sets the film grain target (at vaEndPicture), so the host never learns where the grained
// picture goes (docs/plans/video.md §10). Here such a frame's decode target is its display surface, and the reference
// map names display surfaces too (a decoder keeps a frame's display surface while the frame is a reference): the
// host, which keeps the references itself, writes the grained picture where it's shown.
//
// And exported surfaces' sizes (VK2 L6: mpv on Vulkan). Mesa's virgl driver says an exported object's size is its
// dma-buf's, and a decoder's surfaces are host-only resources whose dma-bufs are a page whatever the planes hold; a
// Vulkan importer checks the image fits (libplacebo: "Imported object requires N bytes, larger than the provided size
// 4096") and fails every surface. Here an object's size is at least what its planes span (offset + pitch × rows); the
// host's Venus renderer imports the resource by its id and gives it that many bytes (web/venus-import.ts).
#define _GNU_SOURCE
#include <libdrm/drm_fourcc.h>
#include <stdint.h>
#include <va/va_drmcommon.h>
#include <dlfcn.h>
#include <stdio.h>
#include <va/va.h>
#include <va/va_backend.h>
#include <va/va_dec_av1.h>
#include <stdlib.h>

#ifndef MESA_DRIVER
#define MESA_DRIVER "/usr/lib/dri/virtio_gpu_drv_video.so"
#endif

static VAStatus (*mesa_query)(VADriverContextP, VAConfigID, VASurfaceAttrib *, unsigned int *);

static VAStatus query_surface_attributes(VADriverContextP ctx, VAConfigID config, VASurfaceAttrib *attribs,
                                         unsigned int *n) {
  VAStatus s = mesa_query(ctx, config, attribs, n);
  if (s != VA_STATUS_SUCCESS || !attribs) return s; // without a list the count is an upper bound, which is allowed
  unsigned int k = 0;
  for (unsigned int i = 0; i < *n; i++) {
    if (attribs[i].type == VASurfaceAttribPixelFormat) {
      int f = attribs[i].value.value.i;
      if (f == VA_FOURCC_I420 || f == VA_FOURCC_IYUV || f == VA_FOURCC_YV12) continue;
    }
    attribs[k++] = attribs[i];
  }
  *n = k;
  return s;
}

/** The AV1 decode configs and contexts, and per context: a picture begun (its target, until its parameters come)
 * and the reference surfaces that stand for display surfaces. */
#define MAX_AV1 64
#define MAX_MAP 64
static VAConfigID av1_configs[MAX_AV1];
static int n_av1_configs;
struct av1_context {
  VAContextID id;
  int pending;
  VASurfaceID target;
  struct { VASurfaceID ref, shown; } map[MAX_MAP];
  int n;
};
static struct av1_context *av1_contexts[MAX_AV1];

static VAStatus (*mesa_create_config)(VADriverContextP, VAProfile, VAEntrypoint, VAConfigAttrib *, int, VAConfigID *);
static VAStatus (*mesa_create_context)(VADriverContextP, VAConfigID, int, int, int, VASurfaceID *, int, VAContextID *);
static VAStatus (*mesa_destroy_context)(VADriverContextP, VAContextID);
static VAStatus (*mesa_begin)(VADriverContextP, VAContextID, VASurfaceID);
static VAStatus (*mesa_render)(VADriverContextP, VAContextID, VABufferID *, int);
static VAStatus (*mesa_end)(VADriverContextP, VAContextID);

static struct av1_context *av1_context(VAContextID id) {
  for (int k = 0; k < MAX_AV1; k++)
    if (av1_contexts[k] && av1_contexts[k]->id == id) return av1_contexts[k];
  return NULL;
}

static VAStatus create_config(VADriverContextP ctx, VAProfile profile, VAEntrypoint entrypoint, VAConfigAttrib *attribs,
                              int n, VAConfigID *config) {
  VAStatus s = mesa_create_config(ctx, profile, entrypoint, attribs, n, config);
  if (s == VA_STATUS_SUCCESS && entrypoint == VAEntrypointVLD && (profile == VAProfileAV1Profile0 || profile == VAProfileAV1Profile1))
    av1_configs[n_av1_configs++ % MAX_AV1] = *config;
  return s;
}

static VAStatus create_context(VADriverContextP ctx, VAConfigID config, int w, int h, int flag, VASurfaceID *targets,
                               int n, VAContextID *context) {
  VAStatus s = mesa_create_context(ctx, config, w, h, flag, targets, n, context);
  if (s != VA_STATUS_SUCCESS) return s;
  for (int k = 0; k < MAX_AV1 && k < n_av1_configs; k++) {
    if (av1_configs[k] != config) continue;
    for (int j = 0; j < MAX_AV1; j++) {
      if (av1_contexts[j]) continue;
      av1_contexts[j] = calloc(1, sizeof *av1_contexts[j]);
      if (av1_contexts[j]) av1_contexts[j]->id = *context;
      break;
    }
    break;
  }
  return s;
}

static VAStatus destroy_context(VADriverContextP ctx, VAContextID context) {
  for (int k = 0; k < MAX_AV1; k++) {
    if (av1_contexts[k] && av1_contexts[k]->id == context) {
      free(av1_contexts[k]);
      av1_contexts[k] = NULL;
    }
  }
  return mesa_destroy_context(ctx, context);
}

/** An AV1 picture begins once its parameters say where it goes. */
static VAStatus begin_picture(VADriverContextP ctx, VAContextID context, VASurfaceID target) {
  struct av1_context *c = av1_context(context);
  if (!c) return mesa_begin(ctx, context, target);
  c->pending = 1;
  c->target = target;
  return VA_STATUS_SUCCESS;
}

static VASurfaceID shown(struct av1_context *c, VASurfaceID s) {
  for (int k = 0; k < c->n; k++)
    if (c->map[k].ref == s) return c->map[k].shown;
  return s;
}

static VAStatus render_picture(VADriverContextP ctx, VAContextID context, VABufferID *buffers, int n) {
  struct av1_context *c = av1_context(context);
  if (!c || !c->pending) return mesa_render(ctx, context, buffers, n);
  for (int k = 0; k < n; k++) {
    VABufferType type;
    unsigned int size, count;
    void *data;
    if (ctx->vtable->vaBufferInfo(ctx, buffers[k], &type, &size, &count) != VA_STATUS_SUCCESS || type != VAPictureParameterBufferType ||
        size < sizeof(VADecPictureParameterBufferAV1) || ctx->vtable->vaMapBuffer(ctx, buffers[k], &data) != VA_STATUS_SUCCESS)
      continue;
    VADecPictureParameterBufferAV1 *p = data;
    for (int r = 0; r < 8; r++) p->ref_frame_map[r] = shown(c, p->ref_frame_map[r]);
    if (p->film_grain_info.film_grain_info_fields.bits.apply_grain && p->current_display_picture != VA_INVALID_SURFACE &&
        p->current_display_picture != p->current_frame) {
      int j = 0;
      while (j < c->n && c->map[j].ref != p->current_frame) j++;
      if (j == c->n && c->n < MAX_MAP) c->n++;
      if (j < MAX_MAP) c->map[j].ref = p->current_frame, c->map[j].shown = p->current_display_picture;
      if (c->target == p->current_frame) c->target = p->current_display_picture;
      p->current_frame = p->current_display_picture;
    } else {
      // The surface is a reference of its own again: what it stood for is gone.
      for (int j = 0; j < c->n; j++)
        if (c->map[j].ref == c->target) c->map[j] = c->map[--c->n];
    }
    ctx->vtable->vaUnmapBuffer(ctx, buffers[k]);
  }
  c->pending = 0;
  VAStatus s = mesa_begin(ctx, context, c->target);
  return s == VA_STATUS_SUCCESS ? mesa_render(ctx, context, buffers, n) : s;
}

static VAStatus end_picture(VADriverContextP ctx, VAContextID context) {
  struct av1_context *c = av1_context(context);
  if (c && c->pending) {
    c->pending = 0;
    VAStatus s = mesa_begin(ctx, context, c->target);
    if (s != VA_STATUS_SUCCESS) return s;
  }
  return mesa_end(ctx, context);
}

static VAStatus (*mesa_export)(VADriverContextP, VASurfaceID, uint32_t, uint32_t, void *);

/** Rows a plane of a layer has: the surface's, or half for 4:2:0's chroma (a second plane, or a 2-component layer). */
static uint32_t plane_rows(uint32_t height, uint32_t fourcc, uint32_t plane) {
  int half = plane > 0 ? (fourcc == DRM_FORMAT_NV12 || fourcc == DRM_FORMAT_P010 || fourcc == DRM_FORMAT_P016 ||
                          fourcc == DRM_FORMAT_YUV420 || fourcc == DRM_FORMAT_YVU420)
                       : (fourcc == DRM_FORMAT_GR88 || fourcc == DRM_FORMAT_RG88 || fourcc == DRM_FORMAT_GR1616 ||
                          fourcc == DRM_FORMAT_RG1616);
  return half ? (height + 1) / 2 : height;
}

static VAStatus export_surface(VADriverContextP ctx, VASurfaceID surface, uint32_t mem_type, uint32_t flags, void *out) {
  VAStatus s = mesa_export(ctx, surface, mem_type, flags, out);
  if (s != VA_STATUS_SUCCESS || mem_type != VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2) return s;
  VADRMPRIMESurfaceDescriptor *d = out;
  // A separate layer's chroma (GR88) is half the surface's height; so is a composed layer's second plane.
  for (uint32_t l = 0; l < d->num_layers && l < 4; l++) {
    int chroma = (flags & VA_EXPORT_SURFACE_SEPARATE_LAYERS) && l > 0;
    for (uint32_t p = 0; p < d->layers[l].num_planes && p < 4; p++) {
      uint32_t o = d->layers[l].object_index[p];
      if (o >= d->num_objects || o >= 4) continue;
      uint32_t rows = chroma ? (d->height + 1) / 2 : plane_rows(d->height, d->layers[l].drm_format, p);
      uint64_t end = (uint64_t)d->layers[l].offset[p] + (uint64_t)d->layers[l].pitch[p] * rows;
      if (end > d->objects[o].size && end < (1ull << 32)) d->objects[o].size = (uint32_t)end;
    }
  }
  return s;
}

#define INIT_NAME(major, minor) __vaDriverInit_##major##_##minor
#define INIT(major, minor) INIT_NAME(major, minor)

VAStatus INIT(VA_MAJOR_VERSION, VA_MINOR_VERSION)(VADriverContextP ctx) {
  void *mesa = dlopen(MESA_DRIVER, RTLD_NOW | RTLD_LOCAL);
  if (!mesa) {
    fprintf(stderr, "webpc_drv_video: %s\n", dlerror());
    return VA_STATUS_ERROR_UNKNOWN;
  }
  // Mesa exports the entry point of the libva it was built against: the newest minor version it has.
  VAStatus (*init)(VADriverContextP) = NULL;
  char name[48];
  for (int minor = VA_MINOR_VERSION + 16; minor >= 0 && !init; minor--) {
    snprintf(name, sizeof name, "__vaDriverInit_%d_%d", VA_MAJOR_VERSION, minor);
    init = (VAStatus (*)(VADriverContextP))dlsym(mesa, name);
  }
  if (!init) {
    fprintf(stderr, "webpc_drv_video: no __vaDriverInit_%d_* in %s\n", VA_MAJOR_VERSION, MESA_DRIVER);
    return VA_STATUS_ERROR_UNKNOWN;
  }
  VAStatus s = init(ctx);
  if (s != VA_STATUS_SUCCESS) return s;
  struct VADriverVTable *v = ctx->vtable;
  if (v->vaQuerySurfaceAttributes) {
    mesa_query = v->vaQuerySurfaceAttributes;
    v->vaQuerySurfaceAttributes = query_surface_attributes;
  }
  mesa_create_config = v->vaCreateConfig, v->vaCreateConfig = create_config;
  mesa_create_context = v->vaCreateContext, v->vaCreateContext = create_context;
  mesa_destroy_context = v->vaDestroyContext, v->vaDestroyContext = destroy_context;
  mesa_begin = v->vaBeginPicture, v->vaBeginPicture = begin_picture;
  mesa_render = v->vaRenderPicture, v->vaRenderPicture = render_picture;
  mesa_end = v->vaEndPicture, v->vaEndPicture = end_picture;
  if (v->vaExportSurfaceHandle) mesa_export = v->vaExportSurfaceHandle, v->vaExportSurfaceHandle = export_surface;
  return s;
}
