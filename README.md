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
- `--url <page-url>` — scan a deployed page instead of local source (see below); pass a placeholder like `-` for `<target-source-dir>` when using this alone
- `--format text|json|markdown` — output format (default: `text`)
- `--fail-below <0-100>` — exit non-zero if the drift health score falls below this threshold; omit to never fail

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

Every `near-miss` finding with a resolved nearest token gets a `suggestion` — the concrete replacement text (`var(--token-name)` for a CSS value, or `motionTokens.path.to.value` for a motion token). It's advisory text for a human to apply, not an automatic edit: nothing in this package rewrites your source files. An `unrecognized` value with no close match, and a `missing`-state finding, never get one — there's no safe mechanical fix for either.

### Health score

`match` counts fully, `near-miss` counts half (it drifted, but is still recognizably close to a real token), `unrecognized` and a missing required state count for nothing. A scan with zero checks scores 100.

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
- `url` — a deployed page URL to scan instead of local source
- `github-token` *(required)* — for posting the PR comment, usually `${{ secrets.GITHUB_TOKEN }}`
- `fail-below` — fail the build below this health score; omit for comment-only
- `api-key` / `api-url` — optional, upload results to a [Maddox Engine](https://www.maddoxengine.com) dashboard account for scan history and drift trends across projects (a separate hosted product, not required to use the Action itself)

Pin `@main` to a specific commit SHA if you want reproducible CI runs immune to changes on this branch.

## License

MIT
