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
#include "spirv/nir_spirv.h"

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
   .lower_pack_half_2x16 = true,
   .lower_unpack_half_2x16 = true,
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
 * gives their coordinate: multiview isn't offered, and WGSL has no multisampled arrays. */
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

/* Descriptors to slots. A buffer's descriptor is vec2(index, 0) with index = set << 16 | WGSL binding; a texture's or
 * sampler's index goes in the tex instruction's texture_index / sampler_index, an image's in its intrinsic's first
 * source, the same way. Array elements must be constants by then (no dynamic indexing is advertised). */
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

/* The WGSL binding of (set, binding)'s first element; -1 if the layout has none. */
static int
slot_binding(struct lower_state *s, unsigned set, unsigned binding)
{
   if (set >= s->layout->set_count || binding >= s->layout->sets[set].binding_count ||
       s->layout->sets[set].first[binding] < 0) {
      fail(s, "a descriptor outside the layout", set, binding);
      return -1;
   }
   return s->layout->sets[set].first[binding] * 2;
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
         const unsigned index = var->data.descriptor_set << 16 | (base + 2 * el + sampler);
         if (sampler)
            tex->sampler_index = index;
         else
            tex->texture_index = index;
         nir_tex_instr_remove_src(tex, i);
         i--;
         progress = true;
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
      nir_def *index = nir_iadd_imm(b, nir_imul_imm(b, intr->src[0].ssa, 2), set << 16 | base);
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
      nir_rewrite_image_intrinsic(intr, nir_imm_int(b, var->data.descriptor_set << 16 | (base + 2 * el)),
                                  nir_image_intrinsic_type_default);
      return true;
   }
   default:
      return false;
   }
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

static void
optimize_cb(nir_shader *nir, void *data)
{
   optimize(nir);
}

bool
wgsl_lower(nir_shader *nir, const struct wgsl_layout *layout, char *error, size_t error_size)
{
   struct lower_state s = { .layout = layout, .error = error, .error_size = error_size };
   error[0] = 0;
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
   optimize(nir);

   /* Descriptors once their indices are constants. */
   NIR_PASS(_, nir, nir_shader_instructions_pass, lower_descriptors_instr, nir_metadata_control_flow, &s);
   if (s.failed)
      return false;
   NIR_PASS(_, nir, nir_remove_dead_variables, nir_var_uniform | nir_var_image, NULL);
   optimize(nir);
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
   NIR_PASS(_, nir, nir_opt_shrink_stores, false);
   NIR_PASS(_, nir, nir_lower_load_const_to_scalar);
   NIR_PASS(_, nir, nir_convert_from_ssa, true, false);
   NIR_PASS(_, nir, nir_trivialize_registers);
   NIR_PASS(_, nir, nir_opt_copy_prop);
   NIR_PASS(_, nir, nir_opt_dce);
   nir_shader_gather_info(nir, nir_shader_get_entrypoint(nir));
}
