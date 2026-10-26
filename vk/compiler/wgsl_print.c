/*
 * Prints lowered NIR as WGSL (wgsl.h for the model). Shaped like KosmicKrisp's nir_to_msl.c (Mesa 26.2.4, MIT):
 * a gather of what the shader declares, the declarations, then the control flow printed node by node with every
 * value predeclared. Our own code.
 */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "nir.h"
#include "util/format/u_format.h"
#include "util/ralloc.h"
#include "util/string_buffer.h"

#include "wgsl.h"

void wgsl_finish(nir_shader *nir);

/* What the shader uses, gathered before printing. */
struct res_use {
   bool used;
   struct wgsl_resource r;
   bool signed_atomic;
};

struct ctx {
   nir_shader *nir;
   void *mem;
   struct _mesa_string_buffer *out;
   unsigned indent;
   bool failed;
   char *error;
   size_t error_size;
   struct wgsl_info *info;
   const struct wgsl_varyings *fs;

   struct res_use res[WGSL_MAX_RESOURCES];
   unsigned res_count;
   bool shm_atomic, uses_frag_coord, uses_front_face, uses_sample_id, uses_sample_mask_in;
   uint32_t ubo_sizes_unused;
   /* Fragment inputs and vertex outputs, by location (VARYING_SLOT_VAR0 + n). */
   struct wgsl_varyings vary;
   uint32_t vs_writes;           /* vertex: VAR locations written */
   uint8_t vs_write_base[32];
   uint8_t input_comps[32];
   /* Compute: ifs whose condition goes through workgroupUniformLoad (below), and whether the loop being printed
    * holds a barrier. */
   unsigned uniform_conds;
   bool in_barrier_loop;
};

static void
failf(struct ctx *c, const char *fmt, ...)
{
   if (c->failed)
      return;
   c->failed = true;
   va_list ap;
   va_start(ap, fmt);
   vsnprintf(c->error, c->error_size, fmt, ap);
   va_end(ap);
}

#define P(c, ...) _mesa_string_buffer_printf((c)->out, __VA_ARGS__)

static void
line(struct ctx *c, const char *fmt, ...)
{
   for (unsigned i = 0; i < c->indent; i++)
      _mesa_string_buffer_append(c->out, "  ");
   va_list ap;
   va_start(ap, fmt);
   _mesa_string_buffer_vprintf(c->out, fmt, ap);
   va_end(ap);
   _mesa_string_buffer_append(c->out, "\n");
}

static char *
fmt(struct ctx *c, const char *f, ...)
{
   va_list ap;
   va_start(ap, f);
   char *s = ralloc_vasprintf(c->mem, f, ap);
   va_end(ap);
   return s;
}

static const char *
vec_of(struct ctx *c, const char *scalar, unsigned n)
{
   return n == 1 ? scalar : fmt(c, "vec%u<%s>", n, scalar);
}

/* A value's storage type: bool, or u32, as scalars or vectors. */
static const char *
storage_type(struct ctx *c, unsigned bit_size, unsigned n)
{
   return vec_of(c, bit_size == 1 ? "bool" : "u32", n);
}

static const char *
base_name(unsigned base)
{
   return base == WGSL_F32 ? "f32" : base == WGSL_I32 ? "i32" : "u32";
}

static unsigned
base_of(nir_alu_type t)
{
   switch (nir_alu_type_get_base_type(t)) {
   case nir_type_int:
      return WGSL_I32;
   case nir_type_uint:
   case nir_type_bool:
      return WGSL_U32;
   default:
      return WGSL_F32;
   }
}

static const char *
swz(unsigned comp)
{
   static const char *s[] = { "x", "y", "z", "w" };
   return s[comp];
}

/* The components first..first+n of a vec4 field. */
static const char *
comps(struct ctx *c, unsigned first, unsigned n)
{
   static const char xyzw[] = "xyzw";
   char s[5] = { 0 };
   memcpy(s, xyzw + first, n);
   return fmt(c, "%s", s);
}

/* An SSA value by name: registers' loads are values of their own. */
static const char *
def_name(struct ctx *c, nir_def *def)
{
   return fmt(c, "t%u", def->index);
}

static const char *
src_name(struct ctx *c, nir_src *src)
{
   return def_name(c, src->ssa);
}

/* Component `comp` of a source, in its storage type. */
static const char *
src_comp(struct ctx *c, nir_src *src, unsigned comp)
{
   if (src->ssa->num_components == 1)
      return src_name(c, src);
   return fmt(c, "%s.%s", src_name(c, src), swz(comp));
}

/* A storage-typed expression as `base` (f32, i32 or u32), with `n` components. */
static const char *
as_base(struct ctx *c, const char *e, unsigned base, unsigned n)
{
   if (base == WGSL_U32)
      return e;
   return fmt(c, "bitcast<%s>(%s)", vec_of(c, base_name(base), n), e);
}

/* And back: an expression of `base` to storage. */
static const char *
to_storage(struct ctx *c, const char *e, unsigned base, unsigned n)
{
   if (base == WGSL_U32)
      return e;
   return fmt(c, "bitcast<%s>(%s)", vec_of(c, "u32", n), e);
}

static const char *
src_as(struct ctx *c, nir_src *src, unsigned base)
{
   return as_base(c, src_name(c, src), base, src->ssa->num_components);
}

static const char *
src_scalar_as(struct ctx *c, nir_src *src, unsigned comp, unsigned base)
{
   return as_base(c, src_comp(c, src, comp), base, 1);
}

/* Resources. */

static struct res_use *
resource(struct ctx *c, unsigned index, enum wgsl_resource_kind kind)
{
   const unsigned group = index >> 16, binding = index & 0xffff;
   for (unsigned i = 0; i < c->res_count; i++)
      if (c->res[i].r.group == group && c->res[i].r.binding == binding)
         return &c->res[i];
   if (c->res_count == WGSL_MAX_RESOURCES) {
      failf(c, "more than %u resources", WGSL_MAX_RESOURCES);
      return &c->res[0];
   }
   struct res_use *r = &c->res[c->res_count++];
   *r = (struct res_use){ .used = true, .r = { .group = group, .binding = binding, .kind = kind } };
   return r;
}

static const char *
res_name(struct ctx *c, unsigned index)
{
   return fmt(c, "r%u_%u", index >> 16, index & 0xffff);
}

static unsigned
const_index(struct ctx *c, nir_src *src)
{
   if (!nir_src_is_const(*src)) {
      failf(c, "a dynamically indexed buffer or image");
      return 0;
   }
   return nir_src_as_uint(*src);
}

static enum wgsl_dim
tex_dim(struct ctx *c, enum glsl_sampler_dim dim, bool array)
{
   switch (dim) {
   case GLSL_SAMPLER_DIM_1D:
      if (array)
         failf(c, "1D array textures");
      return WGSL_DIM_1D;
   case GLSL_SAMPLER_DIM_2D:
   case GLSL_SAMPLER_DIM_MS:
   case GLSL_SAMPLER_DIM_SUBPASS:
   case GLSL_SAMPLER_DIM_SUBPASS_MS:
      return array ? WGSL_DIM_2D_ARRAY : WGSL_DIM_2D;
   case GLSL_SAMPLER_DIM_CUBE:
      return array ? WGSL_DIM_CUBE_ARRAY : WGSL_DIM_CUBE;
   case GLSL_SAMPLER_DIM_3D:
      return WGSL_DIM_3D;
   default:
      failf(c, "a texture of sampler dim %d (texel buffers aren't offered)", dim);
      return WGSL_DIM_2D;
   }
}

/* The WGSL texel format of a storage image's format, or NULL. */
static const char *
storage_format(enum pipe_format f)
{
   switch (f) {
   case PIPE_FORMAT_R8G8B8A8_UNORM: return "rgba8unorm";
   case PIPE_FORMAT_R8G8B8A8_SNORM: return "rgba8snorm";
   case PIPE_FORMAT_R8G8B8A8_UINT: return "rgba8uint";
   case PIPE_FORMAT_R8G8B8A8_SINT: return "rgba8sint";
   case PIPE_FORMAT_B8G8R8A8_UNORM: return "bgra8unorm";
   case PIPE_FORMAT_R16G16B16A16_UINT: return "rgba16uint";
   case PIPE_FORMAT_R16G16B16A16_SINT: return "rgba16sint";
   case PIPE_FORMAT_R16G16B16A16_FLOAT: return "rgba16float";
   case PIPE_FORMAT_R32_UINT: return "r32uint";
   case PIPE_FORMAT_R32_SINT: return "r32sint";
   case PIPE_FORMAT_R32_FLOAT: return "r32float";
   case PIPE_FORMAT_R32G32_UINT: return "rg32uint";
   case PIPE_FORMAT_R32G32_SINT: return "rg32sint";
   case PIPE_FORMAT_R32G32_FLOAT: return "rg32float";
   case PIPE_FORMAT_R32G32B32A32_UINT: return "rgba32uint";
   case PIPE_FORMAT_R32G32B32A32_SINT: return "rgba32sint";
   case PIPE_FORMAT_R32G32B32A32_FLOAT: return "rgba32float";
   /* texture-formats-tier1 */
   case PIPE_FORMAT_R8_UNORM: return "r8unorm";
   case PIPE_FORMAT_R8_SNORM: return "r8snorm";
   case PIPE_FORMAT_R8_UINT: return "r8uint";
   case PIPE_FORMAT_R8_SINT: return "r8sint";
   case PIPE_FORMAT_R8G8_UNORM: return "rg8unorm";
   case PIPE_FORMAT_R8G8_SNORM: return "rg8snorm";
   case PIPE_FORMAT_R8G8_UINT: return "rg8uint";
   case PIPE_FORMAT_R8G8_SINT: return "rg8sint";
   case PIPE_FORMAT_R16_UINT: return "r16uint";
   case PIPE_FORMAT_R16_SINT: return "r16sint";
   case PIPE_FORMAT_R16_FLOAT: return "r16float";
   case PIPE_FORMAT_R16G16_UINT: return "rg16uint";
   case PIPE_FORMAT_R16G16_SINT: return "rg16sint";
   case PIPE_FORMAT_R16G16_FLOAT: return "rg16float";
   case PIPE_FORMAT_R10G10B10A2_UNORM: return "rgb10a2unorm";
   case PIPE_FORMAT_R10G10B10A2_UINT: return "rgb10a2uint";
   case PIPE_FORMAT_R11G11B10_FLOAT: return "rg11b10ufloat";
   case PIPE_FORMAT_R16_UNORM: return "r16unorm";
   case PIPE_FORMAT_R16G16_UNORM: return "rg16unorm";
   case PIPE_FORMAT_R16G16B16A16_UNORM: return "rgba16unorm";
   case PIPE_FORMAT_R16_SNORM: return "r16snorm";
   case PIPE_FORMAT_R16G16_SNORM: return "rg16snorm";
   case PIPE_FORMAT_R16G16B16A16_SNORM: return "rgba16snorm";
   default: return NULL;
   }
}

