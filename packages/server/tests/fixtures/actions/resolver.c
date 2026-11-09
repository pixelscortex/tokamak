// Test-process-only DNS answers: exercise the resolver used by the real HTTP
// connector without changing global hosts files or contacting external DNS.
#include <netdb.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#ifdef __APPLE__
static int real_lookup(const char *host, const char *service,
                       const struct addrinfo *hints, struct addrinfo **result) {
    return getaddrinfo(host, service, hints, result);
}
#else
#include <dlfcn.h>
static int real_lookup(const char *host, const char *service,
                       const struct addrinfo *hints, struct addrinfo **result) {
    typedef int (*lookup)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
    return ((lookup)dlsym(RTLD_NEXT, "getaddrinfo"))(host, service, hints, result);
}
#endif
static int test_lookup(const char *host, const char *service,
                       const struct addrinfo *hints, struct addrinfo **result) {
    const char *address = NULL;
    if (host && !strcmp(host, "held.tkm.test")) {
        const char *log = getenv("TKM45_DNS_LOG");
        const char *release = getenv("TKM45_DNS_RELEASE");
        // One atomic append per real OS lookup, not per attempted JS fetch.
        if (log) {
            int file = open(log, O_WRONLY | O_APPEND | O_CREAT, 0600);
            if (file >= 0) { (void)write(file, "entered\n", 8); close(file); }
        }
        // Parent watchdog kills this isolated test process on assertion failure.
        while (release && access(release, F_OK) != 0) usleep(1000);
        address = "10.1.2.3";
    }
    if (host && !strcmp(host, "loopback.tkm.test")) address = "127.0.0.1";
    if (host && !strcmp(host, "private.tkm.test")) address = "10.1.2.3";
    if (host && !strcmp(host, "metadata.tkm.test")) address = "169.254.169.254";
    if (host && !strcmp(host, "mapped.tkm.test")) address = "::ffff:127.0.0.1";
    if (!address) return real_lookup(host, service, hints, result);
    struct addrinfo numeric = {0};
    if (hints) numeric = *hints;
    numeric.ai_flags |= AI_NUMERICHOST;
    return real_lookup(address, service, &numeric, result);
}
// Observe forbidden connection attempts too: a generic connection-refused
// error must not let a missing private/metadata filter pass the regression.
// Block those attempts in the shim so no packet can leave the test machine.
static int test_connect(int socket, const struct sockaddr *address, socklen_t length) {
    if (address && address->sa_family == AF_INET) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
        unsigned long ip = ntohl(ipv4->sin_addr.s_addr);
        if (ip == 0x0a010203 || ip == 0xa9fea9fe) {
            const char *path = getenv("TKM45_TEST_CONNECT_LOG");
            if (path) {
                int file = open(path, O_WRONLY | O_APPEND | O_CREAT, 0600);
                if (file >= 0) { (void)write(file, "forbidden connect\n", 18); close(file); }
            }
            errno = ECONNREFUSED;
            return -1;
        }
    }
#ifdef __APPLE__
    return connect(socket, address, length);
#else
    typedef int (*connection)(int, const struct sockaddr *, socklen_t);
    return ((connection)dlsym(RTLD_NEXT, "connect"))(socket, address, length);
#endif
}
#ifdef __APPLE__
__attribute__((used, section("__DATA,__interpose")))
static struct { const void *replacement; const void *original; } interpose[] = {
    { (const void *)test_lookup, (const void *)getaddrinfo },
    { (const void *)test_connect, (const void *)connect }
};
#else
int connect(int socket, const struct sockaddr *address, socklen_t length) {
    return test_connect(socket, address, length);
}
int getaddrinfo(const char *host, const char *service,
                const struct addrinfo *hints, struct addrinfo **result) {
    return test_lookup(host, service, hints, result);
}
#endif
