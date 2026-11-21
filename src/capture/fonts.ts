/**
 * The fonts a capture is drawn with, vendored in assets/fonts with their SIL OFL 1.1 licence texts (design
 * section 19.6). Characters these fonts do not cover fall back to system fonts.
 */
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';

/** One alias per face: registering two weights under one alias makes every draw use the bold face. */
export const FONT = {
  sans: 'MirsadSans',
  sansBold: 'MirsadSansBold',
  arabic: 'MirsadArabic',
  arabicBold: 'MirsadArabicBold',
  mono: 'MirsadMono',
} as const;

const FONT_DIRECTORY = new URL('../../assets/fonts/', import.meta.url);

const FONT_FILES: readonly (readonly [file: string, alias: string])[] = [
  ['NotoSans_400Regular.ttf', FONT.sans],
  ['NotoSans_700Bold.ttf', FONT.sansBold],
  ['NotoSansArabic_400Regular.ttf', FONT.arabic],
  ['NotoSansArabic_700Bold.ttf', FONT.arabicBold],
  ['NotoSansMono_400Regular.ttf', FONT.mono],
];

let registered = false;

/** Registers the vendored fonts once per process; throws when a file cannot be registered. */
export function registerCaptureFonts(): void {
  if (registered) return;
  for (const [file, alias] of FONT_FILES) {
    const fontPath = fileURLToPath(new URL(file, FONT_DIRECTORY));
    if (!GlobalFonts.registerFromPath(fontPath, alias)) throw new Error(`capture_font_not_registered: ${alias}`);
  }
  registered = true;
}
