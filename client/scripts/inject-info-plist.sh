#!/usr/bin/env bash
# Post-bundle script: injects macOS usage-description keys into the built .app
# Tauri 2's bundler doesn't auto-merge src-tauri/Info.plist, so we patch the
# generated one with plutil after the bundle step.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_PATHS=(
  "src-tauri/target/release/bundle/macos/Jarvis.app"
  "src-tauri/target/debug/bundle/macos/Jarvis.app"
)

for APP in "${APP_PATHS[@]}"; do
  PLIST="$APP/Contents/Info.plist"
  if [ ! -f "$PLIST" ]; then continue; fi
  echo "→ patching $PLIST"

  # `-replace` is idempotent (insert-or-replace).
  plutil -replace NSMicrophoneUsageDescription -string \
    "Jarvis needs microphone access to hear voice commands." "$PLIST"
  plutil -replace NSAppleEventsUsageDescription -string \
    "Jarvis uses AppleScript to control Apple apps (Notes, Music, Messages, etc)." "$PLIST"
  plutil -replace NSContactsUsageDescription -string \
    "Jarvis can search your Contacts when asked." "$PLIST"
  plutil -replace NSCalendarsUsageDescription -string \
    "Jarvis may search your Calendar when asked." "$PLIST"
  plutil -replace NSCameraUsageDescription -string \
    "Jarvis may use the camera for vision features." "$PLIST"
  plutil -replace NSScreenCaptureUsageDescription -string \
    "Jarvis needs screen recording access to look at your screen when you ask." "$PLIST"
  plutil -replace NSRemindersUsageDescription -string \
    "Jarvis can create reminders for you when asked." "$PLIST"
  plutil -replace NSSpeechRecognitionUsageDescription -string \
    "Jarvis recognises your voice commands via macOS Speech." "$PLIST"

  echo "  ✓ injected 8 usage descriptions"
done

# Install the freshly patched release build into /Applications for a stable
# bundle-ID path so macOS TCC permissions (Mic / Screen Recording / Accessibility)
# survive future rebuilds. Then wipe the bundle artifact so Spotlight doesn't
# index two copies of Jarvis.app.
RELEASE_APP="src-tauri/target/release/bundle/macos/Jarvis.app"
if [ -d "$RELEASE_APP" ]; then
  echo "→ installing to /Applications/Jarvis.app"
  # quit any running copy first to avoid file-in-use errors
  /usr/bin/pkill -9 -f "Jarvis.app/Contents/MacOS" 2>/dev/null || true
  sleep 1
  /bin/rm -rf "/Applications/Jarvis.app"
  /usr/bin/ditto "$RELEASE_APP" "/Applications/Jarvis.app"
  # Ad-hoc resign the bundle. Unsigned/changed binaries make TCC treat each
  # build as a "new app" → stale grants. Ad-hoc sign at least establishes a
  # consistent code identity for this session. Errors non-fatal.
  /usr/bin/codesign --force --deep --sign - "/Applications/Jarvis.app" 2>/dev/null || true
  echo "  ✓ /Applications/Jarvis.app updated + ad-hoc signed"

  # Wipe stale TCC grants for our bundle so the next launch re-prompts fresh.
  # tccutil runs in user context — no sudo needed for these services.
  for s in All Accessibility ScreenCapture Microphone AppleEvents \
           SystemPolicyAllFiles SpeechRecognition Calendar Reminders Contacts; do
    /usr/bin/tccutil reset "$s" "ai.jarvis.app" >/dev/null 2>&1 || true
  done
  echo "  ✓ TCC grants reset (next launch will re-prompt fresh)"

  # Remove the build artifact so Spotlight only indexes one Jarvis.app.
  # `bun run build:mac` recreates this on every run anyway.
  /bin/rm -rf "src-tauri/target/release/bundle"
  echo "  ✓ build artifact cleaned (was: target/release/bundle/)"
fi

echo "done."
