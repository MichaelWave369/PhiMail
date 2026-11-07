# Φ PhiMail R10: credential envelope foundation

**Status: standalone cryptographic primitive + adversarial unit tests. NOT active credential storage. NOT production readiness.** The live Gmail/Microsoft OAuth sessions remain in volatile Node RAM as before. The existing IMAP app credential still comes from the developer's private environment. No disk writes, token export, vault APIs, production key service, or provider account linking are introduced by R10.

## Problem being solved

Before we eventually introduce encrypted durable credentials for PhiMail, the service will need to encrypt values **for the correct authenticated owner and independently authorized mailbox**. Merely encrypting a JSON token is insufficient: an attacker with database access may swap ciphertext between users, replace a current record with an older valid one, or provide an unaudited "owner" field from the browser.

This rung delivers a strict, testable cryptography codec while deliberately leaving **identity proof, authorization, key custody, persistence, and rollback-resistant revision storage** to an explicit future integration gate.

## Module

`server/credential-envelope.js`

- `createCredentialEnvelopeCodec({keys,activeKeyId,now})` requires a trusted `Map` of 32-byte keys (max 16 permitted). There is NO key material in GitHub, no hard-coded fallback, no password-based key derivation, and no automatic process.env input.
- `seal({binding,credential,revision,expiresAt})` encrypts a narrowly validated OAuth credential or IMAP app credential using a random 32-byte salt, HKDF-SHA256 per-record key, fresh 12-byte nonce, and AES-256-GCM with a 16-byte tag.
- `open({binding,envelope,expectedRevision})` rejects unknown key IDs, expiry, schema or metadata tampering, cross-account context changes, malformed ciphertext, invalid canonical encoding, and unexpected credential types. Provider tokens are never returned except to an explicitly calling trusted server module.
- `rewrap({binding,envelope,expectedRevision,nextRevision,expiresAt})` allows future migration between trusted key IDs by decrypting an authorized record and re-encrypting under the active key with an INCREASED revision and fresh random salt/nonce.
- `destroy()` wipes the codec's private key copies and prevents further seal/open/rewrap operations. It intentionally cannot wipe the input keys owned by the host, provider tokens already in memory, garbage-collected JS strings, or OS memory snapshots.

The binary envelope has the version `phimail.credential-envelope/v1` and carries key ID, record revision, expiry, salt, IV, ciphertext, and authentication tag. It does NOT expose tokens, mailbox credentials, or identity values in its fields.

## Authenticated context (AAD)

The trusted caller must provide the following binding for EACH record:

```text
owner.issuer       = verified PhiID issuer, NOT an untrusted browser string
owner.subject      = verified local identity subject, NOT a localStorage profile
mailbox.provider   = gmail | outlook | imap
mailbox.accountId  = provider-verified stable account ID, NOT a user-typed email
revision           = externally authoritative record version (integer >= 1)
expiresAt          = server-enforced envelope expiry
```

All values are authenticated as AES-GCM Additional Authenticated Data. The codec **validates their shape but does not verify their truth**, issue mailbox permissions, record consent, check identity sessions or construct a durable storage record. The planned integration service MUST verify owner identity separately, verify the provider account through independently authorized provider APIs, secure explicit grants and recheck authorization before decrypting or using any secret.

**Important:** An attacker who can supply a *false but consistent* owner binding could still use this codec. Use it only within a trusted, authorization-enforcing service. It must NEVER be exported to React, used to infer permanent PhiID association, or wired to generic user-selected decrypt endpoints.

## Rollback resistance is NOT supplied by crypto alone

An old GCM-authenticated envelope can still decrypt with the old revision if the caller supplies that old revision. To stop replay, a future transactional record store must preserve the **latest committed revision independently and authoritatively**, bind every write to it using compare-and-swap, and reject older revisions. A browser-owned or same-record untrusted "current revision" does NOT satisfy this requirement.

R10's open function requires the caller's `expectedRevision` and validates it against the envelope's authenticated revision. This is a useful prerequisite, not complete rollback protection.

## Key custody and rotation limitations

No persistent key loader or Key Management Service is built yet. A host supplying `keys` must protect the keys independently; the codec internally copies them and derives per-record keys using HKDF. Future production hosting must use a vetted KMS/HSM, well-scoped tenant keys, rotation/retirement policy, audit events, recovery/backup controls, and emergency revocation. Client-selected key IDs are prohibited.

A key rotation changes only the cryptographic wrapping. It does **not** revoke an OAuth access/refresh token at Google or Microsoft, reset an IMAP app password, or invalidate another process's previously decrypted copy.

## Security gates still unimplemented

- No permanent verified PhiID ↔ provider-mailbox grant/association, no provider ownership proof beyond existing local OAuth/API pilots, and no durable consent authority.
- No tenant isolation in a database, no credential persistence, no transactional sequence/revision store, no KMS, no encrypted recovery key management, no production lifecycle events, no logging or audit system, and no out-of-band threat-model review.
- No guarantees against a compromised trusted process, a stolen master key, a dishonest application administrator, a compromised runtime, secret values embedded in JS strings, database replay without trusted versioning, or provider consent revocation delayed outside the service.
- No permanent email account creation, sending, public login, or cloud mail hosting.

## Test coverage

`server/credential-envelope.test.js` exercises encryption round-trips for mock OAuth and IMAP credentials, tamper rejection for every encrypted field, changed identity and mailbox AAD rejection, nonce uniqueness, expiry, strong key requirements, key rotation and rewrap, rollback mismatch, malformed input, oversized credentials, unknown fields, and destruction behavior.

Run `npm test` and `npm run build`. Tests use synthetic secrets and random in-memory keys; none reach the filesystem or external providers. Security audit and live-provider smoke testing remain separate.

## Next safe integration milestone

1. Define an **owner/mailbox grant verifier** with issuer/subject and provider-verified account ID, an explicit expiring approval, lifecycle state, and revocation. PhiID authentication is necessary for an account owner but never sufficient to read any arbitrary mailbox.
2. Define a transactional, tenant-scoped credential record repository with authoritative compare-and-swap revision and an isolated key service; integrate R10 codec only after its security review.
3. Add audited local-only smoke tests for rekey, expired grants, owner disconnect/reconnect, mailbox swap, rollback attempt, crash recovery, provider revocation and restore.
4. Only then evaluate production hosting, after independent security analysis.

For context, see R8 local account control, R9 session hardening, PhiMail issue #4 (security gates), and issue #8 (mailbox association).
