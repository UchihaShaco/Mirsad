#!/usr/bin/env bash
# Switch Mirsad between English and Arabic on the media emulator.
#
# Usage: scripts/set_locale.sh en|ar
# Env:   SERIAL (default emulator-5554)
#        LOCALE_MODE=app|system   (default app)
#
# 1. Sends the autopilot step `lang_ar` / `lang_en` (workstream C implements it; stub today).
# 2. Fallback (mode app): the per-app language API the app itself uses (AppCompat -> LocaleManager on
#    API 33+), from the shell:  cmd locale set-app-locales app.mirsad.shield --user 0 --locales ar-AE
#    (`adb shell cmd locale help`: "set-app-locales <PACKAGE_NAME> [--user <USER_ID>] [--locales <LOCALE_INFO>]",
#    "get-app-locales <PACKAGE_NAME> [--user <USER_ID>]"). The system recreates the activity, no restart needed.
# 3. Mode system: `setprop persist.sys.locale ar-AE` + zygote restart + relaunch (slow, ~30 s; whole device).
#
# Idempotent; prints the resulting app locale.

source "$(dirname "$0")/_lib.sh"

[[ $# -ge 1 ]] || { echo "usage: $0 en|ar" >&2; exit 2; }
LOCALE_MODE="${LOCALE_MODE:-app}"
case "$1" in
  en) STEP=lang_en; TAG="en-US" ;;
  ar) STEP=lang_ar; TAG="ar-AE" ;;
  *) echo "usage: $0 en|ar" >&2; exit 2 ;;
esac
require_device

autopilot_step "$STEP"
sleep 1

current_app_locale() {
  # Output on API 34: "Locales for app.mirsad.shield for user 0 are [ar-AE]"
  adbs shell cmd locale get-app-locales "$APP_ID" --user 0 2>/dev/null | tr -d '\r' | sed -n 's/.*\[\(.*\)\].*/\1/p'
}

if [[ "$LOCALE_MODE" == "system" ]]; then
  log "Setting system locale to $TAG (zygote restart)"
  adbs shell setprop persist.sys.locale "$TAG"
  adbs shell setprop ctl.restart zygote
  sleep 5
  deadline=$(( $(date +%s) + 90 ))
  while (( $(date +%s) < deadline )); do
    v="$(adbs_t 10 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    [[ "$v" == "1" ]] && break
    sleep 3
  done
  adbs shell input keyevent 82 >/dev/null 2>&1 || true
  adbs shell am start -n "$MAIN_ACTIVITY" >/dev/null
  log "system locale: $(adbs shell getprop persist.sys.locale | tr -d '\r')"
  exit 0
fi

cur="$(current_app_locale || true)"
if [[ "$cur" != "$TAG"* && "$cur" != "${TAG%%-*}"* ]]; then
  log "App locale is '${cur:-<system>}'; applying per-app locale $TAG via cmd locale"
  adbs shell cmd locale set-app-locales "$APP_ID" --user 0 --locales "$TAG" || log "WARNING: cmd locale set-app-locales failed"
  sleep 1.5
fi
log "app locale: $(current_app_locale || echo '<unknown>')"
