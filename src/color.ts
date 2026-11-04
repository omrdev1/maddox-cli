// Browser-safe color parsing, no Node built-ins. Turns the CSS color syntaxes
// real design systems use for tokens (hex, rgb, hsl, oklch) into sRGB so the
// diff engine can compare any of them, not just hex. Alpha is ignored: a
// color is compared by its opaque value.

export type Rgb = [number, number, number];

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_RE = /^(rgba?|hsla?|oklch)\(\s*(.+?)\s*\)$/i;

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseHex(value: string): Rgb | null {
  const match = HEX_RE.exec(value);
  if (!match) return null;
  const digits = match[1];
  const full =
    digits.length <= 4 ? [...digits.slice(0, 3)].map((d) => d + d).join("") : digits.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

// "rgb(255 0 0 / 50%)" and "rgba(255, 0, 0, .5)" both split to their numbers.
function splitArguments(body: string): string[] {
  return body.split(/[\s,/]+/).filter(Boolean);
}

function parseNumber(token: string): number {
  return parseFloat(token);
}

function parseRgb(args: string[]): Rgb | null {
  if (args.length < 3) return null;
  const channels = args.slice(0, 3).map((arg) => (arg.endsWith("%") ? (parseNumber(arg) / 100) * 255 : parseNumber(arg)));
  return channels.some(Number.isNaN) ? null : (channels.map(clampChannel) as Rgb);
}

function parseHsl(args: string[]): Rgb | null {
  if (args.length < 3) return null;
  const hue = ((parseNumber(args[0]) % 360) + 360) % 360;
  const saturation = parseNumber(args[1]) / 100;
  const lightness = parseNumber(args[2]) / 100;
  if ([hue, saturation, lightness].some(Number.isNaN)) return null;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channelAt = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    return lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channelAt(0), channelAt(8), channelAt(4)].map((c) => clampChannel(c * 255)) as Rgb;
}

function linearToSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function parseOklch(args: string[]): Rgb | null {
  if (args.length < 3) return null;
  const lightness = args[0].endsWith("%") ? parseNumber(args[0]) / 100 : parseNumber(args[0]);
  const chroma = args[1].endsWith("%") ? (parseNumber(args[1]) / 100) * 0.4 : parseNumber(args[1]);
  const hue = (parseNumber(args[2]) * Math.PI) / 180;
  if ([lightness, chroma, hue].some(Number.isNaN)) return null;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => clampChannel(linearToSrgb(c) * 255)) as Rgb;
}

/** Returns the opaque sRGB value of a CSS color, or null if it is not a concrete color. */
export function parseColor(value: string): Rgb | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return parseHex(trimmed);

  const match = FUNCTION_RE.exec(trimmed);
  if (!match) return null;
  const args = splitArguments(match[2]);
  const fn = match[1].toLowerCase();
  if (fn.startsWith("rgb")) return parseRgb(args);
  if (fn.startsWith("hsl")) return parseHsl(args);
  return parseOklch(args);
}
