"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { TasteProfile } = require("../src/tasteProfile");
const { evaluateSonicEnsemble } = require("../src/sonicEnsembleEvaluation");

function argumentsFor(args) {
  const allowed = new Set(["--batch-id", "--db", "--taste", "--output"]), values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!allowed.has(flag) || values[flag] !== undefined || !value || value.startsWith("--")) throw new Error("Use distinct --batch-id, --db, --taste and --output arguments with values.");
    values[flag] = value;
  }
  if (!values["--batch-id"]) throw new Error("Provide --batch-id for a completed two-v2 fixed-top-k blind batch.");
  return values;
}

const label = track => `${track.artist} — ${track.title}`;
const cell = value => String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const names = { "mert-fullsong": "FullSong", "mert-30s": "30s", "best-rank": "Merged best rank", "agreement-005": "Merged +0.05 agreement",
  "agreement-010": "Merged +0.10 agreement", "rrf-60": "Reciprocal rank fusion", "agreement-005-taste": "Merged +0.05 + taste/admission",
  "mert-fullsong-taste": "FullSong + taste/admission", "mert-30s-taste": "30s + taste/admission",
  "agreement-005-stored-lane-gate": "Merged + stored-lane gate (diagnostic)", "mert-fullsong-stored-lane-gate": "FullSong + stored-lane gate (diagnostic)",
  "mert-30s-stored-lane-gate": "30s + stored-lane gate (diagnostic)" };

function markdown(report) {
  const count = report.source.finalShortlistCount;
  const summary = id => report.summary.find(row => row.id === id);
  const merged = summary("agreement-005"), tasted = summary("agreement-005-taste");
  const changedAnchors = report.anchors.filter(anchor => anchor.bonusChanges.some(change => change.id === "agreement-005" && (change.added.length || change.removed.length))).length;
  return ["# MERT-v2 shadow ensemble test", "", "This is an offline replay of completed human judgments. Both model rankings were recomputed independently from stored embeddings and checked against the frozen listening batch. Labels were joined after ranking. No inference, playback, new judgments or production ranking change occurred.", "",
    `The agreement shortlist kept **${merged.kept}/${merged.judged}**; FullSong kept **${summary("mert-fullsong").kept}/${summary("mert-fullsong").judged}** and 30s **${summary("mert-30s").kept}/${summary("mert-30s").judged}**. The experimental taste/admission replay kept **${tasted.kept}/${tasted.judged}**. Agreement changed membership at ${changedAnchors} anchor(s); this small result does not calibrate confidence or establish general superiority.`, "",
    "| Strategy | Keep / judged returned | Keep rate | Wrong lane | Returned / requested slots | First choices kept |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.summary.map(row => `| ${names[row.id]} | ${row.kept}/${row.judged} | ${row.keepRate === null ? "n/a" : (row.keepRate * 100).toFixed(1) + "%"} | ${row.wrongLane} | ${row.returned}/${row.requested} | ${row.firstChoicesKept}/${row.firstChoicesJudged} |`), "",
    `The merged shortlist stays at ${count} per anchor. Best-rank fusion uses the best reciprocal rank (1/rank) from either encoder. Agreement adds 0, 0.05 or 0.10 only when both source recordings and excerpt spans match. RRF sums 1/(60+rank), with no additional agreement bonus. These rank configurations were declared before this test and are not selected or fitted using the labels.`, "",
    "Taste variants apply Rabbit Hole's existing pure admission and base-scoring functions using one frozen global TasteProfile snapshot. The experimental retrieval contribution is 7.2 × best-rank score + 8 × agreement bonus, capped at eight points; this is a separate shadow formula, not the production EffNet Blend formula. The original models receive the same taste/admission replay for comparison. Excluded or unfilled slots are reported separately and never counted as accepted tracks.", "",
    "Primary taste variants make no explicit genre request: the anchor's sampling metadata is not a human constraint. Separate stored-lane-gate rows diagnose the consequences of treating that metadata as a strict genre request. This distinction was added after the first diagnostic showed that the inferred constraint removed accepted neighbors. That first report remains preserved, and the gate has not been relaxed inside an explicit genre request.", "",
    "| Anchor | FullSong | 30s | Merged | Merged +0.05 | Merged + taste | Filled taste slots |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.anchors.map(anchor => `| ${cell(label(anchor.anchor))} | ${anchor.results["mert-fullsong"].kept}/${count} | ${anchor.results["mert-30s"].kept}/${count} | ${anchor.results["best-rank"].kept}/${count} | ${anchor.results["agreement-005"].kept}/${count} | ${anchor.results["agreement-005-taste"].kept}/${anchor.results["agreement-005-taste"].judged} | ${anchor.results["agreement-005-taste"].returned}/${count} |`), "",
    "## Individual shortlist evidence", "",
    ...report.anchors.flatMap(anchor => ["### " + label(anchor.anchor), "",
      ...["agreement-005", "agreement-005-taste"].flatMap(id => ["**" + names[id] + "**", "",
        ...anchor.results[id].candidates.map((candidate, index) => `${index + 1}. ${label(candidate.track)} — ${candidate.decision}; ${candidate.nominations.map(n => names[n.analyzer] + " #" + n.rank).join(", ")}`), "",
        ...(anchor.results[id].exclusions || []).map(exclusion => "Excluded: " + cell(JSON.stringify(exclusion))), ""])]),
    "## Interpretation and limits", "",
    "Merging can preserve complementary accepted candidates while keeping the requested shortlist size. Any difference here remains descriptive. Agreement cannot repair an anchor whose entire retrieved union was rejected; Infinity needs additional relevant candidates or better lane evidence. Missing model coverage is reported without treating absence as a dislike. Exact model specifications stay separate; vectors and raw cosine scores are never averaged across spaces.", "",
    ...report.limitations.map(text => "- " + text), "",
    "The pilot supplies local metadata, not complete current provider evidence. The frozen taste snapshot may postdate listening and is not an independent validation set. Human review labels and notes are not used to infer genre/mood, create exclusions or alter taste. Online identity verification, discovery-history novelty and final artist diversity still require separate validation before production use.", "",
    "## Safety and reproducibility", "",
    "The CLI opens SQLite readOnly, enables query_only and reads within one transaction. Protected reviews, ratings, profiles and analyzer-queue rows have matching before/after digests. One derived taste snapshot is captured for scoring, and the taste file's before/after hashes match. The original taste input is archived privately as taste-input.json; its digest and scoring calendar year are recorded. Future exact taste replays need that input and the same scorer/year. Reports are written only to a fresh directory under ignored data/. Source paths, audio hashes and vectors are omitted from the report. No service reload is needed for this offline harness.", "",
    "Batch: " + report.batchId + ". Snapshot: " + report.createdAt + ".", ""].join("\n");
}

