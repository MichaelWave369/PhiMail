# Φ PhiMail R8 · Local account control center

**Status: verified by mocked-provider CI tests only. Local-development session management. NOT a cloud account system, durable mailbox association, hosted multi-user service, token vault, or provider-level revocation.**

## Why

R5/R6/R7 introduced three independently authenticated read-only mail providers, but the development UI only knew whether the currently selected provider was connected. R8 offers one scoped local inventory and an explicit way to disconnect **all mailbox sessions in the current browser** without inventing a universal authorization grant.

## New private local API

The following endpoints operate ONLY when BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173, NODE_ENV is not production, and both the HTTP Host and socket peer are the expected loopback origin. No CORS headers grant cross-origin access.

- GET /api/accounts: reports a versioned phimail.local-accounts/0.1 status with Gmail, Outlook and IMAP entries in stable order.
  - configured: whether this bridge has the provider setup, **NOT** whether a provider's live server is reachable.
  - connected: current request contains a validated server-side session for that provider. Session expiration is checked.
  - email: the address known from the separately authorized Google or Microsoft profile, or from the configured local IMAP username, only while the relevant session is connected.
  - authorization: google_oauth, microsoft_oauth or local_unlock. These are independent, non-interchangeable resource access paths.
  - capabilities: read:inbox, read:message ONLY while connected.
  - expires_at: verified local session expiry; no access token lifetime or provider refresh-token details are returned.
  - explicit false flags for PhiID linking, PhiCloud authorization, provider token revocation, persisted credentials and hosted multi-user email.
- POST /api/accounts/disconnect-all: requires exact same-origin Origin, X-PhiMail-Action: disconnect-all, no request body, and same strict local origin. Invalid/cross-site/extra-query/method attempts fail closed.
  - Revokes **only** the Gmail, Outlook and IMAP server sessions represented by the current browser's respective HttpOnly cookies and clears those cookie paths.
  - Keeps the separately verified PhiID identity session intact. Does NOT revoke tokens remotely at Google/Microsoft or invalidate the server's IMAP password. It also does not affect sessions in other browser profiles or other devices.
  - Returns a fresh zero-connected local inventory and disconnected_local_sessions count; never returns OAuth tokens, IMAP credentials, cookies, or server addresses.

The old provider endpoints are unchanged:
- GET /api/session?provider=gmail|outlook|imap (Gmail is default)
- GET /api/mail/messages?provider=...
- POST /api/session/disconnect?provider=... with existing provider-specific CSRF rules

## Race protections

Provider reads are asynchronous. R8 now re-checks the **same server-owned session object** after listInbox or readMessage completes and immediately before returning any mailbox data. If logout or reconnect removed/replaced the session during the read, the bridge sends HTTP 401 mailbox_session_revoked instead of stale mail content.

The React pilot also invalidates in-flight inbox and message-detail results when the selected provider changes or sessions are disconnected. This avoids displaying Gmail data under an Outlook tab merely because an older asynchronous request completed late.

## Account controls in the UI

In the local Mail providers pilot, the provider cards now distinguish:
- Configured but not connected
- Connected and read-only
- Setup needed

Connected cards display only the account email and no secret. An account-control strip reports the number of active sessions and offers **Disconnect all local sessions** when at least one exists.

If the strict local account center is unavailable (e.g. running a legacy localhost rather than 127.0.0.1 origin), the existing provider switcher remains usable, but no bulk control is falsely shown.

## Verification

Run npm test and npm run build. server/local-accounts.test.js includes:
- All three independent session states
- Exact origin, Host, method, query, CSRF and action-header checks
- No provider access from PhiID identity, nor secret leakage
- One-provider disconnect preserving the other providers
- All-provider disconnect clearing only the current browser's local mailbox sessions
- Stale in-flight Gmail data blocked after logout
- Rejected forged/expired provider sessions

These use fake Google/Microsoft responses and a fake IMAP connection. Real provider live end-to-end testing is a separate manual requirement.

## Production blockers

R8 is not permission to host public PhiMail. Security gate #4 still calls for hardened authorization, threat modeling, per-user account isolation, encrypted durable tokens, remote provider revocation strategy, auditing, production rate limits, and penetration testing. Account-linking gate #8 remains blocked. Do not treat a PhiID account login or review receipt as mailbox authority.
