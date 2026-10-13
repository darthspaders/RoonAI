/* Real libsrt/GStreamer recovery with receiver ACKs withheld by a loopback
 * UDP proxy. The receiver still drains and all other control traffic passes.
 * No capture, decoder, native visualizer, audio, or application API is used.
 * SPDX-License-Identifier: LGPL-2.0-or-later */
#include <winsock2.h>
#include <gst/gst.h>
#include <srt/srt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static gint stopping, suppress_acks, suppressed_acks, pressure_count;
static gint accepted, received_unique, latest_sequence, send_drop_total;
static gint owned_caller_socket = -1;
static SRTSOCKET peer = -1;
static SOCKET proxy_socket = INVALID_SOCKET;
static struct sockaddr_in target_address;

static void
observe_log (GstDebugCategory * category, GstDebugLevel level, const gchar * file,
    const gchar * function, gint line, GObject * object, GstDebugMessage * message,
    gpointer unused)
{
  const gchar * text = gst_debug_message_get (message), *field;
  gint socket;
  (void) category; (void) level; (void) file; (void) function;
  (void) line; (void) object; (void) unused;
  if (strstr (text, "Waiting for SRT caller send buffer capacity"))
    g_atomic_int_inc (&pressure_count);
  /* The callback observes only this isolated process's one listener. The
   * internal socket handle remains in memory and is never printed. */
  if (sscanf (text, "Accept to connect %d", &socket) == 1 && socket >= 0)
    g_atomic_int_set (&owned_caller_socket, socket);
  if (strstr (text, "RH_SRT_WAIT ") && (field = strstr (text, "\"dropTotal\":"))) {
    gint dropped = atoi (field + strlen ("\"dropTotal\":"));
    if (dropped > g_atomic_int_get (&send_drop_total))
      g_atomic_int_set (&send_drop_total, dropped);
  }
}

static gpointer
proxy_loop (gpointer unused)
{
  struct sockaddr_in from, receiver_address;
  gboolean known_receiver = FALSE;
  char packet[2048];
  (void) unused;
  while (!g_atomic_int_get (&stopping)) {
    fd_set ready;
    struct timeval timeout = { 0, 10000 };
    int from_length = sizeof(from), length;
    FD_ZERO (&ready); FD_SET (proxy_socket, &ready);
    if (select (0, &ready, NULL, NULL, &timeout) <= 0)
      continue;
    length = recvfrom (proxy_socket, packet, sizeof(packet), 0,
        (struct sockaddr *) &from, &from_length);
    if (length <= 0 || from.sin_addr.s_addr != htonl (0x7f000001))
      continue;
    if (from.sin_port == target_address.sin_port) {
      if (known_receiver)
        sendto (proxy_socket, packet, length, 0,
            (struct sockaddr *) &receiver_address, sizeof(receiver_address));
    } else {
      if (known_receiver && from.sin_port != receiver_address.sin_port)
        continue;
      receiver_address = from; known_receiver = TRUE;
      /* SRT control bit and control type 0x0002: receiver -> sender ACK.
       * Handshakes, keepalives, NAKs, ACKACKs, and data are never suppressed. */
      if (g_atomic_int_get (&suppress_acks) && length >= 16 &&
          (unsigned char) packet[0] == 0x80 && (unsigned char) packet[1] == 0x02) {
        g_atomic_int_inc (&suppressed_acks);
        continue;
      }
      sendto (proxy_socket, packet, length, 0,
          (struct sockaddr *) &target_address, sizeof(target_address));
    }
  }
  return NULL;
}

static gpointer
read_peer (gpointer unused)
{
  char packet[2048];
  (void) unused;
  while (!g_atomic_int_get (&stopping)) {
    int length = srt_recvmsg2 (peer, packet, sizeof(packet), NULL);
    if (length >= 4) {
      guint32 sequence;
      memcpy (&sequence, packet, sizeof(sequence));
      sequence = ntohl (sequence);
      if (sequence > (guint32) g_atomic_int_get (&latest_sequence)) {
        g_atomic_int_set (&latest_sequence, (gint) sequence);
        g_atomic_int_inc (&received_unique);
      }
    }
  }
  return NULL;
}

