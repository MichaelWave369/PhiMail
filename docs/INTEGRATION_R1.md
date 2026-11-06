# Φ Field Connections R1: PhiID, PhiMail, and PhiCloud

This milestone provides two real, **read-only contract adapters**, not sign-in or service authentication.

| Producer | Version | PhiMail consumer action | Never implies |
| --- | --- | --- | --- |
| PhiID synthetic export | phi-account/0.1 | Validate a chosen local JSON file and show untrusted account metadata | Login, account ownership, credentials, authorization |
| PhiCloud registry | phicloud.services.v0.1 | Retrieve the local registry's declared service inventory through a fixed development proxy | Individual service health, account linking, reachability or permissions |

## PhiID demo export inspection

1. Open the PhiID R0 Account Center preview and export synthetic account JSON.
2. In PhiMail, open **Field Connections** in the sidebar.
3. Select **Inspect PhiID preview JSON**.
4. The inspected display name, issuer and subject are explicitly **unverified**.

Only the known preview wrapper is accepted. The adapter rejects extra fields, unknown schema versions and claims that a preview is an authentic identity proof. PhiMail never treats imported metadata as a credential. Data stays in React component memory and is cleared when the panel is closed.

A future real PhiID account must be established through an audited OpenID Connect relying party. A backend must validate token signatures, issuer, audience, expiry and user-binding, with explicit account-link consent. A profile export is never an authentication input.

## PhiCloud local registry inspection

1. In the PhiCloud repository, run: python -m phicloud.server --port 8769
2. In the PhiMail repository, run: npm run dev
3. Open Field Connections and click **Read local PhiCloud registry**.

Only the local Vite dev server proxies /field-registry/v1/services to 127.0.0.1:8769/v1/services. The browser does not contact URLs from endpoint_hint; the adapter discards these hints entirely. The **production GitHub Pages build never offers the registry-fetch action.**

A successful fetch only establishes that the registry responded with a valid declarative inventory. PhiCloud's R0 /healthz reports registry-process health, not health of the services listed. This panel performs **no** service reachability checks.

## Strong separation of trust

- PhiID authenticates remote accounts eventually. Only a cryptographically verified pair (iss, sub) becomes a durable principal.
- PhiCloud services authorize their own resource access through independently validated identity, audience and scopes.
- PhiMail provides email experiences and provider adapters. Gmail's experimental OAuth session is not PhiID SSO.
- PhiOS local effects remain subject to local permission checks. Remote sign-in never grants computer-level authority.
- User's existing offline PhiOS and PhiMail demo workflows keep working without any remote identity or cloud service.
- No real linking, storage of imported identities, cross-app tokens, permission grants or external endpoints are introduced.

## Safety and tests

Run npm test and npm run build. Tests cover canonical compatibility, malformed wrappers, forged authentication claims, extra fields, bad versions, unsafe endpoint hints, duplicate entries, unverified service health, fixed URL requests and bounded response sizes.

This R1 design intentionally avoids writing a custom identity system or exposing a local service registry to the internet.

Related references: [PhiID identity contract](https://github.com/MichaelWave369/PhiID/blob/main/docs/IDENTITY_CONTRACT.md) and [PhiCloud identity contract](https://github.com/MichaelWave369/PhiCloud/blob/main/docs/PHIID_PHIMAIL_IDENTITY.md).
