# Unreel — block Reels & Shorts, keep the rest

An Android app in the spirit of Socialite: it stops **Instagram Reels**, **YouTube Shorts** and
**Facebook Reels** while keeping Instagram chats, stories and friends' posts, and it shows how much time
you spend in those apps.

## What it does
- **Blocks Reels / Shorts.** Opening a Reel or Short gets you sent straight back. Opening the Reels tab sends you to the Home feed.
- **Keeps the good parts.** Instagram DMs, stories and your feed work as usual. Reels a friend sends you in chat can still play (switch).
- **Optional:** block Instagram's Explore tab (also blocks search).
- **Screen time.** Today's time per app, a 7-day chart, Reels blocked per day and an estimate of time saved.
- **Daily limits.** Set a limit in minutes per app. When it's reached, Unreel sends you to the home screen for the rest of the day.
- **Pause** for 10 minutes when you really need it. It turns back on by itself.
- **Capture.** If a Reel gets through (apps change their screens), capture that screen and share it so the detection can be updated.

## Install
1. On your phone, open the repository's **Releases** page and download the latest `Unreel.apk`
   (built automatically by `.github/workflows/build-unreel-app.yml`).
2. Open it and allow installing from this source.
3. Open Unreel and follow the two setup steps:
   - **Turn on the blocker:** Settings › Accessibility › Unreel › On.
     On Android 13+ the switch is greyed out for apps installed from a file: open
     *App info › ⋮ (top right) › Allow restricted settings*, then try again.
   - **Allow usage access:** Settings › Usage access › Unreel › On.
4. Some phones (Xiaomi, Samsung, Huawei…) kill background services: set Unreel's battery usage to *Unrestricted*.

## How it works
- `ReelBlockerService` is an Accessibility Service limited to the three apps (`res/xml/accessibility_config.xml`),
  so it never sees anything else. It looks for the apps' Reels/Shorts screens (`Detectors.kt`) and presses Back,
  or taps the Home tab when you're on the Reels tab.
- Screen time comes from Android's usage history (`UsageRepo.kt`), not from the service.
- Nothing is sent anywhere. Settings and counters stay in the app's private storage.

## Build locally
Needs JDK 17 and the Android SDK: `./gradlew assembleRelease`, APK at `app/build/outputs/apk/release/`.
Every build is signed with the committed `app/unreel.keystore`, so a new build installs over the old one.

iPhone isn't supported: iOS doesn't let apps look inside or control other apps.
