/*
 * Shaders and pipelines on the runtime's vk_shader path (wg_private.h): vk_pipeline.c turns pipelines into shaders
 * and dynamic state, and calls `compile` with a pipeline's stages together; we translate them (vk/compiler/: lowered
 * against the pipeline's set layouts, a vertex and fragment shader linked, the fragment shader printed first so the
 * vertex shader's outputs follow its inputs), make their WebGPU modules and what the stages share (wg_program: bind
 * group layouts, a pipeline layout). A render pipeline bakes in what Vulkan 1.3 leaves dynamic, so it is made at the
 * first draw that needs it (wg_render_pipeline) and kept by that state. KosmicKrisp's kk_shader.c is the model (MIT).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "nir.h"
#include "spirv/nir_spirv.h"
#include "util/hash_table.h"
#include "util/ralloc.h"
#include "vk_format.h"
#include "vk_pipeline.h"

#include "wg_private.h"

static const struct nir_shader_compiler_options *
wg_get_nir_options(struct vk_physical_device *pdev, mesa_shader_stage stage,
                   const struct vk_pipeline_robustness_state *rs)
{
   return wgsl_nir_options();
}

static struct spirv_to_nir_options
wg_get_spirv_options(struct vk_physical_device *pdev, mesa_shader_stage stage,
                     const struct vk_pipeline_robustness_state *rs)
{
   struct spirv_to_nir_options o;
   wgsl_spirv_options(&o);
   return o;
}

static void
wg_preprocess_nir(struct vk_physical_device *pdev, nir_shader *nir, const struct vk_pipeline_robustness_state *rs)
{
   wgsl_preprocess(nir);
}

static void
wg_hash_state(struct vk_physical_device *pdev, const struct vk_graphics_pipeline_state *state,
              const struct vk_features *features, VkShaderStageFlags stages, blake3_hash out)
{
   /* Nothing of the state reaches the WGSL: render pipelines take it at draw time. */
   memset(out, 0, sizeof(blake3_hash));
}

/* Programs. */

static void
program_free_pipelines(struct wg_program *p)
{
   if (!p->pipelines)
      return;
   hash_table_foreach (p->pipelines, e) {
      wg_id_release((uint32_t)(uintptr_t)e->data);
      free((void *)e->key);
   }
   _mesa_hash_table_destroy(p->pipelines, NULL);
}

void
wg_program_unref(struct wg_program *p)
{
   if (!p || --p->refs)
      return;
   program_free_pipelines(p);
   for (uint32_t i = 0; i < WGSL_MAX_SETS; i++)
      wg_id_release(p->bgl[i]);
   wg_id_release(p->layout);
   wg_id_release(p->compute);
   free(p);
}

static const char *const dims[] = { "1d", "2d", "2d-array", "cube", "cube-array", "3d" };
static const char *const samples[] = { "float", "unfilterable-float", "depth", "sint", "uint" };

static int
resource_cmp(const void *a, const void *b)
{
   const struct wgsl_resource *x = a, *y = b;
   return x->group != y->group ? x->group - y->group : x->binding - y->binding;
}

