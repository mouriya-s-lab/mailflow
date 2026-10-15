import { request } from '../../src/utils/api.js';

/**
 * @typedef {'all'|'checked'|'not_checked'|'unrecognized'|'spam'|'ham'|'uncertain'|'pending'|'retry'|'failed'|'disabled'|'registered'|'new_domain'|'not_found'|'unknown'|'no_links'|'listed'|'not_listed'} StoredResultFacet
 * @typedef {{id:string, emailAddress:string}} ResultAccount
 * @typedef {{facet:StoredResultFacet, count:number}} ResultCount
 * @typedef {{kind:'known',registeredAt:string}|{kind:'not_found'}|{kind:'unknown',reason:string}} StoredRegistration
 * @typedef {{kind:'listed',detail:string}|{kind:'not_listed'}|{kind:'unknown',reason:string}} StoredListing
 * @typedef {{kind:'pending'}|{kind:'retry',attempts:number,errorKind:string,dueAt:string}|{kind:'done',outcome:'spam'|'ham'|'uncertain',probability:number,model:string,decidedAt:string}|{kind:'skipped',reason:'disabled'}|{kind:'terminal_failed',errorKind:string}} StoredSpamDecision
 * @typedef {{kind:'blocked'}|{kind:'below_threshold'}|{kind:'no_message_id'}|{kind:'pending'|'recorded'|'duplicate'|'terminal_failed',label:'spam'|'ham'}|{kind:'retry',label:'spam'|'ham',attempts:number,dueAt:string}|{kind:'skipped',reason:'decision_failed'|'disabled'}|{kind:'unrecognized'}} StoredSpamTraining
 * @typedef {{kind:'none',revision:number|null}|{kind:'unrecognized',revision:number|null}|{kind:'jev_spam',revision:number|null,decision:StoredSpamDecision,training:StoredSpamTraining}|{kind:'rdap',revision:number|null,checkedAt:string,subjects:Array<{domain:string,registration:StoredRegistration}>}|{kind:'listing',revision:number|null,source:'spamhaus_dbl'|'urlhaus'|'safe_browsing',checkedAt:string,subjects:Array<{kind:'domain',domain:string,verdict:StoredListing}|{kind:'url_digest',urlDigest:string,host:string,verdict:StoredListing}>}} StoredObservation
 * @typedef {{id:string,accountId:string,accountEmail:string,folder:string,uid:number,subject:string|null,fromName:string|null,fromEmail:string|null,date:string|null,facets:StoredResultFacet[],observation:StoredObservation}} StoredResultMessage
 * @typedef {{kind:'jev_spam',id:string,activated:boolean,configuration:'enabled'|'unconfigured',hamAtMost:number,spamAtLeast:number}|{kind:'rdap',id:string,source:'rdap',activated:boolean,configuration:'enabled'|'unconfigured'|'disabled',newDomainMaxAgeMs:number}|{kind:'listing',id:string,source:'spamhaus_dbl'|'urlhaus'|'safe_browsing',activated:boolean,configuration:'enabled'|'unconfigured'}} StoredResultPlugin
 * @typedef {{observedAt:string,plugin:StoredResultPlugin,accounts:ResultAccount[],counts:ResultCount[],messages:StoredResultMessage[],nextCursor:string|null}} StoredResultPage
 * @typedef {{observedAt:string,plugin:StoredResultPlugin,message:StoredResultMessage}} StoredResultDetail
 */

const pluginPath = pluginId => {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)) throw new TypeError('invalid plugin id');
  return `/${encodeURIComponent(pluginId)}/results`;
};

/** @returns {Promise<StoredResultPage>} */
export function getStoredResults(pluginId, { accountId = null, facet = 'all', cursor = null, limit = 50 } = {}) {
  const params = new URLSearchParams({ facet, limit: String(limit) });
  if (accountId) params.set('accountId', accountId);
  if (cursor) params.set('cursor', cursor);
  return request('GET', `${pluginPath(pluginId)}?${params}`);
}

/** @returns {Promise<StoredResultDetail>} */
export function getStoredResult(pluginId, messageId) {
  return request('GET', `${pluginPath(pluginId)}/${encodeURIComponent(messageId)}`);
}
