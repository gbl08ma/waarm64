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
#include "nir_serialize.h"
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

/* Whether a pipeline's fragment shader runs at the sample rate (sampleShadingEnable, VK3 L7.1): where its minimum
 * asks for more than one invocation a pixel (with the sample count dynamic, any minimum). WebGPU has no minimum: a
 * fragment shader runs per pixel or per sample (WGSL's inputs at their sample), so it runs per sample. */
static bool
sample_shading(const struct vk_graphics_pipeline_state *state)
{
   if (!state || !state->ms || !state->ms->sample_shading_enable)
      return false;
   const uint32_t n = state->ms->rasterization_samples;
   return n ? state->ms->min_sample_shading * n > 1.0f : state->ms->min_sample_shading > 0.0f;
}

static void
wg_hash_state(struct vk_physical_device *pdev, const struct vk_graphics_pipeline_state *state,
              const struct vk_features *features, VkShaderStageFlags stages, blake3_hash out)
{
   /* Of the state only sample shading reaches the WGSL (its inputs' sampling: the vertex stage's outputs follow
    * them); render pipelines take the rest at draw time. */
   memset(out, 0, sizeof(blake3_hash));
   out[0] = (stages & (VK_SHADER_STAGE_FRAGMENT_BIT | VK_SHADER_STAGE_VERTEX_BIT)) && sample_shading(state);
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
stage_nir_free(struct wg_stage_nir *n)
{
   if (n)
      free(n->data);
   free(n);
}

static struct wg_stage_nir *
stage_nir_copy(const struct wg_stage_nir *n)
{
   if (!n)
      return NULL;
   struct wg_stage_nir *c = malloc(sizeof(*c));
   *c = *n;
   c->data = malloc(n->size);
   memcpy(c->data, n->data, n->size);
   return c;
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
   wg_id_release(p->vs_module);
   wg_id_release(p->fs_module);
   wg_id_release(p->fs_no_depth);
   for (struct wg_pull *u = p->pulls, *next; u; u = next) {
      next = u->next;
      wg_id_release(u->bgl);
      wg_id_release(u->layout);
      free(u);
   }
   free(p->compute_wgsl);
   stage_nir_free(p->compute_nir);
   free(p->keys);
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
   if (wg_features & WG_FEATURE_L9_BGL_UIDS)
      return ++next;
   if (!uids)
      uids = _mesa_hash_table_create(NULL, _mesa_hash_string, _mesa_key_string_equal);
   struct wg_json key = { 0 };
   wg_json_printf(&key, "%s", desc);
   /* And the storage a group's shaders write: a bind group's replay registers their readback (wg_cmd.c `bind_group`),
    * so a group of a widened variant, whose layout says "storage" of what it only reads, isn't a writer's (VK3 L7a). */
   for (uint32_t k = 0; k < p->resource_count; k++)
      if (p->resources[k].group == g && p->resources[k].kind == WGSL_UNIFORM)
         wg_json_printf(&key, " %u:%u", p->resources[k].binding,
                        p->dynamic[k] == WG_DYNAMIC_PUSH ? p->push_ubo_size : p->resources[k].size);
      else if (p->resources[k].group == g && p->resources[k].kind == WGSL_STORAGE && p->resources[k].written)
         wg_json_printf(&key, " w%u", p->resources[k].binding);
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

/* A module's WGSL as a variant binds it (wgsl_print.c declares each `@group(g) @binding(b) var rG_B…` and samples as
 * `rG_T, rG_S, …`): widened storage buffers `read_write` (WebGPU wants a binding's access in the module to be its layout
 * entry's), and each split sampler's unfilterable textures sampled through its twin at the binding before it. NULL: no
 * change. */
static char *
variant_text(const struct wg_program *p, const struct wg_program *v, const uint64_t *mask, const char *wgsl)
{
   if (!wgsl)
      return NULL;
   char *text = strdup(wgsl);
   bool changed = false;
   for (uint32_t k = 0; k < MIN2(p->resource_count, WGSL_MAX_RESOURCES); k++) {
      if (!(mask[k / 64] & (1ull << (k % 64))) || p->resources[k].kind != WGSL_STORAGE_READ)
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
      changed = true;
   }
   for (uint32_t i = 0; i < v->split_count; i++) {
      const uint32_t g = v->splits[i][0], tb = v->splits[i][1], sb = v->splits[i][2];
      char from[64], to[64], decl[96], twin[96];
      snprintf(from, sizeof(from), "r%u_%u, r%u_%u,", g, tb, g, sb);
      snprintf(to, sizeof(to), "r%u_%u, r%u_%u,", g, tb, g, sb - 1);
      snprintf(decl, sizeof(decl), "@group(%u) @binding(%u) var r%u_%u: sampler;\n", g, sb, g, sb);
      snprintf(twin, sizeof(twin), "@group(%u) @binding(%u) var r%u_%u: sampler;\n", g, sb - 1, g, sb - 1);
      char *at = strstr(text, decl);
      if (!at)
         continue;
      /* The twin's declaration after the sampler's (once), then every sampling of the texture with the sampler (the
       * name a whole word: `r0_2` isn't the end of `r10_2`). */
      struct wg_json out = { 0 };
      const char *q = at + strlen(decl);
      if (strstr(text, twin))
         wg_json_printf(&out, "%.*s", (int)(q - text), text);
      else
         wg_json_printf(&out, "%.*s%s", (int)(q - text), text, twin);
      for (;;) {
         const char *f = strstr(q, from);
         while (f && (f[-1] == '_' || (f[-1] >= '0' && f[-1] <= '9') || (f[-1] >= 'a' && f[-1] <= 'z') ||
                      (f[-1] >= 'A' && f[-1] <= 'Z')))
            f = strstr(f + 1, from);
         if (!f) {
            wg_json_printf(&out, "%s", q);
            break;
         }
         wg_json_printf(&out, "%.*s%s", (int)(f - q), q, to);
         q = f + strlen(from);
      }
      free(text);
      text = strdup(out.data);
      wg_json_free(&out);
      changed = true;
   }
   if (!changed) {
      free(text);
      return NULL;
   }
   return text;
}

static struct wgsl_print_options
print_options(const struct wgsl_varyings *fs)
{
   return (struct wgsl_print_options){
      .fs = fs,
      .max_immediates = wg_max_immediates,
      .max_workgroup_storage = wg_limits.max_compute_workgroup_storage_size,
      .max_uniform_size = wg_limits.max_uniform_buffer_binding_size,
      .features = ((wg_features & WG_FEATURE_TIER2) ? WGSL_TIER2 : 0) |
                  ((wg_features & WG_FEATURE_DUAL_SOURCE) ? WGSL_DUAL_SOURCE : 0) |
                  (wg_subgroup_size() > 1 ? WGSL_SUBGROUPS : 0) | ((wg_features & WG_FEATURE_F16) ? WGSL_F16 : 0),
   };
}

/* A stage printed against a variant's sampler keys, NULL if none is of a pair it samples (its own text serves). */
static char *
keyed_text(const struct wg_program *v, const struct wg_stage_nir *n, const struct wgsl_info *info, mesa_shader_stage stage)
{
   if (!v->key_count || !n)
      return NULL;
   bool touched = false;
   for (uint32_t k = 0; k < v->key_count && !touched; k++) {
      for (uint32_t i = 0; i < info->pair_count; i++)
         touched |= info->pairs[i][0] == v->keys[k].texture && info->pairs[i][1] == v->keys[k].sampler;
      for (uint32_t i = 0; i < info->int_pair_count; i++)
         touched |= info->int_pairs[i][0] == v->keys[k].texture && info->int_pairs[i][1] == v->keys[k].sampler;
      /* A padded texture's size queries, a stage that doesn't sample it (no NIR kept if it samples nothing at all). */
      for (uint32_t i = 0; v->keys[k].padded && i < info->resource_count; i++)
         touched |= ((uint32_t)info->resources[i].group << 16 | info->resources[i].binding) == v->keys[k].texture;
   }
   if (!touched)
      return NULL;
   struct blob_reader r;
   blob_reader_init(&r, n->data, n->size);
   nir_shader *nir = nir_deserialize(NULL, wgsl_nir_options(), &r);
   struct wgsl_print_options options = print_options(n->has_fs ? &n->fs : NULL);
   options.keys = v->keys;
   options.key_count = v->key_count;
   struct wgsl_info *printed = malloc(sizeof(*printed));
   char error[512] = "";
   char *text = wgsl_print(NULL, nir, &options, printed, error, sizeof(error));
   char *out = text ? strdup(text) : NULL;
   if (!text)
      fprintf(stderr, "wg: a stage's samplers didn't translate: %s\n", error);
   ralloc_free(text);
   ralloc_free(nir);
   free(printed);
   return out;
}

/* A variant's module of `wgsl` (0: the stage's own serves it). */
static uint32_t
variant_module(const struct wg_program *p, const struct wg_program *v, const uint64_t *mask, const char *wgsl,
               const struct wg_stage_nir *nir, const struct wgsl_info *info, mesa_shader_stage stage)
{
   char *keyed = keyed_text(v, nir, info, stage);
   char *text = variant_text(p, v, mask, keyed ? keyed : wgsl);
   if (text)
      free(keyed);
   else
      text = keyed;
   if (!text)
      return 0;
   const uint32_t m = wg_id();
   gpu_shader(m, text, strlen(text));
   free(text);
   return m;
}

/* A variant's render modules (wg_render_pipeline), made at its first render pipeline from its stages' WGSL. */
void
wg_variant_modules(struct wg_program *v, const struct wg_shader *vs, const struct wg_shader *fs)
{
   if ((!v->split_count && !v->key_count) || v->stage_modules_made)
      return;
   v->stage_modules_made = true;
   v->vs_module = vs ? variant_module(v->base, v, v->mask, vs->wgsl, vs->nir, &vs->info, MESA_SHADER_VERTEX) : 0;
   v->fs_module = fs ? variant_module(v->base, v, v->mask, fs->wgsl, fs->nir, &fs->info, MESA_SHADER_FRAGMENT) : 0;
}

/* `twin` into `v`'s resources before index `at` (a split sampler's twin, at the binding before it). */
static void
insert_resource(struct wg_program *v, uint32_t at, const struct wgsl_resource *twin)
{
   for (uint32_t i = v->resource_count; i > at; i--) {
      v->resources[i] = v->resources[i - 1];
      v->dynamic[i] = v->dynamic[i - 1];
      v->res_set[i] = v->res_set[i - 1];
      v->vis[i] = v->vis[i - 1];
   }
   v->resources[at] = *twin;
   v->dynamic[at] = -1;
   v->resource_count++;
}

static uint32_t
res_index(const struct wgsl_resource *r)
{
   return (uint32_t)r->group << 16 | r->binding;
}

/* A compute program's pairs are its one stage's. */
static struct wgsl_info
compute_pairs(const struct wg_program *p)
{
   struct wgsl_info i;
   i.pair_count = p->pair_count;
   i.int_pair_count = p->int_pair_count;
   i.resource_count = p->resource_count;
   memcpy(i.pairs, p->pairs, sizeof(i.pairs));
   memcpy(i.int_pairs, p->int_pairs, sizeof(i.int_pairs));
   memcpy(i.resources, p->resources, sizeof(i.resources));
   return i;
}

struct wg_program *
wg_program_variant(struct wg_program *p, const uint64_t *mask, const struct wgsl_sampler_key *keys, uint32_t key_count)
{
   for (struct wg_program *v = p->variants; v; v = v->variants)
      if (v->mask[0] == mask[0] && v->mask[1] == mask[1] && v->key_count == key_count &&
          !memcmp(v->keys, keys, key_count * sizeof(*keys)))
         return v;
   struct wg_program *v = malloc(sizeof(*v));
   memcpy(v, p, sizeof(*v));
   v->refs = 1;
   v->listed = false;
   v->merged = NULL;
   v->pipelines = NULL;
   v->pulls = NULL;
   v->push_group = 0;
   v->push_group_gen = 0;
   v->compute = 0;
   v->compute_wgsl = NULL;
   v->compute_nir = NULL;
   v->owns_compute_module = false;
   v->base = p;
   v->key_count = key_count;
   v->keys = malloc(MAX2(key_count, 1) * sizeof(*keys));
   memcpy(v->keys, keys, key_count * sizeof(*keys));
   v->split_count = 0;
   v->vs_module = v->fs_module = 0;
   v->stage_modules_made = false;
   memcpy(v->mask, mask, sizeof(v->mask));
   bool widened = false;
#define MASKED(k) (mask[(k) / 64] & (1ull << ((k) % 64)))
   for (uint32_t k = 0; k < p->resource_count; k++) {
      if (!MASKED(k))
         continue;
      /* A read-only storage buffer beside a writable one of its memory: "storage" (wg_cmd.c `program_for`). */
      if (v->resources[k].kind == WGSL_STORAGE_READ) {
         v->resources[k].kind = WGSL_STORAGE;
         widened = true;
         continue;
      }
      v->resources[k].sample = WGSL_SAMPLE_UNFILTERABLE;
   }
   /* An unfilterable texture's samplers: non-filtering (the bind group gives them the sampler's nearest twin), or,
    * where a sampler also samples a filterable texture (VK3 L7a, the binding review's finding 2: HLSL's shared
    * samplers), split: its nearest twin at the binding before it (a separate sampler's slot leaves it free) for the
    * unfilterable textures, the sampler itself for the rest. */
   for (uint32_t r = 0; r < p->resource_count; r++) {
      if (p->resources[r].kind != WGSL_SAMPLER)
         continue;
      const uint32_t sidx = res_index(&p->resources[r]);
      bool unfilterable = false, filterable = false;
      for (uint32_t i = 0; i < p->pair_count; i++)
         for (uint32_t k = 0; p->pairs[i][1] == sidx && k < p->resource_count; k++)
            if (res_index(&p->resources[k]) == p->pairs[i][0] && p->resources[k].kind == WGSL_TEXTURE) {
               if (MASKED(k))
                  unfilterable = true;
               else if (p->resources[k].sample == WGSL_SAMPLE_FLOAT && !p->resources[k].multisampled)
                  filterable = true;
            }
      if (!unfilterable)
         continue;
      const uint32_t b = p->resources[r].binding;
      /* A separate sampler is at its slot's odd binding, the even one free (a combined image sampler's texture). */
      const bool free = (b & 1) && (r == 0 || p->resources[r - 1].group != p->resources[r].group ||
                                    p->resources[r - 1].binding != b - 1);
      uint32_t at = 0;
      while (at < v->resource_count && res_index(&v->resources[at]) != sidx)
         at++;
      /* The twin is a sampler more in each stage that sees it (wg_caps.c "The bindings WebGPU takes"). */
      uint32_t samplers = 0;
      for (uint32_t k = 0; at < v->resource_count && k < v->resource_count; k++)
         samplers += (v->resources[k].kind == WGSL_SAMPLER || v->resources[k].kind == WGSL_SAMPLER_COMPARE) &&
                     (v->vis[k] & v->vis[at]);
      if (!filterable || !free || v->resource_count == WGSL_MAX_RESOURCES || samplers >= wg_limits.max_samplers) {
         v->resources[at].nonfiltering = true;
         continue;
      }
      uint32_t added = 0;
      for (uint32_t i = 0; i < p->pair_count; i++)
         for (uint32_t k = 0; p->pairs[i][1] == sidx && k < p->resource_count; k++)
            if (res_index(&p->resources[k]) == p->pairs[i][0] && MASKED(k) &&
                v->split_count < ARRAY_SIZE(v->splits)) {
               v->splits[v->split_count][0] = p->resources[r].group;
               v->splits[v->split_count][1] = p->resources[k].binding;
               v->splits[v->split_count++][2] = b;
               added++;
            }
      if (!added) {
         v->resources[at].nonfiltering = true;
         continue;
      }
      struct wgsl_resource twin = p->resources[r];
      twin.binding = b - 1;
      twin.nonfiltering = true;
      insert_resource(v, at, &twin);
   }
#undef MASKED
   /* A padded cube is bound as its faces (wgsl_sampler.c fetches from them). */
   for (uint32_t i = 0; i < key_count; i++)
      for (uint32_t k = 0; keys[i].faces && k < v->resource_count; k++)
         if (res_index(&v->resources[k]) == keys[i].texture)
            v->resources[k].dim = WGSL_DIM_2D_ARRAY;
   program_layouts(v);
   if ((widened || v->split_count || v->key_count) && p->compute_wgsl) {
      const struct wgsl_info keyed = compute_pairs(p);
      const uint32_t m = variant_module(p, v, mask, p->compute_wgsl, p->compute_nir, &keyed, MESA_SHADER_COMPUTE);
      if (m) {
         v->compute_module = m;
         v->owns_compute_module = true;
      }
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
   m->nonfiltering |= r->nonfiltering;
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
      /* A vertex stage captured by transform feedback runs as compute too, on the draw's bind groups (VK3 L7.4). */
      const uint8_t stage = shaders[s]->vk.stage == MESA_SHADER_VERTEX ? (wg_shader_xfb(shaders[s]) ? 1 | 4 : 1)
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
         } else if (!known) {
            p->pairs_full = true;
         }
      }
      for (uint32_t i = 0; i < info->int_pair_count; i++) {
         bool known = false;
         for (uint32_t k = 0; k < p->int_pair_count; k++)
            known |= p->int_pairs[k][0] == info->int_pairs[i][0] && p->int_pairs[k][1] == info->int_pairs[i][1];
         if (!known && p->int_pair_count < WGSL_MAX_PAIRS) {
            p->int_pairs[p->int_pair_count][0] = info->int_pairs[i][0];
            p->int_pairs[p->int_pair_count++][1] = info->int_pairs[i][1];
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
      if (r->group == WGSL_MAX_GROUPS - 1 && r->binding == WGSL_ADDRESS_BINDING)
         continue;
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
   X(push_ubo_size) X(vis) X(pair_count) X(pairs) X(int_pair_count) X(int_pairs)
#define RESOURCE_FIELDS(X)                                                                                             \
   X(group) X(binding) X(kind) X(dim) X(sample) X(multisampled) X(atomic) X(written) X(nonfiltering) X(image_words) X(access) \
   X(format) X(size)

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
program_objects(struct wg_program *p, uint32_t compute_module, const char *wgsl, const struct wg_stage_nir *nir)
{
   program_layouts(p);
   if (compute_module) {
      p->compute_wgsl = strdup(wgsl);
      p->compute_nir = stage_nir_copy(nir);
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
   for (uint32_t i = 0; i < b->int_pair_count; i++) {
      bool known = false;
      for (uint32_t k = 0; k < m->int_pair_count; k++)
         known |= m->int_pairs[k][0] == b->int_pairs[i][0] && m->int_pairs[k][1] == b->int_pairs[i][1];
      if (!known && m->int_pair_count < WGSL_MAX_PAIRS) {
         m->int_pairs[m->int_pair_count][0] = b->int_pairs[i][0];
         m->int_pairs[m->int_pair_count++][1] = b->int_pairs[i][1];
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
   stage_nir_free(s->nir);
   vk_shader_free(dev, pAllocator, &s->vk);
}

/* Uniform buffers past what WebGPU binds a stage (VK3 L7.4: ANGLE's ES3 wants 12 besides its own): read as read-only
 * storage (wgsl_nir.c `lower_ubo_storage`). A stage's uniform bindings are its uniform buffers, a texel buffer's
 * parameters each and the push buffer's (counted always: whether a stage reads push constants past the immediates
 * isn't known by the layout). The pipeline layout decides, by the stages each binding's flags name, so that every
 * stage that sees a buffer reads it the same way: a uniform buffer past its stage's room, in set and binding order, is
 * storage in all of them (dynamic ones never: they take the room first, and WebGPU's dynamic storage buffers are fewer).
 * wg_caps.c reports the uniform buffers WG_FOLDED_UBOS more, less the push buffer's, and the storage buffers
 * WG_FOLDED_UBOS fewer. */
static void
fold_uniforms(struct wgsl_layout *out, struct vk_descriptor_set_layout *const *layouts)
{
   static const VkShaderStageFlags stages[] = { VK_SHADER_STAGE_VERTEX_BIT, VK_SHADER_STAGE_FRAGMENT_BIT,
                                                VK_SHADER_STAGE_COMPUTE_BIT };
   for (uint32_t st = 0; st < ARRAY_SIZE(stages); st++) {
      int32_t room = (int32_t)wg_limits.max_uniform_buffers - 1;
      for (int pass = 0; pass < 2; pass++) {
         for (uint32_t s = 0; s < out->set_count; s++) {
            if (!layouts[s])
               continue;
            const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
            for (uint32_t b = 0; b < l->binding_count; b++) {
               if (l->first[b] < 0 || !(l->stages[b] & stages[st]))
                  continue;
               const VkDescriptorType t = l->type[b];
               if (pass == 0) {
                  if (t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || t == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER ||
                      t == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER)
                     room -= l->count[b];
                  continue;
               }
               if (t != VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER && t != VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
                  continue;
               for (uint32_t e = 0; e < l->count[b]; e++) {
                  if (room-- > 0)
                     continue;
                  const uint32_t slot = out->sets[s].base + l->first[b] + e;
                  if (slot < 64 * WGSL_UBO_STORAGE_WORDS)
                     out->ubo_storage[out->sets[s].group][slot / 64] |= 1ull << (slot % 64);
               }
            }
         }
      }
   }
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
                                               .first = l->first, .count = l->count, .ycbcr = l->ycbcr,
                                               .planes = l->planes };
   }
   fold_uniforms(out, layouts);
}

/* The lowered stage as variants will print it, if it samples (what wgsl_print's first step decides by samplers). */
static struct wg_stage_nir *
stage_nir_keep(const nir_shader *nir, const struct wgsl_varyings *fs)
{
   /* Any texture op: a padded texture's size query is printed against its key too. */
   bool samples = false;
   nir_foreach_function_impl (impl, nir)
      nir_foreach_block (block, impl)
         nir_foreach_instr (instr, block)
            if (instr->type == nir_instr_type_tex) {
               samples |= nir_instr_as_tex(instr)->sampler_dim != GLSL_SAMPLER_DIM_BUF;
            }
   if (!samples)
      return NULL;
   struct blob b;
   blob_init(&b);
   nir_serialize(&b, nir, true);
   struct wg_stage_nir *n = calloc(1, sizeof(*n));
   blob_finish_get_buffer(&b, &n->data, &n->size);
   n->has_fs = fs != NULL;
   if (fs)
      n->fs = *fs;
   return n;
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
      if (infos[i].stage == MESA_SHADER_FRAGMENT && sample_shading(state))
         infos[i].nir->info.fs.uses_sample_shading = true;
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
         const struct wgsl_print_options options = print_options(infos[i].stage == MESA_SHADER_VERTEX ? fs_reads : NULL);
         s->nir = stage_nir_keep(infos[i].nir, options.fs);
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
               /* A storage image one stage reaches by an atomic (so as its words, a buffer) and another as a texture. */
               if (x->group == y->group && x->binding == y->binding && (x->image_words != y->image_words)) {
                  snprintf(error, sizeof(error), "a storage image with atomics in one stage only (group %u binding %u)",
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
   /* The program, if its bindings fit WebGPU's limits (wg_caps.c `wg_bindings_fit`: else the pipeline is refused,
    * saying why, never an invalid submit; VK3 L7a). A captured vertex stage's compute pass that doesn't fit, or has
    * no bind group left (the push buffer's or sets 3 and up take the fourth), drops the capture instead. */
   struct wg_program *made = NULL;
   if (ok) {
      made = program_create(shaders, count, infos[0].set_layouts, infos[0].set_layout_count);
      struct wg_shader *xvs = NULL;
      for (uint32_t i = 0; i < count; i++)
         if (infos[i].stage == MESA_SHADER_VERTEX && wg_shader_xfb(shaders[i]))
            xvs = shaders[i];
      char why[256] = "";
      const bool fits = wg_bindings_fit(made, infos[0].set_layouts, why, sizeof(why));
      if (xvs && (!fits || made->group_count >= WGSL_MAX_GROUPS)) {
         if (fits)
            snprintf(why, sizeof(why), "its compute pass needs a fifth bind group (the push buffer's or sets 3 and up "
                                       "take the fourth)");
         fprintf(stderr, "wg: a vertex stage's transform feedback refused: %s\n", why);
         memset(xvs->info.xfb_stride, 0, sizeof(xvs->info.xfb_stride));
         free(made);
         made = program_create(shaders, count, infos[0].set_layouts, infos[0].set_layout_count);
      }
      if (made->pairs_full) {
         snprintf(error, sizeof(error), "the stages sample more than %u texture-sampler pairs", WGSL_MAX_PAIRS);
         free(made);
         made = NULL;
         ok = false;
      } else if (!wg_bindings_fit(made, infos[0].set_layouts, error, sizeof(error))) {
         free(made);
         made = NULL;
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
         stage_nir_free(shaders[i]->nir);
         shaders[i]->nir = NULL;
         out[i] = &shaders[i]->vk;
      }
      return VK_SUCCESS;
   }

   /* A program of the same link already made (its other stages loaded from a cache, or the same pipeline made
    * again) is shared: a draw needs its vertex and fragment shaders on one program. */
   struct wg_program *p = made;
   program_link(p, shaders, count);
   struct wg_program *same = program_find(p->link);
   if (same) {
      free(p);
      p = same;
      p->refs += count;
   } else {
      p->refs = count;
      program_objects(p, infos[0].stage == MESA_SHADER_COMPUTE ? shaders[0]->module : 0, shaders[0]->wgsl, shaders[0]->nir);
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
#define WG_SHADER_FORMAT 5

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
   blob_write_uint32(blob, s->nir ? (uint32_t)s->nir->size : 0);
   if (s->nir) {
      blob_write_bytes(blob, s->nir->data, s->nir->size);
      blob_write_uint32(blob, s->nir->has_fs);
      blob_write_bytes(blob, &s->nir->fs, sizeof(s->nir->fs));
   }
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
   const uint32_t nir_size = blob_read_uint32(blob);
   if (nir_size && !blob->overrun) {
      const void *data = blob_read_bytes(blob, nir_size);
      s->nir = calloc(1, sizeof(*s->nir));
      s->nir->size = nir_size;
      s->nir->has_fs = blob_read_uint32(blob);
      blob_copy_bytes(blob, &s->nir->fs, sizeof(s->nir->fs));
      if (!blob->overrun) {
         s->nir->data = malloc(nir_size);
         memcpy(s->nir->data, data, nir_size);
      }
   }
   blob_copy_bytes(blob, &s->info, sizeof(s->info));
   struct wg_program *p = calloc(1, sizeof(*p));
   if (!p) {
      vk_shader_free(device, pAllocator, &s->vk);
      return vk_error(device, VK_ERROR_OUT_OF_HOST_MEMORY);
   }
   program_read(blob, p);
   blob_copy_bytes(blob, p->link, sizeof(blake3_hash));
   if (blob->overrun || !wgsl || p->resource_count > WGSL_MAX_RESOURCES || p->group_count > WGSL_MAX_GROUPS ||
       p->pair_count > WGSL_MAX_PAIRS || p->int_pair_count > WGSL_MAX_PAIRS || p->set_count > WGSL_MAX_SETS) {
      free(p);
      stage_nir_free(s->nir);
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
      program_objects(p, stage == MESA_SHADER_COMPUTE ? s->module : 0, s->wgsl, s->nir);
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
      if (!stride || offset + size <= stride || k->vb[b].pull)
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
      if (free < 0 || offset - base + size > stride) {
         out->stuck |= 1u << b;
         continue;
      }
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

void
wg_vertex_pull(struct wg_pipeline_key *k, uint32_t inputs, const uint64_t *bound)
{
   bool past = false;
   u_foreach_bit(loc, inputs) {
      if (!k->attr[loc].format)
         continue;
      const uint32_t b = k->attr[loc].binding, size = vk_format_get_blocksize(k->attr[loc].format);
      if ((k->vb[b].stride & 3) || (bound[b] & 3) || (k->attr[loc].offset % MIN2(size, 4)))
         k->vb[b].pull = 1;
      past |= k->vb[b].stride && k->attr[loc].offset + size > k->vb[b].stride;
   }
   if (!past)
      return;
   struct wg_vertex_slots slots;
   wg_vertex_slots(k, inputs, &slots);
   u_foreach_bit(b, slots.stuck)
      k->vb[b].pull = 1;
}

const struct wg_pull *
wg_pipeline_pull(struct wg_program *p, const struct wg_pipeline_key *k)
{
   uint32_t mask = 0;
   u_foreach_bit(loc, k->vs->info.inputs)
      if (k->attr[loc].format && k->vb[k->attr[loc].binding].pull)
         mask |= 1u << k->attr[loc].binding;
   if (!mask)
      return NULL;
   for (struct wg_pull *u = p->pulls; u; u = u->next)
      if (u->slots == mask)
         return u;
   /* The first group without resources: past the program's, or one it leaves empty below its push buffer's group 3. */
   uint32_t used = 0;
   for (uint32_t i = 0; i < p->resource_count; i++)
      used |= 1u << p->resources[i].group;
   const uint32_t group = ffs(~used) - 1;
   if (group > MIN2(p->group_count, WGSL_MAX_GROUPS - 1)) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: no bind group left to pull a vertex binding WebGPU refuses from\n");
      warned = true;
      return NULL;
   }
   struct wg_pull *u = calloc(1, sizeof(*u));
   u->slots = mask;
   u->group = group;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"entries\":[");
   u_foreach_bit(s, mask)
      wg_json_printf(&j, "{\"binding\":%u,\"visibility\":1,\"buffer\":{\"type\":\"read-only-storage\"}},", s);
   wg_json_printf(&j, "{\"binding\":8,\"visibility\":1,\"buffer\":{\"type\":\"uniform\"}}]}");
   u->bgl = wg_create_json(WG_KIND_BGL, &j);
   wg_json_printf(&j, "{\"bindGroupLayouts\":[");
   for (uint32_t g = 0; g < MAX2(p->group_count, group + 1); g++)
      wg_json_printf(&j, "%s%u", g ? "," : "", g == group ? u->bgl : p->bgl[g]);
   wg_json_printf(&j, "],\"immediateSize\":%u}", p->immediate_size);
   u->layout = wg_create_json(WG_KIND_LAYOUT, &j);
   u->next = p->pulls;
   p->pulls = u;
   return u;
}

/* A fragment stage that writes depth into an attachment without a depth aspect: Vulkan drops the write, WebGPU refuses the
 * pipeline. The output, at a location no target takes, goes nowhere (a location past the stage's own). */
static uint32_t
fragment_without_depth(struct wg_program *p, const struct wg_shader *fs)
{
   if (p->fs_no_depth && p->fs_no_depth_of == fs)
      return p->fs_no_depth;
   char *keyed = keyed_text(p, fs->nir, &fs->info, MESA_SHADER_FRAGMENT);
   char *text = p->split_count ? variant_text(p->base, p, p->mask, keyed ? keyed : fs->wgsl) : NULL;
   if (!text)
      text = keyed ? strdup(keyed) : strdup(fs->wgsl);
   free(keyed);
   static const char from[] = "@builtin(frag_depth)", to[] = "@location(7)        ";
   char *at = strstr(text, from);
   if (at)
      memcpy(at, to, sizeof(to) - 1);
   wg_id_release(p->fs_no_depth);
   p->fs_no_depth = wg_id();
   p->fs_no_depth_of = fs;
   gpu_shader(p->fs_no_depth, text, strlen(text));
   free(text);
   return p->fs_no_depth;
}

uint32_t
wg_render_pipeline(struct wg_program *p, const struct wg_pipeline_key *k)
{
   if (!p->pipelines)
      p->pipelines = _mesa_hash_table_create(NULL, key_hash, key_equal);
   struct hash_entry *e = _mesa_hash_table_search(p->pipelines, k);
   if (e)
      return (uint32_t)(uintptr_t)e->data;
   wg_variant_modules(p, k->vs, k->fs);

   struct wg_json j = { 0 };
   const struct wg_pull *pull = wg_pipeline_pull(p, k);
   wg_json_printf(&j, "{\"layout\":%u,\"vertex\":{\"module\":%u,\"entryPoint\":\"main\","
                  "\"constants\":{\"wg_flip_y\":%d,\"wg_flip_z\":%d",
                  pull ? pull->layout : p->layout, p->vs_module ? p->vs_module : k->vs->module, k->flip ? 1 : -1,
                  k->flip_z ? 1 : 0);
   if (k->vs->info.uses_view)
      wg_json_printf(&j, ",\"wg_view\":%u", k->view);
   wg_json_printf(&j, "},");
   if (pull)
      wg_json_printf(&j, "\"pullGroup\":%u,", pull->group);
   wg_json_printf(&j, "\"buffers\":[");
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
      wg_json_printf(&j, "%s{%s\"arrayStride\":%u,\"stepMode\":\"%s\",\"attributes\":[", b ? "," : "",
                     pull && (pull->slots & (1u << b)) ? "\"pull\":true," : "", k->vb[binding].stride,
                     k->vb[binding].instance ? "instance" : "vertex");
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
      const struct wg_texture_format *ds = k->depth ? wg_texture_format(k->depth) : NULL;
      const bool depth_dropped = k->fs->info.writes_depth && !(ds && (ds->flags & WG_FMT_DEPTH));
      wg_json_printf(&j, ",\"fragment\":{\"module\":%u,\"entryPoint\":\"main\",",
                     depth_dropped ? fragment_without_depth(p, k->fs) : p->fs_module ? p->fs_module : k->fs->module);
      /* At the sample rate, the samples' positions follow the pipeline's count (wgsl_print.c `wg_sample_pos`). */
      if (k->fs->info.per_sample && k->fs->info.uses_view)
         wg_json_printf(&j, "\"constants\":{\"wg_samples\":%u,\"wg_view\":%u},", k->samples, k->view);
      else if (k->fs->info.per_sample)
         wg_json_printf(&j, "\"constants\":{\"wg_samples\":%u},", k->samples);
      else if (k->fs->info.uses_view)
         wg_json_printf(&j, "\"constants\":{\"wg_view\":%u},", k->view);
      wg_json_printf(&j, "\"targets\":[");
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
   /* Transform feedback (the worker's, not WebGPU's): the vertex stage's records (wgsl.h) and the program's layouts,
    * for the compute pass that runs it on the draw's bind groups (web/venus-gpu.ts `xfbPipeline`). */
   if (wg_shader_xfb(k->vs)) {
      const struct wgsl_info *x = &k->vs->info;
      wg_json_printf(&j, ",\"xfb\":{\"stride\":[%u,%u,%u,%u],\"base\":[%u,%u,%u,%u],\"words\":[", x->xfb_stride[0],
                     x->xfb_stride[1], x->xfb_stride[2], x->xfb_stride[3], x->xfb_base[0], x->xfb_base[1],
                     x->xfb_base[2], x->xfb_base[3]);
      for (uint32_t b = 0; b < 4; b++)
         wg_json_printf(&j, "%s[%u,%u,%u,%u]", b ? "," : "", x->xfb_words[b][0], x->xfb_words[b][1],
                        x->xfb_words[b][2], x->xfb_words[b][3]);
      wg_json_printf(&j, "],\"bgls\":[");
      for (uint32_t g = 0; g < p->group_count; g++)
         wg_json_printf(&j, "%s%u", g ? "," : "", p->bgl[g]);
      wg_json_printf(&j, "],\"immediateSize\":%u}", p->immediate_size);
   }
   wg_json_printf(&j, "}");
   const uint32_t id = wg_create_json(WG_KIND_RENDER, &j);
   struct wg_pipeline_key *copy = malloc(sizeof(*copy));
   memcpy(copy, k, sizeof(*copy));
   _mesa_hash_table_insert(p->pipelines, copy, (void *)(uintptr_t)id);
   return id;
}
