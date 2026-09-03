import { extractFromContent, type RawUsage } from "./scan.js";

// Only ever follow relative/absolute-path stylesheet links resolved
// against the page's own origin — never a third-party CDN's CSS, since
// that's not the project's own design system and would only add noise
// (and, worse, false "unrecognized" findings for code the project never
// wrote).
function isSameOrigin(href: string, pageUrl: URL): boolean {
  try {
    const resolved = new URL(href, pageUrl);
    return resolved.origin === pageUrl.origin;
  } catch {
    return false;
  }
}

// Matches <link ... rel="stylesheet" ... href="..."> and the reverse
// attribute order, case-insensitively, without a full HTML parser —
// good enough for the handful of <link> tags a real page head has.
const STYLESHEET_LINK_RE =
  /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["'][^>]*>/gi;

function findStylesheetHrefs(html: string): string[] {
  const hrefs: string[] = [];
  STYLESHEET_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STYLESHEET_LINK_RE.exec(html)) !== null) {
    hrefs.push(m[1] ?? m[2]);
  }
  return hrefs;
}

export interface CrawlResult {
  usages: RawUsage[];
  // The page URL plus every stylesheet URL actually fetched — reported
  // back so a caller (or the CLI's own output) can show what was scanned,
  // the live-URL equivalent of scanSource's file count.
  sourcesScanned: string[];
}

/**
 * Fetches a live page's rendered HTML plus every same-origin linked
 * stylesheet, and runs the same color/font-size/motion literal
 * extraction scanSource runs over local source files. This is what makes
 * Maddox "production-aware" rather than local-source-only: it checks
 * what a real deployed page actually ships, not just what's in the repo
 * at scan time (a config typo, a stale CDN cache, or a build step that
 * silently drops a token could all cause the two to diverge).
 *
 * Framer Motion / GSAP usage is deliberately dropped from the result.
 * Real motion libraries set durations/eases via the JS animation runtime,
 * not static markup, so they never legitimately appear in rendered
 * HTML/CSS — but framework-compiled CSS reliably DOES contain unrelated
 * matches for the same shared regex (confirmed against a real deploy:
 * Tailwind's own `--default-transition-duration:.15s` custom property
 * matches the duration pattern, `transition-timing-function` matches the
 * ease pattern). Rather than surface those as noisy false "unrecognized"
 * findings, motion usages are filtered out of every crawl result before
 * it's returned — motion checking stays a source-scan-only capability.
 */
export async function crawlUrl(pageUrl: string): Promise<CrawlResult> {
  const url = new URL(pageUrl);
  const usages: RawUsage[] = [];
  const sourcesScanned: string[] = [];

  const pageResponse = await fetch(url, { redirect: "follow" });
  if (!pageResponse.ok) {
    throw new Error(`Failed to fetch ${url}: ${pageResponse.status} ${pageResponse.statusText}`);
  }
  const html = await pageResponse.text();
  usages.push(...extractFromContent(url.toString(), html));
  sourcesScanned.push(url.toString());

  const stylesheetHrefs = findStylesheetHrefs(html).filter((href) => isSameOrigin(href, url));

  for (const href of stylesheetHrefs) {
    const cssUrl = new URL(href, url).toString();
    try {
      const cssResponse = await fetch(cssUrl);
      if (!cssResponse.ok) continue;
      const css = await cssResponse.text();
      usages.push(...extractFromContent(cssUrl, css));
      sourcesScanned.push(cssUrl);
    } catch {
      // A single unreachable stylesheet shouldn't fail the whole crawl —
      // same tolerance readScannedFiles already has for an unreadable
      // local file.
    }
  }

  return { usages: usages.filter((u) => u.kind !== "motion"), sourcesScanned };
}
