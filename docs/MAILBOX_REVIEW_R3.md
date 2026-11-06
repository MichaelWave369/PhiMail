# Φ PhiMail R3: explicit local mailbox association review

**Status: localhost-only consent-to-review lab. No actual mailbox linking, ownership transfer, Gmail permission grant, or production SSO.**

This milestone lets a user inspect an independently verified PhiID identity and separately OAuth-authorized Gmail mailbox, then explicitly record that they reviewed the proposed pairing. Neither session automatically grants authority to the other.

## Trust and security boundaries

- Identity: a verified, server-held PhiMail OIDC session from the pinned PhiID Keycloak development realm. The subject is the validated issuer/subject pair, never a browser-supplied address.
- Mailbox: a separate Gmail OAuth read-only session. An email-address match is not proof of PhiID ownership.
- Both sessions must be active. The review POST sends only a constant version, the provider name gmail, and an explicit acknowledgment. The server derives the identity and Gmail address from its own sessions.
- The temporary server-side review is keyed to the identity session instance and Gmail session's random marker. It expires within 10 minutes or at either session expiry. A different identity session or Gmail reconnect cannot reuse the old review.
- The user can clear it. Gmail disconnect or PhiID logout makes it inapplicable, without creating a permanent record.
- Mutations require matching Origin plus a specific action header, exact JSON fields and limited request size. No client-supplied issuer, subject, account, scopes or permissions are accepted.
- Every response states account_linked:false, mailbox_access_granted:false, cloud_authorized:false. These flags never change upon recording a review.
- No new tokens, provider credentials or message content are stored. This prototype has no durable consent database, account association or authority.
- Only enabled on local 127.0.0.1:5173 development with PHIMAIL_LOCAL_PHIID=1; disabled in production and unavailable through GitHub Pages.

**Review receipt is not an access token, identity proof, OAuth grant or recovery artifact.**

## Developer walkthrough

1. Start the existing PhiID Keycloak realm on 127.0.0.1:8080 and confirm the separate phimail-bff-dev client, per the R2 local identity guide. Use a synthetic test user.
2. In PhiMail's gitignored .env.local, configure BRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:5173 and PHIMAIL_LOCAL_PHIID=1. To also test Gmail, configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET privately. The Google Cloud OAuth redirect must exactly match http://127.0.0.1:5173/auth/google/callback.
3. Run npm run bridge:dev and npm run dev in separate terminals.
4. Open http://127.0.0.1:5173, navigate to Field Connections, and sign into local PhiID.
5. Select Open Gmail read-only pilot and separately authorize Gmail, if using a Google test account.
6. Return to Field Connections. Verify the displayed test identity and Gmail address, tick the acknowledgment, and choose Record local review (no linking).
7. Use Clear review receipt, then independently try logout and Gmail disconnect. In either case the receipt must not authorize anything.

Google Gmail read-only is a restricted scope. This experimental code is not certified for public access. Do not expose local development ports to the LAN, internet, tunnels or production platforms.

## Local API contract

Fixed endpoint: /api/identity/mailbox-review

- GET: Report current identity and Gmail session presence, eligibility and any non-enforcing current review.
- POST: Requires both sessions; Origin exact match; X-PhiMail-Action: review-mailbox; application/json body containing exactly schema (phimail.local-mailbox-review/0.1), provider (gmail), acknowledged (true).
- DELETE: Requires verified identity, matching Origin and X-PhiMail-Action: clear-review; removes just the temporary review.

Every endpoint uses Cache-Control: no-store. A review never authorizes Gmail messages; /api/mail/messages continues to rely on the separate Gmail OAuth session.

## Verification and production blockers

npm test uses isolated mocked Google/Keycloak HTTP integrations to cover missing sessions, forged input, cross-session isolation, CSRF, Host checks, disconnect, logout, explicit acknowledgment, expiry boundaries and the non-authoritative result. Mocked tests do not prove a live Keycloak or Gmail deployment; an operator must run the end-to-end smoke test.

For actual PhiID-to-mailbox association, complete issues #4 and #8: HTTPS production identity, verified provider OAuth, durable encrypted token storage, resource authorization, per-user ownership, session revocation and a security assessment. PhiCloud R0 remains a declarative registry. Offline PhiOS remains independent.
