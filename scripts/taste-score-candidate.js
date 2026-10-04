"use strict";

const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const {
  readTasteClusterProfiles,
  scoreCandidateAgainstProfiles
} = require("../src/tasteClusterScoring");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    identity: "",
    model: "discogs-effnet",
    modelVersion: "1",
    cluster: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = require("node:path").resolve(argv[++index] || "");
    else if (arg === "--identity" || arg === "--track") args.identity = cleanText(argv[++index]);
    else if (arg === "--model") args.model = cleanText(argv[++index]) || args.model;
    else if (arg === "--model-version") args.modelVersion = cleanText(argv[++index]) || args.modelVersion;
    else if (arg === "--cluster" || arg === "--cluster-key") args.cluster = cleanText(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Score a stored sonic candidate against ready taste-cluster profiles.

Usage:
  npm run taste:score-candidate -- --identity tidal:123
  npm run taste:score-candidate -- --identity tidal:123 --cluster "metadata:progressive house"

This is diagnostic only. It does not change discovery or reject candidates.
`);
}

function main(args) {
  if (!args.identity) throw new Error("--identity is required.");
  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  const sonic = new SonicEmbeddingStore({ enabled: true, dbFile: args.dbFile, logger: console });
  try {
    const embedding = sonic.getEmbedding(args.identity, { model: args.model, modelVersion: args.modelVersion });
    if (!embedding) throw new Error(`No ${args.model} v${args.modelVersion} embedding exists for ${args.identity}.`);
    const profiles = readTasteClusterProfiles(memory.db, { model: args.model, modelVersion: args.modelVersion });
    const result = scoreCandidateAgainstProfiles(embedding.vector, profiles, { requestedClusterKey: args.cluster });
    console.log(JSON.stringify({
      ok: true,
      candidate: {
        identityKey: embedding.identityKey,
        artist: embedding.track.artist,
        title: embedding.track.title,
        model: embedding.model,
        modelVersion: embedding.modelVersion,
        dimensions: embedding.dimensions
      },
      ...result
    }, null, 2));
  } finally {
    memory.close();
    sonic.close();
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  else {
    try {
      main(args);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    }
  }
}

module.exports = { parseArgs, scoreCandidateAgainstProfiles };
