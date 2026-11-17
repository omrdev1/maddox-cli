# Contributing

Thanks for helping improve Maddox. Bug fixes, new detection patterns and documentation improvements are all welcome.

## Licence of contributions

This project is licensed under the [MIT License](LICENSE), copyright Grafikui Ltd. By submitting a pull request, you agree that your contribution is licensed under the same MIT License, and you confirm that you wrote it or otherwise have the right to submit it under that licence. No separate contributor agreement is needed.

## Before you open a pull request

1. Run `npm install` and `npm test`. All tests must pass.
2. Add a test for any new detection pattern or bug fix. Tests live in `test/`.
3. Run `npx tsc --noEmit` to type-check.
4. Keep changes focused: one fix or feature per pull request.

## Releases

Each release has an exact tag (`v0.9.0`) and moves the major tag (`v0`) to it, so Action users on `@v0` get compatible changes automatically. A change that breaks existing workflows gets a new major tag instead.

## Security problems

Do not report security problems in a pull request or anywhere public. See [SECURITY.md](SECURITY.md).

## Name and logo

"Maddox", "Maddox Engine" and the Maddox logo are trade marks of Grafikui Ltd. The MIT License covers the code, not the name or logo. If you publish a fork, give it a different name.
