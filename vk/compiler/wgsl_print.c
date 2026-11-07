/*
 * Prints lowered NIR as WGSL (wgsl.h for the model). Shaped like KosmicKrisp's nir_to_msl.c (Mesa 26.2.4, MIT):
 * a gather of what the shader declares, the declarations, then the control flow printed node by node, each value a
 * let where its uses allow and a var otherwise (place_values). Our own code.
 */
#include <ctype.h>
#include <stdarg.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "nir.h"
#include "nir_xfb_info.h"
#include "util/format/u_format.h"
#include "util/ralloc.h"
#include "util/string_buffer.h"

#include "wgsl.h"

void wgsl_finish(nir_shader *nir);

/* What the shader uses, gathered before printing. */
struct res_use {
   bool used;
   struct wgsl_resource r;
   bool signed_atomic, unsigned_atomic;
   bool texel; /* a texel buffer's words (texel_buffer) */
   bool typed; /* a storage image read as a texture: its sample type from a load's (texture_images) */
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
   uint32_t max_inter_stage;
   const struct wgsl_varyings *fs;
   bool tier1; /* texture-formats-tier1: storage textures of more formats */
   bool tier2; /* texture-formats-tier2: read-write storage for more formats */
   uint32_t max_uniform_size; /* a uniform block's declared bytes at most (maxUniformBufferBindingSize) */
   bool dual_source; /* dual-source-blending */
   bool subgroups;   /* subgroups (wgsl_lower's subgroups of the adapter's size); else of one invocation */
   bool f16;         /* shader-f16 */
   bool uses_subgroup_ops, uses_sg_inv, uses_sg_size;
   bool uses_texel_buffers;
   /* Storage images this stage reaches as words (their index, whether it writes them, their format: image_words). */
   unsigned word_images[WGSL_MAX_RESOURCES];
   bool word_image_written[WGSL_MAX_RESOURCES];
   uint16_t word_image_format[WGSL_MAX_RESOURCES];
   unsigned word_image_count;
   /* Storage images declared without a format and written or only asked their size, and the format each is printed for
    * (image_format). */
   unsigned formatless_images[WGSL_MAX_RESOURCES];
   uint16_t formatless_format[WGSL_MAX_RESOURCES];
   unsigned formatless_count;
   const struct wgsl_sampler_key *keys;
   unsigned key_count;
   /* Storage images this stage only reads, as textures (texture_images). */
   unsigned tex_images[WGSL_MAX_RESOURCES];
   unsigned tex_image_count;
   bool storage_limits;
   uint32_t max_storage_textures; /* the stage's, where storage_limits */

   struct res_use res[WGSL_MAX_RESOURCES];
   unsigned res_count;
   bool shm_atomic, shm_signed, shm_unsigned, uses_helper, uses_frag_coord, uses_front_face, uses_draw_params, uses_sample_id, uses_sample_mask_in;
   bool uses_interp_at_sample; /* interpolateAtSample: wg_sample_pos without the sample rate */
   uint32_t ubo_sizes_unused;
   /* Fragment inputs and vertex outputs, by location (VARYING_SLOT_VAR0 + n). */
   struct wgsl_varyings vary;
   uint32_t vs_writes;           /* vertex: VAR locations written */
   bool xfb;                     /* vertex: outputs captured by transform feedback (`wg_xo`) */
   uint8_t vs_write_base[32];
   uint8_t input_comps[32];
   /* Compute: ifs whose condition goes through workgroupUniformLoad (below), and whether the loop being printed
    * holds a barrier. */
   unsigned uniform_conds;
   bool in_barrier_loop;
   /* Where a uniform condition goes: shared memory's spare word or a var of its own (`uc`), or shared memory's first
    * word, saved and restored around it where shared memory leaves no room (`uc_save`; through atomics where shared
    * memory is of atomics). */
   const char *uc;
   bool uc_save;
   unsigned shm_words;

   /* Where each value is declared (place_values). Each control-flow list is a scope (by its blocks' index:
    * block_scope), under the list holding its if or loop (scope_parent), loop bodies marked. A value whose uses all
    * stay in its own scope is a `let` where its instruction assigns it once at its own level, else a var declared
    * just before the instruction (decl_scope -1); any other value, and every register, a var declared where its scope
    * starts (decl_scope, chained per scope from scope_first through decl_next). */
   unsigned *block_scope;
   int *scope_parent;
   unsigned *scope_depth;
   bool *scope_loop;
   int *decl_scope, *decl_next, *scope_first;
   const char **decl_type;
   /* Values stored as f32, by index (float_values). */
   BITSET_WORD *fdef;
   /* By a register load's value: the register it reads where its uses can name that instead (alias_loads), else -1. */
   int *alias;
   /* By a loop body's scope: the registers its iterations may read before writing them (carry_loop). */
   BITSET_WORD **scope_carried;
   int *reg_num; /* a register's number in those sets, by its decl's value */
   unsigned reg_words;
   /* The instruction being printed whose value may be a let: its name, the indent and the output's offset of its
    * assignments at its own level, how many, and whether a line assigned it in part or deeper. */
   bool track;
   char track_name[16];
   unsigned track_len, track_indent, track_count;
   uint32_t track_off;
   bool track_other;
   /* A run-once loop's final break, not printed (loop_once); the list to print next continuing its scope. */
   nir_instr *skip_jump;
   bool in_scope;
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
   const uint32_t at = c->out->length;
   va_list ap;
   va_start(ap, fmt);
   _mesa_string_buffer_vprintf(c->out, fmt, ap);
   va_end(ap);
   _mesa_string_buffer_append(c->out, "\n");
   /* The tracked value (place_values) named in the line: assigned whole (`tN = ` first) at its instruction's level, or
    * anything else (assigned in part, deeper, mid-line). */
   if (!c->track)
      return;
   for (const char *s = c->out->buf + at; (s = strstr(s, c->track_name)); s += c->track_len) {
      const char *rest = s + c->track_len;
      if ((s > c->out->buf + at && (isalnum((unsigned char)s[-1]) || s[-1] == '_')) || isdigit((unsigned char)*rest))
         continue;
      if (s == c->out->buf + at && !strncmp(rest, " = ", 3) && c->indent == c->track_indent) {
         if (!c->track_count++)
            c->track_off = at;
      } else {
         c->track_other = true;
      }
   }
}

