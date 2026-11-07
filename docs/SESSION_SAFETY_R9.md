# Φ PhiMail R9 · Local provider-session safety gates

**Status: security-hardening for the experimental, single-process local mailbox bridge. This is NOT production identity, a durable encrypted credential vault, a hosted email service, verified remote revocation, or multi-tenant authorization.**

R8 added an account-control center and blocked stale mail responses after disconnect. R9 addresses specific independent failure modes in the local mailbox provider request path.

## 1. Bound total work even across rate windows

Earlier per-session throttle logic stored the rate count and active request count in one object. After one minute, the entire object was replaced. If a remote request was still active, its active count was erased from the new window. That could allow more than the intended number of concurrent provider operations.

R9 implements server/mail-gate.js, which stores accounting in a WeakMap keyed by the actual server-owned provider session object. A 60-second boundary can reset **only** request count, not outstanding work.

Default limits:
- 30 mailbox HTTP operations per 60-second window **per provider session**.
- 2 concurrent mailbox operations **per provider session**.
- 12 concurrent mailbox operations in the local bridge process **across all providers**.
- Every acquired slot is released in a finally clause, even on provider errors, timeout, or client disconnect.
- A slot release is idempotent. Session objects and provider tokens are never returned to the UI or used as client-selected rate-limit keys.

These are local abuse/availability safeguards; they do not provide a tenant-wide quota, upstream provider cost controls or public-hosting protection.

## 2. Prevent refresh-token races

The Google and Microsoft read-only adapters both keep temporary OAuth access/refresh tokens in **server process RAM**. Parallel reads can find an access token almost expired and each independently request a refresh. This can race if the provider rotates a refresh token or if retries overlap.

R9 adds a session-specific single-flight refresh operation:
- Concurrent refreshes for the **same** authorized session share one in-flight promise.
- A second independent mailbox session can refresh concurrently without borrowing the first one's token.
- A failure removes the pending refresh so a subsequent request can retry.
- A successful response updates the existing in-memory session. Google refresh responses with a new refresh token are now respected; invalid returned refresh-token values fail without writing them into the session.
- The provider-specific authentication, scope validation, request response caps and session expiry rules remain in their original modules.

This does NOT encrypt credentials at rest: no credential-at-rest storage is added at all. Process compromise, malicious local services, stale provider consent and leaked environment variables remain threats. Future durable credentials require a separate vetted vault and real per-user authorization design.

## 3. Restrict sensitive GET requests to the UI origin

The local read-only routes GET /api/session and GET /api/mail/messages... now reject:
- An explicit HTTP Origin header that does not equal BRIDGE_PUBLIC_ORIGIN.
- Browser Fetch Metadata Sec-Fetch-Site values other than same-origin or none.

Requests lacking these headers remain permitted to preserve loopback clients and older test harnesses. This is **defense in depth**, not a standalone authentication or CSRF solution, and it does not authorize cookies from unrelated local applications. Browser same-origin and provider session cookies remain mandatory for actual mail reads.

The strict R8 local account-center endpoint remains separately protected. The Gmail/Outlook OAuth callbacks, their PKCE/state handling, and the read-only IMAP unlock are intentionally unchanged.

## Tests and verification

Run npm test and npm run build.

- server/mail-gate.test.js covers rate-window rollover with outstanding work, process-wide caps, unrelated sessions, idempotent release, clock changes, and same-session single-flight refresh including retry after failure.
- server/mail-resource-security.test.js exercises actual local HTTP routes using fake Gmail/Microsoft provider responses, confirming one token refresh per provider while two requests are in flight, cross-provider isolation, and rejection of foreign-origin/same-site/cross-site sensitive reads.
- All prior Gmail/Outlook/IMAP/OIDC and R8 account-management tests continue to run.

No live Google, Microsoft or IMAP server is contacted in CI. The latest real-provider smoke tests and security assessment are still pending.

## Next production gate

Before **encrypted durable credentials** or **multi-user hosting**, agree a service-level security architecture with audited PhiID identity proof, mailbox ownership consent, provider-verified account binding, tenant-scoped resource authorization, an encrypted key hierarchy and rotation/revocation policy, encrypted-at-rest data models, replay-protected write actions, observability and independent external security review.

See PhiMail issues #4 and #8. R9 is a foundation, not a waiver for either gate.
