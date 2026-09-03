# maddox

Scans source code for design-token, motion, and component-state drift against your own design system.

This is the open-source scanning engine behind [Maddox Engine](https://www.maddoxengine.com) — the same code the hosted dashboard and GitHub Action run, extracted so you can run it locally or in CI with no account required.

## What it checks

- **Colors** — every hex literal in your source, matched against your `@theme` tokens by exact value, then by RGB distance for near-misses.
- **Motion** — durations and easings used in code, checked against your real motion tokens (duration against duration, ease against ease — never cross-compared).
- **Component states** — an explicit contract you write yourself (a JSON file naming which states each kind of component must cover: `disabled`, `loading`, `error`, and so on). Confirms the state is referenced in the file; it doesn't verify it renders correctly — that's a static source check, not a visual one.

This is a static source-code scanner, not a pixel/DOM visual-regression tool. It checks the values developers actually wrote against the tokens that are supposed to govern them, so it catches drift that renders identically to a real token (and so produces zero visual diff) but was never written as one.

## Usage

```bash
npx maddox-engine <target-source-dir> <path-to-globals.css-with-@theme-block> [options]
```

Options:

- `--project <name>` — project name (defaults to the target directory's basename)
- `--motion <path>` — path to a JSON file of motion tokens (e.g. a vendored copy of your motion-tokens export)
- `--states <path>` — path to a state-contract JSON file (see below)
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

- `target-dir` *(required)* — directory to scan
- `theme-css` *(required)* — path to the CSS file containing the `@theme` block
- `motion-tokens` — path to a motion-tokens JSON file
- `states` — path to a state-contract JSON file
- `github-token` *(required)* — for posting the PR comment, usually `${{ secrets.GITHUB_TOKEN }}`
- `fail-below` — fail the build below this health score; omit for comment-only
- `api-key` / `api-url` — optional, upload results to a [Maddox Engine](https://www.maddoxengine.com) dashboard account for scan history and drift trends across projects (a separate hosted product, not required to use the Action itself)

Pin `@main` to a specific commit SHA if you want reproducible CI runs immune to changes on this branch.

## License

MIT
