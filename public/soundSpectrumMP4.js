"use strict";
// Narrow, bounded demuxer for our single-video-track MediaMTX fMP4 output.
// Unsupported layouts fail closed instead of guessing timestamps or offsets.
((scope) => {
  function parser(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const need = (p, n, end = b.length) => { if (!Number.isSafeInteger(p) || p < 0 || p + n > end) throw Error("Invalid MP4 bounds"); };
    const u32 = p => { need(p, 4); return v.getUint32(p); };
    const u64 = p => { const n = u32(p) * 4294967296 + u32(p + 4); if (!Number.isSafeInteger(n)) throw Error("MP4 timestamp too large"); return n; };
    function boxes(start = 0, end = b.length) {
      const result = [];
      for (let p = start; p < end;) {
        need(p, 8, end); let size = u32(p), header = 8;
        if (size === 1) { need(p, 16, end); size = u64(p + 8); header = 16; }
        if (size === 0) size = end - p;
        if (size < header || result.length > 10000) throw Error("Invalid MP4 box");
        need(p, size, end);
        result.push({ type: String.fromCharCode(...b.subarray(p + 4, p + 8)), start: p, data: p + header, end: p + size }); p += size;
      }
      return result;
    }
    const child = (parent, type) => { const box = boxes(parent.data, parent.end).find(x => x.type === type); if (!box) throw Error("Missing MP4 " + type); return box; };
    return { b, v, need, u32, u64, boxes, child };
  }
  function init(input) {
    const p = parser(input), { b, v, u32, boxes, child, need } = p;
    const moov = boxes().find(x => x.type === "moov"); if (!moov) throw Error("Missing MP4 init");
    const tracks = boxes(moov.data, moov.end).filter(x => x.type === "trak");
    if (tracks.length !== 1) throw Error("Expected one video track");
    const tkhd = child(tracks[0], "tkhd"), mdia = child(tracks[0], "mdia"), mdhd = child(mdia, "mdhd");
    const trackId = u32(tkhd.data + (b[tkhd.data] === 1 ? 20 : 12));
    const timescale = u32(mdhd.data + (b[mdhd.data] === 1 ? 20 : 12));
    const stsd = child(child(child(mdia, "minf"), "stbl"), "stsd");
    if (u32(stsd.data + 4) !== 1) throw Error("Multiple sample descriptions");
    const entry = boxes(stsd.data + 8, stsd.end)[0];
    if (!entry || !["avc1", "avc3"].includes(entry.type)) throw Error("Expected H.264 video");
    need(entry.start, 86, entry.end);
    const width = v.getUint16(entry.start + 32), height = v.getUint16(entry.start + 34);
    if (!timescale || !width || !height || width > 8192 || height > 8192) throw Error("Invalid video dimensions");
    const avcC = boxes(entry.start + 86, entry.end).find(x => x.type === "avcC");
    if (!avcC || avcC.end - avcC.data < 7) throw Error("Missing AVC configuration");
    const description = b.slice(avcC.data, avcC.end);
    const codec = "avc1." + [...description.subarray(1, 4)].map(n => n.toString(16).padStart(2, "0")).join("");
    const trex = child(child(moov, "mvex"), "trex");
    if (u32(trex.data + 4) !== trackId) throw Error("Track mismatch");
    return { trackId, timescale, codec, codedWidth: width, codedHeight: height, description,
      duration: u32(trex.data + 12), size: u32(trex.data + 16), flags: u32(trex.data + 20) };
  }
  function samples(input, track) {
    const p = parser(input), { b, v, u32, u64, boxes, child, need } = p;
    const top = boxes(), result = [];
    const media = top.filter(x => x.type === "mdat");
    for (const moof of top.filter(x => x.type === "moof")) {
      const trafs = boxes(moof.data, moof.end).filter(x => x.type === "traf");
      if (trafs.length !== 1) throw Error("Multiple fragment tracks");
      const traf = trafs[0], tfhd = child(traf, "tfhd"), tfdt = child(traf, "tfdt");
      const flags = u32(tfhd.data) & 0xffffff;
      if (u32(tfhd.data + 4) !== track.trackId || !(flags & 0x20000) || flags & 1) throw Error("Unsupported fragment base");
      let at = tfhd.data + 8, duration = track.duration, size = track.size, sampleFlags = track.flags;
      if (flags & 2) { if (u32(at) !== 1) throw Error("Sample description changed"); at += 4; }
      if (flags & 8) { duration = u32(at); at += 4; }
      if (flags & 16) { size = u32(at); at += 4; }
      if (flags & 32) { sampleFlags = u32(at); at += 4; }
      need(tfhd.data, at - tfhd.data, tfhd.end);
      let dts = b[tfdt.data] === 1 ? u64(tfdt.data + 4) : u32(tfdt.data + 4), previousEnd = null;
      for (const run of boxes(traf.data, traf.end).filter(x => x.type === "trun")) {
        const rf = u32(run.data) & 0xffffff, count = u32(run.data + 4); at = run.data + 8;
        if (count > 10000 || result.length + count > 10000) throw Error("Too many samples");
        let offset = previousEnd, firstFlags = sampleFlags;
        if (rf & 1) { need(at, 4, run.end); offset = moof.start + v.getInt32(at); at += 4; }
        if (rf & 4) { firstFlags = u32(at); at += 4; }
        if (offset === null) throw Error("Missing sample offset");
        for (let i = 0; i < count; i++) {
          let dt = duration, bytes = size, sf = i === 0 ? firstFlags : sampleFlags, cts = 0;
          if (rf & 0x100) { dt = u32(at); at += 4; }
          if (rf & 0x200) { bytes = u32(at); at += 4; }
          if (rf & 0x400) { sf = u32(at); at += 4; }
          if (rf & 0x800) { cts = b[run.data] === 1 ? v.getInt32(at) : u32(at); at += 4; }
          need(run.data, at - run.data, run.end);
          if (!dt || !bytes || !media.some(m => offset >= m.data && offset + bytes <= m.end)) throw Error("Invalid sample payload");
          const timestamp = Math.round((dts + cts) * 1000000 / track.timescale);
          if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw Error("Invalid sample time");
          result.push({ timestamp, duration: Math.round(dt * 1000000 / track.timescale), key: !(sf & 0x10000), data: b.subarray(offset, offset + bytes) });
          offset += bytes; dts += dt;
        }
        previousEnd = offset;
      }
    }
    if (!result.length) throw Error("No video samples");
    return result;
  }
  const api = { init, samples };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else scope.SoundSpectrumMP4 = api;
})(globalThis);
