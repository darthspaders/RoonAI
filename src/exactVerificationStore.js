"use strict";
const fs = require("node:fs");
const path = require("node:path");

class ExactVerificationStore {
  constructor(file) { this.file = file; }
  save(result) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(result, (key, value) => key === "queueToken" ? "" : value, 2));
    fs.renameSync(temporary, this.file);
  }
  read() {
    if (!fs.existsSync(this.file)) return null;
    const result = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const row of result.tracks || []) if (row.tidal?.verified) {
      if (row.queuedAt || row.queueAttemptedAt) continue;
      const previous = row.roon;
      row.queueable = null;
      if (!["ROON_NOT_FOUND", "ROON_TIMEOUT", "ROON_VERSION_MISMATCH"].includes(row.status)) row.status = "TIDAL_VERIFIED_ROON_PENDING";
      row.roon = { ...previous, previousResolution: previous, checked: false, queueable: null, zoneId: previous?.zoneId || "", queueToken: "", failureType: previous?.failureType || "session_reset", reason: "TIDAL identity restored; resolve a fresh Roon action after restart." };
    }
    result.roonQueueableCount = 0;
    return result;
  }
}
module.exports = { ExactVerificationStore };
