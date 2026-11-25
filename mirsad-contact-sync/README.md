# Mirsad contact sync: known scammer contacts (مرصاد)

Mirsad contact sync puts every number the police flag as a scammer onto one contact on the citizen's phone, named
**⚠️ Known Scammer** (in Arabic: **⚠️ محتال معروف**, see section 6). The phone's dialer, SMS, WhatsApp and Telegram then
show that name the moment the number calls or writes. When a number is cleared it disappears from the contact again.
It has two pieces: a small sync server that holds the list and pushes it to phones within about a second, and an
Android app that keeps the contact up to date. It is a hackathon prototype for the Abu Dhabi Police hackathon by the
Mirsad team, not an official app.

```
 Mirsad portal / demo dashboard ──REST──►  sync server (FastAPI + SQLite, Docker)
                                                │  WebSocket push: the full list on connect and after every change
                                                ▼
                              Android app (foreground service) ──► one contact "⚠️ Known Scammer"
                                                                   holding every flagged number
```

**Internal identifiers keep the working name.** The component was built as "ScamShield" before it joined Mirsad. What
people see now says Mirsad; what phones and scripts already depend on is unchanged, so the phones running today keep
working: the Android package and `applicationId` `com.scamshield.guard`, the `SCAMSHIELD_*` environment variables, the
API paths and WebSocket messages below, the compose service `sync`, the container `scamshield-sync` (the tunnel routes to
that name), the data volume, `android/scamshield.properties`, and the Python helper `scamshield_client.ScamShield`.

| Path | What |
|---|---|
| `sync-server/app/main.py` | The API and WebSocket hub; the list lives in one SQLite file in the data volume |
| `sync-server/app/static/dashboard.html` | Demo dashboard with an on/off switch per number: `http://localhost:8080/dashboard` |
| `sync-server/client/scamshield_client.py` | Standard-library helper for scripts and bots: `ScamShield().flag(...)` |
| `sync-server/tests/` | Server tests (section 8) |
| `android/` | The Kotlin app (minSdk 26, targetSdk 35) |
| `docker-compose.yml` | The server alone; the Cloudflare tunnel is run once for the whole of Mirsad, not here |

## 1. Try it in two minutes

**Server** (Docker):

```sh
cd mirsad-contact-sync
cp .env.example .env              # leave SCAMSHIELD_ADMIN_TOKEN empty for open demo mode (see section 7)
docker compose up -d --build
curl -s http://localhost:8080/healthz
```

Open `http://localhost:8080/dashboard`, type a number in international format (for a demo, a fictional one such as
`+44 7700 900417`) and flag it.

