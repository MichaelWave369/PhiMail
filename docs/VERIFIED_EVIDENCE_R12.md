# Φ PhiMail R12 · Local verified evidence adapters

**Status: local-development-only evidence resolvers, backed by existing server-held PhiID OIDC and Microsoft personal-account OAuth/Graph sessions. No real owner-to-mailbox grants are issued. No new HTTP or UI account-linking controls.**

R11 created a read-only, owner-to-mailbox grant state machine and required three independently trusted verifier functions. R12 implements the first TWO local evidence adapters, while deliberately keeping approval unavailable. This separates real server-verified proof from browser claims and makes future integration testing possible without falsely authorizing mail.

## What is actually implemented

server/local-grant-verifiers.js exports createLocalGrantVerifiers({env,identityLab,microsoftLab}).

- verifyIdentity(request): reads the ACTIVE OIDC-backed session from the existing createPhiIdLab instance. It requires the pinned phiid-dev issuer, an authenticated identity profile, non-empty validated subject, an unexpired session, and a new random internal sessionMarker. It returns {issuer,subject,sessionKey,expiresAt}, never the OIDC cookie, JWT or provider tokens. The marker is generated when the OIDC login succeeds and changes after a fresh session.
- verifyMailbox({request,provider:'outlook'}): delegates to the existing createMicrosoftLab instance. It requires a separately active server-held Microsoft personal-account session and re-fetches the Graph /me profile through the fixed, bounded Microsoft Graph client. It compares the returned Graph id to the ID saved during the original OAuth login, checks that the exact session remains active AFTER the asynchronous Graph request, and returns {provider:'outlook',accountId:'microsoft-consumers:'+verifiedGraphId,sessionKey,expiresAt}. Its random session marker is separate from the OAuth cookie and from the PhiID marker.
- verifyApproval(): ALWAYS raises MailboxGrantDenied. A valid identity, a Microsoft OAuth read session, two emails that match, an R3 review receipt, an R10 ciphertext or a user-supplied boolean is NOT the explicit R11 approval ceremony. Creating a real approval verifier remains R13 work.
- The entire adapter rejects requests outside the exact non-production http://127.0.0.1:5173 development origin. Existing lab Host+loopback checks remain enforced.
- No real credential values, email bodies or tokens enter the proof response. Graph /me must be reachable and authorized; inability to verify is a DENIAL, not a fallback to the cached email.

## Critical provider distinction

- Outlook personal Microsoft accounts: READY FOR LOCAL EVIDENCE TESTING ONLY. The stable Graph /me user id came from the prior OAuth-verified session, and a fresh Graph /me call confirms that ID for each new proof.
- Gmail: NOT ELIGIBLE FOR R11 ACCOUNT LINKING YET. The current Gmail pilot uses the Gmail profile emailAddress, which is not an independently verified stable Google OAuth subject. Do NOT promote an email string into a stable provider account id. A properly verified Google account subject and scope/audience verification must be added in a separate rung.
- IMAP: NOT ELIGIBLE FOR R11 ACCOUNT LINKING YET. A configured IMAP username, a TLS server or a successful local unlock by themselves cannot establish stable account identity and ownership. Do not infer mailbox ownership from the configuration's email address.

Both Gmail and IMAP still work as previously implemented in their **independent local read-only pilots**. This change only prevents them from being considered verified evidence for future R11 grant issuance.

## No new browser routes or permissions

There is no /api/grants, /api/identity/mailbox-grant or consent action in the real bridge. The new module is NOT imported by server/bridge.js and is not used to allow live mail reads. Existing Gmail/Outlook/IMAP mailbox sessions keep their original authorizations, independent of PhiID.

The test file server/local-grant-verifiers.test.js creates its own isolated Node HTTP harness to exercise the real PhiID/Microsoft lab handlers, OIDC login callback and OAuth callback with synthetic provider responses. Paths beginning /__test__/ in that file exist ONLY inside the test harness and are not available in the deployed or local PhiMail bridge.

## Verified boundaries

- Session claims cannot be supplied by client JSON; identity resolution uses the lab's internal lookupSession(request), not a browser-owned profile.
- Microsoft proof always checks Graph /me again. An account ID mismatch, expired or revoked local session, Graph error, duplicate session cookie or wrong loopback Host fails closed.
- Reconnecting the PhiID or Microsoft session generates new session markers, preventing a previous grant from being silently reused across a new login.
- The Graph asynchronous revocation test suspends the remote profile response, removes the local Microsoft session, then resumes Graph and verifies that the proof is refused.
- R11's approval verifier remains denied even if both separate evidence sources succeed and a new intent is created by the isolated test harness.

## Test and remaining gates

Run npm test && npm run build. Tests use synthetic OAuth/OIDC proof and a fake Microsoft Graph response, not real user accounts. **No real-world live provider smoke tests or security review have been completed.**

Before issuing real grants:

1. Implement an auditable, explicit same-origin, replay-resistant approval ceremony tied to both independently authorized sessions, the random intent, owner account, provider ID, and exact requested scopes.
2. Complete Gmail stable subject verification and design a defensible IMAP ownership verification strategy.
3. Integrate R11 authorization at the data-use boundary with the correct current verified sessions, including a fresh decision just before returning mail. No grants should outlive disconnection, provider session expiry or owner revocation.
4. Only after independent validation connect the R10 credential envelope to a tenant-scoped transactional store, KMS and authoritative revision management.
5. Threat-model, review and test security gates #4 and #8 before public hosting.

**R12 is real local evidence verification plumbing, not a finished or deployed PhiID-to-mailbox account linking feature.**
