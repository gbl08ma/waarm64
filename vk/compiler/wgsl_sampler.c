/*
 * Sampling as a sampler says (VK4 T8; vk/README.md "Samplers in the shader"): what WebGPU's samplers can't do, against
 * the sampler state a variant's draw binds (`wgsl_sampler_key`): border colours, mirror-once, unnormalized coordinates,
 * the sampler's LOD bias, and integer textures, which WGSL samples with no sampler at all: they are fetched, their
 * address modes and LOD worked out here. Runs when a stage is printed, so a stage's NIR kept across its compile takes
 * another key without another translation. No key (a stage's own module): integer textures at clamp-to-edge, and
 * everything else WebGPU's.
 */
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
   bool cube_gathered;
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

/* A query of the texture `tex` samples: its level-`lod` size (components as WGSL's, a layer count last) or levels. */
static nir_def *
query(nir_builder *b, const nir_tex_instr *tex, nir_texop op, nir_def *lod, unsigned components)
{
   nir_tex_instr *q = nir_tex_instr_create(b->shader, lod ? 1 : 0);
   q->op = op;
   q->sampler_dim = tex->sampler_dim;
   q->is_array = tex->is_array;
   q->dest_type = nir_type_int32;
   q->texture_index = tex->texture_index;
   q->sampler_index = tex->sampler_index;
   if (lod)
      q->src[0] = nir_tex_src_for_ssa(nir_tex_src_lod, lod);
   nir_def_init(&q->instr, &q->def, components, 32);
   nir_builder_instr_insert(b, &q->instr);
   return &q->def;
}

/* The spatial dimensions of a coordinate. */
static unsigned
spatial(const nir_tex_instr *tex)
{
   return tex->coord_components - (tex->is_array ? 1 : 0);
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
   if ((tex->op != nir_texop_tex && tex->op != nir_texop_txb) || b->shader->info.stage != MESA_SHADER_FRAGMENT)
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
   return nir_fadd(b, base, sum);
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
   f->texture_index = tex->texture_index;
   f->sampler_index = tex->sampler_index;
   f->src[0] = nir_tex_src_for_ssa(nir_tex_src_coord, coord);
   f->src[1] = nir_tex_src_for_ssa(nir_tex_src_lod, lod);
   nir_def_init(&f->instr, &f->def, components, 32);
   nir_builder_instr_insert(b, &f->instr);
   return &f->def;
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

/* A gather through fetches, for what WebGPU's samplers can't address (borders, mirror-once): the four texels' chosen
 * component, each wrapped, in OpImageGather's order (i0 j1, i1 j1, i1 j0, i0 j0); compared for a shadow gather. */
static nir_def *
gather_fetch(nir_builder *b, nir_tex_instr *tex, const struct wgsl_sampler_key *key)
{
   nir_def *coord = tex_source(tex, nir_tex_src_coord), *dref = tex_source(tex, nir_tex_src_comparator);
   const unsigned n = spatial(tex);
   nir_def *size = query(b, tex, nir_texop_txs, nir_imm_int(b, 0), tex->coord_components);
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
      nir_def *texel = fetch(b, tex, nir_vec(b, c, layer ? 3 : 2), lod, 4, tex->sampler_dim, tex->is_array, layer ? 3 : 2);
      nir_def *v = nir_bcsel(b, nir_ior(b, ox, oy), component, nir_channel(b, texel, dref ? 0 : tex->component));
      res[k] = dref ? compare_of(b, dref, v, key->compare) : v;
   }
   return nir_vec4(b, res[0], res[1], res[2], res[3]);
}

/* `tex` sampled at a level, explicit: what border emulation does for each mip of a blend. */
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

/* How much of a sample at level `level` (float, whole) comes from inside the image, the border's share being the rest:
 * per axis, the part of the filter's footprint on this side of the edge. */