static unsigned
image_dim(struct ctx *c, enum glsl_sampler_dim dim, bool array)
{
   /* Storage textures have no cube views: a cube image is its 2D array of faces. */
   if (dim == GLSL_SAMPLER_DIM_CUBE)
      return WGSL_DIM_2D_ARRAY;
   if (dim == GLSL_SAMPLER_DIM_MS)
      failf(c, "multisampled storage images");
   return tex_dim(c, dim, array);
}

/* The gather: resources, I/O and what the entry point needs. */
static void
gather_intrinsic(struct ctx *c, nir_intrinsic_instr *intr)
{
   const nir_shader *nir = c->nir;
   switch (intr->intrinsic) {
   case nir_intrinsic_load_ubo: {
      struct res_use *r = resource(c, const_index(c, &intr->src[0]), WGSL_UNIFORM);
      const unsigned end = nir_intrinsic_range_base(intr) + nir_intrinsic_range(intr);
      /* The bytes declared: the range NIR knows, else what this load reaches. */
      if (nir_intrinsic_range(intr) != ~0u)
         r->r.size = MAX2(r->r.size, end);
      else if (nir_src_is_const(intr->src[1]))
         r->r.size = MAX2(r->r.size, nir_src_as_uint(intr->src[1]) + intr->def.num_components * 4);
      else
         r->r.size = MAX2(r->r.size, 65536);
      break;
   }
   case nir_intrinsic_load_ssbo:
   case nir_intrinsic_store_ssbo:
   case nir_intrinsic_get_ssbo_size:
   case nir_intrinsic_ssbo_atomic:
   case nir_intrinsic_ssbo_atomic_swap: {
      const unsigned src = intr->intrinsic == nir_intrinsic_store_ssbo ? 1 : 0;
      const bool writes = intr->intrinsic != nir_intrinsic_load_ssbo && intr->intrinsic != nir_intrinsic_get_ssbo_size;
      struct res_use *r = resource(c, const_index(c, &intr->src[src]), WGSL_STORAGE_READ);
      if (writes || !(nir_intrinsic_has_access(intr) && (nir_intrinsic_access(intr) & ACCESS_NON_WRITEABLE)))
         r->r.kind = WGSL_STORAGE;
      if (intr->intrinsic == nir_intrinsic_ssbo_atomic || intr->intrinsic == nir_intrinsic_ssbo_atomic_swap) {
         r->r.atomic = true;
         const nir_atomic_op op = nir_intrinsic_atomic_op(intr);
         if (op == nir_atomic_op_imin || op == nir_atomic_op_imax)
            r->signed_atomic = true;
      }
      break;
   }
   case nir_intrinsic_shared_atomic:
   case nir_intrinsic_shared_atomic_swap:
      c->shm_atomic = true;
      break;
   case nir_intrinsic_image_load:
   case nir_intrinsic_image_store:
   case nir_intrinsic_image_size: {
      struct res_use *r = resource(c, const_index(c, &intr->src[0]), WGSL_STORAGE_TEXTURE);
      r->r.dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
      r->r.format = nir_intrinsic_format(intr);
      if (!storage_format(r->r.format))
         failf(c, "a storage image of format %s", util_format_name(r->r.format));
      if (intr->intrinsic == nir_intrinsic_image_load)
         r->r.access |= WGSL_ACCESS_READ;
      else if (intr->intrinsic == nir_intrinsic_image_store)
         r->r.access |= WGSL_ACCESS_WRITE;
      break;
   }
   case nir_intrinsic_image_atomic:
   case nir_intrinsic_image_atomic_swap:
      failf(c, "image atomics");
      break;
   case nir_intrinsic_load_input:
      if (nir->info.stage == MESA_SHADER_VERTEX) {
         const unsigned loc = nir_intrinsic_io_semantics(intr).location - VERT_ATTRIB_GENERIC0;
         if (loc >= 32) {
            failf(c, "vertex input %u", loc);
            break;
         }
         c->info->inputs |= 1u << loc;
         c->info->input_base[loc] = base_of(nir_intrinsic_dest_type(intr));
         break;
      }
      FALLTHROUGH;
   case nir_intrinsic_load_interpolated_input:
      if (nir->info.stage == MESA_SHADER_FRAGMENT) {
         const unsigned slot = nir_intrinsic_io_semantics(intr).location;
         if (slot < VARYING_SLOT_VAR0 || slot >= VARYING_SLOT_VAR0 + 32) {
            failf(c, "fragment input slot %u", slot);
            break;
         }
         const unsigned loc = slot - VARYING_SLOT_VAR0;
         const unsigned base = base_of(nir_intrinsic_dest_type(intr));
         c->vary.mask |= 1u << loc;
         c->vary.base[loc] = base;
         if (intr->intrinsic == nir_intrinsic_load_input || base != WGSL_F32) {
            c->vary.interp[loc] = WGSL_INTERP_FLAT;
         } else {
            nir_intrinsic_instr *bary = nir_src_as_intrinsic(intr->src[0]);
            const enum glsl_interp_mode mode = nir_intrinsic_interp_mode(bary);
            c->vary.interp[loc] = mode == INTERP_MODE_NOPERSPECTIVE ? WGSL_INTERP_LINEAR
                                  : mode == INTERP_MODE_FLAT       ? WGSL_INTERP_FLAT
                                                                   : WGSL_INTERP_PERSPECTIVE;
            c->vary.sampling[loc] = bary->intrinsic == nir_intrinsic_load_barycentric_centroid ? WGSL_SAMPLING_CENTROID
                                    : bary->intrinsic == nir_intrinsic_load_barycentric_sample ? WGSL_SAMPLING_SAMPLE
                                                                                                : WGSL_SAMPLING_CENTER;
            if (bary->intrinsic == nir_intrinsic_load_barycentric_at_offset ||
                bary->intrinsic == nir_intrinsic_load_barycentric_at_sample)
               failf(c, "interpolation at an offset or sample");
         }
      }
      break;
   case nir_intrinsic_store_output: {
      const nir_io_semantics sem = nir_intrinsic_io_semantics(intr);
      if (nir->info.stage == MESA_SHADER_VERTEX) {
         if (sem.location >= VARYING_SLOT_VAR0 && sem.location < VARYING_SLOT_VAR0 + 32) {
            const unsigned loc = sem.location - VARYING_SLOT_VAR0;
            c->vs_writes |= 1u << loc;
            c->vs_write_base[loc] = base_of(nir_intrinsic_src_type(intr));
         } else if (sem.location == VARYING_SLOT_CLIP_DIST0 || sem.location == VARYING_SLOT_CLIP_DIST1) {
            c->info->clip_distances = true;
            c->info->clip_distance_count = MAX2(c->info->clip_distance_count, nir->info.clip_distance_array_size);
         } else if (sem.location != VARYING_SLOT_POS) {
            failf(c, "vertex output slot %s", gl_varying_slot_name_for_stage(sem.location, MESA_SHADER_VERTEX));
         }
      } else if (nir->info.stage == MESA_SHADER_FRAGMENT) {
         if (sem.location >= FRAG_RESULT_DATA0 && sem.location < FRAG_RESULT_DATA0 + 8) {
            const unsigned loc = sem.location - FRAG_RESULT_DATA0;
            if (sem.dual_source_blend_index)
               failf(c, "dual-source blending");
            c->info->outputs |= 1u << loc;
            c->info->output_base[loc] = base_of(nir_intrinsic_src_type(intr));
         } else if (sem.location == FRAG_RESULT_DEPTH) {
            c->info->writes_depth = true;
         } else if (sem.location == FRAG_RESULT_SAMPLE_MASK) {
            c->info->writes_sample_mask = true;
         } else {
            failf(c, "fragment output slot %u", sem.location);
         }
      }
      break;
   }
   case nir_intrinsic_load_frag_coord:
      c->uses_frag_coord = true;
      break;
   case nir_intrinsic_load_front_face:
      c->uses_front_face = true;
      break;
   case nir_intrinsic_load_sample_id:
      c->uses_sample_id = true;
      break;
   case nir_intrinsic_load_sample_mask_in:
      c->uses_sample_mask_in = true;
      break;
   case nir_intrinsic_demote:
   case nir_intrinsic_demote_if:
   case nir_intrinsic_terminate:
   case nir_intrinsic_terminate_if:
      c->info->discards = true;
      break;
   case nir_intrinsic_load_push_constant: {
      const unsigned end = nir_intrinsic_base(intr) + nir_intrinsic_range(intr);
      c->info->immediate_size = MAX2(c->info->immediate_size, align(end, 16));
      break;
   }
   default:
      break;
   }
}

