/*
 * The NIR side of the WGSL backend (wgsl.h): options, the generic preprocessing, the lowering against a layout and
 * the link of a vertex and a fragment shader. The pass lists follow KosmicKrisp's (Mesa 26.2.4,
 * src/kosmickrisp/compiler/nir_to_msl.c msl_preprocess_nir and msl_optimize_nir, vulkan/kk_shader.c kk_lower_nir;
 * MIT), without what is Metal's (argument buffers, 64-bit addresses) and with buffers as bindings.
 */
#include <stdio.h>
#include <string.h>

#include "nir.h"
#include "nir_builder.h"
#include "nir_builtin_builder.h"
#include "spirv/nir_spirv.h"
#include "vk_nir_convert_ycbcr.h"
#include "vk_ycbcr_conversion.h"

#include "wgsl.h"

static const nir_shader_compiler_options options = {
   .lower_fdph = true,
   .has_fsub = true,
   .has_isub = true,
   .lower_extract_word = true,
   .lower_extract_byte = true,
   .lower_insert_word = true,
   .lower_insert_byte = true,
   .lower_fmod = true,
   .lower_flrp32 = true,
   .lower_hadd = true,
   .lower_uadd_sat = true,
   .lower_usub_sat = true,
   .lower_iadd_sat = true,
   .lower_mul_high = true,
   .lower_mul_2x32_64 = true,
   .lower_uadd_carry = true,
   .lower_usub_borrow = true,
   .lower_scmp = true,
   .lower_isign = true,
   .lower_fsign = false,
   .lower_fquantize2f16 = true,
   .lower_pack_64_2x32_split = true,
   .lower_unpack_64_2x32_split = true,
   .lower_pack_64_2x32 = true,
   .lower_pack_64_4x16 = true,
   .lower_pack_split = true,
   .lower_pack_unorm_2x16 = true,
   .lower_pack_snorm_2x16 = true,
   .lower_pack_unorm_4x8 = true,
   .lower_pack_snorm_4x8 = true,
   .lower_unpack_unorm_2x16 = true,
   .lower_unpack_snorm_2x16 = true,
   .lower_unpack_unorm_4x8 = true,
   .lower_unpack_snorm_4x8 = true,
   .lower_device_index_to_zero = true,
   .discard_is_demote = true,
   .has_cs_global_id = true,
   .instance_id_includes_base_index = true,
   .compact_arrays = true,
   .lower_doubles_options = (nir_lower_doubles_options)~0,
   .lower_int64_options = (nir_lower_int64_options)~0,
   .max_unroll_iterations = 32,
};

const struct nir_shader_compiler_options *
wgsl_nir_options(void)
{
   return &options;
}

/* Buffers by binding and offset, push constants and shared memory by offset; no physical pointers (bufferDeviceAddress
 * isn't offered). */
void
wgsl_spirv_options(struct spirv_to_nir_options *out)
{
   *out = (struct spirv_to_nir_options){
      .environment = NIR_SPIRV_VULKAN,
      .ubo_addr_format = nir_address_format_32bit_index_offset,
      .ssbo_addr_format = nir_address_format_32bit_index_offset,
      .phys_ssbo_addr_format = nir_address_format_64bit_global,
      .push_const_addr_format = nir_address_format_logical,
      .shared_addr_format = nir_address_format_32bit_offset,
      .constant_addr_format = nir_address_format_64bit_global,
      .min_ubo_alignment = 256,
      .min_ssbo_alignment = 256,
   };
}

static bool
scalarize_filter(const nir_instr *instr, const void *data)
{
   return instr->type == nir_instr_type_alu;
}

/* Input attachments as 2D textures (kk_shader.c's lower_subpass_dim), without the layer nir_lower_input_attachments
 * gives their coordinate: a multiview pass binds each view's layer (wg_cmd.c `bind_group`), and WGSL has no multisampled
 * arrays. */
static bool
lower_subpass_dim(nir_builder *b, nir_tex_instr *tex, void *data)
{
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_SUBPASS)
      tex->sampler_dim = GLSL_SAMPLER_DIM_2D;
   else if (tex->sampler_dim == GLSL_SAMPLER_DIM_SUBPASS_MS)
      tex->sampler_dim = GLSL_SAMPLER_DIM_MS;
   else
      return false;
   if (tex->is_array) {
      const int i = nir_tex_instr_src_index(tex, nir_tex_src_coord);
      b->cursor = nir_before_instr(&tex->instr);
      nir_src_rewrite(&tex->src[i].src, nir_trim_vector(b, tex->src[i].src.ssa, 2));
      tex->is_array = false;
      tex->coord_components = 2;
   }
   return true;
}