static gpointer
feed (gpointer data)
{
  GstElement * source = data;
  guint32 sequence = 0;
  for (;;) {
    GstBuffer * buffer = gst_buffer_new_allocate (NULL, 1316, NULL);
    guint32 encoded_sequence = htonl (++sequence);
    GstFlowReturn result;
    gst_buffer_memset (buffer, 0, 0, 1316);
    gst_buffer_fill (buffer, 0, &encoded_sequence, sizeof(encoded_sequence));
    g_signal_emit_by_name (source, "push-buffer", buffer, &result);
    gst_buffer_unref (buffer);
    if (result != GST_FLOW_OK)
      break;
    g_atomic_int_inc (&accepted);
  }
  return NULL;
}

int
main (int argc, char ** argv)
{
  GstElement * pipeline, *source;
  GThread * producer, *proxy_thread, *reader;
  GError * error = NULL;
  struct sockaddr_in proxy_address;
  int port, proxy_port, latency = 120, receive_timeout = 100, peer_timeout = 5000;
  gboolean drop = TRUE, expect_recovery;
  gint64 deadline, suppressed_at, measured_at, stop_at, stop_us;
  gint accepted_before, unique_before, accepted_delta, unique_delta;
  gboolean connected, passed, stats_read;
  SRT_TRACEBSTATS sender_stats = { 0 };
  gchar * description;
  if (argc != 4 || (port = atoi(argv[1])) < 1024 || port > 65535 ||
      (proxy_port = atoi(argv[2])) < 1024 || proxy_port > 65535 || port == proxy_port ||
      (strcmp(argv[3], "recover") && strcmp(argv[3], "stall")))
    return 2;
  expect_recovery = !strcmp(argv[3], "recover");
  gst_init (&argc, &argv);
  gst_debug_set_threshold_for_name ("srtobject", GST_LEVEL_DEBUG);
  gst_debug_add_log_function (observe_log, NULL, NULL);
  srt_startup ();
  memset (&target_address, 0, sizeof(target_address));
  target_address.sin_family = AF_INET;
  target_address.sin_port = htons ((unsigned short) port);
  target_address.sin_addr.s_addr = htonl (0x7f000001);
  proxy_address = target_address;
  proxy_address.sin_port = htons ((unsigned short) proxy_port);
  proxy_socket = socket (AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (proxy_socket == INVALID_SOCKET || bind (proxy_socket,
          (struct sockaddr *) &proxy_address, sizeof(proxy_address))) return 3;
  proxy_thread = g_thread_new ("ack-filter-proxy", proxy_loop, NULL);
  description = g_strdup_printf (
      "appsrc name=Feed is-live=true block=true max-bytes=2632 format=time ! "
      "srtsink uri=srt://127.0.0.1:%d?mode=listener&sndbuf=131600&fc=8192&payloadsize=1316&maxbw=12500000&tlpktdrop=true&snddropdelay=0 "
      "latency=120 wait-for-connection=true auto-reconnect=false sync=false async=false", port);
  pipeline = gst_parse_launch (description, &error);
  g_free (description);
  if (!pipeline || error) return 4;
  source = gst_bin_get_by_name (GST_BIN(pipeline), "Feed");
  if (gst_element_set_state (pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE)
    return 5;
  peer = srt_create_socket ();
  if (peer == SRT_INVALID_SOCK ||
      srt_setsockopt (peer, 0, SRTO_LATENCY, &latency, sizeof(latency)) ||
      srt_setsockopt (peer, 0, SRTO_TLPKTDROP, &drop, sizeof(drop)) ||
      srt_setsockopt (peer, 0, SRTO_RCVTIMEO, &receive_timeout, sizeof(receive_timeout)) ||
      srt_setsockopt (peer, 0, SRTO_PEERIDLETIMEO, &peer_timeout, sizeof(peer_timeout)))
    return 6;
  if (srt_connect (peer, (struct sockaddr *) &proxy_address, sizeof(proxy_address)))
    return 7;
  reader = g_thread_new ("draining-receiver", read_peer, NULL);
  producer = g_thread_new ("bounded-feed", feed, source);
  deadline = g_get_monotonic_time () + 3000000;
  while (g_atomic_int_get (&received_unique) < 100 && g_get_monotonic_time () < deadline)
    g_usleep (1000);
  if (g_atomic_int_get (&received_unique) < 100) return 8;
  suppressed_at = g_get_monotonic_time ();
  g_atomic_int_set (&suppress_acks, 1);
  deadline = suppressed_at + 1000000;
  while (!g_atomic_int_get (&pressure_count) && g_get_monotonic_time () < deadline)
    g_usleep (1000);
  if (!g_atomic_int_get (&pressure_count)) return 9;
  /* Let in-flight ACKs/data drain before measuring accepted new messages. */
  g_usleep (200000);
  accepted_before = g_atomic_int_get (&accepted);
  unique_before = g_atomic_int_get (&received_unique);
  deadline = suppressed_at + 3200000;
  while (g_get_monotonic_time () < deadline)
    g_usleep (1000);
  measured_at = g_get_monotonic_time ();
  accepted_delta = g_atomic_int_get (&accepted) - accepted_before;
  unique_delta = g_atomic_int_get (&received_unique) - unique_before;
  connected = srt_getsockstate (peer) == SRTS_CONNECTED;
  /* Direct libsrt inspection avoids the public Gst stats getter's sock_lock.
   * Sample once at the comparison boundary; do not depend on a diagnostic
   * firing when a particular wait lasts slightly less than one second. */
  stats_read = g_atomic_int_get (&owned_caller_socket) >= 0 &&
      srt_bstats (g_atomic_int_get (&owned_caller_socket), &sender_stats, 0) == 0;
  if (stats_read)
    g_atomic_int_set (&send_drop_total, sender_stats.pktSndDropTotal);
  passed = connected && stats_read && g_atomic_int_get (&suppressed_acks) > 0 &&
      (expect_recovery ? accepted_delta > 10 && unique_delta > 10 &&
          g_atomic_int_get (&send_drop_total) > 0 : accepted_delta <= 2 && unique_delta == 0);
  g_atomic_int_set (&suppress_acks, 0);
  g_atomic_int_set (&stopping, 1);
  stop_at = g_get_monotonic_time ();
  gst_element_set_state (pipeline, GST_STATE_NULL);
  g_thread_join (producer);
  g_thread_join (reader);
  g_thread_join (proxy_thread);
  stop_us = g_get_monotonic_time () - stop_at;
  closesocket (proxy_socket);
  srt_close (peer); srt_cleanup ();
  gst_object_unref (source); gst_object_unref (pipeline);
  printf ("{\"expectedRecovery\":%s,\"backpressureObserved\":true,\"ackSuppressedMs\":%.3f,"
      "\"acksSuppressed\":%d,\"acceptedNewMessages\":%d,\"receivedNewMessages\":%d,"
      "\"sendDropTotal\":%d,\"directStatsRead\":%s,\"peerStayedConnected\":%s,\"stopMilliseconds\":%.3f,\"passed\":%s}\n",
      expect_recovery ? "true" : "false", (measured_at - suppressed_at) / 1000.0,
      g_atomic_int_get (&suppressed_acks), accepted_delta, unique_delta,
      g_atomic_int_get (&send_drop_total), stats_read ? "true" : "false", connected ? "true" : "false",
      stop_us / 1000.0, passed && stop_us < 2000000 ? "true" : "false");
  return passed && stop_us < 2000000 ? 0 : 10;
}
