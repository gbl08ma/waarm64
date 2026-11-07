/*
 * Shaders and pipelines on the runtime's vk_shader path (wg_private.h): vk_pipeline.c turns pipelines into shaders
 * and dynamic state, and calls `compile` with a pipeline's stages together; we translate them (vk/compiler/: lowered
 * against the pipeline's set layouts, a vertex and fragment shader linked, the fragment shader printed first so the
 * vertex shader's outputs follow its inputs), make their WebGPU modules and what the stages share (wg_program: bind
 * group layouts, a pipeline layout). A render pipeline bakes in what Vulkan 1.3 leaves dynamic, so it is made at the
 * first draw that needs it (wg_render_pipeline) and kept by that state. KosmicKrisp's kk_shader.c is the model (MIT).
 */
#include <stdarg.h>
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
   for (struct wg_based *u = p->based, *next; u; u = next) {
      next = u->next;
      wg_id_release(u->pipeline);
      free(u);
   }
   for (struct wg_pull *u = p->pulls, *next; u; u = next) {
      next = u->next;
      wg_id_release(u->bgl);
      wg_id_release(u->layout);
      free(u);
   }
   for (struct wg_dst *u = p->dsts, *next; u; u = next) {
      next = u->next;
      wg_id_release(u->bgl);
      wg_id_release(u->layout);
      free(u);
   }
   for (struct wg_dst_module *u = p->dst_modules, *next; u; u = next) {
      next = u->next;
      wg_id_release(u->id);
      free(u);
   }
   free(p->compute_wgsl);
   stage_nir_free(p->compute_nir);
   free(p->keys);
   free(p->aliases);
   free(p->refused);
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

static bool
name_char(char c)
{
   return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/* The first `from` in `text` from `q` on that doesn't end a longer name (`r0_2` isn't the end of `r10_2`). */
static char *
word_at(char *text, char *q, const char *from)
{
   char *f = strstr(q, from);
   while (f && f > text && name_char(f[-1]))
      f = strstr(f + 1, from);
   return f;
}

/* `text` with [at, at + n) as `with`, freed. */
static char *
spliced(char *text, size_t at, size_t n, const char *with)
{
   char *t = malloc(strlen(text) + strlen(with) + 1);
   memcpy(t, text, at);
   strcpy(t + at, with);
   strcat(t, text + at + n);
   free(text);
   return t;
}

/* A variant's text for its storage aliases (`wg_storage_alias`): each alias's words reached through the binding it's
 * part of (wgsl_print.c names storage words `rG_B[word]`), and arrayLength of every one of a run the size the shader
 * asks of it. */
static char *
aliased_text(const struct wg_program *v, char *text)
{
   for (uint32_t i = 0; i < v->alias_count; i++) {
      const struct wg_storage_alias *a = &v->aliases[i];
      char from[64], with[64];
      snprintf(from, sizeof(from), "arrayLength(&r%u_%u)", a->res >> 16, a->res & 0xffff);
      snprintf(with, sizeof(with), "%uu", a->bytes / 4);
      for (char *f; (f = word_at(text, text, from));)
         text = spliced(text, f - text, strlen(from), with);
      if (a->res == a->to)
         continue;
      snprintf(from, sizeof(from), "r%u_%u[", a->res >> 16, a->res & 0xffff);
      snprintf(with, sizeof(with), "r%u_%u[%uu + (", a->to >> 16, a->to & 0xffff, a->delta / 4);
      for (char *f; (f = word_at(text, text, from));) {
         /* Its closing bracket. */
         size_t end = f - text + strlen(from);
         for (int depth = 1; text[end] && depth; end++)
            depth += (text[end] == '[') - (text[end] == ']');
         const size_t head = f - text;
         text = spliced(text, end - 1, 1, ")]");
         text = spliced(text, head, strlen(from), with);
      }
   }
   return text;
}

/* A module's WGSL as a variant binds it (wgsl_print.c declares each `@group(g) @binding(b) var rG_B…` and samples as
 * `rG_T, rG_S, …`): widened storage buffers `read_write` (WebGPU wants a binding's access in the module to be its layout
 * entry's), each split sampler's unfilterable textures sampled through its twin at the binding before it, and storage
 * bindings of one range through one. NULL: no change. */
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
         while (f && name_char(f[-1]))
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
   if (v->alias_count) {
      text = aliased_text(v, text);
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
      .max_inter_stage = wg_limits.max_inter_stage_shader_variables,
      .storage_limits = true,
      .max_storage_textures = { MIN2(wg_limits.max_storage_textures, wg_limits.max_storage_textures_in_vertex_stage),
                                MIN2(wg_limits.max_storage_textures, wg_limits.max_storage_textures_in_fragment_stage),
                                wg_limits.max_storage_textures },
      .features = ((wg_features & WG_FEATURE_TIER2) ? WGSL_TIER2 : 0) | ((wg_features & WG_FEATURE_TIER1) ? WGSL_TIER1 : 0) |
                  ((wg_features & WG_FEATURE_DUAL_SOURCE) ? WGSL_DUAL_SOURCE : 0) |
                  (wg_subgroup_size() > 1 ? WGSL_SUBGROUPS : 0) | ((wg_features & WG_FEATURE_F16) ? WGSL_F16 : 0),
   };
}

/* What `r` of `count` resources are compared (wgsl_print_options.depths): `out` has room for WGSL_MAX_RESOURCES. */
static uint32_t
depth_textures(const struct wgsl_resource *r, uint32_t count, uint32_t *out)
{
   uint32_t n = 0;
   for (uint32_t i = 0; i < count; i++)
      if (r[i].kind == WGSL_TEXTURE && r[i].sample == WGSL_SAMPLE_DEPTH)
         out[n++] = (uint32_t)r[i].group << 16 | r[i].binding;
   return n;
}

/* A stage printed against a variant's sampler keys, NULL if none is of a pair it samples (its own text serves), or if
 * it can't be: `refused` says why, for the draws of the variant to say. */
static char *
keyed_text(const struct wg_program *v, const struct wg_stage_nir *n, const struct wgsl_info *info, char **refused)
{
   if (!v->key_count || !n)
      return NULL;
   bool touched = false;
   for (uint32_t k = 0; k < v->key_count && !touched; k++) {
      for (uint32_t i = 0; i < info->pair_count; i++)
         touched |= info->pairs[i][0] == v->keys[k].texture && info->pairs[i][1] == v->keys[k].sampler;
      for (uint32_t i = 0; i < info->int_pair_count; i++)
         touched |= info->int_pairs[i][0] == v->keys[k].texture && info->int_pairs[i][1] == v->keys[k].sampler;
      for (uint32_t i = 0; i < info->key_pair_count; i++)
         touched |= info->key_pairs[i][0] == v->keys[k].texture && info->key_pairs[i][1] == v->keys[k].sampler;
      /* A padded texture's size queries, or a cube's bound as its faces, a stage that doesn't sample it (no NIR kept if
       * it samples nothing at all). */
      for (uint32_t i = 0; (v->keys[k].padded || v->keys[k].faces || v->keys[k].rgb9e5) && i < info->resource_count; i++)
         touched |= ((uint32_t)info->resources[i].group << 16 | info->resources[i].binding) == v->keys[k].texture;
      /* A storage image without a format (GD G5), or written through a view of another format (GD G7). */
      for (uint32_t i = 0; v->keys[k].sampler == WGSL_IMAGE_KEY && i < info->resource_count; i++)
         touched |= wgsl_image_keyed(&info->resources[i]) &&
                    ((uint32_t)info->resources[i].group << 16 | info->resources[i].binding) == v->keys[k].texture;
   }
   if (!touched)
      return NULL;
   struct blob_reader r;
   blob_reader_init(&r, n->data, n->size);
   nir_shader *nir = nir_deserialize(NULL, wgsl_nir_options(), &r);
   struct wgsl_print_options options = print_options(n->has_fs ? &n->fs : NULL);
   options.keys = v->keys;
   options.key_count = v->key_count;
   uint32_t depths[WGSL_MAX_RESOURCES];
   options.depths = depths;
   options.depth_count = depth_textures(v->resources, v->resource_count, depths);
   for (uint32_t k = 0; k < v->resource_count; k++)
      options.push_storage |= v->dynamic[k] == WG_DYNAMIC_PUSH && v->resources[k].kind == WGSL_STORAGE_READ;
   struct wgsl_info *printed = malloc(sizeof(*printed));
   char error[512] = "";
   char *text = wgsl_print(NULL, nir, &options, printed, error, sizeof(error));
   char *out = text ? strdup(text) : NULL;
   if (!text && refused && !*refused)
      *refused = strdup(error);
   ralloc_free(text);
   ralloc_free(nir);
   free(printed);
   return out;
}

/* A variant's module of `wgsl` (0: the stage's own serves it). */
static uint32_t
variant_module(const struct wg_program *p, struct wg_program *v, const uint64_t *mask, const char *wgsl,
               const struct wg_stage_nir *nir, const struct wgsl_info *info)
{
   char *keyed = keyed_text(v, nir, info, &v->refused);
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
   if ((!v->split_count && !v->key_count && !v->alias_count) || v->stage_modules_made)
      return;
   v->stage_modules_made = true;
   v->vs_module = vs ? variant_module(v->base, v, v->mask, vs->wgsl, vs->nir, &vs->info) : 0;
   v->fs_module = fs ? variant_module(v->base, v, v->mask, fs->wgsl, fs->nir, &fs->info) : 0;
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
   i.key_pair_count = p->key_pair_count;
   i.resource_count = p->resource_count;
   memcpy(i.pairs, p->pairs, sizeof(i.pairs));
   memcpy(i.int_pairs, p->int_pairs, sizeof(i.int_pairs));
   memcpy(i.key_pairs, p->key_pairs, sizeof(i.key_pairs));
   memcpy(i.resources, p->resources, sizeof(i.resources));
   return i;
}

