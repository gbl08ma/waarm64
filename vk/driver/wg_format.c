/*
 * Vulkan's formats as WebGPU's (wg_private.h): each texture format's WebGPU name, block and capabilities (the WebGPU
 * spec's format tables), from which the driver reports format features, and the vertex formats.
 */
#include <string.h>

#include "util/format/u_format.h"
#include "vk_format.h"

#include "wg_private.h"

#define F(vk, name, bytes, bw, bh, flags) { VK_FORMAT_##vk, name, bytes, bw, bh, flags }
#define CS (WG_FMT_COLOR | WG_FMT_SAMPLE)
#define FL (WG_FMT_FILTER)
#define RB (WG_FMT_RENDER | WG_FMT_BLEND)
#define ST (WG_FMT_STORAGE)
#define U (WG_FMT_UINT)
#define S (WG_FMT_SINT)
#define T1R (WG_FMT_T1_RENDER)
#define T1S (WG_FMT_T1_STORAGE)

/* The spec's table; wg_format_init resolves what the adapter's features add into `formats`. */
static const struct wg_texture_format table[] = {
   F(R8_UNORM, "r8unorm", 1, 1, 1, CS | FL | RB | T1S),
   F(R8_SNORM, "r8snorm", 1, 1, 1, CS | FL | T1R | T1S),
   F(R8_UINT, "r8uint", 1, 1, 1, CS | WG_FMT_RENDER | U | T1S),
   F(R8_SINT, "r8sint", 1, 1, 1, CS | WG_FMT_RENDER | S | T1S),
   F(R8G8_UNORM, "rg8unorm", 2, 1, 1, CS | FL | RB | T1S),
   F(R8G8_SNORM, "rg8snorm", 2, 1, 1, CS | FL | T1R | T1S),
   F(R8G8_UINT, "rg8uint", 2, 1, 1, CS | WG_FMT_RENDER | U | T1S),
   F(R8G8_SINT, "rg8sint", 2, 1, 1, CS | WG_FMT_RENDER | S | T1S),
   F(R8G8B8A8_UNORM, "rgba8unorm", 4, 1, 1, CS | FL | RB | ST),
   F(R8G8B8A8_SRGB, "rgba8unorm-srgb", 4, 1, 1, CS | FL | RB),
   F(R8G8B8A8_SNORM, "rgba8snorm", 4, 1, 1, CS | FL | ST | T1R),
   F(R8G8B8A8_UINT, "rgba8uint", 4, 1, 1, CS | WG_FMT_RENDER | U | ST),
   F(R8G8B8A8_SINT, "rgba8sint", 4, 1, 1, CS | WG_FMT_RENDER | S | ST),
   F(B8G8R8A8_UNORM, "bgra8unorm", 4, 1, 1, CS | FL | RB | WG_FMT_BGRA8),
   F(B8G8R8A8_SRGB, "bgra8unorm-srgb", 4, 1, 1, CS | FL | RB),
   F(R16_UINT, "r16uint", 2, 1, 1, CS | WG_FMT_RENDER | U | T1S),
   F(R16_SINT, "r16sint", 2, 1, 1, CS | WG_FMT_RENDER | S | T1S),
   F(R16_SFLOAT, "r16float", 2, 1, 1, CS | FL | RB | T1S),
   F(R16G16_UINT, "rg16uint", 4, 1, 1, CS | WG_FMT_RENDER | U | T1S),
   F(R16G16_SINT, "rg16sint", 4, 1, 1, CS | WG_FMT_RENDER | S | T1S),
   F(R16G16_SFLOAT, "rg16float", 4, 1, 1, CS | FL | RB | T1S),
   /* 16-bit normalized: only with texture-formats-tier1, and unfilterable (Chromium: their sample type is
    * unfilterable-float; libplacebo's LUT was a bind group error when they said linear filtering). */
   F(R16_UNORM, "r16unorm", 2, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16_SNORM, "r16snorm", 2, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16G16_UNORM, "rg16unorm", 4, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16G16_SNORM, "rg16snorm", 4, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16G16B16A16_UNORM, "rgba16unorm", 8, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16G16B16A16_SNORM, "rgba16snorm", 8, 1, 1, CS | T1R | T1S | WG_FMT_TIER1),
   F(R16G16B16A16_UINT, "rgba16uint", 8, 1, 1, CS | WG_FMT_RENDER | U | ST),
   F(R16G16B16A16_SINT, "rgba16sint", 8, 1, 1, CS | WG_FMT_RENDER | S | ST),
   F(R16G16B16A16_SFLOAT, "rgba16float", 8, 1, 1, CS | FL | RB | ST),
   F(R32_UINT, "r32uint", 4, 1, 1, CS | WG_FMT_RENDER | U | ST),
   F(R32_SINT, "r32sint", 4, 1, 1, CS | WG_FMT_RENDER | S | ST),
   F(R32_SFLOAT, "r32float", 4, 1, 1, CS | WG_FMT_RENDER | ST | WG_FMT_FLOAT32),
   F(R32G32_UINT, "rg32uint", 8, 1, 1, CS | WG_FMT_RENDER | U | ST),
   F(R32G32_SINT, "rg32sint", 8, 1, 1, CS | WG_FMT_RENDER | S | ST),
   F(R32G32_SFLOAT, "rg32float", 8, 1, 1, CS | WG_FMT_RENDER | ST | WG_FMT_FLOAT32),
   F(R32G32B32A32_UINT, "rgba32uint", 16, 1, 1, CS | WG_FMT_RENDER | U | ST),
   F(R32G32B32A32_SINT, "rgba32sint", 16, 1, 1, CS | WG_FMT_RENDER | S | ST),
   F(R32G32B32A32_SFLOAT, "rgba32float", 16, 1, 1, CS | WG_FMT_RENDER | ST | WG_FMT_FLOAT32),
   F(A2B10G10R10_UNORM_PACK32, "rgb10a2unorm", 4, 1, 1, CS | FL | RB | T1S),
   F(A2B10G10R10_UINT_PACK32, "rgb10a2uint", 4, 1, 1, CS | WG_FMT_RENDER | U | T1S),
   F(B10G11R11_UFLOAT_PACK32, "rg11b10ufloat", 4, 1, 1, CS | FL | T1R | T1S | WG_FMT_RG11B10),
   F(E5B9G9R9_UFLOAT_PACK32, "rgb9e5ufloat", 4, 1, 1, CS | FL),
   F(S8_UINT, "stencil8", 1, 1, 1, WG_FMT_SAMPLE | WG_FMT_STENCIL),
   F(D16_UNORM, "depth16unorm", 2, 1, 1, WG_FMT_SAMPLE | WG_FMT_DEPTH),
   F(X8_D24_UNORM_PACK32, "depth24plus", 4, 1, 1, WG_FMT_SAMPLE | WG_FMT_DEPTH | WG_FMT_NOCOPY),
   F(D24_UNORM_S8_UINT, "depth24plus-stencil8", 4, 1, 1, WG_FMT_SAMPLE | WG_FMT_DEPTH | WG_FMT_STENCIL | WG_FMT_NOCOPY),
   F(D32_SFLOAT, "depth32float", 4, 1, 1, WG_FMT_SAMPLE | WG_FMT_DEPTH),
   F(D32_SFLOAT_S8_UINT, "depth32float-stencil8", 4, 1, 1, WG_FMT_SAMPLE | WG_FMT_DEPTH | WG_FMT_STENCIL | WG_FMT_D32S8),
   /* Compressed: the adapter's texture-compression-* features. */
   F(BC1_RGBA_UNORM_BLOCK, "bc1-rgba-unorm", 8, 4, 4, CS | FL | WG_FMT_BC),
   F(BC1_RGBA_SRGB_BLOCK, "bc1-rgba-unorm-srgb", 8, 4, 4, CS | FL | WG_FMT_BC),
   F(BC2_UNORM_BLOCK, "bc2-rgba-unorm", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC2_SRGB_BLOCK, "bc2-rgba-unorm-srgb", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC3_UNORM_BLOCK, "bc3-rgba-unorm", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC3_SRGB_BLOCK, "bc3-rgba-unorm-srgb", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC4_UNORM_BLOCK, "bc4-r-unorm", 8, 4, 4, CS | FL | WG_FMT_BC),
   F(BC4_SNORM_BLOCK, "bc4-r-snorm", 8, 4, 4, CS | FL | WG_FMT_BC),
   F(BC5_UNORM_BLOCK, "bc5-rg-unorm", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC5_SNORM_BLOCK, "bc5-rg-snorm", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC6H_UFLOAT_BLOCK, "bc6h-rgb-ufloat", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC6H_SFLOAT_BLOCK, "bc6h-rgb-float", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC7_UNORM_BLOCK, "bc7-rgba-unorm", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(BC7_SRGB_BLOCK, "bc7-rgba-unorm-srgb", 16, 4, 4, CS | FL | WG_FMT_BC),
   F(ETC2_R8G8B8_UNORM_BLOCK, "etc2-rgb8unorm", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(ETC2_R8G8B8_SRGB_BLOCK, "etc2-rgb8unorm-srgb", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(ETC2_R8G8B8A1_UNORM_BLOCK, "etc2-rgb8a1unorm", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(ETC2_R8G8B8A1_SRGB_BLOCK, "etc2-rgb8a1unorm-srgb", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(ETC2_R8G8B8A8_UNORM_BLOCK, "etc2-rgba8unorm", 16, 4, 4, CS | FL | WG_FMT_ETC2),
   F(ETC2_R8G8B8A8_SRGB_BLOCK, "etc2-rgba8unorm-srgb", 16, 4, 4, CS | FL | WG_FMT_ETC2),
   F(EAC_R11_UNORM_BLOCK, "eac-r11unorm", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(EAC_R11_SNORM_BLOCK, "eac-r11snorm", 8, 4, 4, CS | FL | WG_FMT_ETC2),
   F(EAC_R11G11_UNORM_BLOCK, "eac-rg11unorm", 16, 4, 4, CS | FL | WG_FMT_ETC2),
   F(EAC_R11G11_SNORM_BLOCK, "eac-rg11snorm", 16, 4, 4, CS | FL | WG_FMT_ETC2),
#define ASTC(w, h)                                                                                                    \
   F(ASTC_##w##x##h##_UNORM_BLOCK, "astc-" #w "x" #h "-unorm", 16, w, h, CS | FL | WG_FMT_ASTC),                     \
   F(ASTC_##w##x##h##_SRGB_BLOCK, "astc-" #w "x" #h "-unorm-srgb", 16, w, h, CS | FL | WG_FMT_ASTC)
   ASTC(4, 4), ASTC(5, 4), ASTC(5, 5), ASTC(6, 5), ASTC(6, 6), ASTC(8, 5), ASTC(8, 6), ASTC(8, 8), ASTC(10, 5),
   ASTC(10, 6), ASTC(10, 8), ASTC(10, 10), ASTC(12, 10), ASTC(12, 12),
};

#define FORMAT_COUNT (sizeof(table) / sizeof(table[0]))
static struct wg_texture_format formats[FORMAT_COUNT];

/* The device's features that formats depend on (venus_init's flags). */
static uint32_t device_features;

void
wg_format_init(uint32_t features)
{
   device_features = features;
   const bool tier1 = features & WG_FEATURE_TIER1;
   for (uint32_t i = 0; i < FORMAT_COUNT; i++) {
      struct wg_texture_format *f = &formats[i];
      *f = table[i];
      if ((tier1 && (f->flags & WG_FMT_T1_RENDER)) ||
          ((features & WG_FEATURE_RG11B10_RENDER) && (f->flags & WG_FMT_RG11B10)))
         f->flags |= WG_FMT_RENDER | WG_FMT_BLEND;
      /* Both off by default (the worker holds them back: web/venus-gpu.ts `HELD_FEATURES`, mpv's VA-API chroma on the
       * M4 under libplacebo's advanced rendering, VK3 L4); `?gpu=vkformats=all` passes them on. */
      if ((features & WG_FEATURE_TIER1_STORAGE) && (f->flags & WG_FMT_T1_STORAGE))
         f->flags |= WG_FMT_STORAGE;
      if ((features & WG_FEATURE_FLOAT32_BLEND) && (f->flags & WG_FMT_FLOAT32))
         f->flags |= WG_FMT_BLEND;
      if ((features & WG_FEATURE_BGRA8_STORAGE) && (f->flags & WG_FMT_BGRA8))
         f->flags |= WG_FMT_STORAGE;
   }
}

const struct wg_texture_format *
wg_texture_format(VkFormat format)
{
   for (uint32_t i = 0; i < FORMAT_COUNT; i++) {
      const struct wg_texture_format *f = &formats[i];
      if (f->vk != format)
         continue;
      if (!f->name ||
          ((f->flags & WG_FMT_BC) && !(device_features & WG_FEATURE_BC)) ||
          ((f->flags & WG_FMT_ETC2) && !(device_features & WG_FEATURE_ETC2)) ||
          ((f->flags & WG_FMT_ASTC) && !(device_features & WG_FEATURE_ASTC)) ||
          ((f->flags & WG_FMT_D32S8) && !(device_features & WG_FEATURE_D32S8)) ||
          ((f->flags & WG_FMT_TIER1) && !(device_features & WG_FEATURE_TIER1)))
         return NULL;
      return f;
   }
   return NULL;
}

bool
wg_format_filterable(const struct wg_texture_format *f)
{
   return (f->flags & WG_FMT_FILTER) || ((f->flags & WG_FMT_FLOAT32) && (device_features & WG_FEATURE_FLOAT32_FILTER));
}

static const struct {
   VkFormat vk;
   const char *name;
} vertex_formats[] = {
   { VK_FORMAT_R8_UINT, "uint8" }, { VK_FORMAT_R8G8_UINT, "uint8x2" }, { VK_FORMAT_R8G8B8A8_UINT, "uint8x4" },
   { VK_FORMAT_R8_SINT, "sint8" }, { VK_FORMAT_R8G8_SINT, "sint8x2" }, { VK_FORMAT_R8G8B8A8_SINT, "sint8x4" },
   { VK_FORMAT_R8_UNORM, "unorm8" }, { VK_FORMAT_R8G8_UNORM, "unorm8x2" }, { VK_FORMAT_R8G8B8A8_UNORM, "unorm8x4" },
   { VK_FORMAT_R8_SNORM, "snorm8" }, { VK_FORMAT_R8G8_SNORM, "snorm8x2" }, { VK_FORMAT_R8G8B8A8_SNORM, "snorm8x4" },
   { VK_FORMAT_B8G8R8A8_UNORM, "unorm8x4-bgra" },
   { VK_FORMAT_R16_UINT, "uint16" }, { VK_FORMAT_R16G16_UINT, "uint16x2" }, { VK_FORMAT_R16G16B16A16_UINT, "uint16x4" },
   { VK_FORMAT_R16_SINT, "sint16" }, { VK_FORMAT_R16G16_SINT, "sint16x2" }, { VK_FORMAT_R16G16B16A16_SINT, "sint16x4" },
   { VK_FORMAT_R16_UNORM, "unorm16" }, { VK_FORMAT_R16G16_UNORM, "unorm16x2" },
   { VK_FORMAT_R16G16B16A16_UNORM, "unorm16x4" },
   { VK_FORMAT_R16_SNORM, "snorm16" }, { VK_FORMAT_R16G16_SNORM, "snorm16x2" },
   { VK_FORMAT_R16G16B16A16_SNORM, "snorm16x4" },
   { VK_FORMAT_R16_SFLOAT, "float16" }, { VK_FORMAT_R16G16_SFLOAT, "float16x2" },
   { VK_FORMAT_R16G16B16A16_SFLOAT, "float16x4" },
   { VK_FORMAT_R32_SFLOAT, "float32" }, { VK_FORMAT_R32G32_SFLOAT, "float32x2" },
   { VK_FORMAT_R32G32B32_SFLOAT, "float32x3" }, { VK_FORMAT_R32G32B32A32_SFLOAT, "float32x4" },
   { VK_FORMAT_R32_UINT, "uint32" }, { VK_FORMAT_R32G32_UINT, "uint32x2" }, { VK_FORMAT_R32G32B32_UINT, "uint32x3" },
   { VK_FORMAT_R32G32B32A32_UINT, "uint32x4" },
   { VK_FORMAT_R32_SINT, "sint32" }, { VK_FORMAT_R32G32_SINT, "sint32x2" }, { VK_FORMAT_R32G32B32_SINT, "sint32x3" },
   { VK_FORMAT_R32G32B32A32_SINT, "sint32x4" },
   { VK_FORMAT_A2B10G10R10_UNORM_PACK32, "unorm10-10-10-2" },
};

const char *
wg_vertex_format(VkFormat format)
{
   for (uint32_t i = 0; i < sizeof(vertex_formats) / sizeof(vertex_formats[0]); i++)
      if (vertex_formats[i].vk == format)
         return vertex_formats[i].name;
   return NULL;
}

/* A texel buffer's format as the translator's loads and stores decode it (wgsl_print.c `texel_buffer_helpers`): p0's
 * x (type, texel bytes, swizzle) and p1's x, y, z (channel widths, first bits, the components stored). False for a
 * format they can't read: not plain RGB, a channel past 32 bits or straddling a word, mixed channel types, sRGB;
 * `storage` says whether they can write it too (whole words, no packed floats). */
bool
wg_texel_buffer_layout(VkFormat format, uint32_t *x, uint32_t p1[3], bool *storage)
{
   const enum pipe_format pf = vk_format_to_pipe_format(format);
   const struct util_format_description *d = pf != PIPE_FORMAT_NONE ? util_format_description(pf) : NULL;
   if (!d || (d->layout != UTIL_FORMAT_LAYOUT_PLAIN && pf != PIPE_FORMAT_R11G11B10_FLOAT) ||
       d->colorspace != UTIL_FORMAT_COLORSPACE_RGB ||
       d->block.width != 1 || d->block.height != 1 || d->block.depth != 1 || d->block.bits % 8 ||
       d->block.bits > 128)
      return false;
   const uint32_t bytes = d->block.bits / 8;
   int type = -1;
   p1[0] = p1[1] = p1[2] = 0;
   for (uint32_t k = 0; k < 4; k++) {
      const struct util_format_channel_description *ch = &d->channel[k];
      if (k >= d->nr_channels || ch->type == UTIL_FORMAT_TYPE_VOID)
         continue;
      int t;
      if (pf == PIPE_FORMAT_R11G11B10_FLOAT)
         t = 5;
      else if (ch->type == UTIL_FORMAT_TYPE_FLOAT)
         t = ch->size == 16 || ch->size == 32 ? 4 : -1;
      else if (ch->type == UTIL_FORMAT_TYPE_UNSIGNED)
         t = ch->pure_integer ? 2 : ch->normalized ? 0 : 6;
      else if (ch->type == UTIL_FORMAT_TYPE_SIGNED)
         t = ch->pure_integer ? 3 : ch->normalized ? 1 : 7;
      else
         t = -1;
      if (t < 0 || (type >= 0 && t != type) || ch->size == 0 || ch->size > 32 ||
          ch->shift / 32 != (ch->shift + ch->size - 1) / 32)
         return false;
      /* A texel of 1, 2 or 4 bytes lies in one word; another's channels are whole bytes at their own alignment (an
       * RGB8 texel at byte 3 has its channels at bytes 3, 4, 5). */
      if (((bytes & (bytes - 1)) || bytes > 4) && (ch->size % 8 || ch->shift % ch->size))
         return false;
      type = t;
      p1[0] |= ch->size << (8 * k);
      p1[1] |= ch->shift << (8 * k);
   }
   if (type < 0)
      return false;
   uint32_t swizzle = 0;
   for (uint32_t i = 0; i < 4; i++) {
      const uint32_t s = d->swizzle[i];
      swizzle |= (s <= PIPE_SWIZZLE_1 ? s : PIPE_SWIZZLE_0) << (3 * i);
      if (s <= PIPE_SWIZZLE_W)
         p1[2] |= i << (3 * s);
   }
   *x = (uint32_t)type | bytes << 8 | swizzle << 16;
   *storage = bytes % 4 == 0 && type != 5 && type < 6;
   return true;
}

const struct vk_format_ycbcr_info *
wg_ycbcr_format(VkFormat format)
{
   const struct vk_format_ycbcr_info *info = (wg_features & WG_FEATURE_YCBCR) ? vk_format_get_ycbcr_info(format) : NULL;
   if (!info || info->n_planes < 2)
      return NULL;
   for (uint32_t p = 0; p < info->n_planes; p++) {
      const struct wg_texture_format *f = wg_texture_format(info->planes[p].format);
      if (!f || !(f->flags & WG_FMT_SAMPLE) || !wg_format_filterable(f) || (f->flags & WG_FMT_NOCOPY))
         return NULL;
   }
   return info;
}

VkFormatFeatureFlags
wg_view_formats_features(const struct wg_texture_format *f, const VkFormat *list, uint32_t count)
{
   VkFormatFeatureFlags all = 0;
   for (uint32_t i = 0; i < FORMAT_COUNT; i++) {
      const struct wg_texture_format *v = wg_texture_format(formats[i].vk);
      if (!v || v->bytes != f->bytes || v->bw != f->bw || v->bh != f->bh || (v->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL)))
         continue;
      bool listed = !list;
      for (uint32_t k = 0; list && k < count; k++)
         listed |= list[k] == v->vk;
      if (!listed)
         continue;
      VkFormatFeatureFlags linear, optimal, buffer;
      wg_format_features(v->vk, &linear, &optimal, &buffer);
      all |= optimal;
   }
   return all;
}

/* What the device reports of a format: optimal tiling from WebGPU's capabilities, linear tiling only copies (a linear
 * image is a texture like any other, but the guest can't sample what it maps), buffers vertex input and texel buffers
 * (wg_texel_buffer_layout). */
void
wg_format_features(VkFormat format, VkFormatFeatureFlags *linear, VkFormatFeatureFlags *optimal,
                   VkFormatFeatureFlags *buffer)
{
   const struct wg_texture_format *f = wg_texture_format(format);
   VkFormatFeatureFlags o = 0;
   if (f) {
      /* depth24plus's depth is copied by the worker's draws and compute passes (web/venus-gpu.ts `depthByShader`). */
      if (!(f->flags & WG_FMT_NOCOPY) || (f->flags & WG_FMT_DEPTH))
         o |= VK_FORMAT_FEATURE_TRANSFER_SRC_BIT | VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
      if (f->flags & WG_FMT_SAMPLE)
         o |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_BLIT_SRC_BIT;
      if (wg_format_filterable(f))
         o |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
      if (f->flags & WG_FMT_RENDER)
         o |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_BLIT_DST_BIT;
      if (f->flags & WG_FMT_BLEND)
         o |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BLEND_BIT;
      if (f->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL))
         o |= VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
      if (f->flags & WG_FMT_STORAGE)
         o |= VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT;
   }
   *optimal = o;
   *linear = f && f->bw == 1 && !(f->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL))
                ? o & (VK_FORMAT_FEATURE_TRANSFER_SRC_BIT | VK_FORMAT_FEATURE_TRANSFER_DST_BIT)
                : 0;
   /* A multi-planar format (VK3 L7.2): its planes sampled through a YCbCr conversion and copied, optimal tiling only;
    * implicit chroma reconstruction (no explicit, no filter of the chroma's own: the sampler's filters it), planes
    * bound apart. */
   if (wg_ycbcr_format(format)) {
      *optimal = VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_TRANSFER_SRC_BIT |
                 VK_FORMAT_FEATURE_TRANSFER_DST_BIT | VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT |
                 VK_FORMAT_FEATURE_MIDPOINT_CHROMA_SAMPLES_BIT | VK_FORMAT_FEATURE_COSITED_CHROMA_SAMPLES_BIT |
                 VK_FORMAT_FEATURE_SAMPLED_IMAGE_YCBCR_CONVERSION_LINEAR_FILTER_BIT | VK_FORMAT_FEATURE_DISJOINT_BIT;
      *linear = 0;
   }
   *buffer = wg_vertex_format(format) ? VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT : 0;
   uint32_t x, p1[3];
   bool storage;
   if (wg_texel_buffer_layout(format, &x, p1, &storage))
      *buffer |= VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | (storage ? VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT : 0);
}