static void
gather_tex(struct ctx *c, nir_tex_instr *tex)
{
   const bool sampled = tex->op != nir_texop_txf && tex->op != nir_texop_txf_ms && tex->op != nir_texop_txs &&
                        tex->op != nir_texop_query_levels && tex->op != nir_texop_texture_samples;
   struct res_use *t = resource(c, tex->texture_index, WGSL_TEXTURE);
   t->r.dim = tex_dim(c, tex->sampler_dim, tex->is_array);
   t->r.multisampled = tex->sampler_dim == GLSL_SAMPLER_DIM_MS || tex->op == nir_texop_txf_ms;
   if (tex->is_shadow)
      t->r.sample = WGSL_SAMPLE_DEPTH;
   else if (t->r.sample != WGSL_SAMPLE_DEPTH && tex->op != nir_texop_txs && tex->op != nir_texop_query_levels &&
            tex->op != nir_texop_texture_samples) {
      const nir_alu_type base = nir_alu_type_get_base_type(tex->dest_type);
      t->r.sample = base == nir_type_int ? WGSL_SAMPLE_SINT : base == nir_type_uint ? WGSL_SAMPLE_UINT
                                                                                    : WGSL_SAMPLE_FLOAT;
   }
   if (sampled) {
      struct res_use *s = resource(c, tex->sampler_index, tex->is_shadow ? WGSL_SAMPLER_COMPARE : WGSL_SAMPLER);
      if (tex->is_shadow)
         s->r.kind = WGSL_SAMPLER_COMPARE;
      if (t->r.sample == WGSL_SAMPLE_SINT || t->r.sample == WGSL_SAMPLE_UINT)
         failf(c, "an integer texture sampled with a sampler");
      bool known = false;
      for (unsigned i = 0; i < c->info->pair_count; i++)
         known |= c->info->pairs[i][0] == tex->texture_index && c->info->pairs[i][1] == tex->sampler_index;
      if (!known && c->info->pair_count < WGSL_MAX_PAIRS) {
         c->info->pairs[c->info->pair_count][0] = tex->texture_index;
         c->info->pairs[c->info->pair_count++][1] = tex->sampler_index;
      }
   }
   if (tex->op == nir_texop_lod)
      failf(c, "textureQueryLod");
}

static void
gather(struct ctx *c, nir_function_impl *impl)
{
   nir_foreach_block(block, impl) {
      nir_foreach_instr(instr, block) {
         if (instr->type == nir_instr_type_intrinsic)
            gather_intrinsic(c, nir_instr_as_intrinsic(instr));
         else if (instr->type == nir_instr_type_tex)
            gather_tex(c, nir_instr_as_tex(instr));
         else if (instr->type == nir_instr_type_alu) {
            nir_alu_instr *alu = nir_instr_as_alu(instr);
            if (alu->def.bit_size != 1 && alu->def.bit_size != 32)
               failf(c, "%u-bit values (%s)", alu->def.bit_size, nir_op_infos[alu->op].name);
         }
      }
   }
}

/* Declarations. */

static const char *
texture_type(struct ctx *c, const struct wgsl_resource *r)
{
   static const char *dims[] = { "1d", "2d", "2d_array", "cube", "cube_array", "3d" };
   if (r->sample == WGSL_SAMPLE_DEPTH) {
      if (r->multisampled)
         return "texture_depth_multisampled_2d";
      return fmt(c, "texture_depth_%s", dims[r->dim]);
   }
   const char *t = r->sample == WGSL_SAMPLE_SINT ? "i32" : r->sample == WGSL_SAMPLE_UINT ? "u32" : "f32";
   if (r->multisampled)
      return fmt(c, "texture_multisampled_2d<%s>", t);
   return fmt(c, "texture_%s<%s>", dims[r->dim], t);
}

static void
declare_resources(struct ctx *c)
{
   for (unsigned i = 0; i < c->res_count; i++) {
      struct wgsl_resource *r = &c->res[i].r;
      const char *name = fmt(c, "r%u_%u", r->group, r->binding);
      const char *at = fmt(c, "@group(%u) @binding(%u)", r->group, r->binding);
      switch (r->kind) {
      case WGSL_UNIFORM:
         r->size = MAX2(align(r->size, 16), 16);
         line(c, "%s var<uniform> %s: array<vec4<u32>, %u>;", at, name, r->size / 16);
         break;
      case WGSL_STORAGE:
      case WGSL_STORAGE_READ: {
         const char *el = r->atomic ? (c->res[i].signed_atomic ? "atomic<i32>" : "atomic<u32>") : "u32";
         if (r->atomic)
            r->kind = WGSL_STORAGE;
         line(c, "%s var<storage, %s> %s: array<%s>;", at, r->kind == WGSL_STORAGE ? "read_write" : "read", name, el);
         break;
      }
      case WGSL_SAMPLER:
         line(c, "%s var %s: sampler;", at, name);
         break;
      case WGSL_SAMPLER_COMPARE:
         line(c, "%s var %s: sampler_comparison;", at, name);
         break;
      case WGSL_TEXTURE:
         line(c, "%s var %s: %s;", at, name, texture_type(c, r));
         break;
      case WGSL_STORAGE_TEXTURE: {
         static const char *dims[] = { "1d", "2d", "2d_array", "2d_array", "2d_array", "3d" };
         if (!r->access)
            r->access = WGSL_ACCESS_READ;
         const char *access = r->access == WGSL_ACCESS_READ    ? "read"
                              : r->access == WGSL_ACCESS_WRITE ? "write"
                                                               : "read_write";
         line(c, "%s var %s: texture_storage_%s<%s, %s>;", at, name, dims[r->dim], storage_format(r->format), access);
         break;
      }
      }
      c->info->resources[c->info->resource_count++] = *r;
   }
}

static const char *
interp_attr(struct ctx *c, unsigned interp, unsigned sampling)
{
   if (interp == WGSL_INTERP_FLAT)
      return "@interpolate(flat)";
   static const char *s[] = { "center", "centroid", "sample" };
   return fmt(c, "@interpolate(%s, %s)", interp == WGSL_INTERP_LINEAR ? "linear" : "perspective", s[sampling]);
}

static void
declare_io(struct ctx *c)
{
   nir_shader *nir = c->nir;
   if (nir->info.stage == MESA_SHADER_VERTEX) {
      if (c->info->inputs) {
         line(c, "struct In {");
         u_foreach_bit(loc, c->info->inputs)
            line(c, "  @location(%u) a%u: vec4<%s>,", loc, loc, base_name(c->info->input_base[loc]));
         line(c, "}");
      }
      /* Outputs: what the fragment shader reads, as it reads them; else what this shader writes. */
      struct wgsl_varyings *v = &c->vary;
      if (c->fs) {
         *v = *c->fs;
      } else {
         memset(v, 0, sizeof(*v));
         v->mask = c->vs_writes;
         u_foreach_bit(loc, c->vs_writes) {
            v->base[loc] = c->vs_write_base[loc];
            v->interp[loc] = v->base[loc] == WGSL_F32 ? WGSL_INTERP_PERSPECTIVE : WGSL_INTERP_FLAT;
         }
      }
      line(c, "struct Out {");
      line(c, "  @builtin(position) pos: vec4<f32>,");
      if (c->info->clip_distances)
         line(c, "  @builtin(clip_distances) clip: array<f32, %u>,", c->info->clip_distance_count);
      u_foreach_bit(loc, v->mask)
         line(c, "  @location(%u) %s v%u: vec4<%s>,", loc, interp_attr(c, v->interp[loc], v->sampling[loc]), loc,
              base_name(v->base[loc]));
      line(c, "}");
      line(c, "var<private> o: Out;");
      /* A positive-height Vulkan viewport is upside down for WebGPU: y negated unless the pipeline's is flipped. */
      line(c, "override wg_flip_y: f32 = -1.0;");
   } else if (nir->info.stage == MESA_SHADER_FRAGMENT) {
      if (c->vary.mask || c->uses_frag_coord) {
         line(c, "struct In {");
         if (c->uses_frag_coord)
            line(c, "  @builtin(position) pos: vec4<f32>,");
         u_foreach_bit(loc, c->vary.mask)
            line(c, "  @location(%u) %s v%u: vec4<%s>,", loc, interp_attr(c, c->vary.interp[loc], c->vary.sampling[loc]),
                 loc, base_name(c->vary.base[loc]));
         line(c, "}");
      }
      if (c->info->outputs || c->info->writes_depth || c->info->writes_sample_mask) {
         line(c, "struct Out {");
         u_foreach_bit(loc, c->info->outputs)
            line(c, "  @location(%u) f%u: vec4<%s>,", loc, loc, base_name(c->info->output_base[loc]));
         if (c->info->writes_depth)
            line(c, "  @builtin(frag_depth) depth: f32,");
         if (c->info->writes_sample_mask)
            line(c, "  @builtin(sample_mask) mask: u32,");
         line(c, "}");
         line(c, "var<private> o: Out;");
      }
      c->info->varyings = c->vary;
   }
   if (nir->info.stage == MESA_SHADER_VERTEX)
      c->info->varyings = c->vary;
}

/* Values. */

static const char *
literal(struct ctx *c, nir_load_const_instr *lc, unsigned comp)
{
   if (lc->def.bit_size == 1)
      return lc->value[comp].b ? "true" : "false";
   return fmt(c, "0x%xu", lc->value[comp].u32);
}

static bool
def_needs_var(nir_instr *instr)
{
   if (instr->type != nir_instr_type_intrinsic)
      return true;
   nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
   if (!nir_intrinsic_infos[intr->intrinsic].has_dest)
      return false;
   switch (intr->intrinsic) {
   case nir_intrinsic_decl_reg:
   case nir_intrinsic_load_barycentric_pixel:
   case nir_intrinsic_load_barycentric_centroid:
   case nir_intrinsic_load_barycentric_sample:
   case nir_intrinsic_load_barycentric_at_offset:
   case nir_intrinsic_load_barycentric_at_sample:
      return false;
   default:
      return true;
   }
}