/* Replaces the output's `len` bytes at `off` with `text`. */
static void
splice(struct ctx *c, uint32_t off, uint32_t len, const char *text)
{
   char *tail = strdup(c->out->buf + off + len);
   c->out->length = off;
   c->out->buf[off] = 0;
   _mesa_string_buffer_append(c->out, text);
   _mesa_string_buffer_append(c->out, tail);
   free(tail);
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
   if (c->alias && c->alias[def->index] >= 0)
      return fmt(c, "t%d", c->alias[def->index]);
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

/* A 16-bit value is kept in a u32's low half (the high half zero), an 8-bit one in its low byte (VK4 T29). Its view as
 * `base`: the half as an f16 (shader-f16's arithmetic), or as a 32-bit integer, zero- or sign-extended. */
static const char *
view_narrow(struct ctx *c, const char *raw, unsigned base, unsigned bits)
{
   if (base == WGSL_F32) {
      if (bits != 16)
         failf(c, "8-bit floats");
      else if (!c->f16)
         failf(c, "16-bit float arithmetic without the device's shader-f16");
      return fmt(c, "bitcast<vec2<f16>>(%s).x", raw);
   }
   if (base == WGSL_I32)
      return fmt(c, "(bitcast<i32>(%s << %uu) >> %uu)", raw, 32 - bits, 32 - bits);
   return raw;
}

/* And back: an expression of `base` (f16, or an integer whose low bits are the value) to storage. */
static const char *
store_narrow(struct ctx *c, const char *e, unsigned base, unsigned bits)
{
   const char *mask = bits == 8 ? "0xffu" : "0xffffu";
   if (base == WGSL_F32)
      return fmt(c, "bitcast<u32>(vec2<f16>(%s, 0.0h))", e);
   if (base == WGSL_I32)
      return fmt(c, "(bitcast<u32>(%s) & %s)", e, mask);
   return fmt(c, "(%s & %s)", e, mask);
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

/* Whether WebGPU lets a storage texture of this format be bound with `access` (WebGPU's format tables): core's formats
 * read-only and write-only, the others with texture-formats-tier1; read-write only for r32 in core and tier2's formats
 * with texture-formats-tier2; bgra8unorm (bgra8unorm-storage) write-only. */
static bool
storage_access_ok(const char *format, uint8_t access, bool tier1, bool tier2)
{
   if (!strcmp(format, "bgra8unorm"))
      return access == WGSL_ACCESS_WRITE;
   static const char *const r32[] = { "r32uint", "r32sint", "r32float" };
   for (unsigned i = 0; i < ARRAY_SIZE(r32); i++)
      if (!strcmp(format, r32[i]))
         return true;
   static const char *const core[] = { "rgba8unorm", "rgba8snorm", "rgba8uint", "rgba8sint", "rgba16uint", "rgba16sint",
                                       "rgba16float", "rg32uint", "rg32sint", "rg32float", "rgba32uint", "rgba32sint",
                                       "rgba32float" };
   bool in_core = false;
   for (unsigned i = 0; i < ARRAY_SIZE(core); i++)
      in_core |= !strcmp(format, core[i]);
   if (!in_core && !tier1 && !tier2) /* WebGPU's tier2 brings tier1 */
      return false;
   if (access != (WGSL_ACCESS_READ | WGSL_ACCESS_WRITE))
      return true;
   static const char *const t2[] = { "r8unorm", "r8uint", "r8sint", "rgba8unorm", "rgba8uint", "rgba8sint",
                                     "r16uint", "r16sint", "r16float", "rgba16uint", "rgba16sint", "rgba16float",
                                     "rgba32uint", "rgba32sint", "rgba32float" };
   for (unsigned i = 0; tier2 && i < ARRAY_SIZE(t2); i++)
      if (!strcmp(format, t2[i]))
         return true;
   return false;
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

bool
wgsl_image_as_words(unsigned format, uint8_t access, unsigned features)
{
   const char *name = storage_format(format);
   return name && !storage_access_ok(name, access, features & WGSL_TIER1, features & WGSL_TIER2);
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

/* An array's atomics compare signed (imin, imax: atomic<i32>) or unsigned (umin, umax: atomic<u32>); WGSL's atomics
 * have one type, so an array that needs both is refused. */
static void
atomic_sign(struct ctx *c, nir_atomic_op op, bool *is_signed, bool *is_unsigned)
{
   if (op == nir_atomic_op_imin || op == nir_atomic_op_imax)
      *is_signed = true;
   else if (op == nir_atomic_op_umin || op == nir_atomic_op_umax)
      *is_unsigned = true;
   if (*is_signed && *is_unsigned)
      failf(c, "signed and unsigned atomic min or max on one array");
}

/* The parameters of the resource at `index` (a texel buffer's, a storage image's as words): two vec4s of its group's
 * table (WGSL_TABLE_BINDING), at its binding. */
static void
param_table(struct ctx *c, unsigned index)
{
   struct res_use *t = resource(c, (index >> 16) << 16 | WGSL_TABLE_BINDING, WGSL_UNIFORM);
   t->r.size = MAX2(t->r.size, WGSL_TABLE_SIZE(index & 0xffff));
}

/* Its first or second vec4 (`i`). */
static const char *
param(struct ctx *c, const struct wgsl_resource *r, unsigned i)
{
   return fmt(c, "r%u_%u[%uu]", r->group, WGSL_TABLE_BINDING, r->binding + i);
}

/* A texel buffer (uniform or storage) at `index`: its words as a storage buffer there, and its view's parameters in
 * its group's table (the driver's, from the VkBufferView: the format's layout, the first texel's byte and the texel
 * count). The format is the view's, known only when the descriptor is bound, so loads and stores decode and encode it
 * from the parameters (`wg_tb_*`). */
static void
texel_buffer(struct ctx *c, unsigned index, bool writes)
{
   struct res_use *r = resource(c, index, WGSL_STORAGE_READ);
   r->texel = true;
   if (writes)
      r->r.kind = WGSL_STORAGE, r->r.written = true;
   param_table(c, index);
   c->uses_texel_buffers = true;
}

/* WGSL has no atomics on textures, and WebGPU binds most formats' storage textures one way or, without tier1, not at all,
 * so a storage image an atomic reaches, or one this stage accesses in a way WebGPU's texture of its format doesn't allow,
 * is in that stage its view's words: a storage buffer at its binding (of atomics where the stage writes it: a store under
 * a word shares it with other invocations' texels) and the view's parameters in its group's table, two vec4s
 * (p0 = (width, height, depth or layers, words between rows), p1.x = words between slices): the driver's, whose replay
 * keeps the words and the image's textures in step (vk/README.md "Storage images as words"). Every access of that
 * binding in the stage goes through them, the format's encoding printed from its description (declare_word_images). */
static int
word_image(const struct ctx *c, unsigned index)
{
   for (unsigned i = 0; i < c->word_image_count; i++)
      if (c->word_images[i] == index)
         return i;
   return -1;
}

static bool
is_word_image(const struct ctx *c, unsigned index)
{
   return word_image(c, index) >= 0;
}

/* A storage image the stage only reads (loads and size queries, no atomics, not multisampled) can be a texture there,
 * read by `textureLoad` at its view's first level (GD G4). It is one where it must be (loaded without a format, or of a
 * format with no storage texture) and where the stage's storage textures are past WebGPU's for the stage (8 at most, 4
 * by default; Godot's SDFGI stages bind 15 storage images, 12 only read), those it only reads in order until they fit:
 * not before, since textures have a limit of their own (16), which a stage sampling 16 would pass. The driver binds the
 * storage image's view, its texture made with TEXTURE_BINDING beside STORAGE_BINDING. Every access of that binding in
 * the stage goes through it; a pipeline whose stages disagree on its kind or sample type is refused (wg_shader.c), as
 * one whose stages' storage access differed was before. An image only asked its size without a format stays what it
 * was (refused: its sample type is unknown). */
static bool
is_tex_image(const struct ctx *c, unsigned index)
{
   for (unsigned i = 0; i < c->tex_image_count; i++)
      if (c->tex_images[i] == index)
         return true;
   return false;
}

/* A storage image read as a texture: its resource, its sample type from the type a load returns (the format where the
 * stage only asks its size). */
static void
texture_image(struct ctx *c, unsigned index, nir_intrinsic_instr *intr)
{
   struct res_use *r = resource(c, index, WGSL_TEXTURE);
   r->r.kind = WGSL_TEXTURE;
   r->r.image_texture = true;
   r->r.dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
   if (nir_intrinsic_format(intr) != PIPE_FORMAT_NONE)
      r->r.format = nir_intrinsic_format(intr);
   if (intr->intrinsic == nir_intrinsic_image_load) {
      const nir_alu_type t = nir_alu_type_get_base_type(nir_intrinsic_dest_type(intr));
      r->r.sample = t == nir_type_int ? WGSL_SAMPLE_SINT : t == nir_type_uint ? WGSL_SAMPLE_UINT : WGSL_SAMPLE_UNFILTERABLE;
      r->typed = true;
   } else if (!r->typed) {
      const enum pipe_format f = r->r.format;
      r->r.sample = util_format_is_pure_sint(f) ? WGSL_SAMPLE_SINT : util_format_is_pure_uint(f) ? WGSL_SAMPLE_UINT
                                                                                                : WGSL_SAMPLE_UNFILTERABLE;
   }
}

/* A storage image's format: its declaration's, or, declared without one (`shaderStorageImageWriteWithoutFormat`, GD G5;
 * an image only read is a texture: texture_images), the bound view's, from the variant's key (WGSL_IMAGE_KEY: the
 * driver's `program_keys`), else r32uint, a format core WebGPU binds read-write, for the stage's module before any
 * bind (the draws and dispatches take a variant). Whether it is a storage texture or words follows from that format
 * as from a declared one. */
static enum pipe_format
image_format(const struct ctx *c, nir_intrinsic_instr *intr)
{
   /* (A declared format a key overrides too: a written image bound to a view of another format, `gather`.) */
   if (!nir_src_is_const(intr->src[0]))
      return nir_intrinsic_format(intr);
   const unsigned index = nir_src_as_uint(intr->src[0]);
   for (unsigned i = 0; i < c->formatless_count; i++)
      if (c->formatless_images[i] == index)
         return c->formatless_format[i];
   return nir_intrinsic_format(intr);
}

static bool
is_formatless(const struct ctx *c, unsigned index)
{
   for (unsigned i = 0; i < c->formatless_count; i++)
      if (c->formatless_images[i] == index)
         return true;
   return false;
}

static struct res_use *
image_words(struct ctx *c, unsigned index, nir_intrinsic_instr *intr)
{
   const int w = word_image(c, index);
   const bool written = w < 0 || c->word_image_written[w]; /* w < 0: an index that isn't constant, failed already */
   struct res_use *r = resource(c, index, written ? WGSL_STORAGE : WGSL_STORAGE_READ);
   r->r.kind = written ? WGSL_STORAGE : WGSL_STORAGE_READ;
   r->r.atomic = r->r.written = written;
   r->r.image_words = true;
   r->r.dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
   r->r.format = w < 0 ? nir_intrinsic_format(intr) : c->word_image_format[w];
   r->r.formatless = is_formatless(c, index);
   param_table(c, index);
   return r;
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
      /* Read-write where this stage writes it (a buffer one stage reads and another writes is read-only in the reader:
       * a vertex stage can't bind it read-write, and WebGPU wants each module's access to be the entry's). */
      if (writes)
         r->r.kind = WGSL_STORAGE, r->r.written = true;
      /* A 16- or 8-bit store is two atomics on its word (emit_narrow_access). */
      if (intr->intrinsic == nir_intrinsic_store_ssbo && intr->src[0].ssa->bit_size < 32)
         r->r.atomic = true;
      if (intr->intrinsic == nir_intrinsic_ssbo_atomic || intr->intrinsic == nir_intrinsic_ssbo_atomic_swap) {
         r->r.atomic = true;
         atomic_sign(c, nir_intrinsic_atomic_op(intr), &r->signed_atomic, &r->unsigned_atomic);
      }
      break;
   }
   case nir_intrinsic_shared_atomic:
   case nir_intrinsic_shared_atomic_swap:
      c->shm_atomic = true;
      atomic_sign(c, nir_intrinsic_atomic_op(intr), &c->shm_signed, &c->shm_unsigned);
      break;
   case nir_intrinsic_store_shared:
      if (intr->src[0].ssa->bit_size < 32)
         c->shm_atomic = true;
      break;
   case nir_intrinsic_image_load:
   case nir_intrinsic_image_store:
   case nir_intrinsic_image_size: {
      if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF) {
         texel_buffer(c, const_index(c, &intr->src[0]), intr->intrinsic == nir_intrinsic_image_store);
         break;
      }
      if (is_tex_image(c, const_index(c, &intr->src[0]))) {
         texture_image(c, const_index(c, &intr->src[0]), intr);
         break;
      }
      if (is_word_image(c, const_index(c, &intr->src[0]))) {
         image_words(c, const_index(c, &intr->src[0]), intr);
         break;
      }
      struct res_use *r = resource(c, const_index(c, &intr->src[0]), WGSL_STORAGE_TEXTURE);
      r->r.dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
      r->r.format = image_format(c, intr);
      r->r.formatless = is_formatless(c, const_index(c, &intr->src[0]));
      if (!storage_format(r->r.format))
         failf(c, "a storage image of format %s", util_format_name(r->r.format));
      if (intr->intrinsic == nir_intrinsic_image_load)
         r->r.access |= WGSL_ACCESS_READ;
      else if (intr->intrinsic == nir_intrinsic_image_store)
         r->r.access |= WGSL_ACCESS_WRITE;
      break;
   }
   case nir_intrinsic_load_view_index:
      c->info->uses_view = true;
      break;
   case nir_intrinsic_image_atomic:
   case nir_intrinsic_image_atomic_swap: {
      const enum pipe_format f = nir_intrinsic_format(intr);
      if (f != PIPE_FORMAT_R32_UINT && f != PIPE_FORMAT_R32_SINT) {
         failf(c, "image atomics on %s", util_format_name(f));
         break;
      }
      const unsigned index = const_index(c, &intr->src[0]);
      struct res_use *r;
      if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF) {
         texel_buffer(c, index, true);
         r = resource(c, index, WGSL_STORAGE);
         r->r.atomic = true;
      } else {
         r = image_words(c, index, intr);
      }
      atomic_sign(c, nir_intrinsic_atomic_op(intr), &r->signed_atomic, &r->unsigned_atomic);
      break;
   }
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
         const bool clip = slot == VARYING_SLOT_CLIP_DIST0 || slot == VARYING_SLOT_CLIP_DIST1;
         if (!clip && (slot < VARYING_SLOT_VAR0 || slot >= VARYING_SLOT_VAR0 + 32)) {
            failf(c, "fragment input slot %u", slot);
            break;
         }
         /* gl_ClipDistance: at the top locations until declare_io finds free ones. */
         const unsigned loc = clip ? 30 + slot - VARYING_SLOT_CLIP_DIST0 : slot - VARYING_SLOT_VAR0;
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
            /* Shading at the sample rate (the pipeline's sampleShadingEnable, or the shader reads its sample's id or
             * declares an input per sample: VK3 L7.1), every input not at the centroid is at its sample. */
            c->vary.sampling[loc] = bary->intrinsic == nir_intrinsic_load_barycentric_centroid ? WGSL_SAMPLING_CENTROID
                                    : bary->intrinsic == nir_intrinsic_load_barycentric_sample ||
                                          nir->info.fs.uses_sample_shading
                                       ? WGSL_SAMPLING_SAMPLE
                                       : WGSL_SAMPLING_CENTER;
            /* interpolateAtOffset, interpolateAtSample: from the input where it is interpolated, by its derivatives
             * (emit_input; VK3 L7b, the review of L6b-L7.3's finding 1: sampleRateShading brings them). */
            if (bary->intrinsic == nir_intrinsic_load_barycentric_at_sample)
               c->uses_interp_at_sample = true;
         }
      }
      break;
   case nir_intrinsic_store_output: {
      const nir_io_semantics sem = nir_intrinsic_io_semantics(intr);
      if (nir->info.stage == MESA_SHADER_VERTEX) {
         /* Transform feedback: the words of each buffer's record this store writes (io_xfb's runs of components). */
         if (c->xfb) {
            const nir_io_xfb x = nir_intrinsic_io_xfb(intr);
            const unsigned first = nir_intrinsic_component(intr), mask = nir_intrinsic_write_mask(intr);
            for (unsigned k = 0; k < 4; k++)
               for (unsigned n = 0; n < x.out[k].num_components; n++)
                  if (k + n >= first && (mask & (1u << (k + n - first)))) {
                     const unsigned w = x.out[k].offset + n;
                     if (w >= 128 || intr->src[0].ssa->bit_size != 32)
                        failf(c, "a transform feedback output past 512 bytes or not 32-bit");
                     else
                        c->info->xfb_words[x.out[k].buffer][w / 32] |= 1u << (w % 32);
                  }
         }
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
            if (sem.dual_source_blend_index) {
               /* WGSL's dual_source_blending: location 0 alone, its two outputs @blend_src(0) and (1). */
               if (!c->dual_source)
                  failf(c, "dual-source blending without the device's dual-source-blending");
               c->info->dual_source = true;
               c->info->dual_base = base_of(nir_intrinsic_src_type(intr));
               break;
            }
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
   /* Draw parameters (VK3 L7.5): words of the push buffer past the push constants (WGSL_DRAW_PARAMS), which WGSL has
    * no built-ins for (its vertex_index and instance_index include the bases, as Vulkan's VertexIndex and
    * InstanceIndex do). */
   case nir_intrinsic_load_first_vertex:
   case nir_intrinsic_load_base_instance:
   case nir_intrinsic_load_draw_id:
      c->uses_draw_params = true;
      c->info->immediate_size = MAX2(c->info->immediate_size, WGSL_DRAW_PARAMS + 16);
      break;
   case nir_intrinsic_load_sample_id:
   case nir_intrinsic_load_sample_pos:
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
   case nir_intrinsic_is_helper_invocation:
   case nir_intrinsic_load_helper_invocation:
      c->uses_helper = true;
      c->uses_sample_mask_in = true;
      break;
   case nir_intrinsic_load_global_invocation_id:
   case nir_intrinsic_load_workgroup_id:
      c->info->uses_base = true;
      break;
   case nir_intrinsic_load_subgroup_invocation:
   case nir_intrinsic_load_subgroup_size:
   case nir_intrinsic_load_subgroup_id:
   case nir_intrinsic_load_num_subgroups:
   case nir_intrinsic_ballot:
   case nir_intrinsic_vote_any:
   case nir_intrinsic_vote_all:
   case nir_intrinsic_read_invocation:
   case nir_intrinsic_read_first_invocation:
   case nir_intrinsic_first_invocation:
   case nir_intrinsic_shuffle:
   case nir_intrinsic_shuffle_xor:
   case nir_intrinsic_shuffle_up:
   case nir_intrinsic_shuffle_down:
   case nir_intrinsic_quad_broadcast:
   case nir_intrinsic_quad_swap_horizontal:
   case nir_intrinsic_quad_swap_vertical:
   case nir_intrinsic_quad_swap_diagonal:
   case nir_intrinsic_elect:
   case nir_intrinsic_reduce:
   case nir_intrinsic_inclusive_scan:
   case nir_intrinsic_exclusive_scan:
      if (!c->subgroups)
         break;
      /* WGSL has subgroups in compute and fragment shaders only (what the device advertises). */
      if (nir->info.stage != MESA_SHADER_COMPUTE && nir->info.stage != MESA_SHADER_FRAGMENT)
         failf(c, "subgroup operations in a %s shader", mesa_shader_stage_name(nir->info.stage));
      if (intr->intrinsic == nir_intrinsic_load_subgroup_invocation)
         c->uses_sg_inv = true;
      else if (intr->intrinsic == nir_intrinsic_load_subgroup_size || intr->intrinsic == nir_intrinsic_load_subgroup_id ||
               intr->intrinsic == nir_intrinsic_load_num_subgroups)
         c->uses_sg_size = true;
      else
         c->uses_subgroup_ops = true;
      if (intr->intrinsic == nir_intrinsic_first_invocation)
         c->uses_sg_inv = true;
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
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_BUF) {
      if (tex->op != nir_texop_txf && tex->op != nir_texop_txs)
         failf(c, "the texel buffer op %d", tex->op);
      texel_buffer(c, tex->texture_index, false);
      return;
   }
   const bool sampled = tex->op != nir_texop_txf && tex->op != nir_texop_txf_ms && tex->op != nir_texop_txs &&
                        tex->op != nir_texop_query_levels && tex->op != nir_texop_texture_samples;
   struct res_use *t = resource(c, tex->texture_index, WGSL_TEXTURE);
   t->r.dim = tex_dim(c, tex->sampler_dim, tex->is_array);
   t->r.multisampled = tex->sampler_dim == GLSL_SAMPLER_DIM_MS || tex->op == nir_texop_txf_ms;
   if (tex->op == nir_texop_txs || tex->op == nir_texop_query_levels) {
      if (tex->component)
         t->r.sample = tex->component == 1 ? WGSL_SAMPLE_SINT : WGSL_SAMPLE_UINT;
   }
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
      bool known = false;
      for (unsigned i = 0; i < c->info->pair_count; i++)
         known |= c->info->pairs[i][0] == tex->texture_index && c->info->pairs[i][1] == tex->sampler_index;
      if (!known && c->info->pair_count < WGSL_MAX_PAIRS) {
         c->info->pairs[c->info->pair_count][0] = tex->texture_index;
         c->info->pairs[c->info->pair_count++][1] = tex->sampler_index;
      } else if (!known) {
         /* The driver makes an unfilterable texture's samplers non-filtering by them (VK3 L7a, the binding review's
          * finding 4: past the cap they were dropped, and the pipeline was invalid). */
         failf(c, "more than %u texture-sampler pairs", WGSL_MAX_PAIRS);
      }
   }
}

