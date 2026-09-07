"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { recordFeedbackAcrossStores } = require("../src/feedbackRecorder");

test("feedback recorder writes one rating to every backend feedback store", () => {
  const calls = [];
  const track = { artist: "Example Artist", title: "Example Track" };
  const calibrationContext = { discoverySource: "Similar artist", discoveryLane: "core" };

  const result = recordFeedbackAcrossStores({
    rating: "wrong_genre",
    track,
    calibrationContext,
    tasteProfile: {
      record: (...args) => {
        calls.push(["tasteProfile.record", ...args]);
        return { feedback: { rating: "wrong_genre" }, calibration: { total: 1 } };
      }
    },
    genreProfileStore: {
      recordFeedback: (...args) => {
        calls.push(["genreProfileStore.recordFeedback", ...args]);
        return { count: 1 };
      }
    },
    sessionStore: {
      read: () => {
        calls.push(["sessionStore.read"]);
        return { options: { genres: "progressive house" } };
      },
      updateFeedback: (...args) => {
        calls.push(["sessionStore.updateFeedback", ...args]);
      }
    },
    trackMemory: {
      updateFeedback: (...args) => {
        calls.push(["trackMemory.updateFeedback", ...args]);
      }
    }
  });

  assert.deepEqual(result, {
    feedback: { rating: "wrong_genre" },
    calibration: { total: 1 },
    genreProfiles: { count: 1 }
  });
  assert.deepEqual(calls, [
    ["tasteProfile.record", track, "wrong_genre", calibrationContext],
    ["sessionStore.read"],
    ["genreProfileStore.recordFeedback", { genres: "progressive house" }, track, "wrong_genre"],
    ["sessionStore.updateFeedback", track, "wrong_genre"],
    ["trackMemory.updateFeedback", track, "wrong_genre"]
  ]);
});
