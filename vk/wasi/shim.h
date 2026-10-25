/* What WASI's libc lacks that Mesa's util, its Vulkan runtime and virglrenderer's vkr reach for (vk/build.sh). Included
 * first in every file of the renderer's wasm build, which also defines DETECT_OS_POSIX=1 (WASI is POSIX enough; Mesa's
 * detect_os.h knows it not). */
#pragma once
#include <sys/types.h>

/* util/u_debug.h's __normal_user(): one user, always normal. */
static inline uid_t getuid(void) { return 0; }
static inline uid_t geteuid(void) { return 0; }
static inline gid_t getgid(void) { return 0; }
static inline gid_t getegid(void) { return 0; }

/* util/log.c's log to a file: no files to write. */
#define mkstemps(t, n) ((void)(t), (void)(n), -1)

/* util/u_thread.h masks signals around thread creation, c11's thrd_exit ends a thread, vkr's ring thread asks for a
 * priority: none of it happens in a module whose threads are the GPU worker's polls. */
#include <signal.h>
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_SETMASK 2
#endif
#define sigfillset(s) ((void)(s), 0)
#define sigdelset(s, n) ((void)(s), (void)(n), 0)
#define pthread_sigmask(how, set, old) ((void)(how), (void)(set), (void)(old), 0)
#define pthread_exit(v) __builtin_trap()
#define PRIO_PROCESS 0
#define setpriority(which, who, prio) ((void)(which), (void)(who), (void)(prio), -1)

/* Linux's "timer expired", which the fence waits return. */
#include <errno.h>
#ifndef ETIME
#define ETIME 62
#endif