/* The integer and depth textures of a program's samplers that also sample a float texture: a variant's mask has them,
 * so that it splits those samplers, the float textures keeping their filters (wgsl_print.c makes such a sampler
 * non-filtering). */
void
wg_program_mixed(struct wg_program *p)
{
   p->mixed_known = true;
   for (uint32_t i = 0; i < p->pair_count; i++) {
      const struct wgsl_resource *r = NULL;
      for (uint32_t k = 0; k < p->resource_count; k++)
         if (res_index(&p->resources[k]) == p->pairs[i][0] && p->resources[k].kind == WGSL_TEXTURE)
            r = &p->resources[k];
      if (!r || r->sample == WGSL_SAMPLE_FLOAT || r->sample == WGSL_SAMPLE_UNFILTERABLE)
         continue;
      for (uint32_t j = 0; j < p->pair_count; j++)
         for (uint32_t k = 0; p->pairs[j][1] == p->pairs[i][1] && k < p->resource_count; k++)
            if (res_index(&p->resources[k]) == p->pairs[j][0] && p->resources[k].kind == WGSL_TEXTURE &&
                p->resources[k].sample == WGSL_SAMPLE_FLOAT && !p->resources[k].multisampled) {
               const uint32_t at = r - p->resources;
               p->mixed[at / 64] |= 1ull << (at % 64);
            }
   }
}

struct wg_program *
wg_program_variant(struct wg_program *p, const uint64_t *mask, const struct wgsl_sampler_key *keys, uint32_t key_count,
                   const struct wg_storage_alias *aliases, uint32_t alias_count)
{
   for (struct wg_program *v = p->variants; v; v = v->variants)
      if (v->mask[0] == mask[0] && v->mask[1] == mask[1] && v->key_count == key_count &&
          v->alias_count == alias_count && !memcmp(v->keys, keys, key_count * sizeof(*keys)) &&
          !memcmp(v->aliases, aliases, alias_count * sizeof(*aliases)))
         return v;
   struct wg_program *v = malloc(sizeof(*v));
   wg_emul[WG_EMUL_VARIANTS]++;
   memcpy(v, p, sizeof(*v));
   v->refs = 1;
   v->listed = false;
   v->merged = NULL;
   v->pipelines = NULL;
   v->pulls = NULL;
   v->dsts = NULL;
   v->dst_modules = NULL;
   v->push_group = 0;
   v->push_group_gen = 0;
   v->compute = 0;
   v->based = NULL;
   v->compute_wgsl = NULL;
   v->compute_nir = NULL;
   v->owns_compute_module = false;
   v->base = p;
   v->key_count = key_count;
   v->keys = malloc(MAX2(key_count, 1) * sizeof(*keys));
   memcpy(v->keys, keys, key_count * sizeof(*keys));
   v->alias_count = alias_count;
   v->aliases = malloc(MAX2(alias_count, 1) * sizeof(*aliases));
   memcpy(v->aliases, aliases, alias_count * sizeof(*aliases));
   v->split_count = 0;
   v->vs_module = v->fs_module = 0;
   v->fs_no_depth = 0; /* the base's is printed without this variant's keys */
   v->fs_no_depth_of = NULL;
   v->stage_modules_made = false;
   v->refused = NULL;
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
      if (v->resources[k].sample == WGSL_SAMPLE_FLOAT)
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
      v->resources[at].nonfiltering = false; /* an integer or depth texture's asked it of the whole binding */
      insert_resource(v, at, &twin);
   }
#undef MASKED
   /* An E5B9G9R9 view of words (VK4 T23): the shader fetches u32s of it (wgsl_sampler.c `fetch_keyed`). */
   for (uint32_t i = 0; i < key_count; i++)
      for (uint32_t k = 0; keys[i].rgb9e5 && k < v->resource_count; k++)
         if (res_index(&v->resources[k]) == keys[i].texture && v->resources[k].kind == WGSL_TEXTURE)
            v->resources[k].sample = WGSL_SAMPLE_UINT;
   /* A storage image without a format is the bound view's (GD G5): a storage texture of that format, or its words where
    * WebGPU has none for the access (as wgsl_print.c decides, `gather`), their parameters at the next binding. */
   for (uint32_t i = 0; i < key_count; i++) {
      if (keys[i].sampler != WGSL_IMAGE_KEY)
         continue;
      for (uint32_t k = 0; k < v->resource_count; k++) {
         struct wgsl_resource *r = &v->resources[k];
         if (res_index(r) != keys[i].texture || !wgsl_image_keyed(r))
            continue;
         const uint8_t access = r->access ? r->access : WGSL_ACCESS_READ;
         const unsigned features = ((wg_features & WG_FEATURE_TIER1) ? WGSL_TIER1 : 0) |
                                   ((wg_features & WG_FEATURE_TIER2) ? WGSL_TIER2 : 0);
         r->format = keys[i].format;
         if (r->kind == WGSL_STORAGE_TEXTURE && wgsl_image_as_words(keys[i].format, access, features) &&
             v->resource_count < WGSL_MAX_RESOURCES) {
            const bool written = access & WGSL_ACCESS_WRITE;
            r->kind = written ? WGSL_STORAGE : WGSL_STORAGE_READ;
            r->image_words = true;
            r->atomic = r->written = written;
            /* Its parameters in its group's table (made here if the group had none; program_layouts sorts it). */
            const uint8_t vis = v->vis[k];
            const uint32_t size = WGSL_TABLE_SIZE(r->binding), group = r->group;
            uint32_t t = 0;
            while (t < v->resource_count &&
                   (v->resources[t].group != group || v->resources[t].binding != WGSL_TABLE_BINDING))
               t++;
            if (t == v->resource_count) {
               const struct wgsl_resource table = { .group = group, .binding = WGSL_TABLE_BINDING,
                                                    .kind = WGSL_UNIFORM, .size = size };
               insert_resource(v, t, &table);
               v->vis[t] = 0;
               v->res_set[t] = -1;
            }
            v->resources[t].size = MAX2(v->resources[t].size, size);
            v->vis[t] |= vis;
         }
         break;
      }
   }
   /* A padded cube is bound as its faces (wgsl_sampler.c fetches from them). */
   for (uint32_t i = 0; i < key_count; i++)
      for (uint32_t k = 0; keys[i].faces && k < v->resource_count; k++)
         if (res_index(&v->resources[k]) == keys[i].texture)
            v->resources[k].dim = WGSL_DIM_2D_ARRAY;
   program_layouts(v);
   if ((widened || v->split_count || v->key_count || v->alias_count) && p->compute_wgsl) {
      const struct wgsl_info keyed = compute_pairs(p);
      const uint32_t m = variant_module(p, v, mask, p->compute_wgsl, p->compute_nir, &keyed);
      if (m) {
         v->compute_module = m;
         v->owns_compute_module = true;
      }
   }
   if (p->compute_module && !v->refused) {
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
   if (r->sample == WGSL_SAMPLE_DEPTH)
      m->sample = WGSL_SAMPLE_DEPTH;
}

/* A pair that needs a key into a program's, the wider of the two whens. */
static void
key_pair_merge(struct wg_program *p, const uint32_t *pair)
{
   for (uint32_t k = 0; k < p->key_pair_count; k++)
      if (p->key_pairs[k][0] == pair[0] && p->key_pairs[k][1] == pair[1]) {
         p->key_pairs[k][2] |= pair[2];
         return;
      }
   if (p->key_pair_count < WGSL_MAX_PAIRS)
      memcpy(p->key_pairs[p->key_pair_count++], pair, sizeof(p->key_pairs[0]));
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
      /* A vertex stage captured by transform feedback runs as compute too, on the draw's bind groups (VK3 L7.4); one
       * that writes storage as compute only (VK4 T33: a pass-through vertex stage draws its outputs). */
      const bool vs = shaders[s]->vk.stage == MESA_SHADER_VERTEX;
      p->vs_stores |= vs && wg_shader_stores(shaders[s]);
      const uint8_t stage = vs ? (wg_shader_stores(shaders[s]) ? 4 : wg_shader_xfb(shaders[s]) ? 1 | 4 : 1)
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
      for (uint32_t i = 0; i < info->key_pair_count; i++)
         key_pair_merge(p, info->key_pairs[i]);
      p->uses_base |= info->uses_base;
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
      if ((r->group == WGSL_MAX_GROUPS - 1 && r->binding == WGSL_ADDRESS_BINDING) || r->binding == WGSL_TABLE_BINDING)
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

/* The compute pipeline of a dispatch from a base (vkCmdDispatchBase): WebGPU's start at workgroup 0, so the ids the
 * shader reads are offset by overrides, a pipeline per base. One that reads no id needs none. */
uint32_t
wg_compute_based(struct wg_program *p, uint32_t x, uint32_t y, uint32_t z)
{
   if ((!x && !y && !z) || !p->uses_base)
      return p->compute;
   for (struct wg_based *u = p->based; u; u = u->next)
      if (u->base[0] == x && u->base[1] == y && u->base[2] == z)
         return u->pipeline;
   struct wg_based *u = malloc(sizeof(*u));
   u->base[0] = x, u->base[1] = y, u->base[2] = z;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"layout\":%u,\"compute\":{\"module\":%u,\"entryPoint\":\"main\",\"constants\":"
                  "{\"wg_base_x\":%u,\"wg_base_y\":%u,\"wg_base_z\":%u}}}", p->layout, p->compute_module, x, y, z);
   u->pipeline = wg_create_json(WG_KIND_COMPUTE, &j);
   u->next = p->based;
   p->based = u;
   return u->pipeline;
}

