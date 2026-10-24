#define _GNU_SOURCE
#include <errno.h>
#include <linux/sched.h>
#include <sched.h>
#include <stdio.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

// No credentials, no privilege acquisition; distinguish the syscall filter from EBADF/EINVAL.
int main(void) {
  errno = 0;
  syscall(SYS_clone3, NULL, 0);
  int clone3_error = errno;
  errno = 0;
  syscall(SYS_setns, -1, CLONE_NEWUSER);
  int setns_error = errno;
  errno = 0;
  syscall(SYS_unshare, CLONE_NEWNS);
  int unshare_error = errno;
  errno = 0;
  syscall(SYS_bpf, 0, NULL, 0);
  int bpf_error = errno;
  errno = 0;
  syscall(SYS_keyctl, 0, 0, 0, 0, 0);
  int keyctl_error = errno;
  errno = 0;
  socket(AF_VSOCK, SOCK_STREAM, 0);
  int vsock_error = errno;
  printf("{\"clone3\":%d,\"setns\":%d,\"unshare\":%d,\"bpf\":%d,\"keyctl\":%d,\"vsock\":%d}",
    clone3_error, setns_error, unshare_error, bpf_error, keyctl_error, vsock_error);
  return 0;
}
