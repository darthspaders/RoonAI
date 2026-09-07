package house.rabbithole.synapse

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.*
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var status: TextView
    private lateinit var command: TextView
    private lateinit var response: TextView
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var pendingAction = VoiceService.START
    private val update = object : Runnable {
        override fun run() {
            status.text = "Rabbit Hole: ${VoiceState.connection}\nRoon: ${VoiceState.roon}\nSynapse: ${VoiceState.synapse}\nWake word: ${VoiceState.listening}"
            command.text = "LAST COMMAND\n${VoiceState.command}"
            response.text = "LAST RESPONSE\n${VoiceState.response}\n\n${VoiceState.audio}\n${VoiceState.tts}"
            main.postDelayed(this, 500)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); settings = Settings(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        render()
    }
    private fun dp(n: Int) = (resources.displayMetrics.density * n).toInt()
    private fun label(value: String, size: Float = 20f) = TextView(this).apply { text = value; textSize = size; setTextColor(Color.rgb(232, 240, 240)); setPadding(0, dp(10), 0, dp(10)) }
    private fun layout() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(28), dp(24), dp(28), dp(24)) }
    private fun button(text: String, action: () -> Unit) = Button(this).apply {
        this.text = text; textSize = if (settings.driving) 26f else 20f; minHeight = dp(if (settings.driving) 92 else 68)
        setOnClickListener { action() }
    }
    private fun render() {
        val root = layout().apply { setBackgroundColor(Color.rgb(16, 23, 30)) }
        root.setOnApplyWindowInsetsListener { v, insets -> val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()); v.setPadding(dp(28) + bars.left, dp(16) + bars.top, dp(28) + bars.right, dp(16) + bars.bottom); insets }
        root.addView(label("HEY SYNAPSE", if (settings.driving) 44f else 36f).apply { setTextColor(Color.rgb(121, 224, 202)) })
        root.addView(label(if (settings.driving) "Driving mode · speak after the tone" else "Your Rabbit Hole voice companion", 18f))
        status = label(""); root.addView(status)
        root.addView(button("Start Listening") { start(VoiceService.START) })
        root.addView(button("Stop Listening") { stopService(Intent(this, VoiceService::class.java)) })
        root.addView(button("Push To Talk") { start(VoiceService.TALK) })
        root.addView(Switch(this).apply {
            text = "Driving Mode"; textSize = 22f; minHeight = dp(64); isChecked = settings.driving
            setOnCheckedChangeListener { _, checked -> settings.driving = checked; render() }
        })
        if (!settings.driving) root.addView(button("Settings & Connection Test") { showSettings() })
        command = label("", if (settings.driving) 24f else 20f); root.addView(command)
        response = label("", if (settings.driving) 24f else 20f); root.addView(response)
        setContentView(ScrollView(this).apply { isFillViewport = true; addView(root) }); root.requestApplyInsets()
    }
    private fun start(action: String) {
        try { ServerAddress.validate(settings.url, settings.allowHttp); require(settings.token.isNotBlank()) { "Add your Rabbit Hole device token." } }
        catch (e: Exception) { VoiceState.response = e.message ?: "Open Settings first."; showSettings(); return }
        pendingAction = action
        val permissions = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        if (permissions.isNotEmpty()) requestPermissions(permissions.toTypedArray(), 10)
        else startForegroundService(Intent(this, VoiceService::class.java).setAction(action))
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startForegroundService(Intent(this, VoiceService::class.java).setAction(pendingAction))
        else VoiceState.response = "Microphone permission is required."
    }
    private fun showSettings() {
        val box = layout()
        box.addView(label("Connect only to your Rabbit Hole PC. No OpenAI key belongs here.", 17f))
        fun field(hint: String, value: String, secret: Boolean = false): EditText = EditText(this).apply {
            this.hint = hint; setText(value); isSingleLine = true
            inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            box.addView(this, LinearLayout.LayoutParams(-1, dp(60)))
        }
        val url = field("Rabbit Hole URL", settings.url)
        val token = field("Device token (blank keeps saved token)", "", true)
        val http = CheckBox(this).apply { text = "Allow HTTP on trusted LAN / Tailscale IPv4"; isChecked = settings.allowHttp }; box.addView(http)
        box.addView(label("HTTPS protects the device token. Plain LAN HTTP is unencrypted; Tailscale encrypts its own tunnel.", 15f))
        val noisy = CheckBox(this).apply { text = "Noisy environment · longer speech pauses"; isChecked = settings.noisy }; box.addView(noisy)
        val duration = field("Maximum command duration (5–30 seconds)", settings.maxSeconds.toString()).apply { inputType = InputType.TYPE_CLASS_NUMBER }
        val voice = field("Offline Android TTS voice name (optional)", settings.voice)
        box.addView(label("Wake engine: Vosk offline\nWake phrase: Hey Synapse\nEnglish speech model bundled\nRestart listening after changing settings.\nInstall an English offline voice in Android Text-to-speech settings for spoken replies.", 16f))
        val result = label("", 16f); box.addView(result)
        fun save() {
            ServerAddress.validate(url.text.toString().trim(), http.isChecked)
            stopService(Intent(this, VoiceService::class.java))
            settings.url = url.text.toString(); settings.allowHttp = http.isChecked; settings.noisy = noisy.isChecked
            settings.maxSeconds = duration.text.toString().toIntOrNull() ?: 15; settings.voice = voice.text.toString()
            if (token.text.isNotBlank()) settings.token = token.text.toString()
        }
        box.addView(button("Save & Test Connection") {
            try {
                save(); result.text = "Testing…"
                worker.execute {
                    val message = try {
                        val s = RabbitHoleClient(settings).request("/api/voice/status")
                        VoiceState.connection = "Connected"; VoiceState.roon = if (s.optBoolean("roon")) "Connected" else "Offline"; VoiceState.synapse = if (s.optBoolean("synapseAvailable")) "Available" else "Unavailable"
                        "Rabbit Hole connected. Roon: ${VoiceState.roon}."
                    } catch (e: Exception) { VoiceState.connection = "Offline"; e.message ?: "Connection failed." }
                    main.post { result.text = message }
                }
            } catch (e: Exception) { result.text = e.message }
        })
        AlertDialog.Builder(this).setTitle("Synapse Voice Settings").setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton("Done", null).show()
    }
    override fun onResume() { super.onResume(); main.post(update) }
    override fun onPause() { main.removeCallbacks(update); super.onPause() }
    override fun onDestroy() { worker.shutdownNow(); main.removeCallbacksAndMessages(null); super.onDestroy() }
}
