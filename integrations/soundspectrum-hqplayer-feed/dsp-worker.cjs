'use strict';
const { AnalysisDsp, MAX_PCM_BYTES } = require('./dsp.cjs');

// Owned child, not a thread whose OS priority would change the parent process.
// It never opens a network socket, source file, device or HQPlayer controller.
function run() {
  const dsp = new AnalysisDsp();
  process.on('disconnect', () => process.exit(0));
  process.on('message', message => {
    if (message?.type === 'close') { process.disconnect(); return; }
    if (message?.type !== 'frames') return;
    try {
      if (!Number.isSafeInteger(message.epoch) || !Array.isArray(message.frames) || !message.frames.length || message.frames.length > 12) throw Error('Invalid analysis work batch.');
      const pcm = []; let size = 0, resets = 0;
      for (const frame of message.frames) {
        const result = dsp.process(frame.bytes, frame.sequence); size += result.pcm.length;
        if (size > MAX_PCM_BYTES) throw Error('Derived analysis batch exceeded its bound.');
        pcm.push(result.pcm); resets += result.discontinuity ? 1 : 0;
      }
      process.send?.({ type: 'pcm', epoch: message.epoch, sequence: message.frames.at(-1).sequence,
        pcm: Buffer.concat(pcm, size), resets }, () => {});
    } catch {
      dsp.reset(); process.send?.({ type: 'failure', epoch: message.epoch, sequence: message.frames?.at?.(-1)?.sequence,
        reason: 'HQPlayer supplied unsupported or invalid analysis data.' }, () => {});
    }
  });
  process.send?.({ type: 'ready' }, () => {});
}

module.exports = { run };
if (require.main === module) run();