void
wgsl_preprocess(nir_shader *nir)
{
   /* Outputs written through temporaries, so that partial writes and reads of outputs become whole stores. */
   if (nir->info.stage == MESA_SHADER_VERTEX || nir->info.stage == MESA_SHADER_FRAGMENT)
      NIR_PASS(_, nir, nir_lower_io_vars_to_temporaries, nir_shader_get_entrypoint(nir), nir_var_shader_out);
   NIR_PASS(_, nir, nir_lower_variable_initializers, nir_var_function_temp);
   NIR_PASS(_, nir, nir_lower_returns);
   NIR_PASS(_, nir, nir_inline_functions);
   NIR_PASS(_, nir, nir_opt_deref);
   nir_remove_non_entrypoints(nir);

   NIR_PASS(_, nir, nir_lower_global_vars_to_local);
   NIR_PASS(_, nir, nir_split_var_copies);
   NIR_PASS(_, nir, nir_split_struct_vars, nir_var_function_temp);
   NIR_PASS(_, nir, nir_split_array_vars, nir_var_function_temp);
   NIR_PASS(_, nir, nir_split_per_member_structs);
   NIR_PASS(_, nir, nir_lower_continue_constructs);
   NIR_PASS(_, nir, nir_lower_frexp);
   NIR_PASS(_, nir, nir_lower_vars_to_ssa);
   NIR_PASS(_, nir, nir_remove_dead_variables, nir_var_function_temp, NULL);
   NIR_PASS(_, nir, nir_opt_copy_prop);
   NIR_PASS(_, nir, nir_opt_constant_folding);
   NIR_PASS(_, nir, nir_opt_deref);
   NIR_PASS(_, nir, nir_lower_system_values);
   NIR_PASS(_, nir, nir_opt_dce);

   if (nir->info.stage == MESA_SHADER_FRAGMENT) {
      const nir_input_attachment_options ia = { 0 };
      NIR_PASS(_, nir, nir_lower_input_attachments, &ia);
      NIR_PASS(_, nir, nir_shader_tex_pass, lower_subpass_dim, nir_metadata_control_flow, NULL);
   }
   NIR_PASS(_, nir, nir_lower_var_copies);
   NIR_PASS(_, nir, nir_split_var_copies);
   NIR_PASS(_, nir, nir_lower_memcpy);
   NIR_PASS(_, nir, nir_split_array_vars, nir_var_function_temp | nir_var_shader_in | nir_var_shader_out);
   NIR_PASS(_, nir, nir_lower_alu_to_scalar, scalarize_filter, NULL);
   NIR_PASS(_, nir, nir_lower_vars_to_scratch, 32, glsl_get_natural_size_align_bytes,
            glsl_get_word_size_align_bytes);
   NIR_PASS(_, nir, nir_lower_indirect_derefs_to_if_else_trees,
            nir_var_function_temp | nir_var_shader_in | nir_var_shader_out, UINT32_MAX);
}

/* Descriptors to slots. A buffer's descriptor is vec2(index, 0) with index = group << 16 | WGSL binding; a texture's or
 * sampler's index goes in the tex instruction's texture_index / sampler_index, an image's in its intrinsic's first
 * source, the same way. Array elements are constants by then (arrays indexed dynamically are chosen from first). */
struct lower_state {
   const struct wgsl_layout *layout;
   char *error;
   size_t error_size;
   bool failed;
};

static void
fail(struct lower_state *s, const char *what, unsigned set, unsigned binding)
{
   if (!s->failed)
      snprintf(s->error, s->error_size, "%s (set %u, binding %u)", what, set, binding);
   s->failed = true;
}

/* The index (group << 16 | WGSL binding) of (set, binding)'s first element; -1 if the layout has none. */
static int
slot_binding(struct lower_state *s, unsigned set, unsigned binding)
{
   if (set >= s->layout->set_count || binding >= s->layout->sets[set].binding_count ||
       s->layout->sets[set].first[binding] < 0) {
      fail(s, "a descriptor outside the layout", set, binding);
      return -1;
   }
   const struct wgsl_set_layout *l = &s->layout->sets[set];
   return l->group << 16 | (l->base + l->first[binding]) * 2;
}

/* A deref chain to its variable and its constant element. */
static nir_variable *
deref_element(struct lower_state *s, nir_deref_instr *deref, unsigned *element)
{
   unsigned el = 0, stride = 1;
   while (deref->deref_type != nir_deref_type_var) {
      if (deref->deref_type != nir_deref_type_array) {
         s->failed = true;
         snprintf(s->error, s->error_size, "a descriptor reached through a cast");
         return NULL;
      }
      if (!nir_src_is_const(deref->arr.index)) {
         nir_variable *v = nir_deref_instr_get_variable(deref);
         fail(s, "a dynamically indexed descriptor array", v ? v->data.descriptor_set : 0, v ? v->data.binding : 0);
         return NULL;
      }
      el += nir_src_as_uint(deref->arr.index) * stride;
      stride *= MAX2(glsl_get_length(nir_deref_instr_parent(deref)->type), 1);
      deref = nir_deref_instr_parent(deref);
   }
   *element = el;
   return deref->var;
}

