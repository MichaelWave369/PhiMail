# PhiMail R2B — Optional PhiID OpenID Connect sign-in (localhost only)

This experimental bridge gives **PhiMail its own independent Keycloak OIDC relying-party session** against the `phiid-dev` realm, separate from PhiID's Account Center and separate from PhiMail's existing Gmail read-only OAuth pilot.

**Not production-ready.** No PhiMail account, hosted mailbox, account linking, mail permission, PhiCloud resource access or PhiOS device authority is issued. Do not expose the bridge on LAN/WAN or through a tunnel.

## What exists

- PhiMail's local Node bridge now optionally processes its own `/auth/phiid/start`, `/auth/phiid/callback`, `/api/phiid/session` and `POST /api/phiid/logout` routes.
- It is **disabled by default** and refuses production mode.
- Keycloak realm issuer is hard-pinned to `http://127.0.0.1:8080/realms/phiid-dev` and all discovery endpoints must match the fixed loopback realm paths.
- Client ID: `phimail-phiid-dev`. Exact registered callback: `http://localhost:5173/auth/phiid/callback`.
- Authorization code + PKCE S256, random state/nonce, server-held one-time flow, trusted library verification and subject-only in-memory session. Token material is discarded.
- The optional Field Connections panel shows **Verified local OIDC identity** separately from **unverified synthetic PhiID JSON**. Existing Gmail provider OAuth is independent.

### Security invariants

1. The valid identity pair is `(issuer, subject)` from verified ID Token claims, not a mutable email.
2. PhiMail's own OIDC cookie has a different name and path from its Gmail cookie and PhiID's cookie; no cross-app cookie or token is shared.
3. The OIDC profile reports `capabilities: []`, `mailbox_connected:false`, and `phios_authority:false`.
4. No PhiID email scope, Gmail token, mailbox access, PhiCloud scope or local PhiOS permission is acquired by this flow.
5. Login and session routes require a locally proxied `http://localhost:5173` Vite request and a loopback peer. The callback and scope are not user-configurable.
6. Sessions and flow state live in memory only. Restart and expiration remove them. PhiMail logout removes only its local OIDC session. Keycloak SSO remains and Gmail sessions are not affected.
7. GitHub Pages is a **static demo**. Its production bundle does not expose a sign-in form or live OIDC client.
8. The system is not a full account lifecycle, approval, identity-linking or token validation platform for remote resources.

## Local setup

**Prerequisites:** Node.js 22+, Docker Compose, localhost ports 8080, 8787 and 5173 available, and disposable test identities only.

1. In PhiID R3, run the localhost Keycloak stack from `dev/keycloak/compose.yaml`. Verify the realm contains both `phiid-bff-dev` and `phimail-phiid-dev`. Importing a realm does not update an existing realm, so add the PhiMail client in Keycloak Admin manually if the old realm already exists.
2. In **PhiMail** check out the R2B branch and create `.env.local` (gitignored). Include:

```dotenv
BRIDGE_PUBLIC_ORIGIN=http://localhost:5173
PHIMAIL_ENABLE_PHIID_DEV=1
```

3. In separate PhiMail terminals, run `npm install`, `npm run bridge:dev` and `npm run dev`.
4. Open **http://localhost:5173/** (use *localhost*, not 127.0.0.1, for the app URL), then open **Field Connections**.
5. Under **PhiID sign-in · localhost lab**, click **Sign in to local PhiID**. Keycloak shows the login for the disposable test user. On a successful callback PhiMail reopens Field Connections with a verified local profile.
6. Run `npm test` and `npm run build` as independent CI checks; they do not simulate a full Keycloak sign-in.

### Distinguishing the two accounts

PhiID Identity Center's local sign-in is at `http://127.0.0.1:8786/PhiID/`; PhiMail's is at `http://localhost:5173/`. They can validate the same subject after *separate* authorization-code flows. They maintain separate sessions and cannot infer each other's authorization.

The original **Inspect PhiID preview JSON** feature remains available, explicitly labeled **Not authenticated**. It is for schema interoperability only and must never become an authentication path.

### Negative tests

- With `PHIMAIL_ENABLE_PHIID_DEV` absent or `0`, PhiMail cannot start OIDC login.
- Requests with a forged Host, non-loopback peer or cross-site browser fetch are denied.
- Missing/incorrect callback state or an expired flow cannot create a verified session.
- Cross-origin session-logout requests are denied.
- Valid PhiID-only authentication does not create any Gmail session or grant mail permission.
- Production opt-in is rejected even if environment variable is accidentally set.

**Remaining manual verification:** start the actual Keycloak test realm, verify the redirect, complete login, then confirm independent PhiMail/PhiID logout behavior. Passing unit tests and a compiled site are not proof of this end-to-end result.

See [PhiID R3 dual-client contract](https://github.com/MichaelWave369/PhiID/blob/main/docs/R3_PHIMAIL_DUAL_CLIENT.md) after merge.
