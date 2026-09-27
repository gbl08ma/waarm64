// The crypto test kernel's init (M6.5 loop 3; images/build.sh linux-crypto):
// waits for the crypto self-tests to finish, prints each implementation with
// its self-test result and the CPU's features, then powers off. KUnit's
// results are on the console already (the suites run during boot).
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <unistd.h>

static int scan(int print) {
    FILE *f = fopen("/proc/crypto", "r");
    char line[256], driver[128] = "", name[128] = "";
    int pending = 0, failed = 0;
    if (!f) return -1;
    while (fgets(line, sizeof line, f)) {
        char v[128];
        if (sscanf(line, "name : %127s", v) == 1) strcpy(name, v);
        if (sscanf(line, "driver : %127s", v) == 1) strcpy(driver, v);
        if (sscanf(line, "selftest : %127s", v) == 1) {
            if (!strcmp(v, "unknown")) pending++;
            else if (strcmp(v, "passed")) failed++;
            if (print) printf("crypto: %s %s %s\n", driver, name, v);
        }
    }
    fclose(f);
    return print ? failed : pending;
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    printf("webpc: crypto-test\n");
    for (int i = 0; i < 600 && scan(0) != 0; i++) usleep(100000);
    int failed = scan(1), pending = scan(0);
    char line[1024];
    FILE *f = fopen("/proc/cpuinfo", "r");
    while (f && fgets(line, sizeof line, f))
        if (!strncmp(line, "Features", 8)) printf("cpuinfo: %s", line);
    if (f) fclose(f);
    printf("webpc: test %s (%d failed, %d pending)\n", failed || pending ? "failed" : "ok", failed, pending);
    fflush(stdout);
    reboot(RB_POWER_OFF);
    return 0;
}