static bool
lower_descriptors_instr(nir_builder *b, nir_instr *instr, void *data)
{
   struct lower_state *s = data;
   b->cursor = nir_before_instr(instr);
   if (instr->type == nir_instr_type_tex) {
      nir_tex_instr *tex = nir_instr_as_tex(instr);
      bool progress = false;
      int tex_set = -1, tex_binding = 0;
      unsigned tex_el = 0;
      for (unsigned i = 0; i < tex->num_srcs; i++) {
         const bool sampler = tex->src[i].src_type == nir_tex_src_sampler_deref;
         if (!sampler && tex->src[i].src_type != nir_tex_src_texture_deref)
            continue;
         unsigned el;
         nir_variable *var = deref_element(s, nir_src_as_deref(tex->src[i].src), &el);
         if (!var)
            return false;
         const int base = slot_binding(s, var->data.descriptor_set, var->data.binding);
         if (base < 0)
            return false;
         const unsigned index = base + 2 * el + sampler;
         if (sampler) {
            tex->sampler_index = index;
         } else {
            tex->texture_index = index;
            tex_set = var->data.descriptor_set, tex_binding = var->data.binding, tex_el = el;
            /* A size or level query's result doesn't say the texture's type, which only the variable does: the printer
             * declares it by `component`, which those ops don't use (1 sint, 2 uint), or a stage that only asks an
             * integer texture's size binds it as float. */
            if (tex->op == nir_texop_txs || tex->op == nir_texop_query_levels) {
               const enum glsl_base_type type = glsl_get_sampler_result_type(glsl_without_array(var->type));
               tex->component = type == GLSL_TYPE_INT ? 1 : type == GLSL_TYPE_UINT ? 2 : 0;
            }
         }
         nir_tex_instr_remove_src(tex, i);
         i--;
         progress = true;
      }
      /* A plane past the first (wgsl_lower_ycbcr's samples): its own texture, at the binding's plane slots. */
      const int pi = nir_tex_instr_src_index(tex, nir_tex_src_plane);
      if (pi >= 0) {
         const unsigned plane = nir_src_as_uint(tex->src[pi].src);
         nir_tex_instr_remove_src(tex, pi);
         progress = true;
         if (plane > 0) {
            const struct wgsl_set_layout *l = tex_set >= 0 ? &s->layout->sets[tex_set] : NULL;
            if (!l || !l->planes || l->planes[tex_binding] < 0) {
               fail(s, "a plane of an image without planes", MAX2(tex_set, 0), tex_binding);
               return false;
            }
            tex->texture_index = l->group << 16 | (l->base + l->planes[tex_binding] + 2 * tex_el + plane - 1) * 2;
         }
      }
      return progress;
   }
   if (instr->type != nir_instr_type_intrinsic)
      return false;
   nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
   switch (intr->intrinsic) {
   case nir_intrinsic_vulkan_resource_index: {
      const unsigned set = nir_intrinsic_desc_set(intr), binding = nir_intrinsic_binding(intr);
      const int base = slot_binding(s, set, binding);
      if (base < 0)
         return false;
      nir_def *index = nir_iadd_imm(b, nir_imul_imm(b, intr->src[0].ssa, 2), base);
      nir_def_replace(&intr->def, nir_vec2(b, index, nir_imm_int(b, 0)));
      return true;
   }
   case nir_intrinsic_vulkan_resource_reindex: {
      nir_def *index = nir_iadd(b, nir_channel(b, intr->src[0].ssa, 0), nir_imul_imm(b, intr->src[1].ssa, 2));
      nir_def_replace(&intr->def, nir_vec2(b, index, nir_channel(b, intr->src[0].ssa, 1)));
      return true;
   }
   case nir_intrinsic_load_vulkan_descriptor:
      nir_def_replace(&intr->def, intr->src[0].ssa);
      return true;
   case nir_intrinsic_image_deref_load:
   case nir_intrinsic_image_deref_store:
   case nir_intrinsic_image_deref_atomic:
   case nir_intrinsic_image_deref_atomic_swap:
   case nir_intrinsic_image_deref_size:
   case nir_intrinsic_image_deref_samples:
   case nir_intrinsic_image_deref_levels: {
      unsigned el;
      nir_variable *var = deref_element(s, nir_src_as_deref(intr->src[0]), &el);
      if (!var)
         return false;
      const int base = slot_binding(s, var->data.descriptor_set, var->data.binding);
      if (base < 0)
         return false;
      if (nir_intrinsic_format(intr) == PIPE_FORMAT_NONE)
         nir_intrinsic_set_format(intr, var->data.image.format);
      nir_rewrite_image_intrinsic(intr, nir_imm_int(b, base + 2 * el),
                                  nir_image_intrinsic_type_default);
      return true;
   }
   default:
      return false;
   }
}

/* 1D textures and images as 2D ones of one row (WebGPU's 1D textures have one level, no layers and can't be rendered
 * into, so the driver makes every 1D image 2D): a coordinate gains its second component (the row's centre for a
 * sampled one, 0 for a fetched one or an image's), an array's layer moves up one, and a size query drops the height. */
static nir_def *
widen_1d(nir_builder *b, nir_def *coord, bool array, nir_def *y)
{
   nir_def *c[4] = { nir_channel(b, coord, 0), y };
   unsigned n = 2;
   if (array)
      c[n++] = nir_channel(b, coord, 1);
   return nir_vec(b, c, n);
}

static bool
lower_1d_tex(nir_builder *b, nir_tex_instr *tex, void *data)
{
   if (tex->sampler_dim != GLSL_SAMPLER_DIM_1D)
      return false;
   b->cursor = nir_before_instr(&tex->instr);
   tex->sampler_dim = GLSL_SAMPLER_DIM_2D;
   for (unsigned i = 0; i < tex->num_srcs; i++) {
      nir_def *v = tex->src[i].src.ssa;
      switch (tex->src[i].src_type) {
      case nir_tex_src_coord:
         nir_src_rewrite(&tex->src[i].src,
                         widen_1d(b, v, tex->is_array, nir_tex_instr_src_type(tex, i) == nir_type_float
                                                          ? nir_imm_float(b, 0.5f)
                                                          : nir_imm_int(b, 0)));
         break;
      case nir_tex_src_offset:
      case nir_tex_src_ddx:
      case nir_tex_src_ddy: {
         nir_def *zero = tex->src[i].src_type == nir_tex_src_offset ? nir_imm_int(b, 0) : nir_imm_float(b, 0);
         nir_src_rewrite(&tex->src[i].src, nir_vec2(b, nir_channel(b, v, 0), zero));
         break;
      }
      default:
         break;
      }
   }
   tex->coord_components++;
   if (tex->op == nir_texop_txs) {
      /* 2D sizes are (w, h[, layers]): the height goes. */
      tex->def.num_components++;
      b->cursor = nir_after_instr(&tex->instr);
      nir_def *size = tex->is_array ? nir_channels(b, &tex->def, 0x5) : nir_channel(b, &tex->def, 0);
      nir_def_rewrite_uses_after(&tex->def, size);
   }
   return true;
}

