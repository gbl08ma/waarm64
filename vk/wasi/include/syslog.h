/* util/log.c's syslog: there is no system log in a wasm module (vk/wasi/shim.h). */
#pragma once
#define LOG_ERR 3
#define LOG_WARNING 4
#define LOG_INFO 6
#define LOG_DEBUG 7
#define LOG_USER (1 << 3)
#define LOG_NDELAY 0x08
#define LOG_PID 0x01
static inline void openlog(const char *ident, int option, int facility) {}
static inline void syslog(int priority, const char *format, ...) {}