static bool
predeclare_def(nir_def *def, void *data)
{
   struct ctx *c = data;
   if (!def_needs_var(nir_def_instr(def)))
      return true;
   if (def->bit_size != 1 && def->bit_size != 32) {
      failf(c, "%u-bit values", def->bit_size);
      return true;
   }
   line(c, "var t%u: %s;", def->index, storage_type(c, def->bit_size, def->num_components));
   return true;
}

static void
predeclare(struct ctx *c, nir_function_impl *impl)
{
   nir_foreach_block(block, impl) {
      nir_foreach_instr(instr, block) {
         if (instr->type == nir_instr_type_intrinsic &&
             nir_instr_as_intrinsic(instr)->intrinsic == nir_intrinsic_decl_reg) {
            nir_intrinsic_instr *decl = nir_instr_as_intrinsic(instr);
            if (nir_intrinsic_num_array_elems(decl))
               failf(c, "register arrays");
            line(c, "var t%u: %s;", decl->def.index,
                 storage_type(c, nir_intrinsic_bit_size(decl), nir_intrinsic_num_components(decl)));
            continue;
         }
         nir_foreach_def(instr, predeclare_def, c);
      }
   }
}

/* ALU: each component on its own, sources bitcast to the op's input types. */
static const char *
alu_in(struct ctx *c, nir_alu_instr *alu, unsigned i, unsigned comp)
{
   const nir_alu_src *s = &alu->src[i];
   const char *raw = src_comp(c, (nir_src *)&s->src, s->swizzle[comp]);
   if (s->src.ssa->bit_size == 1)
      return raw;
   return as_base(c, raw, base_of(nir_op_infos[alu->op].input_types[i]), 1);
}

static const char *
alu_comp(struct ctx *c, nir_alu_instr *alu, unsigned comp)
{
   const nir_op op = alu->op;
   const unsigned n_in = nir_op_infos[op].num_inputs;
   const char *a = n_in > 0 ? alu_in(c, alu, 0, comp) : NULL;
   const char *b = n_in > 1 ? alu_in(c, alu, 1, comp) : NULL;
   const char *d = n_in > 2 ? alu_in(c, alu, 2, comp) : NULL;
   const bool boolean = alu->def.bit_size == 1;
   const unsigned out = boolean ? WGSL_U32 : base_of(nir_op_infos[op].output_type);
   const char *e = NULL;
#define BIN(o) e = fmt(c, "(%s " o " %s)", a, b)
#define F1(f) e = fmt(c, f "(%s)", a)
#define F2(f) e = fmt(c, f "(%s, %s)", a, b)
#define F3(f) e = fmt(c, f "(%s, %s, %s)", a, b, d)
   switch (op) {
   case nir_op_mov:
      return a;
   case nir_op_fadd: case nir_op_iadd: BIN("+"); break;
   case nir_op_fsub: case nir_op_isub: BIN("-"); break;
   case nir_op_fmul: case nir_op_imul: BIN("*"); break;
   case nir_op_fdiv: case nir_op_idiv: case nir_op_udiv: BIN("/"); break;
   case nir_op_irem: case nir_op_umod: BIN("%%"); break;
   case nir_op_imod:
      e = fmt(c, "(%s %% %s + select(0i, %s, ((%s %% %s) != 0i) && (((%s %% %s) < 0i) != (%s < 0i))))", a, b, b, a, b,
              a, b, b);
      break;
   case nir_op_fneg: case nir_op_ineg: e = fmt(c, "(-%s)", a); break;
   case nir_op_fabs: case nir_op_iabs: F1("abs"); break;
   case nir_op_fsat: e = fmt(c, "clamp(%s, 0.0, 1.0)", a); break;
   case nir_op_ffma: F3("fma"); break;
   case nir_op_flrp: F3("mix"); break;
   case nir_op_fmin: case nir_op_imin: case nir_op_umin: F2("min"); break;
   case nir_op_fmax: case nir_op_imax: case nir_op_umax: F2("max"); break;
   case nir_op_ffloor: F1("floor"); break;
   case nir_op_fceil: F1("ceil"); break;
   case nir_op_ftrunc: F1("trunc"); break;
   case nir_op_fround_even: F1("round"); break;
   case nir_op_ffract: F1("fract"); break;
   case nir_op_fsqrt: F1("sqrt"); break;
   case nir_op_frsq: F1("inverseSqrt"); break;
   case nir_op_frcp: e = fmt(c, "(1.0 / %s)", a); break;
   case nir_op_fexp2: F1("exp2"); break;
   case nir_op_flog2: F1("log2"); break;
   case nir_op_fsin: F1("sin"); break;
   case nir_op_fcos: F1("cos"); break;
   case nir_op_fpow: F2("pow"); break;
   case nir_op_fsign: F1("sign"); break;
   case nir_op_fquantize2f16: F1("quantizeToF16"); break;
   case nir_op_flt: case nir_op_ilt: case nir_op_ult: BIN("<"); break;
   case nir_op_fge: case nir_op_ige: case nir_op_uge: BIN(">="); break;
   case nir_op_feq: case nir_op_ieq: BIN("=="); break;
   case nir_op_fneu: case nir_op_ine: BIN("!="); break;
   case nir_op_fltu: e = fmt(c, "!(%s >= %s)", a, b); break;
   case nir_op_fgeu: e = fmt(c, "!(%s < %s)", a, b); break;
   case nir_op_fequ: e = fmt(c, "!((%s < %s) || (%s > %s))", a, b, a, b); break;
   case nir_op_fneo: e = fmt(c, "((%s < %s) || (%s > %s))", a, b, a, b); break;
   case nir_op_fisfinite:
      e = fmt(c, "((bitcast<u32>(%s) & 0x7f800000u) != 0x7f800000u)", a);
      break;
   case nir_op_f2i32: e = fmt(c, "i32(%s)", a); break;
   case nir_op_f2u32: e = fmt(c, "u32(%s)", a); break;
   case nir_op_i2f32: case nir_op_u2f32: e = fmt(c, "f32(%s)", a); break;
   case nir_op_f2f32: case nir_op_i2i32: case nir_op_u2u32: return a;
   case nir_op_b2f32: return fmt(c, "select(0u, 0x3f800000u, %s)", a);
   case nir_op_b2i32: return fmt(c, "select(0u, 1u, %s)", a);
   case nir_op_b2b32: return fmt(c, "select(0u, 0xffffffffu, %s)", a);
   case nir_op_b2b1:
      return alu->src[0].src.ssa->bit_size == 1 ? a : fmt(c, "(%s != 0u)", a);
   case nir_op_bcsel:
      return fmt(c, "select(%s, %s, %s)", src_comp(c, &alu->src[2].src, alu->src[2].swizzle[comp]),
                 src_comp(c, &alu->src[1].src, alu->src[1].swizzle[comp]), src_comp(c, &alu->src[0].src,
                                                                                    alu->src[0].swizzle[comp]));
   case nir_op_iand:
      if (boolean)
         return fmt(c, "(%s && %s)", a, b);
      BIN("&");
      break;
   case nir_op_ior:
      if (boolean)
         return fmt(c, "(%s || %s)", a, b);
      BIN("|");
      break;
   case nir_op_ixor:
      if (boolean)
         return fmt(c, "(%s != %s)", a, b);
      BIN("^");
      break;
   case nir_op_inot:
      if (boolean)
         return fmt(c, "!%s", a);
      e = fmt(c, "(~%s)", a);
      break;
   case nir_op_ishl: e = fmt(c, "(%s << (%s & 31u))", a, b); break;
   case nir_op_ishr: case nir_op_ushr: e = fmt(c, "(%s >> (%s & 31u))", a, b); break;
   /* WGSL's offsets and counts are u32: their sources as stored. */
   case nir_op_ubitfield_extract: case nir_op_ibitfield_extract:
      e = fmt(c, "extractBits(%s, %s, %s)", a, src_comp(c, &alu->src[1].src, alu->src[1].swizzle[comp]),
              src_comp(c, &alu->src[2].src, alu->src[2].swizzle[comp]));
      break;
   case nir_op_bitfield_insert:
      e = fmt(c, "insertBits(%s, %s, %s, %s)", a, b, src_comp(c, &alu->src[2].src, alu->src[2].swizzle[comp]),
              src_comp(c, &alu->src[3].src, alu->src[3].swizzle[comp]));
      break;
   case nir_op_bitfield_select: e = fmt(c, "((%s & %s) | (~%s & %s))", a, b, a, d); break;
   case nir_op_bit_count: F1("countOneBits"); break;
   case nir_op_bitfield_reverse: F1("reverseBits"); break;
   case nir_op_ufind_msb: case nir_op_ifind_msb: F1("firstLeadingBit"); break;
   case nir_op_find_lsb: F1("firstTrailingBit"); break;
   case nir_op_uclz: F1("countLeadingZeros"); break;
   case nir_op_fcsel: e = fmt(c, "select(%s, %s, %s != 0.0)", d, b, a); break;
   case nir_op_vec2: case nir_op_vec3: case nir_op_vec4:
      return src_comp(c, &alu->src[comp].src, alu->src[comp].swizzle[0]);
   default:
      failf(c, "the ALU op %s", nir_op_infos[op].name);
      return "0u";
   }
#undef BIN
#undef F1
#undef F2
#undef F3
   /* Comparisons give bools; the rest their output type, stored as u32 (a bitcast of a u32 to u32 is allowed). */
   if (boolean)
      return e;
   return to_storage(c, e, out, 1);
}

