/*
 * Sampling as a sampler says (VK4 T8; vk/README.md "Samplers in the shader"): what WebGPU's samplers can't do, against
 * the sampler state a variant's draw binds (`wgsl_sampler_key`): border colours, mirror-once, unnormalized coordinates,
 * the sampler's LOD bias, and integer textures, which WGSL samples with no sampler at all: they are fetched, their
 * address modes and LOD worked out here. Runs when a stage is printed, so a stage's NIR kept across its compile takes
 * another key without another translation. No key (a stage's own module): integer textures at clamp-to-edge, and
 * everything else WebGPU's. Shadow samples at a LOD and LOD queries (VK4 T9) need a sampler's state too, whatever WebGPU
 * could do with it: `add_key_pair` says so. A min/max reduction (VK4 T25) is the fetches' filter's.
 */
#include <float.h>

#include "nir.h"
#include "nir_builder.h"
#include "util/u_math.h"
#include "wgsl.h"

struct sampler_pass {
   const struct wgsl_sampler_key *keys;
   uint32_t key_count;
   struct wgsl_info *info;
   /* Integer cube textures sampled (texture indices): their bindings are 2D arrays, which WGSL can fetch from. */
   uint32_t cubes[WGSL_MAX_PAIRS];
   uint32_t cube_count;
   /* Textures of a stage's comparisons (texture indices): declared depth, whatever else samples them. */
   uint32_t depths[WGSL_MAX_PAIRS];
   uint32_t depth_count;
};

static const struct wgsl_sampler_key plain_key = {
   .address = { WGSL_ADDRESS_EDGE, WGSL_ADDRESS_EDGE, WGSL_ADDRESS_EDGE },
   .max_lod = 1000.0f,
};

static const struct wgsl_sampler_key *
find_key(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->key_count; i++)
      if (s->keys[i].texture == tex->texture_index && s->keys[i].sampler == tex->sampler_index)
         return &s->keys[i];
   return NULL;
}

/* A key of a cube bound as its faces, for an op on it through another sampler. */
static const struct wgsl_sampler_key *
faces_key(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->key_count; i++)
      if (s->keys[i].texture == tex->texture_index && s->keys[i].faces)
         return &s->keys[i];
   return NULL;
}

/* The key of a padded texture, whatever the instruction. */
static const struct wgsl_sampler_key *
padded_key(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->key_count; i++)
      if (s->keys[i].texture == tex->texture_index && s->keys[i].padded)
         return &s->keys[i];
   return NULL;
}

/* The key of an E5B9G9R9 view of a 32-bit integer texture, whatever the instruction (VK4 T23). */
static const struct wgsl_sampler_key *
rgb9e5_key(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->key_count; i++)
      if (s->keys[i].texture == tex->texture_index && s->keys[i].rgb9e5)
         return &s->keys[i];
   return NULL;
}

/* An offset that isn't a constant (maintenance8's `Offset` operand): WGSL takes only const-expressions, so such a sample
 * comes from fetches, where the offset moves the texels at the level read (VK4 T24). A vector of constants is a vec of
 * scalars here, each channel found through it, as the printer finds them. */
static bool
dynamic_offset(const nir_tex_instr *tex)
{
   const int i = nir_tex_instr_src_index(tex, nir_tex_src_offset);
   if (i < 0)
      return false;
   nir_def *off = tex->src[i].src.ssa;
   for (unsigned c = 0; c < off->num_components; c++)
      if (!nir_scalar_is_const(nir_scalar_chase_movs(nir_get_scalar(off, c))))
         return true;
   return false;
}

static bool
samples(const nir_tex_instr *tex)
{
   return tex->op == nir_texop_tex || tex->op == nir_texop_txb || tex->op == nir_texop_txl || tex->op == nir_texop_txd ||
          tex->op == nir_texop_tg4;
}

static bool
is_integer(const nir_tex_instr *tex)
{
   const nir_alu_type base = nir_alu_type_get_base_type(tex->dest_type);
   return base == nir_type_int || base == nir_type_uint;
}

static bool
is_int_cube(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->cube_count; i++)
      if (s->cubes[i] == tex->texture_index)
         return true;
   return false;
}

static bool
is_depth(const struct sampler_pass *s, const nir_tex_instr *tex)
{
   for (uint32_t i = 0; i < s->depth_count; i++)
      if (s->depths[i] == tex->texture_index)
         return true;
   return false;
}

/* A query of the texture `tex` samples: its level-`lod` size (components as WGSL's, a layer count last) or levels. */
static nir_def *
query(nir_builder *b, const nir_tex_instr *tex, nir_texop op, nir_def *lod, unsigned components)
{
   nir_tex_instr *q = nir_tex_instr_create(b->shader, lod ? 1 : 0);
   q->op = op;
   q->sampler_dim = tex->sampler_dim;
   q->is_array = tex->is_array;
   q->dest_type = nir_type_int32;
   q->component = tex->op == nir_texop_lod ? tex->component : 0; /* a LOD query's texture may only be asked */
   q->texture_index = tex->texture_index;
   q->sampler_index = tex->sampler_index;
   if (lod)
      q->src[0] = nir_tex_src_for_ssa(nir_tex_src_lod, lod);
   nir_def_init(&q->instr, &q->def, components, 32);
   nir_builder_instr_insert(b, &q->instr);
   return &q->def;
}

/* The spatial dimensions of a coordinate (a LOD query's has no layer). */
static unsigned
spatial(const nir_tex_instr *tex)
{
   return tex->coord_components - (tex->is_array && tex->op != nir_texop_lod ? 1 : 0);
}

static nir_def *
tex_source(const nir_tex_instr *tex, nir_tex_src_type type)
{
   const int i = nir_tex_instr_src_index(tex, type);
   return i < 0 ? NULL : tex->src[i].src.ssa;
}

/* The channel `i` of the op's offset (0 without one). */
static nir_def *
offset_of(nir_builder *b, const nir_tex_instr *tex, unsigned i)
{
   nir_def *offset = tex_source(tex, nir_tex_src_offset);
   return offset && i < offset->num_components ? nir_channel(b, offset, i) : nir_imm_int(b, 0);
}

/* A cube coordinate's face and place on it, as Vulkan's table says; with the coordinate's derivatives `d` (NULL: none
 * wanted), the place's: differentiated by hand from the face this invocation is on, so that a seam, where the place
 * jumps, costs nothing. */
struct cube_place {
   nir_def *face, *s, *t, *ds[2], *dt[2];
};

static nir_def *
pick3(nir_builder *b, nir_def *xmajor, nir_def *ymajor, nir_def *x, nir_def *y, nir_def *z)
{
   return nir_bcsel(b, xmajor, x, nir_bcsel(b, ymajor, y, z));
}

static struct cube_place
cube_place(nir_builder *b, nir_def *coord, nir_def *const *dx, nir_def *const *dy)
{
   nir_def *rx = nir_channel(b, coord, 0), *ry = nir_channel(b, coord, 1), *rz = nir_channel(b, coord, 2);
   nir_def *ax = nir_fabs(b, rx), *ay = nir_fabs(b, ry), *az = nir_fabs(b, rz);
   nir_def *xm = nir_iand(b, nir_fge(b, ax, ay), nir_fge(b, ax, az)), *ym = nir_fge(b, ay, az);
   nir_def *xneg = nir_flt_imm(b, rx, 0.0f), *yneg = nir_flt_imm(b, ry, 0.0f), *zneg = nir_flt_imm(b, rz, 0.0f);
   nir_def *neg = pick3(b, xm, ym, xneg, yneg, zneg);
   nir_def *axis = nir_bcsel(b, xm, nir_imm_int(b, 0), nir_bcsel(b, ym, nir_imm_int(b, 2), nir_imm_int(b, 4)));
   struct cube_place out = { .face = nir_iadd(b, axis, nir_bcsel(b, neg, nir_imm_int(b, 1), nir_imm_int(b, 0))) };
   /* sc = (x-major: -+z; y-major: x; z-major: +-x), tc = (x-major: -y; y-major: +-z; z-major: -y), ma = the major. */
   nir_def *p1 = nir_imm_float(b, 1.0f), *m1 = nir_imm_float(b, -1.0f), *zero = nir_imm_float(b, 0.0f);
   nir_def *sx = nir_bcsel(b, xm, zero, nir_bcsel(b, ym, p1, nir_bcsel(b, neg, m1, p1)));
   nir_def *sz = nir_bcsel(b, xm, nir_bcsel(b, neg, p1, m1), zero);
   nir_def *ty = nir_bcsel(b, xm, m1, nir_bcsel(b, ym, zero, m1));
   nir_def *tz = nir_bcsel(b, xm, zero, nir_bcsel(b, ym, nir_bcsel(b, neg, m1, p1), zero));
   nir_def *sc = nir_fadd(b, nir_fmul(b, sx, rx), nir_fmul(b, sz, rz));
   nir_def *tc = nir_fadd(b, nir_fmul(b, ty, ry), nir_fmul(b, tz, rz));
   nir_def *ma = pick3(b, xm, ym, ax, ay, az);
   nir_def *inv = nir_frcp(b, nir_fmax(b, ma, nir_imm_float(b, 1e-30f)));
   out.s = nir_fmul_imm(b, nir_fadd_imm(b, nir_fmul(b, sc, inv), 1.0f), 0.5);
   out.t = nir_fmul_imm(b, nir_fadd_imm(b, nir_fmul(b, tc, inv), 1.0f), 0.5);
   for (unsigned k = 0; dx && k < 2; k++) {
      nir_def *const *d = k ? dy : dx;
      nir_def *dsc = nir_fadd(b, nir_fmul(b, sx, d[0]), nir_fmul(b, sz, d[2]));
      nir_def *dtc = nir_fadd(b, nir_fmul(b, ty, d[1]), nir_fmul(b, tz, d[2]));
      nir_def *sign_x = nir_bcsel(b, xneg, m1, p1), *sign_y = nir_bcsel(b, yneg, m1, p1), *sign_z = nir_bcsel(b, zneg, m1, p1);
      nir_def *dma = pick3(b, xm, ym, nir_fmul(b, sign_x, d[0]), nir_fmul(b, sign_y, d[1]), nir_fmul(b, sign_z, d[2]));
      out.ds[k] = nir_fmul_imm(b, nir_fmul(b, nir_fsub(b, dsc, nir_fmul(b, nir_fmul(b, sc, inv), dma)), inv), 0.5);
      out.dt[k] = nir_fmul_imm(b, nir_fmul(b, nir_fsub(b, dtc, nir_fmul(b, nir_fmul(b, tc, inv), dma)), inv), 0.5);
   }
   return out;
}

