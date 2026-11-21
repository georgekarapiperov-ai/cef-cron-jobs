package com.unreel.app

import android.view.accessibility.AccessibilityNodeInfo

/** What the service should do about the screen it is looking at. */
sealed class Verdict {
    data object Allow : Verdict()
    /** Press the system Back button. */
    data object Back : Verdict()
    /** Tap this node (e.g. the Home tab), falling back to Back if the tap fails. */
    data class Tap(val node: AccessibilityNodeInfo) : Verdict()
}

/**
 * Recognises Reels / Shorts screens from the apps' view ids and labels.
 * Apps rename these from time to time; the "Capture" button in the app records a screen so the lists can be updated.
 */
object Detectors {

    // ---------- Instagram ----------
    private const val IG = "com.instagram.android:id/"
    private val IG_REEL_VIEWER_IDS = listOf(
        "clips_viewer_view_pager",
        "clips_viewer_pager",
        "clips_video_container",
        "clips_viewer_container",
        "clips_ufi_component",
        "clips_media_component",
    )
    private val IG_DM_IDS = listOf(
        "row_thread_composer_edittext",
        "thread_composer_edittext",
        "direct_thread_toolbar",
        "message_list",
    )

    /** Per-session memory: whether the Reel on screen was opened from a chat. */
    private var lastDmSeenAt = 0L
    private var reelOpenedFromDm = false

    fun instagram(root: AccessibilityNodeInfo, prefs: Prefs, now: Long): Verdict {
        if (IG_DM_IDS.any { root.visibleId(IG + it) }) lastDmSeenAt = now

        val reelsTabSelected = root.byId(IG + "clips_tab").any { it.isSelected } ||
            root.findFirst(400) { it.isSelected && it.desc().equals("Reels", ignoreCase = true) } != null
        val inReelViewer = IG_REEL_VIEWER_IDS.any { root.visibleId(IG + it) }

        if (prefs.blockIgReels && (reelsTabSelected || inReelViewer)) {
            if (reelsTabSelected) {
                // The Reels tab is a root screen: Back would leave Instagram, so switch to the Home feed instead.
                return homeTabOrBack(root)
            }
            if (prefs.allowIgDmReels && (reelOpenedFromDm || now - lastDmSeenAt < 4_000)) {
                reelOpenedFromDm = true
                return Verdict.Allow
            }
            return Verdict.Back
        }
        if (!inReelViewer) reelOpenedFromDm = false

        if (prefs.blockIgExplore) {
            val exploreSelected = root.byId(IG + "search_tab").any { it.isSelected } ||
                root.findFirst(400) { it.isSelected && it.desc().equals("Search and explore", ignoreCase = true) } != null
            if (exploreSelected) return homeTabOrBack(root)
        }
        return Verdict.Allow
    }

    // ---------- Instagram Home feed (stories row stays, posts get covered) ----------
    sealed class FeedState {
        data object NotHome : FeedState()
        data class Cover(val top: Int, val bottom: Int) : FeedState()
        /** The stories row was scrolled away: tap Home to jump back to the top. */
        data class ScrollToTop(val homeTab: AccessibilityNodeInfo) : FeedState()
    }

    // Instagram calls the stories row the "reels tray" internally.
    private val IG_STORIES_TRAY_IDS = listOf(
        "reels_tray_container",
        "reels_tray_recycler_view",
        "stories_tray",
        "story_tray",
    )
    private var storiesTrayEverSeen = false

    fun instagramFeed(root: AccessibilityNodeInfo, screenHeight: Int): FeedState {
        val homeTab = root.byId(IG + "feed_tab").firstOrNull { it.isVisibleToUser }
            ?: root.findFirst(400) { it.desc().equals("Home", ignoreCase = true) && it.isClickable }
            ?: return FeedState.NotHome
        if (!homeTab.isSelected) return FeedState.NotHome

        val navTop = (root.byId(IG + "tab_bar").firstOrNull { it.isVisibleToUser } ?: homeTab).bounds().top
        val tray = IG_STORIES_TRAY_IDS.firstNotNullOfOrNull { id -> root.byId(IG + id).firstOrNull { it.isVisibleToUser } }
            ?: root.findFirst(800) { it.desc().contains("story at column", ignoreCase = true) }?.parent

        if (tray != null) {
            storiesTrayEverSeen = true
            return FeedState.Cover(tray.bounds().bottom, navTop)
        }
        // Stories row scrolled out of view: back to the top. (Only once we know this Instagram version shows it,
        // so a renamed id can't cause endless taps.)
        if (storiesTrayEverSeen) return FeedState.ScrollToTop(homeTab)
        return FeedState.Cover((screenHeight * 0.30).toInt(), navTop)
    }