**Phone.** Build the app (section 8) with `android/scamshield.properties` pointing at the server (`http://10.0.2.2:8080`
on the Android emulator, or the tunnel's HTTPS address on a real phone), install it, open **Mirsad**, tap
**Turn on protection** and allow Contacts and Notifications. Flag a number on the dashboard: within about a second the
**⚠️ Known Scammer** contact on the phone holds it. Switch it off on the dashboard and it is gone.

On Samsung phones, also allow **"Let app always run in background"** when asked, set Settings > Apps > Mirsad >
Battery to **Unrestricted**, and make sure the app is not in "Sleeping" or "Deep sleeping" apps; Samsung stops
background apps aggressively without this.

## 2. What it does on the phone

- **Live.** A foreground service with a silent, low-priority notification ("Mirsad: known scammer contacts on") holds a
  WebSocket to the server. The server sends the full list on connect and after every change, and the app reconciles
  the contact with it. It reconnects with backoff, and at once when the network comes back.
- **Fallback.** WorkManager fetches `/api/v1/snapshot` every 15 minutes and restarts the service if it was killed.
  After a reboot or an app update, protection restarts by itself.
- **DNS fallback.** If the network's DNS cannot resolve the server (venue Wi-Fi, a stale cache), the app resolves it over
  DNS-over-HTTPS (Cloudflare, then Google).
- **One contact, device-local.** The contact is never synced to a Google account, and aggregation is disabled so it never
  merges into the user's own contacts. After 50 numbers it continues in "⚠️ Known Scammer 2", "… 3", and so on; empty
  extra contacts are deleted and the rest renumbered. The app finds its own contacts through a hidden marker row and
  never touches any other contact. If the user deletes the contact, it is recreated on the next change.
- **Turn off and remove scam contacts** deletes everything the app created.
- **The name** comes from the server with every list (`SCAMSHIELD_CONTACT_NAME`, default `⚠️ Known Scammer`), so it
  can be changed for every phone at once.

Tested on an Android 13 emulator: flag, unflag, toggle and delete reach the contact in about one second (section 8);
overflow into contacts 2 and 3 and back; a user's contact with a similar number is left alone; reboot and app update
reconnect by themselves; a deleted contact is recreated; an incoming call and SMS from a flagged number show
"⚠️ Known Scammer".

## 3. The API

**Writes and the full list** take `Authorization: Bearer <SCAMSHIELD_ADMIN_TOKEN>` (not needed in open demo mode).

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/v1/scammers` | `{"phone","label?","note?","source?","active?"}` | flag (upsert) |
| PATCH | `/api/v1/scammers/{phone}` | `{"active": true/false}` | **dashboard toggle** |
| POST | `/api/v1/scammers/{phone}/toggle` | – | flip (creates if unknown) |
| DELETE | `/api/v1/scammers/{phone}` | – | remove completely |
| POST | `/api/v1/scammers/bulk` | `{"phones":[...]}` | import many |
| GET | `/api/v1/scammers` | – | full list with labels/sources |

**Phones** use the device token (or the admin token): `GET /api/v1/snapshot`, and `WS /api/v1/ws` with
`Authorization: Bearer <token>` or `?token=<token>`. Both return
`{"type":"snapshot","version":N,"contact_name":"…","numbers":["+…", …]}`; the WebSocket sends it on connect and after
every change. A rejected WebSocket is closed with code 4401. `GET /healthz` returns the list version and how many phones
are connected.

- Every successful write increments `version` by one and pushes the new list to every connected phone. A write that
  fails (a number that cannot be read, an unknown number) changes nothing.
- An upsert keeps the existing label, note and source when the new request leaves them out. `active: false` keeps the
  number on the server but takes it off phones.
- Numbers are stored in E.164 (`+447700900417`). `+44 7700 900417`, `0044 7700 900417` and `+44 (0)7700 900417` all
  become the same number. A number without a country code is read with `SCAMSHIELD_DEFAULT_REGION` (for example `AE`);
  with that empty, such a number is rejected with 422. Store numbers with their country code: a phone matches a full
  international number against WhatsApp and SMS senders reliably.
- URL-encode the `+` in path parameters: `/api/v1/scammers/%2B447700900417`.

```python
from scamshield_client import ScamShield          # reads SCAMSHIELD_URL and SCAMSHIELD_ADMIN_TOKEN from the environment
ScamShield().flag("+44 7700 900417", label="@fake_parcel", source="mirsad-portal")
```

## 4. How it fits with the other parts of Mirsad

| Part | Where it runs | What it does with a scam number |
|---|---|---|
| **The Mirsad portal** (repository root) | An officer's machine | Officers and the AI assistant flag the number; it goes to the Phone watchlist |
| **Mirsad Android** ([`../mirsad-android/`](../mirsad-android/README.md)) | The citizen's phone, with no internet permission | Holds SMS and rejects calls from numbers in a signed blocklist file exported from the portal |
| **Contact sync** (this folder) | A small server, and an app on the citizen's phone | Names the number "⚠️ Known Scammer" in every app on the phone, within about a second |
| **The website shield** ([`../mirsad-gateway/`](../mirsad-gateway/README.md)) | The network | Checks websites, not phone numbers; it has no link to this list |

**From the portal to every phone.** When an officer, or the AI assistant, flags a scammer in the portal, the portal
sends the number to this server with `POST /api/v1/scammers` (`source` names the portal), and clearing it sends
`PATCH /api/v1/scammers/{phone}` with `{"active": false}` or `DELETE`. On the server side that is one upsert: the
number is normalised to E.164, the list version goes up by one, and the new list is pushed over every open WebSocket,
so each phone running the app shows "⚠️ Known Scammer" for that number within about a second. A phone that was offline
gets the whole list when it reconnects, or from the 15-minute fallback. The portal's side (when it sends, the server
address and token it uses, what an officer sees) is described in the [root README](../README.md). Any other script can
use the same calls through `client/scamshield_client.py`.

**Why two Android apps, kept separate.** Mirsad Android's promise is that it holds no internet permission, and its build
fails if one appears. This app exists to receive the list from the network, so it needs `INTERNET`, and it writes
contacts, which Mirsad Android never asks for. Merging the two would break that promise, so the code bases and Gradle
projects stay apart and a citizen can install either or both. They complement each other: Mirsad Android screens
messages and calls on the phone and takes the police list as a signed file the citizen imports; this app gives the same
kind of number a warning name everywhere, including WhatsApp and Telegram calls that Mirsad Android cannot screen, and
updates without the citizen doing anything.

Not connected today: Mirsad Android does not read this server, and this server does not produce the portal's signed
blocklist file; the website shield neither reads nor writes this list.

## 5. Running from this folder instead of the first install

The instance running for the demo was started from the component's original folder, outside this repository. After the
demo, move to this copy as follows (do not do it during the demo):

1. Export the list from the running server: `curl -s http://localhost:8080/api/v1/scammers > scammers.json` (add the
   admin token header if one is set).
