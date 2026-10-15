import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pluginBackfillApi } from './api.js';

const REFRESH_MS = 15_000;
const hintStyle = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, overflowWrap: 'anywhere' };
const buttonStyle = { minHeight: 44, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, maxWidth: '100%', overflowWrap: 'anywhere' };

function eligibilityText(t, eligibility) {
  switch (eligibility.kind) {
    case 'ready': return t('pluginBackfill.ready');
    case 'skipped': return t(`pluginBackfill.reason.${eligibility.reason}`);
    default: throw new Error(`Unknown backfill eligibility: ${eligibility.kind}`);
  }
}

function runText(t, run) {
  switch (run.kind) {
    case 'idle': return t('pluginBackfill.idle');
    case 'running': return t('pluginBackfill.running');
    case 'completed': return t('pluginBackfill.completed');
    case 'stopped': return t('pluginBackfill.stopped');
    default: throw new Error(`Unknown backfill run: ${run.kind}`);
  }
}

function outcomeText(t, outcome) {
  switch (outcome.kind) {
    case 'started': return t('pluginBackfill.submitted');
    case 'already_running': return t('pluginBackfill.alreadyRunning');
    case 'skipped': return `${t('pluginBackfill.skipped')}: ${t(`pluginBackfill.reason.${outcome.reason}`)}`;
    case 'failed': return t('pluginBackfill.failed');
    default: throw new Error(`Unknown backfill outcome: ${outcome.kind}`);
  }
}

export default function PluginBackfillPanel({ onConfigure, activationKey }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [startError, setStartError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const command = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await pluginBackfillApi.status();
      if (mounted.current && mine === generation.current) {
        setSnapshot(next);
        setLoadError(null);
      }
    } catch (err) {
      if (mounted.current && mine === generation.current) setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, REFRESH_MS);
    };
    poll();
    return () => {
      active = false;
      mounted.current = false;
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [refresh, activationKey]);

  const start = async () => {
    if (command.current) return;
    command.current = true;
    setSubmitting(true);
    setStartError(null);
    setResults(null);
    try {
      const response = await pluginBackfillApi.start();
      if (mounted.current) setResults(response.results);
    } catch (err) {
      if (mounted.current) setStartError(err.message);
    } finally {
      if (mounted.current) await refresh();
      command.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const supported = snapshot?.plugins.filter(plugin => plugin.supported) ?? [];
  const active = supported.filter(plugin => plugin.activated);
  const hasAccounts = supported.some(plugin => plugin.accounts.length > 0);
  const hasReady = active.some(plugin => plugin.accounts.some(account => account.status.kind === 'available'
    && account.status.eligibility.kind === 'ready' && account.status.backfill.kind !== 'running'));
  const failedRead = active.some(plugin => plugin.accounts.some(account => account.status.kind === 'failed'));
  const disabled = submitting || !snapshot || Boolean(loadError) || (!hasReady && !failedRead);

  return (
    <section aria-label={t('pluginBackfill.title')} data-testid="plugin-backfill-panel" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20, minWidth: 0, overflowWrap: 'anywhere' }}>
      <h3 style={{ fontSize: 15, margin: '0 0 8px', color: 'var(--text-primary)' }}>{t('pluginBackfill.title')}</h3>
      <p style={hintStyle}>{t('pluginBackfill.description')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={start} disabled={disabled} style={{ ...buttonStyle, color: 'var(--accent)', opacity: disabled ? 0.5 : 1 }}>
          {t(submitting ? 'pluginBackfill.starting' : 'pluginBackfill.start')}
        </button>
        <button type="button" onClick={refresh} style={buttonStyle}>{t('pluginBackfill.refresh')}</button>
      </div>
      <p style={hintStyle}>{t('pluginBackfill.submissionHint')}</p>
      <p style={hintStyle}>{t('pluginBackfill.waitingHint')}</p>
      {loadError && <p role="alert" style={{ ...hintStyle, color: 'var(--red)' }}>{t('pluginBackfill.loadFailed', { error: loadError })}</p>}
      {startError && <p role="alert" style={{ ...hintStyle, color: 'var(--red)' }}>{t('pluginBackfill.startFailed', { error: startError })}</p>}
      {!snapshot && !loadError && <p style={hintStyle}>{t('common.loading')}</p>}
      {snapshot && !hasAccounts && <p style={hintStyle}>{t('pluginBackfill.noAccounts')}</p>}
      {snapshot && active.length === 0 && <p style={hintStyle}>{t('pluginBackfill.noEnabled')}</p>}
      {results && (
        <div role="status" data-testid="plugin-backfill-results" style={hintStyle}>
          {results.some(result => result.outcome.kind === 'failed') && <p role="alert" style={{ color: 'var(--red)' }}>{t('pluginBackfill.partialFailure')}</p>}
          <ul style={{ paddingInlineStart: 20 }}>
            {results.map(result => (
              <li key={`${result.pluginId}:${result.accountId}`}>
                {result.pluginName} · {result.emailAddress}: {outcomeText(t, result.outcome)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshot?.plugins.map(plugin => (
        <div key={plugin.id} data-testid={`backfill-plugin-${plugin.id}`} style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 12, paddingTop: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{plugin.name}</strong>
            <span style={hintStyle}>{t(plugin.activated ? 'pluginBackfill.activated' : 'pluginBackfill.inactive')}</span>
            {plugin.supported && plugin.activated && onConfigure && (
              <button type="button" onClick={() => onConfigure(plugin.id)} style={buttonStyle}>{t('pluginBackfill.configure')}</button>
            )}
          </div>
          {!plugin.supported ? <p style={hintStyle}>{t('pluginBackfill.unsupported')}</p> : (
            <ul style={{ ...hintStyle, paddingInlineStart: 20 }}>
              {plugin.accounts.map(account => (
                <li key={account.id} data-testid={`backfill-account-${plugin.id}-${account.id}`} style={{ marginTop: 8 }}>
                  <span>{account.emailAddress}: </span>
                  {account.status.kind === 'failed' ? (
                    <span role="alert" style={{ color: 'var(--red)' }}>{t('pluginBackfill.failed')}</span>
                  ) : (
                    <>
                      <span>{eligibilityText(t, account.status.eligibility)} · {runText(t, account.status.backfill)}</span>
                      {account.status.backfill.kind !== 'idle' && <div>{t('pluginBackfill.counts', account.status.backfill)}</div>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
