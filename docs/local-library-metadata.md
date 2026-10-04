# Local-library metadata enrichment

Rabbit Hole now has a separate, database-only metadata pass for the mixed local
music library. It is deliberately independent from the playback-time metadata
service and does not change production discovery.

The pass does this for each supported audio file:

1. Computes a SHA-256 file identity.
2. Reads embedded tags and technical properties through FFprobe.
3. Reuses matching Rabbit Hole memory and metadata-cache evidence.
4. Optionally checks Beatport, the local MusicBrainz index, and Discogs OAuth.
5. Selects fields independently using source priority and confidence.
6. Stores every field's provenance, match evidence, completeness score, and
   checkpoint in Rabbit Hole's SQLite database.

Enrichment writes database evidence only. The separate tag writer is dry-run
by default and requires explicit `--apply`; see the staged instructions below.

## Preview a future tag write-back

The next gate is a field-by-field, read-only preview. It only considers fields
that are missing from the file's existing tags, never proposes overwriting an
existing value, requires field provenance, and treats identity fields as
manual-review items. External IDs remain database-only until a separate tag
namespace policy is approved.

```powershell
npm run metadata:write-preview -- --report data/local-library-write-preview.json
```

The default auto-fill threshold is 95% confidence. Lower-confidence memory
evidence, unresolved provider matches, and competing MusicBrainz candidates are
reported for review rather than treated as safe writes. This command does not
modify audio files.

## Create the pre-write tag backup

Before any future staged write, create an immutable JSON snapshot of the
embedded tags captured during the scan and verify the source files have not
changed since then:

```powershell
npm run metadata:backup-tags
```

The command writes a timestamped report under `data/`, records the file hash,
size, modification time, and original tag map for every processed row, and
lists files that are missing or changed. It does not write audio files. A
format-aware restore command uses binary backups and expected-current-hash checks.

## Staged tag write-back

The writer is intentionally separate from enrichment. It uses FFmpeg stream
copy (no audio re-encode), verifies the input hash against the preview, creates
an exact binary backup, writes only `safe_fill` changes, validates the output
with FFprobe, and rolls back the displaced original on failure. Dry-run is the
default:

```powershell
npm run metadata:write-tags -- --preview data/local-library-write-preview.json
```

The first apply gate is limited to ten files:

```powershell
npm run metadata:write-tags -- --apply --limit 10
```

DSF now uses a dedicated ID3-in-DSF writer, because the installed FFmpeg can
decode DSF but cannot mux DSF output. It preserves the DSD audio payload,
updates the DSF metadata pointer when needed, validates the result with FFprobe,
and retains an exact binary backup. WAV/M4A and other formats still require
their own staged validation before bulk use.

To restore a staged write exactly, the report's binary backups can be used in
dry-run mode first, then applied with an expected-current-hash check:

```powershell
npm run metadata:restore-tags -- --report data/local-library-tag-write-report-stage-10.json
npm run metadata:restore-tags -- --apply --report data/local-library-tag-write-report-stage-10.json
```

The local-library pass is the bootstrap path for the current collection. It is
not the rule for every future track: live-played tracks are handled separately.
For live playback, Rabbit Hole will retain tracks even when Beatport has no
match, but automatic sonic analysis is reserved for high-confidence Beatport
matches. A live track without Beatport coverage should receive a durable
`NEEDS_LOCAL_FILE` sonic-source flag so a later matching local file can complete
analysis.

## Build the review queue

After a persisted sample has been inspected, build a focused review report from
the saved database rows without scanning the library again:

```powershell
npm run metadata:library -- --review --report data/local-library-review-queue.json
```

The queue includes incomplete records, unresolved external matches, multiple
accepted MusicBrainz candidates, and accepted Beatport matches whose duration
differs materially from the local file. A duration difference is a review flag,
not proof of a bad match: an Extended Mix may be a useful sonic proxy for a
shorter local edit. The default thresholds are 30 seconds for review and 120
seconds for a higher-severity version check. The report contains compact
candidate summaries and never writes audio tags.

## Preview a small sample

```powershell
npm run metadata:library -- --root Z:\\Music --limit 25
```

The default providers are `embedded,memory,cache`. The JSON report is written
to `data/local-library-metadata-report.json`, which is runtime data and should
remain ignored by Git.

## Persist a reviewed sample

```powershell
npm run metadata:library -- --root Z:\\Music --limit 25 --write
```

This saves rows to the existing Rabbit Hole music-memory database. It still
does not modify files. Re-running the same command resumes/skips files whose
path, size, modification time, and provider set are unchanged.

Use `--shuffle --offset 50 --limit 50` to process the next deterministic slice
after a 50-file shuffled pilot without repeating that slice.

Optional providers are explicit so a large library cannot accidentally trigger
thousands of network requests:

```powershell
npm run metadata:library -- --root Z:\\Music --limit 25 --providers embedded,memory,cache,beatport
```

Add Discogs explicitly when you want release/label/version coverage:

```powershell
npm run metadata:library -- --root Z:\\Music --limit 25 --providers embedded,memory,cache,beatport,musicbrainz,discogs --write
```

Set `DISCOGS_TOKEN` in the private `.env` file, or connect the Discogs OAuth
flow with `DISCOGS_CONSUMER_KEY` and `DISCOGS_CONSUMER_SECRET`. After restarting
Rabbit Hole, open `/api/discogs/oauth/start`; register the exact callback URL
(`http://127.0.0.1:3777/api/discogs/oauth/callback`, or the PC's LAN URL) in the
Discogs developer application. OAuth credentials are stored in
`data/discogs-oauth-token.json`, while the provider caches successful and
missing lookups, spaces requests, and only fetches a bounded number of release
details per local track. Discogs matches are stored as evidence and are not
written back to audio tags.

Beatport is enrichment evidence only. TIDAL/Roon remain identity authority for
queueing. External matches below the confidence threshold are retained in the
review table/report but are not applied to resolved metadata.

Discogs is intended as an additional, rate-limited metadata provider for release,
label, catalog, style, and version coverage. It does not supply the sonic audio
source. Provider precedence remains field-level: strong embedded tags are not
overwritten by weaker external evidence.

## Accelerated external enrichment

After the initial local scan has populated `local_library_file`, use the
database-only worker for large follow-up passes. It reuses stored file identity
and metadata, so it does not re-run FFprobe or SHA-256 hashing:

```powershell
npm run metadata:external -- --providers musicbrainz --all --write
npm run metadata:external -- --providers beatport --electronic-only --all --write
```

The MusicBrainz pass streams each required local-index title bucket once. The
Beatport pass ignores rows that already have a Beatport id and uses the
electronic metadata/path gate so rock, pop, jazz, and similar rows are not sent
to Beatport merely because they live under a broadly named folder. Discogs is
kept as a separate, rate-limited pass because its release searches can require
multiple requests and may time out; a timeout is retained as review evidence
without stopping the other providers. These passes remain database-only and
never write audio tags.

## Stored tables

- `local_library_file`: one resolved row per file hash, including technical
  metadata and completeness classification.
- `local_metadata_field`: field-level source, confidence, match type, reason,
  and evidence.
- `local_library_match`: accepted and rejected external candidates for review.
- `local_library_job`: resumable job checkpoints and progress.

The initial implementation uses full file SHA-256 identity. An audio-content
hash or Chromaprint layer can be added later to recognize the same audio after
container tags change, without making that more expensive identity pass a
prerequisite today.
