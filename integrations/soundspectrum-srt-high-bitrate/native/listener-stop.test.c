/* Actual GStreamer/GLib/libsrt stop under send backpressure.
 * A loopback peer connects but never reads. No capture or audio is involved.
 * SPDX-License-Identifier: LGPL-2.0-or-later */
#include <gst/gst.h>
#include <srt/srt.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static gint backpressure_seen;
static void
observe_log (GstDebugCategory * category, GstDebugLevel level, const gchar * file,
    const gchar * function, gint line, GObject * object, GstDebugMessage * message,
    gpointer unused)
{
  (void) category; (void) level; (void) file; (void) function;
  (void) line; (void) object; (void) unused;
  if (strstr (gst_debug_message_get (message),
          "Waiting for SRT caller send buffer capacity"))
    g_atomic_int_inc (&backpressure_seen);
}
static gpointer
feed (gpointer data)
{
  GstElement * source = data;
  for (;;) {
    GstBuffer * buffer = gst_buffer_new_allocate (NULL, 1316, NULL);
    GstFlowReturn result;
    gst_buffer_memset (buffer, 0, 0, 1316);
    g_signal_emit_by_name (source, "push-buffer", buffer, &result);
    gst_buffer_unref (buffer);
    if (result != GST_FLOW_OK)
      break;
  }
  return NULL;
}
int
main (int argc, char ** argv)
{
  GstElement * pipeline, *source;
  GThread * producer;
  GError * error = NULL;
  SRTSOCKET peer;
  struct sockaddr_in address;
  int receive_buffer = 131600, latency = 250;
  gboolean drop = FALSE;
  gint64 deadline, start, elapsed;
  gchar * description;
  int port;
  if (argc != 2 || (port = atoi (argv[1])) < 1024 || port > 65535)
    return 2;
  gst_init (&argc, &argv);
  gst_debug_set_threshold_for_name ("srtobject", GST_LEVEL_DEBUG);
  gst_debug_add_log_function (observe_log, NULL, NULL);
  description = g_strdup_printf (
      "appsrc name=Feed is-live=true block=true max-bytes=2632 format=time ! "
      "srtsink uri=srt://127.0.0.1:%d?mode=listener&sndbuf=131600&fc=8192&payloadsize=1316 "
      "latency=250 wait-for-connection=true auto-reconnect=false sync=false async=false", port);
  pipeline = gst_parse_launch (description, &error);
  g_free (description);
  if (!pipeline || error) return 3;
  source = gst_bin_get_by_name (GST_BIN (pipeline), "Feed");
  if (gst_element_set_state (pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE)
    return 4;
  srt_startup ();
  peer = srt_create_socket ();
  if (peer == SRT_INVALID_SOCK) return 5;
  if (srt_setsockopt (peer, 0, SRTO_RCVBUF, &receive_buffer, sizeof(receive_buffer)) ||
      srt_setsockopt (peer, 0, SRTO_LATENCY, &latency, sizeof(latency)) ||
      srt_setsockopt (peer, 0, SRTO_TLPKTDROP, &drop, sizeof(drop))) return 6;
  memset (&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons ((unsigned short) port);
  address.sin_addr.s_addr = htonl (0x7f000001);
  if (srt_connect (peer, (struct sockaddr *) &address, sizeof(address))) return 7;
  producer = g_thread_new ("bounded-feed", feed, source);
  deadline = g_get_monotonic_time () + 3000000;
  while (!g_atomic_int_get (&backpressure_seen) && g_get_monotonic_time () < deadline)
    g_usleep (1000);
  if (!g_atomic_int_get (&backpressure_seen)) return 8;
  start = g_get_monotonic_time ();
  gst_element_set_state (pipeline, GST_STATE_NULL);
  g_thread_join (producer);
  elapsed = g_get_monotonic_time () - start;
  srt_close (peer);
  srt_cleanup ();
  gst_object_unref (source);
  gst_object_unref (pipeline);
  printf ("{\"backpressureObserved\":true,\"stopMilliseconds\":%.3f,\"passed\":%s}\n",
      elapsed / 1000.0, elapsed < 2000000 ? "true" : "false");
  return elapsed < 2000000 ? 0 : 9;
}
