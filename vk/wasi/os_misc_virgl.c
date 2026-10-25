/* The two functions of virglrenderer's util/os_misc.c its copy of u_debug.c calls, for the renderer's wasm build
 * (vk/gen.ts compiles it under virglrenderer's renamed util names): no environment, the log to stderr. */
#include <stdio.h>

const char *os_get_option(const char *name);
void os_log_message(const char *message);

const char *
os_get_option(const char *name)
{
   (void)name;
   return NULL;
}

void
os_log_message(const char *message)
{
   fputs(message, stderr);
}
