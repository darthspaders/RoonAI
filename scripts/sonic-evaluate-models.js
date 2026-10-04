"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { compareAnalysis } = require("../src/sonicAnalysisEvaluation");
const { buildAnalysisPilot } = require("../src/sonicAnalysisPilot");
const args = process.argv.slice(2), get = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const manifestPath = get("--manifest", "");
const output = get("--output", "data/sonic-analysis-evaluation.json");
const db = new DatabaseSync(path.resolve(get("--db", "data/rabbit-hole-memory.sqlite")), { readOnly: true });
try {
  const latest = manifestPath ? null : db.prepare("SELECT manifest_json FROM sonic_analysis_pilot ORDER BY created_at DESC LIMIT 1").get();
  const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath,"utf8")) : latest ? JSON.parse(latest.manifest_json) : buildAnalysisPilot(db);
  const report = compareAnalysis(db, manifest);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report,null,2));
  console.log(JSON.stringify({ output: path.resolve(output), status: report.status, requestedCount: report.requestedCount,
    commonAudioCandidateCount: report.commonAudioCandidateCount, anchorCount: report.anchorCount, productionPromotionAllowed: false }));
} finally { db.close(); }
