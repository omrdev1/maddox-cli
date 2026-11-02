# maddox

Scans source code — or a live deployed page — for design-token, motion, and component-state drift against your own design system.

This is the open-source scanning engine behind [Maddox Engine](https://www.maddoxengine.com) — the same code the hosted dashboard and GitHub Action run, extracted so you can run it locally or in CI with no account required.

## What it checks

- **Colors** — every hex literal in your source (or a live page's rendered HTML/CSS), matched against your `@theme` tokens by exact value, then by RGB distance for near-misses.
- **Motion** — durations and easings used in code, checked against your real motion tokens (duration against duration, ease against ease — never cross-compared). Source-scan only; see `--url` below.
- **Component states** — an explicit contract you write yourself (a JSON file naming which states each kind of component must cover: `disabled`, `loading`, `error`, and so on). Confirms the state is referenced in the file; it doesn't verify it renders correctly — that's a static source check, not a visual one. Source-scan only.

This is a source-code and rendered-output scanner, not a pixel/DOM visual-regression tool. It checks the values a page actually ships against the tokens that are supposed to govern them, so it catches drift that renders identically to a real token (and so produces zero visual diff) but was never written as one.

## Usage

```bash
npx maddox-engine <target-source-dir> <path-to-globals.css-with-@theme-block> [options]
```

Options:

- `--project <name>` — project name (defaults to the target directory's basename, or the URL's hostname in `--url` mode)
- `--motion <path>` — path to a JSON file of motion tokens (e.g. a vendored copy of your motion-tokens export)
- `--states <path>` — path to a state-contract JSON file (see below). No effect in `--url` mode.
- `--tokens-studio <path>` — path to a Tokens Studio / W3C Design Tokens JSON export (see below); merged with, and taking precedence over, `@theme` on any path both define
- `--figma-file <file-key>` — pull color/spacing tokens from a Figma file's Variables (see below); requires an Enterprise Figma plan
- `--url <page-url>` — scan a deployed page instead of local source (see below); pass a placeholder like `-` for `<target-source-dir>` when using this alone
- `--apply-fixes` — write near-miss color/font-size/spacing suggestions back into source files (see below); not available with `--url`
- `--format text|json|markdown` — output format (default: `text`)
- `--fail-below <0-100>` — exit non-zero if the drift health score falls below this threshold; omit to never fail
- `--api-key <key>` — upload the result to Maddox Cloud (see below); the `MADDOX_API_KEY` environment variable does the same and is the safer choice, because a flag value can end up in shell history

### Maddox Cloud (optional)

Local scans are free, open source and unlimited. To keep scan history, get automated PR comments and use team dashboards, connect to [Maddox Cloud](https://www.maddoxengine.com) with an API key:

```bash
export MADDOX_API_KEY=<your-key>
npx maddox-engine ./src ./src/app/globals.css
```

Uploading never changes the scan result or its exit code. If your monthly limit is reached or the upload fails, the CLI prints a message and carries on, so `--fail-below` still decides whether the build passes. Without a key, nothing is sent over the network. The free plan includes 5 uploaded scans a month; Team and Scale are unlimited, see [pricing](https://www.maddoxengine.com/pricing). `MADDOX_API_URL` overrides the endpoint.

### Example

```bash
npx maddox-engine ./src ./src/app/globals.css --project my-app --fail-below 80
```

### State contract

An optional JSON file mapping a component-name pattern to the state names that component kind must cover:

```json
{
  "Button": ["disabled", "loading"],
  "*Input": ["error", "disabled"]
}
```

Ground truth is explicit — nothing is inferred about which states a component "should" have.

### Tokens Studio ground truth

If your tokens live in Figma via the Tokens Studio plugin rather than (or alongside) a Tailwind `@theme` block, export them to JSON and point `--tokens-studio` at the file. A single-set export (the whole file is one token tree) and a multi-set export (top-level keys are set names, e.g. `global`, `dark`) are both supported — for a multi-set export, every set is merged, later sets overriding earlier ones by path. `{alias}` references are resolved automatically. Only token types that resolve to a single comparable value (`color`, `spacing`, `sizing`, `fontSizes`, `borderRadius`, `dimension`) are used — composite types like `typography` or `boxShadow` describe a bundle of properties, not one value to diff against, and are skipped rather than misclassified.

### Figma Variables ground truth

If your tokens live in native Figma Variables rather than Tokens Studio, `--figma-file <file-key>` pulls them directly from Figma's Variables REST API. **This requires an Enterprise Figma plan** — the endpoint returns a 403 for any other plan, regardless of the token's own permissions. Get the file key from the file's URL (`figma.com/design/:file_key/...`).

```bash
export MADDOX_FIGMA_TOKEN=figd_...   # a personal access token with file_variables:read scope
npx maddox-engine ./src ./src/app/globals.css --figma-file abc123XYZ
```

The token is read from `MADDOX_FIGMA_TOKEN` (a personal access token, sent via the `X-Figma-Token` header) or `MADDOX_FIGMA_OAUTH_TOKEN` (an OAuth2 access token, sent via `Authorization: Bearer`) — never pass it as a CLI flag, which would leak it into shell history and process listings.

Only `COLOR` and `FLOAT`-typed variables are used, resolved to each variable's default mode, following alias references to their underlying value. `FLOAT` variables have no unit in Figma's API — treated as pixels, matching Figma's own UI default for spacing/sizing/radius scales; a variable actually meant as a unitless multiplier will resolve wrong. `STRING`/`BOOLEAN` variables are skipped, same policy as Tokens Studio's composite types. When more than one ground-truth source is given, Figma Variables take precedence over Tokens Studio, which takes precedence over `@theme` CSS — Figma sits earliest in a real design-to-code pipeline, so a later step is more likely to be the stale one.

### Scanning a live page

```bash
npx maddox-engine - ./src/app/globals.css --url https://example.com --format text
```

`--url` fetches the page's rendered HTML plus every same-origin `<link rel="stylesheet">` it links to, and runs the same color/font-size extraction against what's actually shipped — not what's in the repo at scan time. This is the difference between a source-linter and a production check: a stale CDN cache, a build step that silently drops a token, or a config typo can all make the deployed page diverge from what the source says, and only a live-URL scan catches that.

Two things don't carry over to `--url` mode:

- **Motion** — durations/eases only ever appear in rendered HTML/CSS as static literals if a component hardcodes them there, which real motion libraries don't do (they animate via the JS runtime). Motion findings are dropped from every `--url` scan rather than surfaced as noise from unrelated CSS.
- **Component states** — state-completeness is a "is this identifier referenced in this file's source" check; a fetched, already-rendered page has no source to check. `--states` is accepted but has no effect in `--url` mode.

Third-party stylesheets (a different origin than the page itself, e.g. a font CDN) are never fetched — only same-origin CSS, so findings only ever point at code the project actually owns.

### Suggested fixes

Every `near-miss` finding with a resolved nearest token gets a `suggestion` — the concrete replacement text (`var(--token-name)` for a CSS value, or `motionTokens.path.to.value` for a motion token). By default it's advisory text for you to apply yourself; pass `--apply-fixes` to write it back into the file. An `unrecognized` value with no close match, and a `missing`-state finding, never get a suggestion — there's no safe mechanical fix for either.

### Applying fixes automatically

```bash
npx maddox-engine ./src ./src/app/globals.css --apply-fixes
```

`--apply-fixes` writes every `color`/`font-size`/`spacing` near-miss suggestion straight into the source file it was found in, replacing the exact literal with `var(--token-name)`. It's scoped deliberately narrow:

- **Motion suggestions are never applied.** `motionTokens.path.to.value` assumes an import named `motionTokens` exists in that file's scope — there's no way to verify that per-file, and applying it blind could silently break the build. Motion findings always stay advisory-only.
- **State findings never had a suggestion to apply.**
- If a finding's line no longer contains its reported value (the file changed since the scan ran), it's skipped rather than guessed at.
- Not available with `--url` — a fetched page has no local file to write to.

This is a real edit to your working tree, not a dry run — review the diff (`git diff`) before committing, same as you would any other automated change.

### Health score

`match` counts fully, `near-miss` counts half (it drifted, but is still recognizably close to a real token), `unrecognized` and a missing required state count for nothing. A scan with zero checks scores 100.

## Programmatic use: route mapping

The CLI's own text/markdown/JSON output stays a flat file:line list — the right shape for a PR comment or a CI log. If you're building your own dashboard or report on top of this package, `fileToRoute(file)` and `groupByRoute(findings)` are also exported for grouping findings by the actual Next.js App Router route a file belongs to, rather than its raw path:

```ts
import { audit, loadGroundTruth, fileToRoute, groupByRoute } from "maddox-engine";

const groundTruth = loadGroundTruth("./src/app/globals.css", {});
const { findings } = await audit("./src", groundTruth);

fileToRoute("app/dashboard/page.tsx"); // "/dashboard"
fileToRoute("app/(auth)/login/page.tsx"); // "/login" — route groups are invisible in the real URL
fileToRoute("app/work/[id]/page.tsx"); // "/work/[id]" — dynamic segments kept as Next.js represents them
fileToRoute("components/Button.tsx"); // "Shared (non-route files)"

groupByRoute(findings); // [{ route, findings }, ...], real routes first, shared bucket last
```

Only `page.*`/`layout.*` files directly under an `app/` (or `src/app/`) directory get a real route — this deliberately does not trace the import graph to attribute a shared component to the page(s) that render it, since a component used by five different pages has no single "real" route, and guessing one would misattribute drift. Everything else lands in a `"Shared (non-route files)"` bucket instead. A layout keeps its route group in its own label (`/(auth) (layout)`) even though a page at the same URL doesn't, since two different layouts can legitimately wrap the same URL from different subtrees.

### Using this from a React client component

`import ... from "maddox-engine"` pulls in everything, including `scan.ts`/`groundTruth.ts`/`tokensStudio.ts`/`applyFixes.ts` — all of which read the filesystem (`node:fs`, `node:path`). A bundler building a browser/client bundle (Next.js's `"use client"`, Vite, etc.) can't resolve those, and the build fails even if the client code never actually calls a Node-dependent function — a bundler loads a module's own top-level imports regardless of which export is used.

If you're grouping or diffing findings inside a client component (e.g. rendering `fileToRoute`/`groupByRoute` output, or re-running `diffUsages` against data already fetched server-side), import from the `/client` subpath instead — it only re-exports modules with zero `node:*` imports anywhere in their own graph:

```ts
import { fileToRoute, groupByRoute, diffUsages, healthScore } from "maddox-engine/client";
```

`audit`/`auditUrl`/`loadGroundTruth`/anything that reads a file or fetches a URL still needs the package root, and stays server-side (an API route, a server component, a build script) — `/client` only has the pure data-transformation half.

## Using in CI

This repo is also a GitHub Action — `omrdev1/maddox-cli` — that runs a scan, posts the markdown report as a PR comment (updating the same comment on later pushes rather than piling up new ones), and optionally fails the build via `fail-below`.

```yaml
- uses: actions/checkout@v4
- uses: omrdev1/maddox-cli@main
  with:
    target-dir: src
    theme-css: src/app/globals.css
    github-token: ${{ secrets.GITHUB_TOKEN }}
    fail-below: "80"
```

Inputs:

- `target-dir` *(required unless `url` is set)* — directory to scan
- `theme-css` *(required)* — path to the CSS file containing the `@theme` block
- `motion-tokens` — path to a motion-tokens JSON file
- `states` — path to a state-contract JSON file. No effect when `url` is set.
- `tokens-studio` — path to a Tokens Studio / W3C Design Tokens JSON export
- `figma-file` / `figma-token` / `figma-token-type` — pull tokens from a Figma file's Variables; requires an Enterprise Figma plan. `figma-token` should be a secret (`${{ secrets.FIGMA_TOKEN }}`), never a literal value.
- `url` — a deployed page URL to scan instead of local source
- `github-token` *(required)* — for posting the PR comment, usually `${{ secrets.GITHUB_TOKEN }}`
- `fail-below` — fail the build below this health score; omit for comment-only
- `api-key` / `api-url` — optional, upload results to a [Maddox Engine](https://www.maddoxengine.com) dashboard account for scan history and drift trends across projects (a separate hosted product, not required to use the Action itself). When an upload succeeds, the PR comment links to the run on the dashboard. The PR comment is updated in place on every push, never duplicated.

Pin `@main` to a specific commit SHA if you want reproducible CI runs immune to changes on this branch.

## License

MIT
