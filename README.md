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

## Roadmap

- **Rung 1 | Client:** responsive, accessible demonstration and clearly labeled local actions.
- **Rung 2 | Bridge:** secure, server-side OAuth/Gmail, Microsoft Graph, and IMAP/SMTP adapters; true inbound/outbound mail, attachments, sync, strong HTML sanitization.
- **Rung 3 | Intelligence:** optional on-device PhiBot assistance with human approval for external actions; message portability and open formats.
- **Rung 4 | Sovereign:** optional mail hosting, MX/DNS configuration, SPF, DKIM, DMARC, TLS, abuse mitigation, reputation management, encrypted backups, observability.

## Philosophy

Interoperable. Portable. Transparent. Privacy-minded. Optional intelligence. No mandatory ecosystem lock-in.

MIT licensed. Part of [PhiOS](https://phi-field.com).
