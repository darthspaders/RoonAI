package house.rabbithole.synapse

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object VoiceState {
    @Volatile var listening = "Stopped"
    @Volatile var connection = "Offline"
    @Volatile var roon = "Unknown"
    @Volatile var synapse = "Unknown"
    @Volatile var command = "—"
    @Volatile var response = "Start listening or use Push To Talk."
    @Volatile var audio = "Offline speech · no microphone audio uploaded"
    @Volatile var tts = "Android TTS not started"
}
class VoiceService : Service() {
    companion object { const val START = "listen"; const val STOP = "stop"; const val TALK = "talk" }
    private lateinit var settings: Settings
    private lateinit var client: RabbitHoleClient
    private lateinit var tts: TextToSpeechEngine
    private val main = Handler(Looper.getMainLooper())
    private val active = AtomicBoolean(false)
    private val pushToTalk = AtomicBoolean(false)
    private val speaking = AtomicBoolean(false)
    private val capture = AtomicBoolean(false)
    private val network = Executors.newSingleThreadScheduledExecutor()
    private val requests = linkedMapOf<String, JSONObject>() // only accessed on network executor
    private var speechThread: Thread? = null
    @Volatile private var recorder: AudioRecord? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focus: AudioFocusRequest? = null
    private var lastStatus = 0L
    private var backoff = 1000L
    private var nextNetwork = 0L
    private var destroyed = false
    private val renewWakeLock = object : Runnable {
        override fun run() { if (active.get()) { wakeLock?.acquire(10 * 60 * 1000L); main.postDelayed(this, 5 * 60 * 1000L) } }
    }
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate(); settings = Settings(this); client = RabbitHoleClient(settings)
        tts = AndroidTextToSpeech(this, settings)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("listening", "Voice listening", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopSelf(); return START_NOT_STICKY }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return START_NOT_STICKY }
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        if (intent?.action == TALK) pushToTalk.set(true)
        if (active.compareAndSet(false, true)) {
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SynapseVoice:listening").apply { setReferenceCounted(false) }
            main.post(renewWakeLock)
            network.execute {
                try { val saved = JSONArray(settings.pending.ifBlank { "[]" }); for (i in 0 until saved.length()) { val item = saved.getJSONObject(i); requests[item.getString("requestId")] = item } }
                catch (_: Exception) { VoiceState.response = "Could not restore pending commands. Check Rabbit Hole before retrying." }
            }
            network.scheduleWithFixedDelay({ if (active.get()) networkTick() }, 0, 1000, TimeUnit.MILLISECONDS)
            speechThread = Thread({ listen() }, "synapse-offline-audio").also { it.start() }
        }
        return START_NOT_STICKY // Android requires explicit, visible activation; do not silently restart the mic.
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, VoiceService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "listening").setSmallIcon(R.drawable.ic_synapse).setContentTitle("Synapse Voice")
            .setContentText("Listening for “Hey Synapse”").setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop listening", stop).build()).build()
    }
    private fun duck(on: Boolean) {
        main.post {
            val manager = getSystemService(AudioManager::class.java)
            if (on && focus == null) {
                focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener { }.build()
                manager.requestAudioFocus(focus!!)
            } else if (!on) { focus?.let { manager.abandonAudioFocusRequest(it) }; focus = null }
        }
    }
    private fun tone() { main.post { if (!destroyed) { val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 35); tone.startTone(ToneGenerator.TONE_PROP_BEEP, 100); main.postDelayed({ tone.release() }, 200) } } }
    private fun say(text: String) {
        main.post {
            if (destroyed) return@post
            if (capture.get() || speaking.get()) { main.postDelayed({ say(text) }, 500); return@post }
            speaking.set(true); duck(true); VoiceState.listening = "Speaking"
            val ended = AtomicBoolean(false)
            val finish = { if (ended.compareAndSet(false, true)) { speaking.set(false); duck(false); if (active.get()) VoiceState.listening = "Listening for Hey Synapse" }; Unit }
            tts.speak(text, finish)
            main.postDelayed({ finish() }, 20000)
        }
    }
    private fun listen() {
        var model: org.vosk.Model? = null
        var wake: WakeWordEngine? = null
        var speech: SpeechRecognizer? = null
        var suppressor: NoiseSuppressor? = null
        var echo: AcousticEchoCanceler? = null
        try {
            VoiceState.listening = "Loading offline speech model…"
            model = OfflineModel.load(this); wake = LocalWakeWordProvider(model); speech = VoskSpeechRecognizer(model)
            if (!active.get()) return
            val min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            require(min > 0) { "Microphone does not support 16 kHz audio." }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) error("Microphone permission revoked.")
            val record = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(min * 2, 8192)).build()
            recorder = record
            check(record.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable." }
            if (NoiseSuppressor.isAvailable()) suppressor = runCatching { NoiseSuppressor.create(record.audioSessionId) }.getOrNull()
            if (AcousticEchoCanceler.isAvailable()) echo = runCatching { AcousticEchoCanceler.create(record.audioSessionId) }.getOrNull()
            runCatching { suppressor?.enabled = true }; runCatching { echo?.enabled = true }
            VoiceState.audio = "Offline Vosk · noise suppression ${if (suppressor?.enabled == true) "on" else "unavailable"} · echo cancellation ${if (echo?.enabled == true) "on" else "unavailable"}"
            record.startRecording()
            val block = ByteArray(3200)
            val preRoll = ArrayDeque<ByteArray>()
            var began = 0L; var changed = 0L; var lastVoice = 0L; var noiseFloor = 180.0; var previous = ""; var wasSpeaking = false
            VoiceState.listening = "Listening for Hey Synapse"
            while (active.get()) {
                val count = record.read(block, 0, block.size)
                if (count <= 0) { if (active.get()) error("Microphone stopped. Another app may own it."); break }
                val now = SystemClock.elapsedRealtime()
                var energy = 0.0
                for (i in 0 until count - 1 step 2) { val sample = ((block[i].toInt() and 255) or (block[i + 1].toInt() shl 8)).toShort().toDouble(); energy += sample * sample }
                val rms = kotlin.math.sqrt(energy / (count / 2).coerceAtLeast(1))
                if (speaking.get()) { wasSpeaking = true; preRoll.clear(); continue }
                if (wasSpeaking) { wake.reset(); speech.reset(); wasSpeaking = false; VoiceState.listening = "Listening for Hey Synapse" }
                if (!capture.get()) {
                    // Slowly adapt to continuous road/music noise; recognition remains the primary speech signal.
                    noiseFloor = noiseFloor * 0.98 + rms.coerceAtMost(noiseFloor * 2 + 200) * 0.02
                    preRoll.addLast(block.copyOf(count)); while (preRoll.size > 30) preRoll.removeFirst()
                    val pressed = pushToTalk.getAndSet(false)
                    val detection = if (pressed) null else wake.accept(block, count)
                    if (pressed || detection != null) {
                        capture.set(true); duck(true); tone(); speech.reset(); began = now; changed = now; lastVoice = now; previous = ""
                        if (detection != null) {
                            val buffered = preRoll.fold(ByteArray(0)) { acc, chunk -> acc + chunk }
                            val tail = buffered.takeLast(detection.trailingAudioBytes).toByteArray()
                            if (tail.isNotEmpty()) previous = speech.accept(tail, tail.size)
                        }
                        preRoll.clear(); VoiceState.listening = "Speak your command"
                    }
                } else {
                    if (rms > maxOf(300.0, noiseFloor * 2.5)) lastVoice = now
                    val partial = speech.accept(block, count)
                    val clean = WakePhrase.strip(partial)
                    if (partial != previous) { changed = now; previous = partial; if (clean.isNotBlank()) VoiceState.command = clean }
                    val silence = if (settings.noisy || settings.driving) 2200 else 1300
                    if (now - began >= settings.maxSeconds * 1000L || clean.isNotBlank() && now - maxOf(changed, lastVoice) >= silence && now - began > 1300) {
                        val command = WakePhrase.strip(speech.finish())
                        capture.set(false); duck(false); wake.reset(); speech.reset(); preRoll.clear()
                        VoiceState.listening = "Listening for Hey Synapse"
                        if (command.isNotBlank()) { VoiceState.command = command; dispatch(command) }
                        else { VoiceState.response = "I didn’t catch that."; say("I didn’t catch that.") }
                    }
                }
            }
        } catch (_: Exception) {
            if (active.get()) { VoiceState.response = "Microphone or offline model unavailable. Check microphone permission, then start again."; main.post { stopSelf() } }
        } finally {
            try { recorder?.stop() } catch (_: Exception) { }
            suppressor?.release(); echo?.release(); recorder?.release(); recorder = null
            speech?.close(); wake?.close(); model?.close(); capture.set(false)
        }
    }
    private fun dispatch(text: String) {
        network.execute {
            try {
                val currentRequests = requests.filterValues { it.optString("server") == settings.url }
                if (text.lowercase().trim().trimEnd('.', '!') in listOf("cancel", "cancel that", "cancel discovery", "stop") && currentRequests.isNotEmpty()) {
                    // Cancel all commands originating on this tablet, including those whose POST response was lost.
                    currentRequests.keys.toList().forEach { id ->
                        client.request("/api/voice/cancel", JSONObject().put("requestId", id))
                        requests.remove(id)
                    }
                    persist(); VoiceState.response = "Cancelled. Completed actions remain in place."; say(VoiceState.response)
                } else {
                    val id = UUID.randomUUID().toString()
                    requests[id] = JSONObject().put("requestId", id).put("sessionId", id).put("text", text).put("source", "android_voice").put("device", "galaxy-tab-s10-ultra").put("createdAt", System.currentTimeMillis()).put("server", settings.url)
                    persist(); nextNetwork = 0; VoiceState.response = "Sending to Rabbit Hole…"
                }
            } catch (_: Exception) { VoiceState.response = "Could not send cancellation. The request may still be running."; say(VoiceState.response) }
        }
    }
    private fun persist() { settings.pending = JSONArray(requests.values.toList()).toString() }
    private fun networkTick() {
        if (SystemClock.elapsedRealtime() < nextNetwork) return
        try {
            if (SystemClock.elapsedRealtime() - lastStatus > 10000) {
                val s = client.request("/api/voice/status")
                VoiceState.roon = if (s.optBoolean("roon")) "Connected" else "Offline"
                VoiceState.synapse = if (s.optBoolean("synapseAvailable")) "Available" else "Unavailable"
                lastStatus = SystemClock.elapsedRealtime()
            }
            for ((id, input) in requests.toMap()) {
                if (input.optString("server") != settings.url) continue // Never replay a command on a different server.
                val result = try { client.request("/api/voice/jobs/$id") }
                catch (e: ApiException) {
                    if (e.code != 404) throw e
                    if (System.currentTimeMillis() - input.optLong("createdAt", 0) > 120000) {
                        requests.remove(id); persist()
                        VoiceState.response = "An unsent command expired while offline. Please say it again."; say(VoiceState.response)
                        continue
                    }
                    client.request("/api/voice/command", input)
                }
                if (result.optString("status") in listOf("completed", "failed", "cancelled", "interrupted")) {
                    requests.remove(id); persist()
                    VoiceState.response = result.optString("displayResponse", result.optString("spokenResponse"))
                    say(result.optString("spokenResponse", "Request finished."))
                } else if (!input.optBoolean("acknowledged") && result.optString("status") == "running") {
                    input.put("acknowledged", true); persist(); VoiceState.response = "Rabbit Hole is working. Say “Hey Synapse, cancel” to stop further steps."
                    // Give immediate feedback only when a command is still running after a poll.
                    if (result.optString("status") == "running") say("Rabbit Hole is working.")
                }
            }
            VoiceState.connection = "Connected"; backoff = 1000; nextNetwork = SystemClock.elapsedRealtime() + 1000
        } catch (e: Exception) {
            VoiceState.connection = if (e is ApiException && e.code == 401) "Token rejected" else "Reconnecting"
            VoiceState.response = if (e is ApiException) e.message ?: "Offline" else "Rabbit Hole is unreachable. Check the URL and LAN or Tailscale connection."
            if (e is ApiException && e.code in listOf(400, 401, 403, 409, 413)) { nextNetwork = SystemClock.elapsedRealtime() + 30000 }
            else { backoff = (backoff * 2).coerceAtMost(30000); nextNetwork = SystemClock.elapsedRealtime() + backoff; if (backoff >= 30000) VoiceState.connection = "Offline" }
        }
    }
    override fun onDestroy() {
        destroyed = true; active.set(false); main.removeCallbacksAndMessages(null)
        try { recorder?.stop() } catch (_: Exception) { }
        network.shutdownNow(); tts.close(); duck(false)
        if (wakeLock?.isHeld == true) wakeLock?.release()
        VoiceState.listening = "Stopped"; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