static void
emit_alu(struct ctx *c, nir_alu_instr *alu)
{
   const unsigned n = alu->def.num_components;
   const char *parts[4];
   for (unsigned i = 0; i < n; i++)
      parts[i] = alu_comp(c, alu, i);
   if (n == 1) {
      line(c, "t%u = %s;", alu->def.index, parts[0]);
      return;
   }
   const char *list = parts[0];
   for (unsigned i = 1; i < n; i++)
      list = fmt(c, "%s, %s", list, parts[i]);
   line(c, "t%u = %s(%s);", alu->def.index, storage_type(c, alu->def.bit_size, n), list);
}

static void
emit_load_const(struct ctx *c, nir_load_const_instr *lc)
{
   const unsigned n = lc->def.num_components;
   if (n == 1) {
      line(c, "t%u = %s;", lc->def.index, literal(c, lc, 0));
      return;
   }
   const char *list = literal(c, lc, 0);
   for (unsigned i = 1; i < n; i++)
      list = fmt(c, "%s, %s", list, literal(c, lc, i));
   line(c, "t%u = %s(%s);", lc->def.index, storage_type(c, lc->def.bit_size, n), list);
}

/* A def assigned from an expression of `n` u32 words, each `word(i)`. */
static void
assign_words(struct ctx *c, nir_def *def, const char *const *words)
{
   const unsigned n = def->num_components;
   if (n == 1) {
      line(c, "t%u = %s;", def->index, words[0]);
      return;
   }
   const char *list = words[0];
   for (unsigned i = 1; i < n; i++)
      list = fmt(c, "%s, %s", list, words[i]);
   line(c, "t%u = vec%u<u32>(%s);", def->index, n, list);
}

static const char *
atomic_fn(struct ctx *c, nir_atomic_op op)
{
   switch (op) {
   case nir_atomic_op_iadd: return "atomicAdd";
   case nir_atomic_op_imin: case nir_atomic_op_umin: return "atomicMin";
   case nir_atomic_op_imax: case nir_atomic_op_umax: return "atomicMax";
   case nir_atomic_op_iand: return "atomicAnd";
   case nir_atomic_op_ior: return "atomicOr";
   case nir_atomic_op_ixor: return "atomicXor";
   case nir_atomic_op_xchg: return "atomicExchange";
   default:
      failf(c, "the atomic op %d", op);
      return "atomicAdd";
   }
}

/* Loads, stores and atomics on an array of words (`arr`, a WGSL array of u32, atomic<u32> or atomic<i32>). */
static void
emit_word_access(struct ctx *c, nir_intrinsic_instr *intr, const char *arr, bool atomic, bool signed_atomic,
                 const char *word)
{
   const char *conv_in = signed_atomic ? "bitcast<i32>" : "";
   const char *conv_out = signed_atomic ? "bitcast<u32>" : "";
   switch (intr->intrinsic) {
   case nir_intrinsic_load_ssbo:
   case nir_intrinsic_load_shared:
   case nir_intrinsic_load_scratch: {
      const char *words[4];
      for (unsigned i = 0; i < intr->def.num_components; i++) {
         const char *w = fmt(c, "%s[%s + %uu]", arr, word, i);
         words[i] = atomic ? fmt(c, "%s(atomicLoad(&%s))", conv_out, w) : w;
      }
      assign_words(c, &intr->def, words);
      return;
   }
   case nir_intrinsic_store_ssbo:
   case nir_intrinsic_store_shared:
   case nir_intrinsic_store_scratch: {
      nir_src *value = &intr->src[0];
      u_foreach_bit(i, nir_intrinsic_write_mask(intr)) {
         const char *w = fmt(c, "%s[%s + %uu]", arr, word, i);
         if (atomic)
            line(c, "atomicStore(&%s, %s(%s));", w, conv_in, src_comp(c, value, i));
         else
            line(c, "%s = %s;", w, src_comp(c, value, i));
      }
      return;
   }
   case nir_intrinsic_ssbo_atomic:
   case nir_intrinsic_shared_atomic: {
      nir_src *data = &intr->src[intr->intrinsic == nir_intrinsic_ssbo_atomic ? 2 : 1];
      line(c, "t%u = %s(%s(&%s[%s], %s(%s)));", intr->def.index, conv_out, atomic_fn(c, nir_intrinsic_atomic_op(intr)),
           arr, word, conv_in, src_name(c, data));
      return;
   }
   case nir_intrinsic_ssbo_atomic_swap:
   case nir_intrinsic_shared_atomic_swap: {
      const unsigned at = intr->intrinsic == nir_intrinsic_ssbo_atomic_swap ? 2 : 1;
      line(c, "t%u = %s(atomicCompareExchangeWeak(&%s[%s], %s(%s), %s(%s)).old_value);", intr->def.index, conv_out, arr,
           word, conv_in, src_name(c, &intr->src[at]), conv_in, src_name(c, &intr->src[at + 1]));
      return;
   }
   default:
      return;
   }
}

static struct res_use *
find_res(struct ctx *c, unsigned index)
{
   for (unsigned i = 0; i < c->res_count; i++)
      if (c->res[i].r.group == index >> 16 && c->res[i].r.binding == (index & 0xffff))
         return &c->res[i];
   return &c->res[0];
}

/* Image coordinates: the integer coordinate of its dimension, and the array layer apart. */
static void
image_coords(struct ctx *c, nir_intrinsic_instr *intr, nir_src *coord, const char **xy, const char **layer)
{
   const unsigned dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
   const char *v = as_base(c, src_name(c, coord), WGSL_I32, coord->ssa->num_components);
   *layer = NULL;
   switch (dim) {
   case WGSL_DIM_1D: *xy = fmt(c, "%s.x", v); break;
   case WGSL_DIM_2D: *xy = fmt(c, "%s.xy", v); break;
   case WGSL_DIM_3D: *xy = fmt(c, "%s.xyz", v); break;
   default:
      *xy = fmt(c, "%s.xy", v);
      *layer = fmt(c, "%s.z", v);
   }
}

static const char *
texel_base(enum pipe_format f)
{
   return util_format_is_pure_sint(f) ? "i32" : util_format_is_pure_uint(f) ? "u32" : "f32";
}

/* A vec4 result of base `base` into a def of n components. */
static void
assign_vec4(struct ctx *c, nir_def *def, const char *e, unsigned base)
{
   const char *bits = base == WGSL_U32 ? e : fmt(c, "bitcast<vec4<u32>>(%s)", e);
   if (def->num_components == 4)
      line(c, "t%u = %s;", def->index, bits);
   else
      line(c, "t%u = (%s).%s;", def->index, bits, comps(c, 0, def->num_components));
}

static void
emit_output(struct ctx *c, nir_intrinsic_instr *intr)
{
   const nir_io_semantics sem = nir_intrinsic_io_semantics(intr);
   const unsigned first = nir_intrinsic_component(intr);
   nir_src *value = &intr->src[0];
   const unsigned mask = nir_intrinsic_write_mask(intr);
   if (!nir_src_is_const(intr->src[1]) || nir_src_as_uint(intr->src[1]))
      failf(c, "an indirect output");
   const char *field = NULL;
   unsigned base = WGSL_F32;
   if (c->nir->info.stage == MESA_SHADER_VERTEX) {
      if (sem.location == VARYING_SLOT_POS) {
         field = "pos";
      } else if (sem.location == VARYING_SLOT_CLIP_DIST0 || sem.location == VARYING_SLOT_CLIP_DIST1) {
         const unsigned at = (sem.location - VARYING_SLOT_CLIP_DIST0) * 4 + first;
         u_foreach_bit(i, mask)
            if (at + i < c->info->clip_distance_count)
               line(c, "o.clip[%u] = bitcast<f32>(%s);", at + i, src_comp(c, value, i));
         return;
      } else {
         const unsigned loc = sem.location - VARYING_SLOT_VAR0;
         if (!(c->vary.mask & (1u << loc)))
            return; /* the fragment shader doesn't read it */
         field = fmt(c, "v%u", loc);
         base = c->vary.base[loc];
      }
   } else {
      if (sem.location == FRAG_RESULT_DEPTH) {
         line(c, "o.depth = bitcast<f32>(%s);", src_comp(c, value, 0));
         return;
      }
      if (sem.location == FRAG_RESULT_SAMPLE_MASK) {
         line(c, "o.mask = %s;", src_comp(c, value, 0));
         return;
      }
      const unsigned loc = sem.location - FRAG_RESULT_DATA0;
      field = fmt(c, "f%u", loc);
      base = c->info->output_base[loc];
   }
   u_foreach_bit(i, mask)
      line(c, "o.%s.%s = %s;", field, swz(first + i), as_base(c, src_comp(c, value, i), base, 1));
}

static void
emit_input(struct ctx *c, nir_intrinsic_instr *intr)
{
   const nir_io_semantics sem = nir_intrinsic_io_semantics(intr);
   const unsigned first = nir_intrinsic_component(intr), n = intr->def.num_components;
   const unsigned offset_src = intr->intrinsic == nir_intrinsic_load_interpolated_input ? 1 : 0;
   if (!nir_src_is_const(intr->src[offset_src]) || nir_src_as_uint(intr->src[offset_src]))
      failf(c, "an indirect input");
   const char *e;
   unsigned base;
   if (c->nir->info.stage == MESA_SHADER_VERTEX) {
      const unsigned loc = sem.location - VERT_ATTRIB_GENERIC0;
      e = fmt(c, "i.a%u.%s", loc, comps(c, first, n));
      base = c->info->input_base[loc];
   } else {
      const unsigned loc = sem.location - VARYING_SLOT_VAR0;
      e = fmt(c, "i.v%u.%s", loc, comps(c, first, n));
      base = c->vary.base[loc];
   }
   line(c, "t%u = %s;", intr->def.index, to_storage(c, e, base, n));
}

