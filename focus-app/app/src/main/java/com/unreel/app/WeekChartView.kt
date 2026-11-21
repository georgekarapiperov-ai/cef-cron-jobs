package com.unreel.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import java.util.Calendar

/** Seven stacked bars (one per day, one colour per app) with day initials underneath. */
class WeekChartView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    private var days: List<Map<TrackedApp, Long>> = emptyList()
    private val density = resources.displayMetrics.density
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF9AA0AC.toInt(); textSize = 11 * density; textAlign = Paint.Align.CENTER
    }
    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFF2F3F5.toInt(); textSize = 10 * density; textAlign = Paint.Align.CENTER
    }
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF22262E.toInt() }
    private val rect = RectF()

    fun setData(data: List<Map<TrackedApp, Long>>) {
        days = data
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        if (days.isEmpty()) return
        val labelH = 18 * density
        val valueH = 14 * density
        val chartTop = valueH
        val chartBottom = height - labelH
        val chartH = chartBottom - chartTop
        val slot = width / days.size.toFloat()
        val barW = minOf(slot * 0.55f, 28 * density)
        val max = days.maxOf { it.values.sum() }.coerceAtLeast(30 * 60_000L)
        val radius = 5 * density

        days.forEachIndexed { i, day ->
            val cx = slot * i + slot / 2
            rect.set(cx - barW / 2, chartTop, cx + barW / 2, chartBottom)
            canvas.drawRoundRect(rect, radius, radius, trackPaint)

            var y = chartBottom
            for (app in TrackedApp.entries) {
                val ms = day[app] ?: 0L
                if (ms <= 0) continue
                val h = chartH * ms / max
                barPaint.color = app.color
                rect.set(cx - barW / 2, y - h, cx + barW / 2, y)
                canvas.drawRoundRect(rect, radius, radius, barPaint)
                y -= h
            }
            val total = day.values.sum()
            if (total >= 60_000) canvas.drawText(UsageRepo.format(total), cx, y - 4 * density, valuePaint)

            val cal = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, i - (days.size - 1)) }
            val label = if (i == days.size - 1) "Today" else
                arrayOf("S", "M", "T", "W", "T", "F", "S")[cal.get(Calendar.DAY_OF_WEEK) - 1]
            canvas.drawText(label, cx, height - 4 * density, labelPaint)
        }
    }
}
