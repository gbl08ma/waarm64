// CoreMark's port layer for the webpc benchmark guest (M5 step 10): bare
// metal on flat memory, as bench/interp/guest.c. Our own file (MIT), written
// against CoreMark's porting interface (barebones/core_portme.h upstream);
// CoreMark itself (Apache-2.0, EEMBC) is fetched unmodified by build.sh.
// Built with HAS_FLOAT 0, static memory and fixed seeds (the 2K performance
// run); it keeps no time: the host measures it (bench/interp/suite.ts).
#ifndef CORE_PORTME_H
#define CORE_PORTME_H

#define HAS_FLOAT 0
#define HAS_TIME_H 0
#define USE_CLOCK 0
#define HAS_STDIO 0
#define HAS_PRINTF 0
#define COMPILER_VERSION "clang " __clang_version__
#ifndef FLAGS_STR
#define FLAGS_STR "?"
#endif
#define COMPILER_FLAGS FLAGS_STR
#define MEM_LOCATION "STATIC"

typedef signed short ee_s16;
typedef unsigned short ee_u16;
typedef signed int ee_s32;
typedef double ee_f32;
typedef unsigned char ee_u8;
typedef unsigned int ee_u32;
typedef unsigned long ee_ptr_int;
typedef unsigned long ee_size_t;
#define NULL ((void *)0)
#define align_mem(x) (void *)(4 + (((ee_ptr_int)(x)-1) & ~3))

#define CORETIMETYPE ee_u32
typedef ee_u32 CORE_TICKS;

#define SEED_METHOD SEED_VOLATILE
#define MEM_METHOD MEM_STATIC
#define MULTITHREAD 1
#define USE_PTHREAD 0
#define USE_FORK 0
#define USE_SOCKET 0
#define MAIN_HAS_NOARGC 1
#define MAIN_HAS_NORETURN 0

typedef struct CORE_PORTABLE_S {
    ee_u8 portable_id;
} core_portable;

void portable_init(core_portable *p, int *argc, char *argv[]);
void portable_fini(core_portable *p);

#if !defined(PROFILE_RUN) && !defined(PERFORMANCE_RUN) && !defined(VALIDATION_RUN)
#define PERFORMANCE_RUN 1
#endif

extern ee_u32 default_num_contexts;
int ee_printf(const char *fmt, ...);

#endif