static void
emit_intrinsic(struct ctx *c, nir_intrinsic_instr *intr)
{
   nir_def *def = &intr->def;
   switch (intr->intrinsic) {
   case nir_intrinsic_decl_reg:
   case nir_intrinsic_load_barycentric_pixel:
   case nir_intrinsic_load_barycentric_centroid:
   case nir_intrinsic_load_barycentric_sample:
      return;
   case nir_intrinsic_load_reg:
      line(c, "t%u = %s;", def->index, src_name(c, &intr->src[0]));
      return;
   case nir_intrinsic_store_reg: {
      nir_intrinsic_instr *decl = nir_src_as_intrinsic(intr->src[1]);
      const unsigned n = nir_intrinsic_num_components(decl);
      const unsigned mask = nir_intrinsic_write_mask(intr);
      if (mask == BITFIELD_MASK(n) && intr->src[0].ssa->num_components == n) {
         line(c, "t%u = %s;", decl->def.index, src_name(c, &intr->src[0]));
      } else {
         u_foreach_bit(i, mask)
            line(c, "t%u%s = %s;", decl->def.index, n > 1 ? fmt(c, ".%s", swz(i)) : "", src_comp(c, &intr->src[0], i));
      }
      return;
   }
   case nir_intrinsic_load_input:
   case nir_intrinsic_load_interpolated_input:
      emit_input(c, intr);
      return;
   case nir_intrinsic_store_output:
      emit_output(c, intr);
      return;
   case nir_intrinsic_load_vertex_id:
      line(c, "t%u = vid;", def->index);
      return;
   case nir_intrinsic_load_instance_id:
      line(c, "t%u = iid;", def->index);
      return;
   case nir_intrinsic_load_frag_coord:
      line(c, "t%u = bitcast<vec4<u32>>(i.pos)%s;", def->index, def->num_components < 4 ? fmt(c, ".%s", comps(c, 0, def->num_components)) : "");
      return;
   case nir_intrinsic_load_front_face:
      line(c, "t%u = ff;", def->index);
      return;
   case nir_intrinsic_load_sample_id:
      line(c, "t%u = sid;", def->index);
      return;
   case nir_intrinsic_load_sample_mask_in:
      line(c, "t%u = smask;", def->index);
      return;
   case nir_intrinsic_load_local_invocation_id:
      line(c, "t%u = lid;", def->index);
      return;
   case nir_intrinsic_load_global_invocation_id:
      line(c, "t%u = gid;", def->index);
      return;
   case nir_intrinsic_load_workgroup_id:
      line(c, "t%u = wid;", def->index);
      return;
   case nir_intrinsic_load_num_workgroups:
      line(c, "t%u = nwg;", def->index);
      return;
   case nir_intrinsic_load_local_invocation_index:
      line(c, "t%u = lidx;", def->index);
      return;
   case nir_intrinsic_load_workgroup_size:
      line(c, "t%u = vec3<u32>(%uu, %uu, %uu);", def->index, c->nir->info.workgroup_size[0],
           c->nir->info.workgroup_size[1], c->nir->info.workgroup_size[2]);
      return;
   case nir_intrinsic_load_view_index:
   case nir_intrinsic_load_layer_id:
      line(c, "t%u = 0u;", def->index);
      return;
   case nir_intrinsic_is_helper_invocation:
   case nir_intrinsic_load_helper_invocation:
      line(c, "t%u = false;", def->index);
      return;
   case nir_intrinsic_ddx: case nir_intrinsic_ddx_fine: case nir_intrinsic_ddx_coarse:
   case nir_intrinsic_ddy: case nir_intrinsic_ddy_fine: case nir_intrinsic_ddy_coarse: {
      static const char *names[] = { "dpdx", "dpdxFine", "dpdxCoarse", "dpdy", "dpdyFine", "dpdyCoarse" };
      const unsigned k = intr->intrinsic == nir_intrinsic_ddx ? 0 : intr->intrinsic == nir_intrinsic_ddx_fine ? 1
                         : intr->intrinsic == nir_intrinsic_ddx_coarse ? 2 : intr->intrinsic == nir_intrinsic_ddy ? 3
                         : intr->intrinsic == nir_intrinsic_ddy_fine ? 4 : 5;
      line(c, "t%u = %s;", def->index,
           to_storage(c, fmt(c, "%s(%s)", names[k], src_as(c, &intr->src[0], WGSL_F32)), WGSL_F32, def->num_components));
      return;
   }
   case nir_intrinsic_load_ubo: {
      const char *arr = res_name(c, const_index(c, &intr->src[0]));
      const char *w = fmt(c, "(%s >> 2u)", src_comp(c, &intr->src[1], 0));
      const char *words[4];
      for (unsigned i = 0; i < def->num_components; i++)
         words[i] = fmt(c, "%s[(%s + %uu) >> 2u][(%s + %uu) & 3u]", arr, w, i, w, i);
      assign_words(c, def, words);
      return;
   }
   case nir_intrinsic_load_ssbo:
   case nir_intrinsic_ssbo_atomic:
   case nir_intrinsic_ssbo_atomic_swap: {
      struct res_use *r = find_res(c, const_index(c, &intr->src[0]));
      emit_word_access(c, intr, res_name(c, const_index(c, &intr->src[0])), r->r.atomic, r->signed_atomic,
                       fmt(c, "(%s >> 2u)", src_comp(c, &intr->src[1], 0)));
      return;
   }
   case nir_intrinsic_store_ssbo: {
      struct res_use *r = find_res(c, const_index(c, &intr->src[1]));
      emit_word_access(c, intr, res_name(c, const_index(c, &intr->src[1])), r->r.atomic, r->signed_atomic,
                       fmt(c, "(%s >> 2u)", src_comp(c, &intr->src[2], 0)));
      return;
   }
   case nir_intrinsic_get_ssbo_size:
      line(c, "t%u = arrayLength(&%s) * 4u;", def->index, res_name(c, const_index(c, &intr->src[0])));
      return;
   case nir_intrinsic_load_shared:
   case nir_intrinsic_shared_atomic:
   case nir_intrinsic_shared_atomic_swap:
      emit_word_access(c, intr, "shm", c->shm_atomic, false,
                       fmt(c, "((%s + %uu) >> 2u)", src_comp(c, &intr->src[0], 0), nir_intrinsic_base(intr)));
      return;
   case nir_intrinsic_store_shared:
      emit_word_access(c, intr, "shm", c->shm_atomic, false,
                       fmt(c, "((%s + %uu) >> 2u)", src_comp(c, &intr->src[1], 0), nir_intrinsic_base(intr)));
      return;
   case nir_intrinsic_load_scratch:
      emit_word_access(c, intr, "scratch", false, false,
                       fmt(c, "((%s + %uu) >> 2u)", src_comp(c, &intr->src[0], 0), nir_intrinsic_base(intr)));
      return;
   case nir_intrinsic_store_scratch:
      emit_word_access(c, intr, "scratch", false, false,
                       fmt(c, "((%s + %uu) >> 2u)", src_comp(c, &intr->src[1], 0), nir_intrinsic_base(intr)));
      return;
   case nir_intrinsic_load_push_constant: {
      const char *w = fmt(c, "((%s + %uu) >> 2u)", src_comp(c, &intr->src[0], 0), nir_intrinsic_base(intr));
      const char *words[4];
      for (unsigned i = 0; i < def->num_components; i++)
         words[i] = fmt(c, "pc[(%s + %uu) >> 2u][(%s + %uu) & 3u]", w, i, w, i);
      assign_words(c, def, words);
      return;
   }
   case nir_intrinsic_barrier: {
      const mesa_scope exec = nir_intrinsic_execution_scope(intr);
      const nir_variable_mode modes = nir_intrinsic_memory_modes(intr);
      if (exec >= SCOPE_WORKGROUP && c->nir->info.stage == MESA_SHADER_COMPUTE) {
         if (modes & (nir_var_mem_ssbo | nir_var_mem_global))
            line(c, "storageBarrier();");
         if (modes & nir_var_image)
            line(c, "textureBarrier();");
         line(c, "workgroupBarrier();");
      }
      return;
   }
   case nir_intrinsic_demote:
   case nir_intrinsic_terminate:
      line(c, "discard;");
      return;
   case nir_intrinsic_demote_if:
   case nir_intrinsic_terminate_if:
      line(c, "if (%s) { discard; }", src_comp(c, &intr->src[0], 0));
      return;
   case nir_intrinsic_image_load: {
      const unsigned index = const_index(c, &intr->src[0]);
      const char *xy, *layer;
      image_coords(c, intr, &intr->src[1], &xy, &layer);
      const char *e = layer ? fmt(c, "textureLoad(%s, %s, %s)", res_name(c, index), xy, layer)
                            : fmt(c, "textureLoad(%s, %s)", res_name(c, index), xy);
      const char *b = texel_base(nir_intrinsic_format(intr));
      assign_vec4(c, def, e, !strcmp(b, "u32") ? WGSL_U32 : !strcmp(b, "i32") ? WGSL_I32 : WGSL_F32);
      return;
   }
   case nir_intrinsic_image_store: {
      const unsigned index = const_index(c, &intr->src[0]);
      const char *xy, *layer;
      image_coords(c, intr, &intr->src[1], &xy, &layer);
      const char *b = texel_base(nir_intrinsic_format(intr));
      nir_src *value = &intr->src[3];
      const char *v = value->ssa->num_components == 4 ? src_name(c, value)
                      : fmt(c, "vec4<u32>(%s, 0u, 0u, 0u)", src_name(c, value));
      const char *typed = !strcmp(b, "u32") ? v : fmt(c, "bitcast<vec4<%s>>(%s)", b, v);
      if (layer)
         line(c, "textureStore(%s, %s, %s, %s);", res_name(c, index), xy, layer, typed);
      else
         line(c, "textureStore(%s, %s, %s);", res_name(c, index), xy, typed);
      return;
   }
   case nir_intrinsic_image_size: {
      const unsigned index = const_index(c, &intr->src[0]);
      const unsigned dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
      const char *name = res_name(c, index);
      if (dim == WGSL_DIM_2D_ARRAY)
         line(c, "t%u = vec3<u32>(textureDimensions(%s), textureNumLayers(%s))%s;", def->index, name, name,
              def->num_components < 3 ? fmt(c, ".%s", comps(c, 0, def->num_components)) : "");
      else
         line(c, "t%u = textureDimensions(%s);", def->index, name);
      return;
   }
   default:
      failf(c, "the intrinsic %s", nir_intrinsic_infos[intr->intrinsic].name);
      return;
   }
}

