# Security Policy

## Supported versions

This project follows semantic versioning. Security fixes are applied to the **latest released minor version** only. Please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue or pull request for security vulnerabilities.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/bakissation/tasdid/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgement and can track the fix in the private advisory.

## Why this matters here

`tasdid` validates **identity, fiscal, and banking identifiers** that downstream code uses for onboarding, KYC, invoicing, and payments. The library has no network, filesystem, or credential surface, so the security-relevant risks are about **correctness**:

- A **checksum bug** (Luhn / mod-97) that accepts an invalid NIN / RIB / CCP / IBAN, or rejects a valid one.
- A **parsing bug** that mis-extracts a part (e.g. the wrong wilaya from an RC/NIS) or mis-classifies an RC entity type.

If you can produce an input that yields a wrong validity result or a wrong extracted field, that's in scope.

## Handling identifiers responsibly

These identifiers are **personal/commercial PII**. Consumers should never log them in clear and should redact them in error reporting. The library itself stores nothing and performs no I/O.

## Out of scope

- Issues requiring an already-compromised machine.
- Advisories in **dev-only** dependencies (build/test/release toolchain) not reachable at runtime — the published package has **zero runtime dependencies**.
