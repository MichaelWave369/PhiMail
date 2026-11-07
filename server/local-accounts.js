/**
 * PhiMail R8: authoritative *local session* inventory.
 *
 * This is intentionally distinct from PhiID identity, mailbox association,
 * external provider token revocation and production tenancy. Never serialize
 * session objects, provider tokens, cookies or IMAP server configuration.
 */
export const LOCAL_ACCOUNTS_SCHEMA='phimail.local-accounts/0.1';
const AUTH_KIND=Object.freeze({
  gmail:'google_oauth',
  outlook:'microsoft_oauth',
  imap:'local_unlock'
});

export function localAccountSnapshot(catalog,sessionFor){
  if(!Array.isArray(catalog) || typeof sessionFor!=='function')throw new TypeError('Local account inventory needs a provider catalog and session lookup');
  const accounts=catalog.map(item=>{
    if(!item || typeof item.id!=='string'||!Object.hasOwn(AUTH_KIND,item.id)){
      throw new TypeError('Invalid provider catalog');
    }
    const session=sessionFor(item.id);
    const expires=Number(session?.expires);
    const connected=Boolean(session && session.provider===item.id &&
      typeof session.email==='string' && session.email.length>0 &&
      Number.isFinite(expires) && expires>Date.now());
    return {
      provider:item.id,
      name:item.name,
      configured:item.ready===true,
      connected,
      email:connected?session.email:null,
      authorization:AUTH_KIND[item.id],
      capabilities:connected?['read:inbox','read:message']:[],
      expires_at:connected?new Date(expires).toISOString():null,
      live_provider_health_checked:false
    };
  });
  return {
    schema:LOCAL_ACCOUNTS_SCHEMA,
    environment:'local_development_only',
    accounts,
    connected_count:accounts.filter(item=>item.connected).length,
    phiid_identity_linked:false,
    phicloud_authorized:false,
    remote_provider_tokens_revoked:false,
    persistent_credentials_created:false,
    hosted_multiuser_mailbox:false,
  };
}
