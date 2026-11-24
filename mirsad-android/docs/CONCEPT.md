# Mirsad Android: concept

Hackathon prototype for the Abu Dhabi Police hackathon by the Mirsad team. Not an official app.

## The problem

Scam calls and messages in the UAE follow a small number of scripts: a parcel held for a three-dirham fee, an unpaid
fine, a suspended card or account, a request to read out a one-time code, an Emirates ID or UAE Pass "update", a prize,
a daily-pay job, guaranteed returns, a remote-access app to "fix" something, a relative writing from a new number. They
arrive by SMS, by WhatsApp or Telegram, and by phone, often in a mix of Arabic and English, and they impersonate the
institutions people trust most: the police, ministries, banks, telecoms, couriers.

Three things make them hard to stop with today's tools:

1. **The decision happens at the moment of reading.** By the time a person searches the number or asks a relative,
   the link has often been opened or the code read out. Help has to arrive before the message is read, on the phone.
2. **Evidence is lost.** A person who realises they were targeted usually deletes the message or blocks the number.
   What reaches the police, if anything, is a screenshot with no structure: no normalised number, no registrable domain,
   no IBAN, nothing that can be matched against other cases.
3. **Existing filters are either silent or blunt.** Carrier-side filters cannot see WhatsApp or Telegram. App-side
   filters that delete or hide without explanation lose the user's trust the first time they catch a real bank message.

## Who it is for

- **Residents of the UAE**, in Arabic or English, on an ordinary Android phone, who want a second opinion they can
  understand and overrule.
- **The person who is most often targeted and least likely to report**: someone who would rather delete the message
  than deal with it. For them the report has to be one tap, pre-filled, and clearly about the scammer, not about them.
- **Police investigators**, indirectly: each attempt that a phone holds can become a structured, timestamped item, with
  the same fields across every phone, that the Mirsad officer service can ingest and review.

## The three levels

Mirsad never makes a binary spam/not-spam call. Every event gets one of three levels, each with a fixed, visible effect:

| Level | What the user sees | What Mirsad changed |
|---|---|---|
| **ALLOW** | Nothing. | Nothing. The event is logged only if the user opens Activity and asks for allowed items. |
| **WARN** | The original notification, plus a caution from Mirsad with the reasons in plain language and the safety line. A call rings with a heads-up warning. | Nothing in the source app. |
| **HOLD** | For a message: the original notification is gone; a quiet notice says "Held 1 suspicious message from <sender>" with **Not a scam** and **Report**. For a call: the phone does not ring; the call is in the call log; a notice says why. | The notification only. The message is still in its app and a copy is in Quarantine. |

The levels are asymmetric on purpose. WARN is cheap and reversible, so it can be driven by a score. HOLD interrupts a
real conversation when it is wrong, so it requires evidence a human could check: a lookalike or blocklisted link, a
blocklisted sender or fingerprint, or a request for credentials or payment. Calls go one step further: they are held
only on a blocklisted number or on a number that appeared in a held message in the last 7 days, because a missed real
call costs more than a missed real text. See `FALSE_POSITIVES.md`.

## Why on-device

- **Speed.** The verdict is needed before the notification is read. A local engine answers in milliseconds, with no
  round trip and no dependence on signal.
- **Privacy that can be verified, not promised.** The app holds no internet permission at all. Anyone can check this
  with `aapt dump permissions` on the APK. Messages, contacts and call history never leave the phone unless the user
  taps Report and chooses where the report goes.
- **Trust.** A person who is told "this app reads your WhatsApp notifications" needs to be able to answer "and where
  does that go?" with "nowhere". No-internet is the only answer that needs no further explanation.
- **Works everywhere.** No server to keep up, no account, no sign-in. The same APK works in a basement car park.
- **Updates without a connection.** New police intelligence reaches the phone as a JSON blocklist of numbers, domains
  and fingerprints that the user imports from a file, so even reputation data does not need the app to be online.
  (Signing and distribution of such a file would need to be agreed with the police team; the prototype imports any
  well-formed file.)

The cost is that the model has to be small, and it is: hashed character n-grams and word unigrams with logistic
regression, trained by a Gradle task, loaded from an asset. Rules and reputation do the heavy lifting; the model adds
a score that can raise a WARN, never a HOLD on its own.

## Why evidence packets

A screenshot is a picture of a scam. An evidence packet is data about one: the sender in E.164, every URL and its
registrable domain, every IBAN with its checksum verified, e-mail addresses, wallets, wa.me and t.me handles, the
reason codes that fired, the language, and a 64-bit SimHash fingerprint of the normalised text with digits and URLs
masked. Two phones that receive the same campaign with different amounts and different short links produce the same
fingerprint. That is what lets a police analyst group cases, and it is what the Mirsad officer service at the root of
this repository can ingest through `POST /v1/ingest`.

The packet is also what protects the user. It is built from the one incident only. It never contains contacts, other
messages, location, device identifiers or the user's own number, and the raw text is included only when the user ticks
a box on a preview screen that shows the exact JSON. Reporting is a share-sheet action: the user picks the app, and
Mirsad has no way to send anything itself.

## What success looks like at the hackathon

- A judge installs the APK, opens Demo and shares a message to **Check with Mirsad** in under two minutes, with no
  permission granted.
- A real UAE bank OTP, a delivery update and a DEWA bill all pass the legitimate-message suite; none is held.
- A synthetic "parcel fee" message with a lookalike link is held, explained in Arabic and English, overruled in one tap,
  and turned into a report that the officer service accepts.
- Every claim in the README matches the APK.