/* The program of `count` translated stages (visibility by stage) on a pipeline's set layouts. */
static struct wg_program *
program_create(struct wg_shader **shaders, uint32_t count, struct vk_descriptor_set_layout *const *layouts,
               uint32_t layout_count)
{
   struct wg_program *p = calloc(1, sizeof(*p));
   p->refs = 1;
   uint8_t vis[WGSL_MAX_RESOURCES] = { 0 };
   for (uint32_t s = 0; s < count; s++) {
      const struct wgsl_info *info = &shaders[s]->info;
      const uint8_t stage = shaders[s]->vk.stage == MESA_SHADER_VERTEX ? 1
                            : shaders[s]->vk.stage == MESA_SHADER_FRAGMENT ? 2
                                                                            : 4;
      p->immediate_size = MAX2(p->immediate_size, info->immediate_size);
      for (uint32_t i = 0; i < info->resource_count; i++) {
         const struct wgsl_resource *r = &info->resources[i];
         uint32_t k = 0;
         while (k < p->resource_count && (p->resources[k].group != r->group || p->resources[k].binding != r->binding))
            k++;
         if (k == p->resource_count) {
            p->resources[p->resource_count++] = *r;
         } else {
            struct wgsl_resource *m = &p->resources[k];
            if (r->kind == WGSL_STORAGE)
               m->kind = WGSL_STORAGE;
            if (r->kind == WGSL_STORAGE_TEXTURE)
               m->access |= r->access;
            m->size = MAX2(m->size, r->size);
         }
         vis[k] |= stage;
         p->group_count = MAX2(p->group_count, r->group + 1u);
      }
   }
   /* Visibility travels with its resource through the sort. */
   struct { struct wgsl_resource r; uint8_t vis; } sorted[WGSL_MAX_RESOURCES];
   for (uint32_t i = 0; i < p->resource_count; i++)
      sorted[i].r = p->resources[i], sorted[i].vis = vis[i];
   qsort(sorted, p->resource_count, sizeof(sorted[0]), resource_cmp);
   for (uint32_t i = 0; i < p->resource_count; i++) {
      p->resources[i] = sorted[i].r;
      vis[i] = sorted[i].vis;
      const struct wgsl_resource *r = &p->resources[i];
      const struct wg_descriptor_set_layout *l =
         r->group < layout_count && layouts[r->group]
            ? container_of(layouts[r->group], struct wg_descriptor_set_layout, vk)
            : NULL;
      const uint32_t slot = r->binding / 2;
      p->dynamic[i] = l && slot < l->slot_count && (r->kind == WGSL_UNIFORM || r->kind == WGSL_STORAGE ||
                                                     r->kind == WGSL_STORAGE_READ)
                         ? l->dynamic[slot]
                         : -1;
   }

   struct wg_json j = { 0 };
   uint32_t k = 0;
   for (uint32_t g = 0; g < p->group_count; g++) {
      wg_json_printf(&j, "{\"entries\":[");
      for (bool first = true; k < p->resource_count && p->resources[k].group == g; k++, first = false) {
         const struct wgsl_resource *r = &p->resources[k];
         wg_json_printf(&j, "%s{\"binding\":%u,\"visibility\":%u,", first ? "" : ",", r->binding, vis[k]);
         switch (r->kind) {
         case WGSL_UNIFORM:
         case WGSL_STORAGE:
         case WGSL_STORAGE_READ:
            wg_json_printf(&j, "\"buffer\":{\"type\":\"%s\",\"hasDynamicOffset\":%s}}",
                           r->kind == WGSL_UNIFORM ? "uniform" : r->kind == WGSL_STORAGE ? "storage" : "read-only-storage",
                           p->dynamic[k] >= 0 ? "true" : "false");
            break;
         case WGSL_SAMPLER:
         case WGSL_SAMPLER_COMPARE:
            wg_json_printf(&j, "\"sampler\":{\"type\":\"%s\"}}", r->kind == WGSL_SAMPLER ? "filtering" : "comparison");
            break;
         case WGSL_TEXTURE: {
            const char *sample = samples[MIN2(r->sample, 4)];
            if (r->multisampled && r->sample == WGSL_SAMPLE_FLOAT)
               sample = "unfilterable-float";
            wg_json_printf(&j, "\"texture\":{\"sampleType\":\"%s\",\"viewDimension\":\"%s\",\"multisampled\":%s}}", sample,
                           dims[MIN2(r->dim, 5)], r->multisampled ? "true" : "false");
            break;
         }
         case WGSL_STORAGE_TEXTURE: {
            const struct wg_texture_format *f =
               wg_texture_format(vk_format_from_pipe_format((enum pipe_format)r->format));
            const char *access = r->access == WGSL_ACCESS_READ    ? "read-only"
                                 : r->access == WGSL_ACCESS_WRITE ? "write-only"
                                                                  : "read-write";
            wg_json_printf(&j, "\"storageTexture\":{\"access\":\"%s\",\"format\":\"%s\",\"viewDimension\":\"%s\"}}",
                           r->access ? access : "read-only", f ? f->name : "rgba8unorm",
                           r->dim == WGSL_DIM_CUBE || r->dim == WGSL_DIM_CUBE_ARRAY ? "2d-array" : dims[MIN2(r->dim, 5)]);
            break;
         }
         }
      }
      wg_json_printf(&j, "]}");
      p->bgl[g] = wg_create_json(WG_KIND_BGL, &j);
   }
   wg_json_printf(&j, "{\"bindGroupLayouts\":[");
   for (uint32_t g = 0; g < p->group_count; g++)
      wg_json_printf(&j, "%s%u", g ? "," : "", p->bgl[g]);
   wg_json_printf(&j, "],\"immediateSize\":%u}", p->immediate_size);
   p->layout = wg_create_json(WG_KIND_LAYOUT, &j);
   return p;
}

