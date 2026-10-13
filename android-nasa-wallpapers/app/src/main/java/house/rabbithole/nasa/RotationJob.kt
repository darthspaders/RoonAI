package house.rabbithole.nasa

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import java.util.concurrent.TimeUnit

class RotationJob : JobService() {
    private var current: JobParameters? = null
    private var ownsWork = false
    override fun onStartJob(params: JobParameters): Boolean {
        current = params
        ownsWork = (application as NasaApp).engine.run(WallpaperAction.AUTOMATIC) {
            if (current === params) { current = null; ownsWork = false; jobFinished(params, false) }
        }
        if (!ownsWork) current = null
        return ownsWork
    }
    override fun onStopJob(params: JobParameters): Boolean {
        current = null
        if (ownsWork) (application as NasaApp).engine.stopWork()
        ownsWork = false
        return false // Next periodic opportunity, not a battery-draining immediate retry loop.
    }
    companion object {
        const val ID = 74031
        fun schedule(context: Context, minutes: Int): Boolean {
            require(minutes in ConnectionSettings.INTERVALS)
            // No network constraint: cached offline rotation still works. The reader enforces Wi-Fi policy.
            val job = JobInfo.Builder(ID, ComponentName(context, RotationJob::class.java))
                .setPeriodic(TimeUnit.MINUTES.toMillis(minutes.toLong()))
                .setPersisted(true).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build()
            return context.getSystemService(JobScheduler::class.java).schedule(job) == JobScheduler.RESULT_SUCCESS
        }
        fun cancel(context: Context) { context.getSystemService(JobScheduler::class.java).cancel(ID) }
    }
}

class RestoreSchedule : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        Thread {
            try {
                val state = AppState(context)
                if (state.enabled) {
                    val ok = RotationJob.schedule(context, state.settings().intervalMinutes)
                    if (!ok) { state.enabled = false; state.status = "Open the app to start the slideshow again." }
                }
            } catch (_: Exception) { AppState(context).status = "Open the app to check your saved connection." }
            finally { pending.finish() }
        }.start()
    }
}
