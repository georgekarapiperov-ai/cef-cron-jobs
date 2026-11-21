package com.unreel.app

/** The apps Unreel watches. */
enum class TrackedApp(val pkg: String, val label: String, val color: Int) {
    INSTAGRAM("com.instagram.android", "Instagram", 0xFFE1306C.toInt()),
    YOUTUBE("com.google.android.youtube", "YouTube", 0xFFFF3B30.toInt()),
    FACEBOOK("com.facebook.katana", "Facebook", 0xFF3B82F6.toInt());

    companion object {
        val PACKAGES = entries.map { it.pkg }.toSet()
        fun of(pkg: String?): TrackedApp? = entries.firstOrNull { it.pkg == pkg }
    }
}
