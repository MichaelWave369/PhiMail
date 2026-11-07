# Φ PhiMail R6 · Outlook read-only Microsoft Graph pilot

**Status: optional LOCAL DEVELOPMENT integration for personal Microsoft accounts. Not hosted mail, production SSO, mailbox linking, Outlook write access, or a verified end-to-end provider deployment.**

## What R6 implements

- A **separate** Microsoft OAuth Authorization Code + PKCE (S256) client, with one-time state, bounded pending flows, token handling on the Node backend, and separate HttpOnly application cookies.
- Personal Microsoft accounts use fixed https://login.microsoftonline.com/consumers/oauth2/v2.0 endpoints.
- Microsoft Graph v1.0 /me identifies the account from a provider-authenticated API response, NOT from PhiID or a browser-supplied email address.
- Delegated User.Read + Mail.Read (+ offline_access for server-held refresh) only. No Mail.Send, Mail.ReadWrite or application-wide permission is requested.
- GET /me/mailFolders/inbox/messages returns up to 20 messages translated into the existing PhiMail read-only DTO. GET /me/messages/{id} uses Prefer: outlook.body-content-type="text". If Graph returns HTML anyway, PhiMail displays a plain-text unavailable notice rather than rendering HTML.
- Long Microsoft Graph IDs are kept in a bounded in-memory map inside the relevant Outlook session; browser-visible IDs are random opaque handles. A handle from another session or after reconnect cannot identify a message.
- Gmail and Outlook OAuth sessions are **separate**. A query parameter can select only between those server-owned sessions; it never supplies a token, external URL or arbitrary provider.
- Session data and tokens are ephemeral process RAM, with a 4-hour local session maximum and no persistence. Outlook signout clears only PhiMail's local Outlook session; it does not revoke tokens remotely or log out Microsoft.
- Existing PhiID identity lab and Gmail provider remain independent; the R3 consent-to-review remains Gmail-only and grants no authority.

## App registration and local setup

1. Use a throwaway Microsoft personal account for testing. Create a separate Microsoft Entra application registration with **Personal Microsoft accounts only** as the supported account type. For this R6 pilot, work/school accounts are not enabled.
2. Add a **Web** platform OAuth redirect exactly matching http://127.0.0.1:5173/auth/microsoft/callback.
   - Microsoft documents that the Entra portal's redirect URI text box may reject an HTTP 127.0.0.1 address. Their official workaround is to edit the application's replyUrlsWithType manifest for a loopback URL, preserving the **Web** type. Do not silently substitute localhost, HTTPS or a public callback: the R6 bridge deliberately pins the origin to 127.0.0.1:5173.
   - See Microsoft's official Redirect URI guidance: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
3. Generate a short-lived **client secret** on the Microsoft app registration and keep it privately in a gitignored .env.local file. Never put it in source, docs, logs, screenshots, or the browser.
4. Enable delegated Microsoft Graph permissions User.Read and Mail.Read. Do not grant Mail.ReadWrite, Mail.Send, or application permissions for this pilot.
5. Set these private local environment values:
   BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173
   MICROSOFT_CLIENT_ID=<your Microsoft application GUID>
   MICROSOFT_CLIENT_SECRET=<your private Microsoft web-app secret>
6. From PhiMail run npm install, npm test, npm run build. Start the bridge with npm run bridge:dev and Vite with npm run dev in different terminals.
7. Open http://127.0.0.1:5173, choose Mail providers, select Outlook, then Connect Outlook (read-only). Review the delegated permissions on Microsoft's actual consent screen.
8. PhiMail returns to the local app. Reopen Mail providers if needed, select Outlook, and read recent Inbox messages as plain text. Switching to Gmail changes the selected provider session but does not share tokens.
9. Use Disconnect Outlook when done. The response explicitly indicates that remote token revocation is **not** performed.

## Safety and limitations

- This lab uses raw OAuth HTTP exchange with strict fixed endpoints, PKCE state binding and a confidential web client. **It has not completed an independent security audit** and is not production-grade. Prefer a vetted Microsoft authentication library for eventual public deployment after a design and security review.
- Every provider token remains in Node process RAM only. Session expiration and local logout do not invalidate tokens Microsoft may still honor. Remove the app's delegated access through Microsoft account settings if desired.
- Only run on the trusted developer machine. The code requires the exact origin and rejects non-loopback Host/peer requests for Microsoft's auth and session flows. Do not open a port, use a tunnel, or deploy the HTTP lab behind a public reverse proxy.
- Full paging, immutable message IDs, tenant admin consent, work/school Microsoft 365 accounts, token vault encryption, durable identity association, data export, account isolation, security event logging, Microsoft remote token revocation, and end-to-end live Microsoft verification are **not completed**.
- The server intentionally does not follow Microsoft Graph @odata.nextLink URLs. Its response may say more messages are available, but this pilot cannot page through them yet.
- No HTML, attachments, tracking images, active content, or MIME source bytes are sent to the browser.
- The browser's provider selection is not a security credential. Real ownership remains enforced by the server's distinct HttpOnly sessions and provider OAuth grants.
- Microsoft app registration, test tenant/account consent, and a manual real end-to-end smoke test must be completed by the operator. GitHub CI uses fake provider responses only.

## Routes

- GET /auth/microsoft/start and GET /auth/microsoft/callback (only with valid local Microsoft credentials)
- GET /api/providers shows configuration state
- GET /api/session?provider=outlook reports the current Outlook session; omitting provider preserves Gmail compatibility
- GET /api/mail/messages?provider=outlook and GET /api/mail/messages/{opaque-id}?provider=outlook
- POST /api/session/disconnect?provider=outlook requires Origin match and X-PhiMail-Action: disconnect-outlook

Related: PhiMail security gate #4 and permanent association gate #8. The R5 universal mailbox schema continues to apply unchanged.

## Official Microsoft documentation

- OAuth Authorization Code delegation: https://learn.microsoft.com/en-us/graph/auth-v2-user
- Graph list messages: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- Graph get message with Prefer text: https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
- Personal Microsoft account app registration: https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation
