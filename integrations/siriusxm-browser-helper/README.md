# Historical SiriusXM visible metadata helper

This helper is disabled. Repeating a visible DOM reading did not establish
that SiriusXM updated its title. Rabbit Hole rejects its deliveries and does
not apply this overlay.

Current live metadata uses direct public feeds and buffered playback timing.
See the [active metadata guide](../../SIRIUSXM_METADATA.md).
An existing helper installation can be disabled or removed.

The retained Chrome/Edge source reads a visible On Now label on a SiriusXM
linear-channel page. It does not press Play, read account cookies or capture
audio. Its generated local pairing key belongs under ignored
`data/siriusxm-browser-helper`, never in this source directory.

Do not install or describe this historical helper as a working continuous
metadata solution.