static bool
lower_1d_image(nir_builder *b, nir_intrinsic_instr *intr, void *data)
{
   switch (intr->intrinsic) {
   case nir_intrinsic_image_deref_load:
   case nir_intrinsic_image_deref_store:
   case nir_intrinsic_image_deref_atomic:
   case nir_intrinsic_image_deref_atomic_swap:
   case nir_intrinsic_image_deref_size:
      break;
   default:
      return false;
   }
   if (nir_intrinsic_image_dim(intr) != GLSL_SAMPLER_DIM_1D)
      return false;
   const bool array = nir_intrinsic_image_array(intr);
   nir_intrinsic_set_image_dim(intr, GLSL_SAMPLER_DIM_2D);
   nir_deref_instr *d = nir_src_as_deref(intr->src[0]);
   nir_variable *var = nir_deref_instr_get_variable(d);
   if (var)
      var->type = glsl_type_wrap_in_arrays(glsl_image_type(GLSL_SAMPLER_DIM_2D, array,
                                                           glsl_get_sampler_result_type(glsl_without_array(var->type))),
                                           var->type);
   if (intr->intrinsic == nir_intrinsic_image_deref_size) {
      intr->def.num_components++;
      b->cursor = nir_after_instr(&intr->instr);
      nir_def *size = array ? nir_channels(b, &intr->def, 0x5) : nir_channel(b, &intr->def, 0);
      nir_def_rewrite_uses_after(&intr->def, size);
      return true;
   }
   b->cursor = nir_before_instr(&intr->instr);
   nir_def *coord = intr->src[1].ssa;
   nir_def *c[4] = { nir_channel(b, coord, 0), nir_imm_int(b, 0),
                     array ? nir_channel(b, coord, 1) : nir_imm_int(b, 0), nir_imm_int(b, 0) };
   nir_src_rewrite(&intr->src[1], nir_vec(b, c, coord->num_components));
   return true;
}

/* Arrays of textures and samplers indexed dynamically (shaderSampledImageArrayDynamicIndexing: the index is
 * dynamically uniform): WGSL has no binding arrays, so each element is a binding of its own and the instruction is
 * chosen by the index, a binary tree of ifs with a copy per element. */
static nir_deref_instr *
dynamic_array_deref(nir_tex_instr *tex, unsigned i)
{
   if (tex->src[i].src_type != nir_tex_src_texture_deref && tex->src[i].src_type != nir_tex_src_sampler_deref)
      return NULL;
   nir_deref_instr *d = nir_src_as_deref(tex->src[i].src);
   return d->deref_type == nir_deref_type_array && !nir_src_is_const(d->arr.index) &&
                nir_deref_instr_parent(d)->deref_type == nir_deref_type_var
             ? d
             : NULL;
}

/* The texture's and the sampler's arrays may be indexed apart (texture2D t[4], sampler s[2]: t[i], s[j]): one
 * dynamic deref, `d`, is lowered at a time, with any other that has its index and its length; a copy left with
 * another index is lowered by the pass's next round. */
static nir_def *
emit_element(nir_builder *b, nir_tex_instr *tex, nir_deref_instr *d, nir_def *index, unsigned lo, unsigned hi)
{
   if (hi - lo == 1) {
      /* The clone's sources aren't in use lists until it's inserted: set, not rewritten. */
      nir_tex_instr *copy = nir_instr_as_tex(nir_instr_clone(b->shader, &tex->instr));
      for (unsigned i = 0; i < copy->num_srcs; i++) {
         nir_deref_instr *e = dynamic_array_deref(tex, i);
         if (e && (e == d || (e->arr.index.ssa == d->arr.index.ssa &&
                              glsl_get_length(nir_deref_instr_parent(e)->type) ==
                                 glsl_get_length(nir_deref_instr_parent(d)->type))))
            copy->src[i].src = nir_src_for_ssa(&nir_build_deref_array_imm(b, nir_deref_instr_parent(e), lo)->def);
      }
      nir_builder_instr_insert(b, &copy->instr);
      return &copy->def;
   }
   const unsigned mid = (lo + hi) / 2;
   nir_push_if(b, nir_ult_imm(b, index, mid));
   nir_def *x = emit_element(b, tex, d, index, lo, mid);
   nir_push_else(b, NULL);
   nir_def *y = emit_element(b, tex, d, index, mid, hi);
   nir_pop_if(b, NULL);
   return nir_if_phi(b, x, y);
}

static bool
lower_dynamic_tex_index(nir_builder *b, nir_tex_instr *tex, void *data)
{
   nir_deref_instr *d = NULL;
   for (unsigned i = 0; i < tex->num_srcs && !d; i++)
      d = dynamic_array_deref(tex, i);
   if (!d)
      return false;
   const unsigned n = glsl_get_length(nir_deref_instr_parent(d)->type);
   if (!n)
      return false;
   b->cursor = nir_before_instr(&tex->instr);
   nir_def *index = nir_umin(b, d->arr.index.ssa, nir_imm_int(b, n - 1));
   nir_def *res = emit_element(b, tex, d, index, 0, n);
   nir_def_replace(&tex->def, res);
   return true;
}

