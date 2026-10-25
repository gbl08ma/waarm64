/*
 * VK1 step 1 (bench/vulkan/REPORT.md "VK1"): route (b)'s shader path on one SPIR-V stage, as a translator would run
 * it: spirv_to_nir, the NIR passes (KosmicKrisp's preprocessing, I/O and explicit-memory lowering and optimization
 * loop, as its kosmicomp tool runs them, plus the generic lowerings VK0's D found naga's chain lacking: input
 * attachments, scratch), then nir_to_msl as the stand-in for a NIR -> WGSL backend. Each phase timed.
 * Built for wasm (a reactor: spike_* exported, run.ts and page.ts drive it) and natively (main: files on argv).
 * The pass list follows src/kosmickrisp/kosmicomp.c and vulkan/kk_shader.c (Mesa 26.2.4, MIT); our own code.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "compiler/nir_to_msl.h"
#include "nir.h"
#include "nir_builder.h"
#include "spirv/nir_spirv.h"
#include "util/memstream.h"
#include "util/ralloc.h"

#define EXPORT __attribute__((visibility("default")))

static char *result;
static size_t result_len;
static uint64_t phase_ns[4];
static char error[512];

static uint64_t
now_ns(void)
{
   struct timespec t;
   clock_gettime(CLOCK_MONOTONIC, &t);
   return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}

static void
debug_callback(void *priv, enum nir_spirv_debug_level level, size_t offset, const char *message)
{
   if (level >= NIR_SPIRV_DEBUG_LEVEL_ERROR)
      snprintf(error, sizeof(error), "at %zu: %s", offset, message);
}

static unsigned
type_size_vec4(const struct glsl_type *type, bool bindless)
{
   return glsl_count_attribute_slots(type, false);
}

static void
shared_var_info(const struct glsl_type *type, unsigned *size, unsigned *align)
{
   uint32_t comp_size = glsl_type_is_boolean(type) ? 4 : glsl_get_bit_size(type) / 8;
   unsigned length = glsl_get_vector_elements(type);
   *size = comp_size * length, *align = comp_size;
}

/* Descriptors as a backend sees them, in place of KosmicKrisp's driver passes (kk_nir_lower_descriptors, which need
 * its set layouts): every (set, binding) owns an 8-byte slot of a table at a constant address, as a binding map
 * would; a buffer's descriptor is the address loaded from its slot, a texture's or image's handle is loaded through
 * its slot, a sampler's handle is its binding. */
static nir_def *
slot_addr(nir_builder *b, unsigned set, unsigned binding, nir_def *index)
{
   nir_def *base = nir_imm_int64(b, 0x100000000ull + ((uint64_t)set << 16 | binding) * 8 * 64);
   return index ? nir_iadd(b, base, nir_u2u64(b, nir_imul_imm(b, index, 8))) : base;
}

static nir_def *
deref_slot(nir_builder *b, nir_deref_instr *deref)
{
   nir_def *index = NULL;
   if (deref->deref_type == nir_deref_type_array) {
      index = deref->arr.index.ssa;
      deref = nir_deref_instr_parent(deref);
   }
   nir_variable *var = nir_deref_instr_get_variable(deref);
   return slot_addr(b, var->data.descriptor_set, var->data.binding, index);
}

