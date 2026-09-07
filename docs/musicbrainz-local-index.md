# MusicBrainz Local Index

Rabbit Hole can use a local MusicBrainz JSON-dump index for metadata enrichment before it falls back to the public MusicBrainz API. This avoids the public 1 request/second bottleneck for repeated genre, tag, release, and ISRC lookups.

## Build

Download and extract the MusicBrainz JSON dumps, then run:

```powershell
npm run import:musicbrainz -- C:\path\to\extracted\musicbrainz-json-dumps
```

The importer looks for line-delimited JSON files named `recording` and `release`, including the normal `mbdump\recording` and `mbdump\release` layout. It writes the index to:

```text
data/musicbrainz-index
```

That directory is ignored by Git.

## Enable

Set:

```env
MUSICBRAINZ_LOCAL_INDEX=true
MUSICBRAINZ_INDEX_DIR=
MUSICBRAINZ_PUBLIC_FALLBACK=true
```

When `MUSICBRAINZ_INDEX_DIR` is blank, Rabbit Hole uses `data/musicbrainz-index`.

## Lookup Order

```text
TIDAL/Roon track identity
-> metadata enrichment cache
-> TIDAL exact metadata
-> local MusicBrainz index
-> public MusicBrainz API fallback
-> Discogs fallback
```

The local index returns MusicBrainz-shaped recording rows, so existing enrichment confidence checks still apply. Genres and tags from local recording/release rows become metadata evidence for Rabbit Hole, which helps when TIDAL only exposes broad labels like `electronic`.