/* Compiling. */

static const struct vk_shader_ops wg_shader_ops;

static void
shader_destroy(struct vk_device *dev, struct vk_shader *vk, const VkAllocationCallbacks *pAllocator)
{
   struct wg_shader *s = container_of(vk, struct wg_shader, vk);
   wg_id_release(s->module);
   wg_program_unref(s->program);
   free(s->wgsl);
   vk_shader_free(dev, pAllocator, &s->vk);
}

/* A set layout as the compiler sees it. */
static void
layout_of(struct wgsl_layout *out, struct vk_descriptor_set_layout *const *layouts, uint32_t count,
          uint32_t push_size)
{
   *out = (struct wgsl_layout){ .set_count = MIN2(count, WGSL_MAX_SETS), .push_size = push_size };
   for (uint32_t s = 0; s < out->set_count; s++) {
      if (!layouts[s])
         continue;
      const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
      out->sets[s] = (struct wgsl_set_layout){ .binding_count = l->binding_count, .first = l->first, .count = l->count };
   }
}

static VkResult
wg_compile(struct vk_device *device, uint32_t count, struct vk_shader_compile_info *infos,
           const struct vk_graphics_pipeline_state *state, const struct vk_features *features,
           const VkAllocationCallbacks *pAllocator, struct vk_shader **out)
{
   char error[512] = "";
   struct wg_shader *shaders[MESA_SHADER_STAGES] = { 0 };
   nir_shader *vs = NULL, *fs = NULL;
   bool ok = true;
   for (uint32_t i = 0; i < count && ok; i++) {
      struct wgsl_layout layout;
      uint32_t push = 0;
      for (uint32_t r = 0; r < infos[i].push_constant_range_count; r++)
         push = MAX2(push, infos[i].push_constant_ranges[r].offset + infos[i].push_constant_ranges[r].size);
      layout_of(&layout, infos[i].set_layouts, infos[i].set_layout_count, push);
      if (!wgsl_lower(infos[i].nir, &layout, error, sizeof(error))) {
         ok = false;
         break;
      }
      if (infos[i].stage == MESA_SHADER_VERTEX)
         vs = infos[i].nir;
      else if (infos[i].stage == MESA_SHADER_FRAGMENT)
         fs = infos[i].nir;
      else if (infos[i].stage != MESA_SHADER_COMPUTE) {
         snprintf(error, sizeof(error), "a %s shader", mesa_shader_stage_name(infos[i].stage));
         ok = false;
      }
   }
   if (ok && vs && fs)
      wgsl_link(vs, fs);

   /* Fragment shaders first: a vertex shader's outputs are typed by what its fragment shader reads. */
   const struct wgsl_varyings *fs_reads = NULL;
   for (uint32_t pass = 0; pass < 2 && ok; pass++) {
      for (uint32_t i = 0; i < count && ok; i++) {
         const bool frag = infos[i].stage == MESA_SHADER_FRAGMENT;
         if (frag != (pass == 0))
            continue;
         struct wg_shader *s = vk_shader_zalloc(device, &wg_shader_ops, infos[i].stage, pAllocator, sizeof(*s));
         if (!s) {
            ok = false;
            break;
         }
         shaders[i] = s;
         char *text = wgsl_print(NULL, infos[i].nir, infos[i].stage == MESA_SHADER_VERTEX ? fs_reads : NULL, &s->info,
                                 error, sizeof(error));
         if (!text) {
            ok = false;
            break;
         }
         s->wgsl = strdup(text);
         ralloc_free(text);
         s->module = wg_id();
         gpu_shader(s->module, s->wgsl, strlen(s->wgsl));
         if (frag)
            fs_reads = &s->info.varyings;
      }
   }
   for (uint32_t i = 0; i < count; i++)
      ralloc_free(infos[i].nir);
   if (!ok) {
      fprintf(stderr, "wg: a shader didn't translate: %s\n", error);
      for (uint32_t i = 0; i < count; i++)
         if (shaders[i])
            shader_destroy(device, &shaders[i]->vk, pAllocator);
      memset(out, 0, count * sizeof(*out));
      return vk_error(device, VK_ERROR_UNKNOWN);
   }

   struct wg_program *p = program_create(shaders, count, infos[0].set_layouts, infos[0].set_layout_count);
   for (uint32_t i = 0; i < count; i++) {
      shaders[i]->program = p;
      if (i)
         p->refs++;
      out[i] = &shaders[i]->vk;
   }
   if (infos[0].stage == MESA_SHADER_COMPUTE) {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"layout\":%u,\"compute\":{\"module\":%u,\"entryPoint\":\"main\"}}", p->layout,
                     shaders[0]->module);
      p->compute = wg_create_json(WG_KIND_COMPUTE, &j);
   }
   return VK_SUCCESS;
}