/* Textures. */

static nir_src *
tex_src(nir_tex_instr *tex, nir_tex_src_type type)
{
   const int i = nir_tex_instr_src_index(tex, type);
   return i < 0 ? NULL : &tex->src[i].src;
}

static const char *
tex_offset(struct ctx *c, nir_tex_instr *tex)
{
   nir_src *off = tex_src(tex, nir_tex_src_offset);
   if (!off)
      return NULL;
   if (!nir_src_is_const(*off)) {
      failf(c, "a texture offset that isn't a constant");
      return NULL;
   }
   const unsigned n = off->ssa->num_components;
   const char *list = fmt(c, "%d", (int)nir_src_comp_as_int(*off, 0));
   for (unsigned i = 1; i < n; i++)
      list = fmt(c, "%s, %d", list, (int)nir_src_comp_as_int(*off, i));
   return n == 1 ? list : fmt(c, "vec%u<i32>(%s)", n, list);
}

static void
emit_tex(struct ctx *c, nir_tex_instr *tex)
{
   struct res_use *r = find_res(c, tex->texture_index);
   const char *t = res_name(c, tex->texture_index);
   const char *s = res_name(c, tex->sampler_index);
   nir_def *def = &tex->def;
   const bool depth = r->r.sample == WGSL_SAMPLE_DEPTH;
   const unsigned rbase = r->r.sample == WGSL_SAMPLE_SINT ? WGSL_I32 : r->r.sample == WGSL_SAMPLE_UINT ? WGSL_U32
                                                                                                         : WGSL_F32;
   const bool fragment = c->nir->info.stage == MESA_SHADER_FRAGMENT;

   switch (tex->op) {
   case nir_texop_txs: {
      nir_src *lod = tex_src(tex, nir_tex_src_lod);
      const char *dims = r->r.multisampled || !lod ? fmt(c, "textureDimensions(%s)", t)
                                                   : fmt(c, "textureDimensions(%s, %s)", t, src_comp(c, lod, 0));
      if (tex->is_array)
         dims = fmt(c, "vec%u<u32>(%s, textureNumLayers(%s))", def->num_components, dims, t);
      line(c, "t%u = %s;", def->index, dims);
      return;
   }
   case nir_texop_query_levels:
      line(c, "t%u = textureNumLevels(%s);", def->index, t);
      return;
   case nir_texop_texture_samples:
      line(c, "t%u = textureNumSamples(%s);", def->index, t);
      return;
   default:
      break;
   }

   nir_src *coord = tex_src(tex, nir_tex_src_coord);
   const unsigned cn = coord->ssa->num_components;
   const unsigned dn = cn - (tex->is_array ? 1 : 0);
   const char *cbase;
   const char *layer = NULL;
   const char *offset = tex_offset(c, tex);
   if (tex->op == nir_texop_txf || tex->op == nir_texop_txf_ms) {
      const char *ci = as_base(c, src_name(c, coord), WGSL_I32, cn);
      cbase = cn == 1 ? ci : dn == 1 ? fmt(c, "%s.x", ci) : fmt(c, "%s.%s", ci, comps(c, 0, dn));
      if (tex->is_array)
         layer = fmt(c, "%s.%s", ci, swz(dn));
      if (offset)
         cbase = fmt(c, "(%s + %s)", cbase, offset);
      const char *args = fmt(c, "%s, %s", t, cbase);
      if (layer)
         args = fmt(c, "%s, %s", args, layer);
      if (tex->op == nir_texop_txf_ms) {
         args = fmt(c, "%s, %s", args, src_scalar_as(c, tex_src(tex, nir_tex_src_ms_index), 0, WGSL_I32));
      } else if (!r->r.multisampled) {
         nir_src *lod = tex_src(tex, nir_tex_src_lod);
         args = fmt(c, "%s, %s", args, lod ? src_scalar_as(c, lod, 0, WGSL_I32) : "0i");
      }
      const char *e = fmt(c, "textureLoad(%s)", args);
      if (depth)
         line(c, "t%u = %s;", def->index, def->num_components == 1 ? fmt(c, "bitcast<u32>(%s)", e)
              : fmt(c, "vec4<u32>(bitcast<u32>(%s), 0u, 0u, 0x3f800000u).%s", e, comps(c, 0, def->num_components)));
      else
         assign_vec4(c, def, e, rbase);
      return;
   }

   const char *cf = as_base(c, src_name(c, coord), WGSL_F32, cn);
   cbase = cn == 1 ? cf : dn == 1 ? fmt(c, "%s.x", cf) : fmt(c, "%s.%s", cf, comps(c, 0, dn));
   if (tex->is_array)
      layer = fmt(c, "i32(round(%s.%s))", cf, swz(dn));
   const char *args = fmt(c, "%s, %s, %s", t, s, cbase);
   if (layer)
      args = fmt(c, "%s, %s", args, layer);
   nir_src *cmp = tex_src(tex, nir_tex_src_comparator);
   nir_src *lod = tex_src(tex, nir_tex_src_lod);
   nir_src *bias = tex_src(tex, nir_tex_src_bias);
   nir_src *ddx = tex_src(tex, nir_tex_src_ddx), *ddy = tex_src(tex, nir_tex_src_ddy);
   const char *e;
   switch (tex->op) {
   case nir_texop_tex:
      if (cmp)
         e = fmt(c, "%s(%s, %s", fragment ? "textureSampleCompare" : "textureSampleCompareLevel", args,
                 src_scalar_as(c, cmp, 0, WGSL_F32));
      else if (fragment)
         e = fmt(c, "textureSample(%s", args);
      else
         e = fmt(c, "textureSampleLevel(%s, %s", args, depth ? "0i" : "0.0");
      break;
   case nir_texop_txb:
      if (cmp)
         e = fmt(c, "textureSampleCompare(%s, %s", args, src_scalar_as(c, cmp, 0, WGSL_F32));
      else
         e = fmt(c, "textureSampleBias(%s, %s", args, src_scalar_as(c, bias, 0, WGSL_F32));
      break;
   case nir_texop_txl:
      if (cmp)
         e = fmt(c, "textureSampleCompareLevel(%s, %s", args, src_scalar_as(c, cmp, 0, WGSL_F32));
      else if (depth)
         e = fmt(c, "textureSampleLevel(%s, i32(%s)", args, src_scalar_as(c, lod, 0, WGSL_F32));
      else
         e = fmt(c, "textureSampleLevel(%s, %s", args, src_scalar_as(c, lod, 0, WGSL_F32));
      break;
   case nir_texop_txd:
      if (cmp) {
         e = fmt(c, "textureSampleCompareLevel(%s, %s", args, src_scalar_as(c, cmp, 0, WGSL_F32));
      } else {
         const unsigned gn = ddx->ssa->num_components;
         e = fmt(c, "textureSampleGrad(%s, %s, %s", args, as_base(c, src_name(c, ddx), WGSL_F32, gn),
                 as_base(c, src_name(c, ddy), WGSL_F32, gn));
      }
      break;
   case nir_texop_tg4:
      if (cmp)
         e = fmt(c, "textureGatherCompare(%s, %s", args, src_scalar_as(c, cmp, 0, WGSL_F32));
      else if (depth)
         e = fmt(c, "textureGather(%s", args);
      else
         e = fmt(c, "textureGather(%u, %s", tex->component, args);
      break;
   default:
      failf(c, "the texture op %d", tex->op);
      return;
   }
   if (offset)
      e = fmt(c, "%s, %s", e, offset);
   e = fmt(c, "%s)", e);
   const bool scalar = depth && tex->op != nir_texop_tg4;
   if (scalar)
      line(c, "t%u = %s;", def->index, def->num_components == 1 ? fmt(c, "bitcast<u32>(%s)", e)
           : fmt(c, "vec4<u32>(bitcast<u32>(%s), 0u, 0u, 0x3f800000u).%s", e, comps(c, 0, def->num_components)));
   else
      assign_vec4(c, def, e, tex->op == nir_texop_tg4 && depth ? WGSL_F32 : rbase);
}

/* Control flow. */

static void emit_cf_list(struct ctx *c, struct exec_list *list);

static void
emit_jump(struct ctx *c, nir_jump_instr *jump)
{
   switch (jump->type) {
   case nir_jump_break:
      line(c, "break;");
      break;
   case nir_jump_continue:
      line(c, "continue;");
      break;
   case nir_jump_return:
   case nir_jump_halt:
      if (c->nir->info.stage == MESA_SHADER_FRAGMENT && jump->type == nir_jump_halt)
         line(c, "discard;");
      else
         line(c, "return%s;", c->nir->info.stage == MESA_SHADER_COMPUTE ? "" : " o");
      break;
   default:
      failf(c, "a jump of type %d", jump->type);
   }
}

