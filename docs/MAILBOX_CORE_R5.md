# Φ PhiMail R5: provider-neutral read-only mailbox engine

## Status and intent

**Development-only architecture milestone.** The Gmail adapter continues to use Google OAuth and the original local bridge session, server-memory credentials, response-size caps and mail request throttling. The same UI and HTTP endpoints keep working. The mailbox engine has a standardized read-only provider interface, but **Outlook and IMAP are not implemented or connected**. GitHub Pages remains a local demonstration, not live mail.

### Contract

The public adapter schema identifier is phimail.mailbox-read/0.1.

- server/mailbox-core.js owns the adapter registry, catalog, message-envelope validation and read dispatch.
- server/providers/gmail.js owns all Gmail API paths, inbox list/metadata batching, envelope translation and bounded plain-text MIME traversal.
- server/bridge.js retains all Google OAuth exchange, session/cookie handling, refresh tokens in memory, origin checks and rate limiting.
- The bridge constructs exactly one real adapter: Gmail. The catalog marks Outlook and IMAP as not ready with no capabilities.
- A mailbox session chooses the compiled-in adapter; no user-supplied provider URL, bearer token, account identity, or arbitrary host is accepted.
- The only dispatched operations are listInbox({session,limit}) and readMessage({session,id}). There is **no send/delete/modify API**. Future delivery will need a separate explicitly authorized capability.
- Message DTO: id, threadId, from, email, to, subject, date (ISO UTC), preview, unread, starred, labels, folder, provider. Detailed reads additionally return bounded plain-text body. All responses are validated at the gateway before returning to the browser.
- Existing HTTP routes remain GET /api/providers, GET /api/session, GET /api/mail/messages, and GET /api/mail/messages/:id. A path ID must be a limited ASCII opaque ID safe for URLs; adapters for services with other identifiers must encode those identifiers to the contract, not relax URL safety.
- A verified PhiID OIDC session or temporary consent-to-review receipt is **never** an email provider authorization or linked mailbox. Only the independent Gmail OAuth session can read Gmail.

### How to add a provider, safely

1. Define a module under server/providers/ that owns fixed destination URLs and a dedicated vetted OAuth or IMAP client. Do not turn incoming request data into a service endpoint.
2. Create a provider session that is separately authorized and revocable; never mistake an email address, PhiID profile, or preview JSON for a credential.
3. Implement listInbox and readMessage, producing a safe message envelope. Keep HTML, remote images, attachments and active content out of the initial reader.
4. Register the adapter only after provider setup, least-privilege scopes, resource ownership, token lifecycle, abuse limits and security tests exist.
5. Add negative tests for account separation, wrong provider, unauthorized access, malicious provider data, provider outages and sessions expiry.
6. Do not claim a provider is available or deployed based on its name appearing in the catalog.

### Testing and safety

npm test runs server/mailbox-core.test.js as well as the previous OAuth/Gmail hardening suites. Tests cover synthetic provider injection, forbidden method capabilities, unknown provider rejection, malformed message responses, invalid IDs, provider mismatches and bounded text. The existing Gmail integration tests still exercise the real adapter through the HTTP bridge with mocked provider responses. npm run build checks the UI.

These are automated tests with mock provider responses, **not proof of live Google OAuth, Microsoft Graph or IMAP access**. No production encryption, multi-tenancy, Gmail verification, remote revocation, cloud hosting, send scopes, background sync or mailbox-to-PhiID binding is introduced.

Related production gates: PhiMail issues #4 and #8.

## R7 IMAP adapter

The third compiled-in adapter now implements optional single-account read-only TLS IMAP using ImapFlow. It is disabled unless explicitly configured by the developer with private server credentials and an independent local unlock. The caller cannot submit IMAP destinations or account passwords through the browser. See [IMAP R7](IMAP_R7.md). No send, delete, folder sync, persistent credentials or production authorization was added.
