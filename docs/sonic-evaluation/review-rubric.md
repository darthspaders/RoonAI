# Sonic Review Rubric

Use this rubric when ChatGPT/Synapse reviews a candidate from a persisted Sonic
Review session. The assistant may make a conservative provisional judgment from
the supplied evidence, but it must distinguish facts from derived signals and
subjective inference.

## Evidence hierarchy

### Metadata facts

Provider or Rabbit Hole facts may include artist, title, mix/version, album,
TIDAL ID, Beatport ID, ISRC, duration, label, release dates, BPM, key, genre,
subgenre, playlist membership, rating, and known identity/exposure state.

### Derived sonic evidence

The service may provide raw cosine, cluster/taste relationships, spectral
similarity, interpreted audio features, BPM/key deltas, neighborhood evidence,
or stored review-history signals. These are computed evidence, not a claim that
the assistant listened to the actual PCM.

### Subjective review inference

The assistant may propose genre/lane, subgenres, energy, mood, tags, preserve
traits, avoid traits, similarity emphasis, confidence, and a note. Use
conservative detail when evidence is thin. Do not invent a genre, audio feature,
or “heard” property that Rabbit Hole did not supply.

## Candidate decision labels

- `STRONG_KEEP`: clearly worth hearing and a strong fit for this anchor/lane.
- `KEEP`: useful neighbor with acceptable evidence and some discovery value.
- `SKIP`: not useful for this review, without asserting a global dislike.
- `REVIEW_MANUALLY`: evidence is promising but too ambiguous for automatic save.
- `AMBIGUOUS`: identity, version, genre lane, or relationship cannot be judged
  safely.
- `DUPLICATE`: same recording or known equivalent already reviewed/exposed.
- `REJECT`: unsafe, malformed, clearly off-lane, or not useful for discovery.

These labels are Sonic Review state. They do not overwrite global
`LOVE`, `LIKE`, `OKAY`, `DISLIKE`, or `NEVER_AGAIN` ratings unless the user
explicitly asks for a separate rating operation.

## Profile fields

When saving a profile, prefer canonical values from `sonic_get_review_schema`:

- genre/lane and subgenres/styles;
- energy scale;
- moods;
- tags;
- preserve traits;
- avoid traits;
- similarity emphasis;
- confidence;
- evidence summary;
- optional note.

Evidence summaries should name the available sources, for example Beatport or
TIDAL metadata, stored Discogs-EffNet similarity, duration/form relation, same
taste cluster, shared label/scene evidence, and prior reviewed-neighbor tags.
Keep confidence below certainty when identity or genre evidence is sparse.

## Queue policy

Session queue policies are:

- `NEVER`: never queue from the review session;
- `ASK`: review and wait for approval;
- `STRONG_ONLY`: queue only `STRONG_KEEP`;
- `KEEP_AND_STRONG`: queue `KEEP` and `STRONG_KEEP`;
- `ALL_VALID`: queue every valid non-rejected candidate.

Queueing is a playback action, not a Sonic Review judgment. Use
`sonic_queue_review_item` only after the candidate has a saved or explicit
review decision. Rabbit Hole must re-verify through its existing strict
TIDAL/Roon path; Beatport previews are never queued.

## What to look for

Ask whether the candidate is useful for discovery, not only whether it has a
large cosine score:

1. Is the source metadata coherent and the duration plausible?
2. Is the exact artist/title/version identity safe?
3. Is the genre family exact, compatible, adjacent, uncertain, weak-conflict,
   conflicting, or incompatible? How strong is the evidence on each side?
4. Does the duration/form suggest a short edit, radio version, long club form,
   remix, dub, live recording, or unrelated arrangement?
5. Does the candidate preserve the anchor’s discovery intent and novelty goal?
6. Is it already known, queued, surfaced, rated, or reviewed?
7. Does stored review history support or contradict the relationship?
8. Is there enough evidence to keep, or should it be skipped/flagged?

A high raw cosine does not override malformed identity, strong lane conflict,
unsafe version substitution, duplicate state, or severe arrangement mismatch.
Likewise, a lower cosine can still be a useful intentionally adjacent neighbor
when the stored evidence and review policy support it.

## Minimum audit packet

For each item, preserve:

- `sessionId`, anchor identity, candidate identity, and index;
- decision, confidence, profile, and evidence summary;
- raw cosine and adjusted shadow score;
- genre relationship, both evidence strengths, shared/conflicting families,
  scene evidence, and final genre-adjustment reason;
- duration/form relation, identity diagnostics, novelty/exposure state;
- queue action and/or explicit rating if performed;
- failure or skip reason when no profile is saved;
- timestamp and source `MCP`/assistant `Synapse` for writes.