/* λ from a footprint (dx[i], dy[i], in texels), Vulkan's ρmax: the longer of the two axes. */
static nir_def *
lambda_of(nir_builder *b, nir_def *const *dx, nir_def *const *dy, unsigned n)
{
   nir_def *x = nir_imm_float(b, 0.0f), *y = x;
   for (unsigned i = 0; i < n; i++) {
      x = nir_fadd(b, x, nir_fmul(b, dx[i], dx[i]));
      y = nir_fadd(b, y, nir_fmul(b, dy[i], dy[i]));
   }
   return nir_fmul_imm(b, nir_flog2(b, nir_fmax(b, nir_fmax(b, x, y), nir_imm_float(b, 1e-30f))), 0.5);
}

/* The op's derivatives of its coordinate's spatial channels (`dx`, `dy`), false if it has none (an explicit LOD, a
 * stage that can't differentiate). */
static bool
coord_derivatives(nir_builder *b, const nir_tex_instr *tex, nir_def *coord, nir_def **dx, nir_def **dy)
{
   const unsigned n = spatial(tex);
   if (tex->op == nir_texop_txd) {
      nir_def *x = tex_source(tex, nir_tex_src_ddx), *y = tex_source(tex, nir_tex_src_ddy);
      for (unsigned i = 0; i < n; i++) {
         dx[i] = nir_channel(b, x, i);
         dy[i] = nir_channel(b, y, i);
      }
      return true;
   }
   if ((tex->op != nir_texop_tex && tex->op != nir_texop_txb && tex->op != nir_texop_lod) ||
       b->shader->info.stage != MESA_SHADER_FRAGMENT)
      return false;
   for (unsigned i = 0; i < n; i++) {
      nir_def *c = nir_channel(b, coord, i);
      dx[i] = nir_ddx(b, c);
      dy[i] = nir_ddy(b, c);
   }
   return true;
}

/* A LOD before its clamps: the sampler's bias and the op's added to λ (`lambda`: the op's implicit one, or NULL). */
static nir_def *
biased_lod(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *lambda)
{
   nir_def *lod = tex_source(tex, nir_tex_src_lod);
   nir_def *bias = tex_source(tex, nir_tex_src_bias);
   nir_def *base = tex->op == nir_texop_txl && lod ? lod : lambda ? lambda : nir_imm_float(b, 0.0f);
   nir_def *sum = nir_imm_float(b, key->bias);
   if (bias)
      sum = nir_fadd(b, sum, bias);
   /* Vulkan's λ': maxSamplerLodBias bounds the two together. */
   return nir_fadd(b, base, nir_fmin(b, nir_fmax(b, sum, nir_imm_float(b, -WGSL_MAX_LOD_BIAS)), nir_imm_float(b, WGSL_MAX_LOD_BIAS)));
}

static nir_def *
clamped_lod(nir_builder *b, const struct wgsl_sampler_key *key, nir_def *lod)
{
   return nir_fmin(b, nir_fmax(b, lod, nir_imm_float(b, key->min_lod)), nir_imm_float(b, key->max_lod));
}

/* Vulkan's nearest level (the spec's preferred rounding, ceil(d + 0.5) - 1) within the view's: WGSL's textureLoad past
 * them is undefined (VK3 L9b: NVIDIA's reads zeros). */
static nir_def *
nearest_level(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *lod)
{
   nir_def *levels = key->levels ? nir_imm_int(b, key->levels) : query(b, tex, nir_texop_query_levels, NULL, 1);
   nir_def *d = nir_fadd_imm(b, nir_fceil(b, nir_fadd_imm(b, lod, 0.5)), -1.0);
   d = nir_fmin(b, nir_fmax(b, d, nir_imm_float(b, 0)), nir_i2f32(b, nir_iadd_imm(b, levels, -1)));
   return nir_f2i32(b, d);
}

/* A texel coordinate into [0, extent) by an address mode (Vulkan's "Wrapping Operation"); `outside` gathers a border
 * mode's coordinates past the edge. */
static nir_def *
wrap(nir_builder *b, nir_def *i, nir_def *extent, unsigned mode, nir_def **outside)
{
   nir_def *last = nir_iadd_imm(b, extent, -1);
   switch (mode) {
   case WGSL_ADDRESS_REPEAT:
      return nir_imod(b, i, extent);
   case WGSL_ADDRESS_MIRROR: {
      nir_def *twice = nir_iadd(b, extent, extent), *t = nir_imod(b, i, twice);
      return nir_bcsel(b, nir_ilt(b, t, extent), t, nir_isub(b, nir_iadd_imm(b, twice, -1), t));
   }
   case WGSL_ADDRESS_MIRROR_ONCE:
      i = nir_bcsel(b, nir_ilt_imm(b, i, 0), nir_isub(b, nir_imm_int(b, -1), i), i);
      break;
   case WGSL_ADDRESS_BORDER:
      *outside = nir_ior(b, *outside, nir_ior(b, nir_ilt_imm(b, i, 0), nir_ige(b, i, extent)));
      break;
   default:
      break;
   }
   return nir_imin(b, nir_imax(b, i, nir_imm_int(b, 0)), last);
}

static nir_def *
border_vec(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *c[4];
   for (unsigned i = 0; i < 4; i++)
      c[i] = nir_imm_int(b, (int)key->border[i]);
   return nir_vec4(b, c[0], c[1], c[2], c[3]);
}

/* The fetch of texels at integer coordinates, a level, as `tex`'s (its dimension and type). */
static nir_def *
fetch(nir_builder *b, const nir_tex_instr *tex, nir_def *coord, nir_def *lod, unsigned components, enum glsl_sampler_dim dim,
      bool array, unsigned coord_components)
{
   nir_tex_instr *f = nir_tex_instr_create(b->shader, 2);
   f->op = nir_texop_txf;
   f->sampler_dim = dim;
   f->is_array = array;
   f->coord_components = coord_components;
   f->dest_type = tex->dest_type;
   f->is_shadow = tex->is_shadow; /* declares a depth texture: what its layout is */
   f->texture_index = tex->texture_index;
   f->sampler_index = tex->sampler_index;
   f->src[0] = nir_tex_src_for_ssa(nir_tex_src_coord, coord);
   f->src[1] = nir_tex_src_for_ssa(nir_tex_src_lod, lod);
   nir_def_init(&f->instr, &f->def, components, 32);
   nir_builder_instr_insert(b, &f->instr);
   return &f->def;
}

/* An E5B9G9R9 word as Vulkan decodes it: each 9-bit mantissa times 2^(exponent - 15 - 9), alpha 1. */
static nir_def *
rgb9e5_decode(nir_builder *b, nir_def *word)
{
   nir_def *scale = nir_fexp2(b, nir_fadd_imm(b, nir_u2f32(b, nir_ushr_imm(b, word, 27)), -24.0f));
   nir_def *c[4];
   for (unsigned i = 0; i < 3; i++)
      c[i] = nir_fmul(b, nir_u2f32(b, nir_iand_imm(b, nir_ushr_imm(b, word, 9 * i), 0x1ff)), scale);
   c[3] = nir_imm_float(b, 1.0f);
   return nir_vec(b, c, 4);
}

/* `fetch`, or for a key's E5B9G9R9 view of a 32-bit integer texture (VK4 T23) its word fetched and decoded: every op
 * on such a texture is a fetch of u32s (what the binding declares). */
static nir_def *
fetch_keyed(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *coord, nir_def *lod,
            unsigned components, enum glsl_sampler_dim dim, bool array, unsigned coord_components)
{
   if (!key || !key->rgb9e5)
      return fetch(b, tex, coord, lod, components, dim, array, coord_components);
   nir_tex_instr words = *tex;
   words.dest_type = nir_type_uint32;
   words.is_shadow = false;
   return rgb9e5_decode(b, nir_channel(b, fetch(b, &words, coord, lod, 4, dim, array, coord_components), 0));
}

/* Which of the coordinate's spatial channels `mode` addresses. */
static bool
uses_address(const nir_tex_instr *tex, const struct wgsl_sampler_key *key, unsigned mode)
{
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE)
      return false;
   for (unsigned i = 0; i < spatial(tex); i++)
      if (key->address[i] == mode)
         return true;
   return false;
}

/* An integer texture's sample (not a gather): the texel the coordinate falls in, as the key's address modes and LOD
 * say. A cube's binding is its faces as a 2D array. */
