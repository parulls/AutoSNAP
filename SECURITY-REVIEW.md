# AutoSNAP security review — 11 November 2026

## Scope

Review of the Next.js proxy, NestJS authentication and account management, master-data access, SNAP execution, ASPI browser automation, history/PDF access, dependency advisories, and the connected Supabase schema. This is a code/configuration review with regression tests, not a complete independent penetration test.

## Implemented fixes

| Finding | Remediation | Verification |
| --- | --- | --- |
| Public backend trusted proxy context without authentication | Production middleware requires a constant-time-checked server-to-server secret; frontend creates proxy headers itself | Missing/incorrect secret and spoofed localhost rejected in tests |
| Public setup could treat a supplied localhost header as local | Production always requires setup token | Code review; backend proxy guard regression |
| Login throttling disappeared on restart and differed per instance | Atomic database counters, hashed identifiers, IP and account limits | Two controllers share the same counter in an isolated database |
| Login processing accepted oversized passwords and skipped hashing for unknown users | Input bounds and dummy hash verification | Account tests; code review |
| Raw exceptions could include credential values from browser fill call logs | Generic unexpected-error responses; no raw login alerts; extended cookie/card redaction | Header/redaction and account tests |
| Portal templates could replace security headers | Shared header validation before opening a browser; cookie, framing and CRLF injection rejected | Header injection regression tests |
| Browser locks only covered one Node process | Database lease per ASPI identity and environment, owner-checked release, 15-minute crash expiry | Two session managers cannot acquire the same account concurrently |
| Production cookies could lose Secure through proxy context | Production cookies always Secure, HttpOnly, SameSite=Strict | Account flow and code review |
| No explicit browser content policy and unlimited proxy body | CSP, frame protection, MIME protection, 256 KB streaming body bound, cross-site POST rejection | Production build, lint, code review |
| Private tables lacked defense-in-depth RLS | RLS with no public policies, schema/table grants revoked from anon/authenticated | Supabase SQL verification and security advisor |
| Runner required a Windows Chrome executable | Pinned serverless Chromium on Vercel, temporary restricted profile directory | TypeScript build; actual Linux deployment still pending |

## Database changes

Only additive tables/indexes and access restrictions were applied. Users, master records, test runs, encryption keys, and stored credentials were not reset. Migration filenames match the connected project's migration history.

RLS has intentionally **no browser policies**: this application uses server-side database connections, not browser Supabase table access. The Supabase advisor may display informational `rls_enabled_no_policy` notices; this is deny-by-default, not a request to grant anonymous access. The privileged backend database role can still access the private tables.

## Release prerequisites and remaining risks

- Set the same strong `AUTOSNAP_INTERNAL_TOKEN` in both Vercel projects before promoting this release. It must never be exposed through `NEXT_PUBLIC_` variables.
- Preserve the existing encryption key. Confirm backend HTTPS URL, database pooling, Google reCAPTCHA hostname allowlist, Node runtime, Chromium bundling, region and function duration in project settings.
- Frontend and backend production deployments are READY in Singapore. Public checks verified page 200, proxy/database account-state 200, direct backend rejection 403, unauthenticated testing 401, cross-origin rejection 403, and incorrect Content-Type 415. Browser verification found the login form and registration CAPTCHA frame with no console errors. All 35 regression tests pass; production dependency audit reports zero known vulnerabilities.
- Actual ASPI end-to-end requests and a browser launch inside the deployed Linux function are **not yet verified**. Local headless regression fixtures do not prove provider access or production credential validity.
- The current database connection uses a privileged Postgres account. A dedicated least-privilege runtime role is recommended; coordinate that credential change with both deployment environments to prevent an outage.
- Access is shared within an internal QA workspace. This review does not introduce multi-tenant isolation between organizations.
- CSP currently allows inline scripts for Next.js compatibility. Nonce-based strict CSP would provide stronger XSS defense and requires a separately tested rendering change.
- Database rate limits do not replace edge/WAF DDoS protection. Monitor request rates, errors, account changes and provider costs.
- Expiring leases prevent normal overlapping runs, not a hard exactly-once guarantee if a process outlives its lease. Financial Execute operations are not automatically retried.
- Temporary serverless profiles may disappear. Provider CAPTCHA/MFA/OTP must be handled through legitimate user interaction; it is never bypassed.
- Preserve encrypted backups and test recovery. Keep dependencies patched and commission an authorized independent penetration test before sensitive production use.

No review can guarantee an application cannot be compromised.
