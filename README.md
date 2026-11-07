# Φ PhiMail

**Communication without captivity.** A new open-source mail experience for the PhiOS ecosystem.

## Current milestone: PhiMail Client v0.1

The first release is an intentionally local browser demo. It contains a responsive inbox, search, starred messages, read/unread controls, folders, archive/trash, draft composition, replies, forwards, local JSON import/export, and keyboard shortcuts. Synthetic messages live in browser localStorage.

**Important:** This prototype cannot synchronize a real mailbox or deliver email. The demo send action records a local Sent message; it does not transmit it. You can hand off a composed message to your operating system's mail app through a mailto link. localStorage is not encrypted. Do not put private emails or mailbox passwords in the demo.

## Run

Requirements: Node.js 22+

1. Clone this repository.
2. Run npm install.
3. Run npm run dev.
4. For checks, run npm test and npm run build.

GitHub Actions verifies pull requests and deploys main to GitHub Pages, provided the repository's Pages source is configured to GitHub Actions.


## Rung 2A · experimental Gmail bridge (local development only)

A separate **Node.js server** and optional local development panel can now connect a Google account through OAuth Authorization Code + PKCE, read recent Gmail inbox summaries, and display plain-text messages. The Gmail pilot is only visible in `npm run dev`, not in the public GitHub Pages production build.

Use `npm run bridge:dev` and `npm run dev` in separate terminals after configuring Google OAuth credentials. See [the bridge setup and security guide](docs/BRIDGE.md). Do not attempt public deployment yet: token/session persistence, account separation, provider verification, security testing, and production infrastructure are unfinished.

**No sending, Gmail modification, hosted mailbox, Outlook connection, or IMAP adapter is implemented in this rung.** All existing demo features remain available.

## Field Connections R1 · integration contract inspector

Use **Field Connections** in the sidebar to inspect a synthetic PhiID identity export (display-only) and, when developing locally, read the PhiCloud R0 declared service inventory. Neither action authenticates an account or establishes service health. Read the [integration guide](docs/INTEGRATION_R1.md) for setup and security boundaries.

## R2: Independent local PhiID OIDC login

The development-only Field Connections panel can sign into the **same local Keycloak realm** used by PhiID, using PhiMail's own audited OAuth Authorization Code + PKCE session. This is a locally verified **localhost test identity**, but not cloud authorization, Gmail linking or hosted SSO. See [R2 local identity setup](docs/LOCAL_PHIID_R2.md). No login is provided on GitHub Pages.

## R3: explicit local mailbox review (no real linking)

Field Connections now includes a local-only, expiring **consent-to-review** flow for the current verified PhiID test identity and separately connected Gmail account. It requires deliberate acknowledgment and allows immediate clearing. This is **not** permanent account linking, mailbox authorization or a PhiCloud grant. See [R3 setup](docs/MAILBOX_REVIEW_R3.md).

## R4: Gmail bridge security hardening

The optional local Gmail bridge now rotates its sessions across OAuth reconnects, limits provider response size and MIME traversal, rejects ambiguous cookies, and throttles mail API calls. The public demo remains separate and no mailbox is linked to PhiID. See [R4 technical changes and remaining limitations](docs/BRIDGE_HARDENING_R4.md).

## R5: Shared read-only mailbox adapter engine

The experimental bridge now uses a **provider-neutral mailbox contract**: Gmail is the sole operational read-only adapter, while Outlook and IMAP remain clearly marked *not implemented*. This centralizes message validation and read-only capabilities without letting a login or untrusted provider response grant permissions. See [R5 mailbox adapter contract](docs/MAILBOX_CORE_R5.md). No sending, provider linking, hosted mail, or public multi-user service was added.

## R6: Local-only Outlook Microsoft Graph read-only pilot

PhiMail now has an optional **Outlook personal-account reader** using independent Microsoft OAuth + PKCE and the existing universal mailbox engine. Gmail and Outlook sessions are separate; IMAP is still not implemented. The pilot needs your own Microsoft Entra app registration and a manual real-account smoke test. Never expose its HTTP backend publicly. See [Outlook R6 setup, permissions and limits](docs/OUTLOOK_R6.md).

## R7: optional TLS IMAP read-only pilot

A third **server-configured, single-account IMAP reader** now uses the universal mailbox gateway. It requires private TLS IMAP configuration and a separate local unlock, with no browser mailbox passwords or PhiID linking. It is development-only and not a multi-user hosted service. See [R7 IMAP guide and safety limits](docs/IMAP_R7.md).

## R8: local account control center

The local Mail providers pilot now shows which of the independently authorized Gmail, Outlook and IMAP sessions are **configured versus connected**, with per-provider status and an explicit **Disconnect all local sessions** control. Mailbox reads are revalidated after asynchronous operations so revoked sessions cannot publish stale mail data. This is not a real PhiID mailbox association, a cross-device logout or remote provider token revocation. See the [R8 account center contract and safety notes](docs/LOCAL_ACCOUNTS_R8.md).

## R9: local provider-session safety gates

The experimental mailbox bridge now preserves active request limits across rate-window rollovers, applies a process-wide concurrency ceiling, and shares one token refresh among concurrent reads of the **same** Gmail or Outlook session. It also rejects explicit cross-origin and cross-site sensitive mailbox reads. No encrypted token vault or hosted multi-user service has been introduced. See [R9 threat model and verification](docs/SESSION_SAFETY_R9.md).

## R10: audited credential envelope foundation (NOT wired to live accounts)

A standalone server-only AES-256-GCM credential-envelope codec now supports per-record random keys/IVs, authenticated owner/provider binding, expiry, revision checks and key rotation through explicit rewrap. **No live OAuth or IMAP secrets are persisted or routed through it yet.** Identity verification, rollback-resistant transactional storage, trusted key custody and mailbox authorization remain separate prerequisites. See [R10 envelope, threat boundaries and tests](docs/CREDENTIAL_ENVELOPE_R10.md).

## Roadmap

- **Rung 1 | Client:** responsive, accessible demonstration and clearly labeled local actions.
- **Rung 2 | Bridge:** secure, server-side OAuth/Gmail, Microsoft Graph, and IMAP/SMTP adapters; true inbound/outbound mail, attachments, sync, strong HTML sanitization.
- **Rung 3 | Intelligence:** optional on-device PhiBot assistance with human approval for external actions; message portability and open formats.
- **Rung 4 | Sovereign:** optional mail hosting, MX/DNS configuration, SPF, DKIM, DMARC, TLS, abuse mitigation, reputation management, encrypted backups, observability.

## Philosophy

Interoperable. Portable. Transparent. Privacy-minded. Optional intelligence. No mandatory ecosystem lock-in.

MIT licensed. Part of [PhiOS](https://phi-field.com).
