#!/usr/bin/env python3
"""
Builds the 20-second explainer video from real phone screenshots: one caption per step on one side, the phone on the
other, cross-fades between steps. English and Arabic caption versions, same timing (so one voice-over fits both).

Usage: python3 -I scripts/make_explainer.py <frames_dir>
  <frames_dir> holds s1_home.png … s7_report.png captured from the APK (scripts/capture_explainer_frames.sh).
Writes demo/mirsad-android-demo.mp4 (English), demo/mirsad-android-demo-ar.mp4 (Arabic), demo/mirsad-android-demo.gif,
and demo/scenes/ (one PNG per scene and language). Needs Pillow with raqm (Arabic shaping) and ffmpeg.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, "demo")
FFMPEG = "/opt/homebrew/bin/ffmpeg"
W, H = 1920, 1080
FADE = 0.4

FONTS = "/System/Library/Fonts/Supplemental/"
EN_BOLD = FONTS + "Arial Bold.ttf"
EN_REG = FONTS + "Arial.ttf"
AR_FONT = "/System/Library/Fonts/SFArabic.ttf"  # Arabic glyphs only: Arabic captions use Arabic-Indic digits, no Latin

BG_TOP = (9, 52, 46)
BG_BOTTOM = (4, 26, 23)
ACCENT = (255, 196, 92)
WHITE = (255, 255, 255)
SOFT = (196, 222, 216)
RED = (232, 96, 86)

# (frame, seconds, english, arabic). Durations add up to 20 s after the cross-fades.
SCENES = [
    ("s1_home", 2.8,
     ("MIRSAD  ·  مرصاد", "A scam shield that lives on your phone",
      "Built for the UAE. It checks every call and message on the phone itself, with no internet."),
     ("مرصاد", "درع ضد الاحتيال يعمل على هاتفك",
      "مصمَّم للإمارات. يفحص كل مكالمة ورسالة على الهاتف نفسه، دون إنترنت.")),
    ("s2_sms_arrives", 3.2,
     ("1  ·  WITHOUT MIRSAD", "A scam SMS arrives",
      "“Emirates Post: your parcel is held. Pay AED 3.50 within 24 hours”, with a fake link."),
     ("١ ـ من دون مرصاد", "تصل رسالة احتيال",
      "«بريد الإمارات: طردك محتجز. ادفع ٣٫٥٠ درهم خلال ٢٤ ساعة» مع رابط مزيّف.")),
    ("s3_held", 3.4,
     ("2  ·  WITH MIRSAD", "It is held in milliseconds",
      "The scam notification disappears before you can tap the link. A quiet notice takes its place."),
     ("٢ ـ مع مرصاد", "تُحجز الرسالة في أجزاء من الثانية",
      "يختفي إشعار الاحتيال قبل أن تضغط على الرابط، ويظهر مكانه تنبيه هادئ.")),
    ("s4_incident", 3.4,
     ("3  ·  EXPLAINED", "It tells you why, in plain words",
      "A fake brand in the link, a small fee, a foreign number posing as Emirates Post. In Arabic or English."),
     ("٣ ـ الشرح", "ويشرح لك السبب بوضوح",
      "رابط ينتحل اسم بريد الإمارات، ورسوم صغيرة، ورقم أجنبي. بالعربية أو الإنجليزية.")),
    ("s5_call", 3.0,
     ("4  ·  CALLS", "The scammer calls. The phone never rings.",
      "A call from a number that sent a held scam is rejected and kept in the call log."),
     ("٤ ـ المكالمات", "يتصل المحتال… ولا يرنّ الهاتف",
      "تُرفض المكالمة من رقم أرسل رسالة محجوزة، وتبقى في سجل المكالمات.")),
    ("s6_restore", 3.2,
     ("5  ·  IF IT IS WRONG", "One tap gives it back",
      "Nothing is ever deleted. “Not a scam” restores the message and trusts the sender."),
     ("٥ ـ إن أخطأ", "ضغطة واحدة تعيدها",
      "لا يُحذف شيء أبداً. «ليس احتيالاً» تعيد الرسالة وتثق بالمرسل.")),
    ("s7_report", 3.4,
     ("6  ·  EVIDENCE", "One tap turns it into a police report",
      "You see exactly what would be shared. Nothing leaves the phone unless you send it."),
     ("٦ ـ البلاغ", "وضغطة واحدة تحوّلها إلى بلاغ",
      "ترى بالضبط ما سيُشارك، ولا يخرج شيء من الهاتف إلا إذا أرسلته بنفسك.")),
]

FOOTER_EN = "Abu Dhabi Police hackathon prototype  ·  no internet permission  ·  demo data"
FOOTER_AR = "نموذج أولي لهاكاثون شرطة أبوظبي، بلا صلاحية إنترنت، ببيانات تجريبية"


def font(path, size):
    return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)


def wrap(draw, text, fnt, width, direction):
    words, lines, line = text.split(" "), [], ""
    for w in words:
        trial = (line + " " + w).strip()
        if draw.textlength(trial, font=fnt, direction=direction) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    return lines


def background():
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    return img


def phone(frame_path, height):
    shot = Image.open(frame_path).convert("RGB")
    w = int(shot.width * height / shot.height)
    shot = shot.resize((w, height), Image.LANCZOS)
    radius, bezel = 46, 14
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, height - 1], radius, fill=255)
    body = Image.new("RGBA", (w + 2 * bezel, height + 2 * bezel), (0, 0, 0, 0))
    ImageDraw.Draw(body).rounded_rectangle([0, 0, body.width - 1, body.height - 1], radius + bezel, fill=(18, 18, 18, 255))
    body.paste(shot, (bezel, bezel), mask)
    shadow = Image.new("RGBA", (body.width + 80, body.height + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([40, 50, body.width + 40, body.height + 50], radius + bezel, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    shadow.alpha_composite(body, (40, 40))
    return shadow


def render(frame_path, texts, index, total, arabic):
    img = background().convert("RGBA")
    ph = phone(frame_path, 960)
    rtl = "rtl" if arabic else None
    text_w = 1000
    if arabic:
        img.alpha_composite(ph, (120 - 40, (H - ph.height) // 2 + 10))
        right = W - 130
    else:
        img.alpha_composite(ph, (W - ph.width - 120 + 40, (H - ph.height) // 2 + 10))
        left = 130
    d = ImageDraw.Draw(img)
    kicker, title, sub = texts
    f_kick = font(AR_FONT if arabic else EN_BOLD, 34)
    f_title = font(AR_FONT if arabic else EN_BOLD, 84 if arabic else 78)
    f_sub = font(AR_FONT if arabic else EN_REG, 44 if arabic else 42)

    title_lines = wrap(d, title, f_title, text_w, rtl)
    sub_lines = wrap(d, sub, f_sub, text_w, rtl)
    block = 50 + 30 + len(title_lines) * 104 + 30 + len(sub_lines) * 62
    y = (H - block) // 2 - 30

    def put(text, fnt, fill, y):
        if arabic:
            d.text((right, y), text, font=fnt, fill=fill, anchor="ra", direction="rtl", language="ar")
        else:
            d.text((left, y), text, font=fnt, fill=fill, anchor="la")

    put(kicker, f_kick, ACCENT, y)
    y += 80
    for line in title_lines:
        put(line, f_title, WHITE, y)
        y += 104
    y += 30
    for line in sub_lines:
        put(line, f_sub, SOFT, y)
        y += 62

    # progress dots
    dot_y = H - 150
    for i in range(total):
        cx = (right - i * 34) if arabic else (left + i * 34)
        r = 9 if i == index else 6
        d.ellipse([cx - r, dot_y - r, cx + r, dot_y + r], fill=ACCENT if i == index else (90, 130, 122))
    f_foot = font(AR_FONT if arabic else EN_REG, 26)
    put(FOOTER_AR if arabic else FOOTER_EN, f_foot, (120, 160, 152), H - 95)
    return img.convert("RGB")


def build(frames, lang):
    arabic = lang == "ar"
    scene_dir = os.path.join(DEMO, "scenes")
    os.makedirs(scene_dir, exist_ok=True)
    paths, durs = [], []
    for i, (name, dur, en, ar) in enumerate(SCENES):
        out = os.path.join(scene_dir, f"{lang}_{i + 1}_{name}.png")
        render(os.path.join(frames, name + ".png"), ar if arabic else en, i, len(SCENES), arabic).save(out, optimize=True)
        paths.append(out)
        durs.append(dur)
    total = sum(durs) - FADE * (len(durs) - 1)
    assert abs(total - 20.0) < 0.01, total

    cmd = [FFMPEG, "-v", "error", "-y"]
    for p, dur in zip(paths, durs):
        cmd += ["-loop", "1", "-framerate", "30", "-t", f"{dur}", "-i", p]
    chain, last, offset = [], "[0:v]", 0.0
    for i in range(1, len(paths)):
        offset += durs[i - 1] - FADE
        out = f"[x{i}]"
        chain.append(f"{last}[{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.2f}{out}")
        last = out
    chain.append(f"{last}format=yuv420p,fps=30[v]")
    mp4 = os.path.join(DEMO, "mirsad-android-demo.mp4" if not arabic else "mirsad-android-demo-ar.mp4")
    cmd += ["-filter_complex", ";".join(chain), "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow",
            "-crf", "22", "-movflags", "+faststart", "-t", "20", mp4]
    subprocess.run(cmd, check=True, timeout=600)
    return mp4


def gif(mp4):
    out = os.path.join(DEMO, "mirsad-android-demo.gif")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", mp4, "-vf",
                    "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                    "-loop", "0", out], check=True, timeout=600)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    frames_dir = sys.argv[1]
    en = build(frames_dir, "en")
    ar = build(frames_dir, "ar")
    g = gif(en)
    for f in (en, ar, g):
        print(f, os.path.getsize(f), "bytes")
