"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const FFMPEG_FORMATS = {
  ".flac": { muxer: "flac", status: "supported" },
  ".mp3": { muxer: "mp3", status: "supported" },
  ".m4a": { muxer: "ipod", status: "supported" },
  ".mp4": { muxer: "mp4", status: "supported" },
  ".wav": { muxer: "wav", status: "supported" },
  ".aif": { muxer: "aiff", status: "supported" },
  ".aiff": { muxer: "aiff", status: "supported" },
  ".ogg": { muxer: "ogg", status: "supported" },
  ".oga": { muxer: "ogg", status: "supported" },
  ".opus": { muxer: "ogg", status: "supported" },
  ".wv": { muxer: "wavpack", status: "supported" },
  ".dsf": { status: "supported", writer: "dsf-id3", reason: "DSF ID3 metadata writer" },
  ".dff": { status: "unsupported", reason: "No installed lossless DFF/DSDIFF tag writer is available." },
  ".ape": { status: "unsupported", reason: "No installed APE tag writer is available." },
  ".mka": { status: "unsupported", reason: "Matroska tag policy is not approved for this staged writer." }
};

function formatPolicy(filePath) {
  return FFMPEG_FORMATS[path.extname(filePath).toLowerCase()] || {
    status: "unsupported",
    reason: "No format-specific writer policy is configured."
  };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function tempFileFor(filePath, suffix = "tmp") {
  const ext = path.extname(filePath);
  return path.join(path.dirname(filePath), `.${path.basename(filePath, ext)}.rabbit-hole-${process.pid}-${crypto.randomBytes(8).toString("hex")}.${suffix}${ext}`);
}

function metadataArguments(changes = []) {
  return changes.flatMap((change) => ["-metadata", `${change.tag}=${String(change.value)}`]);
}

const DSF_FRAME_MAP = {
  ARTIST: "TPE1",
  TITLE: "TIT2",
  ALBUM: "TALB",
  ALBUMARTIST: "TPE2",
  TRACKNUMBER: "TRCK",
  DISCNUMBER: "TPOS",
  DATE: "TDRC",
  GENRE: "TCON",
  LABEL: "TPUB",
  BPM: "TBPM",
  INITIALKEY: "TKEY",
  ISRC: "TSRC"
};

const DSF_TXXX_MAP = {
  CAMELOT: "CAMELOT",
  CATALOGNUMBER: "CATALOGNUMBER",
  SUBGENRE: "SUBGENRE"
};

function readSynchsafe(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f);
}

function writeSynchsafe(value) {
  const number = Math.max(0, Number(value) || 0);
  return Buffer.from([
    (number >> 21) & 0x7f,
    (number >> 14) & 0x7f,
    (number >> 7) & 0x7f,
    number & 0x7f
  ]);
}

function decodeId3Text(payload) {
  if (!payload?.length) return "";
  const encoding = payload[0];
  const data = payload.subarray(1);
  if (encoding === 1 || encoding === 2) {
    const text = encoding === 1 ? data.toString("utf16le") : Buffer.from(data).swap16().toString("utf16le");
    return text.replace(/^\uFEFF/, "").replace(/\u0000+$/g, "").trim();
  }
  return data.toString(encoding === 3 ? "utf8" : "latin1").replace(/\u0000+$/g, "").trim();
}

function encodeId3Text(value) {
  return Buffer.concat([
    Buffer.from([1, 0xff, 0xfe]),
    Buffer.from(`${String(value ?? "")}\u0000`, "utf16le")
  ]);
}

function encodeId3Txxx(description, value) {
  return Buffer.concat([
    Buffer.from([1, 0xff, 0xfe]),
    Buffer.from(`${description}\u0000`, "utf16le"),
    Buffer.from(`${String(value ?? "")}\u0000`, "utf16le")
  ]);
}

function buildId3Frame(id, payload, version = 3) {
  const size = version >= 4 ? writeSynchsafe(payload.length) : (() => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(payload.length, 0);
    return buffer;
  })();
  return Buffer.concat([Buffer.from(id, "ascii"), size, Buffer.from([0, 0]), payload]);
}

