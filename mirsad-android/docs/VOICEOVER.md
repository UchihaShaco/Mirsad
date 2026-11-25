# Voice-over for the 20-second demo

The video has no audio. Record one of these over `demo/mirsad-android-demo.mp4` (English captions) or
`demo/mirsad-android-demo-ar.mp4` (Arabic captions); both have the same timing. Each line starts when its scene fades
in. Speak at a normal pace: each line fits its slot with a short breath to spare.

| Time | On screen | English | العربية (فصحى) |
|---|---|---|---|
| 0.0–2.4 | Home: protection on | This is Mirsad, a scam shield that runs on your phone. | هذا مرصاد، درعٌ ضدّ الاحتيال يعمل على هاتفك. |
| 2.4–5.2 | Without Mirsad: the scam SMS lands | A fake Emirates Post text asks you to pay three dirhams… | رسالةٌ مزيّفة باسم بريد الإمارات تطلب ثلاثة دراهم… |
| 5.2–8.2 | With Mirsad: held notice | …Mirsad holds it before you can tap the link, | …فيحجزها مرصاد قبل أن تضغط على الرابط، |
| 8.2–11.2 | Incident: the reasons | and tells you why, in Arabic or English. | ويشرح لك السبب بالعربية أو الإنجليزية. |
| 11.2–13.8 | The scammer's call, rejected | When the scammer calls, your phone won't even ring. | وإن اتصل المحتال، فلن يرنّ هاتفك. |
| 13.8–16.6 | "Not a scam", restored | Got it wrong? One tap gives the message back. | أخطأ مرصاد؟ ضغطةٌ واحدة تُعيد الرسالة. |
| 16.6–20.0 | Report preview | One more tap turns it into evidence for the police. All on the phone, no internet. | وضغطةٌ أخرى تحوّلها إلى بلاغٍ للشرطة. كلّ ذلك على الهاتف، دون إنترنت. |

## Read as one paragraph

**English (about 55 words):**
This is Mirsad, a scam shield that runs on your phone. A fake Emirates Post text asks you to pay three dirhams…
Mirsad holds it before you can tap the link, and tells you why, in Arabic or English. When the scammer calls, your
phone won't even ring. Got it wrong? One tap gives the message back. One more tap turns it into evidence for the
police. All on the phone, no internet.

**العربية:**
هذا مرصاد، درعٌ ضدّ الاحتيال يعمل على هاتفك. رسالةٌ مزيّفة باسم بريد الإمارات تطلب ثلاثة دراهم… فيحجزها مرصاد قبل أن
تضغط على الرابط، ويشرح لك السبب بالعربية أو الإنجليزية. وإن اتصل المحتال، فلن يرنّ هاتفك. أخطأ مرصاد؟ ضغطةٌ واحدة
تُعيد الرسالة. وضغطةٌ أخرى تحوّلها إلى بلاغٍ للشرطة. كلّ ذلك على الهاتف، دون إنترنت.

## Notes

- Everything shown is real app behaviour on an Android 14 emulator; the message and the numbers are fictional demo data.
- Rebuild the video after an app change: `scripts/capture_explainer_frames.sh` then
  `python3 -I scripts/make_explainer.py <frames dir>` (or `scripts/full_capture.sh` for all media).
