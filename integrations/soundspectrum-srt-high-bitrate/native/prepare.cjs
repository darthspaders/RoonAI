'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'data/soundspectrum-srt-high-bitrate/patched-plugin/build');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'upstream-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (manifest.version !== '1.26.11') throw Error('Unexpected upstream version');
fs.mkdirSync(output, { recursive: true });
for (const record of manifest.files) {
  if (path.basename(record.file) !== record.file) throw Error('Invalid source name');
  const bytes = fs.readFileSync(path.join(__dirname, 'upstream', record.file));
  if (digest(bytes) !== record.sha256) throw Error(`Pinned source hash mismatch: ${record.file}`);
  fs.writeFileSync(path.join(output, record.file), bytes);
}
const once = (text, before, after) => {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw Error('Pinned patch context mismatch');
  return text.slice(0, at) + after + text.slice(at + before.length);
};
const file = path.join(output, 'gstsrtobject.c');
const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const start = original.indexOf('static gssize\ngst_srt_object_write_to_callers');
const end = original.indexOf('static gssize\ngst_srt_object_write_one', start);
if (start < 0 || end < start) throw Error('Pinned listener boundary mismatch');
let listener = original.slice(start, end);
listener = once(listener,
  'sent = srt_sendmsg2 (caller->sock, (char *) (msg + len), rest, 0);',
  'sent = rh_srt_listener_send (srtobject, caller, (char *) (msg + len), rest);');
listener = once(listener,
  'if (sent < 0) {\n        GST_WARNING_OBJECT (srtobject->element, "Dropping caller %d: %s",\n            caller->sock, srt_getlasterror_str ());\n        goto err;\n      }',
  'if (sent < 0) {\n        if (sent == RH_SRT_SEND_CANCELLED)\n          goto cancelled;\n        if (sent == RH_SRT_SEND_SOCKET_ERROR)\n          GST_WARNING_OBJECT (srtobject->element,\n              "Dropping caller %d: socket failed during writable wait", caller->sock);\n        else\n          GST_WARNING_OBJECT (srtobject->element, "Dropping caller %d: %s",\n              caller->sock, srt_getlasterror_str ());\n        goto err;\n      }');
let patched = original.slice(0, start) + '#include "listener-backpressure.h"\n\n' + listener + original.slice(end);
patched = once(patched,
  'GST_DEBUG_OBJECT (srtobject->element, "waking up SRT");\n\n  /* connection',
  'GST_DEBUG_OBJECT (srtobject->element, "waking up SRT");\n\n  /* A listener may hold sock_lock while waiting for writable room. Wake that\n   * wait before acquiring its lock. The protected cancellation below remains\n   * in place to preserve upstream flushing/signal ordering. */\n  g_cancellable_cancel (srtobject->cancellable);\n\n  /* connection');
fs.writeFileSync(file, patched);
for (const name of ['listener-backpressure.h', 'listener-backpressure.test.c', 'listener-stop.test.c', 'listener-recovery.test.c', 'gstsrt-enumtypes.h', 'gstsrt-enumtypes.c'])
  fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
fs.writeFileSync(path.join(output, 'config.h'), [
  '#define VERSION "1.26.11.2"',
  '#define PACKAGE "gst-plugins-bad"',
  '#define GST_LICENSE "LGPL"',
  '#define GST_PACKAGE_NAME "Rabbit Hole isolated SRT listener backpressure repair"',
  '#define GST_PACKAGE_ORIGIN "https://gstreamer.freedesktop.org/"',
  '#define GST_PACKAGE_RELEASE_DATETIME "2026-03-10"',
  ''
].join('\n'));
console.log(JSON.stringify({ revision: 'listener-backpressure-2', output, upstreamVersion: '1.26.11',
  pluginVersion: '1.26.11.2', patchedObjectSha256: digest(Buffer.from(patched)) }));
