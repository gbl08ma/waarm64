// session: the visitor's shell on the serial port, in a session of its own with the port as its
// terminal (job control, Ctrl-C). images/intro/init starts it in the background, to be able to
// answer signals while it runs, and a shell's background jobs ignore SIGINT and SIGQUIT, which
// every program started from that shell would inherit: here they are the defaults again.
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(void) {
  setsid();
  int tty = open("/dev/ttyAMA0", O_RDWR);
  if (tty < 0) return 1;
  ioctl(tty, TIOCSCTTY, 0);
  dup2(tty, 0), dup2(tty, 1), dup2(tty, 2);
  if (tty > 2) close(tty);
  signal(SIGINT, SIG_DFL);
  signal(SIGQUIT, SIG_DFL);
  execl("/bin/sh", "-sh", (char *)0); // a login shell: it reads /etc/profile
  return 1;
}
