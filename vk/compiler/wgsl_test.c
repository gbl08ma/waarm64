/*
 * The translator on one SPIR-V stage, for its unit tests (tests/wgsl.test.ts): spirv_to_nir, the backend's passes
 * against a layout made from the shader's own descriptors (each set's bindings in order, an array's elements
 * consecutive: what a pipeline layout of the same bindings gives), and the WGSL. Exported from the renderer module.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "nir.h"
#include "spirv/nir_spirv.h"
#include "util/ralloc.h"

#include "wgsl.h"

#define EXPORT __attribute__((visibility("default")))

static char *result;
static struct wgsl_info info;
static char error[512];

static void
debug_callback(void *priv, enum nir_spirv_debug_level level, size_t offset, const char *message)
{
   if (level >= NIR_SPIRV_DEBUG_LEVEL_ERROR && !error[0])
      snprintf(error, sizeof(error), "spirv_to_nir at %zu: %s", offset, message);
}

#define MAX_BINDINGS 64
static int32_t firsts[WGSL_MAX_SETS][MAX_BINDINGS];
static uint32_t counts[WGSL_MAX_SETS][MAX_BINDINGS];

static void
layout_of(nir_shader *nir, struct wgsl_layout *layout)
{
   memset(firsts, 0xff, sizeof(firsts));
   memset(counts, 0, sizeof(counts));
   *layout = (struct wgsl_layout){ .set_count = WGSL_MAX_SETS };
   nir_foreach_variable_with_modes(var, nir, nir_var_mem_ubo | nir_var_mem_ssbo | nir_var_uniform | nir_var_image) {
      const unsigned set = var->data.descriptor_set, binding = var->data.binding;
      if (set >= WGSL_MAX_SETS || binding >= MAX_BINDINGS)
         continue;
      const unsigned n = glsl_type_is_array(var->type) ? glsl_get_aoa_size(var->type) : 1;
      counts[set][binding] = MAX2(counts[set][binding], MAX2(n, 1));
   }
   for (unsigned s = 0; s < WGSL_MAX_SETS; s++) {
      int32_t slot = 0;
      for (unsigned b = 0; b < MAX_BINDINGS; b++) {
         if (!counts[s][b])
            continue;
         firsts[s][b] = slot;
         slot += counts[s][b];
      }
      layout->sets[s] = (struct wgsl_set_layout){ .binding_count = MAX_BINDINGS, .first = firsts[s], .count = counts[s] };
   }
}

EXPORT void
wgsl_test_init(void)
{
   glsl_type_singleton_init_or_ref();
}

/* Translates a stage (0 vertex, 4 fragment, 5 compute: mesa_shader_stage): 0, or the phase that failed (1
 * spirv_to_nir, 2 the lowering, 3 printing), with the error as the result. */
EXPORT int
wgsl_test_translate(const uint32_t *words, size_t nwords, int stage)
{
   ralloc_free(result);
   result = NULL;
   error[0] = 0;
   struct spirv_to_nir_options options;
   wgsl_spirv_options(&options);
   options.debug.func = debug_callback;
   nir_shader *nir = spirv_to_nir(words, nwords, NULL, (mesa_shader_stage)stage, "main", &options, wgsl_nir_options());
   if (!nir) {
      result = ralloc_strdup(NULL, error[0] ? error : "spirv_to_nir failed");
      return 1;
   }
   wgsl_preprocess(nir);
   struct wgsl_layout layout;
   layout_of(nir, &layout);
   if (!wgsl_lower(nir, &layout, error, sizeof(error))) {
      result = ralloc_strdup(NULL, error);
      ralloc_free(nir);
      return 2;
   }
   char *text = wgsl_print(NULL, nir, NULL, &info, error, sizeof(error));
   ralloc_free(nir);
   if (!text) {
      result = ralloc_strdup(NULL, error);
      return 3;
   }
   result = text;
   return 0;
}

EXPORT const char *
wgsl_test_result(void)
{
   return result ? result : "";
}

EXPORT const struct wgsl_info *
wgsl_test_info(void)
{
   return &info;
}

#ifndef __wasm__
/* Natively (vk/build.sh native): wgsl <stage> <file.spv> prints the WGSL, or the error and exits 1. */
int
main(int argc, char **argv)
{
   if (argc < 3)
      return 2;
   wgsl_test_init();
   FILE *f = fopen(argv[2], "rb");
   if (!f)
      return 2;
   fseek(f, 0, SEEK_END);
   long n = ftell(f);
   fseek(f, 0, SEEK_SET);
   uint32_t *w = malloc(n);
   if (fread(w, 1, n, f) != (size_t)n)
      return 2;
   fclose(f);
   const int rc = wgsl_test_translate(w, n / 4, atoi(argv[1]));
   fputs(wgsl_test_result(), rc ? stderr : stdout);
   return rc ? 1 : 0;
}
#endif
