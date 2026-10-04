# Rabbit Hole follow-up work

- Verify Lyrion source/plugin combinations on additional Linux installations.
- Expand sustained SiriusXM artist/Xtra playback checks, including outages,
  long pauses, expiring media URLs and queue edits from other clients.
- Evaluate buffered SiriusXM metadata/artwork on different Lyrion plugin versions.
- Add dedicated Xtra-channel MCP actions; current Xtra browsing is available in
  the web interface.
- Evaluate Lyrion discovery integration with the existing discovery workflows.
- Broaden physical-tablet SoundSpectrum transport and synchronization checks.
- Validate optional HQPlayer feed behavior across input formats and desktop versions.
- Keep learned-model evaluation separate from production identity and playback rules.

Setup is documented in [README](README.md) and [Lyrion setup](docs/lyrion.md).
Run `npm run check` and `npm test` before publishing code changes. Keep account
tokens, local configuration, cached audio, databases and diagnostic output private.
