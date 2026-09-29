# Contributing to webrgb

Thanks for your interest. Bug reports, fixes and proposals for the provider
surface are welcome.

## Development

```bash
npm ci
npm test   # tsc over index.js (checkJs) and test/consumer.ts against index.d.ts
```

There is no build step: `index.d.ts` and `index.js` are published as they are.

## What lives here

- `index.d.ts` — the WebRGB provider surface (`window.rgb`), its error codes and
  the `rgb:ready` event.
- `index.js` — `requestProvider()`, the only runtime code.
- `test/consumer.ts` — a compile-only dApp. It pins what a consumer can write
  and, through `@ts-expect-error`, what it cannot. Extend it whenever you touch
  the declarations.

## Changing the surface

The declarations mirror the reference implementation in the KaleidoSwap
browser extension (`src/injected.ts`). Propose surface changes there first, or
alongside; a declaration for a method no wallet serves helps nobody.

- Adding a method or an optional field: minor version.
- Changing or removing a signature, an error code or an event: major version.
- Record every change in `CHANGELOG.md` under `Unreleased`.

## Workflow

1. Branch from `dev`; `main` tracks upstream.
2. Keep `npm test` green; CI runs it on Node 20 and 22 and then installs the
   packed tarball into a bare project to prove it imports.
3. Open a pull request with a short rationale. Link the extension change when
   there is one.

## Releasing

Maintainers: bump `version` in `package.json`, move the `Unreleased` notes under
a dated heading in `CHANGELOG.md`, commit, then

```bash
git tag v<version> && git push --tags
```

The publish workflow waits for a reviewer on the `npm` environment, runs the
tests, checks the tag against `package.json` and publishes with provenance.

## Security

See [SECURITY.md](SECURITY.md). Never open a public issue for a vulnerability.