static nir_def *
int_sample(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord);
   const bool cube = tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE;
   const unsigned n = spatial(tex);
   /* A cube's level-0 size is its 2D array view's, whose layers are faces. */
   nir_tex_instr view = *tex;
   if (cube) {
      view.sampler_dim = GLSL_SAMPLER_DIM_2D;
      view.is_array = true;
   }
   nir_def *size0 = query(b, &view, nir_texop_txs, nir_imm_int(b, 0), cube ? 3 : tex->coord_components);
   nir_def *dx[3], *dy[3], *lambda = NULL;
   struct cube_place place = { 0 };
   const bool derivatives = coord_derivatives(b, tex, coord, dx, dy);
   if (cube) {
      place = cube_place(b, coord, derivatives ? dx : NULL, derivatives ? dy : NULL);
      if (derivatives) {
         nir_def *size = nir_i2f32(b, nir_channel(b, size0, 0));
         nir_def *x[2] = { nir_fmul(b, place.ds[0], size), nir_fmul(b, place.dt[0], size) };
         nir_def *y[2] = { nir_fmul(b, place.ds[1], size), nir_fmul(b, place.dt[1], size) };
         lambda = lambda_of(b, x, y, 2);
      }
   } else if (derivatives && !key->unnormalized) {
      nir_def *x[3], *y[3];
      for (unsigned i = 0; i < n; i++) {
         nir_def *size = nir_i2f32(b, nir_channel(b, size0, i));
         x[i] = nir_fmul(b, dx[i], size);
         y[i] = nir_fmul(b, dy[i], size);
      }
      lambda = lambda_of(b, x, y, n);
   }
   nir_def *level = nearest_level(b, &view, key, clamped_lod(b, key, biased_lod(b, tex, key, lambda)));
   nir_def *outside = nir_imm_false(b);
   nir_def *c[4];
   unsigned count = 0;
   if (cube) {
      nir_def *extent = nir_imax(b, nir_ishr(b, nir_channel(b, size0, 0), level), nir_imm_int(b, 1));
      nir_def *fextent = nir_i2f32(b, extent);
      nir_def *last = nir_iadd_imm(b, extent, -1);
      nir_def *faces = place.face;
      c[count++] = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_ffloor(b, nir_fmul(b, place.s, fextent))), nir_imm_int(b, 0)), last);
      c[count++] = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_ffloor(b, nir_fmul(b, place.t, fextent))), nir_imm_int(b, 0)), last);
      if (tex->is_array) {
         nir_def *cubes = nir_udiv(b, nir_channel(b, size0, 2), nir_imm_int(b, 6));
         nir_def *layer = nir_f2i32(b, nir_fround_even(b, nir_channel(b, coord, 3)));
         layer = nir_imin(b, nir_imax(b, layer, nir_imm_int(b, 0)), nir_iadd_imm(b, cubes, -1));
         faces = nir_iadd(b, nir_imul_imm(b, layer, 6), faces);
      }
      c[count++] = faces;
   } else {
      for (unsigned i = 0; i < n; i++) {
         nir_def *extent = nir_imax(b, nir_ishr(b, nir_channel(b, size0, i), level), nir_imm_int(b, 1));
         nir_def *u = nir_channel(b, coord, i);
         if (!key->unnormalized)
            u = nir_fmul(b, u, nir_i2f32(b, extent));
         nir_def *t = nir_iadd(b, nir_f2i32(b, nir_ffloor(b, u)), offset_of(b, tex, i));
         c[count++] = wrap(b, t, extent, key->address[i], &outside);
      }
      if (tex->is_array) {
         nir_def *layer = nir_f2i32(b, nir_fround_even(b, nir_channel(b, coord, n)));
         c[count++] = nir_imin(b, nir_imax(b, layer, nir_imm_int(b, 0)), nir_iadd_imm(b, nir_channel(b, size0, n), -1));
      }
   }
   nir_def *res = fetch(b, tex, nir_vec(b, c, count), level, 4, cube ? GLSL_SAMPLER_DIM_2D : tex->sampler_dim,
                        cube || tex->is_array, count);
   return uses_address(tex, key, WGSL_ADDRESS_BORDER) ? nir_bcsel(b, outside, border_vec(b, tex, key), res) : res;
}

/* A padded texture's size at a level (NULL: its first) as a size query gives it, the layers the texture's: what the
 * image is, not the whole blocks its texture has. */
static nir_def *
padded_size(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *level)
{
   nir_def *c[3];
   const unsigned n = tex->sampler_dim == GLSL_SAMPLER_DIM_3D ? 3 : tex->sampler_dim == GLSL_SAMPLER_DIM_1D ? 1 : 2;
   for (unsigned i = 0; i < n; i++)
      c[i] = level ? nir_imax(b, nir_ishr(b, nir_imm_int(b, key->size[i]), level), nir_imm_int(b, 1))
                   : nir_imm_int(b, key->size[i]);
   unsigned count = n;
   if (tex->is_array) {
      nir_tex_instr view = *tex;
      nir_def *real = query(b, &view, nir_texop_txs, nir_imm_int(b, 0), n + 1);
      c[count++] = nir_channel(b, real, n);
   }
   return nir_vec(b, c, count);
}

/* A VkCompareOp of a reference and a texel, as 0 or 1. */
static nir_def *
compare_of(nir_builder *b, nir_def *dref, nir_def *texel, unsigned op)
{
   nir_def *r;
   switch (op) {
   case 1: r = nir_flt(b, dref, texel); break; /* LESS */
   case 2: r = nir_feq(b, dref, texel); break;
   case 3: r = nir_fge(b, texel, dref); break; /* LESS_OR_EQUAL */
   case 4: r = nir_flt(b, texel, dref); break; /* GREATER */
   case 5: r = nir_fneu(b, dref, texel); break;
   case 6: r = nir_fge(b, dref, texel); break; /* GREATER_OR_EQUAL */
   case 7: return nir_imm_float(b, 1.0f);
   default: return nir_imm_float(b, 0.0f);
   }
   return nir_b2f32(b, r);
}

/* The op's reference (NULL: none), as the format compares it: Vulkan clamps it for fixed-point depth. */
static nir_def *
reference(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *dref = tex_source(tex, nir_tex_src_comparator);
   return dref && key->clamp_dref ? nir_fsat(b, dref) : dref;
}

/* A gather through fetches, for what WebGPU's samplers can't address (borders, mirror-once): the four texels' chosen
 * component, each wrapped, in OpImageGather's order (i0 j1, i1 j1, i1 j0, i0 j0); compared for a shadow gather. */
static nir_def *
gather_fetch(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord), *dref = reference(b, tex, key);
   const unsigned n = spatial(tex);
   nir_def *size = key->padded ? padded_size(b, tex, key, NULL) : query(b, tex, nir_texop_txs, nir_imm_int(b, 0), tex->coord_components);
   nir_def *lo[2], *hi[2], *out_lo[2], *out_hi[2];
   for (unsigned i = 0; i < n; i++) {
      nir_def *extent = nir_channel(b, size, i);
      nir_def *u = nir_fadd_imm(b, nir_fmul(b, nir_channel(b, coord, i), nir_i2f32(b, extent)), -0.5);
      nir_def *t = nir_iadd(b, nir_f2i32(b, nir_ffloor(b, u)), offset_of(b, tex, i));
      out_lo[i] = out_hi[i] = nir_imm_false(b);
      lo[i] = wrap(b, t, extent, key->address[i], &out_lo[i]);
      hi[i] = wrap(b, nir_iadd_imm(b, t, 1), extent, key->address[i], &out_hi[i]);
   }
   nir_def *layer = tex->is_array ? nir_imin(b, nir_imax(b, nir_f2i32(b, nir_fround_even(b, nir_channel(b, coord, n))),
                                                         nir_imm_int(b, 0)),
                                             nir_iadd_imm(b, nir_channel(b, size, n), -1))
                                  : NULL;
   nir_def *border = border_vec(b, tex, key);
   nir_def *component = nir_channel(b, border, dref ? 0 : tex->component);
   nir_def *lod = nir_imm_int(b, 0), *res[4];
   static const uint8_t order[4][2] = { { 0, 1 }, { 1, 1 }, { 1, 0 }, { 0, 0 } };
   for (unsigned k = 0; k < 4; k++) {
      nir_def *x = order[k][0] ? hi[0] : lo[0], *y = order[k][1] ? hi[1] : lo[1];
      nir_def *ox = order[k][0] ? out_hi[0] : out_lo[0], *oy = order[k][1] ? out_hi[1] : out_lo[1];
      nir_def *c[3] = { x, y, layer };
      nir_def *texel = fetch_keyed(b, tex, key, nir_vec(b, c, layer ? 3 : 2), lod, 4, tex->sampler_dim, tex->is_array, layer ? 3 : 2);
      nir_def *v = nir_bcsel(b, nir_ior(b, ox, oy), component, nir_channel(b, texel, dref ? 0 : tex->component));
      res[k] = dref ? compare_of(b, dref, v, key->compare) : v;
   }
   return nir_vec4(b, res[0], res[1], res[2], res[3]);
}

/* Samples from texel fetches, Vulkan's LOD and filter in the shader. Padded textures (T18): WebGPU wants a compressed
 * texture's first level in whole blocks, so an image that isn't is a corner of a larger texture, whose levels aren't
 * even in proportion to the image's (13 in blocks of 8 is 16: its level 1 is 6 of 8), and WebGPU's sampler can only see
 * the texture. Shadow samples past level 0 (T9): WGSL's compare at level 0 alone, so each texel is compared here and
 * the results filtered, as Vulkan does. */
struct fetched {
   const nir_tex_instr *tex;
   const struct wgsl_sampler_key *key;
   nir_def *level, *extent[3], *layer, *dref;
   unsigned n;
   bool cube;
};

/* One texel (`i`, on `face` for a cube, in the image's level); a cube's neighbour past an edge is on the next face:
 * the texel's centre as a direction, found again by Vulkan's table. */
