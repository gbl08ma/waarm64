/*
 * The driver's "hardware": WebGPU in the GPU worker, through the module's imports (web/venus-gpu.ts implements them).
 * Every WebGPU object is named by an id the driver assigns (wg_id), so no call returns an object across the boundary.
 * Rarely made objects (textures, views, samplers, layouts, pipelines, bind groups) are described as JSON, with other
 * objects named by their ids; the commands of a submit's replay are calls with plain numbers.
 *
 * A submit: gpu_encoder(), the commands, the readbacks of what the GPU wrote to host-visible memory (gpu_readback),
 * gpu_submit(serial). Once that work is done and its readbacks are mapped, the worker calls the export
 * wg_complete(serial), which copies them out (gpu_readback_copy) and signals the submit's syncs.
 */
#pragma once

#include <stdint.h>

#define WG_IMPORT(name) __attribute__((import_module("wg"), import_name(#name)))

/* What gpu_create makes from its JSON. */
enum wg_kind {
   WG_KIND_BUFFER,         /* {size, usage} */
   WG_KIND_TEXTURE,        /* GPUTextureDescriptor */
   WG_KIND_VIEW,           /* {texture, ...GPUTextureViewDescriptor} */
   WG_KIND_SAMPLER,        /* GPUSamplerDescriptor */
   WG_KIND_BGL,            /* {entries} */
   WG_KIND_LAYOUT,         /* {bindGroupLayouts: [ids], immediateSize} */
   WG_KIND_RENDER,         /* GPURenderPipelineDescriptor with ids for the layout and modules */
   WG_KIND_COMPUTE,        /* GPUComputePipelineDescriptor, likewise */
   WG_KIND_BIND_GROUP,     /* {layout, entries: [{binding, buffer, offset, size} | {binding, view} | {binding, sampler}]} */
   WG_KIND_QUERY_SET,      /* {type, count} */
};

/* Objects. */
WG_IMPORT(gpu_create) void gpu_create(uint32_t kind, uint32_t id, const char *json, uint32_t len);
WG_IMPORT(gpu_shader) void gpu_shader(uint32_t id, const char *code, uint32_t len);
WG_IMPORT(gpu_destroy) void gpu_destroy(uint32_t id);
/* queue.writeBuffer from memory 0 (ordered before the next gpu_submit). */
WG_IMPORT(gpu_write) void gpu_write(uint32_t buffer, double offset, const void *data, uint32_t size);

/* A texture's bytes are another renderer's resource's (an image bound to memory imported from a dma-buf: a virgl
 * texture, e.g. a VA-API surface's plane): the worker writes them into it now and whenever the resource changes, in the
 * queue's order. Resource 0 forgets the texture's. */
WG_IMPORT(gpu_texture_import) void gpu_texture_import(uint32_t texture, uint32_t resource);

/* A submit's commands, in an encoder of their own. */
WG_IMPORT(gpu_encoder) void gpu_encoder(void);
WG_IMPORT(gpu_copy_bb) void gpu_copy_bb(uint32_t src, double src_offset, uint32_t dst, double dst_offset, double size);
/* Buffer ↔ texture: rows `bpr` bytes apart (a multiple of 256, or any for one row), `rows` rows an image; aspect 0 all,
 * 1 depth, 2 stencil. */
WG_IMPORT(gpu_copy_bt) void gpu_copy_bt(uint32_t buffer, double offset, uint32_t bpr, uint32_t rows, uint32_t texture,
                                        uint32_t mip, uint32_t x, uint32_t y, uint32_t z, uint32_t w, uint32_t h,
                                        uint32_t d, uint32_t aspect);
WG_IMPORT(gpu_copy_tb) void gpu_copy_tb(uint32_t buffer, double offset, uint32_t bpr, uint32_t rows, uint32_t texture,
                                        uint32_t mip, uint32_t x, uint32_t y, uint32_t z, uint32_t w, uint32_t h,
                                        uint32_t d, uint32_t aspect);
WG_IMPORT(gpu_copy_tt) void gpu_copy_tt(uint32_t src, uint32_t src_mip, uint32_t sx, uint32_t sy, uint32_t sz,
                                        uint32_t dst, uint32_t dst_mip, uint32_t dx, uint32_t dy, uint32_t dz,
                                        uint32_t w, uint32_t h, uint32_t d, uint32_t aspect);
