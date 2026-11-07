# Φ PhiMail R11 · Verified-context mailbox grant contract

**Status: isolated server-only authorization contract and adversarial tests. NO live linking, real consent attestation, token persistence, HTTP grant endpoint, or hosted multi-user service.**

## Why

PhiID authenticates an identity. Gmail, Outlook and IMAP have separate read-only mailbox sessions. **Neither one grants permission to permanently associate the other.** The R3 review is deliberately non-authoritative. The R10 encryption envelope authenticates data context, but does not prove the context is trustworthy. R11 defines and tests an explicit owner-to-mailbox grant process while waiting for independently audited verification adapters.

## Trusted verification interfaces

The new server/mailbox-grants.js module exports createMailboxGrantAuthority and schemas phimail.mailbox-intent/v0.1 and phimail.mailbox-grant/v0.1.

A trusted caller MUST inject all three independent verifiers:

1. verifyIdentity(evidence) returns {issuer,subject,sessionKey,expiresAt} after checking a real current OIDC-backed session. Browser profiles are not evidence.
2. verifyMailbox(evidence) returns {provider,accountId,sessionKey,expiresAt} only after checking a separate provider-authorized mailbox session. accountId must be a provider-verified stable account identifier, NOT a browser-provided email or assumed-immutable mailbox address.
3. verifyApproval(evidence,immutableIntent) returns an attested one-time user approval covering exact intentId/challenge, identity issuer+subject+session, provider+account ID+session, full scope and approval time. Echoing request data or returning a Boolean is forbidden.

**Those three production-grade verifier implementations are not included in R11.** Tests use fake trusted-verifier doubles. There is no new HTTP route, frontend grant button or mailbox bridge integration.

## State transitions

### Begin

- Requires independently verified identity and mailbox sessions and explicit requested capabilities.
- Allows only read:inbox and read:message, without duplicates, sending, modification or deletion.
- Generates two independent random 256-bit values for a one-time intent ID and approval challenge.
- Intent expires in five minutes or sooner at either session's expiry.
- Returns an intent summary, which is NOT a mailbox permission.

### Approve

- Consumes the intent **before** awaiting the independent approval verifier, blocking concurrent replay.
- Requires verified proof of the matching nonce, identity, session markers, provider account, exact scopes and valid approval timestamp.
- A failed approval burns the one-time intent; new approval requires a new intent.
- Creates an in-memory grant with a maximum 15-minute lifetime, capped by both independent session expiries. Grant ID alone is never bearer authorization.

### Authorize

- For each requested read operation, re-verifies both identity and the exact mailbox session.
- Checks current grant, provider account, issuer+subject, original session markers, scope and expiry.
- Rechecks revocation after awaiting asynchronous verifiers, so a grant revoked mid-verification cannot authorize.
- Returns only a short context-specific authorization decision with the verified owner/mailbox binding and capability, never secrets or message data.
- The service that actually reads/returns mailbox contents must check authorization again at the **final data-use boundary**. A prior positive decision is not a transaction lock.

### Revoke

- A freshly verified owner can revoke one or all their grants even after a new identity login, provided issuer and subject match.
- Other owners/issuers cannot revoke those grants. Reconnection cannot reuse an existing grant because authorize still requires the original identity/mailbox sessions.
- Revocation destroys only the temporary grant records. It does not revoke OAuth access at Google/Microsoft, reset IMAP app passwords, remove encrypted vault records (none exist), disconnect PhiID, or terminate other browsers' provider sessions.
- Destroy invalidates all pending and active grants for the process-local authority.

## Security limitations

- No storage, KMS, cross-device grant status, audit log, external security assessment, true multi-user tenancy, or independent provider account ownership verifier.
- No new HTTP endpoint; existing local provider access is not extended or authorized by these unused contracts.
- R3 review receipts, matching emails, PhiID login alone, provider OAuth alone and knowledge of the grant ID never count as grants.
- Provider session keys must be generated and proven by the trusted backend, never client-selected; account identifiers must be resolved by the provider verification layer.
- Defaults cap state at 64 pending intents and 128 active grants. Process restart loses them.
- A compromised trusted verifier can authorize a false binding. Security depends on verifier independence and provenance, which R11 does NOT claim to implement.

## Verification

The new server/mailbox-grants.test.js covers missing verifier functions; forged input; absent sessions; non-authoritative R3 review; one-time challenge, replay and concurrent approvals; scope narrowing; issuer/account/provider/session substitutions; expiry; revocation by owner only; revocation during in-flight verification; resource caps; and destruction.

Run npm test && npm run build. The tests simulate trusted identity, mailbox and explicit approval evidence, never contact a real provider or accept live credentials.

## Next safe implementation

1. Build independently verified identity and provider-account ID resolvers, including a careful IMAP ownership proof. A text email address alone is not a stable universal provider ID.
2. Add an explicit anti-CSRF, anti-replay approval ceremony bound to current PhiID and provider sessions. Do not repurpose R3's non-authoritative review receipt.
3. Only then combine R11 checks with R10 encryption, a transactional tenant-scoped record store, independently protected key management, authoritative revision checks, grants with revocation, and final-response authorization.
4. Commission an independent security review before hosting mail or creating durable mailbox credentials.

PhiMail issues #4 and #8 remain security gates, not checkboxes waived by this PR.