static nir_def *
fetched_texel(nir_builder *b, const struct fetched *p, nir_def *const *i, nir_def *face)
{
   const nir_tex_instr *tex = p->tex;
   nir_def *c[4];
   unsigned count = 0;
   nir_def *outside = nir_imm_false(b);
   if (p->cube && p->key->non_seamless) {
      /* A non-seamless cube (VK4 T28): the texel on its own face, wrapped by the sampler's U and V. */
      c[count++] = wrap(b, i[0], p->extent[0], p->key->address[0], &outside);
      c[count++] = wrap(b, i[1], p->extent[0], p->key->address[1], &outside);
      c[count++] = p->layer ? nir_iadd(b, nir_imul_imm(b, p->layer, 6), face) : face;
   } else if (p->cube) {
      /* The centre on its face's plane, -1..1 within it; a past-the-edge one lands on another face. */
      nir_def *size = nir_i2f32(b, p->extent[0]);
      nir_def *sc = nir_fadd_imm(b, nir_fmul(b, nir_fmul_imm(b, nir_fadd_imm(b, nir_i2f32(b, i[0]), 0.5), 2.0), nir_frcp(b, size)), -1.0);
      nir_def *tc = nir_fadd_imm(b, nir_fmul(b, nir_fmul_imm(b, nir_fadd_imm(b, nir_i2f32(b, i[1]), 0.5), 2.0), nir_frcp(b, size)), -1.0);
      nir_def *one = nir_imm_float(b, 1.0f), *m1 = nir_imm_float(b, -1.0f), *ntc = nir_fneg(b, tc), *nsc = nir_fneg(b, sc);
      nir_def *f0 = nir_ieq_imm(b, face, 0), *f1 = nir_ieq_imm(b, face, 1), *f2 = nir_ieq_imm(b, face, 2);
      nir_def *f3 = nir_ieq_imm(b, face, 3), *f4 = nir_ieq_imm(b, face, 4);
#define BY_FACE(a, b_, c_, d, e, f)                                                                                    \
   nir_bcsel(b, f0, a, nir_bcsel(b, f1, b_, nir_bcsel(b, f2, c_, nir_bcsel(b, f3, d, nir_bcsel(b, f4, e, f)))))
      nir_def *rx = BY_FACE(one, m1, sc, sc, sc, nsc);
      nir_def *ry = BY_FACE(ntc, ntc, one, m1, ntc, ntc);
      nir_def *rz = BY_FACE(nsc, sc, tc, ntc, one, m1);
#undef BY_FACE
      const struct cube_place q = cube_place(b, nir_vec3(b, rx, ry, rz), NULL, NULL);
      nir_def *last = nir_iadd_imm(b, p->extent[0], -1);
      c[count++] = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_ffloor(b, nir_fmul(b, q.s, size))), nir_imm_int(b, 0)), last);
      c[count++] = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_ffloor(b, nir_fmul(b, q.t, size))), nir_imm_int(b, 0)), last);
      c[count++] = p->layer ? nir_iadd(b, nir_imul_imm(b, p->layer, 6), q.face) : q.face;
   } else {
      for (unsigned k = 0; k < p->n; k++)
         c[count++] = wrap(b, i[k], p->extent[k], p->key->address[k], &outside);
      if (p->layer)
         c[count++] = p->layer;
   }
   nir_def *texel = fetch_keyed(b, tex, p->key, nir_vec(b, c, count), p->level, 4, p->cube ? GLSL_SAMPLER_DIM_2D : tex->sampler_dim,
                                p->cube || tex->is_array, count);
   const bool border = uses_address(tex, p->key, WGSL_ADDRESS_BORDER) ||
                       (p->cube && p->key->non_seamless &&
                        (p->key->address[0] == WGSL_ADDRESS_BORDER || p->key->address[1] == WGSL_ADDRESS_BORDER));
   if (border)
      texel = nir_bcsel(b, outside, border_vec(b, tex, p->key), texel);
   if (!p->dref)
      return texel;
   return nir_vec4(b, compare_of(b, p->dref, nir_channel(b, texel, 0), p->key->compare), nir_imm_float(b, 0.0f),
                   nir_imm_float(b, 0.0f), nir_imm_float(b, 1.0f));
}

/* A min/max reduction (VK4 T25, VK_EXT_sampler_filter_minmax): Vulkan's "component-wise minimum (maximum) of values in
 * the footprint with non-zero weights", within a level and across the two a linear mipmap reads. */
static nir_def *
reduce(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *x, nir_def *y)
{
   const nir_alu_type base = nir_alu_type_get_base_type(tex->dest_type);
   const bool min = key->reduction == 1;
   if (base == nir_type_int)
      return min ? nir_imin(b, x, y) : nir_imax(b, x, y);
   if (base == nir_type_uint)
      return min ? nir_umin(b, x, y) : nir_umax(b, x, y);
   return min ? nir_fmin(b, x, y) : nir_fmax(b, x, y);
}

/* What a texel of no weight is: the type's extreme (a float's finite, as WGSL's min and max are indeterminate on
 * infinities). */
static nir_def *
reduction_identity(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   const nir_alu_type base = nir_alu_type_get_base_type(tex->dest_type);
   const bool min = key->reduction == 1;
   nir_def *v = base == nir_type_int    ? nir_imm_int(b, min ? INT32_MAX : INT32_MIN)
                : base == nir_type_uint ? nir_imm_int(b, min ? (int32_t)UINT32_MAX : 0)
                                        : nir_imm_float(b, min ? FLT_MAX : -FLT_MAX);
   return nir_vec4(b, v, v, v, v);
}

/* A seamless cube's 2×2 footprint (`texels` by corner: bit 0 the high s, bit 1 the high t) where one texel is past both
 * of its face's edges, at the cube's corner: no face has it, so it is the other three's average (OpenGL's
 * recommendation, which Vulkan leaves to the implementation; llvmpipe's). Fetched, it would be one face's texel. A
 * float's or a comparison's; an integer's keeps that face's. */
static void
cube_corner(nir_builder *b, const struct fetched *p, nir_def *const *lo, nir_def *const *hi, nir_def **texels)
{
   if (p->key->non_seamless || (is_integer(p->tex) && !p->dref))
      return;
   nir_def *out[2][2];
   for (unsigned k = 0; k < 2; k++) {
      out[k][0] = nir_ilt_imm(b, lo[k], 0);
      out[k][1] = nir_ige(b, hi[k], p->extent[0]);
   }
   nir_def *fixed[4];
   for (unsigned c = 0; c < 4; c++) {
      nir_def *avg = nir_fmul_imm(b, nir_fadd(b, nir_fadd(b, texels[c ^ 1], texels[c ^ 2]), texels[c ^ 3]), 1.0 / 3.0);
      fixed[c] = nir_bcsel(b, nir_iand(b, out[0][c & 1], out[1][(c >> 1) & 1]), avg, texels[c]);
   }
   for (unsigned c = 0; c < 4; c++)
      texels[c] = fixed[c];
}

/* A cube's gather from its faces' fetches (a cube bound as its faces: a shadow sample past level 0, a non-seamless
 * sampler, a padded image, an integer cube also sampled): the footprint's four texels at the view's first level, a
 * neighbour past an edge on the next face, the corner's the other three's average; in OpImageGather's order (i0 j1, i1
 * j1, i1 j0, i0 j0), compared for a shadow gather. */
static nir_def *
cube_gather_fetch(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord);
   struct fetched p = { .tex = tex, .key = key, .n = 2, .cube = true, .dref = reference(b, tex, key), .level = nir_imm_int(b, 0) };
   nir_tex_instr view = *tex;
   view.sampler_dim = GLSL_SAMPLER_DIM_2D;
   view.is_array = true;
   nir_def *size = query(b, &view, nir_texop_txs, nir_imm_int(b, 0), 3);
   for (unsigned i = 0; i < 2; i++)
      p.extent[i] = key->padded ? nir_imm_int(b, key->size[i]) : nir_channel(b, size, i);
   if (tex->is_array) {
      nir_def *layers = nir_udiv(b, nir_channel(b, size, 2), nir_imm_int(b, 6));
      p.layer = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_fround_even(b, nir_channel(b, coord, 3))), nir_imm_int(b, 0)),
                         nir_iadd_imm(b, layers, -1));
   }
   const struct cube_place place = cube_place(b, coord, NULL, NULL);
   nir_def *lo[2], *hi[2];
   for (unsigned i = 0; i < 2; i++) {
      nir_def *u = nir_fadd_imm(b, nir_fmul(b, i ? place.t : place.s, nir_i2f32(b, p.extent[i])), -0.5);
      lo[i] = nir_f2i32(b, nir_ffloor(b, u));
      hi[i] = nir_iadd_imm(b, lo[i], 1);
   }
   nir_def *texels[4];
   for (unsigned c = 0; c < 4; c++) {
      nir_def *i[2] = { c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1] };
      texels[c] = fetched_texel(b, &p, i, place.face);
   }
   cube_corner(b, &p, lo, hi, texels);
   const unsigned component = p.dref ? 0 : tex->component;
   return nir_vec4(b, nir_channel(b, texels[2], component), nir_channel(b, texels[3], component),
                   nir_channel(b, texels[1], component), nir_channel(b, texels[0], component));
}

/* The image's sample at one level, nearest or linear, its texels weighted or reduced (`key->reduction`). `u` in
 * texels of the level: a cube's on `face`. */