/* Arrays of buffers and storage images indexed dynamically (VK3 L7.1: shaderUniformBufferArrayDynamicIndexing,
 * shaderStorageBufferArrayDynamicIndexing, shaderStorageImageArrayDynamicIndexing; Dawn's Vulkan backend requires
 * them): as textures', each element a binding of its own and the access chosen by the index, a binary tree of ifs with
 * a copy of the access per element. An index past the array reads its last element. */
struct dyn_access {
   nir_intrinsic_instr *intr;
   /* A buffer's: the resource index whose array index isn't constant, the descriptor loaded from it and the cast that
    * starts the access's deref chain. An image's: the array deref whose index isn't constant. */
   nir_intrinsic_instr *ri, *desc;
   nir_deref_instr *cast, *array;
};

/* The access's deref chain from `d` up to its cast, rebuilt over `desc` (a buffer's element's descriptor). */
static nir_deref_instr *
clone_buffer_chain(nir_builder *b, nir_deref_instr *d, const struct dyn_access *a, nir_def *desc)
{
   nir_deref_instr *copy = nir_instr_as_deref(nir_instr_clone(b->shader, &d->instr));
   /* The clone's sources aren't in use lists until it's inserted: set, not rewritten. */
   copy->parent = nir_src_for_ssa(d == a->cast ? desc : &clone_buffer_chain(b, nir_deref_instr_parent(d), a, desc)->def);
   nir_builder_instr_insert(b, &copy->instr);
   return copy;
}

static nir_def *
emit_access(nir_builder *b, const struct dyn_access *a, nir_def *index, unsigned lo, unsigned hi)
{
   nir_intrinsic_instr *intr = a->intr;
   if (hi - lo == 1) {
      nir_deref_instr *d;
      if (a->ri) {
         nir_intrinsic_instr *ri = nir_instr_as_intrinsic(nir_instr_clone(b->shader, &a->ri->instr));
         ri->src[0] = nir_src_for_ssa(nir_imm_int(b, lo));
         nir_builder_instr_insert(b, &ri->instr);
         nir_intrinsic_instr *desc = nir_instr_as_intrinsic(nir_instr_clone(b->shader, &a->desc->instr));
         desc->src[0] = nir_src_for_ssa(&ri->def);
         nir_builder_instr_insert(b, &desc->instr);
         d = clone_buffer_chain(b, nir_src_as_deref(intr->src[0]), a, &desc->def);
      } else {
         d = nir_build_deref_array_imm(b, nir_deref_instr_parent(a->array), lo);
      }
      nir_intrinsic_instr *copy = nir_instr_as_intrinsic(nir_instr_clone(b->shader, &intr->instr));
      copy->src[0] = nir_src_for_ssa(&d->def);
      nir_builder_instr_insert(b, &copy->instr);
      return nir_intrinsic_infos[intr->intrinsic].has_dest ? &copy->def : NULL;
   }
   const unsigned mid = (lo + hi) / 2;
   nir_push_if(b, nir_ult_imm(b, index, mid));
   nir_def *x = emit_access(b, a, index, lo, mid);
   nir_push_else(b, NULL);
   nir_def *y = emit_access(b, a, index, mid, hi);
   nir_pop_if(b, NULL);
   return x ? nir_if_phi(b, x, y) : NULL;
}

static bool
lower_dynamic_access_index(nir_builder *b, nir_intrinsic_instr *intr, void *data)
{
   const struct wgsl_layout *layout = data;
   struct dyn_access a = { .intr = intr };
   unsigned n;
   switch (intr->intrinsic) {
   case nir_intrinsic_load_deref:
   case nir_intrinsic_store_deref:
   case nir_intrinsic_deref_atomic:
   case nir_intrinsic_deref_atomic_swap:
   case nir_intrinsic_deref_buffer_array_length: {
      nir_deref_instr *d = nir_src_as_deref(intr->src[0]);
      if (!nir_deref_mode_is_one_of(d, nir_var_mem_ubo | nir_var_mem_ssbo))
         return false;
      while (d && d->deref_type != nir_deref_type_cast)
         d = d->deref_type == nir_deref_type_var ? NULL : nir_deref_instr_parent(d);
      a.cast = d;
      a.desc = d ? nir_src_as_intrinsic(d->parent) : NULL;
      if (!a.desc || a.desc->intrinsic != nir_intrinsic_load_vulkan_descriptor)
         return false;
      a.ri = nir_src_as_intrinsic(a.desc->src[0]);
      if (!a.ri || a.ri->intrinsic != nir_intrinsic_vulkan_resource_index || nir_src_is_const(a.ri->src[0]))
         return false;
      const unsigned set = nir_intrinsic_desc_set(a.ri), binding = nir_intrinsic_binding(a.ri);
      if (set >= layout->set_count || binding >= layout->sets[set].binding_count)
         return false;
      n = layout->sets[set].count[binding];
      break;
   }
   case nir_intrinsic_image_deref_load:
   case nir_intrinsic_image_deref_store:
   case nir_intrinsic_image_deref_size:
   case nir_intrinsic_image_deref_samples:
   case nir_intrinsic_image_deref_levels: {
      nir_deref_instr *d = nir_src_as_deref(intr->src[0]);
      if (d->deref_type != nir_deref_type_array || nir_src_is_const(d->arr.index) ||
          nir_deref_instr_parent(d)->deref_type != nir_deref_type_var)
         return false;
      a.array = d;
      n = glsl_get_length(nir_deref_instr_parent(d)->type);
      break;
   }
   default:
      return false;
   }
   if (!n)
      return false;
   b->cursor = nir_before_instr(&intr->instr);
   nir_def *index = nir_umin(b, a.ri ? a.ri->src[0].ssa : a.array->arr.index.ssa, nir_imm_int(b, n - 1));
   nir_def *res = emit_access(b, &a, index, 0, n);
   if (res)
      nir_def_replace(&intr->def, res);
   else
      nir_instr_remove(&intr->instr);
   return true;
}