/* Not cached across runs yet: the runtime's in-memory cache keeps the shaders themselves. */
static bool
wg_serialize(struct vk_device *device, const struct vk_shader *shader, struct blob *blob)
{
   return false;
}

static VkResult
wg_deserialize(struct vk_device *device, struct blob_reader *blob, uint32_t version,
               const VkAllocationCallbacks *pAllocator, struct vk_shader **out)
{
   return vk_error(device, VK_ERROR_INCOMPATIBLE_SHADER_BINARY_EXT);
}

static VkResult
wg_executable_properties(struct vk_device *device, const struct vk_shader *shader, uint32_t *count,
                         VkPipelineExecutablePropertiesKHR *props)
{
   *count = 0;
   return VK_SUCCESS;
}

static VkResult
wg_executable_statistics(struct vk_device *device, const struct vk_shader *shader, uint32_t index, uint32_t *count,
                         VkPipelineExecutableStatisticKHR *stats)
{
   *count = 0;
   return VK_SUCCESS;
}

static VkResult
wg_executable_irs(struct vk_device *device, const struct vk_shader *shader, uint32_t index, uint32_t *count,
                  VkPipelineExecutableInternalRepresentationKHR *irs)
{
   *count = 0;
   return VK_SUCCESS;
}

static const struct vk_shader_ops wg_shader_ops = {
   .destroy = shader_destroy,
   .serialize = wg_serialize,
   .get_executable_properties = wg_executable_properties,
   .get_executable_statistics = wg_executable_statistics,
   .get_executable_internal_representations = wg_executable_irs,
};


const struct vk_device_shader_ops wg_device_shader_ops = {
   .get_nir_options = wg_get_nir_options,
   .get_spirv_options = wg_get_spirv_options,
   .preprocess_nir = wg_preprocess_nir,
   .hash_state = wg_hash_state,
   .compile = wg_compile,
   .deserialize = wg_deserialize,
   .cmd_set_dynamic_graphics_state = vk_cmd_set_dynamic_graphics_state,
   .cmd_bind_shaders = wg_cmd_bind_shaders,
};

/* Render pipelines. */

static uint32_t
key_hash(const void *key)
{
   return _mesa_hash_data(key, sizeof(struct wg_pipeline_key));
}