static nir_def *
fetched_filter(nir_builder *b, const struct fetched *p, nir_def *const *u, nir_def *face, bool linear)
{
   nir_def *lo[3], *hi[3], *weight[3];
   const unsigned n = p->cube ? 2 : p->n;
   for (unsigned k = 0; k < n; k++) {
      nir_def *offset = p->cube ? nir_imm_int(b, 0) : offset_of(b, p->tex, k);
      if (linear) {
         nir_def *v = nir_fadd_imm(b, u[k], -0.5), *t = nir_ffloor(b, v);
         weight[k] = nir_fsub(b, v, t);
         lo[k] = nir_iadd(b, nir_f2i32(b, t), offset);
         hi[k] = nir_iadd_imm(b, lo[k], 1);
      } else {
         lo[k] = hi[k] = nir_iadd(b, nir_f2i32(b, nir_ffloor(b, u[k])), offset);
         weight[k] = nir_imm_float(b, 0.0f);
      }
   }
   if (!linear)
      return fetched_texel(b, p, lo, face);
   nir_def *texels[8];
   for (unsigned corner = 0; corner < (1u << n); corner++) {
      nir_def *i[3];
      for (unsigned k = 0; k < n; k++)
         i[k] = corner & (1u << k) ? hi[k] : lo[k];
      texels[corner] = fetched_texel(b, p, i, face);
   }
   if (p->cube && !p->key->reduction)
      cube_corner(b, p, lo, hi, texels);
   nir_def *sum = NULL;
   for (unsigned corner = 0; corner < (1u << n); corner++) {
      nir_def *w = nir_imm_float(b, 1.0f);
      for (unsigned k = 0; k < n; k++) {
         const bool high = corner & (1u << k);
         w = nir_fmul(b, w, high ? weight[k] : nir_fsub_imm(b, 1.0f, weight[k]));
      }
      nir_def *texel = texels[corner];
      if (p->key->reduction) {
         /* A texel of no weight takes no part (the reduction's identity in its place); one corner always has some. */
         texel = nir_bcsel(b, nir_fgt_imm(b, w, 0.0f), texel, reduction_identity(b, p->tex, p->key));
         sum = sum ? reduce(b, p->tex, p->key, sum, texel) : texel;
         continue;
      }
      texel = nir_fmul(b, texel, nir_vec4(b, w, w, w, w));
      sum = sum ? nir_fadd(b, sum, texel) : texel;
   }
   return sum;
}

/* A sample from fetches: Vulkan's LOD, then the filter above at its level or levels. A cube's binding is its faces. */
static nir_def *
fetched_sample(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord);
   const bool cube = tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE;
   const unsigned n = spatial(tex);
   struct fetched p = { .tex = tex, .key = key, .n = n, .cube = cube, .dref = reference(b, tex, key) };
   /* The view's first level: a padded image's as Vulkan has it, else the texture's. */
   nir_def *base[3];
   nir_tex_instr view = *tex;
   if (cube) {
      view.sampler_dim = GLSL_SAMPLER_DIM_2D;
      view.is_array = true;
   }
   nir_def *size0 = key->padded ? NULL : query(b, &view, nir_texop_txs, nir_imm_int(b, 0), cube ? 3 : tex->coord_components);
   for (unsigned i = 0; i < (cube ? 2 : n); i++)
      base[i] = key->padded ? nir_imm_int(b, key->size[i]) : nir_channel(b, size0, i);
   nir_def *dx[3], *dy[3], *lambda = NULL;
   struct cube_place place = { 0 };
   const bool derivatives = coord_derivatives(b, tex, coord, dx, dy);
   if (cube) {
      place = cube_place(b, coord, derivatives ? dx : NULL, derivatives ? dy : NULL);
      if (derivatives) {
         nir_def *size = nir_i2f32(b, base[0]);
         nir_def *x[2] = { nir_fmul(b, place.ds[0], size), nir_fmul(b, place.dt[0], size) };
         nir_def *y[2] = { nir_fmul(b, place.ds[1], size), nir_fmul(b, place.dt[1], size) };
         lambda = lambda_of(b, x, y, 2);
      }
   } else if (derivatives) {
      nir_def *x[3], *y[3];
      for (unsigned i = 0; i < n; i++) {
         nir_def *size = nir_i2f32(b, base[i]);
         x[i] = nir_fmul(b, dx[i], size);
         y[i] = nir_fmul(b, dy[i], size);
      }
      lambda = lambda_of(b, x, y, n);
   }
   nir_def *lod = clamped_lod(b, key, biased_lod(b, tex, key, lambda));
   if (tex->is_array) {
      nir_def *layers = nir_channel(b, query(b, &(nir_tex_instr){ .sampler_dim = cube ? GLSL_SAMPLER_DIM_2D : tex->sampler_dim,
                                                                  .is_array = true, .texture_index = tex->texture_index,
                                                                  .sampler_index = tex->sampler_index },
                                             nir_texop_txs, nir_imm_int(b, 0), cube ? 3 : n + 1), cube ? 2 : n);
      if (cube)
         layers = nir_udiv(b, layers, nir_imm_int(b, 6));
      p.layer = nir_imin(b, nir_imax(b, nir_f2i32(b, nir_fround_even(b, nir_channel(b, coord, n))), nir_imm_int(b, 0)),
                         nir_iadd_imm(b, layers, -1));
   }
   const float last = (float)(MAX2(key->levels, 1) - 1);
   nir_def *at[2], *f = NULL;
   unsigned levels = 1;
   if (key->mip_linear && key->levels > 1) {
      nir_def *l = nir_fmin(b, nir_fmax(b, lod, nir_imm_float(b, 0.0f)), nir_imm_float(b, last));
      nir_def *l0 = nir_ffloor(b, l);
      f = nir_fsub(b, l, l0);
      at[0] = nir_f2i32(b, l0);
      at[1] = nir_f2i32(b, nir_fmin(b, nir_fadd_imm(b, l0, 1.0f), nir_imm_float(b, last)));
      levels = 2;
   } else {
      at[0] = nearest_level(b, tex, key, lod);
   }
   nir_def *res[2];
   for (unsigned m = 0; m < levels; m++) {
      p.level = at[m];
      for (unsigned i = 0; i < 3; i++)
         p.extent[i] = i < (cube ? 2 : n) ? nir_imax(b, nir_ishr(b, base[i], at[m]), nir_imm_int(b, 1)) : NULL;
      nir_def *u[3];
      nir_def *face = cube ? place.face : NULL;
      for (unsigned i = 0; i < (cube ? 2 : n); i++) {
         nir_def *c = cube ? (i ? place.t : place.s) : nir_channel(b, coord, i);
         u[i] = key->unnormalized ? c : nir_fmul(b, c, nir_i2f32(b, p.extent[i]));
      }
      if (key->mag_linear == key->min_linear) {
         res[m] = fetched_filter(b, &p, u, face, key->min_linear);
      } else {
         nir_def *x = fetched_filter(b, &p, u, face, key->mag_linear), *y = fetched_filter(b, &p, u, face, key->min_linear);
         res[m] = nir_bcsel(b, nir_fle_imm(b, lod, 0.0f), x, y);
      }
   }
   if (levels == 1)
      return res[0];
   if (key->reduction)
      return nir_bcsel(b, nir_fgt_imm(b, f, 0.0f), reduce(b, tex, key, res[0], res[1]), res[0]);
   nir_def *g = nir_fsub_imm(b, 1.0f, f);
   return nir_fadd(b, nir_fmul(b, res[0], nir_vec4(b, g, g, g, g)), nir_fmul(b, res[1], nir_vec4(b, f, f, f, f)));
}

/* `tex` sampled at a level, explicit. */
static nir_def *
sample_level(nir_builder *b, const nir_tex_instr *tex, nir_def *coord, nir_def *lod)
{
   const int oi = nir_tex_instr_src_index(tex, nir_tex_src_offset);
   nir_tex_instr *l = nir_tex_instr_create(b->shader, oi >= 0 ? 3 : 2);
   l->op = nir_texop_txl;
   l->sampler_dim = tex->sampler_dim;
   l->is_array = tex->is_array;
   l->coord_components = tex->coord_components;
   l->dest_type = tex->dest_type;
   l->texture_index = tex->texture_index;
   l->sampler_index = tex->sampler_index;
   l->src[0] = nir_tex_src_for_ssa(nir_tex_src_coord, coord);
   l->src[1] = nir_tex_src_for_ssa(nir_tex_src_lod, lod);
   if (oi >= 0)
      l->src[2] = nir_tex_src_for_ssa(nir_tex_src_offset, tex->src[oi].src.ssa);
   nir_def_init(&l->instr, &l->def, tex->def.num_components, tex->def.bit_size);
   nir_builder_instr_insert(b, &l->instr);
   return &l->def;
}

/* How much of a sample comes from inside the image, the border's share being the rest: per axis, the part of the
 * filter's footprint on this side of the edge. */
static nir_def *
inside(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *coord, nir_def *size,
       nir_def *lambda)
{
   nir_def *weight = nir_imm_float(b, 1.0f);
   for (unsigned i = 0; i < spatial(tex); i++) {
      if (key->address[i] != WGSL_ADDRESS_BORDER)
         continue;
      nir_def *extent = nir_i2f32(b, nir_channel(b, size, i));
      nir_def *u = nir_fadd(b, nir_fmul(b, nir_channel(b, coord, i), extent), nir_i2f32(b, offset_of(b, tex, i)));
      nir_def *linear = nir_fmul(b, nir_fsat(b, nir_fadd_imm(b, u, 0.5)),
                                 nir_fsat(b, nir_fadd_imm(b, nir_fsub(b, extent, u), 0.5)));
      nir_def *nearest = nir_b2f32(b, nir_iand(b, nir_fge_imm(b, u, 0.0f), nir_flt(b, u, extent)));
      nir_def *w;
      if (key->mag_linear == key->min_linear)
         w = key->min_linear ? linear : nearest;
      else
         w = nir_bcsel(b, nir_fle_imm(b, lambda ? lambda : nir_imm_float(b, 0.0f), 0.0f),
                       key->mag_linear ? linear : nearest, key->min_linear ? linear : nearest);
      weight = nir_fmul(b, weight, w);
   }
   return weight;
}