2. Stop the old server from its own folder: `docker compose stop sync` (or `docker stop scamshield-sync`). Remove the
   old container (`docker rm scamshield-sync`) so the name is free. If the old folder's compose file also ran a
   `cloudflared` service, leave the tunnel to the system-wide one.
3. Here: `cp .env.example .env`, copy the values over from the old `.env` (never commit it), then
   `docker compose up -d --build`.
4. The data volume belongs to the Docker installation that created it. This compose file pins its name
   (`scamshieldapp_scamshield-data`), so on the same Docker installation the list is simply there. On another
   installation, or to start clean, import the export:

   ```sh
   jq '{phones: [.scammers[] | select(.active == 1) | .phone]}' scammers.json \
     | curl -s -X POST http://localhost:8080/api/v1/scammers/bulk -H 'Content-Type: application/json' -d @-
   ```

   Bulk import carries the active numbers only, without labels, notes or sources; re-post those through
   `POST /api/v1/scammers` if they matter.
5. The tunnel reaches the server as `scamshield-sync:8080` or through port 8080 on the machine, so it needs no change;
   the phones reconnect by themselves.

## 6. The contact name in Arabic

The name is the server setting `SCAMSHIELD_CONTACT_NAME`. For Arabic phones: `SCAMSHIELD_CONTACT_NAME=⚠️ محتال معروف`
(known scammer). Every phone renames its contact on the next list it receives.

## 7. Security notes

- **Open demo mode.** With `SCAMSHIELD_ADMIN_TOKEN` empty, anyone who can reach the server can read the whole list,
  flag any number as a scammer on every phone, and delete entries, through the dashboard or the API, and phones need
  no token either. Behind a public tunnel that means anyone with the address. This is for the demo only; set an admin
  token before anything else. Then the dashboard asks for the token and keeps it in that browser.
- **Device token.** With an admin token set, phones must present `SCAMSHIELD_DEVICE_TOKEN` (or the admin token). The
  device token only reads the list. A build made with `android/scamshield.properties` carries the server address and
  device token inside the APK, so treat that APK like the token itself.
- **Phone permissions:** `INTERNET` and `ACCESS_NETWORK_STATE` (receive the list), `READ_CONTACTS` and
  `WRITE_CONTACTS` (keep its own contact), `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_SPECIAL_USE` (the status notification and live connection), `RECEIVE_BOOT_COMPLETED` (restart after
  a reboot) and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. The app sends nothing about the phone or its contacts; it only
  downloads the list. Cleartext HTTP is allowed so the emulator can reach `http://10.0.2.2`; over the tunnel it is HTTPS.
- What the server stores per number: the number, on/off, label, note, source and two timestamps.

## 8. Build from source, tests

**Server tests** (pytest and FastAPI's TestClient, synthetic numbers from the fictional ranges `+44 7700 900xxx` and
`+1 202 555 01xx` only):

