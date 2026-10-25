/*
 * NIR → WGSL (vk/README.md "The shader path"): the driver's shader compiler, modelled on KosmicKrisp's NIR → MSL
 * (Mesa's src/kosmickrisp/compiler: its pass order, and a backend that prints a high-level language from NIR brought
 * out of SSA). Our own code but where a function says it follows one of Mesa's (MIT).
 *
 * The model: every SSA value and register is a function-scope `var` of u32 (or bool) scalars and vectors, and each
 * operation bitcasts its sources to the types it works on and its result back, so no type inference is needed and
 * no WGSL const-expression can overflow or produce a NaN (constants are vars too). Descriptors become bindings of
 * their own: a Vulkan (set, binding, element) is a slot of its set's layout (`wgsl_layout`), and slot s is WGSL
 * @group(set) @binding(2s) for the resource, 2s + 1 for a combined image-sampler's sampler. Push constants are
 * immediates. Varyings are vec4s by location, typed and interpolated as the fragment shader reads them (a vertex
 * shader is printed knowing its fragment shader's inputs: `wgsl_varyings`).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "nir.h"

#define WGSL_MAX_SETS 4
#define WGSL_MAX_RESOURCES 128

/* A set layout as the compiler needs it: each binding's first slot (-1 for none) and element count. */
struct wgsl_set_layout {
   uint32_t binding_count;
   const int32_t *first; /* by binding number */
   const uint32_t *count;
};

struct wgsl_layout {
   uint32_t set_count;
   struct wgsl_set_layout sets[WGSL_MAX_SETS];
   /* The push constants' size in bytes (0: none), read through immediates. */
   uint32_t push_size;
};

enum wgsl_resource_kind {
   WGSL_UNIFORM,
   WGSL_STORAGE,          /* read_write */
   WGSL_STORAGE_READ,
   WGSL_SAMPLER,
   WGSL_SAMPLER_COMPARE,
   WGSL_TEXTURE,
   WGSL_STORAGE_TEXTURE,
};

/* WebGPU's texture view dimensions, as GPUTextureViewDimension's order. */
enum wgsl_dim { WGSL_DIM_1D, WGSL_DIM_2D, WGSL_DIM_2D_ARRAY, WGSL_DIM_CUBE, WGSL_DIM_CUBE_ARRAY, WGSL_DIM_3D };

/* GPUTextureSampleType's. */
enum wgsl_sample { WGSL_SAMPLE_FLOAT, WGSL_SAMPLE_UNFILTERABLE, WGSL_SAMPLE_DEPTH, WGSL_SAMPLE_SINT, WGSL_SAMPLE_UINT };

enum wgsl_access { WGSL_ACCESS_READ = 1, WGSL_ACCESS_WRITE = 2 };

/* A binding the shader declares (its bind group layout entry, with the other stages' merged by the driver). */
struct wgsl_resource {
   uint8_t group;
   uint16_t binding;
   uint8_t kind;          /* enum wgsl_resource_kind */
   uint8_t dim;           /* textures */
   uint8_t sample;        /* textures: enum wgsl_sample */
   bool multisampled;
   bool atomic;           /* storage buffers: declared of atomics */
   uint8_t access;        /* storage textures */
   uint16_t format;       /* storage textures: enum pipe_format */
   uint32_t size;         /* uniform buffers: the bytes declared */
};

/* What a fragment shader reads at each varying location, for its vertex shader's outputs. */
enum wgsl_interp { WGSL_INTERP_PERSPECTIVE, WGSL_INTERP_LINEAR, WGSL_INTERP_FLAT };
enum wgsl_sampling { WGSL_SAMPLING_CENTER, WGSL_SAMPLING_CENTROID, WGSL_SAMPLING_SAMPLE };
enum wgsl_base { WGSL_F32, WGSL_I32, WGSL_U32 };

struct wgsl_varyings {
   uint32_t mask;            /* locations (VARYING_SLOT_VAR0 + n) */
   uint8_t interp[32];
   uint8_t sampling[32];
   uint8_t base[32];
};

/* What the driver needs of a compiled stage. */
struct wgsl_info {
   uint32_t resource_count;
   struct wgsl_resource resources[WGSL_MAX_RESOURCES];
   uint32_t immediate_size;     /* bytes of push constants read */
   /* Vertex: the attributes read (by location) and their WGSL types; fragment: the colour outputs written. */
   uint32_t inputs;
   uint8_t input_base[32];
   uint32_t outputs;
   uint8_t output_base[8];
   bool writes_depth, writes_sample_mask, discards;
   bool clip_distances;         /* uses `clip_distances` (vertex) */
   uint8_t clip_distance_count;
   uint16_t workgroup[3];
   struct wgsl_varyings varyings; /* fragment: what it reads; vertex: what it writes */
};

/* The NIR options every stage is compiled with, and spirv_to_nir's. */
const struct nir_shader_compiler_options *wgsl_nir_options(void);
struct spirv_to_nir_options;
void wgsl_spirv_options(struct spirv_to_nir_options *out);

/* After spirv_to_nir: the generic lowering, before anything pipeline-specific (KosmicKrisp's msl_preprocess_nir). */
void wgsl_preprocess(nir_shader *nir);

/* The lowering against a layout: descriptors to slots, I/O to slots, explicit memory, optimization, out of SSA.
 * Fails (false, with `error`) for what WGSL can't express (dynamically indexed descriptors, 64-bit values). */
bool wgsl_lower(nir_shader *nir, const struct wgsl_layout *layout, char *error, size_t error_size);

/* Links a vertex and a fragment shader's varyings (both lowered): nir_opt_varyings, as KosmicKrisp links. */
void wgsl_link(nir_shader *vs, nir_shader *fs);

/* Prints a lowered shader; a vertex shader's outputs follow `fs` (its fragment shader's inputs; NULL: as written).
 * Returns ralloc'd text owned by `mem_ctx`, or NULL with `error`. */
char *wgsl_print(void *mem_ctx, nir_shader *nir, const struct wgsl_varyings *fs, struct wgsl_info *info, char *error,
                 size_t error_size);

/* The test entry points (wgsl_test.c, exported from the renderer module for tests/wgsl.test.ts). */
void wgsl_test_init(void);
int wgsl_test_translate(const uint32_t *words, size_t nwords, int stage);
const char *wgsl_test_result(void);
const struct wgsl_info *wgsl_test_info(void);