/* Point size has no WGSL counterpart (points are a pixel), nor do primitive and viewport indices out of a vertex
 * shader: their writes go. */
static bool
remove_unsupported_outputs(nir_builder *b, nir_intrinsic_instr *intr, void *data)
{
   if (intr->intrinsic != nir_intrinsic_store_output)
      return false;
   const unsigned slot = nir_intrinsic_io_semantics(intr).location;
   if (slot != VARYING_SLOT_PSIZ && slot != VARYING_SLOT_LAYER && slot != VARYING_SLOT_VIEWPORT &&
       slot != VARYING_SLOT_PRIMITIVE_ID)
      return false;
   nir_instr_remove(&intr->instr);
   return true;
}

static unsigned
type_size_vec4(const struct glsl_type *type, bool bindless)
{
   return glsl_count_attribute_slots(type, false);
}

static void
shared_var_info(const struct glsl_type *type, unsigned *size, unsigned *align)
{
   const unsigned comp = glsl_type_is_boolean(type) ? 4 : glsl_get_bit_size(type) / 8;
   *size = comp * glsl_get_vector_elements(type), *align = comp;
}

/* Reductions and scans WGSL has (subgroupAdd and the like: wgsl_print.c), on scalars; the rest NIR lowers to shuffles. */
static bool
wgsl_reduction(nir_op op, bool scan)
{
   switch (op) {
   case nir_op_iadd: case nir_op_fadd: case nir_op_imul: case nir_op_fmul:
      return true;
   case nir_op_imin: case nir_op_umin: case nir_op_fmin: case nir_op_imax: case nir_op_umax: case nir_op_fmax:
   case nir_op_iand: case nir_op_ior: case nir_op_ixor:
      return !scan;
   default:
      return false;
   }
}

static bool
lower_subgroups_filter(const nir_intrinsic_instr *intr, const void *data)
{
   const unsigned size = *(const unsigned *)data;
   switch (intr->intrinsic) {
   case nir_intrinsic_reduce: {
      const unsigned cluster = nir_intrinsic_cluster_size(intr);
      return intr->def.num_components > 1 || (cluster && cluster < size) ||
             !wgsl_reduction(nir_intrinsic_reduction_op(intr), false);
   }
   case nir_intrinsic_inclusive_scan:
   case nir_intrinsic_exclusive_scan:
      return intr->def.num_components > 1 || !wgsl_reduction(nir_intrinsic_reduction_op(intr), true);
   default:
      return true;
   }
}

/* Subgroup operations (VK3 L5): of `size` invocations, WGSL's (`subgroups`: ballots of 4 × 32 bits) where it is over
 * 1, else of one invocation (the basic operations only). What WGSL has stays for the printer, on scalars: ballots, votes,
 * broadcasts and shuffles (read_invocation as subgroupShuffle: WGSL's subgroupBroadcast wants a constant), quad
 * broadcasts by a constant and swaps, elect, and the reductions and scans `wgsl_reduction` says; the rest is lowered
 * (masks, ballot queries, equality votes, clustered reductions, the other scans, quad votes, dynamic quad broadcasts). */
static void
lower_subgroups(nir_shader *nir, unsigned size)
{
   const nir_lower_subgroups_options o = {
      .filter = size > 1 ? lower_subgroups_filter : NULL,
      .filter_data = &size,
      .subgroup_size = size,
      .ballot_bit_size = 32,
      .ballot_components = size > 1 ? 4 : 1,
      .lower_to_scalar = true,
      .lower_vote_trivial = size == 1,
      .lower_vote_feq = true,
      .lower_vote_ieq = true,
      .lower_vote_bool_eq = true,
      .lower_subgroup_masks = true,
      .lower_relative_shuffle = size == 1,
      .lower_shuffle = size == 1,
      .lower_quad = size == 1,
      .lower_quad_broadcast_dynamic = true,
      .lower_quad_vote = true,
      .lower_elect = size == 1,
      .lower_rotate_to_shuffle = true,
      .lower_inverse_ballot = true,
      .lower_reduce = true,
      .lower_read_first_invocation = size == 1,
   };
   /* What a lowering makes (masks, ballot queries, shuffles of vectors) is lowered by the next round. */
   for (unsigned i = 0; i < 4; i++) {
      bool progress = false;
      NIR_PASS(progress, nir, nir_lower_subgroups, &o);
      if (!progress)
         break;
   }
}

/* 16-bit integers (16-bit storage's, and what NIR makes of 16-bit floats' bits) as 32-bit ones: WGSL has none. The
 * printer keeps a 16-bit value in a u32's low half; conversions, moves and selects work on that as it is. */