    private fun AccessibilityNodeInfo.bounds(): android.graphics.Rect =
        android.graphics.Rect().also { getBoundsInScreen(it) }

    private fun homeTabOrBack(root: AccessibilityNodeInfo): Verdict {
        val home = root.byId(IG + "feed_tab").firstOrNull()
            ?: root.findFirst(400) { it.desc().equals("Home", ignoreCase = true) && it.isClickable }
        return if (home != null) Verdict.Tap(home) else Verdict.Back
    }

    // ---------- YouTube ----------
    private const val YT = "com.google.android.youtube:id/"
    private val YT_SHORTS_IDS = listOf(
        "reel_player_page_container",
        "reel_recycler",
        "reel_watch_player",
        "reel_player_overlay_container",
        "reel_progress_bar",
        "shorts_player_container",
    )

    fun youtube(root: AccessibilityNodeInfo, prefs: Prefs): Verdict {
        if (!prefs.blockYtShorts) return Verdict.Allow
        val inShorts = YT_SHORTS_IDS.any { root.visibleId(YT + it) } ||
            root.findFirst(400) { it.isSelected && it.desc().equals("Shorts", ignoreCase = true) } != null
        return if (inShorts) Verdict.Back else Verdict.Allow
    }

    // ---------- Facebook ----------
    // Facebook hides most view ids, so this goes by labels on the Reels screen and tab.
    private val FB_VIEWER_HINTS = listOf(
        "reels viewer",
        "reel by ",
        "like reel",
        "unmute reel",
        "share reel",
        "send reel",
        "remix this reel",
        "more options for this reel",
    )

    fun facebook(root: AccessibilityNodeInfo, prefs: Prefs): Verdict {
        if (!prefs.blockFbReels) return Verdict.Allow
        val reelsTab = root.findFirst(600) {
            it.isSelected && it.desc().lowercase().let { d -> d == "reels" || d.startsWith("reels,") || d.startsWith("reels tab") }
        }
        if (reelsTab != null) {
            val home = root.findFirst(600) {
                it.desc().lowercase().let { d -> d == "home" || d.startsWith("home,") || d.startsWith("home tab") } && it.isClickable
            }
            return if (home != null) Verdict.Tap(home) else Verdict.Back
        }
        val viewer = root.findFirst(600) { node ->
            val label = (node.desc() + " " + node.txt()).lowercase()
            FB_VIEWER_HINTS.any { label.contains(it) }
        }
        return if (viewer != null) Verdict.Back else Verdict.Allow
    }

    // ---------- Tree helpers ----------
    private fun AccessibilityNodeInfo.desc(): String = contentDescription?.toString() ?: ""
    private fun AccessibilityNodeInfo.txt(): String = text?.toString() ?: ""

    private fun AccessibilityNodeInfo.byId(fullId: String): List<AccessibilityNodeInfo> =
        try { findAccessibilityNodeInfosByViewId(fullId) ?: emptyList() } catch (_: Exception) { emptyList() }

    private fun AccessibilityNodeInfo.visibleId(fullId: String): Boolean = byId(fullId).any { it.isVisibleToUser }

    /** Breadth-first search over at most [limit] visible nodes. */
    fun AccessibilityNodeInfo.findFirst(limit: Int, match: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(this)
        var seen = 0
        while (queue.isNotEmpty() && seen < limit) {
            val node = queue.removeFirst()
            seen++
            if (node.isVisibleToUser && match(node)) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it) }
        }
        return null
    }

    /** A readable outline of the screen, used by the Capture feature. */
    fun dump(root: AccessibilityNodeInfo, maxNodes: Int = 1500): String {
        val sb = StringBuilder()
        var count = 0
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (count++ >= maxNodes) return
            sb.append("  ".repeat(depth))
                .append(node.className?.toString()?.substringAfterLast('.') ?: "?")
            node.viewIdResourceName?.let { sb.append(" id=").append(it.substringAfter(":id/")) }
            node.contentDescription?.let { sb.append(" desc=\"").append(it.toString().take(80)).append('"') }
            node.text?.let { sb.append(" text=\"").append(it.toString().take(80)).append('"') }
            if (node.isSelected) sb.append(" [selected]")
            if (node.isClickable) sb.append(" [clickable]")
            if (!node.isVisibleToUser) sb.append(" [hidden]")
            sb.append('\n')
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        return sb.toString()
    }
}