static bool
lower_descriptors_instr(nir_builder *b, nir_instr *instr, void *data)
{
   b->cursor = nir_before_instr(instr);
   if (instr->type == nir_instr_type_tex) {
      nir_tex_instr *tex = nir_instr_as_tex(instr);
      nir_def *texture = nir_steal_tex_src(tex, nir_tex_src_texture_deref);
      nir_def *sampler = nir_steal_tex_src(tex, nir_tex_src_sampler_deref);
      if (!texture)
         return false;
      nir_def *addr = deref_slot(b, nir_def_as_deref(texture));
      nir_def *handle = tex->is_shadow
         ? nir_load_depth_texture_kk(b, 1, 64, addr, .image_dim = tex->sampler_dim, .image_array = tex->is_array)
         : nir_load_texture_handle_kk(b, 1, 64, addr, .dest_type = tex->dest_type, .image_dim = tex->sampler_dim,
                                      .image_array = tex->is_array);
      nir_tex_instr_add_src(tex, nir_tex_src_texture_handle, handle);
      if (sampler) {
         nir_variable *var = nir_deref_instr_get_variable(nir_def_as_deref(sampler));
         nir_tex_instr_add_src(tex, nir_tex_src_sampler_handle,
                               nir_load_sampler_handle_kk(b, nir_imm_intN_t(b, var->data.binding, 16)));
      }
      return true;
   }
   if (instr->type != nir_instr_type_intrinsic)
      return false;
   nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
   switch (intr->intrinsic) {
   case nir_intrinsic_load_vulkan_descriptor: {
      nir_intrinsic_instr *idx = nir_src_as_intrinsic(intr->src[0]);
      if (!idx || idx->intrinsic != nir_intrinsic_vulkan_resource_index)
         return false;
      nir_def *addr = slot_addr(b, nir_intrinsic_desc_set(idx), nir_intrinsic_binding(idx), idx->src[0].ssa);
      nir_def_replace(&intr->def, nir_load_global_constant(b, 1, 64, addr));
      return true;
   }
   case nir_intrinsic_image_deref_load:
   case nir_intrinsic_image_deref_sparse_load:
   case nir_intrinsic_image_deref_store:
   case nir_intrinsic_image_deref_atomic:
   case nir_intrinsic_image_deref_atomic_swap:
   case nir_intrinsic_image_deref_size:
   case nir_intrinsic_image_deref_samples: {
      nir_deref_instr *deref = nir_src_as_deref(intr->src[0]);
      nir_alu_type type = nir_intrinsic_has_dest_type(intr) ? nir_intrinsic_dest_type(intr)
                        : nir_intrinsic_has_src_type(intr) ? nir_intrinsic_src_type(intr)
                                                            : nir_type_uint32;
      nir_def *handle = nir_load_texture_handle_kk(b, 1, 64, deref_slot(b, deref), .dest_type = type,
                                                   .image_dim = nir_intrinsic_image_dim(intr),
                                                   .image_array = nir_intrinsic_image_array(intr),
                                                   .access = nir_intrinsic_access(intr));
      nir_rewrite_image_intrinsic(intr, handle, nir_image_intrinsic_type_bindless);
      return true;
   }
   default:
      return false;
   }
}

/* Input attachments' subpass dims as 2D textures (kk_shader.c's lower_subpass_dim). */
static bool
lower_subpass_dim(nir_builder *b, nir_tex_instr *tex, void *data)
{
   if (tex->sampler_dim == GLSL_SAMPLER_DIM_SUBPASS)
      tex->sampler_dim = GLSL_SAMPLER_DIM_2D;
   else if (tex->sampler_dim == GLSL_SAMPLER_DIM_SUBPASS_MS)
      tex->sampler_dim = GLSL_SAMPLER_DIM_MS;
   else
      return false;
   return true;
}