static bool
key_equal(const void *a, const void *b)
{
   return !memcmp(a, b, sizeof(struct wg_pipeline_key));
}

static const char *const topologies[] = { "point-list", "line-list", "line-strip", "triangle-list",
                                          "triangle-strip", "triangle-list" };
static const char *const compares[] = { "never", "less", "equal", "less-equal", "greater", "not-equal",
                                        "greater-equal", "always" };
static const char *const stencil_ops[] = { "keep", "zero", "replace", "increment-clamp", "decrement-clamp",
                                           "invert", "increment-wrap", "decrement-wrap" };
static const char *const factors[] = { "zero", "one", "src", "one-minus-src", "dst", "one-minus-dst", "src-alpha",
                                       "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "constant",
                                       "one-minus-constant", "constant", "one-minus-constant", "src-alpha-saturated",
                                       "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha" };
static const char *const blend_ops[] = { "add", "subtract", "reverse-subtract", "min", "max" };

static void
stencil_face(struct wg_json *j, const char *name, const uint8_t *f, bool on)
{
   wg_json_printf(j, "\"%s\":{\"failOp\":\"%s\",\"passOp\":\"%s\",\"depthFailOp\":\"%s\",\"compare\":\"%s\"}", name,
                  on ? stencil_ops[f[0] & 7] : "keep", on ? stencil_ops[f[1] & 7] : "keep",
                  on ? stencil_ops[f[2] & 7] : "keep", on ? compares[f[3] & 7] : "always");
}

