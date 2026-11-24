# Mirsad Android: pitch

Hackathon prototype for the Abu Dhabi Police hackathon by the Mirsad team. Not an official app. Every number below is
either a design target or marked as a placeholder until the tests that measure it are in the build.

## 60-second talk track

Everyone in this room has had the message: your parcel is held, pay three dirhams here. Your card is suspended. Read
me the code. It comes by SMS, WhatsApp, Telegram, and then the phone rings.

Mirsad is a scam shield that lives on the phone. When a message or call arrives, it decides in milliseconds: allow,
warn, or hold. A warning tells you why, in Arabic or English, with the Abu Dhabi Police safety line. A hold takes the
notification away before you read it, keeps a copy, and gives you two buttons: Not a scam, and Report.

It never deletes anything. It never guesses: a hold needs real evidence, a fake link, a blocked sender, a request for
your PIN. If it is wrong, one tap puts the message back and teaches it.

And it has no internet permission. Check the APK yourself. Nothing leaves the phone until you tap Report, and what
leaves is not a screenshot but a structured evidence packet the Mirsad officer service can ingest and match across
cases. Install it, open Demo, share a message. Two minutes.

## Short answers

### What about false positives?

Mirsad is designed around the assumption that it will sometimes be wrong. It never deletes a message; it only removes
the notification and keeps a copy, and the message is still in WhatsApp or Messages. A hold is never silent and never
driven by a score alone: it needs hard evidence such as a lookalike of an official domain, a blocklisted sender or
fingerprint, or a request for credentials or payment. Saved contacts, allow-listed senders, bank one-time codes and
content the system hides are never held, and calls are held only on a blocklisted number or a number that just sent a
held message. When it is wrong, Not a scam restores the notification, allow-lists the sender and the message
fingerprint, and offers Undo; a suite of 40+ legitimate UAE messages gates every build.

### What gets reported?

Nothing, until the user taps Report and picks an app in the Android share sheet. The report is a small JSON document
about one incident: channel, level, score, reason codes, a fingerprint of the normalised text, and the extracted
artifacts: sender, URLs and their registrable domains, IBANs, e-mails, wallets, wa.me and t.me handles. The message
text is included only when the user ticks a box on a preview screen that shows the exact JSON. It never contains
contacts, other messages, location, device identifiers or the user's own number. Demo and synthetic incidents are
marked as such and cannot be sent to the police shortcuts.

### How is privacy guaranteed?

The app holds no `INTERNET` permission, and that is checkable: `aapt dump permissions` on the APK lists
`POST_NOTIFICATIONS`, `VIBRATE` and one permission the app declares for itself, nothing else. A Gradle task fails the build if any dependency merges the internet permission into
the manifest, so the guarantee cannot erode by accident. There is no account, no analytics, no crash reporting and no
foreground service. Everything is stored in the app's private database, backups are off, and the only way data leaves
is the share sheet after a deliberate tap. Notification access and call screening are system-level grants the user can
revoke at any time in Settings.

### What are the limits?

Call screening sees the number and the direction, not audio, and only for numbers that are not in contacts; WhatsApp
and other internet calls cannot be screened at all. A notification listener can remove another app's notification but
not the message, which is also why nothing is ever lost. Android 15 and newer hide one-time-code notifications from
listeners; Mirsad treats hidden content as unavailable, never as suspicious. A sideloaded APK needs "Allow restricted
settings" in App info before notification access can be granted. The model is trained on synthetic data and the official
domain and reporting-channel lists are starter lists, so the accuracy figures are placeholders until real, anonymised
case data and a verified list are available.

### How does it fit with the Mirsad officer service?

The root of this repository is the Mirsad service: officer-side evidence capture and review, with a dashboard, an HTTP
API and an event stream. Mirsad Android is the citizen-side counterpart that produces evidence in the first place. An
exported Android report maps onto the service's `POST /v1/ingest` intake event; a laptop-side script
(`scripts/push_report_to_mirsad.sh`) posts it with a connector token that never touches the phone, and the mapping is
documented in `docs/EVIDENCE_SCHEMA.md`. A scam that one phone held becomes a timestamped, reviewable item for an
officer, with the same reason codes and artifacts the citizen saw, and the same fingerprint lets analysts group one
campaign across many phones. Police intelligence flows the other way as a JSON blocklist the phone imports from a file.

### What's next?

First, real data: train and evaluate the classifier on anonymised police case data instead of synthetic rows, and
publish the held-out numbers in the README. Second, verification with the police team: the official domain list that
drives lookalike detection and the reporting channels (Aman, eCrime) are starter lists marked to be confirmed. Third, a
signed release build and testing on a wider range of phones and messaging apps. Only after those have no open defects:
an OTP guard that warns when a code is about to be shared, and an optional on-device model that explains a verdict in
fuller language, behind an interface so it can be left out.

## One-line close

Mirsad decides on the phone, explains in your language, never deletes, never guesses, never phones home, and turns
every attempt into evidence the police can use.
