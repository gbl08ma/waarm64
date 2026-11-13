/* util/os_misc.c for the wasm build (vk/build.sh): what Mesa's util and Vulkan runtime call, without a platform under them.
 * Options come from no environment (the debug flags stay off); memory and the page size are a wasm module's. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "util/os_misc.h"

void
os_log_message(const char *message)
{
   fputs(message, stderr);
}

const char *
os_get_option(const char *name)
{
   return NULL;
}

char *
os_get_option_dup(const char *name)
{
   return NULL;
}

const char *
os_get_option_secure(const char *name)
{
   return NULL;
}

char *
os_get_option_secure_dup(const char *name)
{
   return NULL;
}

const char *
os_get_option_cached(const char *name)
{
   return NULL;
}

void
os_set_option(const char *name, const char *value, bool override)
{
}

bool
os_get_total_physical_memory(uint64_t *size)
{
   *size = 4ull << 30;
   return true;
}

bool
os_get_available_system_memory(uint64_t *size)
{
   *size = 4ull << 30;
   return true;
}

bool
os_get_page_size(uint64_t *size)
{
   *size = 65536;
   return true;
}

bool
os_jit_allowed(void)
{
   return false;
}

/* util/u_process.c's name, for the log: there is no process to ask. */
const char *util_get_process_name(void);
const char *
util_get_process_name(void)
{
   return "waarm64-gpu";
}