/* `res` where `weight` is 1, the border's colour (a shadow sample's: it compared) where 0. */
static nir_def *
blend_border(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *res, nir_def *weight)
{
   nir_def *dref = reference(b, tex, key);
   nir_def *c[4];
   for (unsigned i = 0; i < res->num_components; i++) {
      nir_def *border;
      if (dref)
         border = i == 0 ? compare_of(b, dref, nir_imm_float(b, uif(key->border[0])), key->compare)
                         : nir_imm_float(b, i == 3 ? 1.0f : 0.0f);
      else
         border = nir_imm_float(b, uif(key->border[i]));
      c[i] = nir_fadd(b, nir_fmul(b, nir_channel(b, res, i), weight),
                      nir_fmul(b, border, nir_fsub_imm(b, 1.0f, weight)));
   }
   return nir_vec(b, c, res->num_components);
}

/* Replaces the instruction's coordinate. */
static void
set_coord(nir_tex_instr *tex, nir_def *coord)
{
   nir_src_rewrite(&tex->src[nir_tex_instr_src_index(tex, nir_tex_src_coord)].src, coord);
}

/* The sampler's bias on an op WebGPU's sampler ignores it for: a shader bias, a LOD, or derivatives scaled. A shadow
 * sample of one level has no use for it. */
static void
add_bias(nir_builder *b, nir_tex_instr *tex, float bias)
{
   if (bias == 0.0f || tex->op == nir_texop_tg4 || tex->is_shadow)
      return;
   int i;
   switch (tex->op) {
   case nir_texop_tex:
      if (b->shader->info.stage == MESA_SHADER_FRAGMENT) {
         tex->op = nir_texop_txb;
         nir_tex_instr_add_src(tex, nir_tex_src_bias, nir_imm_float(b, bias));
      } else {
         tex->op = nir_texop_txl;
         nir_tex_instr_add_src(tex, nir_tex_src_lod, nir_imm_float(b, bias));
      }
      break;
   case nir_texop_txb:
      i = nir_tex_instr_src_index(tex, nir_tex_src_bias);
      nir_src_rewrite(&tex->src[i].src, nir_fadd_imm(b, tex->src[i].src.ssa, bias));
      break;
   case nir_texop_txl:
      i = nir_tex_instr_src_index(tex, nir_tex_src_lod);
      nir_src_rewrite(&tex->src[i].src, nir_fadd_imm(b, tex->src[i].src.ssa, bias));
      break;
   case nir_texop_txd: {
      const float scale = powf(2.0f, bias);
      i = nir_tex_instr_src_index(tex, nir_tex_src_ddx);
      nir_src_rewrite(&tex->src[i].src, nir_fmul_imm(b, tex->src[i].src.ssa, scale));
      i = nir_tex_instr_src_index(tex, nir_tex_src_ddy);
      nir_src_rewrite(&tex->src[i].src, nir_fmul_imm(b, tex->src[i].src.ssa, scale));
      break;
   }
   default:
      break;
   }
}

/* A float texture sampled through a sampler WebGPU can't express. */
static bool
float_sample(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord);
   const bool border = uses_address(tex, key, WGSL_ADDRESS_BORDER);
   const bool once = uses_address(tex, key, WGSL_ADDRESS_MIRROR_ONCE);
   if (tex->op == nir_texop_tg4) {
      if (!border && !once)
         return false;
      nir_def *res = gather_fetch(b, tex, key);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   /* An offset is in texels of the level before the wrap: past a reflection only the shader can have it there. The
    * border across levels: a sample per level would be WebGPU's, its lodMinClamp and magFilter between it and the level
    * asked for; of one level, likewise a sampler's bias where it picks the filter. */
   if ((once && tex_source(tex, nir_tex_src_offset)) ||
       (border && (key->levels > 1 || (key->bias != 0.0f && key->mag_linear != key->min_linear)))) {
      nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
      return true;
   }
   nir_def *adjusted = coord;
   const unsigned n = spatial(tex);
   nir_def *size = NULL;
   if (key->unnormalized || border)
      size = query(b, tex, nir_texop_txs, nir_imm_int(b, 0), tex->coord_components);
   nir_def *dx[3], *dy[3];
   const bool shadow = tex->is_shadow;
   /* Mirror-once: the sampler's mirror-repeat within one reflection; the coordinate's own derivatives keep the LOD
    * through the clamp. */
   bool to_grad = false;
   if (key->unnormalized || once) {
      nir_def *c[4];
      for (unsigned i = 0; i < tex->coord_components; i++) {
         c[i] = nir_channel(b, coord, i);
         if (i < n && key->unnormalized)
            c[i] = nir_fmul(b, c[i], nir_frcp(b, nir_i2f32(b, nir_channel(b, size, i))));
         if (i < n && once && key->address[i] == WGSL_ADDRESS_MIRROR_ONCE)
            c[i] = nir_fmin(b, nir_fmax(b, c[i], nir_imm_float(b, -1.0f)), nir_imm_float(b, 1.0f));
      }
      adjusted = nir_vec(b, c, tex->coord_components);
      to_grad = once && !shadow && (tex->op == nir_texop_tex || tex->op == nir_texop_txb) &&
                b->shader->info.stage == MESA_SHADER_FRAGMENT;
   }
   if (to_grad) {
      for (unsigned i = 0; i < n; i++) {
         nir_def *c = nir_channel(b, coord, i);
         dx[i] = nir_ddx(b, c);
         dy[i] = nir_ddy(b, c);
      }
      nir_def *bias = tex_source(tex, nir_tex_src_bias);
      nir_def *scale = nir_fexp2(b, bias ? bias : nir_imm_float(b, 0.0f));
      if (bias)
         nir_tex_instr_remove_src(tex, nir_tex_instr_src_index(tex, nir_tex_src_bias));
      tex->op = nir_texop_txd;
      nir_def *ddx[3], *ddy[3];
      for (unsigned i = 0; i < n; i++) {
         ddx[i] = nir_fmul(b, dx[i], scale);
         ddy[i] = nir_fmul(b, dy[i], scale);
      }
      nir_tex_instr_add_src(tex, nir_tex_src_ddx, nir_vec(b, ddx, n));
      nir_tex_instr_add_src(tex, nir_tex_src_ddy, nir_vec(b, ddy, n));
   }
   if (adjusted != coord)
      set_coord(tex, adjusted);

   if (!border) {
      add_bias(b, tex, key->bias);
      return true;
   }
   /* The sample at clamp-to-edge (the sampler's address there), blended towards the border by how much of the
    * filter's footprint fell past the edge. A view of one level: more go through fetches, above. */
   nir_def *lambda = NULL;
   if (key->mag_linear != key->min_linear) {
      nir_def *derivative_dx[3], *derivative_dy[3];
      if (coord_derivatives(b, tex, coord, derivative_dx, derivative_dy)) {
         nir_def *x[3], *y[3];
         for (unsigned i = 0; i < n; i++) {
            nir_def *extent = nir_i2f32(b, nir_channel(b, size, i));
            x[i] = nir_fmul(b, derivative_dx[i], extent);
            y[i] = nir_fmul(b, derivative_dy[i], extent);
         }
         lambda = lambda_of(b, x, y, n);
      }
      lambda = clamped_lod(b, key, biased_lod(b, tex, key, lambda));
   }
   nir_def *weight = inside(b, tex, key, adjusted, size, lambda);
   b->cursor = nir_after_instr(&tex->instr);
   nir_def_rewrite_uses_after(&tex->def, blend_border(b, tex, key, &tex->def, weight));
   return true;
}

/* Says that `tex`'s pair needs a key (WGSL_KEY_*). */
static void
add_key_pair(struct sampler_pass *s, const nir_tex_instr *tex, uint32_t when)
{
   struct wgsl_info *info = s->info;
   for (uint32_t i = 0; i < info->key_pair_count; i++)
      if (info->key_pairs[i][0] == tex->texture_index && info->key_pairs[i][1] == tex->sampler_index) {
         info->key_pairs[i][2] |= when;
         return;
      }
   if (info->key_pair_count < WGSL_MAX_PAIRS) {
      info->key_pairs[info->key_pair_count][0] = tex->texture_index;
      info->key_pairs[info->key_pair_count][1] = tex->sampler_index;
      info->key_pairs[info->key_pair_count++][2] = when;
   }
}

/* Whether a shadow sample means a level WGSL's compare can't reach, on a view of several: an explicit LOD that isn't
 * the first level, a bias, gradients. An implicit LOD is WGSL's own. */
static bool
shadow_past_first(const nir_tex_instr *tex)
{
   if (!tex->is_shadow)
      return false;
   if (tex->op == nir_texop_txb || tex->op == nir_texop_txd)
      return true;
   if (tex->op != nir_texop_txl)
      return false;
   const int i = nir_tex_instr_src_index(tex, nir_tex_src_lod);
   return i >= 0 && (!nir_src_is_const(tex->src[i].src) || nir_src_as_float(tex->src[i].src) > 0.0f);
}

/* OpImageQueryLod, which WGSL hasn't: λ as a sample would have it, from the coordinate's derivatives (anisotropy's
 * lengthening isn't kept), then x the level or levels it reads, y the LOD before the sampler's clamps. */