static void
gather(struct ctx *c, nir_function_impl *impl)
{
   /* First which images go by their words: how the stage accesses each, wherever it does (image_words). */
   struct {
      unsigned index;
      uint8_t access;
      uint16_t format;
      bool atomic, ms, loaded;
   } images[WGSL_MAX_RESOURCES];
   unsigned image_count = 0;
   nir_foreach_block(block, impl) {
      nir_foreach_instr(instr, block) {
         if (instr->type != nir_instr_type_intrinsic)
            continue;
         nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
         const bool atomic = intr->intrinsic == nir_intrinsic_image_atomic || intr->intrinsic == nir_intrinsic_image_atomic_swap;
         if (!atomic && intr->intrinsic != nir_intrinsic_image_load && intr->intrinsic != nir_intrinsic_image_store &&
             intr->intrinsic != nir_intrinsic_image_size)
            continue;
         if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF || !nir_src_is_const(intr->src[0]))
            continue;
         const unsigned index = nir_src_as_uint(intr->src[0]);
         unsigned i = 0;
         while (i < image_count && images[i].index != index)
            i++;
         if (i == WGSL_MAX_RESOURCES)
            continue;
         if (i == image_count)
            images[image_count++] = (__typeof__(images[0])){ .index = index };
         images[i].access |= atomic ? WGSL_ACCESS_READ | WGSL_ACCESS_WRITE
                             : intr->intrinsic == nir_intrinsic_image_store ? WGSL_ACCESS_WRITE
                             : intr->intrinsic == nir_intrinsic_image_load ? WGSL_ACCESS_READ : 0;
         images[i].atomic |= atomic;
         images[i].ms |= nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_MS;
         images[i].loaded |= intr->intrinsic == nir_intrinsic_image_load;
         if (nir_intrinsic_format(intr) != PIPE_FORMAT_NONE)
            images[i].format = nir_intrinsic_format(intr);
      }
   }
   /* An image declared without a format that the stage writes or only asks the size of: the key's format, or r32uint
    * (image_format). One declared with a format that the stage writes, bound to a view of another (Godot's
    * screen-space effects write an image declared rgba8 through an r8 view: native drivers write the view's format,
    * the descriptor's), the key's too: the driver keys it only then (wg_cmd.c `program_keys`). */
   for (unsigned i = 0; i < image_count; i++) {
      if (images[i].format && !images[i].atomic && !images[i].ms && (images[i].access & WGSL_ACCESS_WRITE)) {
         for (unsigned k = 0; k < c->key_count; k++)
            if (c->keys[k].sampler == WGSL_IMAGE_KEY && c->keys[k].texture == images[i].index && c->keys[k].format &&
                c->formatless_count < WGSL_MAX_RESOURCES) {
               c->formatless_images[c->formatless_count] = images[i].index;
               c->formatless_format[c->formatless_count++] = c->keys[k].format;
               images[i].format = c->keys[k].format;
               break;
            }
         continue;
      }
      if (images[i].format || images[i].atomic || images[i].ms ||
          (images[i].loaded && !(images[i].access & WGSL_ACCESS_WRITE)))
         continue;
      uint16_t f = PIPE_FORMAT_R32_UINT;
      for (unsigned k = 0; k < c->key_count; k++)
         if (c->keys[k].sampler == WGSL_IMAGE_KEY && c->keys[k].texture == images[i].index && c->keys[k].format)
            f = c->keys[k].format;
      c->formatless_images[c->formatless_count] = images[i].index;
      c->formatless_format[c->formatless_count++] = f;
      images[i].format = f;
   }
   /* Each image a storage texture, its words or a texture (texture_images): a texture where only one can be (read
    * without a format, or of a format without storage textures: its sample type from its loads), and past the stage's
    * storage textures, the others it only reads. */
   enum { AS_STORAGE, AS_WORDS, AS_TEXTURE } as[WGSL_MAX_RESOURCES];
   unsigned storage = 0;
   const unsigned features = (c->tier1 ? WGSL_TIER1 : 0) | (c->tier2 ? WGSL_TIER2 : 0);
   for (unsigned i = 0; i < image_count; i++) {
      /* An image only asked its size is bound as read-only (declare_resources). */
      const uint8_t access = images[i].access ? images[i].access : WGSL_ACCESS_READ;
      const bool read_only = !images[i].atomic && !images[i].ms && !(access & WGSL_ACCESS_WRITE);
      if (read_only && images[i].loaded && (!images[i].format || !storage_format(images[i].format)))
         as[i] = AS_TEXTURE;
      else if (images[i].atomic || wgsl_image_as_words(images[i].format, access, features))
         as[i] = AS_WORDS;
      else
         as[i] = AS_STORAGE, storage++;
   }
   for (unsigned i = 0; i < image_count && c->storage_limits && storage > c->max_storage_textures; i++)
      if (as[i] == AS_STORAGE && !images[i].atomic && !images[i].ms && !(images[i].access & WGSL_ACCESS_WRITE) &&
          (images[i].loaded || images[i].format) && !is_formatless(c, images[i].index))
         as[i] = AS_TEXTURE, storage--;
   for (unsigned i = 0; i < image_count; i++) {
      if (as[i] == AS_TEXTURE)
         c->tex_images[c->tex_image_count++] = images[i].index;
      if (as[i] != AS_WORDS)
         continue;
      c->word_images[c->word_image_count] = images[i].index;
      c->word_image_written[c->word_image_count] = images[i].access & WGSL_ACCESS_WRITE;
      c->word_image_format[c->word_image_count++] = images[i].format;
   }
   nir_foreach_block(block, impl) {
      nir_foreach_instr(instr, block) {
         if (instr->type == nir_instr_type_intrinsic)
            gather_intrinsic(c, nir_instr_as_intrinsic(instr));
         else if (instr->type == nir_instr_type_tex)
            gather_tex(c, nir_instr_as_tex(instr));
         else if (instr->type == nir_instr_type_alu) {
            nir_alu_instr *alu = nir_instr_as_alu(instr);
            if (alu->def.bit_size != 1 && alu->def.bit_size != 8 && alu->def.bit_size != 16 && alu->def.bit_size != 32)
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
         /* Vulkan limits the range bound, not the block: a block past WebGPU's largest uniform binding is declared
          * that large (an index past it reads what WGSL's bounds give; VK3 L7a, the binding review's finding 5). */
         r->size = MIN2(MAX2(align(r->size, 16), 16), c->max_uniform_size);
         line(c, "%s var<uniform> %s: array<vec4<u32>, %u>;", at, name, r->size / 16);
         break;
      case WGSL_STORAGE:
      case WGSL_STORAGE_READ: {
         /* The push buffer, as storage (wgsl_print_options.push_storage): read as a uniform one is. */
         if (r->group == WGSL_MAX_GROUPS - 1 && r->binding == WGSL_PUSH_BINDING) {
            r->size = MAX2(align(r->size, 16), 16);
            line(c, "%s var<storage, read> %s: array<vec4<u32>, %u>;", at, name, r->size / 16);
            break;
         }
         const char *el = r->atomic ? (c->res[i].signed_atomic ? "atomic<i32>" : "atomic<u32>") : "u32";
         if (r->atomic)
            r->kind = WGSL_STORAGE;
         r->signed_atomic = r->atomic && c->res[i].signed_atomic;
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

/* Texel buffers' loads and stores (texel_buffer): the view's parameters are two vec4s, p0 = (type | texel bytes << 8 |
 * swizzle << 16, the first texel's byte in the binding, the texel count, 0) and p1 = (each channel's width, each
 * channel's first bit in the texel, a byte each; the output component each channel is stored from, 3 bits each; 0):
 * the driver's (wg_format.c `wg_texel_buffer_layout`). The type is 0 unorm, 1 snorm, 2 uint, 3 sint, 4 float (16 or
 * 32 bits), 5 an unsigned 11- or 10-bit float, 6 uscaled, 7 sscaled (loads only); the swizzle picks each output component from a channel (0-3) or 0 or 1
 * (4, 5), as pipe_swizzle. A channel never straddles a word (the driver offers only such formats); a texel past the
 * count reads 0 and isn't written. Values travel as their 32-bit patterns, as everything in the printer does. */
static const char *const texel_buffer_helpers =
   "fn wg_tb_dec(v: u32, ty: u32, n: u32) -> u32 {\n"
   "  switch ty {\n"
   "    case 0u: { return bitcast<u32>(f32(v) / f32(0xffffffffu >> (32u - n))); }\n"
   "    case 1u: { let s = bitcast<i32>(v << (32u - n)) >> (32u - n);\n"
   "      return bitcast<u32>(max(f32(s) / f32((1u << (n - 1u)) - 1u), -1.0)); }\n"
   "    case 3u: { return bitcast<u32>(bitcast<i32>(v << (32u - n)) >> (32u - n)); }\n"
   "    case 6u: { return bitcast<u32>(f32(v)); }\n"
   "    case 7u: { return bitcast<u32>(f32(bitcast<i32>(v << (32u - n)) >> (32u - n))); }\n"
   "    case 4u: { if (n == 16u) { return bitcast<u32>(unpack2x16float(v).x); } return v; }\n"
   "    case 5u: { let mb = n - 5u; let e = v >> mb; let m = v & ((1u << mb) - 1u);\n"
   "      if (e == 0u) { return bitcast<u32>(f32(m) * exp2(-14.0 - f32(mb))); }\n"
   "      if (e == 31u) { return select(0x7f800000u, 0x7fc00000u, m != 0u); }\n"
   "      return ((e + 112u) << 23u) | (m << (23u - mb)); }\n"
   "    default: { return v; }\n"
   "  }\n"
   "}\n"
   "fn wg_tb_enc(x: u32, ty: u32, n: u32) -> u32 {\n"
   "  let m = 0xffffffffu >> (32u - n);\n"
   "  switch ty {\n"
   "    case 0u: { return u32(round(clamp(bitcast<f32>(x), 0.0, 1.0) * f32(m))); }\n"
   "    case 1u: { return bitcast<u32>(i32(round(clamp(bitcast<f32>(x), -1.0, 1.0) * f32(m >> 1u)))) & m; }\n"
   "    case 4u: { if (n == 16u) { return pack2x16float(vec2<f32>(bitcast<f32>(x), 0.0)) & 0xffffu; } return x; }\n"
   "    default: { return x & m; }\n"
   "  }\n"
   "}\n";

static void
declare_texel_buffers(struct ctx *c)
{
   if (!c->uses_texel_buffers)
      return;
   _mesa_string_buffer_append(c->out, texel_buffer_helpers);
   for (unsigned i = 0; i < c->res_count; i++) {
      if (!c->res[i].texel)
         continue;
      const struct wgsl_resource *r = &c->res[i].r;
      const char *words = fmt(c, "r%u_%u", r->group, r->binding), *p0 = param(c, r, 0), *p1 = param(c, r, 1);
      const char *name = fmt(c, "%u_%u", r->group, r->binding);
      /* A buffer an atomic reaches is of atomics, its loads and stores too. */
      const char *load = r->atomic ? (c->res[i].signed_atomic ? "bitcast<u32>(atomicLoad(&" : "(atomicLoad(&") : "(";
      const char *load_end = r->atomic ? "))" : ")";
      line(c, "fn wg_tb_size_%s() -> u32 { return %s.z; }", name, p0);
      line(c, "fn wg_tb_word_%s(i: u32) -> u32 {", name);
      line(c, "  let p0 = %s;", p0);
      line(c, "  if (i >= p0.z) { return 0xffffffffu; }");
      line(c, "  return (p0.y + i * ((p0.x >> 8u) & 0xffu)) >> 2u;");
      line(c, "}");
      line(c, "fn wg_tb_load_%s(i: u32) -> vec4<u32> {", name);
      line(c, "  let p0 = %s; let p1 = %s;", p0, p1);
      line(c, "  if (i >= p0.z) { return vec4<u32>(0u); }");
      line(c, "  let a = p0.y + i * ((p0.x >> 8u) & 0xffu); let ty = p0.x & 0xffu;");
      line(c, "  var ch = array<u32, 6>(0u, 0u, 0u, 0u, 0u, select(1u, 0x3f800000u, ty < 2u || ty >= 4u));");
      line(c, "  for (var k = 0u; k < 4u; k++) {");
      line(c, "    let n = (p1.x >> (8u * k)) & 0xffu;");
      line(c, "    if (n == 0u) { continue; }");
      line(c, "    let b = (a & 3u) * 8u + ((p1.y >> (8u * k)) & 0xffu);");
      line(c, "    ch[k] = wg_tb_dec(extractBits(%s%s[(a >> 2u) + (b >> 5u)]%s, b & 31u, n), ty, n);", load, words, load_end);
      line(c, "  }");
      line(c, "  let s = p0.x >> 16u;");
      line(c, "  return vec4<u32>(ch[s & 7u], ch[(s >> 3u) & 7u], ch[(s >> 6u) & 7u], ch[(s >> 9u) & 7u]);");
      line(c, "}");
      if (r->kind != WGSL_STORAGE || !r->written)
         continue;
      /* Only formats of whole words are offered for storage: a texel's words are written whole. */
      line(c, "fn wg_tb_store_%s(i: u32, v: vec4<u32>) {", name);
      line(c, "  let p0 = %s; let p1 = %s;", p0, p1);
      line(c, "  if (i >= p0.z) { return; }");
      line(c, "  let a = p0.y + i * ((p0.x >> 8u) & 0xffu); let ty = p0.x & 0xffu;");
      line(c, "  var w = array<u32, 4>(0u, 0u, 0u, 0u);");
      line(c, "  for (var k = 0u; k < 4u; k++) {");
      line(c, "    let n = (p1.x >> (8u * k)) & 0xffu;");
      line(c, "    if (n == 0u) { continue; }");
      line(c, "    let b = (p1.y >> (8u * k)) & 0xffu;");
      line(c, "    w[b >> 5u] = insertBits(w[b >> 5u], wg_tb_enc(v[(p1.z >> (3u * k)) & 3u], ty, n), b & 31u, n);");
      line(c, "  }");
      if (r->atomic)
         line(c, "  for (var k = 0u; k < ((p0.x >> 10u) & 0x3fu); k++) { atomicStore(&%s[(a >> 2u) + k], %s(w[k])); }", words,
              c->res[i].signed_atomic ? "bitcast<i32>" : "");
      else
         line(c, "  for (var k = 0u; k < ((p0.x >> 10u) & 0x3fu); k++) { %s[(a >> 2u) + k] = w[k]; }", words);
      line(c, "}");
   }
}

/* A channel's bits in a texel's words, w0 and on. */
static const char *
channel_bits(struct ctx *c, const struct util_format_channel_description *ch)
{
   if (ch->size == 32)
      return fmt(c, "w%u", ch->shift / 32);
   return fmt(c, "((w%u >> %uu) & 0x%xu)", ch->shift / 32, ch->shift % 32, (1u << ch->size) - 1);
}

/* Component `comp` of a texel as a shader loads it, a u32 of its bits. */
static const char *
channel_load(struct ctx *c, const struct util_format_description *d, unsigned comp, bool pure)
{
   const unsigned s = d->swizzle[comp];
   if (s == PIPE_SWIZZLE_0)
      return "0u";
   if (s == PIPE_SWIZZLE_1)
      return pure ? "1u" : "0x3f800000u";
   const struct util_format_channel_description *ch = &d->channel[s];
   const char *bits = channel_bits(c, ch);
   switch (ch->type) {
   case UTIL_FORMAT_TYPE_FLOAT:
      /* 11- and 10-bit floats are 16-bit ones without a sign and the mantissa's low bits. */
      return ch->size == 32 ? bits : fmt(c, "wg_f16_to_f32(%s << %uu)", bits, ch->size == 16 ? 0 : 15 - ch->size);
   case UTIL_FORMAT_TYPE_UNSIGNED:
      return ch->normalized ? fmt(c, "bitcast<u32>(f32(%s) / %u.0)", bits, (1u << ch->size) - 1) : bits;
   default: {
      if (ch->size == 32)
         return bits;
      const char *wide = fmt(c, "(bitcast<i32>(%s << %uu) >> %uu)", bits, 32 - ch->size, 32 - ch->size);
      return ch->normalized ? fmt(c, "bitcast<u32>(max(f32(%s) / %u.0, -1.0))", wide, (1u << (ch->size - 1)) - 1)
                            : fmt(c, "bitcast<u32>(%s)", wide);
   }
   }
}

/* A channel's bits from the component `v` a shader stores (Vulkan's conversions: normalized values clamped and rounded,
 * integers cut to the channel). */
static const char *
channel_store(struct ctx *c, const struct util_format_channel_description *ch, const char *v)
{
   const unsigned mask = ch->size == 32 ? ~0u : (1u << ch->size) - 1;
   switch (ch->type) {
   case UTIL_FORMAT_TYPE_FLOAT:
      return ch->size == 32 ? v
             : ch->size == 16 ? fmt(c, "wg_f32_to_f16(%s)", v)
                              : fmt(c, "wg_f32_to_ufloat(%s, %uu)", v, ch->size - 5);
   case UTIL_FORMAT_TYPE_UNSIGNED:
      if (ch->normalized)
         return fmt(c, "u32(clamp(bitcast<f32>(%s), 0.0, 1.0) * %u.0 + 0.5)", v, mask);
      break;
   default:
      if (ch->normalized)
         return fmt(c, "(bitcast<u32>(i32(floor(clamp(bitcast<f32>(%s), -1.0, 1.0) * %u.0 + 0.5))) & 0x%xu)", v, mask >> 1, mask);
      break;
   }
   return ch->size == 32 ? v : fmt(c, "(%s & 0x%xu)", v, mask);
}

/* Floats of fewer bits, from and to their 32 bits by hand: WGSL's pack2x16float is indeterminate past 16 bits' range,
 * and a NaN keeps its bits only so. */
static void
declare_small_floats(struct ctx *c)
{
   line(c, "fn wg_f16_to_f32(h: u32) -> u32 {");
   line(c, "  let s = (h & 0x8000u) << 16u; let e = (h >> 10u) & 31u; let m = h & 0x3ffu;");
   line(c, "  if (e == 31u) { return s | 0x7f800000u | (m << 13u); }");
   line(c, "  if (e == 0u) { return s | bitcast<u32>(f32(m) * 5.9604644775390625e-8); }");
   line(c, "  return s | ((e + 112u) << 23u) | (m << 13u);");
   line(c, "}");
   /* A finite float's magnitude in `mantissa` bits of mantissa over an exponent of 5 bits, rounded once, to even. */
   line(c, "fn wg_f32_round(f: u32, mantissa: u32) -> u32 {");
   line(c, "  let e = (f >> 23u) & 255u; let m = f & 0x7fffffu; let drop = 23u - mantissa;");
   line(c, "  if (e < drop + 89u) { return 0u; }");
   line(c, "  let w = select(m, m | 0x800000u, e <= 112u);");
   line(c, "  let n = select(drop, drop + 113u - e, e <= 112u);");
   line(c, "  let r = (w >> n) + select(0u, (e - 112u) << mantissa, e > 112u);");
   line(c, "  let rest = w & ((1u << n) - 1u); let half = 1u << (n - 1u);");
   line(c, "  return r + select(0u, 1u, rest > half || (rest == half && (r & 1u) != 0u));");
   line(c, "}");
   line(c, "fn wg_f32_to_f16(f: u32) -> u32 {");
   line(c, "  let s = (f >> 16u) & 0x8000u; let e = (f >> 23u) & 255u;");
   line(c, "  if (e == 255u) { return s | 0x7c00u | select(0u, 0x200u, (f & 0x7fffffu) != 0u); }");
   line(c, "  return s | min(wg_f32_round(f, 10u), 0x7c00u);");
   line(c, "}");
   line(c, "fn wg_f32_to_ufloat(f: u32, mantissa: u32) -> u32 {");
   line(c, "  if ((f & 0x7fffffffu) > 0x7f800000u) { return (32u << mantissa) - 1u; }");
   line(c, "  if ((f >> 31u) != 0u) { return 0u; }");
   line(c, "  if (f == 0x7f800000u) { return 31u << mantissa; }");
   line(c, "  return min(wg_f32_round(f, mantissa), (31u << mantissa) - 1u);");
   line(c, "}");
}

/* Storage images as their views' words (image_words). A texel past the view reads 0 and isn't written. A texel of a word
 * or more is at a whole word; under a word, `wg_im_word` gives bytes, and a store is two atomics on the word, as a 16-bit
 * store to a storage buffer is: another invocation's texel may share it. */
static void
declare_word_images(struct ctx *c)
{
   bool small_floats = false;
   for (unsigned i = 0; i < c->res_count; i++) {
      const struct wgsl_resource *r = &c->res[i].r;
      if (!r->image_words)
         continue;
      const struct util_format_description *d = util_format_description((enum pipe_format)r->format);
      const unsigned bytes = d->block.bits / 8, words = DIV_ROUND_UP(bytes, 4);
      const bool writes = r->kind == WGSL_STORAGE, pure = util_format_is_pure_integer((enum pipe_format)r->format);
      const char *array = fmt(c, "r%u_%u", r->group, r->binding), *p0 = param(c, r, 0), *p1 = param(c, r, 1);
      const char *name = fmt(c, "%u_%u", r->group, r->binding);
      const bool is_signed = c->res[i].signed_atomic;
      for (unsigned k = 0; k < d->nr_channels; k++)
         small_floats |= d->channel[k].type == UTIL_FORMAT_TYPE_FLOAT && d->channel[k].size < 32;
      line(c, "fn wg_im_size_%s() -> vec3<u32> { return %s.xyz; }", name, p0);
      line(c, "fn wg_im_word_%s(x: i32, y: i32, z: i32) -> u32 {", name);
      line(c, "  let p0 = %s; let a = vec3<u32>(bitcast<u32>(x), bitcast<u32>(y), bitcast<u32>(z));", p0);
      line(c, "  if (any(a >= p0.xyz)) { return 0xffffffffu; }");
      if (bytes < 4)
         line(c, "  return a.x * %uu + (a.y * p0.w + a.z * %s.x) * 4u;", bytes, p1);
      else
         line(c, "  return a.x * %uu + a.y * p0.w + a.z * %s.x;", words, p1);
      line(c, "}");
      /* The word at `i`, as a u32. */
      const char *word = writes ? fmt(c, "%s(atomicLoad(&%s[%%s]))", is_signed ? "bitcast<u32>" : "", array)
                                : fmt(c, "%s[%%s]", array);
      line(c, "fn wg_im_load_%s(x: i32, y: i32, z: i32) -> vec4<u32> {", name);
      line(c, "  let a = wg_im_word_%s(x, y, z);", name);
      line(c, "  if (a == 0xffffffffu) { return vec4<u32>(0u); }");
      if (bytes < 4) {
         line(c, "  let w0 = %s >> ((a & 3u) * 8u);", fmt(c, word, "a >> 2u"));
      } else {
         for (unsigned k = 0; k < words; k++)
            line(c, "  let w%u = %s;", k, fmt(c, word, fmt(c, "a + %uu", k)));
      }
      line(c, "  return vec4<u32>(%s, %s, %s, %s);", channel_load(c, d, 0, pure), channel_load(c, d, 1, pure),
           channel_load(c, d, 2, pure), channel_load(c, d, 3, pure));
      line(c, "}");
      if (!writes)
         continue;
      line(c, "fn wg_im_store_%s(x: i32, y: i32, z: i32, v: vec4<u32>) {", name);
      line(c, "  let a = wg_im_word_%s(x, y, z);", name);
      line(c, "  if (a == 0xffffffffu) { return; }");
      for (unsigned k = 0; k < words; k++) {
         const char *e = "0u";
         for (unsigned j = 0; j < d->nr_channels; j++) {
            const struct util_format_channel_description *ch = &d->channel[j];
            if (ch->shift / 32 != k)
               continue;
            unsigned comp = 0;
            while (comp < 4 && d->swizzle[comp] != j)
               comp++;
            if (comp == 4)
               continue;
            const char *bits = channel_store(c, ch, fmt(c, "v.%c", "xyzw"[comp]));
            const unsigned low = ch->shift % 32;
            e = !strcmp(e, "0u") ? (low ? fmt(c, "(%s << %uu)", bits, low) : bits)
                : fmt(c, "%s | (%s << %uu)", e, bits, low);
         }
         if (bytes < 4) {
            line(c, "  let s = (a & 3u) * 8u;");
            line(c, "  atomicAnd(&%s[a >> 2u], ~(0x%xu << s));", array, (1u << (bytes * 8)) - 1);
            line(c, "  atomicOr(&%s[a >> 2u], (%s) << s);", array, e);
         } else {
            line(c, "  atomicStore(&%s[a + %uu], %s(%s));", array, k, is_signed ? "bitcast<i32>" : "", e);
         }
      }
      line(c, "}");
   }
   if (small_floats)
      declare_small_floats(c);
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
      if (c->max_inter_stage && util_last_bit(v->mask) + (c->info->clip_distances ? MAX2(DIV_ROUND_UP(c->info->clip_distance_count, 4), 1) : 0) > c->max_inter_stage)
         failf(c, "more inter-stage variables with its clip distances than WebGPU's %u", c->max_inter_stage);
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
      /* An inverted depth range (the driver's flip_z): z mirrored in clip space, the range given the right way. */
      line(c, "override wg_flip_z: bool = false;");
   } else if (nir->info.stage == MESA_SHADER_FRAGMENT) {
      /* gl_ClipDistance's slots down to free locations. */
      for (unsigned k = 0; k < 2; k++) {
         if (!(c->vary.mask & (1u << (30 + k))))
            continue;
         const unsigned to = ffs(~c->vary.mask) - 1;
         c->vary.mask = (c->vary.mask & ~(1u << (30 + k))) | 1u << to;
         c->vary.interp[to] = c->vary.interp[30 + k];
         c->vary.sampling[to] = c->vary.sampling[30 + k];
         c->vary.base[to] = c->vary.base[30 + k];
         c->vary.clip[k] = to + 1;
      }
      if (c->max_inter_stage && util_last_bit(c->vary.mask) > c->max_inter_stage)
         failf(c, "more inter-stage variables with its clip distances than WebGPU's %u", c->max_inter_stage);
      if (c->vary.mask || c->uses_frag_coord) {
         line(c, "struct In {");
         if (c->uses_frag_coord)
            line(c, "  @builtin(position) pos: vec4<f32>,");
         u_foreach_bit(loc, c->vary.mask)
            line(c, "  @location(%u) %s v%u: vec4<%s>,", loc, interp_attr(c, c->vary.interp[loc], c->vary.sampling[loc]),
                 loc, base_name(c->vary.base[loc]));
         line(c, "}");
      }
      /* At the sample rate, a sample's position (gl_SamplePosition; gl_FragCoord is at it, as Vulkan has it, where
       * WGSL's position is the pixel's centre): Vulkan's standard locations, by the pipeline's sample count (the
       * driver's override). */
      if (nir->info.fs.uses_sample_shading || c->uses_interp_at_sample) {
         c->info->per_sample = true;
         line(c, "override wg_samples: u32 = 1u;");
         line(c, "fn wg_sample_pos(s: u32) -> vec2<f32> {");
         line(c, "  if (wg_samples != 4u) { return vec2<f32>(0.5, 0.5); }");
         line(c, "  return array<vec2<f32>, 4>(vec2<f32>(0.375, 0.125), vec2<f32>(0.875, 0.375), vec2<f32>(0.125, 0.625), "
                 "vec2<f32>(0.625, 0.875))[s & 3u];");
         line(c, "}");
      }
      if (c->info->outputs || c->info->writes_depth || c->info->writes_sample_mask) {
         line(c, "struct Out {");
         if (c->info->dual_source) {
            /* Both of location 0's sources, whether or not the shader wrote the first; no other location. */
            if (c->info->outputs & ~1u)
               failf(c, "dual-source blending with outputs past location 0");
            if (!(c->info->outputs & 1u))
               c->info->output_base[0] = c->info->dual_base;
            c->info->outputs |= 1u;
            line(c, "  @location(0) @blend_src(0) f0: vec4<%s>,", base_name(c->info->output_base[0]));
            line(c, "  @location(0) @blend_src(1) f0b: vec4<%s>,", base_name(c->info->dual_base));
         } else {
            u_foreach_bit(loc, c->info->outputs)
               line(c, "  @location(%u) f%u: vec4<%s>,", loc, loc, base_name(c->info->output_base[loc]));
         }
         if (c->info->writes_depth)
            line(c, "  @builtin(frag_depth) depth: f32,");
         if (c->info->writes_sample_mask)
            line(c, "  @builtin(sample_mask) mask: u32,");
         line(c, "}");
         line(c, "var<private> o: Out;");
         /* Alpha to coverage at one sample, which WebGPU's pipelines refuse: one sample's coverage from location 0's
          * alpha, covered from a half (the driver's override, VK4 T28). */
         if ((c->info->outputs & 1u) && c->info->output_base[0] == WGSL_F32) {
            c->info->a2c = true;
            line(c, "override wg_a2c: bool = false;");
         }
      }
      c->info->varyings = c->vary;
   }
   if (nir->info.stage == MESA_SHADER_VERTEX)
      c->info->varyings = c->vary;
}

/* A fragment shader's way out of main. */
static const char *
fs_return(struct ctx *c)
{
   if (c->info->a2c)
      return "if (wg_a2c && o.f0.a < 0.5) { discard; } return o;";
   return c->info->outputs || c->info->writes_depth || c->info->writes_sample_mask ? "return o;" : "return;";
}

/* Values. */

static const char *
literal(struct ctx *c, nir_load_const_instr *lc, unsigned comp)
{
   if (lc->def.bit_size == 1)
      return lc->value[comp].b ? "true" : "false";
   if (lc->def.bit_size == 16)
      return fmt(c, "0x%xu", lc->value[comp].u16);
   if (lc->def.bit_size == 8)
      return fmt(c, "0x%xu", lc->value[comp].u8);
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

/* A value's WGSL type: its register's, or its own. */
static const char *
value_type(struct ctx *c, nir_def *def)
{
   nir_instr *instr = nir_def_instr(def);
   if (instr->type == nir_instr_type_intrinsic && nir_instr_as_intrinsic(instr)->intrinsic == nir_intrinsic_decl_reg) {
      nir_intrinsic_instr *decl = nir_instr_as_intrinsic(instr);
      return storage_type(c, nir_intrinsic_bit_size(decl), nir_intrinsic_num_components(decl));
   }
   if (c->fdef && BITSET_TEST(c->fdef, def->index))
      return "f32";
   return storage_type(c, def->bit_size, def->num_components);
}

/* Whether a list jumps to the loop it is in (a break or continue outside its own loops), apart from `except`. */
static bool
jumps_to_loop(struct exec_list *list, nir_instr *except)
{
   foreach_list_typed (nir_cf_node, node, node, list) {
      if (node->type == nir_cf_node_block) {
         nir_instr *last = nir_block_last_instr(nir_cf_node_as_block(node));
         if (last && last != except && last->type == nir_instr_type_jump &&
             (nir_instr_as_jump(last)->type == nir_jump_break || nir_instr_as_jump(last)->type == nir_jump_continue))
            return true;
      } else if (node->type == nir_cf_node_if) {
         if (jumps_to_loop(&nir_cf_node_as_if(node)->then_list, except) ||
             jumps_to_loop(&nir_cf_node_as_if(node)->else_list, except))
            return true;
      }
   }
   return false;
}

/* A loop that runs once: its body ends in a break, its only jump to it (GD G2: 161 of the 218 loops of Godot's Forward+
 * fragment stage, from early returns NIR lowered). It is printed as its body's statements, in the scope around it. */
static nir_instr *
loop_once(nir_loop *loop)
{
   if (nir_loop_has_continue_construct(loop))
      return NULL;
   nir_instr *last = nir_block_last_instr(nir_loop_last_block(loop));
   if (!last || last->type != nir_instr_type_jump || nir_instr_as_jump(last)->type != nir_jump_break)
      return NULL;
   return jumps_to_loop(&loop->body, last) ? NULL : last;
}

static void
scope_blocks(struct ctx *c, struct exec_list *list, unsigned s, unsigned *count);

static void
scope_walk(struct ctx *c, struct exec_list *list, int parent, bool loop, unsigned *count)
{
   const unsigned s = (*count)++;
   c->scope_parent[s] = parent;
   c->scope_depth[s] = parent < 0 ? 0 : c->scope_depth[parent] + 1;
   c->scope_loop[s] = loop;
   scope_blocks(c, list, s, count);
}

static void
scope_blocks(struct ctx *c, struct exec_list *list, unsigned s, unsigned *count)
{
   foreach_list_typed (nir_cf_node, node, node, list) {
      switch (node->type) {
      case nir_cf_node_block:
         c->block_scope[nir_cf_node_as_block(node)->index] = s;
         break;
      case nir_cf_node_if:
         scope_walk(c, &nir_cf_node_as_if(node)->then_list, s, false, count);
         scope_walk(c, &nir_cf_node_as_if(node)->else_list, s, false, count);
         break;
      case nir_cf_node_loop:
         if (loop_once(nir_cf_node_as_loop(node)))
            scope_blocks(c, &nir_cf_node_as_loop(node)->body, s, count);
         else
            scope_walk(c, &nir_cf_node_as_loop(node)->body, s, true, count);
         break;
      default:
         break;
      }
   }
}

static int
scope_meet(const struct ctx *c, int a, int b)
{
   while (c->scope_depth[a] > c->scope_depth[b])
      a = c->scope_parent[a];
   while (c->scope_depth[b] > c->scope_depth[a])
      b = c->scope_parent[b];
   while (a != b) {
      a = c->scope_parent[a];
      b = c->scope_parent[b];
   }
   return a;
}

/* What `list` does to the registers surely written since its loop's iteration began (`a`; every register past a
 * jump, which doesn't fall through): a load of one not in it may read the last iteration's value (`carried`). The
 * state at each break of the loop walked directly is ANDed into `brk`. Stores of part of a register don't count. */
static void
carry_list(struct ctx *c, struct exec_list *list, BITSET_WORD *a, BITSET_WORD *brk, BITSET_WORD *carried)
{
   const unsigned words = c->reg_words;
   foreach_list_typed (nir_cf_node, node, node, list) {
      switch (node->type) {
      case nir_cf_node_block:
         nir_foreach_instr (instr, nir_cf_node_as_block(node)) {
            if (instr->type == nir_instr_type_jump) {
               if (nir_instr_as_jump(instr)->type == nir_jump_break)
                  for (unsigned w = 0; w < words; w++)
                     brk[w] &= a[w];
               memset(a, 0xff, words * sizeof(BITSET_WORD));
               continue;
            }
            if (instr->type != nir_instr_type_intrinsic)
               continue;
            nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
            if (intr->intrinsic == nir_intrinsic_load_reg) {
               const int k = c->reg_num[intr->src[0].ssa->index];
               if (!BITSET_TEST(a, k))
                  BITSET_SET(carried, k);
            } else if (intr->intrinsic == nir_intrinsic_store_reg) {
               nir_intrinsic_instr *decl = nir_src_as_intrinsic(intr->src[1]);
               if (nir_intrinsic_write_mask(intr) == BITFIELD_MASK(nir_intrinsic_num_components(decl)))
                  BITSET_SET(a, c->reg_num[decl->def.index]);
            }
         }
         break;
      case nir_cf_node_if: {
         BITSET_WORD *t = ralloc_array(c->mem, BITSET_WORD, words);
         memcpy(t, a, words * sizeof(BITSET_WORD));
         carry_list(c, &nir_cf_node_as_if(node)->then_list, t, brk, carried);
         carry_list(c, &nir_cf_node_as_if(node)->else_list, a, brk, carried);
         for (unsigned w = 0; w < words; w++)
            a[w] &= t[w];
         ralloc_free(t);
         break;
      }
      case nir_cf_node_loop: {
         /* Each iteration from what was written before it (a later one has more), out with what every break has. */
         BITSET_WORD *inner = ralloc_array(c->mem, BITSET_WORD, words);
         memset(inner, 0xff, words * sizeof(BITSET_WORD));
         carry_list(c, &nir_cf_node_as_loop(node)->body, a, inner, carried);
         memcpy(a, inner, words * sizeof(BITSET_WORD));
         ralloc_free(inner);
         break;
      }
      default:
         break;
      }
   }
}

/* Each loop's carried registers (scope_carried, by its body's scope). */
static void
carry_loops(struct ctx *c, struct exec_list *list)
{
   foreach_list_typed (nir_cf_node, node, node, list) {
      if (node->type == nir_cf_node_if) {
         carry_loops(c, &nir_cf_node_as_if(node)->then_list);
         carry_loops(c, &nir_cf_node_as_if(node)->else_list);
      } else if (node->type == nir_cf_node_loop) {
         struct exec_list *body = &nir_cf_node_as_loop(node)->body;
         if (loop_once(nir_cf_node_as_loop(node))) {
            carry_loops(c, body);
            continue;
         }
         nir_block *first = nir_cf_node_as_block(exec_node_data(nir_cf_node, exec_list_get_head(body), node));
         const unsigned words = c->reg_words;
         BITSET_WORD *carried = rzalloc_array(c->mem, BITSET_WORD, words);
         BITSET_WORD *a = rzalloc_array(c->mem, BITSET_WORD, words), *brk = ralloc_array(c->mem, BITSET_WORD, words);
         memset(brk, 0xff, words * sizeof(BITSET_WORD));
         carry_list(c, body, a, brk, carried);
         ralloc_free(a);
         ralloc_free(brk);
         c->scope_carried[c->block_scope[first->index]] = carried;
         carry_loops(c, body);
      }
   }
}

/* The scope a use reads in: its instruction's, or for an if's condition the list holding the if. */
static int
use_scope(const struct ctx *c, nir_src *src)
{
   if (nir_src_is_if(src))
      return c->block_scope[nir_cf_node_as_block(nir_cf_node_prev(&nir_src_use_if(src)->cf_node))->index];
   return c->block_scope[nir_src_use_instr(src)->block->index];
}

/* Where each value is declared (GD G2). Tint's uniformity analysis visits every function-scope var in scope at each
 * loop, break, continue and if (making nodes for each: uniformity.cc), so a function of 13,000 vars declared at its
 * top and a few hundred loops (Godot's Forward+ fragment stage) took seconds in createShaderModule; a let costs it
 * nothing there. A value whose uses all stay in its own scope (NIR's dominance: after it, in its list or deeper) is
 * printed there; one used past its scope (defined in a loop and read after it, or in an if whose other side jumps) is
 * a var at the start of the innermost scope holding its uses. A register is a var at the start of the innermost scope
 * holding its loads and stores, outside each loop around that whose iterations may read it before writing it
 * (carry_list: a loop's phi can carry a value from one iteration to the next with no access outside the loop, where
 * its first value is undefined). */
static void
place_values(struct ctx *c, nir_function_impl *impl)
{
   nir_index_blocks(impl);
   const unsigned nblocks = impl->num_blocks + 1, ndefs = impl->ssa_alloc;
   c->block_scope = rzalloc_array(c->mem, unsigned, nblocks);
   c->scope_parent = rzalloc_array(c->mem, int, nblocks);
   c->scope_depth = rzalloc_array(c->mem, unsigned, nblocks);
   c->scope_loop = rzalloc_array(c->mem, bool, nblocks);
   c->scope_first = ralloc_array(c->mem, int, nblocks);
   c->decl_scope = ralloc_array(c->mem, int, ndefs);
   c->decl_next = ralloc_array(c->mem, int, ndefs);
   c->decl_type = ralloc_array(c->mem, const char *, ndefs);
   memset(c->scope_first, 0xff, nblocks * sizeof(int));
   memset(c->decl_scope, 0xff, ndefs * sizeof(int));
   unsigned count = 0;
   scope_walk(c, &impl->body, -1, false, &count);
   c->reg_num = ralloc_array(c->mem, int, ndefs);
   memset(c->reg_num, 0xff, ndefs * sizeof(int));
   unsigned nregs = 0;
   nir_foreach_reg_decl (decl, impl)
      c->reg_num[decl->def.index] = nregs++;
   c->reg_words = BITSET_WORDS(MAX2(nregs, 1));
   c->scope_carried = rzalloc_array(c->mem, BITSET_WORD *, nblocks);
   if (nregs)
      carry_loops(c, &impl->body);
   /* Backwards, each pushed onto its scope's chain: a scope declares its vars in the order of their values. */
   nir_foreach_block_reverse (block, impl) {
      nir_foreach_instr_reverse (instr, block) {
         nir_def *def = nir_instr_def(instr);
         if (!def)
            continue;
         const bool reg = instr->type == nir_instr_type_intrinsic &&
                          nir_instr_as_intrinsic(instr)->intrinsic == nir_intrinsic_decl_reg;
         if (reg && nir_intrinsic_num_array_elems(nir_instr_as_intrinsic(instr)))
            failf(c, "register arrays");
         if (!reg && (!def_needs_var(instr) || c->alias[def->index] >= 0))
            continue;
         const unsigned bits = reg ? nir_intrinsic_bit_size(nir_instr_as_intrinsic(instr)) : def->bit_size;
         if (bits != 1 && bits != 8 && bits != 16 && bits != 32) {
            failf(c, "%u-bit values", bits);
            continue;
         }
         int s = reg ? -1 : (int)c->block_scope[block->index];
         nir_foreach_use_including_if (src, def)
            s = s < 0 ? use_scope(c, src) : scope_meet(c, s, use_scope(c, src));
         if (reg) {
            if (s < 0)
               continue;
            /* Outside each loop around it that may carry it from one iteration to the next. */
            for (int x = s; x >= 0; x = c->scope_parent[x])
               if (c->scope_loop[x] && BITSET_TEST(c->scope_carried[x], c->reg_num[def->index]))
                  s = c->scope_parent[x];
         } else if (s == (int)c->block_scope[block->index]) {
            continue; /* its instruction's: a let where it can (emit_block) */
         }
         c->decl_scope[def->index] = s;
         c->decl_type[def->index] = value_type(c, def);
         c->decl_next[def->index] = c->scope_first[s];
         c->scope_first[s] = def->index;
      }
   }
}

/* The vars a scope starts with (place_values). */
static void
declare_scope(struct ctx *c, struct exec_list *list)
{
   nir_block *first = nir_cf_node_as_block(exec_node_data(nir_cf_node, exec_list_get_head(list), node));
   for (int i = c->scope_first[c->block_scope[first->index]]; i >= 0; i = c->decl_next[i])
      line(c, "var t%d: %s;", i, c->decl_type[i]);
}

/* ALU: each component on its own, sources bitcast to the op's input types. */
/* Integer ops whose bits don't depend on the sign (WGSL's i32 and u32 both wrap at run time): on 32-bit values as
 * stored, without bitcasts to i32 and back. */
static bool
alu_sign_free(nir_alu_instr *alu)
{
   switch (alu->op) {
   case nir_op_iadd: case nir_op_isub: case nir_op_imul: case nir_op_ishl: case nir_op_ieq: case nir_op_ine:
      return alu->src[0].src.ssa->bit_size == 32 && alu->src[1].src.ssa->bit_size == 32;
   default:
      return false;
   }
}

static const char *
alu_in(struct ctx *c, nir_alu_instr *alu, unsigned i, unsigned comp)
{
   const nir_alu_src *s = &alu->src[i];
   const char *raw = src_comp(c, (nir_src *)&s->src, s->swizzle[comp]);
   if (s->src.ssa->bit_size == 1)
      return raw;
   if (s->src.ssa->bit_size < 32)
      return view_narrow(c, raw, base_of(nir_op_infos[alu->op].input_types[i]), s->src.ssa->bit_size);
   const unsigned base = alu_sign_free(alu) ? WGSL_U32 : base_of(nir_op_infos[alu->op].input_types[i]);
   if (c->fdef && BITSET_TEST(c->fdef, s->src.ssa->index))
      return base == WGSL_F32 ? raw : fmt(c, "bitcast<%s>(%s)", base_name(base), raw);
   return as_base(c, raw, base, 1);
}

/* Whether an ALU op reads its source i (of 32 bits) through alu_in, as its input type. */
static bool
alu_reads_typed(nir_op op, unsigned i)
{
   switch (op) {
   case nir_op_mov: case nir_op_bcsel: case nir_op_vec2: case nir_op_vec3: case nir_op_vec4:
   case nir_op_unpack_32_2x16_split_x: case nir_op_unpack_32_2x16_split_y: case nir_op_pack_32_2x16_split:
   case nir_op_b2b1: case nir_op_f2f32:
      return false;
   case nir_op_ubitfield_extract: case nir_op_ibitfield_extract:
      return i == 0;
   case nir_op_bitfield_insert:
      return i < 2;
   default:
      return true;
   }
}

/* Which values are stored as f32 rather than u32 (GD G2): a scalar float ALU result that only ALU ops read, each as a
 * float. Two of every three operations of Godot's Forward+ fragment stage were floats', each printed as
 * bitcast<u32>(op(bitcast<f32>(a), bitcast<f32>(b))): three calls for Tint to resolve where one does. */
static void
float_values(struct ctx *c, nir_function_impl *impl)
{
   c->fdef = rzalloc_array(c->mem, BITSET_WORD, BITSET_WORDS(impl->ssa_alloc));
   nir_foreach_block (block, impl) {
      nir_foreach_instr (instr, block) {
         nir_def *def;
         if (instr->type == nir_instr_type_alu) {
            nir_alu_instr *alu = nir_instr_as_alu(instr);
            if (alu->def.bit_size != 32 || alu->def.num_components != 1 ||
                base_of(nir_op_infos[alu->op].output_type) != WGSL_F32 || !alu_reads_typed(alu->op, 0) ||
                alu->op == nir_op_b2f32)
               continue;
            def = &alu->def;
         } else if (instr->type == nir_instr_type_load_const) {
            /* A constant as an f32 literal, exact in hex: one that is finite, normal or +0 (a let's, so never a
             * const-expression's operand). */
            nir_load_const_instr *lc = nir_instr_as_load_const(instr);
            const uint32_t bits = lc->value[0].u32;
            const uint32_t exp = (bits >> 23) & 0xff;
            if (lc->def.bit_size != 32 || lc->def.num_components != 1 || exp == 0xff || (exp == 0 && bits))
               continue;
            def = &lc->def;
         } else {
            continue;
         }
         bool ok = true;
         nir_foreach_use_including_if (src, def) {
            if (nir_src_is_if(src) || nir_src_use_instr(src)->type != nir_instr_type_alu) {
               ok = false;
               break;
            }
            nir_alu_instr *use = nir_instr_as_alu(nir_src_use_instr(src));
            const unsigned i = (const nir_alu_src *)src - use->src;
            if (!alu_reads_typed(use->op, i) || base_of(nir_op_infos[use->op].input_types[i]) != WGSL_F32) {
               ok = false;
               break;
            }
         }
         if (ok)
            BITSET_SET(c->fdef, def->index);
      }
   }
}

/* Counts the sources of an instruction that read `data`'s value. */
static bool
count_reads(nir_src *src, void *data)
{
   void **d = data;
   if (src->ssa == d[0])
      (*(unsigned *)d[1])++;
   return true;
}

/* Register loads whose uses name the register itself (alias): each use in the load's block (an if's condition after
 * it), with no store to the register before the last. */
static void
alias_loads(struct ctx *c, nir_function_impl *impl)
{
   c->alias = ralloc_array(c->mem, int, impl->ssa_alloc);
   memset(c->alias, 0xff, impl->ssa_alloc * sizeof(int));
   nir_foreach_block (block, impl) {
      nir_foreach_instr (instr, block) {
         if (instr->type != nir_instr_type_intrinsic || nir_instr_as_intrinsic(instr)->intrinsic != nir_intrinsic_load_reg)
            continue;
         nir_intrinsic_instr *load = nir_instr_as_intrinsic(instr);
         nir_def *reg = load->src[0].ssa;
         unsigned left = 0;
         bool ok = true, in_if = false;
         nir_foreach_use_including_if (src, &load->def) {
            if (nir_src_is_if(src))
               in_if = nir_cf_node_prev(&nir_src_use_if(src)->cf_node) == &block->cf_node;
            if (nir_src_is_if(src) ? !in_if : nir_src_use_instr(src)->block != block)
               ok = false;
            else if (!nir_src_is_if(src))
               left++;
         }
         for (nir_instr *i = nir_instr_next(instr); ok && i && (left || in_if); i = nir_instr_next(i)) {
            unsigned n = 0;
            void *d[2] = { &load->def, &n };
            nir_foreach_src(i, count_reads, d);
            left -= n;
            if ((left || in_if) && i->type == nir_instr_type_intrinsic &&
                nir_instr_as_intrinsic(i)->intrinsic == nir_intrinsic_store_reg &&
                nir_instr_as_intrinsic(i)->src[1].ssa == reg)
               ok = false;
         }
         if (ok)
            c->alias[load->def.index] = reg->index;
      }
   }
}

/* A float to a 32-bit integer, saturating exactly (VK4 T29: dEQP's precision_fconvert): WGSL's conversion clamps to
 * the largest float under the bound (2147483520 for an i32), and a backend may take halves as finite (Metal gave an
 * f16 infinity as 65504), so the bound is compared in f32. The lower bounds are floats WGSL's clamp reaches. */
static const char *
float_to_int(struct ctx *c, const char *f32, bool is_signed)
{
   return is_signed ? fmt(c, "select(i32(%s), 2147483647i, %s >= 2147483648.0f)", f32, f32)
                    : fmt(c, "select(u32(%s), 4294967295u, %s >= 4294967296.0f)", f32, f32);
}

static const char *
alu_comp(struct ctx *c, nir_alu_instr *alu, unsigned comp)
{
   const nir_op op = alu->op;
   const unsigned n_in = nir_op_infos[op].num_inputs;
   /* On 16-bit values' bits, without shader-f16's types. */
   if (n_in > 0 && alu->src[0].src.ssa->bit_size == 16) {
      const char *raw = src_comp(c, &alu->src[0].src, alu->src[0].swizzle[comp]);
      switch (op) {
      case nir_op_f2f32: return fmt(c, "bitcast<u32>(unpack2x16float(%s).x)", raw);
      case nir_op_f2i32:
         return fmt(c, "bitcast<u32>(%s)", float_to_int(c, fmt(c, "unpack2x16float(%s).x", raw), true));
      case nir_op_f2u32: return float_to_int(c, fmt(c, "unpack2x16float(%s).x", raw), false);
      case nir_op_fisfinite: return fmt(c, "((%s & 0x7c00u) != 0x7c00u)", raw);
      case nir_op_pack_32_2x16_split:
         return fmt(c, "(%s | (%s << 16u))", raw, src_comp(c, &alu->src[1].src, alu->src[1].swizzle[comp]));
      default: break;
      }
   }
   if (op == nir_op_unpack_32_2x16_split_x || op == nir_op_unpack_32_2x16_split_y) {
      const char *raw = src_comp(c, &alu->src[0].src, alu->src[0].swizzle[comp]);
      return op == nir_op_unpack_32_2x16_split_x ? fmt(c, "(%s & 0xffffu)", raw) : fmt(c, "(%s >> 16u)", raw);
   }
   const char *a = n_in > 0 ? alu_in(c, alu, 0, comp) : NULL;
   const char *b = n_in > 1 ? alu_in(c, alu, 1, comp) : NULL;
   const char *d = n_in > 2 ? alu_in(c, alu, 2, comp) : NULL;
   const bool boolean = alu->def.bit_size == 1;
   const unsigned out = boolean || alu_sign_free(alu) ? WGSL_U32 : base_of(nir_op_infos[op].output_type);
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
   case nir_op_ldexp: F2("ldexp"); break;
   /* Kept whole (wgsl_nir.c's options): NIR's lowerings of these go through 16-bit values. */
   case nir_op_pack_half_2x16:
      e = fmt(c, "pack2x16float(vec2f(%s, %s))", alu_in(c, alu, 0, 0), alu_in(c, alu, 0, 1));
      break;
   case nir_op_unpack_half_2x16: e = fmt(c, "unpack2x16float(%s)[%u]", alu_in(c, alu, 0, 0), comp); break;
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
   case nir_op_f2i32: e = float_to_int(c, a, true); break;
   case nir_op_f2u32: e = float_to_int(c, a, false); break;
   case nir_op_f2i16: case nir_op_f2i8: e = fmt(c, "i32(%s)", a); break;
   case nir_op_f2u16: case nir_op_f2u8: e = fmt(c, "u32(%s)", a); break;
   case nir_op_i2f32: case nir_op_u2f32: e = fmt(c, "f32(%s)", a); break;
   case nir_op_i2f16: case nir_op_u2f16: e = fmt(c, "f16(%s)", a); break;
   case nir_op_f2f16: case nir_op_f2f16_rtne: e = fmt(c, "f16(%s)", a); break;
   case nir_op_f2f32: return a;
   /* 8 and 16 bits to 32 (the view extends them) and back (store_narrow keeps the low bits). */
   case nir_op_i2i32: case nir_op_u2u32: case nir_op_i2i16: case nir_op_u2u16: case nir_op_i2i8: case nir_op_u2u8:
      e = a;
      break;
   case nir_op_b2f32: return fmt(c, "select(0u, 0x3f800000u, %s)", a);
   case nir_op_b2f16: return fmt(c, "select(0u, 0x3c00u, %s)", a);
   case nir_op_b2i32: case nir_op_b2i16: case nir_op_b2i8: return fmt(c, "select(0u, 1u, %s)", a);
   case nir_op_b2b32: return fmt(c, "select(0u, 0xffffffffu, %s)", a);
   case nir_op_b2b1:
      return alu->src[0].src.ssa->bit_size == 1 ? a : fmt(c, "(%s != 0u)", a);
   case nir_op_bcsel:
      return fmt(c, "select(%s, %s, %s)", src_comp(c, &alu->src[2].src, alu->src[2].swizzle[comp]),
                 src_comp(c, &alu->src[1].src, alu->src[1].swizzle[comp]), src_comp(c, &alu->src[0].src,
                                                                                    alu->src[0].swizzle[comp]));
   /* WGSL's `&` and `|` on bools evaluate both sides, as NIR's do; `&&` and `||` short-circuit, a branch each in Tint's
    * output (VK4 T21: dEQP-VK's long_shader_bitwise_and, 2,356 of them, compiled 16% slower on SwiftShader). */
   case nir_op_iand:
      if (boolean)
         return fmt(c, "(%s & %s)", a, b);
      BIN("&");
      break;
   case nir_op_ior:
      if (boolean)
         return fmt(c, "(%s | %s)", a, b);
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
   if (alu->def.bit_size < 32)
      return store_narrow(c, e, out, alu->def.bit_size);
   if (c->fdef && BITSET_TEST(c->fdef, alu->def.index))
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
   if (BITSET_TEST(c->fdef, lc->def.index)) {
      line(c, "t%u = %af;", lc->def.index, (double)lc->value[0].f32);
      return;
   }
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

/* 16- and 8-bit loads and stores (16- and 8-bit storage) on an array of words, at byte offset `byte`: a half or a byte
 * of a word each. A store to memory other invocations see is an atomicAnd of its part and an atomicOr (the gather made
 * the array atomic), so that a store to the word's other parts by another invocation isn't lost. */
static void
emit_narrow_access(struct ctx *c, nir_intrinsic_instr *intr, const char *arr, bool atomic, bool signed_atomic,
                   const char *byte, unsigned bits)
{
   const char *mask = bits == 8 ? "0xffu" : "0xffffu";
   const unsigned step = bits / 8;
   const char *conv_in = signed_atomic ? "bitcast<i32>" : "";
   const char *conv_out = signed_atomic ? "bitcast<u32>" : "";
   const bool load = intr->intrinsic == nir_intrinsic_load_ssbo || intr->intrinsic == nir_intrinsic_load_shared ||
                     intr->intrinsic == nir_intrinsic_load_scratch;
   if (load) {
      const char *words[4];
      for (unsigned i = 0; i < intr->def.num_components; i++) {
         const char *b = fmt(c, "(%s + %uu)", byte, step * i);
         const char *w = fmt(c, "%s[%s >> 2u]", arr, b);
         if (atomic)
            w = fmt(c, "%s(atomicLoad(&%s))", conv_out, w);
         words[i] = fmt(c, "((%s >> ((%s & 3u) * 8u)) & %s)", w, b, mask);
      }
      assign_words(c, &intr->def, words);
      return;
   }
   if (intr->intrinsic != nir_intrinsic_store_ssbo && intr->intrinsic != nir_intrinsic_store_shared &&
       intr->intrinsic != nir_intrinsic_store_scratch) {
      failf(c, "%u-bit atomics", bits);
      return;
   }
   nir_src *value = &intr->src[0];
   u_foreach_bit(i, nir_intrinsic_write_mask(intr)) {
      const char *b = fmt(c, "(%s + %uu)", byte, step * i);
      const char *w = fmt(c, "%s[%s >> 2u]", arr, b);
      const char *sh = fmt(c, "((%s & 3u) * 8u)", b);
      const char *v = fmt(c, "((%s & %s) << %s)", src_comp(c, value, i), mask, sh);
      if (atomic) {
         line(c, "atomicAnd(&%s, %s(~(%s << %s)));", w, conv_in, mask, sh);
         line(c, "atomicOr(&%s, %s(%s));", w, conv_in, v);
      } else {
         line(c, "%s = (%s & ~(%s << %s)) | %s;", w, w, mask, sh, v);
      }
   }
}

/* An atomic on word `word` of an array of atomics; `data` its operand (of a swap, the compared value, the new one
 * after it). SPIR-V's compare-exchange is strong and WGSL's may fail spuriously: tried again until it exchanged or saw
 * another value. */
static void
emit_atomic(struct ctx *c, nir_intrinsic_instr *intr, const char *arr, const char *word, nir_src *data, bool signed_atomic)
{
   const char *conv_in = signed_atomic ? "bitcast<i32>" : "";
   const char *conv_out = signed_atomic ? "bitcast<u32>" : "";
   if (intr->intrinsic == nir_intrinsic_ssbo_atomic_swap || intr->intrinsic == nir_intrinsic_shared_atomic_swap ||
       intr->intrinsic == nir_intrinsic_image_atomic_swap) {
      line(c, "loop {");
      line(c, "  let wg_cas = atomicCompareExchangeWeak(&%s[%s], %s(%s), %s(%s));", arr, word, conv_in, src_name(c, data),
           conv_in, src_name(c, data + 1));
      line(c, "  if (wg_cas.exchanged || wg_cas.old_value != %s(%s)) { t%u = %s(wg_cas.old_value); break; }", conv_in,
           src_name(c, data), intr->def.index, conv_out);
      line(c, "}");
   } else {
      line(c, "t%u = %s(%s(&%s[%s], %s(%s)));", intr->def.index, conv_out, atomic_fn(c, nir_intrinsic_atomic_op(intr)),
           arr, word, conv_in, src_name(c, data));
   }
}

/* Loads, stores and atomics on an array of words (`arr`, a WGSL array of u32, atomic<u32> or atomic<i32>), at word
 * `word` (byte offset `byte`). */
static void
emit_word_access(struct ctx *c, nir_intrinsic_instr *intr, const char *arr, bool atomic, bool signed_atomic,
                 const char *byte)
{
   const unsigned bits = nir_intrinsic_infos[intr->intrinsic].has_dest ? intr->def.bit_size : intr->src[0].ssa->bit_size;
   if (bits < 32) {
      emit_narrow_access(c, intr, arr, atomic, signed_atomic, byte, bits);
      return;
   }
   const char *word = fmt(c, "(%s >> 2u)", byte);
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
   case nir_intrinsic_shared_atomic:
      emit_atomic(c, intr, arr, word, &intr->src[intr->intrinsic == nir_intrinsic_ssbo_atomic ? 2 : 1], signed_atomic);
      return;
   case nir_intrinsic_ssbo_atomic_swap:
   case nir_intrinsic_shared_atomic_swap:
      emit_atomic(c, intr, arr, word, &intr->src[intr->intrinsic == nir_intrinsic_ssbo_atomic_swap ? 2 : 1], signed_atomic);
      return;
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

/* A word image's coordinate as the x, y, z its functions take. */
static const char *
word_coords(struct ctx *c, nir_intrinsic_instr *intr, nir_src *coord)
{
   const unsigned dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
   const char *v = as_base(c, src_name(c, coord), WGSL_I32, coord->ssa->num_components);
   return dim == WGSL_DIM_1D ? fmt(c, "%s.x, 0, 0", v)
          : dim == WGSL_DIM_2D ? fmt(c, "%s.x, %s.y, 0", v, v)
                               : fmt(c, "%s.x, %s.y, %s.z", v, v, v);
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
   /* Transform feedback: the captured components' bits into the vertex's record (gl_Position's before wg_flip_y). */
   if (c->xfb) {
      const nir_io_xfb x = nir_intrinsic_io_xfb(intr);
      for (unsigned k = 0; k < 4; k++)
         for (unsigned n = 0; n < x.out[k].num_components; n++)
            if (k + n >= first && (mask & (1u << (k + n - first))))
               line(c, "wg_xo[%uu] = %s;", c->info->xfb_base[x.out[k].buffer] + x.out[k].offset + n,
                    src_comp(c, value, k + n - first));
   }
   if (c->nir->info.stage == MESA_SHADER_VERTEX) {
      if (sem.location == VARYING_SLOT_POS) {
         field = "pos";
      } else if (sem.location == VARYING_SLOT_CLIP_DIST0 || sem.location == VARYING_SLOT_CLIP_DIST1) {
         const unsigned at = (sem.location - VARYING_SLOT_CLIP_DIST0) * 4 + first;
         const unsigned read = c->vary.clip[sem.location - VARYING_SLOT_CLIP_DIST0];
         u_foreach_bit(i, mask) {
            if (at + i < c->info->clip_distance_count)
               line(c, "o.clip[%u] = bitcast<f32>(%s);", at + i, src_comp(c, value, i));
            if (read)
               line(c, "o.v%u[%u] = bitcast<f32>(%s);", read - 1, first + i, src_comp(c, value, i));
         }
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
      field = sem.dual_source_blend_index ? "f0b" : fmt(c, "f%u", loc);
      base = sem.dual_source_blend_index ? c->info->dual_base : c->info->output_base[loc];
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
      const unsigned loc = sem.location == VARYING_SLOT_CLIP_DIST0   ? c->vary.clip[0] - 1u
                           : sem.location == VARYING_SLOT_CLIP_DIST1 ? c->vary.clip[1] - 1u
                                                                     : sem.location - VARYING_SLOT_VAR0;
      e = fmt(c, "i.v%u.%s", loc, comps(c, first, n));
      base = c->vary.base[loc];
      /* At an offset from the pixel's centre, or at a sample: the input where WebGPU interpolates it (the centre, or
       * the sample at the sample rate; the centroid taken as the centre) moved there along its fine derivatives
       * (exact for linear interpolation; within a pixel, close for perspective). */
      nir_intrinsic_instr *bary =
         intr->intrinsic == nir_intrinsic_load_interpolated_input ? nir_src_as_intrinsic(intr->src[0]) : NULL;
      if (bary && c->vary.interp[loc] != WGSL_INTERP_FLAT &&
          (bary->intrinsic == nir_intrinsic_load_barycentric_at_offset ||
           bary->intrinsic == nir_intrinsic_load_barycentric_at_sample)) {
         const char *at = bary->intrinsic == nir_intrinsic_load_barycentric_at_offset
                             ? fmt(c, "(vec2<f32>(0.5) + %s)", as_base(c, src_name(c, &bary->src[0]), WGSL_F32, 2))
                             : fmt(c, "wg_sample_pos(%s)", src_comp(c, &bary->src[0], 0));
         const char *from = c->vary.sampling[loc] == WGSL_SAMPLING_SAMPLE ? "wg_sample_pos(sid)" : "vec2<f32>(0.5)";
         const char *v = fmt(c, "i.v%u", loc);
         line(c, "{ let d = %s - %s; let v = %s + dpdxFine(%s) * d.x + dpdyFine(%s) * d.y; t%u = %s; }", at, from, v,
              v, v, intr->def.index, to_storage(c, fmt(c, "v.%s", comps(c, first, n)), base, n));
         return;
      }
   }
   line(c, "t%u = %s;", intr->def.index, to_storage(c, e, base, n));
}

/* Subgroup operations (wgsl_nir.c `lower_subgroups` leaves these, on scalars): WGSL's own. A value goes as its storage
 * (u32 bits, exact through shuffles and broadcasts; a bool as 0 or 1, WGSL's subgroup built-ins taking no bools), a
 * reduction or scan as its operation's type. Without WGSL's subgroups, subgroups of one invocation. */
static const char *
subgroup_value(struct ctx *c, nir_src *src, unsigned base)
{
   if (src->ssa->bit_size == 1)
      return fmt(c, "select(0u, 1u, %s)", src_comp(c, src, 0));
   if (src->ssa->bit_size < 32)
      return view_narrow(c, src_comp(c, src, 0), base, src->ssa->bit_size);
   return as_base(c, src_comp(c, src, 0), base, 1);
}

static unsigned
workgroup_invocations(struct ctx *c)
{
   if (c->nir->info.stage != MESA_SHADER_COMPUTE) {
      failf(c, "subgroup ids in a %s shader", mesa_shader_stage_name(c->nir->info.stage));
      return 1;
   }
   return c->nir->info.workgroup_size[0] * c->nir->info.workgroup_size[1] * c->nir->info.workgroup_size[2];
}

static void
emit_subgroup(struct ctx *c, nir_intrinsic_instr *intr)
{
   nir_def *def = &intr->def;
   const bool boolean = def->bit_size == 1;
   if (!c->subgroups) {
      /* Of one invocation (wgsl_nir.c lowers what else the basic operations bring). */
      switch (intr->intrinsic) {
      case nir_intrinsic_load_subgroup_invocation:
      case nir_intrinsic_first_invocation:
         line(c, "t%u = 0u;", def->index);
         return;
      case nir_intrinsic_load_subgroup_size:
         line(c, "t%u = 1u;", def->index);
         return;
      case nir_intrinsic_load_subgroup_id:
         line(c, "t%u = lidx;", def->index);
         return;
      case nir_intrinsic_load_num_subgroups:
         line(c, "t%u = %uu;", def->index, workgroup_invocations(c));
         return;
      case nir_intrinsic_elect:
         line(c, "t%u = true;", def->index);
         return;
      case nir_intrinsic_ballot:
         line(c, "t%u = select(0u, 1u, %s);", def->index, src_comp(c, &intr->src[0], 0));
         return;
      case nir_intrinsic_read_invocation: /* a subgroup of one reads itself (Godot's Forward+ uses subgroups unconditionally) */
         line(c, "t%u = %s;", def->index, src_comp(c, &intr->src[0], 0));
         return;
      default:
         failf(c, "the subgroup operation %s without the device's subgroups", nir_intrinsic_infos[intr->intrinsic].name);
         return;
      }
   }
   unsigned base = WGSL_U32;
   const char *fn = NULL, *e = NULL;
   switch (intr->intrinsic) {
   case nir_intrinsic_load_subgroup_invocation:
      line(c, "t%u = sg_inv;", def->index);
      return;
   case nir_intrinsic_load_subgroup_size:
      line(c, "t%u = sg_size;", def->index);
      return;
   /* WGSL has no subgroup ids: subgroups are taken to be runs of local_invocation_index (as on SwiftShader and Metal). */
   case nir_intrinsic_load_subgroup_id:
      line(c, "t%u = lidx / sg_size;", def->index);
      return;
   case nir_intrinsic_load_num_subgroups:
      line(c, "t%u = (%uu + sg_size - 1u) / sg_size;", def->index, workgroup_invocations(c));
      return;
   case nir_intrinsic_ballot:
      if (def->num_components != 4)
         failf(c, "a ballot of %u components", def->num_components);
      line(c, "t%u = subgroupBallot(%s);", def->index, src_comp(c, &intr->src[0], 0));
      return;
   case nir_intrinsic_vote_any:
      line(c, "t%u = subgroupAny(%s);", def->index, src_comp(c, &intr->src[0], 0));
      return;
   case nir_intrinsic_vote_all:
      line(c, "t%u = subgroupAll(%s);", def->index, src_comp(c, &intr->src[0], 0));
      return;
   case nir_intrinsic_elect:
      line(c, "t%u = subgroupElect();", def->index);
      return;
   case nir_intrinsic_first_invocation:
      line(c, "t%u = subgroupBroadcastFirst(sg_inv);", def->index);
      return;
   case nir_intrinsic_read_first_invocation:
      e = fmt(c, "subgroupBroadcastFirst(%s)", subgroup_value(c, &intr->src[0], base));
      break;
   case nir_intrinsic_read_invocation: fn = "subgroupShuffle"; break;
   case nir_intrinsic_shuffle: fn = "subgroupShuffle"; break;
   case nir_intrinsic_shuffle_xor: fn = "subgroupShuffleXor"; break;
   case nir_intrinsic_shuffle_up: fn = "subgroupShuffleUp"; break;
   case nir_intrinsic_shuffle_down: fn = "subgroupShuffleDown"; break;
   case nir_intrinsic_quad_broadcast:
      /* WGSL's id is a const-expression (a dynamic one is lowered to shuffles). */
      e = fmt(c, "quadBroadcast(%s, %uu)", subgroup_value(c, &intr->src[0], base), const_index(c, &intr->src[1]));
      break;
   case nir_intrinsic_quad_swap_horizontal:
      e = fmt(c, "quadSwapX(%s)", subgroup_value(c, &intr->src[0], base));
      break;
   case nir_intrinsic_quad_swap_vertical:
      e = fmt(c, "quadSwapY(%s)", subgroup_value(c, &intr->src[0], base));
      break;
   case nir_intrinsic_quad_swap_diagonal:
      e = fmt(c, "quadSwapDiagonal(%s)", subgroup_value(c, &intr->src[0], base));
      break;
   case nir_intrinsic_reduce:
   case nir_intrinsic_inclusive_scan:
   case nir_intrinsic_exclusive_scan: {
      const nir_op op = nir_intrinsic_reduction_op(intr);
      const char *name;
      switch (op) {
      case nir_op_iadd: name = "Add"; break;
      case nir_op_fadd: name = "Add"; base = WGSL_F32; break;
      case nir_op_imul: name = "Mul"; break;
      case nir_op_fmul: name = "Mul"; base = WGSL_F32; break;
      case nir_op_imin: name = "Min"; base = WGSL_I32; break;
      case nir_op_umin: name = "Min"; break;
      case nir_op_fmin: name = "Min"; base = WGSL_F32; break;
      case nir_op_imax: name = "Max"; base = WGSL_I32; break;
      case nir_op_umax: name = "Max"; break;
      case nir_op_fmax: name = "Max"; base = WGSL_F32; break;
      case nir_op_iand: name = "And"; break;
      case nir_op_ior: name = "Or"; break;
      case nir_op_ixor: name = "Xor"; break;
      default:
         failf(c, "the subgroup reduction %s", nir_op_infos[op].name);
         return;
      }
      const char *kind = intr->intrinsic == nir_intrinsic_inclusive_scan   ? "Inclusive"
                         : intr->intrinsic == nir_intrinsic_exclusive_scan ? "Exclusive"
                                                                           : "";
      e = fmt(c, "subgroup%s%s(%s)", kind, name, subgroup_value(c, &intr->src[0], base));
      break;
   }
   default:
      failf(c, "the intrinsic %s", nir_intrinsic_infos[intr->intrinsic].name);
      return;
   }
   if (fn)
      e = fmt(c, "%s(%s, %s)", fn, subgroup_value(c, &intr->src[0], base), src_comp(c, &intr->src[1], 0));
   if (def->num_components != 1)
      failf(c, "a subgroup operation on vectors");
   line(c, "t%u = %s;", def->index, boolean ? fmt(c, "(%s != 0u)", e) : def->bit_size < 32 ? store_narrow(c, e, base, def->bit_size)
                                                                                         : to_storage(c, e, base, 1));
}

/* A load from an array of vec4<u32> (a uniform buffer, the push constants) at byte offset `byte`: words, or halves or
 * bytes of them (16- and 8-bit storage). */
static void
emit_vec4_load(struct ctx *c, nir_def *def, const char *arr, const char *byte)
{
   const char *words[4];
   for (unsigned i = 0; i < def->num_components; i++) {
      if (def->bit_size < 32) {
         const char *b = fmt(c, "(%s + %uu)", byte, def->bit_size / 8 * i);
         words[i] = fmt(c, "((%s[%s >> 4u][(%s >> 2u) & 3u] >> ((%s & 3u) * 8u)) & %s)", arr, b, b, b,
                        def->bit_size == 8 ? "0xffu" : "0xffffu");
      } else {
         const char *w = fmt(c, "(%s >> 2u)", byte);
         words[i] = fmt(c, "%s[(%s + %uu) >> 2u][(%s + %uu) & 3u]", arr, w, i, w, i);
      }
   }
   assign_words(c, def, words);
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
   case nir_intrinsic_load_barycentric_at_offset:
   case nir_intrinsic_load_barycentric_at_sample:
      return;
   case nir_intrinsic_load_reg:
      if (c->alias[def->index] < 0)
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
   case nir_intrinsic_load_first_vertex:
   case nir_intrinsic_load_base_instance:
   case nir_intrinsic_load_draw_id:
      line(c, "t%u = pc[%uu][%uu];", def->index, WGSL_DRAW_PARAMS / 16,
           intr->intrinsic == nir_intrinsic_load_first_vertex ? 0 : intr->intrinsic == nir_intrinsic_load_base_instance ? 1 : 2);
      return;
   case nir_intrinsic_load_frag_coord:
      line(c, "t%u = bitcast<vec4<u32>>(%s)%s;", def->index,
           c->nir->info.fs.uses_sample_shading ? "vec4<f32>(floor(i.pos.xy) + wg_sample_pos(sid), i.pos.zw)" : "i.pos",
           def->num_components < 4 ? fmt(c, ".%s", comps(c, 0, def->num_components)) : "");
      return;
   case nir_intrinsic_load_sample_pos:
      line(c, "t%u = bitcast<vec2<u32>>(wg_sample_pos(sid));", def->index);
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
      line(c, "t%u = gid + vec3<u32>(wg_base_x, wg_base_y, wg_base_z) * vec3<u32>(%uu, %uu, %uu);", def->index,
           c->nir->info.workgroup_size[0], c->nir->info.workgroup_size[1], c->nir->info.workgroup_size[2]);
      return;
   case nir_intrinsic_load_workgroup_id:
      line(c, "t%u = wid + vec3<u32>(wg_base_x, wg_base_y, wg_base_z);", def->index);
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
      line(c, "t%u = wg_view;", def->index);
      return;
   case nir_intrinsic_load_layer_id:
      line(c, "t%u = 0u;", def->index);
      return;
   /* WGSL has no built-in: demoted invocations are known (wg_helper), and the rasterizer's helpers cover no sample. */
   case nir_intrinsic_is_helper_invocation:
   case nir_intrinsic_load_helper_invocation:
      line(c, "t%u = wg_helper || smask == 0u;", def->index);
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
      emit_vec4_load(c, def, arr, src_comp(c, &intr->src[1], 0));
      return;
   }
   case nir_intrinsic_load_ssbo:
   case nir_intrinsic_ssbo_atomic:
   case nir_intrinsic_ssbo_atomic_swap: {
      struct res_use *r = find_res(c, const_index(c, &intr->src[0]));
      emit_word_access(c, intr, res_name(c, const_index(c, &intr->src[0])), r->r.atomic, r->signed_atomic,
                       src_comp(c, &intr->src[1], 0));
      return;
   }
   case nir_intrinsic_store_ssbo: {
      struct res_use *r = find_res(c, const_index(c, &intr->src[1]));
      emit_word_access(c, intr, res_name(c, const_index(c, &intr->src[1])), r->r.atomic, r->signed_atomic,
                       src_comp(c, &intr->src[2], 0));
      return;
   }
   case nir_intrinsic_get_ssbo_size:
      line(c, "t%u = arrayLength(&%s) * 4u;", def->index, res_name(c, const_index(c, &intr->src[0])));
      return;
   case nir_intrinsic_load_shared:
   case nir_intrinsic_shared_atomic:
   case nir_intrinsic_shared_atomic_swap:
      emit_word_access(c, intr, "shm", c->shm_atomic, c->shm_signed,
                       fmt(c, "(%s + %uu)", src_comp(c, &intr->src[0], 0), nir_intrinsic_base(intr)));
      return;
   case nir_intrinsic_store_shared:
      emit_word_access(c, intr, "shm", c->shm_atomic, c->shm_signed,
                       fmt(c, "(%s + %uu)", src_comp(c, &intr->src[1], 0), nir_intrinsic_base(intr)));
      return;
   /* Scratch has no base (NIR's load_scratch and store_scratch: their offset is the whole address). */
   case nir_intrinsic_load_scratch:
      emit_word_access(c, intr, "scratch", false, false, src_comp(c, &intr->src[0], 0));
      return;
   case nir_intrinsic_store_scratch:
      emit_word_access(c, intr, "scratch", false, false, src_comp(c, &intr->src[1], 0));
      return;
   case nir_intrinsic_load_push_constant:
      emit_vec4_load(c, def, "pc", fmt(c, "(%s + %uu)", src_comp(c, &intr->src[0], 0), nir_intrinsic_base(intr)));
      return;
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
   /* WGSL's discard demotes (the invocation goes on as a helper); a terminate also leaves the shader (vtn adds no
    * jump after OpTerminateInvocation, and a loop whose only exit it was would never end). */
   case nir_intrinsic_demote:
      line(c, "discard;%s", c->uses_helper ? " wg_helper = true;" : "");
      return;
   case nir_intrinsic_demote_if:
      line(c, "if (%s) { discard;%s }", src_comp(c, &intr->src[0], 0), c->uses_helper ? " wg_helper = true;" : "");
      return;
   case nir_intrinsic_terminate:
      line(c, "discard; %s", fs_return(c));
      return;
   case nir_intrinsic_terminate_if:
      line(c, "if (%s) { discard; %s }", src_comp(c, &intr->src[0], 0), fs_return(c));
      return;
   case nir_intrinsic_load_subgroup_invocation:
   case nir_intrinsic_load_subgroup_size:
   case nir_intrinsic_load_subgroup_id:
   case nir_intrinsic_load_num_subgroups:
   case nir_intrinsic_ballot:
   case nir_intrinsic_vote_any:
   case nir_intrinsic_vote_all:
   case nir_intrinsic_read_invocation:
   case nir_intrinsic_read_first_invocation:
   case nir_intrinsic_first_invocation:
   case nir_intrinsic_shuffle:
   case nir_intrinsic_shuffle_xor:
   case nir_intrinsic_shuffle_up:
   case nir_intrinsic_shuffle_down:
   case nir_intrinsic_quad_broadcast:
   case nir_intrinsic_quad_swap_horizontal:
   case nir_intrinsic_quad_swap_vertical:
   case nir_intrinsic_quad_swap_diagonal:
   case nir_intrinsic_elect:
   case nir_intrinsic_reduce:
   case nir_intrinsic_inclusive_scan:
   case nir_intrinsic_exclusive_scan:
      emit_subgroup(c, intr);
      return;
   case nir_intrinsic_image_load: {
      const unsigned index = const_index(c, &intr->src[0]);
      if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF) {
         assign_vec4(c, def, fmt(c, "wg_tb_load_%u_%u(%s)", index >> 16, index & 0xffff, src_comp(c, &intr->src[1], 0)),
                     WGSL_U32);
         return;
      }
      if (is_word_image(c, index)) {
         assign_vec4(c, def, fmt(c, "wg_im_load_%u_%u(%s)", index >> 16, index & 0xffff, word_coords(c, intr, &intr->src[1])),
                     WGSL_U32);
         return;
      }
      const char *xy, *layer;
      image_coords(c, intr, &intr->src[1], &xy, &layer);
      if (is_tex_image(c, index)) {
         const struct res_use *r = find_res(c, index);
         const char *e = layer ? fmt(c, "textureLoad(%s, %s, %s, 0)", res_name(c, index), xy, layer)
                               : fmt(c, "textureLoad(%s, %s, 0)", res_name(c, index), xy);
         assign_vec4(c, def, e, r->r.sample == WGSL_SAMPLE_UINT ? WGSL_U32 : r->r.sample == WGSL_SAMPLE_SINT ? WGSL_I32 : WGSL_F32);
         return;
      }
      const char *e = layer ? fmt(c, "textureLoad(%s, %s, %s)", res_name(c, index), xy, layer)
                            : fmt(c, "textureLoad(%s, %s)", res_name(c, index), xy);
      const char *b = texel_base(image_format(c, intr));
      assign_vec4(c, def, e, !strcmp(b, "u32") ? WGSL_U32 : !strcmp(b, "i32") ? WGSL_I32 : WGSL_F32);
      return;
   }
   case nir_intrinsic_image_atomic:
   case nir_intrinsic_image_atomic_swap: {
      /* A texel past the view is left alone and reads 0. */
      const unsigned index = const_index(c, &intr->src[0]);
      const struct res_use *r = find_res(c, index);
      const char *word = nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF
                            ? fmt(c, "wg_tb_word_%u_%u(%s)", index >> 16, index & 0xffff, src_comp(c, &intr->src[1], 0))
                            : fmt(c, "wg_im_word_%u_%u(%s)", index >> 16, index & 0xffff, word_coords(c, intr, &intr->src[1]));
      line(c, "t%u = 0u;", def->index);
      line(c, "{");
      c->indent++;
      line(c, "let wg_w = %s;", word);
      line(c, "if (wg_w != 0xffffffffu) {");
      c->indent++;
      emit_atomic(c, intr, res_name(c, index), "wg_w", &intr->src[3], r->signed_atomic);
      c->indent--;
      line(c, "}");
      c->indent--;
      line(c, "}");
      return;
   }
   case nir_intrinsic_image_store: {
      const unsigned index = const_index(c, &intr->src[0]);
      if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF) {
         nir_src *value = &intr->src[3];
         const unsigned n = value->ssa->num_components;
         const char *v = n == 4 ? src_name(c, value)
                         : n == 1 ? fmt(c, "vec4<u32>(%s, 0u, 0u, 0u)", src_name(c, value))
                                  : fmt(c, "vec4<u32>(%s, %s)", src_name(c, value), n == 2 ? "0u, 0u" : "0u");
         line(c, "wg_tb_store_%u_%u(%s, %s);", index >> 16, index & 0xffff, src_comp(c, &intr->src[1], 0), v);
         return;
      }
      if (is_word_image(c, index)) {
         nir_src *value = &intr->src[3];
         const unsigned n = value->ssa->num_components;
         const char *v = n == 4 ? src_name(c, value)
                         : n == 1 ? fmt(c, "vec4<u32>(%s, 0u, 0u, 0u)", src_name(c, value))
                                  : fmt(c, "vec4<u32>(%s, %s)", src_name(c, value), n == 2 ? "0u, 0u" : "0u");
         line(c, "wg_im_store_%u_%u(%s, %s);", index >> 16, index & 0xffff, word_coords(c, intr, &intr->src[1]), v);
         return;
      }
      const char *xy, *layer;
      image_coords(c, intr, &intr->src[1], &xy, &layer);
      const char *b = texel_base(image_format(c, intr));
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
      if (nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_BUF) {
         line(c, "t%u = wg_tb_size_%u_%u();", def->index, index >> 16, index & 0xffff);
         return;
      }
      const unsigned dim = image_dim(c, nir_intrinsic_image_dim(intr), nir_intrinsic_image_array(intr));
      if (is_word_image(c, index)) {
         const bool cubes = nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_CUBE && nir_intrinsic_image_array(intr);
         const char *size = fmt(c, "wg_im_size_%u_%u()", index >> 16, index & 0xffff);
         if (cubes)
            size = fmt(c, "(%s / vec3<u32>(1u, 1u, 6u))", size);
         line(c, "t%u = %s%s;", def->index, size, def->num_components < 3 ? fmt(c, ".%s", comps(c, 0, def->num_components)) : "");
         return;
      }
      const char *name = res_name(c, index);
      /* A cube array's size counts cubes, its 2D array's layers faces. */
      const bool cubes = nir_intrinsic_image_dim(intr) == GLSL_SAMPLER_DIM_CUBE && nir_intrinsic_image_array(intr);
      if (dim == WGSL_DIM_2D_ARRAY)
         line(c, "t%u = vec3<u32>(textureDimensions(%s), textureNumLayers(%s)%s)%s;", def->index, name, name,
              cubes ? " / 6u" : "",
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
   /* WGSL wants a const-expression, and a vector of constants is a vec of scalars here: each channel found through it. */
   const unsigned n = off->ssa->num_components;
   const char *list = NULL;
   for (unsigned i = 0; i < n; i++) {
      const nir_scalar s = nir_scalar_chase_movs(nir_get_scalar(off->ssa, i));
      if (!nir_scalar_is_const(s)) {
         /* A fetch's offset is a sum: any value does (maintenance8's `Offset` operand, VK4 T24; a sample with one
          * comes from fetches, wgsl_sampler.c `dynamic_offset`). */
         if (tex->op == nir_texop_txf || tex->op == nir_texop_txf_ms)
            return as_base(c, src_name(c, off), WGSL_I32, n);
         failf(c, "a texture offset that isn't a constant");
         return NULL;
      }
      const int v = (int)nir_scalar_as_int(s);
      list = list ? fmt(c, "%s, %d", list, v) : fmt(c, "%d", v);
   }
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

   if (tex->sampler_dim == GLSL_SAMPLER_DIM_BUF) {
      const unsigned g = tex->texture_index >> 16, b = tex->texture_index & 0xffff;
      if (tex->op == nir_texop_txs)
         line(c, "t%u = wg_tb_size_%u_%u();", def->index, g, b);
      else
         assign_vec4(c, def, fmt(c, "wg_tb_load_%u_%u(%s)", g, b, src_comp(c, tex_src(tex, nir_tex_src_coord), 0)),
                     WGSL_U32);
      return;
   }

   switch (tex->op) {
   case nir_texop_txs: {
      nir_src *lod = tex_src(tex, nir_tex_src_lod);
      const char *dims = r->r.multisampled || !lod ? fmt(c, "textureDimensions(%s)", t)
                                                   : fmt(c, "textureDimensions(%s, %s)", t, src_comp(c, lod, 0));
      /* The channels asked: optimization shrinks the value to those it uses. */
      if (tex->is_array && def->num_components == 3)
         dims = fmt(c, "vec3<u32>(%s, textureNumLayers(%s))", dims, t);
      else if (def->num_components == 1 && tex->sampler_dim != GLSL_SAMPLER_DIM_1D)
         dims = fmt(c, "%s.x", dims);
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
      else if (depth) /* a whole level: Vulkan's nearest to the LOD (a linear mip filter's blend is lost) */
         e = fmt(c, "textureSampleLevel(%s, i32(floor(%s + 0.5))", args, src_scalar_as(c, lod, 0, WGSL_F32));
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
   if (&jump->instr == c->skip_jump)
      return;
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
         line(c, "discard; %s", fs_return(c));
      else
         line(c, "return%s;", c->nir->info.stage == MESA_SHADER_FRAGMENT ? " o" : "");
      break;
   default:
      failf(c, "a jump of type %d", jump->type);
   }
}

/* After an instruction whose value is its own scope's (place_values): `let tN: T = ` where it assigned the value once,
 * whole, at its own level; else a var declared before it. */
static void
place_value(struct ctx *c, nir_def *def, uint32_t start)
{
   const char *type = value_type(c, def);
   if (c->track_count == 1 && !c->track_other) {
      splice(c, c->track_off, c->track_len, fmt(c, "let %s: %s", c->track_name, type));
      return;
   }
   char *decl = fmt(c, "%*svar %s: %s;\n", 2 * c->indent, "", c->track_name, type);
   splice(c, start, 0, decl);
}

static void
emit_block(struct ctx *c, nir_block *block)
{
   nir_foreach_instr(instr, block) {
      if (c->failed)
         return;
      nir_def *def = nir_instr_def(instr);
      const uint32_t start = c->out->length;
      c->track = def && def_needs_var(instr) && c->decl_scope[def->index] < 0 && c->alias[def->index] < 0;
      if (c->track) {
         c->track_len = snprintf(c->track_name, sizeof(c->track_name), "t%u", def->index);
         c->track_indent = c->indent;
         c->track_count = 0;
         c->track_other = false;
      }
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
      if (c->track) {
         c->track = false;
         place_value(c, def, start);
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
   if (!c->in_scope)
      declare_scope(c, list);
   c->in_scope = false;
   foreach_list_typed(nir_cf_node, node, node, list) {
      switch (node->type) {
      case nir_cf_node_block:
         emit_block(c, nir_cf_node_as_block(node));
         break;
      case nir_cf_node_if: {
         nir_if *nif = nir_cf_node_as_if(node);
         if (needs_uniform_condition(c, nif)) {
            /* WGSL's uniformity analysis can't see that Vulkan's barriers are in uniform control flow (values reach
             * it through registers, vars assigned wherever): the condition of an if around a barrier, or breaking out of a loop
             * that holds one, is passed through workgroupUniformLoad. The barrier after it keeps the next write of
             * the same var from racing this read, so that one var serves every condition. WebGPU counts each workgroup
             * var rounded up to 16 bytes: the var is shared memory's spare word where it has one (wgsl_print), else one
             * of its own where the workgroup's storage has room, else shared memory's first word, saved and restored. */
            const unsigned n = c->uniform_conds++;
            if (c->uc_save && c->shm_atomic) {
               /* As below, through atomics (WGSL's workgroupUniformLoad takes an atomic: VK3 L6c). */
               const char *t = c->shm_signed ? "i" : "u";
               line(c, "workgroupBarrier();");
               line(c, "let ucs%u = atomicLoad(&shm[0]);", n);
               line(c, "workgroupBarrier();");
               line(c, "atomicStore(&shm[0], select(0%s, 1%s, %s));", t, t, src_comp(c, &nif->condition, 0));
               line(c, "let uc%u = u32(workgroupUniformLoad(&shm[0]));", n);
               line(c, "atomicStore(&shm[0], ucs%u);", n);
               line(c, "workgroupBarrier();");
            } else if (c->uc_save) {
               /* Shared memory takes the workgroup's storage whole: its first word holds the condition meanwhile, every
                * access to it before done and after its restore (each invocation writes the same values). */
               line(c, "workgroupBarrier();");
               line(c, "let ucs%u = shm[0];", n);
               line(c, "workgroupBarrier();");
               line(c, "shm[0] = select(0u, 1u, %s);", src_comp(c, &nif->condition, 0));
               line(c, "let uc%u = workgroupUniformLoad(&shm[0]);", n);
               line(c, "shm[0] = ucs%u;", n);
               line(c, "workgroupBarrier();");
            } else {
               line(c, "%s = select(0u, 1u, %s);", c->uc, src_comp(c, &nif->condition, 0));
               line(c, "let uc%u = workgroupUniformLoad(&%s);", n, c->uc);
               line(c, "workgroupBarrier();");
            }
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
         nir_instr *once = loop_once(loop);
         if (once) {
            /* Its statements here (place_values gave them this scope), without the break. */
            nir_instr *outer_skip = c->skip_jump;
            c->skip_jump = once;
            c->in_scope = true;
            emit_cf_list(c, &loop->body);
            c->skip_jump = outer_skip;
            break;
         }
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
wgsl_print(void *mem_ctx, nir_shader *nir, const struct wgsl_print_options *o, struct wgsl_info *info, char *error,
           size_t error_size)
{
   const struct wgsl_varyings *fs = o->fs;
   const uint32_t max_immediates = o->max_immediates;
   const unsigned features = o->features;
   memset(info, 0, sizeof(*info));
   const bool samplers_ok = wgsl_lower_samplers(nir, o, info);
   wgsl_finish(nir);
   nir_function_impl *impl = nir_shader_get_entrypoint(nir);
   nir_index_ssa_defs(impl);
   struct ctx c = {
      .nir = nir,
      .mem = ralloc_context(NULL),
      .error = error,
      .error_size = error_size,
      .info = info,
      .fs = nir->info.stage == MESA_SHADER_VERTEX ? fs : NULL,
      .max_inter_stage = o->max_inter_stage,
      .tier1 = features & WGSL_TIER1,
      .tier2 = features & WGSL_TIER2,
      .max_uniform_size = o->max_uniform_size ? o->max_uniform_size & ~15u : 65536,
      .dual_source = features & WGSL_DUAL_SOURCE,
      .subgroups = features & WGSL_SUBGROUPS,
      .f16 = features & WGSL_F16,
      .storage_limits = o->storage_limits,
      .keys = o->keys,
      .key_count = o->key_count,
      .max_storage_textures = o->max_storage_textures[nir->info.stage == MESA_SHADER_VERTEX     ? 0
                                                      : nir->info.stage == MESA_SHADER_FRAGMENT ? 1
                                                                                                : 2],
   };
   error[0] = 0;
   c.out = _mesa_string_buffer_create(c.mem, 4096);
   if (!samplers_ok)
      failf(&c, "a cube bound as its faces, gathered");
   /* Transform feedback (VK3 L7.4): each captured buffer's record in `wg_xo`, one after another. */
   if (nir->info.stage == MESA_SHADER_VERTEX && nir->xfb_info) {
      unsigned words = 0;
      for (unsigned b = 0; b < 4; b++) {
         if (!(nir->xfb_info->buffers_written & (1u << b)))
            continue;
         info->xfb_stride[b] = nir->xfb_info->buffers[b].stride;
         info->xfb_base[b] = words;
         words += DIV_ROUND_UP(info->xfb_stride[b], 4);
      }
      c.xfb = words > 0;
   }
   gather(&c, impl);
   /* A binding has one type: what another stage compares is depth here. */
   for (uint32_t i = 0; i < o->depth_count; i++)
      for (unsigned k = 0; k < c.res_count; k++)
         if (c.res[k].r.kind == WGSL_TEXTURE && ((uint32_t)c.res[k].r.group << 16 | c.res[k].r.binding) == o->depths[i])
            c.res[k].r.sample = WGSL_SAMPLE_DEPTH;
   /* WebGPU's integer and depth textures take only non-filtering samplers (Vulkan's integers are nearest, and depth
    * filters only through a comparison): a shared one's float textures keep theirs (wg_program_variant splits it). */
   for (uint32_t i = 0; i < info->pair_count; i++) {
      struct res_use *t = resource(&c, info->pairs[i][0], WGSL_TEXTURE), *z = resource(&c, info->pairs[i][1], WGSL_SAMPLER);
      if (z->r.kind == WGSL_SAMPLER && (t->r.sample == WGSL_SAMPLE_SINT || t->r.sample == WGSL_SAMPLE_UINT || t->r.sample == WGSL_SAMPLE_DEPTH))
         z->r.nonfiltering = true;
   }
   /* A storage buffer this stage doesn't write is read-only, in every stage: the driver binds it as writable storage
    * where a dispatch writes its memory through another binding (WebGPU's usage scopes: wg_cmd.c `program_for`). */
   /* The uniform conditions' word (emit_cf_list). */
   c.shm_words = DIV_ROUND_UP(nir->info.shared_size, 4);
   if (nir->info.stage == MESA_SHADER_COMPUTE) {
      if (c.shm_words && !c.shm_atomic && c.shm_words % 4) {
         c.uc = fmt(&c, "shm[%u]", c.shm_words);
         c.shm_words++;
      } else if (align(c.shm_words * 4, 16) + 16 <= o->max_workgroup_storage) {
         c.uc = "wg_uc";
      } else {
         c.uc_save = true;
      }
   }
   /* Push constants past the immediates: a uniform buffer of the driver's, bound at a dynamic offset per draw; with
    * the draw parameters there too, which the driver's copies write for indirect draws (immediates can't be). */
   if (info->immediate_size > max_immediates || c.uses_draw_params) {
      struct res_use *r = resource(&c, (WGSL_MAX_GROUPS - 1) << 16 | WGSL_PUSH_BINDING, o->push_storage ? WGSL_STORAGE_READ : WGSL_UNIFORM);
      r->r.size = info->immediate_size;
      info->push_ubo_size = info->immediate_size;
      info->immediate_size = 0;
   }

   const mesa_shader_stage stage = nir->info.stage;
   line(&c, "diagnostic(off, derivative_uniformity);");
   const bool subgroups = c.uses_subgroup_ops || c.uses_sg_inv || c.uses_sg_size;
   /* Through registers, vars assigned wherever, WGSL's uniformity analysis can't see Vulkan's (a subgroup operation's
    * control flow and its uniform operands are the program's to keep). */
   if (c.f16)
      line(&c, "enable f16;");
   if (subgroups)
      line(&c, "enable subgroups;");
   if (c.uses_subgroup_ops)
      line(&c, "diagnostic(off, subgroup_uniformity);");
   if (info->clip_distances)
      line(&c, "enable clip_distances;");
   if (info->dual_source)
      line(&c, "enable dual_source_blending;");
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
   if (c.info->uses_view)
      line(&c, "override wg_view: u32 = 0;");
   declare_texel_buffers(&c);
   declare_word_images(&c);
   declare_io(&c);
   if (stage == MESA_SHADER_COMPUTE && nir->info.shared_size)
      line(&c, "var<workgroup> shm: array<%s, %u>;", !c.shm_atomic ? "u32" : c.shm_signed ? "atomic<i32>" : "atomic<u32>",
           c.shm_words);
   if (nir->scratch_size)
      line(&c, "var<private> scratch: array<u32, %u>;", DIV_ROUND_UP(nir->scratch_size, 4));
   if (c.uses_helper)
      line(&c, "var<private> wg_helper: bool;");
   if (c.xfb) {
      unsigned words = 0;
      for (unsigned b = 0; b < 4; b++)
         words = MAX2(words, info->xfb_base[b] + DIV_ROUND_UP(info->xfb_stride[b], 4));
      line(&c, "var<private> wg_xo: array<u32, %u>;", words);
   }

   /* A vertex stage that writes storage (VK4 T33): its body runs as compute, its entry point a pass-through's. */
   for (unsigned k = 0; stage == MESA_SHADER_VERTEX && k < c.res_count; k++)
      info->stores |= (c.res[k].r.kind == WGSL_STORAGE && c.res[k].r.written) ||
                      (c.res[k].r.kind == WGSL_STORAGE_TEXTURE && (c.res[k].r.access & WGSL_ACCESS_WRITE));
   for (unsigned k = 0; stage == MESA_SHADER_VERTEX && k < c.word_image_count; k++)
      info->stores |= c.word_image_written[k];

   const bool has_out = stage == MESA_SHADER_VERTEX ||
                        (stage == MESA_SHADER_FRAGMENT && (info->outputs || info->writes_depth || info->writes_sample_mask));
   if (stage == MESA_SHADER_VERTEX) {
      /* The body a function of its own, which the driver's transform feedback pass calls too (VK3 L7.4), and which
       * alone a vertex stage that stores has (VK4 T33: WebGPU refuses writable storage reached from a vertex entry
       * point, the module with it). */
      if (!info->stores) {
         line(&c, "@vertex fn main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32%s) -> Out {",
              info->inputs ? ", i: In" : "");
         line(&c, "  wg_vs(vid, iid%s);", info->inputs ? ", i" : "");
         line(&c, "  o.pos.y = o.pos.y * wg_flip_y;");
         line(&c, "  if (wg_flip_z) { o.pos.z = o.pos.w - o.pos.z; }");
         line(&c, "  return o;");
         line(&c, "}");
      }
      line(&c, "fn wg_vs(vid: u32, iid: u32%s) {", info->inputs ? ", i: In" : "");
   } else if (stage == MESA_SHADER_FRAGMENT) {
      const char *params = (c.vary.mask || c.uses_frag_coord) ? "i: In" : "";
      if (c.uses_front_face)
         params = fmt(&c, "%s%s@builtin(front_facing) ff: bool", params, *params ? ", " : "");
      /* At the sample rate (a fragment shader without inputs too: WGSL runs a fragment shader per sample where it
       * reads sample_index). */
      if (c.uses_sample_id || nir->info.fs.uses_sample_shading)
         params = fmt(&c, "%s%s@builtin(sample_index) sid: u32", params, *params ? ", " : "");
      if (c.uses_sample_mask_in)
         params = fmt(&c, "%s%s@builtin(sample_mask) smask: u32", params, *params ? ", " : "");
      if (c.uses_sg_inv)
         params = fmt(&c, "%s%s@builtin(subgroup_invocation_id) sg_inv: u32", params, *params ? ", " : "");
      if (c.uses_sg_size)
         params = fmt(&c, "%s%s@builtin(subgroup_size) sg_size: u32", params, *params ? ", " : "");
      line(&c, "%s@fragment fn main(%s)%s {", nir->info.fs.early_fragment_tests ? "" : "", params,
           has_out ? " -> Out" : "");
   } else if (stage == MESA_SHADER_COMPUTE) {
      for (unsigned i = 0; i < 3; i++)
         info->workgroup[i] = nir->info.workgroup_size[i];
      /* vkCmdDispatchBase: WebGPU's dispatches start at workgroup 0, so a base is a pipeline's (wg_compute_based). */
      if (info->uses_base)
         line(&c, "override wg_base_x: u32 = 0u;\noverride wg_base_y: u32 = 0u;\noverride wg_base_z: u32 = 0u;");
      line(&c, "@compute @workgroup_size(%u, %u, %u) fn main(@builtin(local_invocation_id) lid: vec3<u32>, "
               "@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>, "
               "@builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) lidx: u32%s%s) {",
           info->workgroup[0], info->workgroup[1], info->workgroup[2],
           c.uses_sg_inv ? ", @builtin(subgroup_invocation_id) sg_inv: u32" : "",
           c.uses_sg_size ? ", @builtin(subgroup_size) sg_size: u32" : "");
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
   float_values(&c, impl);
   alias_loads(&c, impl);
   place_values(&c, impl);
   emit_cf_list(&c, &impl->body);
   if (has_out && stage != MESA_SHADER_VERTEX)
      line(&c, "%s", fs_return(&c));
   c.indent--;
   line(&c, "}");
   if (c.uniform_conds && c.uc && !strcmp(c.uc, "wg_uc"))
      line(&c, "var<workgroup> wg_uc: u32;");

   char *text = NULL;
   if (!c.failed)
      text = ralloc_strdup(mem_ctx, c.out->buf);
   ralloc_free(c.mem);
   return text;
}
