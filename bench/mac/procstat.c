// A process's CPU counters on macOS, for the Mac host's benchmark runs (bench/procstat.ts; docs/benchmarking.md):
// for each pid given, one line "pid instructions cycles user_ns system_ns p_instructions p_cycles p_user_ns
// p_system_ns energy_nj", cumulative since the process started (the p_ ones on performance cores only). Reads
// proc_pid_rusage (RUSAGE_INFO_V6), which needs no privilege for the user's own processes. A pid that is gone or
// not ours prints nothing.
//   cc -O2 -o procstat bench/mac/procstat.c && ./procstat <pid>...
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb); // user and system times are in mach ticks
  for (int i = 1; i < argc; i++) {
    struct rusage_info_v6 r;
    if (proc_pid_rusage(atoi(argv[i]), RUSAGE_INFO_V6, (rusage_info_t *)&r)) continue;
    printf("%s %llu %llu %llu %llu %llu %llu %llu %llu %llu\n", argv[i], r.ri_instructions, r.ri_cycles,
           r.ri_user_time * tb.numer / tb.denom, r.ri_system_time * tb.numer / tb.denom, r.ri_pinstructions,
           r.ri_pcycles, r.ri_user_ptime * tb.numer / tb.denom, r.ri_system_ptime * tb.numer / tb.denom,
           r.ri_energy_nj);
  }
  return 0;
}
