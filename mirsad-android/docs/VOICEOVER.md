# Voice-over for the 17-second demo

The video is a live recording of two phones side by side, made at the same moment: the **left phone has no Mirsad**,
the **right phone runs Mirsad**. Both receive the same scam SMS and then the same scam call. It has no audio. Record
one of these over `demo/mirsad-android-demo.mp4` (English captions) or `demo/mirsad-android-demo-ar.mp4` (Arabic
captions); both have the same timing. Start each line when its moment happens on screen.

| Time | On screen | English | العربية (فصحى) |
|---|---|---|---|
| 0–1 | Two idle phones | Two phones. Only the right one has Mirsad. | هاتفان، والأيمن وحده يعمل عليه مرصاد. |
| 1–3 | The same scam SMS pops up on both | A fake Emirates Post text arrives… | تصل رسالةٌ مزيّفة باسم بريد الإمارات… |
| 3–7.5 | Left: scam and link waiting. Right: "Held 1 suspicious message" | On the left, the scam is one tap away. On the right, Mirsad has already held it, | على اليسار، الاحتيال على بُعد ضغطة. وعلى اليمين، حجزه مرصاد فوراً، |
| 7.5–9.5 | Right: tap the notice, the reasons | and shows exactly why. | ويُبيّن السبب بوضوح. |
| 9.5–14 | Left rings. Right: "Mirsad rejected a call" | Then the scammer calls. The left phone rings. The right one never does. | ثم يتصل المحتال: الهاتف الأيسر يرنّ، والأيمن لا يرنّ أبداً. |
| 14–17 | Right: report preview | One tap, and it's a police report. | وبضغطةٍ واحدة يصبح بلاغاً للشرطة. |

## Read as one paragraph

**English (about 50 words, a brisk normal pace):**
Two phones. Only the right one has Mirsad. A fake Emirates Post text arrives… On the left, the scam is one tap away.
On the right, Mirsad has already held it, and shows exactly why. Then the scammer calls. The left phone rings. The
right one never does. One tap, and it's a police report.

**العربية:**
هاتفان، والأيمن وحده يعمل عليه مرصاد. تصل رسالةٌ مزيّفة باسم بريد الإمارات… على اليسار، الاحتيال على بُعد ضغطة. وعلى
اليمين، حجزه مرصاد فوراً، ويُبيّن السبب بوضوح. ثم يتصل المحتال: الهاتف الأيسر يرنّ، والأيمن لا يرنّ أبداً. وبضغطةٍ
واحدة يصبح بلاغاً للشرطة.

## How it was made

- Real-time screen recordings of two Android emulators (left: Android 14 with Mirsad disabled; right: Android 16 with
  Mirsad and its permissions). The SMS and the call are injected into both at the same moment through the emulator
  console; Mirsad's notification listener and call screening service do the rest. The only scripted step is the tap on
  the notice and opening the report preview. The message and the numbers are fictional demo data.
- Rebuild: `scripts/record_action_demo.sh <dir>` then `python3 -I scripts/make_action_video.py <dir>`.
