# Φ PhiMail R2: Local PhiID OpenID Connect sign-in

**Status: experimental LOCAL-ONLY verified login. Not public SSO, account linking, cloud authorization, or mailbox permission.**

PhiID's local Keycloak realm can now serve as one common identity provider for two **independent** relying parties:

- PhiID Account Center: client phiid-bff-dev, callback http://127.0.0.1:8786/auth/callback
- PhiMail: client phimail-bff-dev, callback http://127.0.0.1:5173/auth/phiid/callback

Each client performs its own authorization-code + PKCE S256 login with random state and nonce. Both are verified by the audited openid-client library. The OIDC issuer is hard-coded to http://127.0.0.1:8080/realms/phiid-dev, and the callback is pinned to 127.0.0.1:5173. **A cookie from PhiID is not trusted by PhiMail.** An exported JSON preview is never used as an auth proof.

## Local development setup

1. Bring up the PhiID Keycloak realm following PhiID's docs/R1_LOCAL_IDENTITY_LAB.md. Use only a synthetic test account.
2. In Keycloak Admin UI, ensure a SECOND public OIDC client named phimail-bff-dev exists. Its settings are pinned in the PhiID realm import (see PhiID companion PR). Configure:
   - Standard authorization code flow enabled, PKCE S256 enforced.
   - Valid redirect URI: http://127.0.0.1:5173/auth/phiid/callback (exact match).
   - Web origins empty, no implicit flow, no direct password grant, no service accounts.
   - Token endpoint authentication method none (public client).
   - If the realm already existed before this change, update/create the client **manually in Keycloak Admin**; importing the changed JSON into a running realm will NOT automatically update it.
3. In PhiMail checkout, run npm install and create gitignored .env.local using .env.example, with:
   - BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173
   - PHIMAIL_LOCAL_PHIID=1
   - No Gmail credentials are needed just to test PhiID.
4. Terminal A: npm run bridge:dev
5. Terminal B: npm run dev
6. Navigate to http://127.0.0.1:5173. Open Field Connections → PhiID via Keycloak → Sign in via local PhiID realm.
7. Complete Keycloak's developer test-user login. PhiMail returns and displays a verified **local development** identity profile.

The local PhiID server on port 8786 is **not required** for PhiMail's own login. Both use the same Keycloak development issuer, but each operates as an independent relying party. Keycloak's existing SSO cookie may prepopulate its login step. Logging out of PhiMail ends only PhiMail's session, **not** Keycloak or PhiID's own session.

## Trust boundaries

- Verified identity is derived from an actual provider-signed ID token validated by openid-client with issuer, client audience, state, nonce, PKCE, and expiry; tokens are immediately discarded.
- Server stores only a minimal verified profile in an in-memory, 15-minute, HttpOnly, SameSite=Lax cookie-bound session. No ID/access tokens, client secrets or passwords enter React/localStorage.
- This session proves an authenticated **local test identity only**. No PhiCloud scopes, resource access, mailbox account linking, Gmail access or PhiOS effect authority follows from it.
- Existing experimental Gmail OAuth sessions remain completely separate. Connecting Gmail does not attach it to a PhiID subject.
- No shared browser auth cookie, imported JSON, unsigned header, or arbitrary user-supplied claims are accepted as identity.
- The bridge and Vite frontend must bind only to loopback. The hard-coded HTTP issuer and Keycloak start-dev are expressly unsafe for LAN/public hosting; do not port-forward, tunnel, expose on Netlify or host on production PhiCloud.
- The GitHub Pages production build never offers the sign-in action, and the backend refuses the local OIDC pilot if NODE_ENV=production.
- Real SSO, subject-to-mailbox association, resource authorization, session revocation/rotation, multi-tenant isolation, audit and security assessment remain blocked by a separate production gate.

## Tests

npm test runs mocking tests for one-time OAuth state, callback replay, host mismatch, verified local session shape, logout CSRF boundaries, untrusted authorization redirection, and the fact that identity cookies alone **cannot** authorize Gmail access. These tests do not contact Keycloak or prove end-to-end live OIDC. Operator manual smoke testing remains necessary.

## Future PhiCloud integration

PhiCloud may eventually host the common OIDC provider and enforce resource authorization, but its current R0 service registry is **declarative** and cannot be used as a token authority. Use real OIDC validation by each resource service and the signed, audience-limited access-token approach in the PhiID and PhiCloud contracts.

See also PhiMail issue #4 and PhiCloud docs/PHIID_PHIMAIL_IDENTITY.md.