static nir_def *
lod_query(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key, bool faces)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord);
   const bool cube = tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE;
   const unsigned n = spatial(tex);
   nir_tex_instr view = *tex;
   if (faces) {
      view.sampler_dim = GLSL_SAMPLER_DIM_2D;
      view.is_array = true;
   }
   nir_def *base[3];
   nir_def *size0 = key->padded ? NULL : query(b, &view, nir_texop_txs, nir_imm_int(b, 0), cube ? 2 + (faces || tex->is_array) : n + tex->is_array);
   for (unsigned i = 0; i < (cube ? 2 : n); i++)
      base[i] = key->padded ? nir_imm_int(b, key->size[i]) : nir_channel(b, size0, i);
   nir_def *dx[3], *dy[3], *x[3], *y[3], *lambda = NULL;
   if (coord_derivatives(b, tex, coord, dx, dy)) {
      if (cube) {
         const struct cube_place place = cube_place(b, coord, dx, dy);
         nir_def *size = nir_i2f32(b, base[0]);
         x[0] = nir_fmul(b, place.ds[0], size), x[1] = nir_fmul(b, place.dt[0], size);
         y[0] = nir_fmul(b, place.ds[1], size), y[1] = nir_fmul(b, place.dt[1], size);
         lambda = lambda_of(b, x, y, 2);
      } else {
         for (unsigned i = 0; i < n; i++) {
            nir_def *size = nir_i2f32(b, base[i]);
            x[i] = nir_fmul(b, dx[i], size);
            y[i] = nir_fmul(b, dy[i], size);
         }
         lambda = lambda_of(b, x, y, n);
      }
   }
   nir_def *unclamped = biased_lod(b, tex, key, lambda), *lod = clamped_lod(b, key, unclamped);
   nir_def *levels = key->levels ? nir_imm_int(b, key->levels) : query(b, &view, nir_texop_query_levels, NULL, 1);
   nir_def *level = key->mip_linear ? nir_fmin(b, nir_fmax(b, lod, nir_imm_float(b, 0.0f)), nir_i2f32(b, nir_iadd_imm(b, levels, -1)))
                                    : nir_i2f32(b, nearest_level(b, &view, key, lod));
   return nir_vec2(b, level, unclamped);
}