uint32_t
wg_render_pipeline(struct wg_program *p, const struct wg_pipeline_key *k)
{
   if (!p->pipelines)
      p->pipelines = _mesa_hash_table_create(NULL, key_hash, key_equal);
   struct hash_entry *e = _mesa_hash_table_search(p->pipelines, k);
   if (e)
      return (uint32_t)(uintptr_t)e->data;

   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"layout\":%u,\"vertex\":{\"module\":%u,\"entryPoint\":\"main\",\"constants\":{\"wg_flip_y\":%d},"
                  "\"buffers\":[", p->layout, k->vs->module, k->flip ? 1 : -1);
   /* A binding none of the shader's inputs reads is left out (else a draw would need its buffer). */
   const uint32_t inputs = k->vs->info.inputs;
   uint32_t used = 0;
   u_foreach_bit(loc, inputs)
      if (k->attr[loc].format)
         used |= 1u << k->attr[loc].binding;
   const uint32_t vb_count = used ? util_last_bit(used) : 0;
   for (uint32_t b = 0; b < vb_count; b++) {
      if (!(used & (1u << b))) {
         wg_json_printf(&j, "%snull", b ? "," : "");
         continue;
      }
      wg_json_printf(&j, "%s{\"arrayStride\":%u,\"stepMode\":\"%s\",\"attributes\":[", b ? "," : "", k->vb[b].stride,
                     k->vb[b].instance ? "instance" : "vertex");
      bool first = true;
      u_foreach_bit(loc, inputs) {
         if (!k->attr[loc].format || k->attr[loc].binding != b)
            continue;
         const char *f = wg_vertex_format(k->attr[loc].format);
         wg_json_printf(&j, "%s{\"format\":\"%s\",\"offset\":%u,\"shaderLocation\":%u}", first ? "" : ",",
                        f ? f : "float32x4", k->attr[loc].offset, loc);
         first = false;
      }
      wg_json_printf(&j, "]}");
   }
   wg_json_printf(&j, "]},\"primitive\":{\"topology\":\"%s\",\"frontFace\":\"%s\",\"cullMode\":\"%s\"",
                  topologies[MIN2(k->topology, 5)], k->front_face ? "cw" : "ccw",
                  k->cull == 1 ? "front" : k->cull == 2 ? "back" : "none");
   if (k->strip_index)
      wg_json_printf(&j, ",\"stripIndexFormat\":\"%s\"", k->strip_index == 2 ? "uint32" : "uint16");
   if (k->unclipped)
      wg_json_printf(&j, ",\"unclippedDepth\":true");
   wg_json_printf(&j, "}");
   if (k->depth) {
      const struct wg_texture_format *f = wg_texture_format(k->depth);
      const bool has_depth = f && (f->flags & WG_FMT_DEPTH), has_stencil = f && (f->flags & WG_FMT_STENCIL);
      wg_json_printf(&j, ",\"depthStencil\":{\"format\":\"%s\"", f ? f->name : "depth32float");
      if (has_depth)
         wg_json_printf(&j, ",\"depthWriteEnabled\":%s,\"depthCompare\":\"%s\"",
                        k->depth_test && k->depth_write ? "true" : "false",
                        k->depth_test ? compares[k->depth_compare & 7] : "always");
      if (has_stencil) {
         wg_json_printf(&j, ",");
         stencil_face(&j, "stencilFront", k->stencil[0], k->stencil_test);
         wg_json_printf(&j, ",");
         stencil_face(&j, "stencilBack", k->stencil[1], k->stencil_test);
         wg_json_printf(&j, ",\"stencilReadMask\":%u,\"stencilWriteMask\":%u", k->stencil_read,
                        k->stencil_test ? k->stencil_write : 0);
      }
      if (k->depth_bias && has_depth)
         wg_json_printf(&j, ",\"depthBias\":%d,\"depthBiasSlopeScale\":%g,\"depthBiasClamp\":%g",
                        (int)k->bias_constant, k->bias_slope, k->bias_clamp);
      wg_json_printf(&j, "}");
   }
   wg_json_printf(&j, ",\"multisample\":{\"count\":%u,\"mask\":%u,\"alphaToCoverageEnabled\":%s}", MAX2(k->samples, 1),
                  k->sample_mask, k->alpha_to_coverage ? "true" : "false");
   if (k->fs) {
      wg_json_printf(&j, ",\"fragment\":{\"module\":%u,\"entryPoint\":\"main\",\"targets\":[", k->fs->module);
      for (uint32_t i = 0; i < k->color_count; i++) {
         const struct wg_texture_format *f = k->colors[i] ? wg_texture_format(k->colors[i]) : NULL;
         if (!f) {
            wg_json_printf(&j, "%snull", i ? "," : "");
            continue;
         }
         const bool written = k->fs->info.outputs & (1u << i);
         wg_json_printf(&j, "%s{\"format\":\"%s\",\"writeMask\":%u", i ? "," : "", f->name,
                        written ? k->blend[i].mask : 0);
         if (written && k->blend[i].enable && (f->flags & WG_FMT_BLEND)) {
            const bool cmin = k->blend[i].op >= 3, amin = k->blend[i].aop >= 3;
            wg_json_printf(&j, ",\"blend\":{\"color\":{\"operation\":\"%s\",\"srcFactor\":\"%s\",\"dstFactor\":\"%s\"},"
                           "\"alpha\":{\"operation\":\"%s\",\"srcFactor\":\"%s\",\"dstFactor\":\"%s\"}}",
                           blend_ops[MIN2(k->blend[i].op, 4)], cmin ? "one" : factors[MIN2(k->blend[i].src, 18)],
                           cmin ? "one" : factors[MIN2(k->blend[i].dst, 18)], blend_ops[MIN2(k->blend[i].aop, 4)],
                           amin ? "one" : factors[MIN2(k->blend[i].asrc, 18)],
                           amin ? "one" : factors[MIN2(k->blend[i].adst, 18)]);
         }
         wg_json_printf(&j, "}");
      }
      wg_json_printf(&j, "]}");
   }
   wg_json_printf(&j, "}");
   const uint32_t id = wg_create_json(WG_KIND_RENDER, &j);
   struct wg_pipeline_key *copy = malloc(sizeof(*copy));
   memcpy(copy, k, sizeof(*copy));
   _mesa_hash_table_insert(p->pipelines, copy, (void *)(uintptr_t)id);
   return id;
}