static void
lower(nir_shader *nir)
{
   nir_shader_gather_info(nir, nir_shader_get_entrypoint(nir));
   NIR_PASS(_, nir, nir_lower_io_vars_to_temporaries, nir_shader_get_entrypoint(nir), nir_var_shader_out);
   msl_preprocess_nir(nir);
   msl_preprocess_nir_workarounds(nir, 0);
   nir_lower_compute_system_values_options csv = {
      .has_base_global_invocation_id = 0,
      .has_base_workgroup_id = true,
   };
   NIR_PASS(_, nir, nir_lower_compute_system_values, &csv);

   const nir_opt_access_options access = {.is_vulkan = true};
   NIR_PASS(_, nir, nir_opt_access, &access);
   if (nir->info.stage == MESA_SHADER_FRAGMENT) {
      /* Input attachments read as textures at the fragment's coordinate (VK0 D: vkQuake's 10). */
      const nir_input_attachment_options ia = {0};
      NIR_PASS(_, nir, nir_lower_input_attachments, &ia);
      NIR_PASS(_, nir, nir_shader_tex_pass, lower_subpass_dim, nir_metadata_all, NULL);
   }
   NIR_PASS(_, nir, nir_lower_vars_to_scratch, 0, glsl_get_natural_size_align_bytes,
            glsl_get_natural_size_align_bytes);
   NIR_PASS(_, nir, msl_lower_textures);
   NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_push_const, nir_address_format_32bit_offset);
   NIR_PASS(_, nir, nir_lower_memory_model);
   NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_global | nir_var_mem_ubo | nir_var_mem_ssbo,
            nir_address_format_64bit_global);
   if (nir->info.stage == MESA_SHADER_COMPUTE) {
      if (!nir->info.shared_memory_explicit_layout) {
         nir->info.shared_size = 0;
         NIR_PASS(_, nir, nir_lower_vars_to_explicit_types, nir_var_mem_shared, shared_var_info);
      }
      NIR_PASS(_, nir, nir_lower_explicit_io, nir_var_mem_shared, nir_address_format_32bit_offset);
   }
   NIR_PASS(_, nir, nir_lower_io, nir_var_shader_in | nir_var_shader_out, type_size_vec4,
            nir_lower_io_lower_64bit_to_32 | nir_lower_io_use_interpolated_input_intrinsics);
   NIR_PASS(_, nir, nir_opt_dce);
   NIR_PASS(_, nir, nir_lower_variable_initializers, ~nir_var_function_temp);
   NIR_PASS(_, nir, nir_remove_dead_variables, nir_var_shader_in | nir_var_shader_out | nir_var_system_value, NULL);
   nir->info.io_lowered = true;
   NIR_PASS(_, nir, nir_opt_constant_folding);
   if (nir->info.stage == MESA_SHADER_VERTEX) {
      NIR_PASS(_, nir, msl_ensure_vertex_position_output);
      NIR_PASS(_, nir, nir_lower_clip_halfz_dynamic);
      NIR_PASS(_, nir, msl_nir_vs_io_types);
   } else if (nir->info.stage == MESA_SHADER_FRAGMENT) {
      NIR_PASS(_, nir, msl_nir_fs_io_types);
   }
   NIR_PASS(_, nir, nir_shader_instructions_pass, lower_descriptors_instr, nir_metadata_control_flow, NULL);
   NIR_PASS(_, nir, nir_opt_dce);
   nir_lower_compute_system_values_options csv2 = {.has_base_global_invocation_id = 0};
   NIR_PASS(_, nir, nir_lower_system_values);
   NIR_PASS(_, nir, nir_lower_compute_system_values, &csv2);
   NIR_PASS(_, nir, nir_lower_global_vars_to_local);
   NIR_PASS(_, nir, nir_lower_load_const_to_scalar);
   msl_optimize_nir(nir);
}

static const struct nir_shader_compiler_options nir_options = {
   .lower_fdph = 1,
};

EXPORT void
spike_init(void)
{
   glsl_type_singleton_init_or_ref();
}

EXPORT void *
spike_alloc(size_t n)
{
   return malloc(n);
}

EXPORT void
spike_free(void *p)
{
   free(p);
}

/* flags: bit 0 runs nir_to_msl too; bit 1 makes the result the NIR after the passes, printed (to compare builds). Returns 0, or the phase that failed (1 spirv_to_nir, 2 nir_to_msl): the error
 * text is then the result. */
