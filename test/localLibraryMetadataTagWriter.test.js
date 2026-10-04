"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildDsfId3Tag,
  buildFfmpegWriteArgs,
  formatPolicy,
  hashFile,
  parseId3Frames,
  probeTags,
  readDsfMetadata,
  tagMatches,
  writeDsfFileTags
} = require("../src/localLibraryMetadataTagWriter");

test("format policy supports stream-copy formats and routes DSF through its dedicated writer", () => {
  assert.equal(formatPolicy("song.flac").status, "supported");
  assert.equal(formatPolicy("song.mp3").status, "supported");
  assert.equal(formatPolicy("song.dsf").status, "supported");
  assert.equal(formatPolicy("song.dsf").writer, "dsf-id3");
});

test("FFmpeg writer arguments preserve the source stream and request only tag changes", () => {
  const args = buildFfmpegWriteArgs("song.flac", "song.tmp.flac", [{ tag: "LABEL", value: "Test Label" }]);
  assert.ok(args.includes("-c") && args.includes("copy"));
  assert.ok(args.includes("-map_metadata") && args.includes("0"));
  assert.ok(args.includes("LABEL=Test Label"));
  assert.equal(args.at(-1), "song.tmp.flac");
});

test("tag validation reads case-insensitive FFprobe tags", () => {
  const probe = { format: { tags: { label: "Test Label" } }, streams: [] };
  assert.equal(probeTags(probe).label, "Test Label");
  assert.equal(tagMatches(probe, { tag: "LABEL", value: "Test Label" }), true);
});

test("DSF ID3 builder emits replaceable standard and TXXX frames", () => {
  const tag = buildDsfId3Tag({ version: 3, frames: [] }, [
    { decision: "safe_fill", tag: "LABEL", value: "Test Label" },
    { decision: "safe_fill", tag: "CAMELOT", value: "8A" }
  ]);
  const parsed = parseId3Frames(tag);
  assert.deepEqual(parsed.frames.map((frame) => frame.id), ["TPUB", "TXXX"]);
  assert.equal(parsed.frames[0].payload.includes(Buffer.from("Test Label", "utf16le")), true);
  assert.equal(parsed.frames[1].payload.includes(Buffer.from("CAMELOT", "utf16le")), true);
});

test("DSF writer appends an ID3 tag without changing the existing payload", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-dsf-"));
  const filePath = path.join(tempDir, "song.dsf");
  const backupDirectory = path.join(tempDir, "backups");
  const journalPath = path.join(tempDir, "journal.json");
  const payload = Buffer.alloc(64, 0x5a);
  const header = Buffer.alloc(28);
  header.write("DSD ", 0, "ascii");
  header.writeBigUInt64LE(28n, 4);
  header.writeBigUInt64LE(BigInt(header.length + payload.length), 12);
  header.writeBigUInt64LE(0n, 20);
  fs.writeFileSync(filePath, Buffer.concat([header, payload]));
  const beforeHash = await hashFile(filePath);
  const fakeExec = async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }) });

  const result = await writeDsfFileTags(filePath, [{ decision: "safe_fill", tag: "LABEL", value: "Test Label" }], {
    backupDirectory,
    journalPath,
    execFileImpl: fakeExec,
    logger: { error() {} }
  });

  assert.equal(result.status, "written");
  assert.equal((await hashFile(path.join(backupDirectory, `${beforeHash}.dsf`))), beforeHash);
  const metadata = readDsfMetadata(filePath);
  assert.equal(metadata.frames.find((frame) => frame.id === "TPUB").payload.includes(Buffer.from("Test Label", "utf16le")), true);
  assert.deepEqual(fs.readFileSync(filePath).subarray(28, 92), payload);
  assert.equal(fs.existsSync(journalPath), false);
});