/* A program's data across runs (wg_serialize): everything program_create derives from its stages and set layouts.
 * The resources go field by field: a struct's padding is indeterminate, and a program's link hashes these bytes (two
 * stages of one link would otherwise get different programs, and a draw would lose its fragment shader). */
#define PROGRAM_FIELDS(X)                                                                                              \
   X(group_count) X(set_count) X(set_group) X(set_base) X(resource_count) X(dynamic) X(res_set) X(immediate_size)     \
   X(push_ubo_size) X(vis) X(pair_count) X(pairs) X(int_pair_count) X(int_pairs) X(key_pair_count) X(key_pairs)        \
   X(uses_base) X(vs_stores)
#define RESOURCE_FIELDS(X)                                                                                             \
   X(group) X(binding) X(kind) X(dim) X(sample) X(multisampled) X(atomic) X(signed_atomic) X(written) X(nonfiltering) X(image_words) X(image_texture) X(formatless) X(access) \
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

/* Whether two stages' resources can share one layout entry each; else `error` says why (their pipeline refused). */
static bool
stages_agree(const struct wgsl_info *xs_info, const struct wgsl_info *ys_info, char *error, size_t size)
{
   for (uint32_t i = 0; i < xs_info->resource_count; i++)
      for (uint32_t k = 0; k < ys_info->resource_count; k++) {
         const struct wgsl_resource *x = &xs_info->resources[i], *y = &ys_info->resources[k];
         if (x->group != y->group || x->binding != y->binding)
            continue;
         /* A storage image the stages bind with different access: its one layout entry can't match both modules'
          * (WebGPU wants each module's access to be the entry's), so the pipeline would be invalid (VK3 L4c-F). Or one
          * stage only reads it, as a texture (wgsl_print.c `texture_images`), and another writes it. */
         const bool xi = x->kind == WGSL_STORAGE_TEXTURE || x->image_texture;
         const bool yi = y->kind == WGSL_STORAGE_TEXTURE || y->image_texture;
         if (xi && yi && (x->kind != y->kind || x->access != y->access || x->sample != y->sample)) {
            snprintf(error, size, "a storage image the stages access differently (group %u binding %u)", x->group,
                     x->binding);
            return false;
         }
         /* A storage image one stage reaches as its words (a buffer) and another as a texture. */
         if (x->image_words != y->image_words) {
            snprintf(error, size, "a storage image as words in one stage only (group %u binding %u)", x->group,
                     x->binding);
            return false;
         }
         /* Likewise a storage buffer one stage writes and another only reads (the translator declares it read-only
          * where it isn't written, but in compute): that is a vertex stage reading what the fragment stage writes,
          * which WebGPU can't bind (no writable storage in vertex shaders). */
         const bool xb = x->kind == WGSL_STORAGE || x->kind == WGSL_STORAGE_READ;
         const bool yb = y->kind == WGSL_STORAGE || y->kind == WGSL_STORAGE_READ;
         if (xb && yb && x->kind != y->kind) {
            snprintf(error, size, "a storage buffer one stage writes and the vertex stage reads (group %u binding %u)",
                     x->group, x->binding);
            return false;
         }
      }
   return true;
}

/* A program of two programs' stages (`a`'s, a draw's vertex shader's, and `b`'s, its fragment shader's), for a draw
 * whose stages came with different links: each stage is lowered against its pipeline's layout, so both programs' data
 * describe one layout, and the union of their bindings serves both modules. Equal stages always share a link (a cached
 * stage keeps the link of its first compile, its partner compiled again gets the same), so this takes a cache whose
 * entries disagree; it is said once. Kept on `a`, by `b`'s link, and freed with it. */
struct wg_program *
wg_program_merge(struct wg_program *a, const struct wg_program *b, const struct wgsl_info *vs, const struct wgsl_info *fs)
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
   m->vs_stores = a->vs_stores || b->vs_stores;
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
   for (uint32_t i = 0; i < b->key_pair_count; i++)
      key_pair_merge(m, b->key_pairs[i]);
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
   /* Stages that disagree on a resource (what wg_shader_compile refuses, for stages compiled together): their draws
    * refused, saying why, not an invalid pipeline (VK4 T37). */
   char error[160];
   if (!stages_agree(vs, fs, error, sizeof(error)))
      m->refused = strdup(error);
   memcpy(m->with, b->link, sizeof(blake3_hash));
   m->merged = a->merged;
   a->merged = m;
   return m;
}

/* VK4 T37's test (wg_test.c `wgt_merge_refused`): a program merged of stages that disagree on a storage image (the
 * vertex stage reads it as a texture, the fragment stage writes it) is refused; of stages that agree, not. Bit 0 and bit
 * 1 for each as it should be. */
