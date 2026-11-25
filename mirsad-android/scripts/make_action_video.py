#!/usr/bin/env python3
"""
Builds the 17-second live demo from two screen recordings made at the same time by scripts/record_action_demo.sh:
the left phone has no Mirsad, the right phone runs Mirsad. Both receive the same scam SMS and the same scam call.
Short captions are overlaid; the phone footage itself is untouched real-time recording.

Usage: python3 -I scripts/make_action_video.py <recording_dir> [left_serial] [right_serial]
Writes demo/mirsad-android-demo.mp4 (English captions), demo/mirsad-android-demo-ar.mp4 (Arabic captions) and
demo/mirsad-android-demo.gif. Needs Pillow with raqm and ffmpeg.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, "demo")
FFMPEG = "/opt/homebrew/bin/ffmpeg"
W, H = 1920, 1080
START = 1.0          # seconds of recording skipped (both phones idle)
LENGTH = 17.0
PHONE_H = 850
PHONE_TOP = 110
LEFT_CX, RIGHT_CX = 620, 1300

FONTS = "/System/Library/Fonts/Supplemental/"
EN_BOLD = FONTS + "Arial Bold.ttf"
AR_FONT = "/System/Library/Fonts/SFArabic.ttf"   # Arabic glyphs only: no Latin letters or ASCII digits in Arabic text
BG = (8, 40, 36)
RED = (214, 69, 59)
GREEN = (34, 139, 94)
WHITE = (255, 255, 255)

LABELS = {
    "en": ("WITHOUT MIRSAD", "WITH MIRSAD"),
    "ar": ("من دون مرصاد", "مع مرصاد"),
}
# (start, end, text) on the final timeline, matched to what the recording shows: SMS at 1 s, shade at 3 s,
# incident after the tap at ~7.5 s, call at ~9.5 s (left rings, right posts "Mirsad rejected a call"), report at ~14 s.
CAPTIONS = {
    "en": [
        (0.0, 1.0, "Two phones, the same scam. Only the right one runs Mirsad."),
        (1.0, 3.0, "A scam SMS arrives on both phones"),
        (3.0, 7.5, "Left: the scam and its link are waiting. Right: Mirsad held it."),
        (7.5, 9.5, "Tap the notice: Mirsad explains why"),
        (9.5, 14.0, "The scammer calls: the left phone rings, the right one never does"),
        (14.0, 17.0, "One tap turns it into a police report"),
    ],
    "ar": [
        (0.0, 1.0, "هاتفان والاحتيال نفسه، والهاتف الأيمن وحده يعمل عليه مرصاد"),
        (1.0, 3.0, "تصل رسالة احتيال إلى الهاتفين"),
        (3.0, 7.5, "على اليسار: الرسالة ورابطها بانتظارك. على اليمين: حجزها مرصاد"),
        (7.5, 9.5, "اضغط على التنبيه: مرصاد يشرح السبب"),
        (9.5, 14.0, "يتصل المحتال: الهاتف الأيسر يرنّ، والأيمن لا يرنّ أبداً"),
        (14.0, 17.0, "وضغطة واحدة تحوّلها إلى بلاغ للشرطة"),
    ],
}


def font(path, size):
    return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)


def probe_size(path):
    out = subprocess.run(["/opt/homebrew/bin/ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    w, h = out.stdout.strip().split(",")[:2]
    return int(w), int(h)


def phone_width(path):
    w, h = probe_size(path)
    return int(round(w * PHONE_H / h / 2)) * 2


def background(lang, lw, rw):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for cx, pw in ((LEFT_CX, lw), (RIGHT_CX, rw)):
        d.rounded_rectangle([cx - pw // 2 - 12, PHONE_TOP - 12, cx + pw // 2 + 12, PHONE_TOP + PHONE_H + 12], 34,
                            fill=(16, 16, 16))
    arabic = lang == "ar"
    f = font(AR_FONT if arabic else EN_BOLD, 36 if arabic else 32)
    for (cx, text, color) in ((LEFT_CX, LABELS[lang][0], RED), (RIGHT_CX, LABELS[lang][1], GREEN)):
        tw = d.textlength(text, font=f, direction="rtl" if arabic else None)
        x1, x2 = cx - tw / 2 - 26, cx + tw / 2 + 26
        d.rounded_rectangle([x1, 30, x2, 86], 28, fill=color)
        d.text((cx, 58), text, font=f, fill=WHITE, anchor="mm", direction="rtl" if arabic else None,
               language="ar" if arabic else None)
    return img


def caption(text, lang):
    arabic = lang == "ar"
    img = Image.new("RGBA", (W, 110), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = font(AR_FONT if arabic else EN_BOLD, 46 if arabic else 42)
    d.text((W // 2, 55), text, font=f, fill=WHITE, anchor="mm", direction="rtl" if arabic else None,
           language="ar" if arabic else None)
    return img


def build(rec_dir, left, right, lang, work):
    lp, rp = os.path.join(rec_dir, left + ".mp4"), os.path.join(rec_dir, right + ".mp4")
    lw, rw = phone_width(lp), phone_width(rp)
    bg = os.path.join(work, f"bg_{lang}.png")
    background(lang, lw, rw).save(bg)
    caps = []
    for i, (a, b, text) in enumerate(CAPTIONS[lang]):
        p = os.path.join(work, f"cap_{lang}_{i}.png")
        caption(text, lang).save(p)
        caps.append((a, b, p))

    cmd = [FFMPEG, "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", str(LENGTH), "-i", bg,
           "-i", lp, "-i", rp]
    for _, _, p in caps:
        cmd += ["-loop", "1", "-framerate", "30", "-t", str(LENGTH), "-i", p]
    # screenrecord only writes frames when the screen changes: pad the end, cut the idle start, fix 30 fps.
    phone = ("[{i}:v]fps=30,tpad=stop_mode=clone:stop_duration=30,trim=start={s}:duration={l},setpts=PTS-STARTPTS,"
             "scale={w}:{h}:flags=lanczos[{n}]")
    f = [phone.format(i=1, s=START, l=LENGTH, w=lw, h=PHONE_H, n="L"),
         phone.format(i=2, s=START, l=LENGTH, w=rw, h=PHONE_H, n="R"),
         f"[0:v][L]overlay={LEFT_CX - lw // 2}:{PHONE_TOP}[v1]",
         f"[v1][R]overlay={RIGHT_CX - rw // 2}:{PHONE_TOP}[v2]"]
    last = "[v2]"
    for k, (a, b, _) in enumerate(caps):
        out = f"[c{k}]"
        f.append(f"{last}[{k + 3}:v]overlay=0:{H - 112}:enable='between(t,{a},{b - 0.001})'{out}")
        last = out
    f.append(f"{last}format=yuv420p[v]")
    mp4 = os.path.join(DEMO, "mirsad-android-demo.mp4" if lang == "en" else "mirsad-android-demo-ar.mp4")
    cmd += ["-filter_complex", ";".join(f), "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "21",
            "-r", "30", "-t", str(LENGTH), "-movflags", "+faststart", mp4]
    subprocess.run(cmd, check=True, timeout=900)
    return mp4


def gif(mp4):
    out = os.path.join(DEMO, "mirsad-android-demo.gif")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", mp4, "-vf",
                    "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                    "-loop", "0", out], check=True, timeout=900)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    rec = sys.argv[1]
    left = sys.argv[2] if len(sys.argv) > 2 else "emulator-5558"
    right = sys.argv[3] if len(sys.argv) > 3 else "emulator-5560"
    work = os.path.join(rec, "overlays")
    os.makedirs(work, exist_ok=True)
    outs = [build(rec, left, right, "en", work), build(rec, left, right, "ar", work)]
    outs.append(gif(outs[0]))
    for o in outs:
        print(o, os.path.getsize(o), "bytes")