static void
emit_block(struct ctx *c, nir_block *block)
{
   nir_foreach_instr(instr, block) {
      if (c->failed)
         return;
      switch (instr->type) {
      case nir_instr_type_alu:
         emit_alu(c, nir_instr_as_alu(instr));
         break;
      case nir_instr_type_load_const:
         emit_load_const(c, nir_instr_as_load_const(instr));
         break;
      case nir_instr_type_undef:
         break;
      case nir_instr_type_intrinsic:
         emit_intrinsic(c, nir_instr_as_intrinsic(instr));
         break;
      case nir_instr_type_tex:
         emit_tex(c, nir_instr_as_tex(instr));
         break;
      case nir_instr_type_jump:
         emit_jump(c, nir_instr_as_jump(instr));
         break;
      default:
         failf(c, "an instruction of type %d", instr->type);
         break;
      }
   }
}

/* Whether a control-flow list holds a workgroup barrier. */
static bool
cf_has_barrier(struct exec_list *list)
{
   foreach_list_typed (nir_cf_node, node, node, list) {
      switch (node->type) {
      case nir_cf_node_block:
         nir_foreach_instr (instr, nir_cf_node_as_block(node))
            if (instr->type == nir_instr_type_intrinsic &&
                nir_instr_as_intrinsic(instr)->intrinsic == nir_intrinsic_barrier &&
                nir_intrinsic_execution_scope(nir_instr_as_intrinsic(instr)) >= SCOPE_WORKGROUP)
               return true;
         break;
      case nir_cf_node_if:
         if (cf_has_barrier(&nir_cf_node_as_if(node)->then_list) || cf_has_barrier(&nir_cf_node_as_if(node)->else_list))
            return true;
         break;
      case nir_cf_node_loop:
         if (cf_has_barrier(&nir_cf_node_as_loop(node)->body))
            return true;
         break;
      default:
         break;
      }
   }
   return false;
}

/* Whether a control-flow list jumps out of (or to the top of) the loop it is in. */
static bool
cf_has_jump(struct exec_list *list)
{
   foreach_list_typed (nir_cf_node, node, node, list) {
      if (node->type == nir_cf_node_block) {
         nir_foreach_instr (instr, nir_cf_node_as_block(node))
            if (instr->type == nir_instr_type_jump)
               return true;
      } else if (node->type == nir_cf_node_if) {
         if (cf_has_jump(&nir_cf_node_as_if(node)->then_list) || cf_has_jump(&nir_cf_node_as_if(node)->else_list))
            return true;
      }
   }
   return false;
}

static bool
needs_uniform_condition(struct ctx *c, nir_if *nif)
{
   if (c->nir->info.stage != MESA_SHADER_COMPUTE)
      return false;
   return cf_has_barrier(&nif->then_list) || cf_has_barrier(&nif->else_list) ||
          (c->in_barrier_loop && (cf_has_jump(&nif->then_list) || cf_has_jump(&nif->else_list)));
}

static void
emit_cf_list(struct ctx *c, struct exec_list *list)
{
   foreach_list_typed(nir_cf_node, node, node, list) {
      switch (node->type) {
      case nir_cf_node_block:
         emit_block(c, nir_cf_node_as_block(node));
         break;
      case nir_cf_node_if: {
         nir_if *nif = nir_cf_node_as_if(node);
         if (needs_uniform_condition(c, nif)) {
            /* WGSL's uniformity analysis can't see that Vulkan's barriers are in uniform control flow (every value
             * here is a var, assigned wherever): the condition of an if around a barrier, or breaking out of a loop
             * that holds one, is passed through workgroupUniformLoad. The barrier after it keeps the next write of
             * the same var from racing this read. */
            const unsigned n = c->uniform_conds++;
            line(c, "wg_uc%u = select(0u, 1u, %s);", n, src_comp(c, &nif->condition, 0));
            line(c, "let uc%u = workgroupUniformLoad(&wg_uc%u);", n, n);
            line(c, "workgroupBarrier();");
            line(c, "if (uc%u != 0u) {", n);
         } else {
            line(c, "if (%s) {", src_comp(c, &nif->condition, 0));
         }
         c->indent++;
         emit_cf_list(c, &nif->then_list);
         c->indent--;
         if (!nir_cf_list_is_empty_block(&nif->else_list)) {
            line(c, "} else {");
            c->indent++;
            emit_cf_list(c, &nif->else_list);
            c->indent--;
         }
         line(c, "}");
         break;
      }
      case nir_cf_node_loop: {
         nir_loop *loop = nir_cf_node_as_loop(node);
         if (nir_loop_has_continue_construct(loop))
            failf(c, "a loop with a continue construct");
         line(c, "loop {");
         c->indent++;
         const bool outer = c->in_barrier_loop;
         c->in_barrier_loop = c->nir->info.stage == MESA_SHADER_COMPUTE && cf_has_barrier(&loop->body);
         emit_cf_list(c, &loop->body);
         c->in_barrier_loop = outer;
         c->indent--;
         line(c, "}");
         break;
      }
      default:
         failf(c, "a control-flow node of type %d", node->type);
      }
   }
}

char *
wgsl_print(void *mem_ctx, nir_shader *nir, const struct wgsl_varyings *fs, uint32_t max_immediates,
           struct wgsl_info *info, char *error, size_t error_size)
{
   wgsl_finish(nir);
   nir_function_impl *impl = nir_shader_get_entrypoint(nir);
   nir_index_ssa_defs(impl);
   memset(info, 0, sizeof(*info));
   struct ctx c = {
      .nir = nir,
      .mem = ralloc_context(NULL),
      .error = error,
      .error_size = error_size,
      .info = info,
      .fs = nir->info.stage == MESA_SHADER_VERTEX ? fs : NULL,
   };
   error[0] = 0;
   c.out = _mesa_string_buffer_create(c.mem, 4096);
   gather(&c, impl);
   /* Push constants past the immediates: a uniform buffer of the driver's, bound at a dynamic offset per draw. */
   if (info->immediate_size > max_immediates) {
      struct res_use *r = resource(&c, (WGSL_MAX_GROUPS - 1) << 16 | WGSL_PUSH_BINDING, WGSL_UNIFORM);
      r->r.size = info->immediate_size;
      info->push_ubo_size = info->immediate_size;
      info->immediate_size = 0;
   }

   const mesa_shader_stage stage = nir->info.stage;
   line(&c, "diagnostic(off, derivative_uniformity);");
   if (info->clip_distances)
      line(&c, "enable clip_distances;");
   if (info->immediate_size)
      line(&c, "requires immediate_address_space;");
   /* Immediates can't be arrays: a struct of vec4s, copied into an array the shader indexes. */
   if (info->immediate_size) {
      line(&c, "struct Immediates {");
      for (unsigned i = 0; i < info->immediate_size / 16; i++)
         line(&c, "  v%u: vec4<u32>,", i);
      line(&c, "}");
      line(&c, "var<immediate> immediates: Immediates;");
   }
   declare_resources(&c);
   declare_io(&c);
   if (stage == MESA_SHADER_COMPUTE && nir->info.shared_size)
      line(&c, "var<workgroup> shm: array<%s, %u>;", c.shm_atomic ? "atomic<u32>" : "u32",
           DIV_ROUND_UP(nir->info.shared_size, 4));
   if (nir->scratch_size)
      line(&c, "var<private> scratch: array<u32, %u>;", DIV_ROUND_UP(nir->scratch_size, 4));

   const bool has_out = stage == MESA_SHADER_VERTEX ||
                        (stage == MESA_SHADER_FRAGMENT && (info->outputs || info->writes_depth || info->writes_sample_mask));
   if (stage == MESA_SHADER_VERTEX) {
      line(&c, "@vertex fn main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32%s) -> Out {",
           info->inputs ? ", i: In" : "");
   } else if (stage == MESA_SHADER_FRAGMENT) {
      const char *params = (c.vary.mask || c.uses_frag_coord) ? "i: In" : "";
      if (c.uses_front_face)
         params = fmt(&c, "%s%s@builtin(front_facing) ff: bool", params, *params ? ", " : "");
      if (c.uses_sample_id)
         params = fmt(&c, "%s%s@builtin(sample_index) sid: u32", params, *params ? ", " : "");
      if (c.uses_sample_mask_in)
         params = fmt(&c, "%s%s@builtin(sample_mask) smask: u32", params, *params ? ", " : "");
      line(&c, "%s@fragment fn main(%s)%s {", nir->info.fs.early_fragment_tests ? "" : "", params,
           has_out ? " -> Out" : "");
   } else if (stage == MESA_SHADER_COMPUTE) {
      for (unsigned i = 0; i < 3; i++)
         info->workgroup[i] = nir->info.workgroup_size[i];
      line(&c, "@compute @workgroup_size(%u, %u, %u) fn main(@builtin(local_invocation_id) lid: vec3<u32>, "
               "@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>, "
               "@builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) lidx: u32) {",
           info->workgroup[0], info->workgroup[1], info->workgroup[2]);
   } else {
      failf(&c, "the %s stage", mesa_shader_stage_name(stage));
   }
   c.indent++;
   if (info->immediate_size) {
      const char *list = "immediates.v0";
      for (unsigned i = 1; i < info->immediate_size / 16; i++)
         list = fmt(&c, "%s, immediates.v%u", list, i);
      line(&c, "let pc = array<vec4<u32>, %u>(%s);", info->immediate_size / 16, list);
   }
   if (info->push_ubo_size)
      line(&c, "let pc = r%u_%u;", WGSL_MAX_GROUPS - 1, WGSL_PUSH_BINDING);
   predeclare(&c, impl);
   emit_cf_list(&c, &impl->body);
   if (stage == MESA_SHADER_VERTEX)
      line(&c, "o.pos.y = o.pos.y * wg_flip_y;");
   if (has_out)
      line(&c, "return o;");
   c.indent--;
   line(&c, "}");
   for (unsigned i = 0; i < c.uniform_conds; i++)
      line(&c, "var<workgroup> wg_uc%u: u32;", i);

   char *text = NULL;
   if (!c.failed)
      text = ralloc_strdup(mem_ctx, c.out->buf);
   ralloc_free(c.mem);
   return text;
}
