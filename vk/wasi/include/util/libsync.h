/* Mesa's and virglrenderer's util/libsync.h for the renderer's wasm build (vk/wasi/shim.h): sync files are Linux's
 * file descriptors for fences, and the module has none (its fences are signalled where they are submitted). */
#pragma once
#include <errno.h>

static inline int sync_wait(int fd, int timeout) { (void)fd, (void)timeout; errno = ENOSYS; return -1; }
static inline int sync_merge(const char *name, int fd1, int fd2) { (void)name, (void)fd1, (void)fd2; errno = ENOSYS; return -1; }
static inline int sync_accumulate(const char *name, int *fd1, int fd2) { (void)name, (void)fd1, (void)fd2; errno = ENOSYS; return -1; }
static inline int sync_valid_fd(int fd) { (void)fd; return 0; }