function parseId3Frames(tag) {
  const version = tag[3] || 3;
  const tagSize = readSynchsafe(tag, 6);
  const end = Math.min(tag.length, 10 + tagSize);
  const frames = [];
  let offset = 10;
  while (offset + 10 <= end) {
    const id = tag.toString("ascii", offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || id[0] === "\0") break;
    const size = version >= 4 ? readSynchsafe(tag, offset + 4) : tag.readUInt32BE(offset + 4);
    if (!size || offset + 10 + size > end) break;
    const payload = tag.subarray(offset + 10, offset + 10 + size);
    frames.push({ id, payload, raw: tag.subarray(offset, offset + 10 + size) });
    offset += 10 + size;
  }
  return { version, tagSize, frames };
}

function readDsfMetadata(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(28);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 4) !== "DSD ") {
      throw new Error("Not a DSF file.");
    }
    const fileSize = Number(header.readBigUInt64LE(12));
    const actualSize = fs.fstatSync(fd).size;
    if (fileSize < 28 || fileSize > actualSize) throw new Error(`DSF header file size is invalid: header=${fileSize}, actual=${actualSize}.`);
    const metadataOffset = Number(header.readBigUInt64LE(20));
    if (!metadataOffset || metadataOffset >= fileSize) return { header, fileSize, metadataOffset, tag: null, frames: [], version: 3 };
    if (metadataOffset + 10 > actualSize) throw new Error("DSF metadata pointer is outside the file.");
    const tagHeader = Buffer.alloc(10);
    if (fs.readSync(fd, tagHeader, 0, tagHeader.length, metadataOffset) !== tagHeader.length) throw new Error("Could not read the DSF ID3 header.");
    if (tagHeader.toString("ascii", 0, 3) !== "ID3") throw new Error("DSF metadata area does not contain an ID3 tag.");
    const tagLength = 10 + readSynchsafe(tagHeader, 6);
    if (metadataOffset + tagLength > actualSize) throw new Error("DSF ID3 tag extends beyond the file.");
    const tag = Buffer.alloc(tagLength);
    if (fs.readSync(fd, tag, 0, tag.length, metadataOffset) !== tag.length) throw new Error("Could not read the complete DSF ID3 tag.");
    const parsed = parseId3Frames(tag);
    return { header, fileSize, metadataOffset, tag, ...parsed };
  } finally {
    fs.closeSync(fd);
  }
}

function dsfChangeFrame(change) {
  const tag = String(change.tag || "").toUpperCase();
  if (DSF_FRAME_MAP[tag]) return { id: DSF_FRAME_MAP[tag], payload: encodeId3Text(change.value) };
  if (DSF_TXXX_MAP[tag]) return { id: "TXXX", description: DSF_TXXX_MAP[tag], payload: encodeId3Txxx(DSF_TXXX_MAP[tag], change.value) };
  return null;
}

function buildDsfId3Tag(metadata, changes) {
  const updates = new Map();
  const txxxUpdates = new Map();
  for (const change of changes) {
    const frame = dsfChangeFrame(change);
    if (!frame) continue;
    if (frame.id === "TXXX") txxxUpdates.set(frame.description, frame.payload);
    else updates.set(frame.id, frame.payload);
  }
  const used = new Set();
  const frames = [];
  for (const frame of metadata.frames || []) {
    if (updates.has(frame.id)) {
      if (!used.has(frame.id)) {
        frames.push(buildId3Frame(frame.id, updates.get(frame.id), metadata.version));
        used.add(frame.id);
      }
      continue;
    }
    if (frame.id === "TXXX") {
      const text = decodeId3Text(frame.payload);
      const description = text.split("\u0000")[0];
      if (txxxUpdates.has(description)) {
        if (!used.has(`TXXX:${description}`)) {
          frames.push(buildId3Frame("TXXX", txxxUpdates.get(description), metadata.version));
          used.add(`TXXX:${description}`);
        }
        continue;
      }
    }
    frames.push(frame.raw);
  }
  for (const [id, payload] of updates) if (!used.has(id)) frames.push(buildId3Frame(id, payload, metadata.version));
  for (const [description, payload] of txxxUpdates) if (!used.has(`TXXX:${description}`)) frames.push(buildId3Frame("TXXX", payload, metadata.version));
  const body = Buffer.concat(frames);
  const header = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.from([metadata.version || 3, 0, 0]), writeSynchsafe(body.length)]);
  return Buffer.concat([header, body]);
}

