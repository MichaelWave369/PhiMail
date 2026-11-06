# PhiMail R4: local Gmail bridge hardening

This is a **limited, experimental, loopback-only** security and reliability milestone. It does not authorize a public Gmail app, production deployment, OIDC-to-mailbox account linking, encrypted token storage or multi-tenant access.

## Changes

- The HttpOnly Gmail bearer session stays on Path=/api. A separate, non-authorizing random rotation handle uses Path=/auth/google, so an OAuth callback can retire the prior API session without exposing its bearer cookie to Keycloak or other localhost applications. Any obsolete root-path cookie is explicitly cleared. Ambiguous duplicate cookies are rejected.
- OAuth callback rejects duplicate state/code parameters and excessively long URLs. One-time state is consumed on callback, even if it fails.
- Google token, profile and metadata responses have bounded sizes (64 KB for token/profile, 256 KB per metadata/list response, 1 MB for full-message response), including decoded stream bytes instead of trusting Content-Length alone.
- OAuth token shapes and expiry are checked before sessions are created. Gmail summaries limit output field sizes and reject malformed message identifiers. Implausible timestamps default to Unix epoch.
- Plain-text MIME decoding is bounded by tree depth, parts visited, and decoded input size. HTML, images and attachments are never rendered.
- Each local Gmail session has a limit of 30 mail API requests per minute and at most 2 simultaneous mail operations. Inbox metadata is fetched in batches of 5 to avoid provider request bursts.
- Server startup refuses a non-loopback listen address. The Gmail pilot no longer leaves its UI indefinitely spinning if the backend is unavailable.

## Security limitations

These controls reduce risk but do not replace a security review, a persistent secure session store, multi-user isolation, encrypted provider tokens, production rate limits, replay prevention at the service level, OAuth app verification or robust operational monitoring.

In particular, **PhiID sessions and Gmail sessions are not linked**. The R3 mailbox association review remains non-authoritative and cannot read any mailbox. Disconnecting Gmail invalidates its server session; it does not guarantee remote Google refresh-token revocation.

## Validation

Run:
- npm test
- npm run build

The new server/bridge-hardening.test.js exercises session rotation, duplicate cookie rejection, token and Gmail body size caps, OAuth parameter duplication, bounded MIME traversal, invalid identifiers, and request throttling. These are isolated fake Google responses; no actual Google account is connected by the CI.

For real integration use only the local setup described in BRIDGE.md. Do not expose experimental ports to LAN or public internet.
