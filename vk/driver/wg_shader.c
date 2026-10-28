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
#include "util/blob.h"
#include "util/hash_table.h"
#include "util/os_time.h"
#include "util/ralloc.h"
#include "vk_format.h"
#include "vk_pipeline.h"

#include "wg_private.h"
#include "vk_common_entrypoints.h"
#include "vk_pipeline_cache.h"

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

/* The programs by their link (`program_link`), while they live. */
static struct hash_table *programs;

static uint32_t
link_hash(const void *key)
{
   return _mesa_hash_data(key, sizeof(blake3_hash));
}

static bool
link_equal(const void *a, const void *b)
{
   return !memcmp(a, b, sizeof(blake3_hash));
}

static struct wg_program *
program_find(const blake3_hash link)
{
   struct hash_entry *e = programs ? _mesa_hash_table_search(programs, link) : NULL;
   return e ? e->data : NULL;
}

static void
program_list(struct wg_program *p)
{
   if (!programs)
      programs = _mesa_hash_table_create(NULL, link_hash, link_equal);
   _mesa_hash_table_insert(programs, p->link, p);
   p->listed = true;
}

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

static void
program_free(struct wg_program *p)
{
   if (p->listed) {
      struct hash_entry *e = _mesa_hash_table_search(programs, p->link);
      if (e && e->data == p)
         _mesa_hash_table_remove(programs, e);
   }
   program_free_pipelines(p);
   for (uint32_t i = 0; i < WGSL_MAX_GROUPS; i++)
      wg_id_release(p->bgl[i]);
   wg_id_release(p->push_group);
   wg_id_release(p->layout);
   wg_id_release(p->compute);
   if (p->owns_compute_module)
      wg_id_release(p->compute_module);
   free(p->compute_wgsl);
   free(p);
}

/* A program and its variants. */
static void
program_free_all(struct wg_program *p)
{
   for (struct wg_program *v = p->variants, *next; v; v = next) {
      next = v->variants;
      program_free(v);
   }
   program_free(p);
}

void
wg_program_unref(struct wg_program *p)
{
   if (!p || --p->refs)
      return;
   for (struct wg_program *m = p->merged, *next; m; m = next) {
      next = m->merged;
      program_free_all(m);
   }
   program_free_all(p);
}

static const char *const dims[] = { "1d", "2d", "2d-array", "cube", "cube-array", "3d" };
static const char *const samples[] = { "float", "unfilterable-float", "depth", "sint", "uint" };

static int
resource_cmp(const void *a, const void *b)
{
   const struct wgsl_resource *x = a, *y = b;
   return x->group != y->group ? x->group - y->group : x->binding - y->binding;
}

/* Where a pipeline layout's sets go: set s in group s, sets 3 and up together in group 3 (WebGPU has 4), each after
 * the one before it there. */
static void
set_groups(struct vk_descriptor_set_layout *const *layouts, uint32_t count, uint8_t *group, uint32_t *base)
{
   uint32_t next = 0;
   for (uint32_t s = 0; s < MIN2(count, WGSL_MAX_SETS); s++) {
      group[s] = MIN2(s, WGSL_MAX_GROUPS - 1);
      base[s] = 0;
      if (group[s] != WGSL_MAX_GROUPS - 1)
         continue;
      base[s] = next;
      if (layouts[s])
         next += container_of(layouts[s], struct wg_descriptor_set_layout, vk)->slot_count;
   }
}

/* A bind group layout's uid, which descriptor sets key the bind groups they keep by (wg_cmd.c): one for each content
 * (its WebGPU description, and what a bind group of it takes besides: its uniform bindings' sizes, the push buffer's
 * binding's), never reused. WebGPU takes a bind group with any layout of the same entries ("group-equivalent"), so
 * pipelines whose layouts match share a set's bind groups (VK3 L6b: each pipeline's own layouts made the scene remake
 * ~14 a frame, a set keeping groups for 4 layouts). */
static uint32_t
bgl_uid(const struct wg_program *p, uint32_t g, const char *desc)
{
   static struct hash_table *uids;
   static uint32_t next;
   if (!uids)
      uids = _mesa_hash_table_create(NULL, _mesa_hash_string, _mesa_key_string_equal);
   struct wg_json key = { 0 };
   wg_json_printf(&key, "%s", desc);
   for (uint32_t k = 0; k < p->resource_count; k++)
      if (p->resources[k].group == g && p->resources[k].kind == WGSL_UNIFORM)
         wg_json_printf(&key, " %u:%u", p->resources[k].binding,
                        p->dynamic[k] == WG_DYNAMIC_PUSH ? p->push_ubo_size : p->resources[k].size);
   struct hash_entry *e = _mesa_hash_table_search(uids, key.data);
   if (e) {
      wg_json_free(&key);
      return (uint32_t)(uintptr_t)e->data;
   }
   _mesa_hash_table_insert(uids, key.data, (void *)(uintptr_t)++next);
   return next;
}

