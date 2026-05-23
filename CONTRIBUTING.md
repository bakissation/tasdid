# Contributing to @bakissation/tasdid

Thanks for your interest! This library validates and parses Algerian fiscal formulas used in onboarding, KYC, invoicing, and payments — correctness and backward compatibility matter more than features.

> **Maintainer-led.** Bug reports are very welcome (open an issue). For a fix or feature, please **open an issue first** so we can agree on the approach.

## Branching model

```
your fork ──PR──▶ dev ──▶ staging ──▶ main (releases tagged here)
```

- **Open all PRs against `dev`.** The maintainer promotes `dev → staging → main` and cuts releases from `main`.
- `dev`, `staging`, `main` are protected: CI must pass and changes land via pull request.
- **Merge commits only** (squash & rebase disabled) — keep each branch's commits clean Conventional Commits; they drive the release version.

## Dev setup

```bash
git clone https://github.com/bakissation/tasdid.git
cd tasdid
npm install
npm run build
npm test
```

No environment or credentials needed — the library is pure and the tests are deterministic.

## Before you open a PR

All of these must pass (exactly what CI runs):

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

## Conventions

- **Backward compatibility is sacred.** Never remove/rename exports, change a `parse*` result shape, or change validity semantics without a **major** bump. Add new optional fields and functions alongside existing ones.
- **Don't fabricate.** Only enforce a format or checksum that is law-backed or empirically confirmed. Where a format is convention (e.g. RC), parse **leniently** and document the confidence. Never invent a checksum (NIF/NIS control keys are not public).
- **Two scripts matter:** accept Latin **and** Arabic input (letters `أ/ب`, Arabic-Indic digits) — normalize before validating.
- **Type safety:** strict TypeScript, explicit return types, no `any`.
- **Tests:** cover valid, invalid-but-extractable, checksum tampering, and Arabic input. Use **synthetic** values — never commit real PII.
- **One identifier per file**; public API re-exported from `src/index.ts`.

## Commits & versioning

Releases are **fully automated** by [semantic-release](https://semantic-release.gitbook.io/) from your commit messages — **do not bump `package.json` or edit `CHANGELOG.md` by hand.**

- `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major. `docs:`/`chore:`/`refactor:`/`test:` don't release.
- On merge per channel: **`dev` → alpha**, **`staging` → beta**, **`main` → stable**. Notes go to [GitHub Releases](https://github.com/bakissation/tasdid/releases).

## PR checklist

- [ ] Targets `dev`
- [ ] `lint`, `typecheck`, `build`, `test` pass
- [ ] Conventional commit messages
- [ ] Backward compatible (or a `feat!:` major is intended)
- [ ] No fabricated formats/checksums; lenient where the format is convention
- [ ] No real PII in tests/fixtures
