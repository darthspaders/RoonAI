# Metadata gathering for physical local files

`npm run library:metadata` gathers previously stored provider evidence for the
path-based inventory. Existing enrichment candidates are reused only when their
file hash matches the current inventory. No old enrichment rows are rekeyed or
deleted. Results and source evidence live in `local_media_metadata`, keyed by
physical file ID and guarded by file hash.

`npm run library:metadata -- --musicbrainz --online` additionally checks MusicBrainz
index gaps and uses the existing Beatport/Discogs clients for files without a
strictly matching candidate. Provider client caching and rate limiting remain in
effect. Per-file lookup outcomes persist; reruns reuse completed lookups. This is
gap filling, not a promise that every provider has a result for every file.

## Review and writing

Database → Local Library → file details → Metadata proposals exposes proposed
values, provider sources, and review reasons separately from embedded file tags.
Proposals are hidden when the inventory file hash no longer matches their evidence.

Only missing genre, subgenre, BPM, key, and Camelot fields can qualify for safe
fill. Direct Beatport/MusicBrainz/Discogs evidence must match artist credits, full
title/version (allowing the generic Original Mix suffix), duration within two
seconds, and have no ISRC conflict. Conflicting verified provider values require
review. Cached memory without provider version evidence also requires review.
Release and identity fields always require review. Existing tags are preserved.

`npm run library:write-tags -- --limit 10000` is a dry-run of the latest completed
preview. Actual writing requires the existing writer's explicit `--apply` flag;
its backups, current-file hash checks, format policies, and staged limits remain
in force. After any future actual writes, rescan the inventory and reconcile
metadata/Sonic references before treating the changed file hashes as current.

The completed preview is `data/local-media-metadata-preview.json`; partial run
progress is separate in `data/local-media-metadata-preview.progress.json`.
Last.fm is not connected to this file-enrichment pass. Online lookup failures and
no-match results remain gaps; Sonic classification is a separate workflow.
