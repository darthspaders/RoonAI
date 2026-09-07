# Synapse Voice — Android companion, version 0.1

Native Kotlin Android app for Rabbit Hole / RoonAI. The tablet detects “Hey Synapse,” transcribes the command offline, sends text to Rabbit Hole, and speaks the response with an offline Android TTS voice. Rabbit Hole owns AI routing and all Roon, TIDAL, discovery, taste and HQPlayer actions.

This is a first sideloadable development build for Android 12–15+ (min SDK 31, target 35), with ARM64 support for Galaxy Tab S10 Ultra and x86_64 for future emulator testing. It has not yet been tested on a physical tablet. The APK uses the local Android debug signing key; preserve that key for compatible development updates. A managed release signing key is a later step.

## Install and pair

1. Restart Rabbit Hole using your normal launcher so the updated `src/server.js` loads the voice API. The source changes are installed in the project; an already-running Node process does not load them automatically. No live music actions are needed for pairing.
2. In PowerShell, from the Rabbit Hole project directory, run:

   ```powershell
   node scripts/voice-device.js create "Galaxy Tab S10 Ultra"
   ```

   It prints a newly generated **Rabbit Hole device token** once. This is the only credential to paste into the tablet. Do not paste OpenAI keys, TIDAL tokens or Roon credentials. To revoke a lost tablet: `node scripts/voice-device.js list`, then `node scripts/voice-device.js revoke DEVICE_ID`.
3. Copy `synapse-voice-0.1.0-debug.apk` to the tablet and open it to install. Permit installation from the file manager when Android asks. Alternatively, with an authorized USB connection: `adb install -r synapse-voice-0.1.0-debug.apk`.
4. Open **Synapse Voice → Settings & Connection Test**. Enter your PC origin, such as `http://192.168.1.50:3777` or `http://100.x.y.z:3777` over Tailscale. For HTTPS, use a valid trusted certificate and hostname, including a configured Tailscale HTTPS origin. The app does not install or configure Tailscale itself.
5. For a numeric LAN/Tailscale HTTP address, enable **Allow HTTP on trusted LAN / Tailscale IPv4**. Prefer HTTPS when available. LAN HTTP exposes the device token to that network; Tailscale encrypts its tunnel. Redirects and public/DNS-based HTTP origins are rejected. Certificate validation is never disabled.
6. Paste the token, tap **Save & Test Connection**, then **Done**. Settings changes stop listening; tap **Start Listening** afterward. Ensure Android has an English offline TTS voice installed. The main screen reports if no suitable offline voice is available.
7. Grant microphone and notification permissions. Tap **Start Listening** while the app is visible. Wait for “Listening for Hey Synapse,” say the wake phrase, then speak after the tone. Push To Talk bypasses wake detection. Driving Mode enlarges controls, hides Settings, and allows longer pauses.

The companion does not automatically restart microphone listening after a reboot, force-stop or process death. Reopen the app and activate listening. Stop Listening releases the microphone and foreground service; it does **not** cancel a command already accepted by Rabbit Hole. Say “Hey Synapse, cancel” first to stop further steps of a running request.

The first model load copies the bundled model to private app storage. No model download, cloud speech service, or wake-word account is needed on the tablet.

## Implemented flow

```
Microphone → local Vosk wake grammar → tone → offline Vosk command STT
           → authenticated Rabbit Hole voice API
             → deterministic existing MCP tool OR normal AUTO model router
             → existing Roon / TIDAL / discovery / memory infrastructure
           ← short spoken response + full display response + actions
           → offline Android TTS → resume wake listening
```

`WakeWordEngine`, `SpeechRecognizer`, and `TextToSpeechEngine` are replaceable interfaces in `SpeechEngines.kt`. Vosk uses a constrained “hey synapse” grammar with an unknown-word path. Its acoustic word timestamps separate wake audio from command audio; a three-second RAM ring buffer preserves words spoken immediately after the wake phrase. The wake phrase is not re-transcribed as part of the command. Dictation uses the model's open vocabulary.

