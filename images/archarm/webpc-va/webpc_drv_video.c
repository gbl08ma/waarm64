// webpc's VA-API driver for the desktop guest (docs/plans/video.md §1): Mesa's virgl driver (virtio_gpu_drv_video.so)
// with only the surface formats real decoders offer. Mesa's virgl lists every 4:2:0 format whose planes it can sample
// and render (NV12, YV12, I420), FFmpeg's VA-API decoder then picks I420 for H.264 and VP9 (the codecs' own software
// format), and Firefox's VA-API path takes NV12, YV12, P010 and P016 only, so it falls back to software. This driver
// loads Mesa's, and drops I420 and YV12 from what vaQuerySurfaceAttributes says: decoders then use NV12. Selected with
// LIBVA_DRIVER_NAME=webpc (the package sets it for every session).
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <va/va.h>
#include <va/va_backend.h>

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
  if (s == VA_STATUS_SUCCESS && ctx->vtable->vaQuerySurfaceAttributes) {
    mesa_query = ctx->vtable->vaQuerySurfaceAttributes;
    ctx->vtable->vaQuerySurfaceAttributes = query_surface_attributes;
  }
  return s;
}