int
wg_merge_refuses(void)
{
   int ok = 0;
   for (uint32_t agree = 0; agree < 2; agree++) {
      struct wg_program *a = calloc(1, sizeof(*a)), *b = calloc(1, sizeof(*b));
      struct wgsl_info vi = { .resource_count = 1 }, fi = { .resource_count = 1 };
      vi.resources[0] = (struct wgsl_resource){ .kind = WGSL_TEXTURE, .dim = WGSL_DIM_2D, .sample = WGSL_SAMPLE_UINT,
                                                .image_texture = true, .format = PIPE_FORMAT_R32_UINT };
      fi.resources[0] = agree ? vi.resources[0]
                              : (struct wgsl_resource){ .kind = WGSL_STORAGE_TEXTURE, .dim = WGSL_DIM_2D,
                                                        .access = WGSL_ACCESS_WRITE, .format = PIPE_FORMAT_R32_UINT };
      a->refs = b->refs = 1;
      a->resource_count = b->resource_count = 1;
      a->group_count = b->group_count = a->set_count = b->set_count = 1;
      a->resources[0] = vi.resources[0], b->resources[0] = fi.resources[0];
      a->vis[0] = 1, b->vis[0] = 2;
      a->dynamic[0] = b->dynamic[0] = -1;
      b->link[0] = 1;
      const struct wg_program *m = wg_program_merge(a, b, &vi, &fi);
      ok |= (agree ? !m->refused : m->refused != NULL) << agree;
   }
   return ok;
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
 * storage (wgsl_nir.c `lower_ubo_storage`). A stage's uniform bindings are its uniform buffers, a parameter table for
 * each group with texel buffers or storage images (which may be words: VK4 T21) and the push buffer's (counted always:
 * whether a stage reads push constants past the immediates isn't known by the layout). The pipeline layout decides, by the stages each binding's flags name, so that every
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
      uint32_t tables = 0; /* the groups with a table, a bit each */
      for (int pass = 0; pass < 2; pass++) {
         for (uint32_t s = 0; s < out->set_count; s++) {
            if (!layouts[s])
               continue;
            const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
            for (uint32_t b = 0; b < l->binding_count; b++) {
               if (l->first[b] < 0 || !(l->stages[b] & stages[st]))
                  continue;
               /* A mutable binding by the types its list names (VK4 T34): a uniform buffer among them may be one. */
               const uint32_t t = l->types[b];
               if (pass == 0) {
                  if (t & wg_type_bit(VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC))
                     room -= l->count[b];
                  else if ((t & (wg_type_bit(VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER) |
                                 wg_type_bit(VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) |
                                 wg_type_bit(VK_DESCRIPTOR_TYPE_STORAGE_IMAGE))) && !(tables & (1u << out->sets[s].group)))
                     room--, tables |= 1u << out->sets[s].group;
                  continue;
               }
               if (!(t & (wg_type_bit(VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER) | wg_type_bit(VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK))))
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

/* Whether a layout's dynamic uniform buffers take all of WebGPU's, so that the push buffer, a dynamic binding of its own
 * (a draw's push constants at an offset), goes as dynamic storage. */
static bool
push_storage(struct vk_descriptor_set_layout *const *layouts, uint32_t count)
{
   uint32_t dynamic = 0;
   for (uint32_t s = 0; s < count; s++) {
      if (!layouts[s])
         continue;
      const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
      for (uint32_t b = 0; b < l->binding_count; b++)
         if (l->first[b] >= 0 && l->type[b] == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC)
            dynamic += l->count[b];
   }
   return dynamic >= wg_limits.max_dynamic_uniform_buffers;
}

/* The lowered stage as variants will print it, if it samples (what wgsl_print's first step decides by samplers). */
static struct wg_stage_nir *
stage_nir_keep(const nir_shader *nir, const struct wgsl_varyings *fs)
{
   /* Any texture op: a padded texture's size query is printed against its key too; a storage image declared without
    * a format, printed against the bound view's (GD G5); and a store with a declared one, whose view may be of another
    * format (GD G7). */
   bool samples = false;
   nir_foreach_function_impl (impl, nir)
      nir_foreach_block (block, impl)
         nir_foreach_instr (instr, block)
            if (instr->type == nir_instr_type_tex) {
               samples |= nir_instr_as_tex(instr)->sampler_dim != GLSL_SAMPLER_DIM_BUF;
            } else if (instr->type == nir_instr_type_intrinsic) {
               const nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
               samples |= (intr->intrinsic == nir_intrinsic_image_store || intr->intrinsic == nir_intrinsic_image_load ||
                           intr->intrinsic == nir_intrinsic_image_size) &&
                          nir_intrinsic_image_dim(intr) != GLSL_SAMPLER_DIM_BUF &&
                          (nir_intrinsic_format(intr) == PIPE_FORMAT_NONE || intr->intrinsic == nir_intrinsic_image_store);
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

   /* What any stage compares is a depth texture in all of them (a binding has one type). */
   uint32_t depths[WGSL_MAX_RESOURCES], depth_count = 0;
   for (uint32_t i = 0; i < count && ok; i++)
      nir_foreach_function_impl (impl, infos[i].nir)
         nir_foreach_block (block, impl)
            nir_foreach_instr (instr, block) {
               if (instr->type != nir_instr_type_tex || !nir_instr_as_tex(instr)->is_shadow)
                  continue;
               const uint32_t t = nir_instr_as_tex(instr)->texture_index;
               bool known = false;
               for (uint32_t k = 0; k < depth_count; k++)
                  known |= depths[k] == t;
               if (!known && depth_count < WGSL_MAX_RESOURCES)
                  depths[depth_count++] = t;
            }
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
         struct wgsl_print_options options = print_options(infos[i].stage == MESA_SHADER_VERTEX ? fs_reads : NULL);
         options.push_storage = push_storage(infos[i].set_layouts, infos[i].set_layout_count);
         options.depths = depths;
         options.depth_count = depth_count;
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
   for (uint32_t a = 0; ok && a < count; a++)
      for (uint32_t b = a + 1; ok && b < count; b++)
         ok = stages_agree(&shaders[a]->info, &shaders[b]->info, error, sizeof(error));
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
      /* A vertex stage that stores runs once, before its draw (VK4 T33): a capture after the pass would run it again. */
      if (xvs && wg_shader_stores(xvs)) {
         fprintf(stderr, "wg: a vertex stage's transform feedback refused: the stage writes storage\n");
         memset(xvs->info.xfb_stride, 0, sizeof(xvs->info.xfb_stride));
         xvs = NULL;
      }
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
#define WG_SHADER_FORMAT 6

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

bool
wg_counts_sane(uint32_t resources, uint32_t pairs, uint32_t int_pairs, uint32_t key_pairs)
{
   return resources <= WGSL_MAX_RESOURCES && pairs <= WGSL_MAX_PAIRS && int_pairs <= WGSL_MAX_PAIRS && key_pairs <= WGSL_MAX_PAIRS;
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
   /* A corrupt store's counts mustn't take the fixed arrays they count past their ends. */
   if (blob->overrun || !wg_counts_sane(s->info.resource_count, s->info.pair_count, s->info.int_pair_count, s->info.key_pair_count)) {
      stage_nir_free(s->nir);
      vk_shader_free(device, pAllocator, &s->vk);
      return vk_error(device, VK_ERROR_INCOMPATIBLE_SHADER_BINARY_EXT);
   }
   struct wg_program *p = calloc(1, sizeof(*p));
   if (!p) {
      vk_shader_free(device, pAllocator, &s->vk);
      return vk_error(device, VK_ERROR_OUT_OF_HOST_MEMORY);
   }
   program_read(blob, p);
   blob_copy_bytes(blob, p->link, sizeof(blake3_hash));
   if (blob->overrun || !wgsl || p->group_count > WGSL_MAX_GROUPS ||
       !wg_counts_sane(p->resource_count, p->pair_count, p->int_pair_count, p->key_pair_count) || p->set_count > WGSL_MAX_SETS) {
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

/* Render pipelines made at their draw only (vk/glue.c `venus_premake`: the page's default; `?gpu=vkpremake=on` A/B). */
bool wg_premake_off;

/* Pipelines made, timed for the render stats (`translateMs`: the translation, or a cache's lookups). */
VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateGraphicsPipelines(VkDevice device, VkPipelineCache cache, uint32_t count,
                           const VkGraphicsPipelineCreateInfo *infos, const VkAllocationCallbacks *alloc,
                           VkPipeline *pipelines)
{
   const int64_t t0 = os_time_get_nano();
   VkResult r = vk_common_CreateGraphicsPipelines(device, cache, count, infos, alloc, pipelines);
   /* With `?gpu=vkpremake=on`, their render pipelines now, where their state decides them (WebGPU makes them
    * asynchronously): off by default, since programs make many they never draw with, whose compiles then delay those
    * they do (VK4 T17; vk/README.md "Pipelines made asynchronously"). */
   if (!wg_premake_off) {
      VK_FROM_HANDLE(wg_device, dev, device);
      for (uint32_t i = 0; i < count; i++)
         if (pipelines[i])
            wg_pipeline_premake(dev, pipelines[i], &infos[i]);
   }
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
   for (uint32_t b = 0; b < WG_VERTEX_BINDINGS; b++)
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
      if (b >= MIN2(wg_limits.max_vertex_buffers, 8) || (k->vb[b].stride & 3) || (bound[b] & 3) ||
          (k->attr[loc].offset % MIN2(size, 4)) || wg_vertex_format_pulled(k->attr[loc].format))
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
   /* A vertex stage that stores fetches its vertices in its pre-pass, from copies (VK4 T33). */
   if (!mask || p->vs_stores)
      return NULL;
   for (struct wg_pull *u = p->pulls; u; u = u->next)
      if (u->slots == mask)
         return u;
   /* The vertex stage's storage buffers: its own and these, on WebGPU's limit. */
   uint32_t storage = util_bitcount(mask);
   for (uint32_t k = 0; k < p->resource_count; k++)
      storage += (p->vis[k] & 1) && (p->resources[k].kind == WGSL_STORAGE || p->resources[k].kind == WGSL_STORAGE_READ);
   if (storage > MIN2(wg_limits.max_storage_buffers, wg_limits.max_storage_buffers_in_vertex_stage))
      return NULL;
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
   wg_json_printf(&j, "{\"binding\":%u,\"visibility\":1,\"buffer\":{\"type\":\"uniform\"}}]}", WG_VERTEX_BINDINGS);
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

bool
wg_pipeline_pull_ok(struct wg_program *p, const struct wg_pipeline_key *k)
{
   bool wanted = false;
   if (p->vs_stores)
      return true;
   u_foreach_bit(loc, k->vs->info.inputs)
      wanted |= k->attr[loc].format && k->vb[k->attr[loc].binding].pull;
   return !wanted || wg_pipeline_pull(p, k);
}

/* A fragment stage that writes depth into an attachment without a depth aspect: Vulkan drops the write, WebGPU refuses the
 * pipeline. The output, at a location no target takes, goes nowhere (a location past the stage's own). */
static char *fragment_text(struct wg_program *p, const struct wg_shader *fs, bool drop_depth);
static uint32_t
fragment_without_depth(struct wg_program *p, const struct wg_shader *fs)
{
   if (p->fs_no_depth && p->fs_no_depth_of == fs)
      return p->fs_no_depth;
   char *text = fragment_text(p, fs, true);
   wg_id_release(p->fs_no_depth);
   p->fs_no_depth = wg_id();
   p->fs_no_depth_of = fs;
   gpu_shader(p->fs_no_depth, text, strlen(text));
   free(text);
   return p->fs_no_depth;
}

/* The fragment stage's text as the program prints it, without its depth output if `drop_depth`. */
static char *
fragment_text(struct wg_program *p, const struct wg_shader *fs, bool drop_depth)
{
   char *keyed = keyed_text(p, fs->nir, &fs->info, NULL);
   char *text = p->split_count || p->alias_count ? variant_text(p->base, p, p->mask, keyed ? keyed : fs->wgsl) : NULL;
   if (!text)
      text = keyed ? strdup(keyed) : strdup(fs->wgsl);
   free(keyed);
   /* With outputs, the member goes (a stage with 8, or dual-source's, has no location to spare); without, it is the
    * struct's only one: a location no target takes. */
   static const char from[] = "  @builtin(frag_depth) depth: f32,\n", to[] = "  @location(7) depth: f32,\n";
   char *at = drop_depth ? strstr(text, from) : NULL;
   if (at && !fs->info.outputs) {
      text = spliced(text, at - text, strlen(from), to);
   } else if (at) {
      text = spliced(text, at - text, strlen(from), "");
      static const char store[] = "o.depth = ";
      for (char *f; (f = strstr(text, store));)
         text = spliced(text, f - text, strlen(store), "_ = ");
   }
   return text;
}

/*
 * What a fragment stage reads of the attachments it writes (VK4 T32; vk/README.md "Reading the attachments"): the depth
 * bounds test, logic ops and advanced blends, which WebGPU's pipelines don't have, done in the stage on a copy of each
 * attachment made before the draw (wg_cmd.c `dst_copies`), bound in a group of their own. The stage's `main` becomes
 * `wg_fs`, which a new `main` calls between the test and what it does with the outputs.
 */
static uint8_t
dst_type(VkFormat format, uint32_t samples)
{
   const struct wg_texture_format *f = wg_texture_format(format);
   const uint8_t ms = samples > 1 ? WG_DST_MS : 0;
   if (!f)
      return 0;
   if (f->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL))
      return WG_DST_DEPTH | ms;
   return (f->flags & WG_FMT_UINT ? WG_DST_UINT : f->flags & WG_FMT_SINT ? WG_DST_SINT : WG_DST_FLOAT) | ms;
}

static void
dst_types(const struct wg_pipeline_key *k, uint8_t types[9])
{
   memset(types, 0, 9);
   for (uint32_t i = 0; i < MIN2(k->color_count, 8); i++)
      if ((k->logic_mask & (1u << i)) || k->adv[i].op)
         types[i] = dst_type(k->colors[i], k->samples);
   if (k->depth_bounds)
      types[WG_DST_DEPTH_BINDING] = dst_type(k->depth, k->samples);
}

const struct wg_dst *
wg_pipeline_dst(struct wg_program *p, const struct wg_pipeline_key *k)
{
   if (!wg_key_reads_dst(k))
      return NULL;
   const struct wg_pull *pull = wg_pipeline_pull(p, k);
   uint8_t types[9];
   dst_types(k, types);
   for (struct wg_dst *d = p->dsts; d; d = d->next)
      if (d->pull_slots == (pull ? pull->slots : 0) && !memcmp(d->types, types, sizeof(types)))
         return d;
   uint32_t used = pull ? 1u << pull->group : 0;
   for (uint32_t i = 0; i < p->resource_count; i++)
      used |= 1u << p->resources[i].group;
   const uint32_t groups = MAX2(p->group_count, pull ? pull->group + 1 : 0);
   const uint32_t group = ffs(~used) - 1;
   if (group > MIN2(groups, WGSL_MAX_GROUPS - 1)) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: a draw refused: no bind group left for the attachments its depth bounds, logic op or advanced blend read\n");
      warned = true;
      return NULL;
   }
   struct wg_dst *d = calloc(1, sizeof(*d));
   d->pull_slots = pull ? pull->slots : 0;
   memcpy(d->types, types, sizeof(types));
   d->group = group;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"entries\":[");
   const char *sep = "";
   for (uint32_t b = 0; b < 9; b++) {
      if (!types[b])
         continue;
      static const char *const sample[] = { "", "unfilterable-float", "sint", "uint", "depth" };
      wg_json_printf(&j, "%s{\"binding\":%u,\"visibility\":2,\"texture\":{\"sampleType\":\"%s\",\"multisampled\":%s}}", sep,
                     b, sample[types[b] & 7], types[b] & WG_DST_MS ? "true" : "false");
      sep = ",";
   }
   wg_json_printf(&j, "]}");
   d->bgl = wg_create_json(WG_KIND_BGL, &j);
   j = (struct wg_json){ 0 };
   wg_json_printf(&j, "{\"bindGroupLayouts\":[");
   for (uint32_t g = 0; g < MAX2(groups, group + 1); g++)
      wg_json_printf(&j, "%s%u", g ? "," : "", g == group ? d->bgl : pull && g == pull->group ? pull->bgl : p->bgl[g]);
   wg_json_printf(&j, "],\"immediateSize\":%u}", p->immediate_size);
   d->layout = wg_create_json(WG_KIND_LAYOUT, &j);
   d->next = p->dsts;
   p->dsts = d;
   return d;
}

/* The colour attachments the fragment stage writes, through the key's map (`wg_key_location`), and each one's WGSL type. */
static uint32_t
key_outputs(const struct wg_pipeline_key *k, uint8_t bases[8])
{
   uint32_t mask = 0;
   for (uint32_t i = 0; k->fs && i < 8; i++) {
      const uint8_t loc = wg_key_location(k, i);
      if (loc < 8 && (k->fs->info.outputs & (1u << loc))) {
         mask |= 1u << i;
         if (bases)
            bases[i] = k->fs->info.output_base[loc];
      }
   }
   return mask;
}

/* The stage's text (`text`, freed) with its outputs at the attachments the key's map gives them (wg_key_location):
 * output L, `fL` at @location(L), becomes `fi` at @location(i) for the attachment i that takes it, or a private
 * variable where none does. NULL where it can't be (dual-source outputs). */
static char *
mapped_text(const struct wg_pipeline_key *k, char *text)
{
   if (!k->mapped)
      return text;
   if (k->fs->info.dual_source) {
      free(text);
      return NULL;
   }
   u_foreach_bit(loc, k->fs->info.outputs) {
      int to = -1;
      for (uint32_t i = 0; i < 8; i++)
         if (k->color_map[i] == loc)
            to = i;
      char member[64], with[64], use[16], to_use[24];
      snprintf(member, sizeof(member), "  @location(%u) f%u: ", loc, loc);
      char *at = strstr(text, member);
      if (!at)
         continue;
      char *eol = strchr(at, '\n');
      const size_t n = eol ? (size_t)(eol + 1 - at) : strlen(at);
      if (to >= 0) {
         snprintf(with, sizeof(with), "  @location(%d) fZ%d: ", to, to);
         text = spliced(text, at - text, strlen(member), with);
         snprintf(to_use, sizeof(to_use), "o.fZ%d", to);
      } else {
         /* Its type, for the private variable it goes to. */
         char type[32] = "";
         sscanf(at + strlen(member), "%31[^,]", type);
         snprintf(with, sizeof(with), "var<private> wg_unused%u: %s;\n", loc, type);
         text = spliced(text, at - text, n, "");
         char *out = strstr(text, "struct Out {");
         text = spliced(text, out ? (size_t)(out - text) : 0, 0, with);
         snprintf(to_use, sizeof(to_use), "wg_unused%u", loc);
      }
      snprintf(use, sizeof(use), "o.f%u", loc);
      for (char *f = strstr(text, use); f; f = strstr(text, use)) {
         const size_t at_f = f - text;
         text = spliced(text, at_f, strlen(use), to_use);
      }
   }
   for (char *f = strstr(text, "fZ"); f; f = strstr(f, "fZ"))
      memmove(f + 1, f + 2, strlen(f + 2) + 1);
   return text;
}

/* printf into one of a few rotating buffers: short-lived pieces of a line. */
static const char *fmt_tmp(const char *f, ...) __attribute__((format(printf, 1, 2)));
static const char *
fmt_tmp(const char *f, ...)
{
   static char bufs[6][512];
   static unsigned n;
   char *b = bufs[n++ % 6];
   va_list ap;
   va_start(ap, f);
   vsnprintf(b, 512, f, ap);
   va_end(ap);
   return b;
}

/* An f32's exact WGSL. */
static const char *
f32_lit(char *buf, float v)
{
   uint32_t u;
   memcpy(&u, &v, 4);
   sprintf(buf, "bitcast<f32>(0x%xu)", u);
   return buf;
}

/* The advanced blends' functions (VK_EXT_blend_operation_advanced's equations, the spec's f(Cs, Cd) and its HSL helpers). */
static const char dst_blend_lib[] =
   "fn wg_lum(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }\n"
   "fn wg_min3(c: vec3<f32>) -> f32 { return min(min(c.x, c.y), c.z); }\n"
   "fn wg_max3(c: vec3<f32>) -> f32 { return max(max(c.x, c.y), c.z); }\n"
   "fn wg_clipc(c0: vec3<f32>) -> vec3<f32> {\n"
   "  var c = c0; let l = wg_lum(c0); let n = wg_min3(c0); let x = wg_max3(c0);\n"
   "  if (n < 0.0) { c = l + (c - l) * l / (l - n); }\n"
   "  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / (x - l); }\n"
   "  return c;\n"
   "}\n"
   "fn wg_setlum(b: vec3<f32>, l: vec3<f32>) -> vec3<f32> { return wg_clipc(b + vec3<f32>(wg_lum(l) - wg_lum(b))); }\n"
   "fn wg_setlumsat(b: vec3<f32>, s: vec3<f32>, l: vec3<f32>) -> vec3<f32> {\n"
   "  let sb = wg_max3(b) - wg_min3(b);\n"
   "  var c = vec3<f32>(0.0);\n"
   "  if (sb > 0.0) { c = (b - wg_min3(b)) * (wg_max3(s) - wg_min3(s)) / sb; }\n"
   "  return wg_setlum(c, l);\n"
   "}\n"
   "fn wg_overlay(s: f32, d: f32) -> f32 { if (d <= 0.5) { return 2.0 * s * d; } return 1.0 - 2.0 * (1.0 - s) * (1.0 - d); }\n"
   "fn wg_colordodge(s: f32, d: f32) -> f32 { if (d <= 0.0) { return 0.0; } if (s < 1.0) { return min(1.0, d / (1.0 - s)); } return 1.0; }\n"
   "fn wg_colorburn(s: f32, d: f32) -> f32 { if (d >= 1.0) { return 1.0; } if (s > 0.0) { return 1.0 - min(1.0, (1.0 - d) / s); } return 0.0; }\n"
   "fn wg_hardlight(s: f32, d: f32) -> f32 { if (s <= 0.5) { return 2.0 * s * d; } return 1.0 - 2.0 * (1.0 - s) * (1.0 - d); }\n"
   "fn wg_softlight(s: f32, d: f32) -> f32 {\n"
   "  if (s <= 0.5) { return d - (1.0 - 2.0 * s) * d * (1.0 - d); }\n"
   "  if (d <= 0.25) { return d + (2.0 * s - 1.0) * d * ((16.0 * d - 12.0) * d + 3.0); }\n"
   "  return d + (2.0 * s - 1.0) * (sqrt(d) - d);\n"
   "}\n"
   "fn wg_lineardodge(s: f32, d: f32) -> f32 { if (s + d <= 1.0) { return s + d; } return 1.0; }\n"
   "fn wg_linearburn(s: f32, d: f32) -> f32 { if (s + d > 1.0) { return s + d - 1.0; } return 0.0; }\n"
   "fn wg_vividlight(s: f32, d: f32) -> f32 {\n"
   "  if (s <= 0.0) { return 0.0; }\n"
   "  if (s < 0.5) { return 1.0 - min(1.0, (1.0 - d) / (2.0 * s)); }\n"
   "  if (s < 1.0) { return min(1.0, d / (2.0 * (1.0 - s))); }\n"
   "  return 1.0;\n"
   "}\n"
   "fn wg_linearlight(s: f32, d: f32) -> f32 { if (2.0 * s + d > 2.0) { return 1.0; } if (2.0 * s + d <= 1.0) { return 0.0; } return 2.0 * s + d - 1.0; }\n"
   "fn wg_pinlight(s: f32, d: f32) -> f32 {\n"
   "  if (2.0 * s - 1.0 > d) { if (s < 0.5) { return 0.0; } return 2.0 * s - 1.0; }\n"
   "  if (s < 0.5 * d) { return 2.0 * s; }\n"
   "  return d;\n"
   "}\n"
   "fn wg_hardmix(s: f32, d: f32) -> f32 { if (s + d < 1.0) { return 0.0; } return 1.0; }\n";

/* An advanced blend op's body: `s` and `d` the fragment's and the attachment's colours (vec4<f32>). */
static void
dst_blend_fn(struct wg_json *j, uint32_t loc, uint8_t op, uint8_t flags, uint8_t overlap)
{
   const VkBlendOp o = (VkBlendOp)(VK_BLEND_OP_ZERO_EXT + op - 1);
   const bool spre = flags & 1, dpre = flags & 2, clamp = flags & 4;
   wg_json_printf(j, "fn wg_blend%u(s0: vec4<f32>, d0: vec4<f32>) -> vec4<f32> {\n", loc);
   const char *res = NULL;
   if (o >= VK_BLEND_OP_PLUS_EXT) {
      /* The additional RGB ops: on premultiplied colours, without the overlap's weights. */
      wg_json_printf(j, "  let s = %s;\n  let d = %s;\n", spre ? "s0" : "vec4<f32>(s0.rgb * s0.a, s0.a)",
                     dpre ? "d0" : "vec4<f32>(d0.rgb * d0.a, d0.a)");
      switch (o) {
      case VK_BLEND_OP_PLUS_EXT: res = "s + d"; break;
      case VK_BLEND_OP_PLUS_CLAMPED_EXT: res = "min(vec4<f32>(1.0), s + d)"; break;
      case VK_BLEND_OP_PLUS_CLAMPED_ALPHA_EXT: res = "vec4<f32>(min(vec3<f32>(min(1.0, s.a + d.a)), s.rgb + d.rgb), min(1.0, s.a + d.a))"; break;
      case VK_BLEND_OP_PLUS_DARKER_EXT: res = "vec4<f32>(max(vec3<f32>(0.0), vec3<f32>(min(1.0, s.a + d.a)) - ((vec3<f32>(s.a) - s.rgb) + (vec3<f32>(d.a) - d.rgb))), min(1.0, s.a + d.a))"; break;
      case VK_BLEND_OP_MINUS_EXT: res = "d - s"; break;
      case VK_BLEND_OP_MINUS_CLAMPED_EXT: res = "max(vec4<f32>(0.0), d - s)"; break;
      case VK_BLEND_OP_CONTRAST_EXT: res = "vec4<f32>(vec3<f32>(d.a / 2.0) + 2.0 * (d.rgb - vec3<f32>(d.a / 2.0)) * (s.rgb - vec3<f32>(s.a / 2.0)), d.a)"; break;
      case VK_BLEND_OP_INVERT_OVG_EXT: res = "vec4<f32>(s.a * (vec3<f32>(1.0) - d.rgb) + (1.0 - s.a) * d.rgb, s.a + d.a - s.a * d.a)"; break;
      case VK_BLEND_OP_RED_EXT: res = "vec4<f32>(s.r, d.gba)"; break;
      case VK_BLEND_OP_GREEN_EXT: res = "vec4<f32>(d.r, s.g, d.ba)"; break;
      case VK_BLEND_OP_BLUE_EXT: res = "vec4<f32>(d.rg, s.b, d.a)"; break;
      default: res = "d"; break;
      }
   } else {
      static const char *const p[] = {
         [VK_BLEND_OVERLAP_UNCORRELATED_EXT] = "vec3<f32>(s0.a * d0.a, s0.a * (1.0 - d0.a), d0.a * (1.0 - s0.a))",
         [VK_BLEND_OVERLAP_DISJOINT_EXT] = "vec3<f32>(max(s0.a + d0.a - 1.0, 0.0), min(s0.a, 1.0 - d0.a), min(d0.a, 1.0 - s0.a))",
         [VK_BLEND_OVERLAP_CONJOINT_EXT] = "vec3<f32>(min(s0.a, d0.a), max(s0.a - d0.a, 0.0), max(d0.a - s0.a, 0.0))",
      };
      wg_json_printf(j, "  let p = %s;\n", p[MIN2(overlap, 2)]);
      /* The colours unpremultiplied (0 where alpha is). */
      wg_json_printf(j, "  let s = %s;\n  let d = %s;\n",
                     spre ? "select(vec3<f32>(0.0), s0.rgb / s0.a, s0.a != 0.0)" : "s0.rgb",
                     dpre ? "select(vec3<f32>(0.0), d0.rgb / d0.a, d0.a != 0.0)" : "d0.rgb");
      const char *f = "vec3<f32>(0.0)", *xyz = "1.0, 1.0, 1.0";
#define PER(fn) "vec3<f32>(" fn "(s.x, d.x), " fn "(s.y, d.y), " fn "(s.z, d.z))"
      switch (o) {
      case VK_BLEND_OP_ZERO_EXT: xyz = "0.0, 0.0, 0.0"; break;
      case VK_BLEND_OP_SRC_EXT: f = "s"; xyz = "1.0, 1.0, 0.0"; break;
      case VK_BLEND_OP_DST_EXT: f = "d"; xyz = "1.0, 0.0, 1.0"; break;
      case VK_BLEND_OP_SRC_OVER_EXT: f = "s"; break;
      case VK_BLEND_OP_DST_OVER_EXT: f = "d"; break;
      case VK_BLEND_OP_SRC_IN_EXT: f = "s"; xyz = "1.0, 0.0, 0.0"; break;
      case VK_BLEND_OP_DST_IN_EXT: f = "d"; xyz = "1.0, 0.0, 0.0"; break;
      case VK_BLEND_OP_SRC_OUT_EXT: xyz = "0.0, 1.0, 0.0"; break;
      case VK_BLEND_OP_DST_OUT_EXT: xyz = "0.0, 0.0, 1.0"; break;
      case VK_BLEND_OP_SRC_ATOP_EXT: f = "s"; xyz = "1.0, 0.0, 1.0"; break;
      case VK_BLEND_OP_DST_ATOP_EXT: f = "d"; xyz = "1.0, 1.0, 0.0"; break;
      case VK_BLEND_OP_XOR_EXT: xyz = "0.0, 1.0, 1.0"; break;
      case VK_BLEND_OP_MULTIPLY_EXT: f = "s * d"; break;
      case VK_BLEND_OP_SCREEN_EXT: f = "s + d - s * d"; break;
      case VK_BLEND_OP_OVERLAY_EXT: f = PER("wg_overlay"); break;
      case VK_BLEND_OP_DARKEN_EXT: f = "min(s, d)"; break;
      case VK_BLEND_OP_LIGHTEN_EXT: f = "max(s, d)"; break;
      case VK_BLEND_OP_COLORDODGE_EXT: f = PER("wg_colordodge"); break;
      case VK_BLEND_OP_COLORBURN_EXT: f = PER("wg_colorburn"); break;
      case VK_BLEND_OP_HARDLIGHT_EXT: f = PER("wg_hardlight"); break;
      case VK_BLEND_OP_SOFTLIGHT_EXT: f = PER("wg_softlight"); break;
      case VK_BLEND_OP_DIFFERENCE_EXT: f = "abs(d - s)"; break;
      case VK_BLEND_OP_EXCLUSION_EXT: f = "s + d - 2.0 * s * d"; break;
      case VK_BLEND_OP_INVERT_EXT: f = "vec3<f32>(1.0) - d"; xyz = "1.0, 0.0, 1.0"; break;
      case VK_BLEND_OP_INVERT_RGB_EXT: f = "s * (vec3<f32>(1.0) - d)"; xyz = "1.0, 0.0, 1.0"; break;
      case VK_BLEND_OP_LINEARDODGE_EXT: f = PER("wg_lineardodge"); break;
      case VK_BLEND_OP_LINEARBURN_EXT: f = PER("wg_linearburn"); break;
      case VK_BLEND_OP_VIVIDLIGHT_EXT: f = PER("wg_vividlight"); break;
      case VK_BLEND_OP_LINEARLIGHT_EXT: f = PER("wg_linearlight"); break;
      case VK_BLEND_OP_PINLIGHT_EXT: f = PER("wg_pinlight"); break;
      case VK_BLEND_OP_HARDMIX_EXT: f = PER("wg_hardmix"); break;
      case VK_BLEND_OP_HSL_HUE_EXT: f = "wg_setlumsat(s, d, d)"; break;
      case VK_BLEND_OP_HSL_SATURATION_EXT: f = "wg_setlumsat(d, s, d)"; break;
      case VK_BLEND_OP_HSL_COLOR_EXT: f = "wg_setlum(s, d)"; break;
      case VK_BLEND_OP_HSL_LUMINOSITY_EXT: f = "wg_setlum(d, s)"; break;
      default: break;
      }
#undef PER
      wg_json_printf(j, "  let f = %s;\n  let xyz = vec3<f32>(%s);\n", f, xyz);
      res = "vec4<f32>(f * p.x + xyz.y * s * p.y + xyz.z * d * p.z, dot(xyz, p))";
   }
   /* A destination not premultiplied takes the result's colour divided by its alpha. */
   wg_json_printf(j, "  let r = %s;\n", res);
   if (!dpre)
      res = "vec4<f32>(select(r.rgb, r.rgb / r.a, r.a > 0.0), r.a)";
   else
      res = "r";
   wg_json_printf(j, "  return %s%s%s;\n}\n", clamp ? "clamp(" : "", res, clamp ? ", vec4<f32>(0.0), vec4<f32>(1.0))" : "");
}

/* A logic op on vec4<u32>s `s` and `d`. */
static const char *const logic_ops[16] = {
   "vec4<u32>(0u)", "s & d", "s & ~d", "s", "~s & d", "d", "s ^ d", "s | d",
   "~(s | d)", "~(s ^ d)", "~d", "s | ~d", "~s", "~s | d", "~(s & d)", "vec4<u32>(0xffffffffu)",
};

/* Location `loc`'s logic op: the fragment's output `r.f<loc>` (of WGSL type `base`) and the attachment's texel `t`, as
 * the format's bits (normalized formats converted to and from them, as the attachment stores them). */
static void
dst_logic(struct wg_json *j, uint32_t loc, VkFormat format, uint8_t base, uint8_t op)
{
   const struct util_format_description *desc = vk_format_description(format);
   uint32_t bits[4] = { 0 };
   for (uint32_t c = 0; desc && c < 4; c++)
      bits[c] = desc->swizzle[c] < 4 ? desc->channel[desc->swizzle[c]].size : 0;
   char m[80], k[120], h[120], e[80];
   snprintf(m, sizeof(m), "vec4<u32>(0x%xu, 0x%xu, 0x%xu, 0x%xu)", (uint32_t)BITFIELD_MASK(bits[0]),
            (uint32_t)BITFIELD_MASK(bits[1]), (uint32_t)BITFIELD_MASK(bits[2]), (uint32_t)BITFIELD_MASK(bits[3]));
   snprintf(k, sizeof(k), "vec4<f32>(%.1f, %.1f, %.1f, %.1f)", bits[0] ? (double)BITFIELD_MASK(bits[0]) : 1.0,
            bits[1] ? (double)BITFIELD_MASK(bits[1]) : 1.0, bits[2] ? (double)BITFIELD_MASK(bits[2]) : 1.0,
            bits[3] ? (double)BITFIELD_MASK(bits[3]) : 1.0);
   snprintf(h, sizeof(h), "vec4<f32>(%.1f, %.1f, %.1f, %.1f)", bits[0] > 1 ? (double)BITFIELD_MASK(bits[0] - 1) : 1.0,
            bits[1] > 1 ? (double)BITFIELD_MASK(bits[1] - 1) : 1.0, bits[2] > 1 ? (double)BITFIELD_MASK(bits[2] - 1) : 1.0,
            bits[3] > 1 ? (double)BITFIELD_MASK(bits[3] - 1) : 1.0);
   snprintf(e, sizeof(e), "vec4<u32>(%uu, %uu, %uu, %uu)", bits[0] ? 32 - bits[0] : 0, bits[1] ? 32 - bits[1] : 0,
            bits[2] ? 32 - bits[2] : 0, bits[3] ? 32 - bits[3] : 0);
   static const char *const types[] = { "f32", "i32", "u32" };
   const char *ty = types[MIN2(base, 2)];
   wg_json_printf(j, "  {\n");
   const bool uns = vk_format_is_uint(format) || vk_format_is_unorm(format);
   if (vk_format_is_unorm(format) || vk_format_is_snorm(format)) {
      const bool unorm = vk_format_is_unorm(format);
      const char *src = base == WGSL_F32 ? fmt_tmp("r.f%u", loc) : fmt_tmp("bitcast<vec4<f32>>(r.f%u)", loc);
      if (unorm)
         wg_json_printf(j, "    let s = vec4<u32>(round(clamp(%s, vec4<f32>(0.0), vec4<f32>(1.0)) * %s));\n"
                        "    let d = vec4<u32>(round(clamp(wg_t, vec4<f32>(0.0), vec4<f32>(1.0)) * %s));\n", src, k, k);
      else
         wg_json_printf(j, "    let s = bitcast<vec4<u32>>(vec4<i32>(round(clamp(%s, vec4<f32>(-1.0), vec4<f32>(1.0)) * %s)));\n"
                        "    let d = bitcast<vec4<u32>>(vec4<i32>(round(clamp(wg_t, vec4<f32>(-1.0), vec4<f32>(1.0)) * %s)));\n",
                        src, h, h);
      wg_json_printf(j, "    let v = (%s) & %s;\n", logic_ops[op & 15], m);
      const char *out = unorm ? fmt_tmp("vec4<f32>(v) / %s", k)
                              : fmt_tmp("max(vec4<f32>(bitcast<vec4<i32>>(v << %s) >> %s) / %s, vec4<f32>(-1.0))", e, e, h);
      wg_json_printf(j, "    r.f%u = %s;\n", loc, base == WGSL_F32 ? out : fmt_tmp("bitcast<vec4<%s>>(%s)", ty, out));
   } else {
      wg_json_printf(j, "    let s = %s;\n    let d = %s;\n",
                     base == WGSL_U32 ? fmt_tmp("r.f%u", loc) : fmt_tmp("bitcast<vec4<u32>>(r.f%u)", loc),
                     uns ? "wg_t" : "bitcast<vec4<u32>>(wg_t)");
      wg_json_printf(j, "    let v = (%s) & %s;\n", logic_ops[op & 15], m);
      const char *out = uns ? "v" : fmt_tmp("bitcast<vec4<u32>>(bitcast<vec4<i32>>(v << %s) >> %s)", e, e);
      wg_json_printf(j, "    r.f%u = %s;\n", loc, base == WGSL_U32 ? out : fmt_tmp("bitcast<vec4<%s>>(%s)", ty, out));
   }
   wg_json_printf(j, "  }\n");
}

/* The stage's text (`text`, freed) as the key's reads of its attachments want it, or NULL where it can't be. */
static char *
dst_text(const struct wg_pipeline_key *k, const struct wg_dst *dst, char *text)
{
   static const char head[] = "@fragment fn main(";
   char *at = strstr(text, head);
   char *eol = at ? strchr(at, '\n') : NULL;
   if (!eol) {
      free(text);
      return NULL;
   }
   /* "@fragment fn main(<params>) -> Out {" or "... {" */
   const bool has_out = eol - at > 10 && !strncmp(eol - 10, ") -> Out {", 10);
   const char *close = has_out ? eol - 10 : eol - 3;
   char params[1024];
   const size_t plen = close - (at + sizeof(head) - 1);
   if (plen >= sizeof(params) || strncmp(close, has_out ? ") -> Out {" : ") {", has_out ? 10 : 3)) {
      free(text);
      return NULL;
   }
   memcpy(params, at + sizeof(head) - 1, plen);
   params[plen] = 0;
   /* The arguments: each parameter's name. */
   struct wg_json args = { 0 };
   wg_json_printf(&args, "%s", "");
   for (char *p = params; *p;) {
      char *colon = strchr(p, ':');
      if (!colon)
         break;
      char *name = colon;
      while (name > p && name[-1] != ' ')
         name--;
      wg_json_printf(&args, "%s%.*s", args.len ? ", " : "", (int)(colon - name), name);
      char *next = strstr(colon, ", ");
      if (!next)
         break;
      p = next + 2;
   }
   const bool in_pos = strstr(params, "i: In") && strstr(text, "  @builtin(position) pos: vec4<f32>,\n");
   bool ms = false;
   for (uint32_t b = 0; b < 9; b++)
      ms |= (dst->types[b] & WG_DST_MS) != 0;
   const char *sid = strstr(params, "@builtin(sample_index) sid: u32") ? "sid" : "wg_sid";
   struct wg_json j = { 0 };
   wg_json_printf(&j, "%.*sfn wg_fs(%s)%s {%s", (int)(at - text), text, params, has_out ? " -> Out" : "", eol);
   bool lib = false;
   for (uint32_t i = 0; i < 8; i++)
      if (k->adv[i].op && dst->types[i]) {
         if (!lib)
            wg_json_printf(&j, "%s", dst_blend_lib);
         lib = true;
         dst_blend_fn(&j, i, k->adv[i].op, k->adv[i].flags, k->adv[i].overlap);
      }
   static const char *const tex[] = { "", "texture_2d<f32>", "texture_2d<i32>", "texture_2d<u32>", "texture_depth_2d" };
   static const char *const tex_ms[] = { "", "texture_multisampled_2d<f32>", "texture_multisampled_2d<i32>",
                                         "texture_multisampled_2d<u32>", "texture_depth_multisampled_2d" };
   for (uint32_t b = 0; b < 9; b++)
      if (dst->types[b])
         wg_json_printf(&j, "@group(%u) @binding(%u) var wg_dst%u: %s;\n", dst->group, b, b,
                        (dst->types[b] & WG_DST_MS ? tex_ms : tex)[dst->types[b] & 7]);
   wg_json_printf(&j, "@fragment fn main(%s%s%s%s%s)%s {\n", params, *params && !in_pos ? ", " : "",
                  in_pos ? "" : "@builtin(position) wg_pos: vec4<f32>", ms && !strcmp(sid, "wg_sid") ? ", " : "",
                  ms && !strcmp(sid, "wg_sid") ? "@builtin(sample_index) wg_sid: u32" : "", has_out ? " -> Out" : "");
   wg_json_printf(&j, "  let wg_pc = vec2<i32>(%s.xy);\n", in_pos ? "i.pos" : "wg_pos");
#define LOAD(b) fmt_tmp("textureLoad(wg_dst%u, wg_pc, %s)", (b), dst->types[b] & WG_DST_MS ? sid : "0")
   if (k->depth_bounds && dst->types[WG_DST_DEPTH_BINDING]) {
      char lo[40], hi[40];
      wg_json_printf(&j, "  let wg_z = %s;\n  if (!(wg_z >= %s && wg_z <= %s)) { discard; }\n",
                     LOAD(WG_DST_DEPTH_BINDING), f32_lit(lo, k->bounds_min), f32_lit(hi, k->bounds_max));
   }
   if (has_out)
      wg_json_printf(&j, "  var r = wg_fs(%s);\n", args.data ? args.data : "");
   else
      wg_json_printf(&j, "  wg_fs(%s);\n", args.data ? args.data : "");
   uint8_t bases[8] = { 0 };
   const uint32_t outputs = key_outputs(k, bases);
   for (uint32_t i = 0; has_out && i < 8; i++) {
      if (!dst->types[i] || !(outputs & (1u << i)))
         continue;
      const uint8_t base = bases[i];
      if (k->logic_mask & (1u << i)) {
         wg_json_printf(&j, "  {\n  let wg_t = %s;\n", LOAD(i));
         dst_logic(&j, i, k->colors[i], base, k->logic_op - 1);
         wg_json_printf(&j, "  }\n");
      } else if (k->adv[i].op && base == WGSL_F32) {
         const bool unorm = vk_format_is_unorm(k->colors[i]) || vk_format_is_srgb(k->colors[i]);
         wg_json_printf(&j, "  r.f%u = wg_blend%u(%s, %s);\n", i, i,
                        unorm ? fmt_tmp("clamp(r.f%u, vec4<f32>(0.0), vec4<f32>(1.0))", i) : fmt_tmp("r.f%u", i),
                        LOAD(i));
      }
   }
#undef LOAD
   wg_json_printf(&j, "%s}\n", has_out ? "  return r;\n" : "");
   wg_json_free(&args);
   free(text);
   return j.data;
}

/* A fragment module of a key reading its attachments (`dst_text`), kept with the program; 0 where it can't be. */
static uint32_t
fragment_dst_text(struct wg_program *p, const struct wg_pipeline_key *k, const struct wg_dst *dst, char *text)
{
   if (text && k->fs)
      text = mapped_text(k, text);
   if (text && dst)
      text = dst_text(k, dst, text);
   if (!text)
      return 0;
   struct wg_dst_module *m = malloc(sizeof(*m));
   m->id = wg_id();
   m->next = p->dst_modules;
   p->dst_modules = m;
   gpu_shader(m->id, text, strlen(text));
   free(text);
   return m->id;
}

static uint32_t
fragment_dst(struct wg_program *p, const struct wg_pipeline_key *k, const struct wg_dst *dst, bool drop_depth)
{
   return fragment_dst_text(p, k, dst, fragment_text(p, k->fs, drop_depth));
}

static uint32_t
render_pipeline(struct wg_program *p, const struct wg_pipeline_key *k, bool premade)
{
   if (!p->pipelines)
      p->pipelines = _mesa_hash_table_create(NULL, key_hash, key_equal);
   struct hash_entry *e = _mesa_hash_table_search(p->pipelines, k);
   if (e)
      return (uint32_t)(uintptr_t)e->data;
   wg_variant_modules(p, k->vs, k->fs);

   struct wg_json j = { 0 };
   const struct wg_pull *pull = wg_pipeline_pull(p, k);
   const struct wg_dst *dst = wg_pipeline_dst(p, k);
   /* `premade`: the worker counts those a draw sets (web/venus-gpu.ts `premade`). */
   wg_json_printf(&j, "{%s\"layout\":%u,", premade ? "\"premade\":true," : "",
                  dst ? dst->layout : pull ? pull->layout : p->layout);
   wg_json_printf(&j, "\"vertex\":{\"module\":%u,\"entryPoint\":\"main\","
                  "\"constants\":{\"wg_flip_y\":%d,\"wg_flip_z\":%d",
                  p->vs_module ? p->vs_module : k->vs->module, k->flip ? 1 : -1,
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
      /* WebGPU's constant is in its texture's units: D16's in depth24plus's are 256 of them. */
      if (k->depth_bias && has_depth)
         wg_json_printf(&j, ",\"depthBias\":%d,\"depthBiasSlopeScale\":%g,\"depthBiasClamp\":%g",
                        (int)(k->bias_constant * ((f->flags & WG_FMT_D16) ? 256 : 1)), k->bias_slope, k->bias_clamp);
      wg_json_printf(&j, "}");
   }
   /* WebGPU's alpha to coverage wants several samples, a colour target at location 0 and no `sample_mask` output (else
    * Vulkan's coverage from its alpha is lost: the draw covers its samples). */
   const bool target0 = k->fs && k->color_count && k->colors[0] && wg_texture_format(k->colors[0]) &&
                        (k->fs->info.outputs & 1u) && !k->fs->info.writes_sample_mask;
   wg_json_printf(&j, ",\"multisample\":{\"count\":%u,\"mask\":%u,\"alphaToCoverageEnabled\":%s}", MAX2(k->samples, 1),
                  k->sample_mask, k->alpha_to_coverage && k->samples > 1 && target0 ? "true" : "false");
   if (k->fs) {
      const struct wg_texture_format *ds = k->depth ? wg_texture_format(k->depth) : NULL;
      const bool depth_dropped = k->fs->info.writes_depth && !(ds && (ds->flags & WG_FMT_DEPTH));
      /* A stage reading its attachments, or whose outputs the key's map moves, is printed for the key. */
      const uint32_t dst_module = dst || k->mapped ? fragment_dst(p, k, dst, depth_dropped) : 0;
      const uint32_t outputs = key_outputs(k, NULL);
      wg_json_printf(&j, ",\"fragment\":{\"module\":%u,\"entryPoint\":\"main\",",
                     dst_module ? dst_module : depth_dropped ? fragment_without_depth(p, k->fs)
                     : p->fs_module ? p->fs_module : k->fs->module);
      /* At the sample rate, the samples' positions follow the pipeline's count (wgsl_print.c `wg_sample_pos`); alpha
       * to coverage at one sample is the stage's (`wg_a2c`). */
      const bool a2c = k->alpha_to_coverage && k->samples <= 1 && k->fs->info.a2c;
      if (k->fs->info.per_sample || k->fs->info.uses_view || a2c) {
         wg_json_printf(&j, "\"constants\":{");
         const char *sep = "";
         if (k->fs->info.per_sample) {
            wg_json_printf(&j, "\"wg_samples\":%u", k->samples);
            sep = ",";
         }
         if (k->fs->info.uses_view) {
            wg_json_printf(&j, "%s\"wg_view\":%u", sep, k->view);
            sep = ",";
         }
         if (a2c)
            wg_json_printf(&j, "%s\"wg_a2c\":1", sep);
         wg_json_printf(&j, "},");
      }
      wg_json_printf(&j, "\"targets\":[");
      for (uint32_t i = 0; i < k->color_count; i++) {
         const struct wg_texture_format *f = k->colors[i] ? wg_texture_format(k->colors[i]) : NULL;
         if (!f) {
            wg_json_printf(&j, "%snull", i ? "," : "");
            continue;
         }
         const bool written = outputs & (1u << i);
         wg_json_printf(&j, "%s{\"format\":\"%s\",\"writeMask\":%u", i ? "," : "", f->name,
                        written ? k->blend[i].mask & ~wg_format_lacks(f) & 15 : 0);
         /* A logic op or an advanced blend is the stage's (`fragment_dst`). */
         const bool by_stage = dst && dst_module && ((k->logic_mask & (1u << i)) || k->adv[i].op);
         if (written && k->blend[i].enable && (f->flags & WG_FMT_BLEND) && !by_stage) {
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
      /* The depth bounds test without a fragment shader: a stage of the test alone (VK4 T32). */
      uint32_t bounds = 0;
      if (dst) {
         struct wg_json t = { 0 };
         wg_json_printf(&t, "@fragment fn main() {\n}\n");
         bounds = fragment_dst_text(p, k, dst, t.data);
      }
      if (bounds) {
         wg_json_printf(&j, ",\"fragment\":{\"module\":%u,\"entryPoint\":\"main\",\"targets\":[", bounds);
         for (uint32_t i = 0; i < k->color_count; i++) {
            const struct wg_texture_format *f = k->colors[i] ? wg_texture_format(k->colors[i]) : NULL;
            if (f)
               wg_json_printf(&j, "%s{\"format\":\"%s\",\"writeMask\":0}", i ? "," : "", f->name);
            else
               wg_json_printf(&j, "%snull", i ? "," : "");
         }
         wg_json_printf(&j, "]}");
      } else if (colour) {
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
   /* A vertex stage that writes storage (VK4 T33): run as compute before each draw on the program's layouts, a
    * pass-through vertex stage of the worker's drawing its outputs (web/venus-gpu.ts `vsPrepass`). */
   if (p->vs_stores) {
      wg_json_printf(&j, ",\"stores\":{\"bgls\":[");
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

uint32_t
wg_render_pipeline(struct wg_program *p, const struct wg_pipeline_key *k)
{
   return render_pipeline(p, k, false);
}

uint32_t
wg_render_pipeline_premade(struct wg_program *p, const struct wg_pipeline_key *k)
{
   return render_pipeline(p, k, true);
}
