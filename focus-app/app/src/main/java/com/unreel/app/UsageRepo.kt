package com.unreel.app

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import java.util.Calendar

/** Reads time spent in the tracked apps from Android's own usage history. */
object UsageRepo {

    // Raw event codes, so we don't depend on constants renamed across Android versions.
    private const val RESUMED = 1          // MOVE_TO_FOREGROUND / ACTIVITY_RESUMED
    private const val PAUSED = 2           // MOVE_TO_BACKGROUND / ACTIVITY_PAUSED
    private const val STOPPED = 23         // ACTIVITY_STOPPED
    private const val SCREEN_OFF = 16      // SCREEN_NON_INTERACTIVE
    private const val DEVICE_SHUTDOWN = 26

    fun hasPermission(context: Context): Boolean {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun startOfDay(daysAgo: Int = 0): Long = Calendar.getInstance().apply {
        add(Calendar.DAY_OF_YEAR, -daysAgo)
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    /** Foreground time (ms) per tracked app between [start] and [end]. */
    fun usage(context: Context, start: Long, end: Long): Map<TrackedApp, Long> {
        val totals = HashMap<TrackedApp, Long>()
        if (!hasPermission(context)) return totals
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

        // Look back a few hours so an app already open at [start] is counted from [start].
        val events = usm.queryEvents(start - 6 * 3_600_000L, end) ?: return totals
        val openActivities = HashMap<TrackedApp, MutableSet<String>>()
        val openSince = HashMap<TrackedApp, Long>()

        fun close(app: TrackedApp, at: Long) {
            val since = openSince.remove(app) ?: return
            openActivities.remove(app)
            val from = maxOf(since, start)
            val to = minOf(at, end)
            if (to > from) totals[app] = (totals[app] ?: 0L) + (to - from)
        }

        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            when (e.eventType) {
                SCREEN_OFF, DEVICE_SHUTDOWN -> openSince.keys.toList().forEach { close(it, e.timeStamp) }
                RESUMED -> {
                    val app = TrackedApp.of(e.packageName) ?: continue
                    val set = openActivities.getOrPut(app) { HashSet() }
                    if (set.isEmpty()) openSince[app] = e.timeStamp
                    set.add(e.className ?: "")
                }
                PAUSED, STOPPED -> {
                    val app = TrackedApp.of(e.packageName) ?: continue
                    val set = openActivities[app] ?: continue
                    set.remove(e.className ?: "")
                    if (set.isEmpty()) close(app, e.timeStamp)
                }
            }
        }
        openSince.keys.toList().forEach { close(it, end) }
        return totals
    }

    fun today(context: Context): Map<TrackedApp, Long> =
        usage(context, startOfDay(), System.currentTimeMillis())

    /** Oldest first: index 0 is six days ago, index 6 is today. */
    fun lastSevenDays(context: Context): List<Map<TrackedApp, Long>> = (6 downTo 0).map { ago ->
        val start = startOfDay(ago)
        val end = if (ago == 0) System.currentTimeMillis() else startOfDay(ago - 1)
        usage(context, start, end)
    }

    fun format(ms: Long): String {
        val totalMin = ms / 60_000
        val h = totalMin / 60
        val m = totalMin % 60
        return when {
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }
}
