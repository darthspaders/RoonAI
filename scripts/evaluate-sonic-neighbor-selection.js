"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { evaluateSonicNeighborSelection } = require("../src/sonicNeighborSelection");

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    model: "discogs-effnet",
    modelVersion: "1",
    splitModulo: 5,
    minPositiveExamples: 3,
    minNegativeExamples: 2,
    tasteWeight: 0.15,
    maxCandidatesPerQuery: 10000,
    report: path.join(__dirname, "..", "data", "sonic-neighbor-selection-evaluation.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--model") args.model = String(argv[++index] || args.model).trim();
    else if (arg === "--model-version") args.modelVersion = String(argv[++index] || args.modelVersion).trim();
    else if (arg === "--split-modulo") args.splitModulo = Math.max(2, Number(argv[++index]) || 5);
    else if (arg === "--min-positive") args.minPositiveExamples = Math.max(1, Number(argv[++index]) || 3);
    else if (arg === "--min-negative") args.minNegativeExamples = Math.max(1, Number(argv[++index]) || 2);
    else if (arg === "--taste-weight") args.tasteWeight = Math.max(0, Math.min(0.5, Number(argv[++index]) || 0.15));
    else if (arg === "--max-candidates") args.maxCandidatesPerQuery = Math.max(1, Number(argv[++index]) || 10000);
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Run a bounded held-out comparison of raw sonic neighbors and the
feedback-facet selector built from already-stored Discogs-EffNet vectors.

Usage:
  npm run sonic:evaluate:neighbors -- --model discogs-effnet --model-version 1

The selector uses only explicit positive/negative feedback, builds separate
genre-area centroids, and falls back to raw cosine when an area has insufficient
evidence. It does not analyze audio, write to production tables, or enable
Recommendation Engine v2 reranking. The JSON report is runtime state under data/.
`);
}

function main(args) {
  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  try {
    const evaluation = evaluateSonicNeighborSelection(memory.db, args);
    const output = {
      ...evaluation,
      generatedAt: new Date().toISOString(),
      options: {
        dbFile: path.resolve(args.dbFile),
        model: args.model,
        modelVersion: args.modelVersion,
        splitModulo: args.splitModulo,
        minPositiveExamples: args.minPositiveExamples,
        minNegativeExamples: args.minNegativeExamples,
        tasteWeight: args.tasteWeight,
        maxCandidatesPerQuery: args.maxCandidatesPerQuery
      },
      limitations: [
        "This is a bounded feedback-seed evaluation, not a production-quality benchmark.",
        "The stored Discogs-EffNet model is not retrained; only a transparent selector is fit from explicit feedback.",
        "Held-out queries are explicit positive feedback identities with stored vectors.",
        "The selector never uses a global taste centroid; unsupported or mismatched areas use raw cosine.",
        "Qualitative listening remains required before any production reranking decision."
      ]
    };
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      selection: output.selection,
      modelSummary: output.modelSummary,
      metrics: output.metrics,
      report: args.report
    }, null, 2));
    return output;
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
    console.error(`sonic-neighbor selection evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main };
