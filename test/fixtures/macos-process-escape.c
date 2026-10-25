#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *message) {
  perror(message);
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s setsid|setpgid MARKER\n", argv[0]);
    return 2;
  }

  if (strcmp(argv[1], "setsid") == 0) {
    if (setsid() == -1) fail("setsid");
  } else if (strcmp(argv[1], "setpgid") == 0) {
    if (setpgid(0, 0) == -1) fail("setpgid");
  } else {
    fprintf(stderr, "unknown mode: %s\n", argv[1]);
    return 2;
  }

  FILE *marker = fopen(argv[2], "w");
  if (marker == NULL) fail("fopen");
  fprintf(marker, "%ld %ld %ld\n", (long)getpid(), (long)getpgrp(), (long)getsid(0));
  if (fclose(marker) != 0) fail("fclose");

  for (;;) pause();
}
