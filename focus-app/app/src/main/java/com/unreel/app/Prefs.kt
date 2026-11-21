package com.unreel.app

import android.content.Context
import android.content.SharedPreferences
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** All settings and counters, in one SharedPreferences file read by both the screen and the service. */
class Prefs(context: Context) {
    val sp: SharedPreferences = context.applicationContext.getSharedPreferences("unreel", Context.MODE_PRIVATE)

    var blockIgReels: Boolean
        get() = sp.getBoolean("ig_reels", true)
        set(v) = sp.edit().putBoolean("ig_reels", v).apply()

    var allowIgDmReels: Boolean
        get() = sp.getBoolean("ig_dm_reels", true)
        set(v) = sp.edit().putBoolean("ig_dm_reels", v).apply()

    var blockIgExplore: Boolean
        get() = sp.getBoolean("ig_explore", false)
        set(v) = sp.edit().putBoolean("ig_explore", v).apply()

    var blockYtShorts: Boolean
        get() = sp.getBoolean("yt_shorts", true)
        set(v) = sp.edit().putBoolean("yt_shorts", v).apply()

    var blockFbReels: Boolean
        get() = sp.getBoolean("fb_reels", true)
        set(v) = sp.edit().putBoolean("fb_reels", v).apply()

    /** Blocking is off until this time (epoch ms). */
    var pausedUntil: Long
        get() = sp.getLong("paused_until", 0L)
        set(v) = sp.edit().putLong("paused_until", v).apply()

    val isPaused: Boolean get() = System.currentTimeMillis() < pausedUntil

    /** When true, the service writes the next tracked screen's layout to a file. */
    var captureRequested: Boolean
        get() = sp.getBoolean("capture", false)
        set(v) = sp.edit().putBoolean("capture", v).apply()

    fun limitMinutes(app: TrackedApp): Int = sp.getInt("limit_${app.pkg}", 0)
    fun setLimitMinutes(app: TrackedApp, minutes: Int) = sp.edit().putInt("limit_${app.pkg}", minutes).apply()

    fun blocksOn(day: String, app: TrackedApp): Int = sp.getInt("blocks_${day}_${app.pkg}", 0)

    fun addBlock(app: TrackedApp) {
        val key = "blocks_${today()}_${app.pkg}"
        sp.edit().putInt(key, sp.getInt(key, 0) + 1).apply()
    }

    companion object {
        private val dayFormat = SimpleDateFormat("yyyyMMdd", Locale.US)
        fun dayKey(time: Long): String = synchronized(dayFormat) { dayFormat.format(Date(time)) }
        fun today(): String = dayKey(System.currentTimeMillis())
    }
}
