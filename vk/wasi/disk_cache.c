/* util/disk_cache.c for the wasm build (vk/build.sh; vk/README.md "The shader cache"): Mesa's pipeline caches look up
 * what they miss here (vk_pipeline_cache.c, built with ENABLE_SHADER_CACHE), and this hands it to the GPU worker,
 * which keeps entries across runs in the browser's storage (web/venus-cache.ts). No files, no threads: a put and a get
 * are calls into the worker (`wg` imports), which answers a get from what it loaded at the start.
 *
 * A key is BLAKE3 of the cache's identity (gpu_name, driver_id: the driver's build and the device's caps, driver_flags)
 * and the runtime's own key (a stage's SPIR-V and specialization, a shader's stages and layouts). */
#include <stdlib.h>
#include <string.h>

#include "util/disk_cache.h"

#define WG_IMPORT(name) __attribute__((import_module("wg"), import_name(#name)))
/* The size of the entry under `key` (0: none), which gpu_cache_read then copies into `data`. */
WG_IMPORT(gpu_cache_get) uint32_t gpu_cache_get(const uint8_t *key, uint32_t key_size);
WG_IMPORT(gpu_cache_read) void gpu_cache_read(const uint8_t *key, uint32_t key_size, void *data, uint32_t size);
WG_IMPORT(gpu_cache_put) void gpu_cache_put(const uint8_t *key, uint32_t key_size, const void *data, uint32_t size);

struct disk_cache {
   blake3_hash identity;
};

struct disk_cache *
disk_cache_create(const char *gpu_name, const char *driver_id, uint64_t driver_flags)
{
   struct disk_cache *cache = calloc(1, sizeof(*cache));
   if (!cache)
      return NULL;
   blake3_hasher h;
   _mesa_blake3_init(&h);
   _mesa_blake3_update(&h, gpu_name, strlen(gpu_name) + 1);
   _mesa_blake3_update(&h, driver_id, strlen(driver_id) + 1);
   _mesa_blake3_update(&h, &driver_flags, sizeof(driver_flags));
   const uint8_t ptr_size = sizeof(void *);
   _mesa_blake3_update(&h, &ptr_size, 1);
   _mesa_blake3_final(&h, cache->identity);
   return cache;
}

struct disk_cache *
disk_cache_create_custom(const char *gpu_name, const char *driver_id, uint64_t driver_flags, const char *cache_dir_name,
                         uint32_t max_size)
{
   return disk_cache_create(gpu_name, driver_id, driver_flags);
}

void
disk_cache_destroy(struct disk_cache *cache)
{
   free(cache);
}

void
disk_cache_wait_for_idle(struct disk_cache *cache)
{
}

void
disk_cache_remove(struct disk_cache *cache, const cache_key key)
{
}

void
disk_cache_put(struct disk_cache *cache, const cache_key key, const void *data, size_t size,
               struct cache_item_metadata *cache_item_metadata)
{
   if (size <= UINT32_MAX)
      gpu_cache_put(key, CACHE_KEY_SIZE, data, (uint32_t)size);
}

void
disk_cache_put_nocopy(struct disk_cache *cache, const cache_key key, void *data, size_t size,
                      struct cache_item_metadata *cache_item_metadata)
{
   disk_cache_put(cache, key, data, size, cache_item_metadata);
   free(data);
}

void *
disk_cache_get(struct disk_cache *cache, const cache_key key, size_t *size)
{
   if (size)
      *size = 0;
   const uint32_t n = gpu_cache_get(key, CACHE_KEY_SIZE);
   if (!n)
      return NULL;
   void *data = malloc(n);
   if (!data)
      return NULL;
   gpu_cache_read(key, CACHE_KEY_SIZE, data, n);
   if (size)
      *size = n;
   return data;
}

void
disk_cache_put_key(struct disk_cache *cache, const cache_key key)
{
}

bool
disk_cache_has_key(struct disk_cache *cache, const cache_key key)
{
   return false;
}

void
disk_cache_compute_key(struct disk_cache *cache, const void *data, size_t size, cache_key key)
{
   blake3_hasher h;
   _mesa_blake3_init(&h);
   _mesa_blake3_update(&h, cache->identity, sizeof(cache->identity));
   _mesa_blake3_update(&h, data, size);
   _mesa_blake3_final(&h, key);
}

void
disk_cache_set_callbacks(struct disk_cache *cache, disk_cache_put_cb put, disk_cache_get_cb get)
{
}
