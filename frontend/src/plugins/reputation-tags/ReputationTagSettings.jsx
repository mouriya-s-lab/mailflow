import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reputationTagsApi } from './api.js';

export const STATUS_REFRESH_MS = 15_000;
const cardStyle = { border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-secondary)' };
const hintStyle = { fontSize: 12, color: 'var(--text-tertiary)', margin: '6px 0 10px' };
const buttonStyle = { padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 };

function sourceText(t, source) {
  switch (source) {
    case 'enabled': return t('reputationTags.configured');
    case 'unconfigured': return t('reputationTags.unconfigured');
    case 'disabled': return t('reputationTags.disabled');
    default: throw new Error(`Unknown reputation source state: ${source}`);
  }
}

function backfillText(t, run) {
  switch (run.kind) {
    case 'idle': return t('reputationTags.idle');
    case 'running': return t('reputationTags.running', { time: new Date(run.startedAt).toLocaleString() });
    case 'completed': return t('reputationTags.completed', { time: new Date(run.finishedAt).toLocaleString() });
    case 'stopped': return t('reputationTags.stopped', { time: new Date(run.stoppedAt).toLocaleString() });
    default: throw new Error(`Unknown reputation backfill state: ${run.kind}`);
  }
}

function AccountBackfill({ pluginId, account, refresh, sourceReady, onError }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const running = account.backfill.kind === 'running';
  const action = async () => {
    setBusy(true);
    onError(null);
    try {
      if (running) await reputationTagsApi.stopBackfill(pluginId, account.id);
      else await reputationTagsApi.startBackfill(pluginId, account.id);
    } catch (err) {
      if (err.status === 409) onError(t(running ? 'reputationTags.stopConflict' : 'reputationTags.startConflict'));
      else if (err.status === 404) onError(t('reputationTags.accountNotFound'));
      else onError(t('reputationTags.actionFailed', { error: err.message }));
    } finally {
      // Even a conflict means another request changed the run; only status is authoritative.
      await refresh();
      setBusy(false);
    }
  };
  const disabled = busy || (!running && !sourceReady);
  return (
    <div style={cardStyle} data-testid={`tag-account-${account.id}`}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{account.emailAddress}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span data-testid="tag-backfill" style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>{backfillText(t, account.backfill)}</span>
        <button type="button" disabled={disabled} onClick={action} style={{ ...buttonStyle, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
          {t(running ? 'reputationTags.stop' : 'reputationTags.start')}
        </button>
      </div>
      {account.backfill.kind !== 'idle' && (
        <p data-testid="tag-counts" style={hintStyle}>{t('reputationTags.counts', {
          marked: account.backfill.marked, processed: account.backfill.processed, failed: account.backfill.failed,
        })}</p>
      )}
    </div>
  );
}

export default function ReputationTagSettings({ pluginId, name, initialSubTab }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const generation = useRef(0);
  const sectionRef = useRef(null);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await reputationTagsApi.getStatus(pluginId);
      if (mine === generation.current) { setStatus(next); setError(null); }
    } catch (err) {
      if (mine === generation.current) setError(err.message);
    }
  }, [pluginId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => { clearInterval(timer); generation.current += 1; };
  }, [refresh]);
  const loaded = status !== null;
  useEffect(() => {
    if (loaded && initialSubTab === pluginId) sectionRef.current.scrollIntoView({ block: 'start' });
  }, [initialSubTab, pluginId, loaded]);

  return (
    <section ref={sectionRef} data-testid={`settings-${pluginId}`}>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '24px 0 20px' }} />
      <h3 style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 6px' }}>{name}</h3>
      <p style={hintStyle}>{t('reputationTags.description')}</p>
      <button type="button" onClick={refresh} style={buttonStyle}>{t('reputationTags.refresh')}</button>
      {error && <p role="alert" style={{ ...hintStyle, color: 'var(--red)' }}>{t('reputationTags.refreshFailed', { error })}</p>}
      {actionError && <p role="alert" style={{ ...hintStyle, color: 'var(--red)' }}>{actionError}</p>}
      {status ? (
        <>
          <p data-testid="tag-source" style={{ fontSize: 13, color: status.source === 'enabled' ? 'var(--green)' : 'var(--text-secondary)' }}>{sourceText(t, status.source)}</p>
          <p style={hintStyle}>{t('reputationTags.stopHint')}</p>
          {status.accounts.length === 0 ? <p style={hintStyle}>{t('reputationTags.noAccounts')}</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {status.accounts.map(account => (
                <AccountBackfill key={account.id} pluginId={pluginId} account={account} refresh={refresh} sourceReady={status.activated && status.source === 'enabled'} onError={setActionError} />
              ))}
            </div>
          )}
        </>
      ) : !error && <p style={hintStyle}>{t('common.loading')}</p>}
    </section>
  );
}
