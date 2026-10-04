# Recommendation Engine v2 and Sonic Review

This optional layer stores versioned audio evidence alongside Rabbit Hole's
existing music memory. TIDAL/Roon continue to establish playable track identity.
Sonic similarity, provider previews and catalogue enrichment cannot replace
strict identity verification or authorize a queue operation.

## Components and defaults

- `spectral-baseline`: deterministic 80-D FFmpeg/FFT features for wiring and
  data-quality checks. This is not a learned music-similarity model.
- `discogs-effnet`: optional 1,280-D learned embeddings from a separately
  configured Essentia worker.
- Versioned source hashes, model keys, dimensions and normalization stored in SQLite.
- Cosine neighbor retrieval, bounded candidate generation and shadow usefulness
  scoring with metadata, genre-lane, duration, novelty and review evidence.
- Persisted Sonic Review sessions with separate anchor-scoped feedback.
- Explicitly started bulk coverage and optional lazy preparation queues.

`RABBIT_HOLE_RECOMMENDATION_V2_ENABLED` defaults false.
The legacy discovery mode defaults `shadow`; `rerank` is explicit.
The live server uses `SONIC_PRODUCTION_MODE`, which defaults `off`:
`observe` records diagnostics, while `blend` can apply bounded evidence to
already verified candidates. The default maximum adjustment is eight points
on a 100-point scale (`SONIC_MAX_ADJUSTMENT=0.08`).

Coverage, minimum scored counts, source/model validity and identity checks gate
Sonic use. Missing embeddings do not weaken normal verification or manufacture
evidence. Shadow candidate rows remain `queueable:false`.

## Small local baseline example

Set these in a private `.env`, then restart your Rabbit Hole service:

```text
RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true
RABBIT_HOLE_SONIC_EMBEDDING_PROVIDER=spectral-baseline
RABBIT_HOLE_RECOMMENDATION_V2_DISCOVERY_MODE=shadow
SONIC_PRODUCTION_MODE=off
FFMPEG_PATH=ffmpeg
```

Use your own audio paths:

```sh
npm run sonic:analyze -- analyze --file "/music/Artist - Track.flac"
npm run sonic:analyze -- analyze --dir "/music/test-tracks" --limit 20
npm run sonic:analyze -- neighbors --file "/music/Artist - Track.flac" --count 20
```

On Windows, substitute an appropriate Windows path. Analysis is an explicit
operation; browsing the library or reading status does not start a bulk run.

Common endpoints:

- `GET /api/recommendation-v2/status`
- `POST /api/recommendation-v2/analyze`
- `POST /api/recommendation-v2/sonic-neighbors`
- `POST /api/recommendation-v2/find-sonic-neighbors` (alias)
- `POST /api/recommendation-v2/sonic-neighbor-candidates`

Neighbor candidates query stored anchors, suppress self/duplicate recordings,
bound work and report acceptance/rejection diagnostics. They do not analyze
missing audio or queue their results automatically.

## Learned analysis setup

The standard Docker image includes FFmpeg/FFprobe, not Essentia, GPU libraries
or downloaded model checkpoints. Learned analysis requires a separately
configured Python/WSL worker. Keep this optional when testing basic Lyrion playback.

Review `scripts/setup-sonic-benchmark-wsl.sh` and the
`RABBIT_HOLE_SONIC_ESSENTIA_*` settings in `.env.example` before installing the
worker. The configured command/arguments select the worker, environment and
model path. Use paths belonging to your installation.

The Discogs-EffNet implementation follows the official
[model metadata](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs_track_embeddings-effnet-bs64-1.json)
and [algorithm reference](https://essentia.upf.edu/reference/std_TensorflowPredictEffnetDiscogs.html).
Analysis applies FFmpeg decoding, the selected learned model, pooling and
normalized vector storage. Source hash, model version and dimensions must agree
before cached evidence can be reused.

Optional model comparison uses `config/sonic-analyzers.json`,
`config/sonic-model-code-sha256.json`, and the
`setup-sonic-analysis-wsl.sh` / `sonic-download-models.py` scripts.
Registry revisions and executable model-code hashes are pinned. Downloads
remain explicit; inference uses approved local snapshots.
See [third-party notices](../THIRD_PARTY_NOTICES.md) for model/runtime terms.

## Audio source and identity policy

A high-confidence exact TIDAL identity can be linked to a safely verified
Beatport preview for analysis. Exact IDs, artist credits, named versions, ISRC,
release lineage and duration/form are checked independently of sonic scoring.
An accepted Extended Mix proxy does not become the playable TIDAL identity.

Local-file analysis uses the actual file and its hash. The linked-local runner
uses a safe accepted Beatport match as metadata context; the local-file mode
can process inventory without Beatport coverage:

```sh
npm run sonic:analyze:linked-local -- --limit 20 --execution auto
npm run sonic:analyze:local-file -- --limit 20 --execution auto
```

These runs are resumable and skip completed matching evidence.
Live tracks without safe preview coverage can remain `NEEDS_LOCAL_FILE`.
Missing or ambiguous sources are reported instead of substituting another mix.

Live preview extraction runs outside the main Node event loop. A bounded
analysis job slot returns `SONIC_RESOURCE_BUSY` when occupied, preserving Roon
heartbeat processing while a worker decodes or analyzes audio.

## Sonic Review

Stored sessions keep the anchor, candidate order, review decisions and audit
events. The [review rubric](sonic-evaluation/review-rubric.md) separates provider
facts, derived sonic evidence and subjective inference.
The assistant must not claim it listened to audio merely from a similarity score.

Anchor-scoped review feedback is separate from global ratings.
Queue policies remain explicit, and queue actions re-verify the existing
TIDAL/Roon path. Beatport previews are never queued.

Optional blinded listening batches use explicitly prepared private excerpts and
persisted decisions. Reports retain model attribution internally until review
completion. This repository includes no prepared batch, listening excerpts,
personal ratings, model vectors or evaluation diaries.

Similarity and sampled keep rates are evidence for review, not a guarantee of
musical fit or proof that a model is ready for production ranking.
