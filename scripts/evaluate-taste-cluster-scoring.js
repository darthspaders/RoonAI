"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { readTasteClusterProfiles } = require("../src/tasteClusterScoring");
const { evaluateTasteClusters } = require("../src/tasteClusterEvaluation");

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    model: "discogs-effnet",
    modelVersion: "1",
    splitModulo: 5,
    report: path.join(__dirname, "..", "data", "taste-cluster-evaluation.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--model") args.model = String(argv[++index] || args.model).trim();
    else if (arg === "--model-version") args.modelVersion = String(argv[++index] || args.modelVersion).trim();
    else if (arg === "--split-modulo") args.splitModulo = Math.max(2, Number(argv[++index]) || 5);
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Run a read-only held-out comparison of global and cluster-aware sonic scoring.

Usage:
  npm run taste:evaluate -- --model discogs-effnet --model-version 1

Every Nth explicit positive and negative feedback embedding is held out by
stable identity order. The evaluator does not score a held-out track against
itself and does not change the database or production discovery.
`);
}

function main(args) {
  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  try {
    const profiles = readTasteClusterProfiles(memory.db, {
      model: args.model,
      modelVersion: args.modelVersion,
      status: "ready"
    });
    const evaluation = evaluateTasteClusters(memory.db, {
      model: args.model,
      modelVersion: args.modelVersion,
      profiles,
      splitModulo: args.splitModulo
    });
    const output = {
      ...evaluation,
      generatedAt: new Date().toISOString(),
      options: {
        dbFile: path.resolve(args.dbFile),
        model: args.model,
        modelVersion: args.modelVersion,
        splitModulo: args.splitModulo,
        profileSource: "persisted ready taste_cluster_profile rows"
      },
      limitations: [
        "This is a small feedback-seed pilot, not a production-quality benchmark.",
        "Held-out rows come from explicit feedback identities already present in the sonic store.",
        "Cluster selection uses Beatport genre/subgenre only to choose a requested facet; it is not a hard filter.",
        "No unknown or neutral track is treated as a negative label."
      ]
    };
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      selection: output.selection,
      metrics: output.metrics,
      profileCount: output.profileCount,
      report: args.report
    }, null, 2));
  } finally {
    memory.close();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) printHelp();
else {
  try {
    main(args);
  } catch (error) {
    console.error(`taste-cluster evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main };
