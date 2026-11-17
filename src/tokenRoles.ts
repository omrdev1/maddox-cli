import type { ColorRole } from "./types.js";

// What a token's name says it is for. Names that say nothing (brand, accent,
// hw-body) fit any role.
const FAMILY: [ColorRole, RegExp][] = [
  ["text", /(^|-)(text|ink|foreground|fg)(-|$)/i],
  ["border", /(^|-)(border|line|stroke|outline|divider|rule)(-|$)/i],
  ["bg", /(^|-)(bg|background|surface|paper|canvas|ground)(-|$)/i],
];

export function tokenRole(name: string): ColorRole | undefined {
  const bare = name.replace(/^--(color-)?/, "");
  return FAMILY.find(([, re]) => re.test(bare))?.[0];
}

/** True when a colour used for one thing (say a background) would point at a token named for another (say text). */
export function roleConflicts(role: ColorRole | undefined, tokenName: string): boolean {
  if (!role) return false;
  const family = tokenRole(tokenName);
  return family !== undefined && family !== role;
}
