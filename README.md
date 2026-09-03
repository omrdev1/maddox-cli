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

## CI

A GitHub Action wrapping this CLI — with PR-comment reporting and the `--fail-below` gate wired in — is available as part of [Maddox Engine](https://www.maddoxengine.com), along with a hosted dashboard for scan history, drift trends, and team usage across projects.

## License

MIT
