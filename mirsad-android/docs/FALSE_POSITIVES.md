# Mirsad Android: false-positive policy

A scam filter that catches a real bank message once is uninstalled. This document is the full policy for what Mirsad
may do to a message or call, what it must never do, and what the user loses when Mirsad is wrong: one tap, nothing else.

## Principles

1. **Nothing is ever deleted.** Mirsad has no way to delete a message. A notification listener can remove another
   app's notification; the message stays in its own app. A held call stays in the call log. Mirsad also keeps its own
   copy of every held message in Quarantine for 30 days.
2. **Never silent.** Every HOLD produces a visible notice naming the sender ("Held 1 suspicious message from
   <sender>"), with the two actions that matter: **Not a scam** and **Report**. A user can always see what was held.
3. **HOLD needs evidence.** A score can only WARN. HOLD requires the score threshold **and** at least one hard reason
   (below). Hard reasons are things a person could verify by looking.
4. **The cheaper mistake wins.** When in doubt, WARN. For calls, when in doubt, let it ring: a missed real call costs
   more than a missed real text.
5. **Reversible in one tap, with Undo.** Overruling Mirsad also teaches it: the sender and the fingerprint go on
   the user's lists so the same mistake is not repeated.

## The HOLD gate

```
level = ALLOW
if sender is allow-listed                      -> ALLOW (stop)
if content was hidden by the system            -> ALLOW (stop; never a scam)
if fingerprint is on the known-good list       -> ALLOW (stop)

score = combine(stage 1 reasons, stage 2 model score)   in [0, 1]

if score >= warnThreshold(sensitivity)         -> WARN
if score >= holdThreshold(sensitivity)
   and at least one hard reason fired
   and none of the never-HOLD rules applies    -> HOLD
```

**Hard reasons** (`Reason.hard = true`), the only ones that can open the gate:

| Code | Evidence |
|---|---|
| `LINK_LOOKALIKE_OFFICIAL` | A host that imitates an official UAE domain (edit distance, brand plus extra words, wrong TLD). |
| `LINK_BLOCKLISTED_DOMAIN` | A registrable domain on the block list (user-added or imported). |
| `SENDER_BLOCKLISTED` | A sender on the block list. |
| `FINGERPRINT_BLOCKLISTED` | The message fingerprint is on the block list (a known campaign). |
| `CONTENT_CREDENTIAL_REQUEST` | The text asks for a password, PIN, CVV, card number or one-time code. |
| `CONTENT_PAYMENT_REQUEST` | The text asks for a payment, a transfer or a fee to an account, wallet or link. |

Everything else (urgency, threat, prize, job offer, investment, "move to WhatsApp", a plain-number sender claiming to be
a bank, a shortener, plain HTTP, `MODEL_SCORE`) raises the score and can produce a WARN with a clear reason, but can
never by itself hold a message.

**Never-HOLD rules**, checked after the gate:

- The sender looks like a saved contact (`senderLooksLikeContact`): at most WARN.
- The sender is on the allow list: ALLOW.
- A one-time code from an alphanumeric sender with no link: ALLOW (`SENDER_OTP_FROM_ALPHANUMERIC`). Banks and
  services send these all day; holding one locks the user out of their own account.
- Content hidden by the system (Android 15+ one-time-code notifications): ALLOW (`CONTENT_HIDDEN`). Unavailable is not
  suspicious.
- Engine error: a message with a link, a number or a money word gets WARN (`ENGINE_ERROR`), anything else ALLOW; a
  WARN never removes anything, so this fails safe without failing silent. A call-screening timeout or error allows the call.


## Calls

Call screening sees the number and the direction, not audio, and only for numbers not in contacts. There is no text to
analyse, so the score path is weak and the cost of a wrong hold is high. Calls are therefore held on **hard evidence
only**:

- `SENDER_BLOCKLISTED`: the number is on the block list.
- `SENDER_SEEN_IN_HELD_MESSAGE`: the same number was the sender of a message Mirsad held in the last 7 days (the
  cross-channel rule: the scammer who texted the "parcel fee" link and then calls to "help").

Other call signals (international prefix for a claimed UAE entity, one-ring patterns) produce a WARN: the phone rings
with a heads-up. The screening service has a 1 s budget and allows the call on timeout.


## Sensitivity

Settings offer three levels. They move the WARN and HOLD score thresholds only:

| Level | Effect |
|---|---|
| **Relaxed** | Higher thresholds. Fewer warnings; HOLD only on very strong combinations. |
| **Balanced** | Default. |
| **Strict** | Lower thresholds. More warnings; HOLD reached sooner when a hard reason is present. |

No level removes the hard-evidence requirement, the never-HOLD rules, or the call policy. Strict cannot make a score
alone hold a message.


## The legitimate-message suite

`:core:test` includes a suite of at least 40 legitimate UAE-style messages in English and Arabic: bank one-time codes and
transaction alerts from alphanumeric senders, delivery updates with tracking links on official courier domains, DEWA
and ADDC bills, Salik and Darb top-ups, Mawaqif reminders, school and clinic notices, telecom bill reminders, UAE Pass
and ICP notifications, a friend sharing a link, a family member asking for money with a real IBAN.

The suite gates every build:

- **None may be held.** A single HOLD fails the test.
- **At most two may be warned.** A WARN on a legitimate message is tolerated only in small numbers and each case is
  listed in the test output with its reasons so it can be fixed.

A rule or model change that breaks the suite does not ship. The suite grows with every false positive found during
testing.


## The Not a scam flow

From the held notice, the Quarantine list or the Incident screen, one tap on **Not a scam** does five things, in order:

1. Marks the incident as a false positive (`FeedbackVerdict.FALSE_POSITIVE`) and stores a `Feedback` row with the
   fingerprint, reason codes, model version, level and score, so the mistake becomes a labelled training row on export.
2. Adds the sender to the **allow list** (`ALLOW_SENDER`, origin `not_a_scam`). Future messages and calls from this
   sender are ALLOW.
3. Adds the message fingerprint to the **known-good list** (`KNOWN_GOOD_FINGERPRINT`). The same text, from anyone,
   with any digits or links, is ALLOW.
4. Posts a **normal notification** with the original sender and text that opens the source app, so the user gets the
   message back exactly where they expected it.
5. Shows a confirmation with **Undo**. Undo removes the two list entries it just added and restores the previous
   feedback state (`IncidentPipeline.undoNotScam(token)`).

The message itself needs no restoring: it never left its app.

The user can also tap **Report** from the same notice to confirm a scam, or open Settings to edit the allow list, the
block lists and the known-good list by hand. Nothing added by Not a scam is hidden from the user.


## What the user loses when Mirsad is wrong

| Mirsad was wrong about | What happened | What the user does | What is lost |
|---|---|---|---|
| A message (HOLD) | Its notification was removed; a notice named the sender; a copy is in Quarantine; the message is in its app. | Taps **Not a scam**. The notification comes back. | One tap, and the seconds between the notice and the tap. |
| A message (WARN) | A caution was added next to the original notification. | Ignores it, or taps Not a scam so the sender is allowed. | Nothing. |
| A call (HOLD) | It did not ring; it is in the call log with a notice. | Calls back from the log; taps Not a scam so the number is allowed. | One missed ring. This is why calls are held only on a blocklisted number or a cross-channel match. |
| A call (WARN) | It rang with a heads-up. | Answers as normal. | Nothing. |

Nothing is deleted, nothing is sent, nothing is hidden from the user, and every list change is visible and reversible
in Settings.

## Feedback and training

Every Not a scam creates a `Feedback` row on the phone; Settings > *Export my corrections as training rows* shares them as CSV. Feedback is never uploaded. When the team
exports training data from a test device, the feedback rows join `data/` as labelled examples, so the next
`./gradlew :core:trainModel` learns from the mistakes. The same rows are what a false-positive report carries if the
user chooses to share one: fingerprint, reason codes, sender type, model version, verdict, and the text only if ticked.
