package house.rabbithole.synapse

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.util.Locale

data class WakeDetection(val trailingAudioBytes: Int)
interface WakeWordEngine : AutoCloseable { fun accept(pcm: ByteArray, size: Int): WakeDetection?; fun reset() }
interface SpeechRecognizer : AutoCloseable { fun accept(pcm: ByteArray, size: Int): String; fun finish(): String; fun reset() }
interface TextToSpeechEngine { fun speak(text: String, done: () -> Unit); fun close() }
object WakePhrase {
    fun matches(text: String) = Regex("\\bhey synapse\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)
    fun strip(text: String) = text.replace(Regex("^\\s*hey synapse\\b[,.\\s]*", RegexOption.IGNORE_CASE), "").trim()
}
class LocalWakeWordProvider(model: Model) : WakeWordEngine {
    private val recognizer = Recognizer(model, 16000f, JSONArray(listOf("hey synapse", "[unk]")).toString())
    private var bytesAccepted = 0L
    init { recognizer.setWords(true); recognizer.setPartialWords(true) }
    override fun accept(pcm: ByteArray, size: Int): WakeDetection? {
        bytesAccepted += size
        val complete = recognizer.acceptWaveForm(pcm, size)
        val result = JSONObject(if (complete) recognizer.result else recognizer.partialResult)
        if (WakePhrase.matches(result.optString(if (complete) "text" else "partial"))) {
            val words = result.optJSONArray(if (complete) "result" else "partial_result")
            var end = -1.0
            if (words != null) for (i in 0 until words.length()) {
                val word = words.getJSONObject(i)
                if (word.optString("word") == "synapse") end = word.optDouble("end", -1.0)
            }
            // Cut using the wake engine's acoustic boundary, not a second transcription of the wake phrase.
            // Full dictation can hear “Synapse” as “apps”; it must never become part of the command.
            if (end >= 0) return WakeDetection((bytesAccepted - (end * 32000).toLong()).coerceIn(0, 96000).toInt() / 2 * 2)
        }
        if (complete) reset()
        return null
    }
    override fun reset() { recognizer.reset(); bytesAccepted = 0 }
    override fun close() = recognizer.close()
}
class VoskSpeechRecognizer(model: Model) : SpeechRecognizer {
    private val recognizer = Recognizer(model, 16000f)
    private val segments = mutableListOf<String>()
    override fun accept(pcm: ByteArray, size: Int): String {
        val complete = recognizer.acceptWaveForm(pcm, size)
        val text = JSONObject(if (complete) recognizer.result else recognizer.partialResult).optString(if (complete) "text" else "partial")
        if (complete && text.isNotBlank()) segments.add(text)
        return (segments + if (complete) emptyList() else listOf(text)).joinToString(" ").trim()
    }
    override fun finish() = (segments + JSONObject(recognizer.finalResult).optString("text")).joinToString(" ").trim()
    override fun reset() { recognizer.reset(); segments.clear() }
    override fun close() = recognizer.close()
}
object OfflineModel {
    fun load(context: Context): Model {
        val destination = File(context.filesDir, "vosk-en-0.15")
        val marker = File(destination, ".ready")
        if (!marker.exists()) {
            fun copy(asset: String, target: File) {
                val children = context.assets.list(asset).orEmpty()
                if (children.isEmpty()) { target.parentFile?.mkdirs(); context.assets.open(asset).use { source -> target.outputStream().use { source.copyTo(it) } } }
                else { target.mkdirs(); children.forEach { copy("$asset/$it", File(target, it)) } }
            }
            copy("model", destination); marker.writeText("1")
        }
        return Model(destination.absolutePath)
    }
}
class AndroidTextToSpeech(context: Context, private val settings: Settings) : TextToSpeechEngine {
    private var ready = false
    private var callback: (() -> Unit)? = null
    private var engine: TextToSpeech? = null
    init {
        engine = TextToSpeech(context) { status ->
            val tts = engine
            if (status == TextToSpeech.SUCCESS && tts != null) {
                val voices = tts.voices.orEmpty().filter { !it.isNetworkConnectionRequired && it.locale.language == Locale.ENGLISH.language }
                val voice = voices.find { it.name == settings.voice } ?: voices.find { it.locale == Locale.US } ?: voices.firstOrNull()
                if (voice != null) { tts.voice = voice; tts.setSpeechRate(1.0f); ready = true }
            }
            VoiceState.tts = if (ready) "Offline voice ready" else "Install an English offline Android TTS voice"
        }
        engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { callback?.invoke(); callback = null }
            @Deprecated("Android API") override fun onError(id: String?) { callback?.invoke(); callback = null }
        })
    }
    override fun speak(text: String, done: () -> Unit) {
        if (!ready) { done(); return }
        callback?.invoke(); callback = done
        if (engine?.speak(text.take(300), TextToSpeech.QUEUE_FLUSH, null, "synapse-response") == TextToSpeech.ERROR) { callback = null; done() }
    }
    override fun close() { engine?.stop(); engine?.shutdown(); callback?.invoke(); callback = null }
}
