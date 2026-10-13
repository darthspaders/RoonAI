/* SPDX-License-Identifier: LGPL-2.0-or-later */
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <stdint.h>
#include <inttypes.h>

typedef int gint;
typedef char gchar;
typedef int64_t gint64;
typedef uint64_t guint64;
typedef int SRTSOCKET;
typedef int SYSSOCKET;
typedef struct { int *cancellable; void *element; } GstSRTObject;
typedef struct { int sock; int poll_id; } SRTCaller;
typedef struct { int byteSndBuf, msSndBuf, pktFlightSize, pktFlowWindow;
  int pktRecvACKTotal, pktRecvNAKTotal, pktRetransTotal, pktSndDropTotal;
  uint64_t byteSentUniqueTotal; } SRT_TRACEBSTATS;
#define SRT_ERROR (-1)
#define SRT_EASYNCSND 6001
#define SRT_ETIMEOUT 6003
#define GST_DEBUG_OBJECT(...) ((void) 0)
#define GST_WARNING_OBJECT(object, ...) record_warning (object, __VA_ARGS__)
#define G_GINT64_FORMAT PRId64
#define G_GUINT64_FORMAT PRIu64
#define G_USEC_PER_SEC 1000000

static int cancelled, last_error, sends, waits, scenario, warnings, stats_reads;
static gint64 monotonic_us;
static char last_warning[2048];
static const char *expected_data;
static int expected_length;
static gint64 g_get_monotonic_time (void) { return monotonic_us; }
static void record_warning (void *object, const char *format, ...)
{
  va_list values;
  (void) object;
  va_start (values, format);
  vsnprintf (last_warning, sizeof(last_warning), format, values);
  va_end (values);
  warnings++;
}
static int srt_bstats (int socket, SRT_TRACEBSTATS *stats, int clear)
{
  assert(socket == 47 && clear == 0);
  memset (stats, 0, sizeof(*stats)); stats_reads++;
  last_error = 9999; /* Reading stats must not change send/error decisions. */
  return scenario == 12 ? -1 : 0;
}
static int srt_getsockstate (int socket) { assert(socket == 47); return 5; }
static int g_cancellable_is_cancelled (int *value) { return *value; }
static int srt_getlasterror (void *unused) { (void) unused; return last_error; }
static int srt_sendmsg2 (int socket, const char *data, int length, void *control)
{
  assert(socket == 47 && data == expected_data && length == expected_length);
  assert(control == NULL);
  sends++;
  if (scenario == 1 || (scenario == 2 && sends == 2) ||
      (scenario == 8 && sends == 3) ||
      ((scenario == 9 || scenario == 12) && sends == 13) ||
      (scenario == 10 && sends == 24)) return length;
  last_error = scenario == 3 || (scenario == 11 && sends == 3) ? 2001 : SRT_EASYNCSND;
  return SRT_ERROR;
}
static int srt_epoll_wait (int poll, int *read_socket, int *read_count,
    int *write_socket, int *write_count, int timeout, int *read_system,
    int *read_system_count, int *write_system, int *write_system_count)
{
  assert(poll == 13 && timeout == 100);
  assert(*read_count == 1 && *write_count == 1);
  assert(*read_system_count == 1 && *write_system_count == 1);
  (void) read_system; (void) write_system;
  *read_count = 0; *write_count = 0;
  *read_system_count = 0; *write_system_count = 0;
  waits++;
  monotonic_us += 100000;
  assert(waits < 30);
  if (scenario == 4 || scenario >= 8) {
    if (scenario == 4 && waits == 3) cancelled = 1;
    last_error = SRT_ETIMEOUT; return SRT_ERROR;
  }
  if (scenario == 5) { last_error = 2001; return SRT_ERROR; }
  if (scenario == 6) { *read_count = 1; *read_socket = 47; }
  if (scenario == 7) cancelled = 1;
  *write_count = 1; *write_socket = 47;
  return *read_count + *write_count;
}

#include "listener-backpressure.h"

int main (void)
{
  GstSRTObject object = { &cancelled, NULL };
  SRTCaller caller = { 47, 13 };
  const char packet[] = "unchanged-packet";
  int result;
  expected_data = packet; expected_length = sizeof(packet);
  for (scenario = 1; scenario <= 12; scenario++) {
    cancelled = last_error = sends = waits = warnings = stats_reads = 0;
    monotonic_us = 100;
    last_warning[0] = 0;
    result = rh_srt_listener_send (&object, &caller, packet, sizeof(packet));
    if (scenario == 1) assert(result == sizeof(packet) && sends == 1 && waits == 0);
    if (scenario == 2) assert(result == sizeof(packet) && sends == 2 && waits == 1);
    if (scenario == 3) assert(result == SRT_ERROR && sends == 1 && waits == 0);
    if (scenario == 4) assert(result == RH_SRT_SEND_CANCELLED && sends == 3 && waits == 3);
    if (scenario == 5) assert(result == SRT_ERROR && sends == 1 && waits == 1);
    if (scenario == 6) assert(result == RH_SRT_SEND_SOCKET_ERROR && sends == 1 && waits == 1);
    if (scenario == 7) assert(result == RH_SRT_SEND_CANCELLED && sends == 1 && waits == 1);
    /* No writable event occurs in cases 8-12. Recovery requires retrying send
     * after a timeout, and still uses the original pointer/length every time. */
    if (scenario == 8) assert(result == sizeof(packet) && sends == 3 && waits == 2);
    if (scenario == 9 || scenario == 12) assert(result == sizeof(packet) && sends == 13 && waits == 12 && warnings == 1 && stats_reads == 1);
    if (scenario == 10) assert(result == sizeof(packet) && sends == 24 && waits == 23 && warnings == 2 && stats_reads == 2);
    if (scenario == 11) assert(result == SRT_ERROR && sends == 3 && waits == 2 && last_error == 2001);
    if (scenario < 9 || scenario == 11) assert(warnings == 0 && stats_reads == 0);
    if (scenario == 9) assert(strstr(last_warning, "RH_SRT_WAIT {\"waitMs\":1000,\"statsAvailable\":true,"));
    if (scenario == 12) assert(strstr(last_warning, "\"statsAvailable\":false,"));
  }
  cancelled = 1; sends = waits = 0;
  assert(rh_srt_listener_send (&object, &caller, packet, sizeof(packet)) == RH_SRT_SEND_CANCELLED);
  assert(sends == 0 && waits == 0);
  puts("13 native listener backpressure cases passed");
  return 0;
}
