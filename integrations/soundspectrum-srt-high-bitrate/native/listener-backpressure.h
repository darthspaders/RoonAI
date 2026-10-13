/* Rabbit Hole SRT listener backpressure repair, 2026.
 * SPDX-License-Identifier: LGPL-2.0-or-later
 *
 * Included by the pinned upstream gstsrtobject.c immediately before its
 * listener write function. Only a transient full send buffer is retried.
 * The accepted caller already owns this writable/error epoll and cancellable
 * descriptor. No packet is discarded or advanced while waiting for room.
 */
#ifndef RH_SRT_LISTENER_BACKPRESSURE_H
#define RH_SRT_LISTENER_BACKPRESSURE_H

#define RH_SRT_SEND_CANCELLED (-2)
#define RH_SRT_SEND_SOCKET_ERROR (-3)
#define RH_SRT_SEND_WAIT_MS 100

/* Numeric-only diagnostics stay useful while the sink's streaming thread is
 * blocked. Do not query the public stats property here: it takes sock_lock,
 * which this listener already owns. A stats failure never removes a caller. */
static void
rh_srt_listener_wait_stats (GstSRTObject * object, SRTCaller * caller,
    gint64 waited_us)
{
  SRT_TRACEBSTATS stats = { 0 };
  gint available = srt_bstats (caller->sock, &stats, 0) == 0;
  gint state = srt_getsockstate (caller->sock);

  GST_WARNING_OBJECT (object->element,
      "RH_SRT_WAIT {\"waitMs\":%" G_GINT64_FORMAT
      ",\"statsAvailable\":%s,\"socketState\":%d,\"sendBufferBytes\":%d"
      ",\"sendBufferMs\":%d,\"flightPackets\":%d,\"flowPackets\":%d"
      ",\"ackTotal\":%d,\"nakTotal\":%d,\"retransTotal\":%d"
      ",\"dropTotal\":%d,\"uniqueBytes\":%" G_GUINT64_FORMAT "}",
      waited_us / 1000, available ? "true" : "false", state, stats.byteSndBuf, stats.msSndBuf,
      stats.pktFlightSize, stats.pktFlowWindow, stats.pktRecvACKTotal,
      stats.pktRecvNAKTotal, stats.pktRetransTotal, stats.pktSndDropTotal,
      (guint64) stats.byteSentUniqueTotal);
}

static gint
rh_srt_listener_send (GstSRTObject * object, SRTCaller * caller,
    const gchar * data, gint length)
{
  gint64 wait_started_us = 0, next_stats_us = 0;

  for (;;) {
    gint sent;

    if (g_cancellable_is_cancelled (object->cancellable))
      return RH_SRT_SEND_CANCELLED;

    sent = srt_sendmsg2 (caller->sock, data, length, NULL);
    if (sent >= 0)
      return sent;
    if (srt_getlasterror (NULL) != SRT_EASYNCSND)
      return SRT_ERROR;

    if (!wait_started_us) {
      wait_started_us = g_get_monotonic_time ();
      next_stats_us = wait_started_us + G_USEC_PER_SEC;
    }
    GST_DEBUG_OBJECT (object->element, "Waiting for SRT caller send buffer capacity");

    for (;;) {
      SRTSOCKET read_socket, write_socket;
      gint read_count = 1, write_count = 1;
      SYSSOCKET read_system, write_system;
      gint read_system_count = 1, write_system_count = 1;
      gint ready;

      if (g_cancellable_is_cancelled (object->cancellable))
        return RH_SRT_SEND_CANCELLED;

      /* Only sustained waits emit diagnostics, at most once per second. The
       * send error was classified above, before stats can alter last-error. */
      {
        gint64 now_us = g_get_monotonic_time ();
        if (now_us >= next_stats_us) {
          rh_srt_listener_wait_stats (object, caller, now_us - wait_started_us);
          next_stats_us = now_us + G_USEC_PER_SEC;
        }
      }

      ready = srt_epoll_wait (caller->poll_id, &read_socket, &read_count,
          &write_socket, &write_count, RH_SRT_SEND_WAIT_MS,
          &read_system, &read_system_count, &write_system, &write_system_count);

      if (g_cancellable_is_cancelled (object->cancellable))
        return RH_SRT_SEND_CANCELLED;

      if (ready < 0) {
        if (srt_getlasterror (NULL) == SRT_ETIMEOUT) {
          /* libsrt 1.5.4 evicts too-late buffered packets inside sendmsg2.
           * Waiting only for OUT can prevent that eviction forever when ACKs
           * stall. Retry this same packet after each bounded poll timeout. */
          break;
        }
        return SRT_ERROR;
      }

      /* This sink's caller subscribes only to OUT|ERR. Read readiness here
       * therefore denotes an error, including the socket in both sets. */
      if (read_count > 0)
        return RH_SRT_SEND_SOCKET_ERROR;
      if (write_count == 1 && write_socket == caller->sock)
        break;
    }
  }
}

#endif
