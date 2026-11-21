package com.unreel.app

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A dark panel drawn over Instagram's Home feed, between the stories row and the bottom tabs.
 * It swallows touches, so posts can't be seen or scrolled; stories, chats and tabs stay usable.
 * Accessibility overlays need no extra permission.
 */
class FeedCover(private val service: AccessibilityService) {

    private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var view: View? = null
    private var shownTop = -1
    private var shownBottom = -1

    val isShown: Boolean get() = view != null

    /** Last problem drawing the cover, for the status line. */
    var lastError: String? = null
        private set

    fun show(top: Int, bottom: Int) {
        if (bottom - top < 80) { hide(); return }
        if (view != null && top == shownTop && bottom == shownBottom) return

        @Suppress("DEPRECATION")
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            bottom - top,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            y = top
            if (Build.VERSION.SDK_INT >= 28) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            if (Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
        }
        try {
            val v = view
            if (v == null) {
                val nv = build()
                wm.addView(nv, lp)
                view = nv
            } else {
                wm.updateViewLayout(v, lp)
            }
            shownTop = top
            shownBottom = bottom
            lastError = null
        } catch (e: Exception) {
            lastError = e.javaClass.simpleName + ": " + e.message
            view = null
        }
    }

    fun hide() {
        view?.let { try { wm.removeView(it) } catch (_: Exception) {} }
        view = null
        shownTop = -1
        shownBottom = -1
    }

    private fun build(): View {
        val dp = service.resources.displayMetrics.density
        fun line(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(service).apply {
            text = s
            textSize = size
            setTextColor(color)
            gravity = Gravity.CENTER
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
        }
        return LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF0F1115.toInt())
            setPadding((24 * dp).toInt(), 0, (24 * dp).toInt(), 0)
            addView(line("Feed hidden", 20f, 0xFFF2F3F5.toInt(), bold = true))
            addView(line("Stories are above ↑   Chats are top right ✈", 14f, 0xFF9AA0AC.toInt()))
            addView(line("Unreel", 12f, 0xFF7C6CFF.toInt()))
            // Touches on this window never reach Instagram underneath.
            isClickable = true
        }
    }
}
