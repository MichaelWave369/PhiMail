# Φ PhiMail Rung 2A: Gmail read-only experimental bridge

## Boundaries

The published GitHub Pages app is a **local demo**. It cannot authenticate against real email on its own.

This milestone adds a standalone Node.js bridge and an optional same-origin development experience. With valid credentials, it can:
- Start Google OAuth Authorization Code + PKCE using a server-side Web OAuth client.
- Receive a callback on the same origin as the UI.
- Hold Gmail tokens in **server process memory only**, never in localStorage or React.
- Read a Gmail address, the latest inbox message summaries, and *plain-text* message bodies.
- Disconnect by invalidating the in-memory server session.

The bridge **does not** send email, synchronize folders, store encrypted mail, host mailboxes, or connect Outlook/IMAP yet. It is not suitable for public multi-user deployment without a further security review.

## Local setup

1. Have Node.js 22+ installed.
2. Run \`npm install\`.
3. In Google Cloud, enable the Gmail API and create an OAuth 2.0 **Web application** client ID and secret.
4. Register the exact redirect URL \`http://127.0.0.1:5173/auth/google/callback\`.
5. Add your account as a test user if the OAuth app is in testing.
6. Set \`GOOGLE_CLIENT_ID\` and \`GOOGLE_CLIENT_SECRET\` in a **local, gitignored** \`.env.local\` file, along with the values in \`.env.example\`.
7. Terminal A: \`npm run bridge:dev\`.
8. Terminal B: \`npm run dev\`, then open \`http://127.0.0.1:5173\`. Vite proxies \`/api\` and \`/auth\` to the loopback bridge.
9. Open Accounts and select **Connect Gmail (read-only pilot)**. The Google consent screen will show the actual requested scope.

To run the automated tests: \`npm test\`. These use fake provider responses and do not need Google credentials.

## Security notes

- Only use the bridge on local loopback while under development. It has **volatile sessions, not production session storage**, and no account identity/tenant separation.
- Sessions are HttpOnly, SameSite=Lax cookies; OAuth callbacks verify one-time state and PKCE.
- The bridge has fixed Google URLs. No user-selected provider hosts or SMTP relays.
- Plain text is rendered in React text nodes, not injected as HTML. HTML-only messages are not rendered.
- Only a read scope is requested. No Gmail send, modify, or delete capability is available.
- The backend serves no static files; for eventual deployment, reverse-proxy the API and UI together on the **same HTTPS origin**. Cross-origin direct GitHub Pages access is unsupported.
- In-memory token storage reduces persistence but is not a substitute for secret-management, encryption, access controls, audit logs, revocation support, session governance, or operational security in production.
- Explicit production startup opt-in exists to **prevent** accidental deployment, not to certify safety.
- Never log OAuth codes/tokens or commit OAuth client secrets. Rotate credentials if accidentally exposed.
- Google classifies \`gmail.readonly\` as a **restricted scope**. Public release may require app verification and an independent security assessment, depending on scope and server-side handling.

## Deployment architecture

\`\`\`text
mail.phi-field.com  HTTPS
    |
    +-- static PhiMail React client
    |
    +-- /api/*       -> private PhiMail Bridge
    +-- /auth/google/* -> private PhiMail Bridge
                          |
                          +-- Gmail API (OAuth, read-only)
                          +-- Future Microsoft Graph adapter
                          +-- Future IMAP/SMTP adapter
\`\`\`

A forthcoming PhiCloud identity service can provide the user session layer. **PhiCloud account identity and PhiMail email addresses are separate concerns:** existing Gmail or Outlook users should not need a PhiMail-hosted address, and creating a PhiOS account must not implicitly create a public mailbox.

## Next security milestone

- Provider token encryption at rest, persistent session store, multi-user identity binding, CSRF/cross-account defense, session rotation/revocation, rate limiting for all endpoints, audit trail without message contents.
- Page-based sync, robust MIME/attachment limits, error recovery and quota handling.
- Hosted OAuth verification, penetration testing, secure production deployment.
- Add sending as a separate capability with explicit permission and approval.

## PhiID R2 optional local identity experiment

To test independent PhiID sign-in from the same PhiMail bridge, set PHIMAIL_LOCAL_PHIID=1 and BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173 in gitignored .env.local. This requires a separate PhiMail OIDC client in PhiID's local Keycloak realm. Consult [R2 setup](LOCAL_PHIID_R2.md). Identity sessions do **not** link, authorize, or modify existing Gmail sessions. If testing Google OAuth too, register the matching 127.0.0.1 Gmail callback in Google Cloud; the redirect URI must match exactly.

## R4 security and reliability changes

The localhost bridge now validates one-time OAuth callback parameters, rotates the root-path Gmail cookie on reconnection, clears old cookie paths, limits provider body sizes and MIME traversal, caps sessions and request rates, and binds the command-line server to loopback only. See [R4 hardening and test guide](BRIDGE_HARDENING_R4.md). These controls do **not** make the bridge production-safe or link Gmail to PhiID.

## R6 Microsoft Outlook read-only pilot

PhiMail also supports an optional separate Microsoft personal-account OAuth + Graph adapter in local development. This has a different browser cookie and server session from Gmail, requests only delegated User.Read and Mail.Read (plus offline_access) and never links to PhiID. Setup requires a Microsoft Entra app registration and private credentials; see [R6 Outlook guide](OUTLOOK_R6.md). No sending or public deployment is provided.

## R7 optional IMAP local read-only pilot

The same provider gateway now accepts an opt-in, **single server-configured** TLS IMAP account. The browser supplies only a separate local unlock phrase; IMAP credentials remain in the server process's gitignored environment. Each read opens INBOX as read-only and verifies TLS. See [R7 IMAP configuration, security limits and test guide](IMAP_R7.md). This is not cloud hosting, automatic PhiID authorization or a public multi-user service.

## R8 local account control

The developer-only bridge now exposes a non-authorizing `/api/accounts` inventory and `POST /api/accounts/disconnect-all` action that clears the **current browser's** Gmail, Outlook and IMAP server sessions only. It does not sign out PhiID or revoke remote provider credentials. In-flight mailbox data is rechecked against the session after each read. See [R8 contract and tests](LOCAL_ACCOUNTS_R8.md). These routes require the exact `http://127.0.0.1:5173` loopback origin and remain disabled in production.

## R9 provider-session and refresh-token safety

The local bridge uses a session-keyed mail request gate that retains in-flight counts across minute boundaries, caps global concurrent provider reads, and coalesces overlapping Gmail or Outlook token refresh requests **within** one provider session. Sensitive GET routes reject explicitly mismatched Origin and cross-site Fetch Metadata. These features do not establish production tenancy or persist tokens; see [R9 details](SESSION_SAFETY_R9.md).

## R10 encryption envelope foundation

A separate server-only [R10 credential-envelope module](CREDENTIAL_ENVELOPE_R10.md) prepares authenticated AES-256-GCM credential wrapping, revision checks, key rotation and cross-owner mailbox binding. The experimental bridge **does not invoke it yet** and continues holding tokens in volatile memory. There is no credential disk persistence, trusted key service, completed authorization gate or production deployment capability.

## R11 verification-gated owner-to-mailbox grant contract

The separately testable [R11 authorization contract](MAILBOX_GRANTS_R11.md) defines one-time approval intents, owner+provider-session binding, read-only capabilities, expiry and owner revocation. It requires three independently trusted backend verifiers, which **have not yet been implemented**. The local provider bridge does not call this authority, and no owner-linking HTTP API, persistent record or new mailbox permission is introduced.
