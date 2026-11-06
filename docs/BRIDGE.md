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
4. Register the exact redirect URL \`http://localhost:5173/auth/google/callback\`.
5. Add your account as a test user if the OAuth app is in testing.
6. Set \`GOOGLE_CLIENT_ID\` and \`GOOGLE_CLIENT_SECRET\` in a **local, gitignored** \`.env.local\` file, along with the values in \`.env.example\`.
7. Terminal A: \`npm run bridge:dev\`.
8. Terminal B: \`npm run dev\`, then open \`http://localhost:5173\`. Vite proxies \`/api\` and \`/auth\` to the loopback bridge.
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