function dsfTagValues(metadata) {
  const values = {};
  const frameToTag = new Map(Object.entries(DSF_FRAME_MAP).map(([tag, frameId]) => [frameId, tag]));
  for (const frame of metadata.frames || []) {
    if (frameToTag.has(frame.id)) values[frameToTag.get(frame.id)] = decodeId3Text(frame.payload);
    if (frame.id === "TXXX") {
      const text = decodeId3Text(frame.payload);
      const [description, ...valueParts] = text.split("\u0000");
      if (description) values[`TXXX:${description}`] = valueParts.join("\u0000");
    }
  }
  return values;
}

async function writeDsfFileTags(filePath, changes, {
  backupDirectory = path.join(process.cwd(), "data", "local-library-tag-write-backups"),
  journalPath = path.join(process.cwd(), "data", "local-library-tag-write-journal.json"),
  expectedFileHash = "",
  ffprobePath = "ffprobe",
  execFileImpl = execFileAsync,
  logger = console
} = {}) {
  const resolvedPath = path.resolve(filePath);
  const safeChanges = (changes || []).filter((change) => change?.decision === "safe_fill");
  if (!safeChanges.length) throw new Error("No safe-fill metadata changes were supplied.");
  const beforeHash = await hashFile(resolvedPath);
  if (expectedFileHash && beforeHash !== expectedFileHash) throw new Error(`File hash changed since preview: expected ${expectedFileHash}, found ${beforeHash}.`);
  const metadata = readDsfMetadata(resolvedPath);
  const actualFileSize = fs.statSync(resolvedPath).size;
  if (actualFileSize !== metadata.fileSize) throw new Error(`DSF file size changed during inspection: header=${metadata.fileSize}, actual=${actualFileSize}.`);
  const newTag = buildDsfId3Tag(metadata, safeChanges);
  if (!newTag.length) throw new Error("No DSF-supported metadata changes were supplied.");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `${beforeHash}.dsf`);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(resolvedPath, backupPath);
  const journal = {
    version: 1,
    status: "prepared",
    writer: "dsf-id3",
    targetPath: resolvedPath,
    backupPath,
    beforeHash,
    changes: safeChanges,
    startedAt: new Date().toISOString()
  };
  writeJournal(journalPath, journal);
  try {
    const oldTagLength = metadata.tag?.length || 0;
    const fd = fs.openSync(resolvedPath, "r+");
    try {
      if (metadata.tag && newTag.length <= oldTagLength) {
        const padded = Buffer.concat([newTag, Buffer.alloc(oldTagLength - newTag.length)]);
        fs.writeSync(fd, padded, 0, padded.length, metadata.metadataOffset);
      } else {
        const newOffset = metadata.fileSize;
        fs.writeSync(fd, newTag, 0, newTag.length, newOffset);
        const header = Buffer.alloc(16);
        header.writeBigUInt64LE(BigInt(newOffset + newTag.length), 0);
        header.writeBigUInt64LE(BigInt(newOffset), 8);
        fs.writeSync(fd, header, 0, header.length, 12);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const validation = readDsfMetadata(resolvedPath);
    const values = dsfTagValues(validation);
    for (const change of safeChanges) {
      const frame = dsfChangeFrame(change);
      if (frame?.id && frame.id !== "TXXX" && values[String(change.tag).toUpperCase()] !== String(change.value)) throw new Error(`DSF output did not contain expected ${change.tag} tag.`);
      if (frame?.id === "TXXX" && values[`TXXX:${frame.description}`] !== String(change.value)) throw new Error(`DSF output did not contain expected ${change.tag} tag.`);
    }
    await probeAudio(resolvedPath, { ffprobePath, execFileImpl });
    journal.status = "committed";
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    fs.rmSync(journalPath, { force: true });
    return {
      filePath: resolvedPath,
      format: ".dsf",
      writer: "dsf-id3",
      beforeHash,
      afterHash: await hashFile(resolvedPath),
      backupPath,
      changes: safeChanges,
      status: "written"
    };
  } catch (error) {
    try {
      fs.copyFileSync(backupPath, resolvedPath);
      const restoredHash = await hashFile(resolvedPath);
      if (restoredHash !== beforeHash) throw new Error(`Restored DSF hash mismatch: expected ${beforeHash}, found ${restoredHash}.`);
    } catch (restoreError) {
      logger?.error?.(`Could not restore DSF original for ${resolvedPath}: ${restoreError.message}`);
    }
    journal.status = "failed_after_backup";
    journal.error = error.message;
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    logger?.error?.(`DSF write failed for ${resolvedPath}; exact backup retained at ${backupPath}`);
    throw error;
  }
}

function buildFfmpegWriteArgs(filePath, outputPath, changes, policy = formatPolicy(filePath)) {
  if (policy.status !== "supported") throw new Error(policy.reason || `Unsupported audio format: ${path.extname(filePath)}`);
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-i", filePath,
    "-map", "0",
    "-map_metadata", "0",
    "-c", "copy",
    ...metadataArguments(changes),
    "-f", policy.muxer,
    outputPath
  ];
}

