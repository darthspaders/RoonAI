# Changes

## 0.2.0 — 2026-10-04

This release publishes the local work added since the September 7 public
version. Existing Roon discovery and playback remain available.

- Add independent Lyrion Music Server players, source browsing/search, exact
  source references, favorites, queue and transport controls.
- Add SiriusXM live metadata, shows, artist stations and Xtra channels, with
  buffered track timing and validated on-demand audio delivery.
- Add SoundCloud discovery/playback through LMS and separate OAuth playlist
  management.
- Publish the current browser player, artwork layouts, remote control and
  optional Windows Aeon/G-Force/WhiteCap visualizers and removable music feeds.
- Keep live sonic extraction off the Roon heartbeat thread, and deliver compact
  status updates through cached worker reads.
- Publish the current catalogue identity/database views, discovery diagnostics,
  local-library metadata tools and optional sonic analysis helpers.
- Use TIDAL's current filter-based search API while retaining exact track/version
  verification and provider relationship pagination.
- Add Linux/Docker setup with persistent private data. Require Node 22.13.0 or
  newer; recommend Node 24. SoundSpectrum remains an optional Windows feature.

Credentials, pairing tokens, listening history, local browser profiles, private
session notes, downloaded models and commercial visualizer binaries are excluded.
