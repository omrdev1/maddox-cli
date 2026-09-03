import { readFileSync } from "node:fs";
import type { TokenMap } from "./types.js";

// A single node in a Tokens Studio / W3C Design Tokens export: either a
// leaf token ({ value, type }) or a group of further-nested nodes. Groups
// and leaves are told apart by the presence of a "value" key, per the W3C
// Design Tokens Community Group format Tokens Studio exports.
interface TokenNode {
  value?: string | number;
  type?: string;
  [key: string]: unknown;
}

type TokenTree = { [key: string]: TokenNode | TokenTree };

// Only these Tokens Studio types resolve to the single raw CSS value that
// Maddox's TokenMap expects (a color hex, or a px/rem/em length) — the
// others (typography, boxShadow, border, composite tokens) describe a
// bundle of properties, not one comparable value, and are skipped rather
// than half-mapped into a shape that would silently misclassify usages.
const SUPPORTED_TYPES = new Set(["color", "fontSizes", "spacing", "sizing", "borderRadius", "dimension"]);

function isLeaf(node: TokenNode | TokenTree): node is TokenNode {
  return typeof (node as TokenNode).value !== "undefined";
}

/**
 * Resolves a Tokens Studio alias reference, e.g. "{color.brand.500}", by
 * looking up the dotted path in the flattened token map already built so
 * far. Aliases must point at a token defined earlier in traversal order;
 * circular or forward references are left unresolved (returned as-is)
 * rather than causing an infinite loop.
 */
function resolveAlias(raw: string, resolved: Map<string, string>, depth = 0): string {
  const match = /^\{([^}]+)\}$/.exec(raw.trim());
  if (!match || depth > 10) return raw;

  const target = resolved.get(match[1]);
  if (target === undefined) return raw;
  return resolveAlias(target, resolved, depth + 1);
}

/**
 * Flattens a Tokens Studio JSON tree (single set, e.g. the "global" set
 * from a multi-set export, or the whole file for a single-set export)
 * into a flat `path.to.token` -> raw-css-value map, resolving `{alias}`
 * references along the way. Unsupported token types are skipped, not
 * coerced.
 */
export function flattenTokensStudioTree(tree: TokenTree): TokenMap {
  const resolved = new Map<string, string>();

  function walk(node: TokenNode | TokenTree, path: string): void {
    if (isLeaf(node)) {
      if (node.type && !SUPPORTED_TYPES.has(node.type)) return;
      const raw = String(node.value);
      const value = raw.startsWith("{") ? resolveAlias(raw, resolved) : raw;
      resolved.set(path, value);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) continue; // Tokens Studio metadata keys, e.g. $themes, $metadata
      walk(child as TokenNode | TokenTree, path ? `${path}.${key}` : key);
    }
  }

  walk(tree, "");

  const tokens: TokenMap = {};
  for (const [path, value] of resolved) {
    // Drop any alias that never resolved to a raw value (dangling/forward
    // reference) — an unresolved "{...}" string is not a comparable CSS
    // value and would never match a scanned usage anyway.
    if (value.startsWith("{")) continue;
    tokens[`--${path.replace(/\./g, "-")}`] = value;
  }
  return tokens;
}

/**
 * Loads a Tokens Studio JSON export from disk and flattens it into a
 * TokenMap. Handles both a single-set export (the whole file is one
 * token tree) and a multi-set export (top-level keys are set names, e.g.
 * "global", "dark" — every non-$-prefixed top-level key is merged, later
 * sets overriding earlier ones by path, since Maddox compares against one
 * flat ground truth rather than a per-theme one).
 */
export function loadTokensStudioFile(path: string): TokenMap {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as TokenTree;

  const topLevelKeys = Object.keys(raw).filter((k) => !k.startsWith("$"));
  const looksLikeMultiSet = topLevelKeys.every(
    (k) => typeof raw[k] === "object" && raw[k] !== null && !isLeaf(raw[k] as TokenNode)
      && Object.values(raw[k] as TokenTree).some((v) => typeof v === "object")
  );

  if (!looksLikeMultiSet) {
    return flattenTokensStudioTree(raw);
  }

  const merged: TokenMap = {};
  for (const key of topLevelKeys) {
    Object.assign(merged, flattenTokensStudioTree(raw[key] as TokenTree));
  }
  return merged;
}