async function probeAudio(filePath, { ffprobePath = "ffprobe", execFileImpl = execFileAsync } = {}) {
  const result = await execFileImpl(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "--",
    filePath
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(result.stdout || "{}");
  const audio = Array.isArray(probe.streams) ? probe.streams.find((stream) => stream?.codec_type === "audio") : null;
  if (!audio) throw new Error("FFprobe validation found no audio stream.");
  return probe;
}

function probeTags(probe = {}) {
  const output = {};
  for (const tags of [probe.format?.tags, ...(Array.isArray(probe.streams) ? probe.streams.map((stream) => stream?.tags) : [])]) {
    for (const [key, value] of Object.entries(tags || {})) output[key.toLowerCase()] = value;
  }
  return output;
}

function tagMatches(probe, change) {
  const actual = probeTags(probe)[String(change.tag).toLowerCase()];
  return String(actual ?? "").trim() === String(change.value ?? "").trim();
}

function writeJournal(journalPath, payload) {
  const tmp = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, journalPath);
}

async function writeFileTags(filePath, changes, {
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  backupDirectory = path.join(process.cwd(), "data", "local-library-tag-write-backups"),
  journalPath = path.join(process.cwd(), "data", "local-library-tag-write-journal.json"),
  expectedFileHash = "",
  execFileImpl = execFileAsync,
  logger = console
} = {}) {
  const resolvedPath = path.resolve(filePath);
  const policy = formatPolicy(resolvedPath);
  if (policy.status !== "supported") throw new Error(policy.reason || `Unsupported audio format: ${path.extname(resolvedPath)}`);
  const safeChanges = (changes || []).filter((change) => change?.decision === "safe_fill");
  if (!safeChanges.length) throw new Error("No safe-fill metadata changes were supplied.");
  if (policy.writer === "dsf-id3") {
    return writeDsfFileTags(resolvedPath, safeChanges, {
      backupDirectory,
      journalPath,
      expectedFileHash,
      ffprobePath,
      execFileImpl,
      logger
    });
  }
  const beforeHash = await hashFile(resolvedPath);
  if (expectedFileHash && beforeHash !== expectedFileHash) {
    throw new Error(`File hash changed since preview: expected ${expectedFileHash}, found ${beforeHash}.`);
  }
  const stat = await fs.promises.stat(resolvedPath);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `${beforeHash}${path.extname(resolvedPath).toLowerCase()}`);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(resolvedPath, backupPath);

  const tempPath = tempFileFor(resolvedPath, "tagged");
  const displacedPath = tempFileFor(resolvedPath, "original");
  const journal = {
    version: 1,
    status: "prepared",
    targetPath: resolvedPath,
    backupPath,
    tempPath,
    displacedPath,
    beforeHash,
    changes: safeChanges,
    startedAt: new Date().toISOString()
  };
  writeJournal(journalPath, journal);
  try {
    await execFileImpl(ffmpegPath, buildFfmpegWriteArgs(resolvedPath, tempPath, safeChanges, policy), {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    const tempProbe = await probeAudio(tempPath, { ffprobePath, execFileImpl });
    for (const change of safeChanges) {
      if (!tagMatches(tempProbe, change)) throw new Error(`FFmpeg output did not contain expected ${change.tag} tag.`);
    }
    journal.status = "ready_to_replace";
    writeJournal(journalPath, journal);
    fs.renameSync(resolvedPath, displacedPath);
    journal.status = "original_displaced";
    writeJournal(journalPath, journal);
    fs.renameSync(tempPath, resolvedPath);
    const finalProbe = await probeAudio(resolvedPath, { ffprobePath, execFileImpl });
    for (const change of safeChanges) {
      if (!tagMatches(finalProbe, change)) throw new Error(`Final file did not contain expected ${change.tag} tag.`);
    }
    journal.status = "committed";
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    fs.rmSync(displacedPath, { force: true });
    fs.rmSync(journalPath, { force: true });
    const afterHash = await hashFile(resolvedPath);
    return {
      filePath: resolvedPath,
      format: path.extname(resolvedPath).toLowerCase(),
      beforeHash,
      afterHash,
      backupPath,
      originalSize: Number(stat.size),
      finalSize: Number((await fs.promises.stat(resolvedPath)).size),
      changes: safeChanges,
      status: "written"
    };
  } catch (error) {
    try {
      if (fs.existsSync(resolvedPath) && fs.existsSync(displacedPath)) fs.rmSync(resolvedPath, { force: true });
      if (!fs.existsSync(resolvedPath) && fs.existsSync(displacedPath)) fs.renameSync(displacedPath, resolvedPath);
    } catch (restoreError) {
      logger?.error?.(`Could not restore displaced original for ${resolvedPath}: ${restoreError.message}`);
    }
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(displacedPath, { force: true });
    journal.status = "rolled_back";
    journal.error = error.message;
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    throw error;
  }
}

async function restoreFileFromBackup(filePath, backupPath, {
  ffprobePath = "ffprobe",
  journalPath = path.join(process.cwd(), "data", "local-library-tag-restore-journal.json"),
  expectedCurrentHash = "",
  expectedRestoredHash = "",
  execFileImpl = execFileAsync,
  logger = console
} = {}) {
  const resolvedPath = path.resolve(filePath);
  const resolvedBackup = path.resolve(backupPath);
  if (resolvedPath === resolvedBackup) throw new Error("Restore backup must be a separate file.");
  const backupHash = await hashFile(resolvedBackup);
  if (expectedRestoredHash && backupHash !== expectedRestoredHash) {
    throw new Error(`Restore backup hash mismatch: expected ${expectedRestoredHash}, found ${backupHash}.`);
  }
  const currentHash = await hashFile(resolvedPath);
  if (expectedCurrentHash && currentHash !== expectedCurrentHash) {
    throw new Error(`Current file hash differs from write report: expected ${expectedCurrentHash}, found ${currentHash}.`);
  }
  const tempPath = tempFileFor(resolvedPath, "restore");
  const displacedPath = tempFileFor(resolvedPath, "restore-original");
  const journal = {
    version: 1,
    status: "prepared",
    targetPath: resolvedPath,
    backupPath: resolvedBackup,
    tempPath,
    displacedPath,
    currentHash,
    restoredHash: backupHash,
    startedAt: new Date().toISOString()
  };
  writeJournal(journalPath, journal);
  try {
    fs.copyFileSync(resolvedBackup, tempPath);
    await probeAudio(tempPath, { ffprobePath, execFileImpl });
    journal.status = "ready_to_replace";
    writeJournal(journalPath, journal);
    fs.renameSync(resolvedPath, displacedPath);
    journal.status = "current_displaced";
    writeJournal(journalPath, journal);
    fs.renameSync(tempPath, resolvedPath);
    const restoredProbe = await probeAudio(resolvedPath, { ffprobePath, execFileImpl });
    if (!restoredProbe) throw new Error("Restored file validation failed.");
    const restoredFileHash = await hashFile(resolvedPath);
    if (restoredFileHash !== backupHash) throw new Error(`Restored file hash mismatch: expected ${backupHash}, found ${restoredFileHash}.`);
    journal.status = "committed";
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    fs.rmSync(displacedPath, { force: true });
    fs.rmSync(journalPath, { force: true });
    return {
      filePath: resolvedPath,
      backupPath: resolvedBackup,
      beforeRestoreHash: currentHash,
      restoredHash: restoredFileHash,
      status: "restored"
    };
  } catch (error) {
    try {
      if (fs.existsSync(resolvedPath) && fs.existsSync(displacedPath)) fs.rmSync(resolvedPath, { force: true });
      if (!fs.existsSync(resolvedPath) && fs.existsSync(displacedPath)) fs.renameSync(displacedPath, resolvedPath);
    } catch (restoreError) {
      logger?.error?.(`Could not restore current file after failed rollback for ${resolvedPath}: ${restoreError.message}`);
    }
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(displacedPath, { force: true });
    journal.status = "rolled_back";
    journal.error = error.message;
    journal.completedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    throw error;
  }
}

module.exports = {
  FFMPEG_FORMATS,
  buildFfmpegWriteArgs,
  formatPolicy,
  hashFile,
  probeAudio,
  probeTags,
  restoreFileFromBackup,
  buildDsfId3Tag,
  parseId3Frames,
  readDsfMetadata,
  writeDsfFileTags,
  tagMatches,
  writeFileTags
};