static unsigned
lower_bit_size_cb(const nir_instr *instr, void *data)
{
   if (instr->type != nir_instr_type_alu)
      return 0;
   const nir_alu_instr *alu = nir_instr_as_alu(instr);
   const nir_op_info *info = &nir_op_infos[alu->op];
   if (info->is_conversion || alu->op == nir_op_mov || alu->op == nir_op_bcsel || alu->op == nir_op_vec2 ||
       alu->op == nir_op_vec3 || alu->op == nir_op_vec4 || alu->op == nir_op_pack_32_2x16_split ||
       alu->op == nir_op_unpack_32_2x16_split_x || alu->op == nir_op_unpack_32_2x16_split_y)
      return 0;
   const unsigned bits = alu->def.bit_size == 1 ? alu->src[0].src.ssa->bit_size : alu->def.bit_size;
   const nir_alu_type type = alu->def.bit_size == 1 ? info->input_types[0] : info->output_type;
   if (bits != 8 && bits != 16)
      return 0;
   return nir_alu_type_get_base_type(type) == nir_type_float ? 0 : 32;
}

/* 16-bit values (VK3 L5): conversions to 16-bit floats as integer code (WGSL's own may round either way, and without
 * shader-f16 there is none), 16-bit integer arithmetic at 32 bits. */
static void
lower_16bit(nir_shader *nir)
{
   NIR_PASS(_, nir, nir_lower_fp16_casts, nir_lower_fp16_all);
   NIR_PASS(_, nir, nir_lower_bit_size, lower_bit_size_cb, NULL);
}

static void
optimize(nir_shader *nir)
{
   bool progress;
   do {
      progress = false;
      NIR_PASS(progress, nir, nir_split_var_copies);
      NIR_PASS(progress, nir, nir_split_struct_vars, nir_var_function_temp);
      NIR_PASS(progress, nir, nir_lower_var_copies);
      NIR_PASS(progress, nir, nir_lower_vars_to_ssa);
      NIR_PASS(progress, nir, nir_opt_undef);
      NIR_PASS(progress, nir, nir_opt_dce);
      NIR_PASS(progress, nir, nir_opt_cse);
      NIR_PASS(progress, nir, nir_opt_dead_cf);
      NIR_PASS(progress, nir, nir_opt_copy_prop);
      NIR_PASS(progress, nir, nir_opt_deref);
      NIR_PASS(progress, nir, nir_opt_constant_folding);
      NIR_PASS(progress, nir, nir_opt_copy_prop_vars);
      NIR_PASS(progress, nir, nir_opt_dead_write_vars);
      NIR_PASS(progress, nir, nir_remove_dead_variables, nir_var_function_temp, NULL);
      NIR_PASS(progress, nir, nir_opt_algebraic);
      NIR_PASS(progress, nir, nir_opt_if, 0);
      NIR_PASS(progress, nir, nir_opt_remove_phis);
      NIR_PASS(progress, nir, nir_opt_loop);
      NIR_PASS(progress, nir, nir_lower_pack);
      NIR_PASS(progress, nir, nir_lower_alu_to_scalar, scalarize_filter, NULL);
   } while (progress);
}

static const struct vk_ycbcr_conversion_state *
ycbcr_lookup(const void *data, uint32_t set, uint32_t binding, uint32_t element)
{
   const struct wgsl_layout *layout = data;
   if (set >= layout->set_count)
      return NULL;
   const struct wgsl_set_layout *l = &layout->sets[set];
   if (!l->ycbcr || binding >= l->binding_count || l->first[binding] < 0 || element >= l->count[binding])
      return NULL;
   return l->ycbcr[l->first[binding] + element];
}

bool
wgsl_lower_ycbcr(nir_shader *nir, const struct wgsl_layout *layout)
{
   bool any = false;
   for (uint32_t s = 0; s < layout->set_count; s++)
      any |= layout->sets[s].ycbcr != NULL;
   if (!any)
      return false;
   bool progress = false;
   NIR_PASS(progress, nir, nir_vk_lower_ycbcr_tex, ycbcr_lookup, layout);
   return progress;
}

/* A uniform buffer the layout folds into storage (wgsl_layout.ubo_storage: past WebGPU's uniform buffers a stage, VK3
 * L7.4) read as a read-only storage buffer: its loads become SSBO loads of the same binding, which the printer declares
 * `var<storage, read>` and the driver's layout entry `read-only-storage`. */
static bool
lower_ubo_storage(nir_builder *b, nir_intrinsic_instr *intr, void *data)
{
   const struct wgsl_layout *layout = data;
   if (intr->intrinsic != nir_intrinsic_load_ubo || !nir_src_is_const(intr->src[0]))
      return false;
   const unsigned index = nir_src_as_uint(intr->src[0]), group = index >> 16, slot = (index & 0xffff) / 2;
   if (group >= WGSL_MAX_GROUPS || slot >= 64 * WGSL_UBO_STORAGE_WORDS ||
       !(layout->ubo_storage[group][slot / 64] & (1ull << (slot % 64))))
      return false;
   b->cursor = nir_before_instr(&intr->instr);
   nir_def *v = nir_load_ssbo(b, intr->def.num_components, intr->def.bit_size, intr->src[0].ssa, intr->src[1].ssa,
                              .access = ACCESS_NON_WRITEABLE | ACCESS_CAN_REORDER,
                              .align_mul = nir_intrinsic_align_mul(intr),
                              .align_offset = nir_intrinsic_align_offset(intr));
   nir_def_replace(&intr->def, v);
   return true;
}

static void
optimize_cb(nir_shader *nir, void *data)
{
   optimize(nir);
}

