/*
 * NIR → WGSL (vk/README.md "The shader path"): the driver's shader compiler, modelled on KosmicKrisp's NIR → MSL
 * (Mesa's src/kosmickrisp/compiler: its pass order, and a backend that prints a high-level language from NIR brought
 * out of SSA). Our own code but where a function says it follows one of Mesa's (MIT).
 *
 * The model: every SSA value and register is a function-scope `var` of u32 (or bool) scalars and vectors, and each
 * operation bitcasts its sources to the types it works on and its result back, so no type inference is needed and
 * no WGSL const-expression can overflow or produce a NaN (constants are vars too). Descriptors become bindings of
 * their own: a Vulkan (set, binding, element) is a slot of its set's layout (`wgsl_layout`), and slot s is WGSL
 * @group(g) @binding(2(base + s)) for the resource, 2(base + s) + 1 for a combined image-sampler's sampler, where the
 * set's layout says its group g and its first slot base there (WebGPU has 4 bind groups; the driver puts sets 3 and
 * up together in group 3). Push constants are immediates, or a uniform buffer at @group(3)
 * @binding(WGSL_PUSH_BINDING) when they're larger than the device's immediates. Varyings are vec4s by location, typed and interpolated as the fragment shader reads them (a vertex
 * shader is printed knowing its fragment shader's inputs: `wgsl_varyings`).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "nir.h"

#define WGSL_MAX_SETS 8
#define WGSL_MAX_GROUPS 4
#define WGSL_MAX_RESOURCES 128
/* Texture-sampler pairs a stage and a program record (a stage with more fails). */
#define WGSL_MAX_PAIRS 128
/* The push constants' uniform buffer's binding in group 3 (WebGPU's bindings stay under 1000). */
#define WGSL_PUSH_BINDING 998
/* A vertex stage's draw parameters (BaseVertex, BaseInstance, DrawIndex: VK3 L7.5) are words of the push buffer at
 * this byte, past Vulkan's 128 bytes of push constants (the device's maxPushConstantsSize): a stage that reads them
 * reads its push constants from the push buffer too, and the driver writes them in each draw's place there. */
#define WGSL_DRAW_PARAMS 128
/* The slots a group's uniform buffers can be read as storage at (wgsl_layout.ubo_storage). */
#define WGSL_UBO_STORAGE_WORDS 8

/* A set layout as the compiler needs it: its bind group and first slot there, each binding's first slot in the set
 * (-1 for none) and element count. */
struct vk_ycbcr_conversion_state;
struct wgsl_set_layout {
   uint32_t group, base;
   uint32_t binding_count;
   const int32_t *first; /* by binding number */
   const uint32_t *count;
   /* YCbCr conversions (VK3 L7.2; NULL tables: none): by slot, a combined image-sampler's immutable sampler's
    * conversion (NULL: none); by binding, the slot its elements' other planes start at (plane p > 0 of element e at
    * slot planes[b] + 2e + p - 1; -1: none). A multi-planar image's planes are textures of their own. */
   const struct vk_ycbcr_conversion_state *const *ycbcr;
   const int32_t *planes;
};