static bool
lower_tex(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   b->cursor = nir_before_instr(&tex->instr);
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_BUF)
      return false;
   if (tex->op == nir_texop_lod) {
      add_key_pair(s, tex, WGSL_KEY_ALWAYS);
      const struct wgsl_sampler_key *key = find_key(s, tex);
      nir_def_replace(&tex->def, lod_query(b, tex, key ? key : &plain_key, is_int_cube(s, tex)));
      return true;
   }
   if (shadow_past_first(tex))
      add_key_pair(s, tex, WGSL_KEY_LEVELS);
   /* An E5B9G9R9 view of a 32-bit integer texture (VK4 T23): its own fetches decoded; its samples below, from fetches. */
   const struct wgsl_sampler_key *words = rgb9e5_key(s, tex);
   if (words && tex->op == nir_texop_txf) {
      nir_def *lod = tex_source(tex, nir_tex_src_lod);
      nir_def *res = fetch_keyed(b, tex, words, tex_source(tex, nir_tex_src_coord), lod ? lod : nir_imm_int(b, 0), 4,
                                 tex->sampler_dim, tex->is_array, tex->coord_components);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   /* Sizes and levels of a cube whose binding is its faces. */
   if (!samples(tex) && is_int_cube(s, tex)) {
      if (tex->op == nir_texop_query_levels) {
         tex->sampler_dim = GLSL_SAMPLER_DIM_2D;
         tex->is_array = true;
         return true;
      }
      if (tex->op != nir_texop_txs)
         return false;
      const bool array = tex->is_array;
      nir_tex_instr view = *tex;
      view.sampler_dim = GLSL_SAMPLER_DIM_2D;
      view.is_array = true;
      nir_def *lod = tex_source(tex, nir_tex_src_lod);
      nir_def *size = query(b, &view, nir_texop_txs, lod ? lod : nir_imm_int(b, 0), 3);
      nir_def *res = array ? nir_vec3(b, nir_channel(b, size, 0), nir_channel(b, size, 1),
                                      nir_udiv(b, nir_channel(b, size, 2), nir_imm_int(b, 6)))
                           : nir_trim_vector(b, size, 2);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   /* A padded texture's size and levels are the image's. */
   const struct wgsl_sampler_key *padded = padded_key(s, tex);
   if (padded && !samples(tex) && (tex->op == nir_texop_txs || tex->op == nir_texop_query_levels)) {
      if (tex->op == nir_texop_query_levels) {
         nir_def_replace(&tex->def, nir_imm_int(b, padded->levels));
         return true;
      }
      nir_def *lod = tex_source(tex, nir_tex_src_lod);
      nir_def *level = lod ? lod : nir_imm_int(b, 0);
      nir_def *c[3];
      const unsigned n = tex->sampler_dim == GLSL_SAMPLER_DIM_3D ? 3 : tex->sampler_dim == GLSL_SAMPLER_DIM_1D ? 1 : 2;
      for (unsigned i = 0; i < n; i++)
         c[i] = nir_imax(b, nir_ishr(b, nir_imm_int(b, padded->size[i]), level), nir_imm_int(b, 1));
      unsigned count = n;
      if (tex->is_array) {
         /* The texture's layers: a padded cube's are its faces, in a 2D array. */
         nir_tex_instr view = *tex;
         if (padded->faces) {
            view.sampler_dim = GLSL_SAMPLER_DIM_2D;
            view.is_array = true;
         }
         nir_def *layers = nir_channel(b, query(b, &view, nir_texop_txs, nir_imm_int(b, 0), n + 1), n);
         c[count++] = padded->faces ? nir_udiv(b, layers, nir_imm_int(b, 6)) : layers;
      }
      nir_def_replace(&tex->def, nir_trim_vector(b, nir_vec(b, c, count), tex->def.num_components));
      return true;
   }
   if (!samples(tex) || tex->sampler_dim == GLSL_SAMPLER_DIM_MS)
      return false;
   const struct wgsl_sampler_key *key = find_key(s, tex);
   if (!key && words)
      key = words;
   /* A gather of a cube bound as its faces: from their fetches, by its own pair's key (every pair of such a cube has
    * one: wg_cmd.c `program_keys`; a module without is never drawn with). */
   if (tex->op == nir_texop_tg4 && tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE && is_int_cube(s, tex)) {
      const struct wgsl_sampler_key *k = key ? key : faces_key(s, tex) ? faces_key(s, tex) : &plain_key;
      nir_def_replace(&tex->def, nir_trim_vector(b, cube_gather_fetch(b, tex, k), tex->def.num_components));
      return true;
   }
   if (key && (key->padded || key->rgb9e5)) {
      if (tex->op == nir_texop_tg4) {
         if (tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE) {
            nir_def_replace(&tex->def, nir_trim_vector(b, gather_fetch(b, tex, key), tex->def.num_components));
            return true;
         }
         nir_def_replace(&tex->def, nir_trim_vector(b, cube_gather_fetch(b, tex, key), tex->def.num_components));
         return true;
      }
      nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
      return true;
   }
   /* A depth view's linear filter without a comparison (VK4 T42): WebGPU filters depth only by comparing, so the
    * sample comes from fetches (a gather reads the texels unfiltered: WebGPU's, or the fetches' above). */
   if (key && key->fetched && !tex->is_shadow && tex->op != nir_texop_tg4 &&
       (tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE || key->faces)) {
      nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
      return true;
   }
   /* A min/max reduction (VK4 T25): WebGPU's samplers only average, so the sample comes from fetches, as the sampler
    * says. A gather reads the texels unfiltered: WebGPU's (or the fetches' below, for what else its key says). A sampler
    * that compares has no reduction (Vulkan's rule). An integer texture's (which a linear filter reads only so) is
    * below, among its fetches. */
   /* A non-seamless cube's linear filter (VK4 T28, VK_EXT_non_seamless_cube_map): from its faces' fetches, each texel
    * on the sample's face (a shadow sample's compared, then filtered). */
   if (key && key->non_seamless && !is_integer(tex) && tex->op != nir_texop_tg4 &&
       tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE && key->faces) {
      nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
      return true;
   }
   if (key && key->reduction && !is_integer(tex) && !tex->is_shadow && tex->op != nir_texop_tg4 &&
       (tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE || key->faces)) {
      nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
      return true;
   }
   /* An offset that isn't a constant: every float sample from fetches, as the sampler bound says (a module without a
    * key is never drawn with). Cubes have no offsets. */
   if (!is_integer(tex) && dynamic_offset(tex)) {
      add_key_pair(s, tex, WGSL_KEY_ALWAYS);
      /* Without a key, a shadow sample still compares (LESS_OR_EQUAL): NEVER would fold the texture away, and the
       * program's layout, made from the stage's own module, would lack what the keyed variants bind. */
      struct wgsl_sampler_key plain = plain_key;
      plain.compare = 3;
      const struct wgsl_sampler_key *k = key ? key : &plain;
      nir_def *res = tex->op == nir_texop_tg4 ? gather_fetch(b, tex, k) : fetched_sample(b, tex, k);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   if (is_integer(tex)) {
      bool known = false;
      for (uint32_t i = 0; i < s->info->int_pair_count; i++)
         known |= s->info->int_pairs[i][0] == tex->texture_index && s->info->int_pairs[i][1] == tex->sampler_index;
      if (!known && s->info->int_pair_count < WGSL_MAX_PAIRS) {
         s->info->int_pairs[s->info->int_pair_count][0] = tex->texture_index;
         s->info->int_pairs[s->info->int_pair_count++][1] = tex->sampler_index;
      }
      if (!key)
         key = &plain_key;
      if (tex->op == nir_texop_tg4) {
         /* WGSL gathers integer textures: only what its samplers can't address goes through fetches, and a cube's
          * faces have no fetch that sees across them. */
         if (tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE || (!uses_address(tex, key, WGSL_ADDRESS_BORDER) &&
                                                           !uses_address(tex, key, WGSL_ADDRESS_MIRROR_ONCE) &&
                                                           !dynamic_offset(tex)))
            return false;
         nir_def_replace(&tex->def, nir_trim_vector(b, gather_fetch(b, tex, key), tex->def.num_components));
         return true;
      }
      /* A min/max reduction with a linear filter: the filter from fetches, its texels reduced as integers. */
      nir_def *res = key->reduction && (key->mag_linear || key->min_linear || key->mip_linear) ? fetched_sample(b, tex, key)
                                                                                             : int_sample(b, tex, key);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   /* A texture a stage compares is a depth texture in WGSL, which has no bias or gradients and takes no filtering
    * sampler: its other samples come from fetches, as their own sampler says (a cube's gather can't: WGSL's, the sampler
    * non-filtering). A cube's fetches are of its faces; a module without a key is never drawn with. */
   if (!tex->is_shadow && is_depth(s, tex)) {
      const bool cube = tex->sampler_dim == GLSL_SAMPLER_DIM_CUBE;
      if (tex->op == nir_texop_tg4) {
         if (cube)
            return false;
         add_key_pair(s, tex, WGSL_KEY_ALWAYS);
         nir_def_replace(&tex->def, nir_trim_vector(b, gather_fetch(b, tex, key ? key : &plain_key), tex->def.num_components));
         return true;
      }
      add_key_pair(s, tex, WGSL_KEY_ALWAYS | (cube ? WGSL_KEY_FACES : 0));
      nir_def *res = cube && !(key && key->faces) ? sample_level(b, tex, tex_source(tex, nir_tex_src_coord), nir_imm_float(b, 0.0f))
                                                  : fetched_sample(b, tex, key ? key : &plain_key);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   /* A cube bound as its faces: every op on it (the driver keys each of its pairs); a shadow sample of several levels,
    * whose level is the shader's. */
   if (!key)
      key = faces_key(s, tex);
   if (key && (key->faces || (tex->is_shadow && key->levels > 1))) {
      if (tex->op == nir_texop_tg4 && tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE) {
         nir_def_replace(&tex->def, nir_trim_vector(b, gather_fetch(b, tex, key), tex->def.num_components));
         return true;
      }
      if (tex->op != nir_texop_tg4) {
         nir_def_replace(&tex->def, nir_trim_vector(b, fetched_sample(b, tex, key), tex->def.num_components));
         return true;
      }
   }
   return key ? float_sample(b, tex, key) : false;
}

static bool
find_cubes(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   if (tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE)
      return false;
   const struct wgsl_sampler_key *faces = faces_key(s, tex);
   const bool bound = faces && !faces->padded;
   /* A size or levels asked of what's bound as its faces, in a stage that may not sample it; a gather from its fetches (cube_gather_fetch). */
   const bool wanted = tex->op == nir_texop_txs || tex->op == nir_texop_query_levels || tex->op == nir_texop_tg4
                          ? bound
                          : (samples(tex) || tex->op == nir_texop_lod) && (is_integer(tex) || bound);
   if (wanted && !is_int_cube(s, tex) && s->cube_count < WGSL_MAX_PAIRS)
      s->cubes[s->cube_count++] = tex->texture_index;
   return false;
}

static bool
find_depths(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   if (tex->is_shadow && !is_depth(s, tex) && s->depth_count < ARRAY_SIZE(s->depths))
      s->depths[s->depth_count++] = tex->texture_index;
   return false;
}

/* A 2D view of a 3D image (WGSL_SLICE_KEY): WebGPU has no 2D view of a 3D texture, so its binding is the level's 3D
 * view and every op on it takes the slice as its third coordinate: (slice + 0.5) / depth where normalized (no filter
 * reaches past the slice's centre), the slice where fetched or an image's; offsets and derivatives 0 there, size
 * queries their first two. */
static const struct wgsl_sampler_key *
slice_key(const struct sampler_pass *s, uint32_t index)
{
   for (uint32_t i = 0; i < s->key_count; i++)
      if (s->keys[i].sampler == WGSL_SLICE_KEY && s->keys[i].texture == index)
         return &s->keys[i];
   return NULL;
}

static nir_def *
with_z(nir_builder *b, nir_def *v, nir_def *z)
{
   return nir_vec3(b, nir_channel(b, v, 0), nir_channel(b, v, 1), z);
}

static bool
lower_slice(nir_builder *b, nir_instr *instr, void *data)
{
   const struct sampler_pass *s = data;
   if (instr->type == nir_instr_type_tex) {
      nir_tex_instr *tex = nir_instr_as_tex(instr);
      const struct wgsl_sampler_key *k = slice_key(s, tex->texture_index);
      if (!k || tex->sampler_dim != GLSL_SAMPLER_DIM_2D || tex->is_array)
         return false;
      tex->sampler_dim = GLSL_SAMPLER_DIM_3D;
      if (tex->op == nir_texop_txs) {
         tex->def.num_components = 3;
         b->cursor = nir_after_instr(instr);
         nir_def *xy = nir_trim_vector(b, &tex->def, 2);
         nir_def_rewrite_uses_after(&tex->def, xy);
         return true;
      }
      b->cursor = nir_before_instr(instr);
      const bool fetch = tex->op == nir_texop_txf;
      for (unsigned i = 0; i < tex->num_srcs; i++) {
         nir_def *v = tex->src[i].src.ssa;
         nir_def *z;
         switch (tex->src[i].src_type) {
         case nir_tex_src_coord:
            z = fetch ? nir_imm_intN_t(b, k->size[2], v->bit_size)
                      : nir_imm_floatN_t(b, (k->size[2] + 0.5) / MAX2(k->size[0], 1), v->bit_size);
            break;
         case nir_tex_src_offset:
            z = nir_imm_intN_t(b, 0, v->bit_size);
            break;
         case nir_tex_src_ddx:
         case nir_tex_src_ddy:
            z = nir_imm_floatN_t(b, 0, v->bit_size);
            break;
         default:
            continue;
         }
         nir_src_rewrite(&tex->src[i].src, with_z(b, v, z));
      }
      tex->coord_components = 3;
      return true;
   }
   if (instr->type != nir_instr_type_intrinsic)
      return false;
   nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
   switch (intr->intrinsic) {
   case nir_intrinsic_image_load:
   case nir_intrinsic_image_store:
   case nir_intrinsic_image_atomic:
   case nir_intrinsic_image_atomic_swap:
   case nir_intrinsic_image_size:
      break;
   default:
      return false;
   }
   if (nir_intrinsic_image_dim(intr) != GLSL_SAMPLER_DIM_2D || nir_intrinsic_image_array(intr) ||
       !nir_src_is_const(intr->src[0]))
      return false;
   const struct wgsl_sampler_key *k = slice_key(s, nir_src_as_uint(intr->src[0]));
   if (!k)
      return false;
   nir_intrinsic_set_image_dim(intr, GLSL_SAMPLER_DIM_3D);
   if (intr->intrinsic == nir_intrinsic_image_size) {
      intr->def.num_components = 3;
      intr->num_components = 3;
      b->cursor = nir_after_instr(instr);
      nir_def *xy = nir_trim_vector(b, &intr->def, 2);
      nir_def_rewrite_uses_after(&intr->def, xy);
      return true;
   }
   b->cursor = nir_before_instr(instr);
   nir_def *c = intr->src[1].ssa;
   if (c->num_components < 3)
      return false;
   nir_src_rewrite(&intr->src[1], nir_vector_insert_imm(b, c, nir_imm_intN_t(b, k->size[2], c->bit_size), 2));
   return true;
}

/* A 10-bit SNORM view's reads (WGSL_SNORM_KEY), after lower_tex: each op that gives texels (the fetches lower_tex made
 * included) clamped to [-1, 1], as Vulkan converts its most negative code. */
static bool
clamp_snorm(nir_builder *b, nir_tex_instr *tex, void *data)
{
   const struct sampler_pass *s = data;
   if (tex->is_shadow || nir_alu_type_get_base_type(tex->dest_type) != nir_type_float ||
       (tex->op != nir_texop_tex && tex->op != nir_texop_txb && tex->op != nir_texop_txl && tex->op != nir_texop_txd &&
        tex->op != nir_texop_txf && tex->op != nir_texop_txf_ms && tex->op != nir_texop_tg4))
      return false;
   bool keyed = false;
   for (uint32_t i = 0; i < s->key_count && !keyed; i++)
      keyed = s->keys[i].sampler == WGSL_SNORM_KEY && s->keys[i].texture == tex->texture_index;
   if (!keyed)
      return false;
   b->cursor = nir_after_instr(&tex->instr);
   nir_def *clamped = nir_fmax(b, nir_fmin(b, &tex->def, nir_imm_float(b, 1.0f)), nir_imm_float(b, -1.0f));
   nir_def_rewrite_uses_after(&tex->def, clamped);
   return true;
}

void
wgsl_lower_samplers(nir_shader *nir, const struct wgsl_print_options *o, struct wgsl_info *info)
{
   struct sampler_pass s = { .keys = o->keys, .key_count = o->key_count, .info = info };
   for (uint32_t i = 0; i < o->key_count; i++)
      if (o->keys[i].sampler == WGSL_SLICE_KEY) {
         NIR_PASS(_, nir, nir_shader_instructions_pass, lower_slice, nir_metadata_control_flow, &s);
         break;
      }
   for (uint32_t i = 0; i < MIN2(o->depth_count, ARRAY_SIZE(s.depths)); i++)
      s.depths[s.depth_count++] = o->depths[i];
   nir_shader_tex_pass(nir, find_depths, nir_metadata_all, &s);
   nir_shader_tex_pass(nir, find_cubes, nir_metadata_all, &s);
   NIR_PASS(_, nir, nir_shader_tex_pass, lower_tex, nir_metadata_control_flow, &s);
   for (uint32_t i = 0; i < o->key_count; i++)
      if (o->keys[i].sampler == WGSL_SNORM_KEY) {
         NIR_PASS(_, nir, nir_shader_tex_pass, clamp_snorm, nir_metadata_control_flow, &s);
         break;
      }
}
