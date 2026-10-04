'use strict';

const fs = require('node:fs/promises');

// Bounded parallel range requests avoid a slow, single large Windows download.
// The setup script still verifies the completed file against upstream SHA-256.
async function downloadRuntime(url, target) {
  if (url !== 'https://gstreamer.freedesktop.org/data/pkg/windows/1.26.11/msvc/gstreamer-1.0-msvc-x86_64-1.26.11.msi') throw new Error('Only the pinned official GStreamer runtime can be downloaded.');
  const metadata = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  if (!metadata.ok) throw new Error(`GStreamer download metadata failed (${metadata.status}).`);
  const size = Number(metadata.headers.get('content-length'));
  if (!Number.isInteger(size) || size < 1000000 || size > 200000000) throw new Error('Unexpected GStreamer package size.');
  const file = await fs.open(target, 'w');
  await file.truncate(size);
  let next = 0;
  const controller = new AbortController();
  const chunkSize = 1024 * 1024;
  async function worker() {
    while (!controller.signal.aborted) {
      const start = next;
      next += chunkSize;
      if (start >= size) return;
      const end = Math.min(start + chunkSize, size) - 1;
      let buffer;
      for (let attempt = 0; attempt < 3; attempt++) {
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        controller.signal.addEventListener('abort', abortAttempt, { once: true });
        const timeout = setTimeout(abortAttempt, 30000);
        try {
          const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: attemptController.signal });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
            await response.body?.cancel();
            throw new Error('GStreamer server did not honor the bounded range request.');
          }
          buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length !== end - start + 1) throw new Error('Incomplete GStreamer download range.');
          break;
        } catch (error) {
          if (attempt === 2 || controller.signal.aborted) throw error;
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', abortAttempt);
        }
      }
      let written = 0;
      while (written < buffer.length) {
        const result = await file.write(buffer, written, buffer.length - written, start + written);
        if (!result.bytesWritten) throw new Error('GStreamer package write stalled.');
        written += result.bytesWritten;
      }
    }
  }
  try {
    const jobs = Array.from({ length: 8 }, worker);
    try { await Promise.all(jobs); }
    catch (error) { controller.abort(); await Promise.allSettled(jobs); throw error; }
  } finally {
    await file.close();
  }
}

module.exports = { downloadRuntime };
if (require.main === module) downloadRuntime(process.argv[2], process.argv[3]).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
