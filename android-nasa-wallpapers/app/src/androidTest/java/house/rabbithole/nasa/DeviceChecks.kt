package house.rabbithole.nasa

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.app.WallpaperManager
import android.app.job.JobScheduler
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.graphics.Canvas

@RunWith(AndroidJUnit4::class)
class DeviceChecks {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun currentAndFutureImagesStayTogetherOnHomeAndLockScreens() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("exerciseBothScreens") == "true")
        val engine = (context.applicationContext as NasaApp).engine
        val state = engine.state
        val manager = WallpaperManager.getInstance(context)
        val enabledBefore = state.enabled
        val settingsBefore = state.settings()
        val currentBefore = state.current
        assertTrue("An existing NASA wallpaper is required", currentBefore.isNotEmpty())
        engine.pause()
        fun waitForWork() {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(110)
            while (engine.busy && System.nanoTime() < deadline) Thread.sleep(100)
            assertFalse("Wallpaper update exceeded its deadline", engine.busy)
        }
        fun assertBoth() {
            val home = manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM)
            val lock = manager.getWallpaperId(WallpaperManager.FLAG_LOCK)
            assertTrue(state.status, home > 0)
            // Android can represent a shared wallpaper as one common ID or an inherited lock (-1).
            assertTrue("Both surfaces must share the wallpaper assigned in one call", lock == home || lock < 0)
            assertEquals(home, state.currentWallpaperId)
            assertEquals(lock, state.currentLockWallpaperId)
            assertTrue(state.currentIncludesLockScreen)
            assertTrue(engine.currentMatchesSystem())
        }
        try {
            waitForWork()
            val historyBefore = state.bag.json()
            val cacheBefore = engine.cache.cached().map { it.published.filename }.toSet()
            assertTrue(engine.setIncludeLockScreen(true))
            waitForWork()
            assertBoth()
            assertEquals("Enabling lock screen must reuse the current photo", currentBefore, state.current)
            assertEquals("No shuffle choice is consumed", historyBefore, state.bag.json())
            assertEquals("No extra image download", cacheBefore, engine.cache.cached().map { it.published.filename }.toSet())
            assertTrue(AppState(context).includeLockScreen)
            val sharedId = state.currentWallpaperId
            assertTrue(engine.setIncludeLockScreen(false))
            assertFalse(AppState(context).includeLockScreen)
            assertEquals(sharedId, manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM))
            assertEquals(state.currentLockWallpaperId, manager.getWallpaperId(WallpaperManager.FLAG_LOCK))
            assertTrue(engine.setIncludeLockScreen(true))
            waitForWork()
            assertBoth()
            val done = CountDownLatch(1)
            assertTrue(engine.run(WallpaperAction.NEXT) { done.countDown() })
            assertTrue(done.await(110, TimeUnit.SECONDS))
            assertBoth()
            assertNotEquals(currentBefore, state.current)
            assertTrue("Saved connection and interval must remain unchanged", settingsBefore.json() == state.settings().json())
        } finally {
            state.enabled = enabledBefore
            if (enabledBefore) assertTrue(RotationJob.schedule(context, state.settings().intervalMinutes))
        }
    }

    @Test fun savedSmbConnectionReadsBothExistingFoldersWithoutSettingWallpaper() {
        val state = AppState(context)
        assertTrue("Save the collection connection on the phone first", state.configured)
        val settings = state.settings()
        val manager = context.getSystemService(android.net.ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: error("No active network")
        val caps = manager.getNetworkCapabilities(network)!!
        assertTrue("Wi-Fi is required for this device test", caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI))
        try {
            SmbLibrary(settings, network, WorkToken()).use { remote ->
                val entries = Catalog.manifest(remote.manifest()); assertTrue(entries.isNotEmpty())
                val decisions = remote.sourceDecisions()
                val chosen = entries.first { entry -> entry.ids.any { SourceDecisions.get(decisions, it, entry.hash) != null } }
                val raw = remote.metadata(chosen); assertTrue(raw.isNotEmpty())
                val info = Catalog.metadata(raw, chosen, JSONObject(raw).getString("id"))
                assertNotNull(SourceDecisions.get(decisions, info.id, chosen.hash))
                val temporary = File(context.cacheDir, "smb-read-test.jpg")
                try { remote.download(chosen, temporary); assertEquals(chosen.hash, fileHash(temporary)) }
                finally { temporary.delete() }
            }
        } catch (e: Exception) {
            val message = WallpaperEngine.safeError(e)
            state.status = message
            fail(message)
        }
    }

    @Test fun liveHomeWallpaperPreviewRotationPauseAndResume() {
        // Deliberate device acceptance test; never changes wallpaper during the default test suite.
        assumeTrue(InstrumentationRegistry.getArguments().getString("exerciseWallpaper") == "true")
        val engine = (context.applicationContext as NasaApp).engine
        assertTrue(engine.state.configured)
        val manager = WallpaperManager.getInstance(context)
        val jobs = context.getSystemService(JobScheduler::class.java)
        fun run(action: WallpaperAction) {
            val done = CountDownLatch(1)
            assertTrue("Another operation is already active", engine.run(action) { done.countDown() })
            assertTrue("Wallpaper operation exceeded its deadline", done.await(110, TimeUnit.SECONDS))
        }
        engine.pause()
        val beforeTest = manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM)
        run(WallpaperAction.TEST)
        assertTrue(engine.state.status, engine.state.preview.isNotEmpty())
        assertEquals(beforeTest, manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM))
        run(WallpaperAction.NEXT)
        assertTrue(engine.state.status, engine.currentMatchesSystem())
        val first = engine.state.current
        val firstId = engine.state.currentWallpaperId
        assertEquals(engine.state.settings().fitWhole, engine.state.currentFitWhole)
        assertTrue(engine.cache.cached().size in 1..3)
        engine.state.enabled = true
        assertTrue(RotationJob.schedule(context, engine.state.settings().intervalMinutes))
        run(WallpaperAction.AUTOMATIC)
        assertTrue(engine.state.status, engine.currentMatchesSystem())
        assertNotEquals(firstId, engine.state.currentWallpaperId)
        assertNotEquals(first, engine.state.current)
        engine.pause()
        val pausedId = engine.state.currentWallpaperId
        assertNull(jobs.getPendingJob(RotationJob.ID))
        assertFalse(engine.run(WallpaperAction.AUTOMATIC))
        assertEquals(pausedId, manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM))
        engine.state.enabled = true
        assertTrue(RotationJob.schedule(context, engine.state.settings().intervalMinutes))
        assertTrue(jobs.getPendingJob(RotationJob.ID)!!.isPersisted)
        engine.state.status = "Slideshow ready. Connection, home wallpaper, shuffle and pause/resume verified."
    }

    @Test fun captureOwnAppPreviewAndDetailsForVisualReview() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("captureUi") == "true")
        val instrument = InstrumentationRegistry.getInstrumentation()
        val activity = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
        fun capture(name: String) = instrument.runOnMainSync {
            val view = activity.window.decorView
            val image = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            try { view.draw(Canvas(image)); File(context.filesDir, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
            finally { image.recycle() }
        }
        var details: Button? = null
        repeat(60) {
            if (details == null) {
                instrument.runOnMainSync { details = descendants(activity.window.decorView).filterIsInstance<Button>().firstOrNull { it.text == "Image details" && it.isEnabled } }
                if (details == null) Thread.sleep(100)
            }
        }
        assertNotNull("An image must be loaded before visual review", details)
        capture("ui-home.png")
        instrument.runOnMainSync { details!!.performClick() }
        instrument.waitForIdleSync()
        capture("ui-details.png")
        // Leave the installed app on its own home page, without interacting with other phone apps.
        instrument.runOnMainSync { descendants(activity.window.decorView).filterIsInstance<Button>().first { it.text == "‹ Wallpaper" }.performClick() }
    }

    @Test fun keystoreCredentialsSurviveRecreationAndAreNotPlaintext() {
        val isolated = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences("device_test_$name", mode)
        }
        val state = AppState(isolated)
        val settings = ConnectionSettings("smb://example/Photos", "smb://example/Catalog", "fixture-user", "fixture-secret-only", "")
        try {
            state.save(settings)
            assertEquals(settings.password, AppState(isolated).settings().password)
            val ciphertext = isolated.getSharedPreferences("connection_encrypted", Context.MODE_PRIVATE).all.toString()
            assertFalse(ciphertext.contains(settings.password)); assertFalse(ciphertext.contains(settings.username))
        } finally { state.forget() }
    }

    @Test fun realAndroidJpegDecodeAndCropKeepExactPortraitDimensions() {
        val file = File(context.cacheDir, "device-crop-test.jpg")
        val source = Bitmap.createBitmap(3840, 2160, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.rgb(100, 40, 150))
        try {
            file.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.JPEG, 92, it)) }
            source.recycle()
            for (fit in listOf(true, false)) {
                val bitmap = WallpaperRenderer.render(file, 1440, 3120, fit)
                assertEquals(1440, bitmap.width); assertEquals(3120, bitmap.height)
                if (fit) assertEquals(Color.BLACK, bitmap.getPixel(0, 0))
                else assertNotEquals(Color.BLACK, bitmap.getPixel(0, 0))
                bitmap.recycle()
            }
        } finally { if (!source.isRecycled) source.recycle(); file.delete() }
    }

    @Test fun readsRealCatalogDecisionsForBothProvidersAndSelectedLinksResolveOnPhone() {
        // The runner receives a private copy of real existing receipts/metadata, never credentials.
        val file = File(context.filesDir, "device-source-fixtures.json")
        assertTrue("Push the real-record fixture file before this test", file.isFile)
        val fixture = JSONObject(file.readText())
        val receipts = fixture.getJSONObject("receipts").toString()
        val records = fixture.getJSONArray("records")
        assertTrue(records.length() >= 6)
        var pages = 0; var images = 0
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i)
            val id = record.getString("id"); val hash = record.getString("presentationSha256")
            val entry = PublishedImage("NASA-$hash.jpg", hash, listOf(id), 1)
            val info = Catalog.metadata(record.toString(), entry, id)
            assertTrue(info.title.isNotBlank())
            val decision = SourceDecisions.get(receipts, id, hash)
            assertNotNull("No shared source decision for $id", decision)
            if (decision!!.kind == "page") pages++ else if (decision.kind == "image") images++
            val connection = URL(decision.url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "HEAD"; connection.connectTimeout = 12000; connection.readTimeout = 12000
                connection.instanceFollowRedirects = false
                assertTrue("Validated URL must resolve directly: $id status ${connection.responseCode}", connection.responseCode in 200..299)
            } finally { connection.disconnect() }
        }
        assertTrue(pages >= 3); assertTrue(images >= 3)
    }
}
