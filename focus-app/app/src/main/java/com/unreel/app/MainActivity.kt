package com.unreel.app

import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import java.io.File
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private val green = 0xFF3DDC97.toInt()
    private val red = 0xFFFF6B6B.toInt()
    private val cText = 0xFFF2F3F5.toInt()
    private val cMuted = 0xFF9AA0AC.toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        findViewById<MaterialButton>(R.id.accessButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<MaterialButton>(R.id.usageButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
        findViewById<MaterialButton>(R.id.appInfoButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }

        bindSwitch(R.id.swIgReels, { prefs.blockIgReels }, { prefs.blockIgReels = it })
        bindSwitch(R.id.swIgDm, { prefs.allowIgDmReels }, { prefs.allowIgDmReels = it })
        bindSwitch(R.id.swIgFeed, { prefs.hideIgFeed }, { prefs.hideIgFeed = it })
        bindSwitch(R.id.swIgExplore, { prefs.blockIgExplore }, { prefs.blockIgExplore = it })
        bindSwitch(R.id.swYtShorts, { prefs.blockYtShorts }, { prefs.blockYtShorts = it })
        bindSwitch(R.id.swFbReels, { prefs.blockFbReels }, { prefs.blockFbReels = it })

        buildLimitRows()

        findViewById<MaterialButton>(R.id.pauseButton).setOnClickListener {
            prefs.pausedUntil = if (prefs.isPaused) 0L else System.currentTimeMillis() + PAUSE_MS
            refreshStatus()
        }
        findViewById<MaterialButton>(R.id.captureButton).setOnClickListener {
            prefs.captureRequested = true
            Toast.makeText(this, "Now open the Reel or Short that wasn't blocked.", Toast.LENGTH_LONG).show()
        }
        findViewById<MaterialButton>(R.id.shareCaptureButton).setOnClickListener { shareCapture() }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
        refreshUsage()
    }

    private fun bindSwitch(id: Int, get: () -> Boolean, set: (Boolean) -> Unit) {
        findViewById<MaterialSwitch>(id).apply {
            isChecked = get()
            setOnCheckedChangeListener { _, checked -> set(checked); refreshStatus() }
        }
    }

    private fun accessibilityOn(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, ReelBlockerService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun refreshStatus() {
        val access = accessibilityOn()
        val usage = UsageRepo.hasPermission(this)

        findViewById<View>(R.id.setupCard).visibility = if (access && usage) View.GONE else View.VISIBLE
        findViewById<TextView>(R.id.accessText).apply {
            this.text = if (access) "✓ Blocker is on" else "1. Turn on the blocker (Accessibility)"
            setTextColor(if (access) green else cText)
        }
        findViewById<View>(R.id.accessButton).visibility = if (access) View.GONE else View.VISIBLE
        findViewById<TextView>(R.id.usageText).apply {
            this.text = if (usage) "✓ Usage access allowed" else "2. Allow usage access (for screen-time stats)"
            setTextColor(if (usage) green else cText)
        }
        findViewById<View>(R.id.usageButton).visibility = if (usage) View.GONE else View.VISIBLE

        val paused = prefs.isPaused
        findViewById<TextView>(R.id.statusChip).apply {
            when {
                !access -> { this.text = "● Off"; setTextColor(red) }
                paused -> { this.text = "● Paused"; setTextColor(0xFFFFC857.toInt()) }
                else -> { this.text = "● Protecting"; setTextColor(green) }
            }
        }
        findViewById<TextView>(R.id.pauseText).text = if (paused) {
            val left = ((prefs.pausedUntil - System.currentTimeMillis()) / 60_000) + 1
            "Blocking is paused for about $left more min."
        } else "Pause blocking for ${PAUSE_MS / 60_000} minutes. It turns itself back on."
        findViewById<MaterialButton>(R.id.pauseButton).text =
            if (paused) "Resume blocking now" else "Pause for ${PAUSE_MS / 60_000} min"
        findViewById<View>(R.id.swIgDm).isEnabled = prefs.blockIgReels
    }

    private fun refreshUsage() {
        thread {
            val today = UsageRepo.today(this)
            val week = UsageRepo.lastSevenDays(this)
            runOnUiThread { showUsage(today, week) }
        }
    }

    private fun showUsage(today: Map<TrackedApp, Long>, week: List<Map<TrackedApp, Long>>) {
        val hasUsage = UsageRepo.hasPermission(this)
        val total = today.values.sum()
        val dayKey = Prefs.today()
        val blocksToday = TrackedApp.entries.sumOf { prefs.blocksOn(dayKey, it) }

        findViewById<TextView>(R.id.todayTotal).text = if (hasUsage) UsageRepo.format(total) else "—"
        findViewById<TextView>(R.id.todaySub).text = buildString {
            if (!hasUsage) append("Allow usage access to see your time. ")
            append("$blocksToday Reels/Shorts blocked today")
            if (blocksToday > 0) append(" · ≈${blocksToday * MIN_SAVED_PER_BLOCK} min saved")
        }

        val rows = findViewById<LinearLayout>(R.id.appRows)
        rows.removeAllViews()
        for (app in TrackedApp.entries) {
            val ms = today[app] ?: 0L
            val limit = prefs.limitMinutes(app)
            val detail = buildString {
                append(if (hasUsage) UsageRepo.format(ms) else "—")
                if (limit > 0) append(" / ${limit}m")
            }
            rows.addView(appRow(app, detail, "${prefs.blocksOn(dayKey, app)} blocked"))
        }

        val weekTotal = week.sumOf { it.values.sum() }
        findViewById<TextView>(R.id.weekSummary).text = if (hasUsage)
            "${UsageRepo.format(weekTotal)} in total · ${UsageRepo.format(weekTotal / 7)} a day on average"
        else "Allow usage access to see your week."
        findViewById<WeekChartView>(R.id.weekChart).setData(week)
    }

    private fun appRow(app: TrackedApp, value: String, sub: String): View {
        val dp = resources.displayMetrics.density
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt())
            addView(View(context).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(app.color) }
                layoutParams = LinearLayout.LayoutParams((10 * dp).toInt(), (10 * dp).toInt()).apply {
                    marginEnd = (12 * dp).toInt()
                }
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(label(app.label, 15f, cText))
                addView(label(sub, 12f, cMuted))
            })
            addView(label(value, 16f, cText).apply { setTypeface(typeface, android.graphics.Typeface.BOLD) })
        }
    }

    private fun buildLimitRows() {
        val dp = resources.displayMetrics.density
        val container = findViewById<LinearLayout>(R.id.limitRows)
        for (app in TrackedApp.entries) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
            }
            row.addView(label(app.label, 15f, cText).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            val input = EditText(this).apply {
                inputType = InputType.TYPE_CLASS_NUMBER
                imeOptions = EditorInfo.IME_ACTION_DONE
                setText(prefs.limitMinutes(app).toString())
                setTextColor(cText)
                gravity = Gravity.END
                minWidth = (64 * dp).toInt()
                doAfterTextChanged { prefs.setLimitMinutes(app, it?.toString()?.toIntOrNull() ?: 0) }
            }
            row.addView(input)
            row.addView(label("min", 13f, cMuted).apply { setPadding((6 * dp).toInt(), 0, 0, 0) })
            container.addView(row)
        }
    }

    private fun label(s: String, sizeSp: Float, color: Int) = TextView(this).apply {
        text = s
        textSize = sizeSp
        setTextColor(color)
    }

    private fun shareCapture() {
        val file = File(filesDir, ReelBlockerService.CAPTURE_FILE)
        if (!file.exists()) {
            Toast.makeText(this, "No capture yet. Tap Capture first.", Toast.LENGTH_SHORT).show()
            return
        }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Unreel screen capture")
            putExtra(Intent.EXTRA_TEXT, file.readText().take(90_000))
        }
        startActivity(Intent.createChooser(send, "Share capture"))
    }

    companion object {
        private const val PAUSE_MS = 10 * 60_000L
        /** Rough estimate of scrolling avoided each time a Reel/Short is blocked. */
        private const val MIN_SAVED_PER_BLOCK = 2
    }
}
