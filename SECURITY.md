# Security Policy

`@utexo/webrgb` is a typings package with one small runtime helper. It moves
no funds itself, but dApps built on it drive a wallet that does, so we still
treat reports seriously and welcome responsible disclosure.

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities. Email:

**security@kaleidoswap.com**

Include a description, steps to reproduce, the potential impact and how to
reach you. We reply within 48 hours, send status updates every 7 days until the
issue is resolved, and aim to fix within 30 days.

## Disclosure

Give us reasonable time to investigate and fix before going public. We credit
researchers who report responsibly unless they prefer anonymity, and publish an
advisory once a fix ships.

## Scope notes

The surfaces worth a second look in this repository are:

- **`requestProvider()`** — it must only ever hand back `window.rgb` itself, and
  must reject rather than resolve when no provider appears. A page can define
  `window.rgb` before the wallet does; that is the wallet's problem to lock
  (the KaleidoSwap extension installs it non-writable), not something this
  helper can detect.
- **Declarations that overstate safety** — a type that claims a method cannot
  fail, or hides an error code, leads dApps to skip a check. Keep every
  funds-touching method's result optional where the wallet may omit it.

Vulnerabilities in a wallet that implements WebRGB belong with that wallet. For
the KaleidoSwap extension, the same address above applies.

## Supported Versions

Pre-1.0: only the latest published version receives fixes.
