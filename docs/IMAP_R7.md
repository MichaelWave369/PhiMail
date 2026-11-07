# Φ PhiMail R7: local read-only IMAP adapter

**Status: optional single-mailbox development pilot. NOT a public, secure, multi-user mail-hosting service.** This adapter joins the existing Gmail and Outlook providers via the R5 read-only mailbox gateway.

## What this rung implements

- Uses the ImapFlow Node IMAP library (version 2.10.2, pinned) only on the local bridge.
- Connects to **one IMAP mailbox configured entirely through the Node server's private environment**. The browser cannot choose a server hostname, port, username or IMAP password.
- Requires a second, unrelated **high-entropy local unlock phrase** entered in the web UI. That phrase authorizes only a temporary local PhiMail IMAP session; it is NOT your mailbox password, an OAuth token, a PhiID login, a cloud permission, or evidence that another user owns the mailbox.
- No IMAP login happens until a valid explicit unlock is given. Wrong credentials, missing/incorrect Origin or action headers, invalid Host/peer, unexpected JSON, and excessive retries fail closed.
- The configured IMAP service must use TLS with certificate validation. There is no STARTTLS downgrade, plaintext fallback, proxy input, or browser-controlled destination.
- Every action opens the INBOX with ImapFlow's getMailboxLock('INBOX',{readOnly:true}), which uses read-only mailbox mode. It uses the newest message sequence range and fetches only bounded envelope/flag/date/size metadata.
- Message IDs are random **per-session handles** mapped to IMAP UIDs in server RAM. UIDVALIDITY is checked before reading details, so stale handles cannot silently refer to another mailbox generation.
- Plain-text details come only from a bounded text/plain MIME part through ImapFlow's decoded download() stream. HTML, remote images, attachments, and message source bytes are not rendered.
- Max 20 minutes for each temporary browser session. Logout invalidates the local session cookie and map; it does not change or remotely revoke your IMAP account's static credential.
- Existing R4 mail request rate/concurrency limits apply. The IMAP adapter itself caps server replies, decoded text, MIME traversal depth and connection timeouts.

## Required local setup

Only proceed if the mailbox server allows IMAP and the account owner explicitly authorizes the connection. Many mainstream email providers require OAuth or app-specific passwords and may disable ordinary password-based IMAP; this pilot does not implement IMAP OAuth.

1. Use Node.js 22+ and npm install in the PhiMail checkout.
2. Add these entries to **gitignored** .env.local, supplying real values privately:
   - BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173
   - IMAP_HOST=mail.example.test  (a real DNS hostname for your provider)
   - IMAP_PORT=993  (the normal implicit TLS port; other explicit TLS ports may be configured if supported)
   - IMAP_USERNAME=mailbox@example.test
   - IMAP_APP_PASSWORD=(a provider-authorized app password or credential)
   - IMAP_UNLOCK_KEY=(generate a separate random 32+ character secret, not your mailbox password)
3. Never commit, upload, paste into chat or expose .env.local. Do not use your primary account password when the provider offers safer OAuth or app passwords. This R7 pilot has no secret-management vault or durable auditing.
4. Run npm test and npm run build, then start npm run bridge:dev and npm run dev in separate terminals.
5. Open http://127.0.0.1:5173. Use Mail providers > IMAP. Enter only the **local unlock phrase**. This does not pass your IMAP password to React.
6. Browse recent inbox summaries, open a bounded plain-text message, and select Disconnect. Switching to Gmail or Outlook leaves their sessions separate.
7. If real connections fail, check the provider's IMAP/TLS/app-password policy. Do not disable TLS certificate verification to make a broken login work.

## HTTP routes

- POST /api/imap/connect with application/json body containing ONLY the key unlock. Requires Origin: http://127.0.0.1:5173 and X-PhiMail-Action: connect-imap.
- GET /api/providers reports IMAP as configured if the private host, username, password, unlock, and local origin meet configuration checks. This is **not a live health check**.
- GET /api/session?provider=imap reports the local temporary IMAP session.
- GET /api/mail/messages?provider=imap and GET /api/mail/messages/{opaque-handle}?provider=imap use the common, validated reader contract.
- POST /api/session/disconnect?provider=imap requires same-origin Origin and X-PhiMail-Action: disconnect-imap. This stops the local session but does not invalidate the server's IMAP app password.

## Security boundaries / intentionally unfinished

- **No IMAP SMTP sending, write operations, flag modifications, deletion, folder synchronization, attachment downloads, background polling, persistence, or mailbox migration.**
- **No public deployment, production session governance, multi-tenant identity, provider-level OAuth authorization, mailbox-to-PhiID linking, tenant-owned secret vault, email address proof or durable consent.**
- The local unlocking phrase is a separate access secret and must itself be protected. A process that knows the phrase can access the configured mailbox through this developer bridge. The local service is only safe for a trusted developer machine with protected process environment, not a shared workstation or open LAN.
- IMAP offers multiple authentication mechanisms; this initial adapter uses the library's user/password configuration, which might require a provider-specific app password. Some providers do not support that, so connection functionality must be verified with the actual provider.
- Hostname DNS lookup is controlled by the server's operator configuration. The browser cannot supply destinations, but trusted operators must still use a genuine TLS-protected server and keep the host settings private.
- Each read reconnects and logs out to avoid long-lived shared mutable IMAP sockets in the pilot. This adds latency and is **not** an efficient production mail engine.
- Only the latest 15 messages appear in the UI by default; the server accepts up to 20. Additional folders and paging require later explicit design.

## Testing

server/imap.test.js uses an injected fake IMAP client that observes:
- TLS verification and readOnly inbox mode
- explicit unlock + same-origin/CSRF safeguards
- no automatic cross-provider authority
- per-session UIDs and UIDVALIDITY invalidation
- hostile MIME rejection, invalid session handles, logout and throttling

No external IMAP server is contacted by tests. A real TLS+IMAP mailbox login remains **unverified until manually tested by the operator**.

## Sources

- ImapFlow documentation: https://imapflow.com/docs/api/imapflow-client/
- ImapFlow message fetch guide: https://imapflow.com/docs/guides/fetching-messages/

Related production security requirements: PhiMail issues #4 and #8.
