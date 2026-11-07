# Φ PhiMail R13 · Explicit local Outlook consent ceremony

**Status:** Development-only, single-browser, volatile memory and read-only **grant experiment**. The approved grant is real only inside the R11 in-process state machine. It is **not** enforced on live mailbox reads, is **not** a durable PhiID↔mailbox link, does **not** expand Microsoft permissions, and is **not** a hosted multi-user service.

## What changed

R11 introduced the one-time, bounded, independently verified grant state machine. R12 supplied live server-held **local** PhiID and Microsoft account evidence, but intentionally blocked all approvals. R13 connects these together with an **explicit two-step same-origin browser consent ceremony**. No browser can supply the issuer, verified identity subject, stable provider account ID, session markers, actual capabilities or provider tokens. The backend determines all of those from its own PhiID and Microsoft Graph sessions.

The new backend module is server/local-mailbox-consent.js. The local Field Connections panel now has an Outlook ownership approval lab with a clear read-only account review, a checkbox requiring an affirmative choice, and a revoke action.

## Operator walkthrough

1. Configure PHIMAIL_LOCAL_PHIID=1 and BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173 in a PRIVATE, gitignored .env.local. Configure the existing PhiID local Keycloak test realm and a Microsoft consumer-account app registration as described in R2 and R6. Keep all credentials off GitHub and out of public demos.
2. Start npm run bridge:dev and npm run dev separately. Use http://127.0.0.1:5173, not a tunnel, LAN URL, public deployment, or even a different localhost hostname.
3. Open Field Connections. Sign in to the independently verified local PhiID test identity and authorize a Microsoft Outlook personal account through the existing read-only OAuth+PKCE pilot.
4. Select **Review temporary read-only approval**. This creates a random one-time intent and separate challenge expiring in five minutes or sooner if either session expires.
5. Read the displayed stable Graph account ID and the two specific read-only scopes: read:inbox and read:message. Explicitly check the consent box, then **Approve once**. The server re-verifies BOTH current sessions and the original account ID before recording the grant.
6. The temporary approval lasts no more than 15 minutes, bounded by the remaining lifetime of each session. Use **Revoke this owner's local approvals** to end it immediately. Logout/disconnect also makes it unusable because each authorization re-verifies original session markers.

**What this does NOT mean:** The new grant cannot send, delete, modify or even make a new live mailbox read. The existing Outlook reader's independent OAuth session still controls live reads. Revoke local grant is NOT an OAuth token revocation, a PhiID logout, or deletion of a saved credential (none is saved by R13).

## Route contract (exact loopback only)

GET /api/identity/mailbox-consent returns current server-verified PhiID and Outlook state, including any still-valid temporary grant summary. It returns **no** provider access/refresh tokens, OIDC secrets, cookie values, raw session markers or encryption keys.

All mutations require the exact Origin http://127.0.0.1:5173, a specific X-PhiMail-Action header, ordinary same-origin browser fetch metadata, Content-Type application/json, no transfer/content encoding, and a tightly bounded JSON body (512 bytes). Any other Host, non-loopback peer, production configuration or extra query parameters is rejected.

- POST /api/identity/mailbox-consent/intent with X-PhiMail-Action: begin-mailbox-consent and exactly {schema:"phimail.local-mailbox-consent/v0.1",provider:"outlook",capabilities:["read:inbox","read:message"]}. No caller-specified email/subject/account ID/grant scope is accepted.
- POST /api/identity/mailbox-consent/approve with X-PhiMail-Action: approve-mailbox-consent and exactly {schema:"phimail.local-mailbox-consent/v0.1",intentId,challenge,acknowledged:true}. The R11 authority consumes the intent **before** any asynchronous approval proof. The R13 verifier checks matching issuer, subject, PhiID session marker, Microsoft consumer account ID, Microsoft session marker, challenge, both scopes and current expiry.
- POST /api/identity/mailbox-consent/revoke with X-PhiMail-Action: revoke-mailbox-consent and exactly {schema:"phimail.local-mailbox-consent/v0.1"}. It re-verifies the current PhiID owner before revoking that owner's in-memory grants. Other owners cannot revoke them.

R13 is not a token redemption endpoint. The grant ID stays server-side; no new live mailbox route accepts it as an authorization shortcut. The temporary status returned to React is a **non-bearer summary**.

## Critical limitations and threat model

- A browser checkbox and same-origin POST prove only that the authenticated browser session submitted the choice. It is **not a cryptographically attested human gesture** and does not defeat a compromised same-origin script, malicious extension, compromised process, or local malware. Production consent and threat modeling remain required.
- This experiment depends on the current OIDC and Microsoft OAuth test sessions. It performs a fresh bounded Microsoft Graph /me read when checking Outlook identity. Account mismatch, missing sessions and logout races fail closed.
- Gmail and IMAP owner binding are explicitly NOT implemented in R13. Gmail profile emailAddress or the IMAP username are not substitutes for a provider-verified stable account identity.
- There is no durable grant or credential store, key management system, revision database, recovery path, cross-device revocation, long-term audit trail or public tenant-isolation design. All R13 state disappears when the local bridge process exits.
- This temporary grant is not linked to the R10 AES-256-GCM envelope, and the envelope still has no persistence integration.
- The R3 Gmail review receipt remains separate and never authorizes R13.
- Existing OAuth and IMAP mailbox readers do **not** require these grants. They rely on their separate authorizations. So the words "temporary grant" apply to the new local R11 agreement test, NOT new live-mail access.
- Although the consent ceremony is explicit, actual production verified mailbox ownership and durable relationship management require additional provider verification, operational controls and independent security review.

## Verification

Run npm test and npm run build. The server/local-mailbox-consent.test.js suite uses a synthetic PhiID OIDC provider and synthetic Microsoft Graph+OAuth responses against the real local bridge handlers. Coverage includes: absent/independent sessions, exact provider identity, explicit challenge and scopes, replay after failed/duplicate approvals, cross-origin/host/CSRF rejection, unsupported Gmail/IMAP, swapped session/account, revocation and Outlook disconnect independence, no extra live mailbox permission, and a remote Graph verification delayed across a concurrent logout.

These tests do not represent a real provider smoke test or formal security review.

## Next safe rung

R14 should add a **final data-use authorization gate** for an explicitly opted-in mailbox linking experiment, with fresh provider/identity verification after asynchronous mailbox operations and immediate revoke enforcement, without changing the existing independent pilot's default behavior. Before any hosted/persistent integration, add a real audited consent record lifecycle, provider-specific ownership proofs, storage governance, KMS, key rotation and operational security review.

Security gates #4 and #8 remain open.