struct wgsl_layout {
   uint32_t set_count;
   struct wgsl_set_layout sets[WGSL_MAX_SETS];
   /* The push constants' size in bytes (0: none). */
   uint32_t push_size;
   /* Uniform buffers read as read-only storage buffers (VK3 L7.4: past WebGPU's uniform buffers a stage, the driver's
    * `fold_uniforms`): by group, a bit for each WGSL slot (binding / 2) there. */
   uint64_t ubo_storage[WGSL_MAX_GROUPS][WGSL_UBO_STORAGE_WORDS];
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
   bool written;          /* storage buffers: the stage writes it (what the driver reads back of host-visible memory;
                           * the kind is the declared access: atomics' are read_write written or not) */
   bool nonfiltering;     /* samplers: bound as non-filtering (the driver's, for unfilterable views) */
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
   uint32_t immediate_size;     /* bytes of push constants read as immediates */
   uint32_t push_ubo_size;      /* or through the uniform buffer (resource @group(3) @binding(WGSL_PUSH_BINDING)) */
   /* Vertex: the attributes read (by location) and their WGSL types; fragment: the colour outputs written. */
   uint32_t inputs;
   uint8_t input_base[32];
   uint32_t outputs;
   uint8_t output_base[8];
   bool writes_depth, writes_sample_mask, discards;
   bool per_sample;             /* fragment: at the sample rate, declares `override wg_samples` (the pipeline's) */
   bool dual_source;            /* fragment: location 0's second output (index 1) written: @blend_src */
   uint8_t dual_base;           /* its WGSL type */
   bool clip_distances;         /* uses `clip_distances` (vertex) */
   uint8_t clip_distance_count;
   uint16_t workgroup[3];
   /* Vertex, with transform feedback (VK3 L7.4): each captured vertex's words in `wg_xo` (a private array the outputs
    * are copied into, wg_vs's), buffer b's record from word xfb_base[b], its stride xfb_stride[b] bytes (0: not
    * captured) and the words of it written (xfb_words[b], a bit a word): the driver's compute pass writes them. */
   uint16_t xfb_stride[4], xfb_base[4];
   uint32_t xfb_words[4][4];
   struct wgsl_varyings varyings; /* fragment: what it reads; vertex: what it writes */
   /* The textures sampled with each sampler, as (texture, sampler) pairs of group << 16 | binding. */
   uint32_t pair_count;
   uint32_t pairs[WGSL_MAX_PAIRS][2];
   /* Integer textures' likewise, which WGSL fetches: their samplers aren't bindings, and only a key sees them. */
   uint32_t int_pair_count;
   uint32_t int_pairs[WGSL_MAX_PAIRS][2];
};

/* VkSamplerAddressMode's order. */
enum wgsl_address { WGSL_ADDRESS_REPEAT, WGSL_ADDRESS_MIRROR, WGSL_ADDRESS_EDGE, WGSL_ADDRESS_BORDER, WGSL_ADDRESS_MIRROR_ONCE };

/* What a sampler and its view make of a (texture, sampler) pair that WebGPU's sampler can't do (wgsl_sampler.c): a
 * variant's stages are printed against a list of these (wgsl_print_options.keys). Zeroed whole: variants compare them
 * as bytes. */
struct wgsl_sampler_key {
   uint32_t texture, sampler;      /* as wgsl_info.pairs */
   uint8_t address[3];             /* enum wgsl_address, U, V, W */
   uint8_t mag_linear, min_linear, mip_linear;
   uint8_t unnormalized;
   uint8_t compare;                /* VkCompareOp */
   uint8_t levels;                 /* the view's (0: asked of the texture) */
   uint8_t padded;                 /* a compressed image larger in its texture (whole blocks): `size` is what it is */
   uint8_t faces;                  /* a padded cube, bound as its faces */
   uint8_t pad;
   float bias, min_lod, max_lod;
   uint32_t border[4];             /* the border as the shader reads it: float bits, or integers on an integer texture */
   uint32_t size[3];               /* padded: the view's first level, as Vulkan has it */
};

/* A key's `sampler` where the texture is what it's about (a padded texture's size queries, whatever samples it). */
#define WGSL_NO_SAMPLER 0xffffffffu

/* The NIR options every stage is compiled with, and spirv_to_nir's. */
const struct nir_shader_compiler_options *wgsl_nir_options(void);
struct spirv_to_nir_options;
void wgsl_spirv_options(struct spirv_to_nir_options *out);

/* After spirv_to_nir: the generic lowering, before anything pipeline-specific (KosmicKrisp's msl_preprocess_nir). */
void wgsl_preprocess(nir_shader *nir);

