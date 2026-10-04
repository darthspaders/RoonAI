# Local Library inventory

Database → Local Library lists physical audio files independently of playback,
discovery, online matches, ratings, or canonical recording decisions. Collection →
Local files only keeps Albums, Tags, and Files within that inventory. Select a
file for its path, format, embedded tags, scan status, and local Sonic coverage.

## Scan

```powershell
npm run library:scan -- --root 'Z:\Music'
```

`LOCAL_LIBRARY_ROOT` supplies the default when `--root` is omitted. The scanner
uses the configured FFprobe executable. It reads supported audio files recursively,
including files with missing tags and files FFprobe cannot decode. Non-audio files
are excluded. Symlinks/junctions are reported rather than followed recursively.

Before scanning, the CLI makes a consistent SQLite backup next to the memory
database. Progress and completion are saved in `local_media_scan`; the report is
`data/local-media-scan-report.json`. A lock prevents simultaneous inventory scans.
Refresh database reloads the inventory; it does not initiate a new filesystem scan.

## Storage and compatibility

The existing Rabbit Hole database contains two additive tables:

- `local_media_file`: one stable entry per case-insensitive physical path. Content
  hashes are non-unique so identical copies in different folders are retained.
- `local_media_scan`: root, timestamps, processed/reused/error counts, and completion.

The earlier `local_library_file` enrichment table has a unique content hash. It
cannot represent all physical copies safely without rebuilding its relationships.
It and its matches, identities, tag-writing history, and field provenance remain
intact. When path, size, modification time, and prior scan status match, the new
inventory reuses its embedded-tag snapshot and hash, not its enriched metadata.
Otherwise it probes and hashes the current file. Files changed during reading
are marked for retry, with no usable content hash.

Reruns reuse unchanged inventory entries and retry failed files. Removed files
are retained with availability `missing` only after complete directory traversal.
An unavailable root or incomplete traversal never marks a whole library missing.
Availability is a statement about the last scan, not a continuous filesystem monitor.

Local albums group by embedded album plus album artist; when album artist is absent,
the containing directory distinguishes collections. These are browsing groups, not
verified release identities. Each physical file remains separately inspectable.
Embedded artwork extraction is not part of this first inventory pass.

Sonic coverage requires a valid supported embedding whose source SHA-256 matches
the local file bytes. A provider preview or title match does not count. Scanning
does not run Sonic analysis, add ratings, match new canonical identities, fetch
provider metadata, queue music, or modify audio-file tags.

The existing Sonic/enrichment/writeback commands still use their existing tables.
Connecting the complete path inventory to those batch workflows is a subsequent
step; an inventoried file is not a claim that those workflows processed it.
