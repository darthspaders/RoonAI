/* Enum registration for the two enums in pinned upstream gstsrt-enums.h.
 * Equivalent to gnome.mkenums_simple used by the upstream Meson build.
 * SPDX-License-Identifier: LGPL-2.0-or-later */
#include "gstsrt-enums.h"
#include "gstsrt-enumtypes.h"
GType
gst_srt_connection_mode_get_type (void)
{
  static gsize type = 0;
  if (g_once_init_enter (&type)) {
    static const GEnumValue values[] = {
      { GST_SRT_CONNECTION_MODE_NONE, "GST_SRT_CONNECTION_MODE_NONE", "none" },
      { GST_SRT_CONNECTION_MODE_CALLER, "GST_SRT_CONNECTION_MODE_CALLER", "caller" },
      { GST_SRT_CONNECTION_MODE_LISTENER, "GST_SRT_CONNECTION_MODE_LISTENER", "listener" },
      { GST_SRT_CONNECTION_MODE_RENDEZVOUS, "GST_SRT_CONNECTION_MODE_RENDEZVOUS", "rendezvous" },
      { 0, NULL, NULL }
    };
    GType registered = g_enum_register_static ("GstSRTConnectionMode", values);
    g_once_init_leave (&type, registered);
  }
  return (GType) type;
}
GType
gst_srt_key_length_get_type (void)
{
  static gsize type = 0;
  if (g_once_init_enter (&type)) {
    static const GEnumValue values[] = {
      { GST_SRT_KEY_LENGTH_NO_KEY, "GST_SRT_KEY_LENGTH_NO_KEY", "no-key" },
      { GST_SRT_KEY_LENGTH_0, "GST_SRT_KEY_LENGTH_0", "0" },
      { GST_SRT_KEY_LENGTH_16, "GST_SRT_KEY_LENGTH_16", "16" },
      { GST_SRT_KEY_LENGTH_24, "GST_SRT_KEY_LENGTH_24", "24" },
      { GST_SRT_KEY_LENGTH_32, "GST_SRT_KEY_LENGTH_32", "32" },
      { 0, NULL, NULL }
    };
    GType registered = g_enum_register_static ("GstSRTKeyLength", values);
    g_once_init_leave (&type, registered);
  }
  return (GType) type;
}
