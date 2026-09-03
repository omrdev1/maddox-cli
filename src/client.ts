// Browser-safe subset of this package, for a "use client" React component
// in a consuming app. Only re-exports modules with no node:* import
// anywhere in their own import graph (verified by hand for each — see the
// comment at the top of scan.ts for why a re-export from a Node-dependent
// file, even of a browser-safe name, still breaks a client bundle).
//
// Import this as "maddox-engine/client", never the package root
// ("maddox-engine") — the root barrel (core.ts) also exports
// audit()/auditUrl() and re-exports scan.ts/groundTruth.ts/
// tokensStudio.ts/applyFixes.ts, all of which import node:fs/node:path.
export * from "./types.js";
export * from "./extract.js";
export * from "./diff.js";
export * from "./stateCheck.js";
export * from "./healthScore.js";
export * from "./routeMap.js";
export * from "./crawl.js";
export * from "./suggestFix.js";
export * from "./figmaVariables.js";