```sh
cd mirsad-contact-sync/sync-server
python3 -m venv /tmp/mirsad-sync-venv
/tmp/mirsad-sync-venv/bin/pip install -r requirements.txt -r requirements-dev.txt
/tmp/mirsad-sync-venv/bin/python -m pytest -q
```

34 tests cover flag and upsert, toggle, delete, bulk import, E.164 normalisation and the default-region rule, the admin
token on and off, the device token on the snapshot and the WebSocket, the snapshot on connect and after each change,
and the version counter.

**Android app.** JDK 17 and the Android SDK with platform 35; the wrapper fetches Gradle 8.10.2 (AGP 8.7.2, Kotlin
2.1.20). Put `sdk.dir=<your SDK>` in `android/local.properties`, and optionally copy
`android/scamshield.properties.example` to `android/scamshield.properties` with the server address and device token.

```sh
cd mirsad-contact-sync/android
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
```

An update installs over an existing copy only when both are signed with the same key. A debug build is signed with the
building machine's debug key, so to update phones that have a build from another machine, sign with that machine's
debug keystore, for example
`./gradlew assembleDebug -Pandroid.injected.signing.store.file=<that debug.keystore> -Pandroid.injected.signing.store.password=android -Pandroid.injected.signing.key.alias=androiddebugkey -Pandroid.injected.signing.key.password=android`.
Do not uninstall to get round a signature mismatch: that deletes the app's settings.

**End to end, measured on 25 November 2026** against the running server and an Android 13 emulator, polling the
phone's contacts over adb (each poll takes about half a second, so the figures are upper bounds of about one second):

| Step | Build from the original folder | Build from this folder |
|---|---|---|
| Flag a new number → on the contact | 0.95 s | 0.97 s |
| Switch off → gone | 1.03 s | 0.95 s |
| Switch on → back | 0.98 s | 0.95 s |
| Delete → gone | 0.95 s | 0.96 s |

## 9. Known limits and next steps

- **One server, one list.** Every phone gets every active number; there are no per-region or per-user lists.
- **Messaging apps cache names.** In Google Messages, a thread that is already open keeps showing the number until it is
  reopened; the system contact lookup itself changes at once.
- **The contact's note is written when the contact is created.** A contact created by an earlier build keeps its old
  note ("…by ScamShield…") until it is removed and recreated (for example with **Turn off and remove scam contacts**
  and turning protection back on).
- **The app's screens are in English** apart from its name and subtitle, which also have Arabic.
- **No audit trail.** The server keeps the latest state of each number, not who changed it and when; the portal's
  case log is the record.
- **A debug-signed build**, tested on an Android 13 emulator.
- Next steps: an admin token on the public instance; Arabic screens; have the portal's signed blocklist and this list
  come from one export.

## 10. ملخص بالعربية

مزامنة جهات الاتصال جزء من مرصاد يضع كل رقم تصنّفه الشرطة محتالاً في جهة اتصال واحدة على هاتف المواطن باسم «⚠️ محتال معروف»
(أو «⚠️ Known Scammer»)، فيظهر هذا الاسم في تطبيق الهاتف والرسائل وواتساب وتيليجرام لحظة اتصال الرقم أو مراسلته.
يتكوّن من خادم صغير يحفظ القائمة ويدفعها إلى الهواتف خلال ثانية تقريباً، وتطبيق أندرويد يحدّث جهة الاتصال تلقائياً.
عندما يصنّف ضابط أو المساعد الذكي رقماً محتالاً في بوابة مرصاد، ترسل البوابة الرقم إلى هذا الخادم، فيظهر على كل الهواتف.
يبقى هذا التطبيق منفصلاً عن تطبيق مرصاد أندرويد لأن الأخير لا يملك صلاحية الإنترنت أبداً، بينما يحتاجها هذا التطبيق لاستلام القائمة.
لا يرسل التطبيق شيئاً عن الهاتف أو جهات اتصاله، ولا يلمس أي جهة اتصال لم ينشئها.
وضع العرض المفتوح (دون رمز المشرف) مخصّص للعرض فقط؛ يجب ضبط رمز المشرف قبل أي استخدام حقيقي.
