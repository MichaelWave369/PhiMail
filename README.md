# Φ PhiMail

**Sovereign communication for the PhiOS ecosystem.**

PhiMail is an open-source, provider-independent email client and a future path to self-hosted mail infrastructure. It will launch as a privacy-first web experience, then add authenticated email adapters and, later, optional sovereign hosting.

> **Current status:** initial scaffolding. No real mailbox connection, incoming synchronization, or email delivery is claimed yet.

## Principles

- **Interoperability:** email should still work with everyone outside PhiOS.
- **User control:** portable messages, optional local processing, no compulsory third-party AI.
- **Clear security boundaries:** do not expose mailbox secrets to static browser hosting.
- **No fake sending:** demo actions stay local and are clearly identified.
- **Human approval:** any automated drafting or sending must require explicit authorization.
- **Accessible by default:** keyboard-friendly, responsive, reduced-motion friendly.

## Roadmap

1. Browser-based local demo: inbox, message detail, search, labels, composing, drafts, import/export.
2. Real account providers: secure OAuth flows for Gmail and Microsoft accounts, and standards-based IMAP/SMTP through a trusted backend.
3. PhiOS integration, optional local PhiBot assistance, offline sync and migration tools.
4. Self-hosted delivery: MX, SPF, DKIM, DMARC, MTA-STS, monitoring, antispam, backups, abuse controls.

## Development

The first app and build instructions are being prepared as a feature pull request.

**License:** MIT (planned).

Part of [PhiOS](https://phi-field.com).
