// typed: prints its arguments a character at a time, as somebody typing them would
// (images/intro/tour, the introduction's guest).
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  unsigned r = 12345;
  for (int i = 1; i < argc; i++) {
    for (const char *p = argv[i]; *p; p++) {
      r = r * 1103515245 + 12345;
      struct timespec t = {0, (60 + (r >> 16) % 70) * 1000000};
      nanosleep(&t, 0);
      if (write(1, p, 1) < 0) return 1;
    }
    if (i + 1 < argc && write(1, " ", 1) < 0) return 1;
  }
  struct timespec t = {0, 250000000};
  nanosleep(&t, 0);
  return write(1, "\n", 1) < 0;
}
