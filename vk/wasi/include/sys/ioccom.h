/* The BSDs' ioctl encoding, which DRM's uapi headers include outside Linux (vk/wasi/shim.h): only its macros, no
 * ioctl is ever made. */
#pragma once
#define _IOC(dir, type, nr, size) ((unsigned long)(((dir) << 30) | ((size) << 16) | ((type) << 8) | (nr)))
#define _IO(type, nr) _IOC(0, (type), (nr), 0)
#define _IOW(type, nr, t) _IOC(1, (type), (nr), sizeof(t))
#define _IOR(type, nr, t) _IOC(2, (type), (nr), sizeof(t))
#define _IOWR(type, nr, t) _IOC(3, (type), (nr), sizeof(t))