EXPORT int
spike_run(const uint32_t *words, size_t nwords, int stage, int flags)
{
   ralloc_free(result);
   result = NULL;
   result_len = 0;
   error[0] = 0;
   memset(phase_ns, 0, sizeof(phase_ns));

   struct spirv_to_nir_options options = {
      .environment = NIR_SPIRV_VULKAN,
      .debug = {.func = &debug_callback},
      .ubo_addr_format = nir_address_format_64bit_global,
      .ssbo_addr_format = nir_address_format_64bit_global,
      .phys_ssbo_addr_format = nir_address_format_64bit_global,
      .shared_addr_format = nir_address_format_32bit_offset,
   };
   uint64_t t0 = now_ns();
   nir_shader *nir = spirv_to_nir(words, nwords, NULL, (mesa_shader_stage)stage, "main", &options, &nir_options);
   uint64_t t1 = now_ns();
   phase_ns[0] = t1 - t0;
   if (!nir) {
      result = ralloc_strdup(NULL, error[0] ? error : "spirv_to_nir failed");
      result_len = strlen(result);
      return 1;
   }
   lower(nir);
   uint64_t t2 = now_ns();
   phase_ns[1] = t2 - t1;
   if (flags & 2) {
      char *text;
      size_t len;
      struct u_memstream mem;
      if (u_memstream_open(&mem, &text, &len)) {
         nir_print_shader(nir, u_memstream_get(&mem));
         u_memstream_close(&mem);
         result = ralloc_strdup(NULL, text);
         result_len = strlen(result);
         free(text);
      }
   } else if (flags & 1) {
      struct nir_to_msl_options msl = {.mem_ctx = NULL};
      result = nir_to_msl(nir, &msl);
      phase_ns[2] = now_ns() - t2;
      if (!result) {
         ralloc_free(nir);
         result = ralloc_strdup(NULL, "nir_to_msl failed");
         result_len = strlen(result);
         return 2;
      }
      result_len = strlen(result);
   }
   ralloc_free(nir);
   return 0;
}

EXPORT const char *
spike_result(void)
{
   return result;
}

EXPORT size_t
spike_result_len(void)
{
   return result_len;
}

/* The last run's phases in ns: spirv_to_nir, the passes, nir_to_msl. */
EXPORT const uint64_t *
spike_phase_ns(void)
{
   return phase_ns;
}

#ifndef __wasm__
/* The stage from a dump's name, 0x<hash>.<ext>.spv. */
static int
stage_of(const char *name)
{
   static const char *ext[] = {".vert.", ".tesc.", ".tese.", ".geom.", ".frag.", ".comp."};
   for (int i = 0; i < 6; i++)
      if (strstr(name, ext[i]))
         return i;
   return -1;
}

/* Natively: spike <file.spv>... prints one JSON line a file (the runner's input). */
int
main(int argc, char **argv)
{
   spike_init();
   for (int i = 1; i < argc; i++) {
      FILE *f = fopen(argv[i], "rb");
      if (!f)
         continue;
      fseek(f, 0, SEEK_END);
      long n = ftell(f);
      fseek(f, 0, SEEK_SET);
      uint32_t *w = malloc(n);
      fread(w, 1, n, f);
      fclose(f);
      int rc = spike_run(w, n / 4, stage_of(argv[i]), getenv("SPIKE_NIR") ? 2 : 1);
      uint32_t h = 0x811c9dc5;
      for (size_t j = 0; j < result_len; j++)
         h = (h ^ (uint8_t)result[j]) * 0x01000193;
      printf("{\"file\":\"%s\",\"rc\":%d,\"ns\":[%llu,%llu,%llu],\"out\":%zu,\"hash\":%u}\n", argv[i], rc,
             (unsigned long long)phase_ns[0], (unsigned long long)phase_ns[1], (unsigned long long)phase_ns[2],
             result_len, h);
      if (getenv("SPIKE_PRINT") && result)
         fputs(result, stderr);
      fflush(stdout);
      free(w);
   }
   return 0;
}
#endif
