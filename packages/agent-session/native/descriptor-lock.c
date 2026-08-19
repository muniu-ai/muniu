// SPDX-License-Identifier: Apache-2.0

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sysexits.h>

int main(int argc, char **argv) {
  char *end = NULL;
  long descriptor;

  if (argc != 2) return EX_USAGE;
  errno = 0;
  descriptor = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || descriptor < 0 || descriptor > INT_MAX) {
    return EX_USAGE;
  }

  if (flock((int)descriptor, LOCK_EX | LOCK_NB) == 0) return EX_OK;
  if (errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR) return EX_TEMPFAIL;
  return EX_OSERR;
}