/* A buffer's range filled with a 32-bit value, or written with bytes from memory 0, in the encoder's order. */
WG_IMPORT(gpu_fill) void gpu_fill(uint32_t buffer, double offset, double size, uint32_t value);
WG_IMPORT(gpu_update) void gpu_update(uint32_t buffer, double offset, const void *data, uint32_t size);
/* Draws `src`'s view into `dst`'s (a render pass of its own): JSON {src, dst, format, filter, from: [x0,y0,x1,y1],
 * to: [x0,y0,x1,y1], width, height}; the destination's other pixels are kept. */
WG_IMPORT(gpu_blit) void gpu_blit(const char *json, uint32_t len);

/* A render pass: GPURenderPassDescriptor's JSON with views by id; ends with gpu_pass_end. */
WG_IMPORT(gpu_render_pass) void gpu_render_pass(const char *json, uint32_t len);
WG_IMPORT(gpu_compute_pass) void gpu_compute_pass(void);
WG_IMPORT(gpu_pass_end) void gpu_pass_end(void);
WG_IMPORT(gpu_set_pipeline) void gpu_set_pipeline(uint32_t id);
WG_IMPORT(gpu_set_bind_group) void gpu_set_bind_group(uint32_t index, uint32_t id, const uint32_t *offsets, uint32_t n);
WG_IMPORT(gpu_set_vertex_buffer) void gpu_set_vertex_buffer(uint32_t slot, uint32_t buffer, double offset, double size);
WG_IMPORT(gpu_set_index_buffer) void gpu_set_index_buffer(uint32_t buffer, uint32_t wide, double offset, double size);
WG_IMPORT(gpu_set_viewport) void gpu_set_viewport(float x, float y, float w, float h, float min, float max);
WG_IMPORT(gpu_set_scissor) void gpu_set_scissor(uint32_t x, uint32_t y, uint32_t w, uint32_t h);
WG_IMPORT(gpu_set_blend_constant) void gpu_set_blend_constant(float r, float g, float b, float a);
WG_IMPORT(gpu_set_stencil_reference) void gpu_set_stencil_reference(uint32_t ref);
WG_IMPORT(gpu_set_immediates) void gpu_set_immediates(uint32_t offset, const void *data, uint32_t size);
WG_IMPORT(gpu_draw) void gpu_draw(uint32_t vertices, uint32_t instances, uint32_t first, uint32_t first_instance);
WG_IMPORT(gpu_draw_indexed) void gpu_draw_indexed(uint32_t indices, uint32_t instances, uint32_t first, int32_t base,
                                                  uint32_t first_instance);
WG_IMPORT(gpu_draw_indirect) void gpu_draw_indirect(uint32_t buffer, double offset, uint32_t indexed);
WG_IMPORT(gpu_dispatch) void gpu_dispatch(uint32_t x, uint32_t y, uint32_t z);
WG_IMPORT(gpu_dispatch_indirect) void gpu_dispatch_indirect(uint32_t buffer, double offset);
/* Inside a render pass: rectangles of the current attachments cleared (JSON {rects: [[x,y,w,h]], colors: [[i, r,g,b,a]],
 * depth?, stencil?}); the pass's pipeline, bind groups and dynamic state are the driver's to set again after. */
WG_IMPORT(gpu_clear_rects) void gpu_clear_rects(const char *json, uint32_t len);
WG_IMPORT(gpu_begin_occlusion) void gpu_begin_occlusion(uint32_t index);
WG_IMPORT(gpu_end_occlusion) void gpu_end_occlusion(void);
WG_IMPORT(gpu_resolve_queries) void gpu_resolve_queries(uint32_t set, uint32_t first, uint32_t count, uint32_t buffer,
                                                        double offset);

/* A buffer range copied to a staging buffer at this point of the encoder, to be read at completion: its slot. */
WG_IMPORT(gpu_readback) uint32_t gpu_readback(uint32_t buffer, double offset, uint32_t size);
WG_IMPORT(gpu_submit) void gpu_submit(uint32_t serial);
/* The host-visible window's pages the guest wrote since the last call (web/window.ts), by index: how many, or -1 for
 * all of them (more than `max`, or the watch is off). */
WG_IMPORT(gpu_dirty) int32_t gpu_dirty(uint32_t *pages, uint32_t max);
/* At wg_complete: a readback's bytes into memory 0. */
WG_IMPORT(gpu_readback_copy) void gpu_readback_copy(uint32_t slot, void *dst, uint32_t size);

/* The worker's: a submit's work is done (its readbacks mapped). */
void wg_complete(uint32_t serial);

/* Object ids (never 0). */
uint32_t wg_id(void);
void wg_id_release(uint32_t id);