/* The lowering against a layout: descriptors to slots, I/O to slots, explicit memory, subgroup operations for subgroups
 * of `subgroup_size` (1: of one invocation, without WGSL's subgroups), optimization, out of SSA.
 * Fails (false, with `error`) for what WGSL can't express (descriptors reached through pointers, 64-bit values). */
bool wgsl_lower(nir_shader *nir, const struct wgsl_layout *layout, unsigned subgroup_size, char *error,
                size_t error_size);

/* Before wgsl_lower: sampling through an immutable sampler with a YCbCr conversion as one sample of each plane and
 * the conversion's swizzle, range and model (Mesa's nir_vk_lower_ycbcr_tex, implicit chroma reconstruction: a cosited
 * chroma sample's coordinate moved half a chroma texel, the plane's sampler filtering it). */
bool wgsl_lower_ycbcr(nir_shader *nir, const struct wgsl_layout *layout); /* wgsl_lower runs it first */

/* Links a vertex and a fragment shader's varyings (both lowered): nir_opt_varyings, as KosmicKrisp links. */
void wgsl_link(nir_shader *vs, nir_shader *fs);

#define WGSL_TIER2       (1u << 0) /* texture-formats-tier2 */
#define WGSL_DUAL_SOURCE (1u << 1) /* dual-source-blending */
#define WGSL_SUBGROUPS   (1u << 2) /* subgroups (as wgsl_lower's subgroup_size over 1) */
#define WGSL_F16         (1u << 3) /* shader-f16 */

/* What a stage is printed for besides itself. */
struct wgsl_print_options {
   /* Vertex: its fragment shader's inputs, which its outputs follow (NULL: as written). */
   const struct wgsl_varyings *fs;
   /* Push constants past these bytes are read from the uniform buffer. */
   uint32_t max_immediates;
   /* WebGPU's maxComputeWorkgroupStorageSize: what shared memory and the translator's own workgroup word may take. */
   uint32_t max_workgroup_storage;
   /* WebGPU's maxUniformBufferBindingSize: a uniform block's declared bytes at most (0: 65536). */
   uint32_t max_uniform_size;
   /* The device's WGSL_* (WGSL_TIER2: read-write storage images of more formats; WGSL_DUAL_SOURCE: @blend_src). */
   unsigned features;
   /* What a variant's samplers need of the shader (none: the stage's own module). */
   const struct wgsl_sampler_key *keys;
   uint32_t key_count;
};

/* Prints a lowered shader. Returns ralloc'd text owned by `mem_ctx`, or NULL with `error`. */
char *wgsl_print(void *mem_ctx, nir_shader *nir, const struct wgsl_print_options *options, struct wgsl_info *info,
                 char *error, size_t error_size);

/* wgsl_print's first step: sampling as the keys say, and integer textures' fetches (recorded in info->int_pairs). False
 * for what it can't do (a gather of an integer cube that is also sampled: the one binding can't be both). */
bool wgsl_lower_samplers(nir_shader *nir, const struct wgsl_sampler_key *keys, uint32_t key_count, struct wgsl_info *info);

/* The test entry points (wgsl_test.c, exported from the renderer module for tests/wgsl.test.ts). */
void wgsl_test_init(void);
void wgsl_test_device(unsigned features, unsigned subgroup_size);
void wgsl_test_ycbcr(int set, unsigned binding, unsigned format, unsigned model, unsigned range, unsigned x_offset,
                     unsigned y_offset, unsigned filter);
void wgsl_test_sampler(unsigned u, unsigned v, unsigned w, unsigned flags, unsigned compare, unsigned levels, float bias,
                       float min_lod, float max_lod, uint32_t b0, uint32_t b1, uint32_t b2, uint32_t b3, uint32_t sx, uint32_t sy);
int wgsl_test_translate(const uint32_t *words, size_t nwords, int stage);
const char *wgsl_test_result(void);
uint32_t wgsl_test_kept(void);
const struct wgsl_info *wgsl_test_info(void);