Capture ends after recognized speech and roughly 1.3 seconds of silence, or 2.2 seconds in noisy/driving mode, or the configured 5–30 second maximum. Adaptive audio energy and recognition activity inform silence detection. Audio is not saved or uploaded. Text and pending command IDs are stored locally, encrypted along with the device token using AES-GCM and Android Keystore. Android backup/device transfer is excluded. The manifest permits network access for the configurable Rabbit Hole origin; the client contains no OpenAI/TIDAL client or key.

The microphone foreground service displays an ongoing notification with a Stop action. A bounded, renewed partial wake lock supports screen-off operation; it is released on stop. Android's while-in-use rules require initial microphone service activation from a visible app. Samsung power management, microphone privacy controls, competing calls/apps and device firmware still affect operation. On the tablet, test with screen off and another app open; if Samsung suspends it, review that app's battery settings. No hidden microphone or boot receiver is used. [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

Audio focus requests duck compatible **tablet** playback only during capture/TTS. They do not lower external speakers or Roon/HQPlayer playback on the PC. Hardware `NoiseSuppressor` and `AcousticEchoCanceler` are enabled when exposed by the tablet's recording session, and their availability appears on screen. Echo cancellation cannot reliably remove music from external speakers without a matching playback reference. Recognition is suspended during the app's own TTS, so voice interruption of spoken replies is not yet supported. [Android NoiseSuppressor](https://developer.android.com/reference/android/media/audiofx/NoiseSuppressor), [AcousticEchoCanceler](https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler).

Vosk is practical and fully offline, but it is a general speech recognizer rather than a trained, low-power custom wake detector. The bundled model is about 40 MB compressed, needs additional RAM/storage, and continuous listening uses more battery than a dedicated keyword engine. Rare artist names and speech over loud music need real-device tuning. A dedicated custom keyword model can replace `LocalWakeWordProvider` without moving tool logic into Android. This build prioritizes a usable offline prototype and Push To Talk fallback; it does not claim measured road-noise accuracy. [Vosk models](https://alphacephei.com/vosk/models).

## Commands and routing

| Command | Rabbit Hole behavior |
| --- | --- |
| What's playing? | Direct current Roon track lookup |
| Pause / Play / Play music / Resume / Skip / Next / Previous | Existing Roon control tool; Play resumes the current zone |
| Love this / Good / Reject this | Existing now-playing ratings: `love`, `good`, `never` |
| Queue the next ten standby tracks | Existing standby queue tool, append mode, requested count 1–25 |
| Refresh standby | Existing forced manual refresh, including hard freshness rules |
| What did Rabbit Hole find? | Counts for standby and discovery; recent discovery tracks on screen |
| Send these to Roon | Existing latest-result queue tool; uses Rabbit Hole's current result source |
| Find ten fresh progressive house tracks over seven minutes / Find more like this | Original text passed to existing AUTO router |
| Cancel | Cancel this device's active request; tablet cancels its pending current-server requests |
| Stop | Cancels pending tablet requests when present; otherwise stops Roon playback |

Deterministic responses use `provider: LOCAL, model: direct`; they do not invoke Qwen or OpenAI. Complex routing is entirely on the backend. The endpoint reuses the existing router, tool descriptions and external-content handling. It grants no new authority to retrieved pages or music metadata. The companion does not make AI-security decisions.

Roon controls target the PC's active zone. Queue responses report actual queued/failed counts and the selected zone name. A request to “send these” follows the shared Rabbit Hole latest result, not a separate tablet selection. Another PC user changing the active result/zone can affect subsequent commands.

## API contract

All `/api/voice/*` routes require `Authorization: Bearer DEVICE_TOKEN`. A device token is 256 random bits; the server stores its SHA-256 hash in `data/voice/devices.json`. Revocation is checked on every request. Status exposes selected booleans and zone name, not raw provider configuration. “Synapse available” means configured, not a paid health/completion request.

```http
POST /api/voice/command
Authorization: Bearer DEVICE_TOKEN
Content-Type: application/json

{
  "requestId": "df946309-ef24-42ca-855a-1b1319d486cf",
  "text": "skip this track",
  "device": "galaxy-tab-s10-ultra",
  "sessionId": "tablet-session",
  "source": "android_voice"
}
```

Returns `202` with the same `requestId`, `status: queued`, and an acknowledgement. Poll `GET /api/voice/jobs/REQUEST_ID` until terminal. A completed result has:

```json
{
  "requestId": "df946309-ef24-42ca-855a-1b1319d486cf",
  "status": "completed",
  "success": true,
  "spokenResponse": "Skipped.",
  "displayResponse": "Skipped.",
  "provider": "LOCAL",
  "model": "direct",
  "actions": [{"type": "control_roon", "success": true}]
}
```

`GET /api/voice/status` is the connection test. `POST /api/voice/cancel` accepts `{ "requestId": "..." }`; omitting it cancels the latest active job owned by that device. Another device cannot read or cancel that job. Client-supplied device/session strings are informational; authorization comes from the token, never those strings. Provider/model fields supplied by Android are ignored.

Requests must include a UUID and nonempty text of at most 2,000 characters; JSON bodies are capped at 8 KiB. The same device/request ID/text retrieves the existing result instead of executing again. Conflicting reuse returns 409. Commands are durably recorded before dispatch in `data/voice/jobs.json`. A PC restart marks unfinished work `interrupted`; it never automatically replays it. IDs are retained rather than expired and reused; at 50,000 records the service stops accepting new IDs pending maintenance. The archive contains command text and responses. Protect it like the rest of Rabbit Hole's user data. Do not delete it to recover a timeout; that loses retry protection.

The tablet polls existing IDs after reconnecting and retries POST only with the same ID after a 404. Unaccepted commands expire after two minutes; accepted work is still reconciled afterward. Commands are bound to their saved server origin and never replayed on a different server. Connection retries back off to 30 seconds. Authentication/conflict errors are shown rather than silently generating another command ID. The backend admits at most eight active voice jobs; complex voice requests are serialized through the shared router.

Cancellation is cooperative: context follows MCP calls through the internal HTTP bridge; checks block later tool calls, further discovery passes, and standby/discovery commits. Already-running external Roon/TIDAL/AI requests may finish, and actions already executed are not rolled back. Cancelling a model request can prevent later tools without preventing charges for inference already started. This is not transactional exactly-once execution across arbitrary external tools or model fallback; the durable ID specifically prevents replaying a whole command after a network retry.

The new token checks protect the **voice routes**. Existing Rabbit Hole routes keep their existing access model. Do not publish the entire legacy server to the internet. For remote use, use your private Tailscale network and its access controls, or an HTTPS proxy that exposes only `/api/voice/*`. No firewall, router port-forwarding, TLS proxy or Tailscale configuration was changed by this implementation.

## Build and verification

JDK 17, Android platform/build-tools 35, Gradle 8.11.1 (checked wrapper distribution), AGP 8.9.2, Kotlin 2.1.20, Vosk Android 0.3.75 and JNA 5.18.1. The model is included in `app/src/main/assets/model`. Native libraries support 16 KiB ELF segment alignment.

```powershell
# Set JAVA_HOME to JDK 17 and sdk.dir in local.properties to your Android SDK.
.\gradlew.bat :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
# From Rabbit Hole's root:
node --test test/voiceApi.test.js
npm test
npm run check
```

Desktop speech smoke test (optional Python Vosk 0.3.45 and Windows System.Speech): run `tools/synthetic-speech.ps1` with Windows PowerShell, then `python tools/check-offline-speech.py`. It synthesizes local audio; it never records the microphone. Four wake/command samples and two negative samples are checked. This catches wake-boundary mistakes but is not representative of human voices, road noise or tablet microphones.

Before relying on hands-free operation, test on the tablet while parked: Push To Talk, wake plus pause, wake and command without a pause, music at normal/loud volume, another app foregrounded, screen off for 15–30 minutes, headset/call microphone contention, LAN loss, Tailscale reconnection, and cancellation during discovery. Use Roon's UI to verify actual actions. A car trial must not require screen interaction while driving.