/* A program's bind group layouts and pipeline layout, from its resources. */
static void
program_layouts(struct wg_program *p)
{
   struct wg_json j = { 0 };
   uint32_t k = 0;
   for (uint32_t g = 0; g < p->group_count; g++) {
      wg_json_printf(&j, "{\"entries\":[");
      for (bool first = true; k < p->resource_count && p->resources[k].group == g; k++, first = false) {
         const struct wgsl_resource *r = &p->resources[k];
         wg_json_printf(&j, "%s{\"binding\":%u,\"visibility\":%u,", first ? "" : ",", r->binding, p->vis[k]);
         switch (r->kind) {
         case WGSL_UNIFORM:
         case WGSL_STORAGE:
         case WGSL_STORAGE_READ:
            wg_json_printf(&j, "\"buffer\":{\"type\":\"%s\",\"hasDynamicOffset\":%s}}",
                           r->kind == WGSL_UNIFORM ? "uniform" : r->kind == WGSL_STORAGE ? "storage" : "read-only-storage",
                           p->dynamic[k] != -1 ? "true" : "false");
            break;
         case WGSL_SAMPLER:
         case WGSL_SAMPLER_COMPARE:
            wg_json_printf(&j, "\"sampler\":{\"type\":\"%s\"}}",
                           r->kind == WGSL_SAMPLER ? (r->nonfiltering ? "non-filtering" : "filtering") : "comparison");
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
      p->bgl_uid[g] = bgl_uid(p, g, j.data);
      p->bgl[g] = wg_create_json(WG_KIND_BGL, &j);
   }
   wg_json_printf(&j, "{\"bindGroupLayouts\":[");
   for (uint32_t g = 0; g < p->group_count; g++)
      wg_json_printf(&j, "%s%u", g ? "," : "", p->bgl[g]);
   wg_json_printf(&j, "],\"immediateSize\":%u}", p->immediate_size);
   p->layout = wg_create_json(WG_KIND_LAYOUT, &j);
}

struct wg_program *
wg_program_variant(struct wg_program *p, uint64_t mask)
{
   for (struct wg_program *v = p->variants; v; v = v->variants)
      if (v->mask == mask)
         return v;
   struct wg_program *v = malloc(sizeof(*v));
   memcpy(v, p, sizeof(*v));
   v->refs = 1;
   v->listed = false;
   v->merged = NULL;
   v->pipelines = NULL;
   v->push_group = 0;
   v->push_group_gen = 0;
   v->compute = 0;
   v->compute_wgsl = NULL;
   v->owns_compute_module = false;
   v->mask = mask;
   bool widened = false;
   for (uint32_t k = 0; k < MIN2(p->resource_count, 64); k++) {
      if (!(mask & (1ull << k)))
         continue;
      /* A read-only storage buffer beside a writable one of its memory: "storage" (wg_cmd.c `program_for`). */
      if (v->resources[k].kind == WGSL_STORAGE_READ) {
         v->resources[k].kind = WGSL_STORAGE;
         widened = true;
         continue;
      }
      v->resources[k].sample = WGSL_SAMPLE_UNFILTERABLE;
      /* Its samplers: non-filtering (the bind group gives them the sampler's nearest twin). */
      const uint32_t index = (uint32_t)v->resources[k].group << 16 | v->resources[k].binding;
      for (uint32_t i = 0; i < p->pair_count; i++) {
         if (p->pairs[i][0] != index)
            continue;
         for (uint32_t r = 0; r < v->resource_count; r++)
            if (((uint32_t)v->resources[r].group << 16 | v->resources[r].binding) == p->pairs[i][1] &&
                v->resources[r].kind == WGSL_SAMPLER)
               v->resources[r].nonfiltering = true;
      }
   }
   program_layouts(v);
   /* WebGPU wants a binding's access in the module to be its layout entry's: widened bindings' read_write in a module
    * of the variant's own, from the program's WGSL (wgsl_print.c declares each `@group(g) @binding(b) var<storage,
    * read>`). */
   if (widened && p->compute_wgsl) {
      char *text = strdup(p->compute_wgsl);
      for (uint32_t k = 0; k < MIN2(p->resource_count, 64); k++) {
         if (!(mask & (1ull << k)) || p->resources[k].kind != WGSL_STORAGE_READ)
            continue;
         char decl[96];
         snprintf(decl, sizeof(decl), "@group(%u) @binding(%u) var<storage, read> ", p->resources[k].group,
                  p->resources[k].binding);
         char *at = strstr(text, decl);
         if (!at)
            continue;
         const size_t head = at - text + strlen(decl) - strlen("read> ");
         char *t = malloc(strlen(text) + 8);
         memcpy(t, text, head);
         strcpy(t + head, "read_write> ");
         strcat(t, at + strlen(decl));
         free(text);
         text = t;
      }
      v->compute_module = wg_id();
      v->owns_compute_module = true;
      gpu_shader(v->compute_module, text, strlen(text));
      free(text);
   }
   if (p->compute_module) {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"layout\":%u,\"compute\":{\"module\":%u,\"entryPoint\":\"main\"}}", v->layout,
                     v->compute_module);
      v->compute = wg_create_json(WG_KIND_COMPUTE, &j);
   }
   v->variants = p->variants;
   p->variants = v;
   return v;
}

/* One stage's binding into another's at the same place: the wider of the two. */
static void
resource_merge(struct wgsl_resource *m, const struct wgsl_resource *r)
{
   if (r->kind == WGSL_STORAGE)
      m->kind = WGSL_STORAGE;
   m->written |= r->written;
   if (r->kind == WGSL_STORAGE_TEXTURE)
      m->access |= r->access;
   m->size = MAX2(m->size, r->size);
}

/* The program of `count` translated stages (visibility by stage) on a pipeline's set layouts. */
static struct wg_program *
program_create(struct wg_shader **shaders, uint32_t count, struct vk_descriptor_set_layout *const *layouts,
               uint32_t layout_count)
{
   struct wg_program *p = calloc(1, sizeof(*p));
   p->refs = 1;
   p->set_count = MIN2(layout_count, WGSL_MAX_SETS);
   set_groups(layouts, layout_count, p->set_group, p->set_base);
   uint8_t vis[WGSL_MAX_RESOURCES] = { 0 };
   for (uint32_t s = 0; s < count; s++) {
      const struct wgsl_info *info = &shaders[s]->info;
      const uint8_t stage = shaders[s]->vk.stage == MESA_SHADER_VERTEX ? 1
                            : shaders[s]->vk.stage == MESA_SHADER_FRAGMENT ? 2
                                                                            : 4;
      p->immediate_size = MAX2(p->immediate_size, info->immediate_size);
      p->push_ubo_size = MAX2(p->push_ubo_size, info->push_ubo_size);
      for (uint32_t i = 0; i < info->pair_count; i++) {
         bool known = false;
         for (uint32_t k = 0; k < p->pair_count; k++)
            known |= p->pairs[k][0] == info->pairs[i][0] && p->pairs[k][1] == info->pairs[i][1];
         if (!known && p->pair_count < WGSL_MAX_PAIRS) {
            p->pairs[p->pair_count][0] = info->pairs[i][0];
            p->pairs[p->pair_count++][1] = info->pairs[i][1];
         }
      }
      for (uint32_t i = 0; i < info->resource_count; i++) {
         const struct wgsl_resource *r = &info->resources[i];
         uint32_t k = 0;
         while (k < p->resource_count && (p->resources[k].group != r->group || p->resources[k].binding != r->binding))
            k++;
         if (k == p->resource_count)
            p->resources[p->resource_count++] = *r;
         else
            resource_merge(&p->resources[k], r);
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
      struct wgsl_resource *r = &p->resources[i];
      p->res_set[i] = -1;
      p->dynamic[i] = -1;
      if (r->group == WGSL_MAX_GROUPS - 1 && r->binding == WGSL_PUSH_BINDING) {
         p->dynamic[i] = WG_DYNAMIC_PUSH;
         r->size = p->push_ubo_size;
         continue;
      }
      /* The set whose slots hold the binding: the last of its group starting at or before it. */
      const uint32_t at = r->binding / 2;
      for (uint32_t s = 0; s < p->set_count; s++)
         if (p->set_group[s] == r->group && p->set_base[s] <= at && layouts[s])
            p->res_set[i] = s;
      const int set = p->res_set[i];
      const struct wg_descriptor_set_layout *l =
         set >= 0 ? container_of(layouts[set], struct wg_descriptor_set_layout, vk) : NULL;
      const uint32_t slot = set >= 0 ? at - p->set_base[set] : 0;
      p->dynamic[i] = l && slot < l->slot_count && (r->kind == WGSL_UNIFORM || r->kind == WGSL_STORAGE ||
                                                     r->kind == WGSL_STORAGE_READ)
                         ? l->dynamic[slot]
                         : -1;
   }

   for (uint32_t i = 0; i < p->resource_count; i++)
      p->vis[i] = vis[i];
   return p;
}

/* A program's data across runs (wg_serialize): everything program_create derives from its stages and set layouts.
 * The resources go field by field: a struct's padding is indeterminate, and a program's link hashes these bytes (two
 * stages of one link would otherwise get different programs, and a draw would lose its fragment shader). */
#define PROGRAM_FIELDS(X)                                                                                              \
   X(group_count) X(set_count) X(set_group) X(set_base) X(resource_count) X(dynamic) X(res_set) X(immediate_size)     \
   X(push_ubo_size) X(vis) X(pair_count) X(pairs)
#define RESOURCE_FIELDS(X)                                                                                             \
   X(group) X(binding) X(kind) X(dim) X(sample) X(multisampled) X(atomic) X(written) X(nonfiltering) X(access) X(format) X(size)

static void
program_write(struct blob *b, const struct wg_program *p)
{
#define W(f) blob_write_bytes(b, &p->f, sizeof(p->f));
   PROGRAM_FIELDS(W)
#undef W
   for (uint32_t i = 0; i < MIN2(p->resource_count, WGSL_MAX_RESOURCES); i++) {
#define W(f) blob_write_bytes(b, &p->resources[i].f, sizeof(p->resources[i].f));
      RESOURCE_FIELDS(W)
#undef W
   }
}

static void
program_read(struct blob_reader *b, struct wg_program *p)
{
#define R(f) blob_copy_bytes(b, &p->f, sizeof(p->f));
   PROGRAM_FIELDS(R)
#undef R
   for (uint32_t i = 0; i < MIN2(p->resource_count, WGSL_MAX_RESOURCES); i++) {
#define R(f) blob_copy_bytes(b, &p->resources[i].f, sizeof(p->resources[i].f));
      RESOURCE_FIELDS(R)
#undef R
   }
}

/* A program's link: its data and each stage's WGSL, in stage order. */
static void
program_link(struct wg_program *p, struct wg_shader *const *shaders, uint32_t count)
{
   struct blob b;
   blob_init(&b);
   program_write(&b, p);
   blake3_hasher h;
   _mesa_blake3_init(&h);
   _mesa_blake3_update(&h, b.data, b.size);
   blob_finish(&b);
   for (uint32_t i = 0; i < count; i++) {
      const uint32_t stage = shaders[i]->vk.stage;
      _mesa_blake3_update(&h, &stage, sizeof(stage));
      if (shaders[i]->wgsl)
         _mesa_blake3_update(&h, shaders[i]->wgsl, strlen(shaders[i]->wgsl));
   }
   _mesa_blake3_final(&h, p->link);
}

/* The program's WebGPU objects: its layouts, and a compute stage's pipeline (of `compute_module`, made of `wgsl`). */
static void
program_objects(struct wg_program *p, uint32_t compute_module, const char *wgsl)
{
   program_layouts(p);
   if (compute_module) {
      p->compute_wgsl = strdup(wgsl);
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"layout\":%u,\"compute\":{\"module\":%u,\"entryPoint\":\"main\"}}", p->layout,
                     compute_module);
      p->compute = wg_create_json(WG_KIND_COMPUTE, &j);
      p->compute_module = compute_module;
   }
}

/* A program of two programs' stages (`a`'s, a draw's vertex shader's, and `b`'s, its fragment shader's), for a draw
 * whose stages came with different links: each stage is lowered against its pipeline's layout, so both programs' data
 * describe one layout, and the union of their bindings serves both modules. Equal stages always share a link (a cached
 * stage keeps the link of its first compile, its partner compiled again gets the same), so this takes a cache whose
 * entries disagree; it is said once. Kept on `a`, by `b`'s link, and freed with it. */
struct wg_program *
wg_program_merge(struct wg_program *a, const struct wg_program *b)
{
   for (struct wg_program *m = a->merged; m; m = m->merged)
      if (!memcmp(m->with, b->link, sizeof(blake3_hash)))
         return m;
   static bool said;
   if (!said)
      fprintf(stderr, "wg: a draw's vertex and fragment shaders came with different programs; drawn with both's\n");
   said = true;
   struct wg_program *m = calloc(1, sizeof(*m));
   m->refs = 1;
#define C(f) memcpy(&m->f, &a->f, sizeof(m->f));
   PROGRAM_FIELDS(C)
#undef C
   memcpy(m->resources, a->resources, sizeof(m->resources));
   m->set_count = MAX2(a->set_count, b->set_count);
   m->group_count = MAX2(a->group_count, b->group_count);
   m->immediate_size = MAX2(a->immediate_size, b->immediate_size);
   m->push_ubo_size = MAX2(a->push_ubo_size, b->push_ubo_size);
   for (uint32_t i = 0; i < b->resource_count; i++) {
      const struct wgsl_resource *r = &b->resources[i];
      uint32_t k = 0;
      while (k < m->resource_count && (m->resources[k].group != r->group || m->resources[k].binding != r->binding))
         k++;
      if (k < m->resource_count) {
         resource_merge(&m->resources[k], r);
         m->vis[k] |= b->vis[i];
      } else if (k < WGSL_MAX_RESOURCES) {
         m->resources[k] = *r;
         m->vis[k] = b->vis[i];
         m->dynamic[k] = b->dynamic[i];
         m->res_set[k] = b->res_set[i];
         m->resource_count++;
      }
   }
   for (uint32_t i = 0; i < b->pair_count; i++) {
      bool known = false;
      for (uint32_t k = 0; k < m->pair_count; k++)
         known |= m->pairs[k][0] == b->pairs[i][0] && m->pairs[k][1] == b->pairs[i][1];
      if (!known && m->pair_count < WGSL_MAX_PAIRS) {
         m->pairs[m->pair_count][0] = b->pairs[i][0];
         m->pairs[m->pair_count++][1] = b->pairs[i][1];
      }
   }
   /* By group, then binding, each resource's visibility, dynamic index and set with it. */
   struct {
      struct wgsl_resource r;
      int16_t dynamic;
      int8_t set;
      uint8_t vis;
   } sorted[WGSL_MAX_RESOURCES];
   for (uint32_t i = 0; i < m->resource_count; i++)
      sorted[i].r = m->resources[i], sorted[i].dynamic = m->dynamic[i], sorted[i].set = m->res_set[i],
      sorted[i].vis = m->vis[i];
   qsort(sorted, m->resource_count, sizeof(sorted[0]), resource_cmp);
   for (uint32_t i = 0; i < m->resource_count; i++) {
      m->resources[i] = sorted[i].r, m->dynamic[i] = sorted[i].dynamic, m->res_set[i] = sorted[i].set;
      m->vis[i] = sorted[i].vis;
      if (m->dynamic[i] == WG_DYNAMIC_PUSH)
         m->resources[i].size = m->push_ubo_size;
   }
   program_layouts(m);
   memcpy(m->with, b->link, sizeof(blake3_hash));
   m->merged = a->merged;
   a->merged = m;
   return m;
}

/* Compiling. */

static const struct vk_shader_ops wg_shader_ops;

static void
shader_destroy(struct vk_device *dev, struct vk_shader *vk, const VkAllocationCallbacks *pAllocator)
{
   struct wg_shader *s = container_of(vk, struct wg_shader, vk);
   /* A compute program outlives this shader if another shares it, and makes its variants from this module: it keeps
    * the module then (an id released here could name another object by a variant's make). */
   if (s->program && s->module && s->program->compute_module == s->module && s->program->refs > 1)
      s->program->owns_compute_module = true;
   else
      wg_id_release(s->module);
   wg_id_release(s->empty_fs);
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
   uint8_t group[WGSL_MAX_SETS];
   uint32_t base[WGSL_MAX_SETS];
   set_groups(layouts, count, group, base);
   for (uint32_t s = 0; s < out->set_count; s++) {
      if (!layouts[s])
         continue;
      const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
      out->sets[s] = (struct wgsl_set_layout){ .group = group[s], .base = base[s], .binding_count = l->binding_count,
                                               .first = l->first, .count = l->count };
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
      if (!wgsl_lower(infos[i].nir, &layout, wg_subgroup_size(), error, sizeof(error))) {
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
         const struct wgsl_print_options options = {
            .fs = infos[i].stage == MESA_SHADER_VERTEX ? fs_reads : NULL,
            .max_immediates = wg_max_immediates,
            .max_workgroup_storage = wg_limits.max_compute_workgroup_storage_size,
            .features = ((wg_features & WG_FEATURE_TIER2) ? WGSL_TIER2 : 0) |
                        ((wg_features & WG_FEATURE_DUAL_SOURCE) ? WGSL_DUAL_SOURCE : 0) |
                        (wg_subgroup_size() > 1 ? WGSL_SUBGROUPS : 0) | ((wg_features & WG_FEATURE_F16) ? WGSL_F16 : 0),
         };
         char *text = wgsl_print(NULL, infos[i].nir, &options, &s->info, error, sizeof(error));
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
   /* A storage image the stages bind with different access: its one layout entry can't match both modules' (WebGPU
    * wants each module's access to be the entry's), so the pipeline would be invalid (VK3 L4c-F): refused. */
   for (uint32_t a = 0; ok && a < count; a++)
      for (uint32_t b = a + 1; ok && b < count; b++)
         for (uint32_t i = 0; ok && i < shaders[a]->info.resource_count; i++)
            for (uint32_t k = 0; ok && k < shaders[b]->info.resource_count; k++) {
               const struct wgsl_resource *x = &shaders[a]->info.resources[i], *y = &shaders[b]->info.resources[k];
               if (x->kind == WGSL_STORAGE_TEXTURE && y->kind == WGSL_STORAGE_TEXTURE && x->group == y->group &&
                   x->binding == y->binding && x->access != y->access) {
                  snprintf(error, sizeof(error), "a storage image the stages access differently (group %u binding %u)",
                           x->group, x->binding);
                  ok = false;
               }
               /* Likewise a storage buffer one stage writes and another only reads (the translator declares it
                * read-only where it isn't written, but in compute): that is a vertex stage reading what the fragment
                * stage writes, which WebGPU can't bind (no writable storage in vertex shaders). */
               const bool xs = x->kind == WGSL_STORAGE || x->kind == WGSL_STORAGE_READ;
               const bool ys = y->kind == WGSL_STORAGE || y->kind == WGSL_STORAGE_READ;
               if (xs && ys && x->group == y->group && x->binding == y->binding && x->kind != y->kind) {
                  snprintf(error, sizeof(error),
                           "a storage buffer one stage writes and the vertex stage reads (group %u binding %u)",
                           x->group, x->binding);
                  ok = false;
               }
            }
   for (uint32_t i = 0; i < count; i++)
      ralloc_free(infos[i].nir);
   if (!ok) {
      /* Shaders that draw and dispatch nothing (a draw needs its vertex shader's program, a dispatch its compute
       * pipeline): failing the pipeline would fail the guest's context, since Venus's guest driver doesn't wait for a
       * pipeline's result before it binds it. */
      fprintf(stderr, "wg: a shader didn't translate: %s\n", error);
      for (uint32_t i = 0; i < count; i++) {
         if (!shaders[i])
            shaders[i] = vk_shader_zalloc(device, &wg_shader_ops, infos[i].stage, pAllocator, sizeof(*shaders[i]));
         if (!shaders[i]) {
            for (uint32_t k = 0; k < i; k++)
               shader_destroy(device, &shaders[k]->vk, pAllocator);
            memset(out, 0, count * sizeof(*out));
            return vk_error(device, VK_ERROR_OUT_OF_HOST_MEMORY);
         }
         wg_id_release(shaders[i]->module);
         shaders[i]->module = 0;
         free(shaders[i]->wgsl);
         shaders[i]->wgsl = NULL;
         out[i] = &shaders[i]->vk;
      }
      return VK_SUCCESS;
   }

   /* A program of the same link already made (its other stages loaded from a cache, or the same pipeline made
    * again) is shared: a draw needs its vertex and fragment shaders on one program. */
   struct wg_program *p = program_create(shaders, count, infos[0].set_layouts, infos[0].set_layout_count);
   program_link(p, shaders, count);
   struct wg_program *same = program_find(p->link);
   if (same) {
      free(p);
      p = same;
      p->refs += count;
   } else {
      p->refs = count;
      program_objects(p, infos[0].stage == MESA_SHADER_COMPUTE ? shaders[0]->module : 0, shaders[0]->wgsl);
      program_list(p);
   }
   for (uint32_t i = 0; i < count; i++) {
      shaders[i]->program = p;
      out[i] = &shaders[i]->vk;
   }
   return VK_SUCCESS;
}

/* A shader across runs (Mesa's pipeline caches, the worker's store through vk/wasi/disk_cache.c; vk/README.md "The
 * shader cache"): its stage's WGSL and info and its program's data with its link. A stage that didn't translate is
 * kept as such (no WGSL, no program). The runtime's header around it carries the build's shaderBinaryUUID. */
#define WG_SHADER_FORMAT 2

static bool
wg_serialize(struct vk_device *device, const struct vk_shader *vk, struct blob *blob)
{
   const struct wg_shader *s = container_of(vk, struct wg_shader, vk);
   blob_write_uint32(blob, WG_SHADER_FORMAT);
   blob_write_uint32(blob, s->vk.stage);
   blob_write_uint32(blob, s->wgsl && s->program ? 1 : 0);
   if (!s->wgsl || !s->program)
      return !blob->out_of_memory;
   blob_write_string(blob, s->wgsl);
   blob_write_bytes(blob, &s->info, sizeof(s->info));
   program_write(blob, s->program);
   blob_write_bytes(blob, s->program->link, sizeof(blake3_hash));
   return !blob->out_of_memory;
}

static VkResult
wg_deserialize(struct vk_device *device, struct blob_reader *blob, uint32_t version,
               const VkAllocationCallbacks *pAllocator, struct vk_shader **out)
{
   const uint32_t format = blob_read_uint32(blob);
   const uint32_t stage = blob_read_uint32(blob);
   const uint32_t translated = blob_read_uint32(blob);
   if (blob->overrun || format != WG_SHADER_FORMAT || stage >= MESA_SHADER_STAGES)
      return vk_error(device, VK_ERROR_INCOMPATIBLE_SHADER_BINARY_EXT);
   struct wg_shader *s = vk_shader_zalloc(device, &wg_shader_ops, stage, pAllocator, sizeof(*s));
   if (!s)
      return vk_error(device, VK_ERROR_OUT_OF_HOST_MEMORY);
   if (!translated) {
      *out = &s->vk;
      return VK_SUCCESS;
   }
   const char *wgsl = blob_read_string(blob);
   blob_copy_bytes(blob, &s->info, sizeof(s->info));
   struct wg_program *p = calloc(1, sizeof(*p));
   if (!p) {
      vk_shader_free(device, pAllocator, &s->vk);
      return vk_error(device, VK_ERROR_OUT_OF_HOST_MEMORY);
   }
   program_read(blob, p);
   blob_copy_bytes(blob, p->link, sizeof(blake3_hash));
   if (blob->overrun || !wgsl || p->resource_count > WGSL_MAX_RESOURCES || p->group_count > WGSL_MAX_GROUPS ||
       p->pair_count > WGSL_MAX_PAIRS || p->set_count > WGSL_MAX_SETS) {
      free(p);
      vk_shader_free(device, pAllocator, &s->vk);
      return vk_error(device, VK_ERROR_INCOMPATIBLE_SHADER_BINARY_EXT);
   }
   s->wgsl = strdup(wgsl);
   s->module = wg_id();
   gpu_shader(s->module, s->wgsl, strlen(s->wgsl));
   struct wg_program *same = program_find(p->link);
   if (same) {
      free(p);
      same->refs++;
      s->program = same;
   } else {
      p->refs = 1;
      program_objects(p, stage == MESA_SHADER_COMPUTE ? s->module : 0, s->wgsl);
      program_list(p);
      s->program = p;
   }
   *out = &s->vk;
   return VK_SUCCESS;
}

/* Pipelines made, timed for the render stats (`translateMs`: the translation, or a cache's lookups). */
VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateGraphicsPipelines(VkDevice device, VkPipelineCache cache, uint32_t count,
                           const VkGraphicsPipelineCreateInfo *infos, const VkAllocationCallbacks *alloc,
                           VkPipeline *pipelines)
{
   const int64_t t0 = os_time_get_nano();
   VkResult r = vk_common_CreateGraphicsPipelines(device, cache, count, infos, alloc, pipelines);
   gpu_translated((double)(os_time_get_nano() - t0) / 1e6);
   return r;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateComputePipelines(VkDevice device, VkPipelineCache cache, uint32_t count,
                          const VkComputePipelineCreateInfo *infos, const VkAllocationCallbacks *alloc,
                          VkPipeline *pipelines)
{
   const int64_t t0 = os_time_get_nano();
   VkResult r = vk_common_CreateComputePipelines(device, cache, count, infos, alloc, pipelines);
   gpu_translated((double)(os_time_get_nano() - t0) / 1e6);
   return r;
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

void
wg_vertex_slots(const struct wg_pipeline_key *k, uint32_t inputs, struct wg_vertex_slots *out)
{
   memset(out, 0, sizeof(*out));
   u_foreach_bit(loc, inputs)
      if (k->attr[loc].format)
         out->used |= 1u << k->attr[loc].binding;
   for (uint32_t b = 0; b < 8; b++)
      out->binding[b] = b;
   u_foreach_bit(loc, inputs) {
      if (!k->attr[loc].format)
         continue;
      const uint32_t b = k->attr[loc].binding, stride = k->vb[b].stride;
      const uint32_t size = vk_format_get_blocksize(k->attr[loc].format), offset = k->attr[loc].offset;
      out->slot[loc] = b;
      out->offset[loc] = offset;
      if (!stride || offset + size <= stride)
         continue;
      /* Its own slot: the same binding further on, the offset's remainder within 4 bytes (WebGPU's buffer offsets are
       * 4-aligned). With no slot free, it stays (and the pipeline fails). */
      const uint32_t base = offset & ~3u;
      int free = -1;
      for (int s = 7; s >= 0 && free < 0; s--) {
         if (out->used & (1u << s)) {
            if (out->binding[s] == b && out->base[s] == base && s != (int)b)
               free = s;
            continue;
         }
         free = s;
      }
      if (free < 0 || offset - base + size > stride)
         continue;
      out->used |= 1u << free;
      out->binding[free] = b;
      out->base[free] = base;
      out->slot[loc] = free;
      out->offset[loc] = offset - base;
   }
   /* A binding whose every attribute moved keeps no slot of its own. */
   for (uint32_t b = 0; b < 8; b++) {
      if (!(out->used & (1u << b)) || out->binding[b] != b || out->base[b])
         continue;
      bool any = false;
      u_foreach_bit(loc, inputs)
         any |= k->attr[loc].format && out->slot[loc] == b;
      if (!any)
         out->used &= ~(1u << b);
   }
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
   wg_json_printf(&j, "{\"layout\":%u,\"vertex\":{\"module\":%u,\"entryPoint\":\"main\","
                  "\"constants\":{\"wg_flip_y\":%d,\"wg_flip_z\":%d},\"buffers\":[",
                  p->layout, k->vs->module, k->flip ? 1 : -1, k->flip_z ? 1 : 0);
   /* A binding none of the shader's inputs reads is left out (else a draw would need its buffer). */
   const uint32_t inputs = k->vs->info.inputs;
   struct wg_vertex_slots vs;
   wg_vertex_slots(k, inputs, &vs);
   const uint32_t vb_count = vs.used ? util_last_bit(vs.used) : 0;
   for (uint32_t b = 0; b < vb_count; b++) {
      if (!(vs.used & (1u << b))) {
         wg_json_printf(&j, "%snull", b ? "," : "");
         continue;
      }
      const uint32_t binding = vs.binding[b];
      wg_json_printf(&j, "%s{\"arrayStride\":%u,\"stepMode\":\"%s\",\"attributes\":[", b ? "," : "",
                     k->vb[binding].stride, k->vb[binding].instance ? "instance" : "vertex");
      bool first = true;
      u_foreach_bit(loc, inputs) {
         if (!k->attr[loc].format || vs.slot[loc] != b)
            continue;
         const char *f = wg_vertex_format(k->attr[loc].format);
         wg_json_printf(&j, "%s{\"format\":\"%s\",\"offset\":%u,\"shaderLocation\":%u}", first ? "" : ",",
                        f ? f : "float32x4", vs.offset[loc], loc);
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
   } else {
      /* No fragment shader: WebGPU's pipeline would have no colour targets, which no pass with colour takes. One
       * that writes nothing, its targets the pass's, unwritten. */
      bool colour = false;
      for (uint32_t i = 0; i < k->color_count; i++)
         colour |= k->colors[i] && wg_texture_format(k->colors[i]);
      if (colour) {
         if (!k->vs->empty_fs) {
            static const char empty[] = "@fragment fn main() {}\n";
            k->vs->empty_fs = wg_id();
            gpu_shader(k->vs->empty_fs, empty, sizeof(empty) - 1);
         }
         wg_json_printf(&j, ",\"fragment\":{\"module\":%u,\"entryPoint\":\"main\",\"targets\":[", k->vs->empty_fs);
         for (uint32_t i = 0; i < k->color_count; i++) {
            const struct wg_texture_format *f = k->colors[i] ? wg_texture_format(k->colors[i]) : NULL;
            if (f)
               wg_json_printf(&j, "%s{\"format\":\"%s\",\"writeMask\":0}", i ? "," : "", f->name);
            else
               wg_json_printf(&j, "%snull", i ? "," : "");
         }
         wg_json_printf(&j, "]}");
      }
   }
   wg_json_printf(&j, "}");
   const uint32_t id = wg_create_json(WG_KIND_RENDER, &j);
   struct wg_pipeline_key *copy = malloc(sizeof(*copy));
   memcpy(copy, k, sizeof(*copy));
   _mesa_hash_table_insert(p->pipelines, copy, (void *)(uintptr_t)id);
   return id;
}