bool
wgsl_lower(nir_shader *nir, const struct wgsl_layout *layout, unsigned subgroup_size, char *error, size_t error_size)
{
   struct lower_state s = { .layout = layout, .error = error, .error_size = error_size };
   error[0] = 0;
   wgsl_lower_ycbcr(nir, layout);
   NIR_PASS(_, nir, nir_shader_tex_pass, lower_1d_tex, nir_metadata_control_flow, NULL);
   NIR_PASS(_, nir, nir_shader_intrinsics_pass, lower_1d_image, nir_metadata_control_flow, NULL);
   nir_shader_gather_info(nir, nir_shader_get_entrypoint(nir));
   const nir_lower_compute_system_values_options csv = { 0 };
   NIR_PASS(_, nir, nir_lower_compute_system_values, &csv);
   const nir_opt_access_options access = { .is_vulkan = true };
   NIR_PASS(_, nir, nir_opt_access, &access);

   const nir_lower_tex_options tex = {
      .lower_txp = ~0u,
      .lower_rect = true,
      .lower_tg4_offsets = true,
      .lower_txb_shadow_clamp = true,
      .lower_index_to_offset = false,
   };
   NIR_PASS(_, nir, nir_lower_tex, &tex);

   /* Buffers and storage images of arrays indexed dynamically, chosen from (before explicit I/O: their deref chains
    * name their arrays). */
   NIR_PASS(_, nir, nir_opt_constant_folding);
   for (bool more = true; more;) {
      more = false;
      NIR_PASS(more, nir, nir_shader_intrinsics_pass, lower_dynamic_access_index, nir_metadata_none, (void *)layout);
   }
   NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_push_const, nir_address_format_32bit_offset);
   NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_ubo | nir_var_mem_ssbo, nir_address_format_32bit_index_offset);
   if (nir->info.stage == MESA_SHADER_COMPUTE) {
      if (!nir->info.shared_memory_explicit_layout) {
         nir->info.shared_size = 0;
         NIR_PASS(_, nir, nir_lower_vars_to_explicit_types, nir_var_mem_shared, shared_var_info);
      }
      NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_shared, nir_address_format_32bit_offset);
   }
   NIR_PASS(_, nir, nir_lower_vars_to_explicit_types, nir_var_function_temp, glsl_get_natural_size_align_bytes);
   NIR_PASS(_, nir, nir_lower_io, nir_var_shader_in | nir_var_shader_out, type_size_vec4,
            nir_lower_io_lower_64bit_to_32 | nir_lower_io_use_interpolated_input_intrinsics);
   /* Transform feedback's outputs (the runtime gathered nir->xfb_info from the variables): on the stores, which keeps
    * them through linking (nir_opt_varyings) and tells the printer what each captures (VK3 L7.4). */
   if (nir->xfb_info && nir->info.stage == MESA_SHADER_VERTEX) {
      /* Each store at its own slot first (constant folding moves an array's or matrix's offset into its location),
       * which the pass matches the outputs by. */
      NIR_PASS(_, nir, nir_opt_constant_folding);
      NIR_PASS(_, nir, nir_io_add_intrinsic_xfb_info);
   }
   NIR_PASS(_, nir, nir_opt_dce);
   NIR_PASS(_, nir, nir_lower_variable_initializers, ~nir_var_function_temp);
   NIR_PASS(_, nir, nir_remove_dead_variables, nir_var_shader_in | nir_var_shader_out | nir_var_system_value, NULL);
   nir->info.io_lowered = true;
   if (nir->info.stage == MESA_SHADER_VERTEX)
      NIR_PASS(_, nir, nir_shader_intrinsics_pass, remove_unsupported_outputs, nir_metadata_control_flow, NULL);

   NIR_PASS(_, nir, nir_lower_system_values);
   const nir_lower_compute_system_values_options csv2 = { 0 };
   NIR_PASS(_, nir, nir_lower_compute_system_values, &csv2);
   NIR_PASS(_, nir, nir_lower_global_vars_to_local);
   NIR_PASS(_, nir, nir_lower_int64);
   lower_subgroups(nir, subgroup_size);
   optimize(nir);

   /* Descriptors once their indices are constants (an array of textures indexed dynamically chosen from). */
   for (bool more = true; more;) {
      more = false;
      NIR_PASS(more, nir, nir_shader_tex_pass, lower_dynamic_tex_index, nir_metadata_none, NULL);
   }
   NIR_PASS(_, nir, nir_shader_instructions_pass, lower_descriptors_instr, nir_metadata_control_flow, &s);
   if (s.failed)
      return false;
   NIR_PASS(_, nir, nir_remove_dead_variables, nir_var_uniform | nir_var_image, NULL);
   lower_16bit(nir);
   optimize(nir);
   NIR_PASS(_, nir, nir_shader_intrinsics_pass, lower_ubo_storage, nir_metadata_control_flow, (void *)layout);
   return true;
}

void
wgsl_link(nir_shader *vs, nir_shader *fs)
{
   nir_shader *shaders[2] = { vs, fs };
   nir_opt_varyings_bulk(shaders, 2, true, 0, 0, optimize_cb, NULL);
}

/* Out of SSA, as msl_optimize_nir ends: the printer's input. */
void wgsl_finish(nir_shader *nir);
void
wgsl_finish(nir_shader *nir)
{
   optimize(nir);
   /* The optimizations may fold 16-bit integer operations back. */
   lower_16bit(nir);
   NIR_PASS(_, nir, nir_opt_shrink_stores, false);
   NIR_PASS(_, nir, nir_lower_load_const_to_scalar);
   NIR_PASS(_, nir, nir_convert_from_ssa, true, false);
   NIR_PASS(_, nir, nir_trivialize_registers);
   NIR_PASS(_, nir, nir_opt_copy_prop);
   NIR_PASS(_, nir, nir_opt_dce);
   nir_shader_gather_info(nir, nir_shader_get_entrypoint(nir));
}
