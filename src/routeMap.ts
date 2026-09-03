import type { Finding } from "./types.js";

// File basenames Next.js's App Router treats as route-owning — a page
// renders the route itself; a layout wraps every route beneath it. Both
// are real "this route" attributions; anything else under app/ (loading,
// error, not-found, template, route.ts API handlers) is left out
// deliberately — those aren't the page's own content and attributing a
// color/token finding to them would be misleading.
const ROUTE_OWNING_BASENAMES = new Set(["page", "layout"]);
const APP_ROUTER_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js"]);

const SHARED_BUCKET = "Shared (non-route files)";

/**
 * Converts a file path segment sequence into the URL path Next.js's App
 * Router would actually serve it at: route groups "(name)" are stripped
 * (they don't appear in the URL), everything else — including dynamic
 * segments like "[id]" or "[...slug]" — is kept exactly as Next.js
 * itself represents them, since that IS the real route shape.
 */
function segmentsToRoute(segments: string[]): string {
  const kept = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return "/" + kept.join("/");
}

/**
 * Finds the "app" (or "src/app") directory within a file's own path
 * segments and returns the index right after it — the point from which
 * App Router route segments begin. Returns -1 if this file isn't under
 * an app/ directory at all (a plain components/lib layout, or a Pages
 * Router project — this module only understands App Router).
 */
function appDirIndex(segments: string[]): number {
  const i = segments.lastIndexOf("app");
  return i === -1 ? -1 : i + 1;
}

/**
 * Maps a single scanned file's path (relative to the project rootDir, as
 * Finding.file already is) to the route it belongs to, or the shared
 * bucket if it isn't a page/layout file under app/. Deliberately does
 * NOT trace imports — a component imported by five different pages has
 * no single "real" route, and guessing one would misattribute drift to
 * routes that don't actually render it. Only page.tsx/layout.tsx (and
 * their .ts/.jsx/.js variants) get a real route; everything else is
 * "Shared (non-route files)".
 */
export function fileToRoute(file: string): string {
  const segments = file.split("/");
  const filename = segments[segments.length - 1];
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return SHARED_BUCKET;

  const basename = filename.slice(0, dotIndex);
  const ext = filename.slice(dotIndex);
  if (!ROUTE_OWNING_BASENAMES.has(basename) || !APP_ROUTER_EXTENSIONS.has(ext)) {
    return SHARED_BUCKET;
  }

  const startIndex = appDirIndex(segments);
  if (startIndex === -1) return SHARED_BUCKET;

  const routeSegments = segments.slice(startIndex, segments.length - 1);

  if (basename === "layout") {
    // A layout's identity is its position in the file tree, not the URL
    // it happens to share with a route — app/layout.tsx and
    // app/(auth)/layout.tsx both wrap "/", but they're different files
    // wrapping different subtrees, so route groups are kept here (unlike
    // segmentsToRoute's page-route stripping) to keep the two distinct.
    const label = routeSegments.length === 0 ? "/" : "/" + routeSegments.join("/");
    return `${label} (layout)`;
  }

  return segmentsToRoute(routeSegments);
}

export interface RouteGroup {
  route: string;
  findings: Finding[];
}

/**
 * Groups findings by the route (or the shared bucket) their file maps
 * to, via fileToRoute. Route order: real routes first (alphabetical),
 * then the shared bucket last — shared files are real drift too, but a
 * route-focused view should lead with actual pages.
 */
export function groupByRoute(findings: Finding[]): RouteGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const route = fileToRoute(finding.file);
    const existing = groups.get(route) ?? [];
    existing.push(finding);
    groups.set(route, existing);
  }

  const routes = [...groups.keys()].filter((r) => r !== SHARED_BUCKET).sort();
  if (groups.has(SHARED_BUCKET)) routes.push(SHARED_BUCKET);

  return routes.map((route) => ({ route, findings: groups.get(route)! }));
}
