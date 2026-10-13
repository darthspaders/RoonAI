package house.rabbithole.nasa

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.*
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

/** Native Views keep this small utility free of web runtimes and UI framework dependencies. */
class MainActivity : Activity() {
    private val engine get() = (application as NasaApp).engine
    private val io = Executors.newSingleThreadExecutor()
    private var page = "home"
    private var viewGeneration = 0
    private var previewBitmap: Bitmap? = null
    private var previewImage: ImageView? = null
    private var shownImage: CachedImage? = null
    private var oldSettings: ConnectionSettings? = null
    private val bg = Color.rgb(24, 20, 30)
    private val field = Color.rgb(36, 31, 44)
    private val text = Color.rgb(242, 238, 246)
    private val muted = Color.rgb(196, 188, 205)
    private val accent = Color.rgb(214, 181, 242)
    private val error = Color.rgb(255, 180, 171)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setDecorFitsSystemWindows(false)
        showHome()
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(0) { back() }
    }
    override fun onResume() {
        super.onResume()
        engine.onChanged = { if (page == "home") showHome() }
        if (page == "home") showHome()
    }
    override fun onPause() { engine.onChanged = null; super.onPause() }
    override fun onDestroy() {
        viewGeneration++
        io.shutdownNow()
        previewImage?.setImageDrawable(null)
        previewBitmap?.recycle()
        super.onDestroy()
    }
    @Deprecated("Android 12 back navigation")
    override fun onBackPressed() { back() }
    private fun back() { if (page != "home") showHome() else finish() }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int = 12) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun base(name: String): LinearLayout {
        page = name
        viewGeneration++
        previewImage?.setImageDrawable(null)
        previewImage = null
        previewBitmap?.recycle(); previewBitmap = null
        if (name == "settings") window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val scroll = ScrollView(this).apply { setBackgroundColor(bg); isFillViewport = true; clipToPadding = false }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(28))
        }
        scroll.addView(content, ViewGroup.LayoutParams(-1, -2))
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        setContentView(scroll)
        return content
    }
    private fun label(parent: LinearLayout, value: String, size: Float = 16f, color: Int = text, bold: Boolean = false, top: Int = 8): TextView {
        return TextView(this).apply {
            this.text = value; textSize = size; setTextColor(color)
            setLineSpacing(dp(3).toFloat(), 1.05f)
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) })
        }
    }
    private fun button(parent: LinearLayout, title: String, primary: Boolean = false, enabled: Boolean = true, action: () -> Unit): Button {
        return Button(this).apply {
            text = title; isAllCaps = false; textSize = 16f
            setTextColor(if (primary) bg else accent)
            backgroundTintList = android.content.res.ColorStateList.valueOf(if (primary) accent else field)
            minHeight = dp(52); setPadding(dp(16), dp(10), dp(16), dp(10))
            isEnabled = enabled; alpha = if (enabled) 1f else .45f
            filterTouchesWhenObscured = true
            setOnClickListener { action() }
            parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        }
    }
    private fun showHome() {
        if (isFinishing || isDestroyed) return
        val body = base("home")
        val generation = viewGeneration
        val state = engine.state
        label(body, "RABBIT HOLE  /  NASA", 13f, accent, top = 0).letterSpacing = .09f
        label(body, "A little more universe.", 26f, bold = true, top = 12)
        val wanted = state.preview.ifEmpty { state.current }
        val hasName = wanted.isNotEmpty()
        val isPreview = state.current.isEmpty() || wanted != state.current
        if (!state.configured && !hasName) {
            val icon = ImageView(this).apply {
                setImageResource(house.rabbithole.nasa.R.drawable.ic_nasa)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            body.addView(icon, LinearLayout.LayoutParams(-1, dp(180)).apply { topMargin = dp(20) })
            label(body, "Your NASA collection, on your home screen.", 22f, bold = true)
            label(body, "Read finished images and their existing catalog from your PC. Only three photographs are kept on this phone.", color = muted)
            button(body, "Connect your collection", primary = true) { showSettings() }
            label(body, "No account service. No ads. No tracking.", 14f, muted, top = 16)
        } else {
            val isCurrent = engine.currentMatchesSystem()
            label(body, when { isPreview -> "COLLECTION PREVIEW"; isCurrent && state.currentIncludesLockScreen -> "CURRENT HOME & LOCK WALLPAPER";
                isCurrent -> "CURRENT HOME WALLPAPER"; else -> "LAST NASA WALLPAPER · SYSTEM IMAGE CHANGED" }, 12f, muted, top = 20)
            val image = ImageView(this).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                background = rounded(Color.BLACK)
                clipToOutline = true
                contentDescription = "NASA wallpaper preview. Open image details."
                isClickable = true; isFocusable = true
                setOnClickListener { shownImage?.let { showDetails(it) } }
            }
            previewImage = image
            val previewHeight = (resources.configuration.screenHeightDp * .42).toInt().coerceIn(220, 420)
            body.addView(image, LinearLayout.LayoutParams(-1, dp(previewHeight)).apply { topMargin = dp(12) })
            val title = label(body, if (hasName) "Loading image…" else "Ready to connect", 24f, bold = true, top = 16)
            title.isFocusable = true; title.isClickable = true; title.minHeight = dp(48)
            title.setOnClickListener { shownImage?.let { showDetails(it) } }
            val credit = label(body, "", 14f, muted, top = 4)
            credit.maxLines = 2; credit.ellipsize = android.text.TextUtils.TruncateAt.END
            val details = button(body, "Image details", enabled = false) { shownImage?.let { showDetails(it) } }
            shownImage = null
            io.execute {
                val entry = engine.cache.entries().firstOrNull { it.filename == wanted }
                val cached = entry?.let { engine.cache.get(it) }
                val bitmap = if (cached != null) runCatching {
                    val fit = if (isPreview) runCatching { state.settings().fitWhole }.getOrDefault(false) else state.currentFitWhole
                    val (w, h) = engine.screenSize()
                    WallpaperRenderer.render(cached.file, 540, (540f * h / w).toInt(), fit)
                }.getOrNull() else null
                runOnUiThread {
                    if (isDestroyed || generation != viewGeneration) { bitmap?.recycle(); return@runOnUiThread }
                    shownImage = cached
                    title.text = cached?.info?.title ?: "No image cached yet"
                    credit.text = cached?.info?.credit ?: "Test your connection to load a preview."
                    image.contentDescription = cached?.info?.title?.let { "$it. Open image details." } ?: "No image available"
                    details.isEnabled = cached != null; details.alpha = if (cached != null) 1f else .45f
                    if (bitmap != null) { previewBitmap = bitmap; image.setImageBitmap(bitmap) }
                }
            }
            button(body, if (state.current.isEmpty()) "Set wallpaper" else "Next wallpaper", primary = true, enabled = !engine.busy) { engine.run(WallpaperAction.NEXT) }
            button(body, if (state.enabled) "Pause slideshow" else "Start slideshow", enabled = state.enabled || !engine.busy) {
                if (state.enabled) engine.pause() else engine.start()
            }
            body.addView(CheckBox(this).apply {
                text = "Also use on lock screen"
                isChecked = state.includeLockScreen
                isEnabled = !engine.busy
                minHeight = dp(52)
                filterTouchesWhenObscured = true
                setOnCheckedChangeListener { _, enabled ->
                    if (!engine.setIncludeLockScreen(enabled)) {
                        Toast.makeText(this@MainActivity, "Wait for the current update to finish.", Toast.LENGTH_SHORT).show()
                        showHome()
                    }
                }
            })
            label(body, "The same photo on both screens. Image details stay inside this app.", 13f, muted, top = 0)
            val interval = runCatching { state.settings().intervalMinutes }.getOrDefault(60)
            label(body, if (state.enabled) "Slideshow on · ${intervalLabel(interval)} · shuffle" else "Slideshow paused", 14f, muted, top = 16)
            label(body, state.status, 14f, muted)
            if (state.libraryCount > 0) label(body, "${state.libraryCount} finished images in the collection", 14f, muted, top = 4)
            if (state.lastChanged > 0) label(body, "Last set ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(state.lastChanged))}", 13f, muted, top = 4)
            label(body, "Android may delay rotations to save battery. The current wallpaper stays available offline.", 13f, muted, top = 12)
            button(body, "Connection & slideshow") { showSettings() }
        }
    }

    private fun showDetails(image: CachedImage) {
        val body = base("details")
        button(body, "‹ Wallpaper") { showHome() }
        label(body, image.info.title, 26f, bold = true, top = 24)
        if (image.info.target.isNotBlank() && image.info.target != image.info.title) label(body, image.info.target, 18f, accent)
        label(body, image.info.description.ifBlank { "No description was recorded in the NASA catalog." }, 17f, top = 20).setTextIsSelectable(true)
        fun fact(name: String, value: String) {
            label(body, name, 13f, muted, top = 22)
            label(body, value.ifBlank { "Not recorded" }, 16f, top = 3).setTextIsSelectable(true)
        }
        fact("Mission", image.info.mission)
        fact("Credit", image.info.credit)
        fact(if (image.info.dateKind == "modified") "Source date (modified)" else "Publication date", image.info.publication.take(10))
        fact("Original source resolution", image.info.originalResolution)
        fact("Retained source resolution", image.info.downloadResolution)
        fact("Wallpaper presentation", "3,840 × 2,160 px · original file preserved")
        val source = engine.cache.sourceDecision(image.info.id, image.published.hash)
        source?.let {
            if (it.kind == "image") label(body, "The original NASA page was unavailable. The shared catalog check selected its official NASA image.", 14f, muted, top = 18)
            button(body, if (it.kind == "image") "Open NASA image" else "Open NASA source") {
                val current = engine.cache.sourceDecision(image.info.id, image.published.hash)
                if (current == null) { Toast.makeText(this, "This source link needs a fresh catalog check. Reconnect to your collection.", Toast.LENGTH_LONG).show(); return@button }
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(current.url))) }
                catch (_: Exception) { Toast.makeText(this, "No browser is available.", Toast.LENGTH_LONG).show() }
            }
        } ?: label(body, "A working official source link has not been validated yet. Sync after the desktop catalog check completes; unverified or expired links are not opened.", 14f, muted, top = 20)
        label(body, "Details read from the existing NASA catalog record. No metadata is written onto the wallpaper.", 13f, muted, top = 20)
    }

    private fun showSettings() {
        val body = base("settings")
        oldSettings = runCatching { engine.state.settings() }.getOrNull()
        val old = oldSettings
        // USB-debugging setup aid only: private app file, URLs only, no credentials or automatic connection.
        // Release builds do not accept provisioning drafts or exported configuration intents.
        val draft = if (BuildConfig.DEBUG) runCatching {
            val f = java.io.File(filesDir, "setup-draft.json")
            if (f.length() in 1..4096) org.json.JSONObject(f.readText()) else null
        }.getOrNull() else null
        button(body, "‹ Wallpaper") { oldSettings = null; showHome() }
        label(body, "Your collection", 26f, bold = true, top = 24)
        label(body, "Use the same shared folders you already access on this phone. Both must be on the same PC.", color = muted)
        fun input(name: String, hint: String, value: String = "", secret: Boolean = false): EditText {
            val nameView = label(body, name, 14f, muted, top = 20)
            return EditText(this).apply {
                id = View.generateViewId(); nameView.labelFor = id
                setText(value); this.hint = hint; setTextColor(this@MainActivity.text); setHintTextColor(muted)
                textSize = 16f; minHeight = dp(52); setPadding(dp(12), dp(12), dp(12), dp(12))
                background = rounded(field, 8)
                inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                isSingleLine = true
                isSaveEnabled = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                parentAdd(body, this)
            }
        }
        val wallpapers = input("Wallpaper folder", "smb://server/share/Wallpapers", old?.wallpaperUrl ?: draft?.optString("wallpaperUrl") ?: "")
        val catalog = input("Catalog data folder", "smb://server/share/rabbit-hole/data", old?.catalogUrl ?: draft?.optString("catalogUrl") ?: "")
        label(body, "The data folder must contain nasa-wallpaper/manifest.json and nasa-whitecap/pipeline/assets. Images stay in their separate wallpaper folder.", 13f, muted, top = 8)
        val username = input("SMB username", "Your Windows / sharing account", old?.username ?: "")
        val password = input("SMB password", if (old != null) "Leave blank to keep the saved password" else "Account password, not Windows PIN", secret = true)
        val domain = input("Domain (optional)", "Usually leave blank", old?.domain ?: "")
        label(body, "Credentials are encrypted with Android Keystore. They are not logged or backed up.", 13f, muted, top = 8)
        label(body, "Rotation", 22f, bold = true, top = 28)
        val intervalLabel = label(body, "Wallpaper interval", 14f, muted, top = 16)
        val interval = Spinner(this).apply {
            id = View.generateViewId(); intervalLabel.labelFor = id
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, ConnectionSettings.INTERVALS.map { intervalLabel(it) })
            setSelection(ConnectionSettings.INTERVALS.indexOf(old?.intervalMinutes ?: 60).coerceAtLeast(0))
            minimumHeight = dp(52)
        }
        body.addView(interval, LinearLayout.LayoutParams(-1, -2))
        label(body, "15 minutes is the Android minimum. Samsung sleep and battery rules can delay updates; there is no always-running service.", 13f, muted, top = 4)
        val wifi = CheckBox(this).apply { text = "Fetch images on Wi-Fi only"; isChecked = old?.wifiOnly ?: true; minHeight = dp(52) }
        body.addView(wifi)
        val fit = CheckBox(this).apply { text = "Fit the whole image"; isChecked = old?.fitWhole ?: false; minHeight = dp(52) }
        body.addView(fit)
        label(body, "Off: crop around the image's light and detail, with a centre bias. On: show the entire photo with black margins. Neither option stretches or changes the source file.", 13f, muted, top = 4)
        label(body, "Use ‘Also use on lock screen’ on the wallpaper page to keep both screens on the same photo.", 13f, muted, top = 16)
        val message = label(body, "", 14f, error, top = 16)
        button(body, "Save & test connection", primary = true) {
            try {
                val settings = ConnectionSettings(wallpapers.text.toString().trim(), catalog.text.toString().trim(),
                    username.text.toString().trim(), password.text.toString().ifEmpty { old?.password ?: "" },
                    domain.text.toString().trim(), ConnectionSettings.INTERVALS[interval.selectedItemPosition], wifi.isChecked, fit.isChecked)
                settings.validate()
                password.text.clear()
                engine.save(settings) { failure ->
                    if (failure != null) message.text = failure
                    else { java.io.File(filesDir, "setup-draft.json").delete(); oldSettings = null; showHome(); engine.run(WallpaperAction.TEST) }
                }
            } catch (e: Exception) { message.text = WallpaperEngine.safeError(e) }
        }
        label(body, "Saving pauses the slideshow. Start it after the connection test. Only existing files are read over encrypted SMB3.", 13f, muted, top = 8)
        if (engine.state.configured) button(body, "Forget connection & clear cache") {
            AlertDialog.Builder(this).setTitle("Forget this collection?")
                .setMessage("Remove the saved account and the three-image phone cache. Your PC files and current wallpaper stay in place.")
                .setNegativeButton("Cancel", null).setPositiveButton("Forget") { _, _ -> engine.forget { oldSettings = null; showHome() } }.show()
        }
    }
    private fun parentAdd(parent: LinearLayout, view: View) { parent.addView(view, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(5) }) }
    private fun intervalLabel(minutes: Int): String = when {
        minutes < 60 -> "Every $minutes minutes"
        minutes == 60 -> "Every hour"
        minutes == 1440 -> "Every day"
        else -> "Every ${minutes / 60} hours"
    }
}
