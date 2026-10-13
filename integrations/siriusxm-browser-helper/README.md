# SiriusXM visible metadata helper

**Disabled after live testing:** repeating a DOM reading does not prove SiriusXM updated its title. Rabbit Hole rejects deliveries and does not apply this overlay. Do not install this as a working live metadata solution. An installed copy can be disabled or removed.

Current live metadata uses the direct public feed with buffered playback timing;
no SiriusXM browser tab is needed. See the
2026-10-03 handoff (private installation record; [published status and operating limits](../../docs/october-2026-update.md)) and
[active metadata guide](../../SIRIUSXM_METADATA.md). The instructions below are
historical implementation details, not the next setup step.

This optional Chrome/Edge extension reads the visible **On Now** label on a SiriusXM linear channel page. It never presses Play, reads account cookies, or copies SiriusXM credentials. Lyrion remains the audio source.

## Install on the Rabbit Hole PC

1. Run `node scripts/prepare-siriusxm-browser-helper.js` from Rabbit Hole (already prepared for this installation).
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. Enable Developer mode and choose **Load unpacked**.
3. Select Rabbit Hole's `data/siriusxm-browser-helper` folder, **not** this source folder. The generated folder includes a private local pairing key. Do not share it.
4. In that same browser, sign into SiriusXM and open the channel you listen to. Leave the channel tab open. Do not start browser playback.
5. The helper badge shows **ON** after Rabbit Hole accepts a reading, or **!** if delivery fails. Its tooltip shows the last sent title. The badge reports last delivery, not ongoing freshness.

Local diagnostic: `http://127.0.0.1:3777/api/siriusxm/browser/status`. Channel metadata: `/api/siriusxm/metadata?channel=53` (look for `liveNowTitle` and `diagnostics.browser`).

Only channels with an open tab receive browser metadata. The extension sends every 15 seconds; background tab sleeping can delay it. Rabbit Hole expires readings after 90 seconds and returns to public/Lyrion metadata. Keep the relevant tab awake for continuous updates. A page refresh may be necessary if SiriusXM itself stops updating its On Now label.

SiriusXM's public schedule is retained separately. The combined artist/mix label is displayed verbatim rather than guessed into artist and title fields. Changes to SiriusXM's page markup can stop extraction; missing fields never send blank metadata.

To stop: disable/remove the extension. Existing readings expire automatically. Regenerating the local pairing key requires preparing and reloading the extension again.