function main(args = process.argv.slice(2)) {
  const values = argumentsFor(args), root = path.resolve(__dirname, ".."), data = path.join(root, "data");
  const output = path.resolve(root, values["--output"] || `data/sonic-ensemble-test-${Date.now()}`);
  const relative = path.relative(data, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private test output must be a fresh directory inside the project's data/ directory.");
  if (fs.existsSync(output)) throw new Error("Output directory already exists; choose a fresh path to preserve prior reports.");
  const tastePath = path.resolve(root, values["--taste"] || "data/taste-profile.json");
  const tasteBytes = fs.readFileSync(tastePath), parsedTaste = JSON.parse(tasteBytes.toString("utf8"));
  if (!parsedTaste || typeof parsedTaste !== "object" || Array.isArray(parsedTaste)) throw new Error("Taste profile must be a JSON object.");
  for (const field of ["feedback", "candidates", "artists", "labels", "calibration"]) {
    if (parsedTaste[field] !== undefined && (!parsedTaste[field] || typeof parsedTaste[field] !== "object" || Array.isArray(parsedTaste[field]))) throw new Error("Invalid taste profile shape.");
  }
  const tasteDigest = createHash("sha256").update(tasteBytes).digest("hex");
  const tasteSnapshot = new TasteProfile(tastePath).read();
  assert.equal(Object.keys(tasteSnapshot.feedback || {}).length, Object.keys(parsedTaste.feedback || {}).length, "Taste reader returned an empty or changed feedback snapshot.");
  assert.equal(Object.keys(tasteSnapshot.candidates || {}).length, Object.keys(parsedTaste.candidates || {}).length, "Taste reader returned an empty or changed candidate snapshot.");
  const db = new DatabaseSync(path.resolve(root, values["--db"] || "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  let report;
  try {
    db.exec("PRAGMA query_only=ON"); db.exec("PRAGMA busy_timeout=5000"); db.exec("BEGIN");
    report = evaluateSonicEnsemble(db, { batchId: values["--batch-id"], tasteSnapshot });
    db.exec("ROLLBACK");
  } finally { db.close(); }
  const tasteUnchanged = createHash("sha256").update(fs.readFileSync(tastePath)).digest("hex") === tasteDigest;
  if (!tasteUnchanged) throw new Error("Taste profile changed during evaluation; repeat with a fresh frozen snapshot.");
  report.isolation.tasteFileUnchanged = true;
  report.source.tasteSnapshot = { updatedAt: tasteSnapshot.updatedAt, feedbackCount: Object.keys(tasteSnapshot.feedback || {}).length,
    sha256: tasteDigest, snapshotFile: "taste-input.json", scoringCalendarYear: new Date().getFullYear() };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "taste-input.json"), tasteBytes, { flag: "wx" });
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  fs.writeFileSync(path.join(output, "report.md"), markdown(report), { flag: "wx" });
  console.log(JSON.stringify({ output, status: report.status, summary: report.summary, productionApplied: false, protectedDatabaseUnchanged: true, tasteFileUnchanged: true }));
  return report;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { argumentsFor, markdown, main };