static nir_def *
inside(nir_builder *b, const nir_tex_instr *tex, const struct wgsl_sampler_key *key, nir_def *coord, nir_def *size,
       nir_def *level, nir_def *lambda)
{
   nir_def *weight = nir_imm_float(b, 1.0f);
   nir_def *shift = level ? nir_f2i32(b, level) : nir_imm_int(b, 0);
   for (unsigned i = 0; i < spatial(tex); i++) {
      if (key->address[i] != WGSL_ADDRESS_BORDER)
         continue;
      nir_def *extent = nir_i2f32(b, nir_imax(b, nir_ishr(b, nir_channel(b, size, i), shift), nir_imm_int(b, 1)));
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
   nir_def *dref = tex_source(tex, nir_tex_src_comparator);
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
 * sample has neither (T9's). */
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
    * filter's footprint fell past the edge. Whole views of one level need no LOD; else the levels are chosen here, so
    * that each blends by its own size (anisotropy doesn't survive: Vulkan leaves its footprint to the implementation).
    * A shadow sample can't take a level past 0 (T9's): it stays WebGPU's, blended by its level's weights. */
   nir_def *derivative_dx[3], *derivative_dy[3];
   nir_def *lambda = NULL;
   const bool multi = key->levels > 1;
   if (multi || key->mag_linear != key->min_linear) {
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
   nir_def *weight;
   if (!multi) {
      weight = inside(b, tex, key, adjusted, size, NULL, lambda);
   } else {
      nir_def *last = nir_imm_float(b, (float)(key->levels - 1));
      nir_def *clamped = nir_fmin(b, nir_fmax(b, lambda, nir_imm_float(b, 0.0f)), last);
      if (!key->mip_linear) {
         nir_def *level = nir_i2f32(b, nearest_level(b, tex, key, lambda));
         weight = inside(b, tex, key, adjusted, size, level, lambda);
         if (!shadow) {
            nir_def_replace(&tex->def, blend_border(b, tex, key, sample_level(b, tex, adjusted, level), weight));
            return true;
         }
      } else {
         nir_def *l0 = nir_ffloor(b, clamped), *l1 = nir_fmin(b, nir_fadd_imm(b, l0, 1.0f), last);
         nir_def *f = nir_fsub(b, clamped, l0), *g = nir_fsub_imm(b, 1.0f, f);
         nir_def *w0 = inside(b, tex, key, adjusted, size, l0, lambda), *w1 = inside(b, tex, key, adjusted, size, l1, lambda);
         if (!shadow) {
            nir_def *x = blend_border(b, tex, key, sample_level(b, tex, adjusted, l0), w0);
            nir_def *y = blend_border(b, tex, key, sample_level(b, tex, adjusted, l1), w1);
            nir_def *mix[4];
            for (unsigned i = 0; i < tex->def.num_components; i++)
               mix[i] = nir_fadd(b, nir_fmul(b, nir_channel(b, x, i), g), nir_fmul(b, nir_channel(b, y, i), f));
            nir_def_replace(&tex->def, nir_vec(b, mix, tex->def.num_components));
            return true;
         }
         weight = nir_fadd(b, nir_fmul(b, w0, g), nir_fmul(b, w1, f));
      }
   }
   b->cursor = nir_after_instr(&tex->instr);
   nir_def_rewrite_uses_after(&tex->def, blend_border(b, tex, key, &tex->def, weight));
   return true;
}

static bool
lower_tex(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   b->cursor = nir_before_instr(&tex->instr);
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_BUF)
      return false;
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
   if (!samples(tex) || tex->sampler_dim == GLSL_SAMPLER_DIM_MS)
      return false;
   const struct wgsl_sampler_key *key = find_key(s, tex);
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
                                                           !uses_address(tex, key, WGSL_ADDRESS_MIRROR_ONCE)))
            return false;
         nir_def_replace(&tex->def, nir_trim_vector(b, gather_fetch(b, tex, key), tex->def.num_components));
         return true;
      }
      nir_def *res = int_sample(b, tex, key);
      nir_def_replace(&tex->def, nir_trim_vector(b, res, tex->def.num_components));
      return true;
   }
   return key ? float_sample(b, tex, key) : false;
}

static bool
find_cubes(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   if (tex->sampler_dim != GLSL_SAMPLER_DIM_CUBE || !is_integer(tex) || !samples(tex) || tex->op == nir_texop_tg4)
      return false;
   if (!is_int_cube(s, tex) && s->cube_count < WGSL_MAX_PAIRS)
      s->cubes[s->cube_count++] = tex->texture_index;
   return false;
}

static bool
find_gathered(nir_builder *b, nir_tex_instr *tex, void *data)
{
   struct sampler_pass *s = data;
   if (tex->op == nir_texop_tg4 && is_int_cube(s, tex))
      s->cube_gathered = true;
   return false;
}

bool
wgsl_lower_samplers(nir_shader *nir, const struct wgsl_sampler_key *keys, uint32_t key_count, struct wgsl_info *info)
{
   struct sampler_pass s = { .keys = keys, .key_count = key_count, .info = info };
   nir_shader_tex_pass(nir, find_cubes, nir_metadata_all, &s);
   nir_shader_tex_pass(nir, find_gathered, nir_metadata_all, &s);
   NIR_PASS(_, nir, nir_shader_tex_pass, lower_tex, nir_metadata_control_flow, &s);
   return !s.cube_gathered;
}
