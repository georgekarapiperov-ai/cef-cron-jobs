package com.unreel.app

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import java.io.File

/**
 * Acts only on Instagram, YouTube and Facebook. When a Reels / Shorts screen appears it backs out of it,
 * covers Instagram's Home feed if asked, and enforces the daily time limits.
 * Events from other apps are only used to notice that Instagram is no longer on screen; their content is never read.
 */
class ReelBlockerService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var checkPending = false
    private var lastActionAt = 0L
    private var lastToastAt = 0L

    private var usageCache: Map<TrackedApp, Long> = emptyMap()
    private var usageCachedAt = 0L

    private lateinit var feedCover: FeedCover

    /** While the feed cover is up, re-check every 700 ms so it goes away the moment Instagram leaves the Home feed. */
    private val coverWatchdog = object : Runnable {
        override fun run() {
            if (!feedCover.isShown) return
            if (rootInActiveWindow?.packageName?.toString() != TrackedApp.INSTAGRAM.pkg) feedCover.hide()
            else checkScreen()
            if (feedCover.isShown) handler.postDelayed(this, 700)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = Prefs(this)
        feedCover = FeedCover(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString()
        if (TrackedApp.of(pkg) == null) {
            // Events from other apps are ignored; a new app window just means Instagram's feed is no longer on screen.
            if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && pkg != packageName) feedCover.hide()
            return
        }
        // Content events arrive in bursts; look at the screen at most every 150 ms.
        if (checkPending) return
        checkPending = true
        handler.postDelayed({
            checkPending = false
            checkScreen()
        }, 150)
    }

    private fun checkScreen() {
        val root = rootInActiveWindow ?: return
        val app = TrackedApp.of(root.packageName?.toString()) ?: return
        val now = System.currentTimeMillis()

        if (prefs.captureRequested) {
            prefs.captureRequested = false
            saveCapture(app, root)
            toast("Unreel: screen captured. Go back to Unreel to share it.")
        }

        if (app != TrackedApp.INSTAGRAM || prefs.isPaused || !prefs.hideIgFeed) feedCover.hide()
        if (prefs.isPaused) return
        if (now - lastActionAt < 900) return  // give the last Back/tap time to land

        if (limitReached(app, now)) {
            feedCover.hide()
            act(app, now, null, home = true)
            toast("${app.label}: daily limit reached. Back to work!")
            return
        }

        val verdict = when (app) {
            TrackedApp.INSTAGRAM -> Detectors.instagram(root, prefs, now)
            TrackedApp.YOUTUBE -> Detectors.youtube(root, prefs)
            TrackedApp.FACEBOOK -> Detectors.facebook(root, prefs)
        }
        when (verdict) {
            is Verdict.Allow -> if (app == TrackedApp.INSTAGRAM && prefs.hideIgFeed) updateFeedCover(root, now)
            is Verdict.Back -> { feedCover.hide(); act(app, now, null); blockedToast(app) }
            is Verdict.Tap -> { feedCover.hide(); act(app, now, verdict.node); blockedToast(app) }
        }
    }

    private fun updateFeedCover(root: AccessibilityNodeInfo, now: Long) {
        when (val state = Detectors.instagramFeed(root, resources.displayMetrics.heightPixels)) {
            is Detectors.FeedState.NotHome -> feedCover.hide()
            is Detectors.FeedState.Cover -> {
                val wasShown = feedCover.isShown
                feedCover.show(state.top, state.bottom)
                if (!wasShown && feedCover.isShown) {
                    handler.removeCallbacks(coverWatchdog)
                    handler.postDelayed(coverWatchdog, 700)
                }
            }
            is Detectors.FeedState.ScrollToTop -> {
                lastActionAt = now
                clickSelfOrParent(state.homeTab)
            }
        }
    }

    override fun onDestroy() {
        if (::feedCover.isInitialized) feedCover.hide()
        super.onDestroy()
    }

    private fun act(app: TrackedApp, now: Long, tap: AccessibilityNodeInfo?, home: Boolean = false) {
        lastActionAt = now
        when {
            home -> performGlobalAction(GLOBAL_ACTION_HOME)
            tap != null -> if (!clickSelfOrParent(tap)) performGlobalAction(GLOBAL_ACTION_BACK)
            else -> performGlobalAction(GLOBAL_ACTION_BACK)
        }
        if (!home) prefs.addBlock(app)
    }

    private fun clickSelfOrParent(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        repeat(4) {
            val cur = n ?: return false
            if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = cur.parent
        }
        return false
    }

    private fun limitReached(app: TrackedApp, now: Long): Boolean {
        val limit = prefs.limitMinutes(app)
        if (limit <= 0) return false
        if (now - usageCachedAt > 30_000) {
            usageCache = UsageRepo.today(this)
            usageCachedAt = now
        }
        return (usageCache[app] ?: 0L) >= limit * 60_000L
    }

    private fun blockedToast(app: TrackedApp) {
        val what = if (app == TrackedApp.YOUTUBE) "Short" else "Reel"
        toast("$what blocked. Stay focused 💪")
    }

    private fun toast(msg: String) {
        val now = System.currentTimeMillis()
        if (now - lastToastAt < 2500) return
        lastToastAt = now
        Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
    }

    private fun saveCapture(app: TrackedApp, root: AccessibilityNodeInfo) {
        val text = "Unreel capture — ${app.label} — ${java.util.Date()}\n\n" + Detectors.dump(root)
        File(filesDir, CAPTURE_FILE).writeText(text)
    }

    override fun onInterrupt() = Unit

    companion object {
        const val CAPTURE_FILE = "capture.txt"
    }
}
