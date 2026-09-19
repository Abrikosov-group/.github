#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Fixed item only. Secret bytes go only to the trusted parent's private pipe. */
int main(int argc, char **argv) {
  int interactive = argc == 2 && strcmp(argv[1], "--interactive-pipe") == 0;
  if (!(argc == 1 || interactive) || isatty(STDOUT_FILENO)) return 64;
  SecKeychainSetUserInteractionAllowed(interactive);
  const char *service = "com.abrikosov.deepseek.reviews";
  const char *account = "api-key-20260920";
  UInt32 length = 0;
  void *data = NULL;
  OSStatus status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service), service,
    (UInt32)strlen(account), account, &length, &data, NULL);
  if (status != errSecSuccess) {
    fprintf(stderr, "credential_unavailable:%d\n", (int)status);
    return 1;
  }
  int ok = length >= 16 && length <= 4096;
  if (ok) ok = fwrite(data, 1, length, stdout) == length && fflush(stdout) == 0;
  if (data) {
    volatile unsigned char *wipe = (volatile unsigned char *)data;
    for (UInt32 i = 0; i < length; i++) wipe[i] = 0;
    SecKeychainItemFreeContent(NULL, data);
  }
  return ok ? 0 : 1;
}
