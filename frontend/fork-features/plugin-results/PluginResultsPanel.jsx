import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../../src/hooks/useMobile.js';
import { getStoredResults } from './api.js';
import { openStoredResultMessage } from './navigation.js';
import StoredObservation from './StoredObservation.jsx';

const PAGE_LIMIT = 50;

const buttonStyle = (disabled = false) => ({
  padding: '6px 10px',
  minHeight: 44,
  maxWidth: '100%',
  overflowWrap: 'anywhere',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.55 : 1,
});

const primaryButtonStyle = (disabled = false) => ({
  ...buttonStyle(disabled),
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: 'var(--accent-text, #fff)',
});

const selectStyle = {
  minWidth: 0,
  maxWidth: '100%',
  padding: '7px 9px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  fontSize: 16,
  minHeight: 44,
};

const formatDate = value => (value ? new Date(value).toLocaleString() : '');

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '';
}

function isNotFound(error) {
  return error?.status === 404;
}

function statusKeys(plugin) {
  if (!plugin) return [];
  const activation = plugin.activated ? 'active' : 'inactive';
  switch (plugin.kind) {
    case 'jev_spam':
      switch (plugin.configuration) {
        case 'enabled':
          return [activation, 'configured'];
        case 'unconfigured':
          return [activation, 'unconfigured'];
        default:
          throw new Error(`Unknown stored-results configuration: ${plugin.configuration}`);
      }
    case 'rdap':
    case 'listing':
      switch (plugin.configuration) {
        case 'enabled':
          return [activation, 'configured'];
        case 'unconfigured':
          return [activation, 'unconfigured'];
        case 'disabled':
          return [activation, 'serviceDisabled'];
        default:
          throw new Error(`Unknown stored-results configuration: ${plugin.configuration}`);
      }
    default:
      throw new Error(`Unknown stored-results plugin: ${plugin.kind}`);
  }
}

function senderLabel(message, noSender) {
  if (!message.fromName && !message.fromEmail) return noSender;
  if (!message.fromName) return message.fromEmail;
  if (!message.fromEmail) return message.fromName;
  return `${message.fromName} <${message.fromEmail}>`;
}

function StatusLine({ plugin, t }) {
  const keys = statusKeys(plugin);
  if (!keys.length) return null;
  return (
    <div data-testid="plugin-results-status" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {keys.map(key => (
        <span key={key} style={{
          padding: '3px 8px', borderRadius: 999, background: 'var(--bg-tertiary)',
          color: 'var(--text-secondary)', fontSize: 11,
        }}>
          {t(`pluginResults.${key}`)}
        </span>
      ))}
    </div>
  );
}

function ResultRow({
  message,
  expanded,
  opening,
  onToggleDetails,
  onOpen,
  mobile,
  t,
}) {
  const facets = Array.isArray(message.facets) ? message.facets : [];
  const fields = [
    { key: 'account', value: message.accountEmail },
    { key: 'folder', value: message.folder },
    { key: 'subject', value: message.subject || t('pluginResults.noSubject') },
    { key: 'sender', value: senderLabel(message, t('pluginResults.noSender')) },
    { key: 'date', value: formatDate(message.date) },
    { key: 'result', value: (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {facets.map(resultFacet => (
          <span key={resultFacet} style={{
            padding: '2px 6px', borderRadius: 999, background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)', fontSize: 11,
          }}>
            {t(`pluginResults.facets.${resultFacet}`)}
          </span>
        ))}
      </div>
    ) },
  ];
  const actions = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button
        type="button"
        onClick={() => onToggleDetails(message)}
        style={buttonStyle()}
        aria-expanded={expanded}
        data-testid="plugin-results-row-details"
      >
        {expanded ? t('pluginResults.hideDetails') : t('pluginResults.showDetails')}
      </button>
      <button
        type="button"
        onClick={() => onOpen(message)}
        style={primaryButtonStyle(opening)}
        disabled={opening}
        data-testid="plugin-results-row-open"
      >
        {opening ? t('pluginResults.opening') : t('pluginResults.open')}
      </button>
    </div>
  );

  if (mobile) {
    return (
      <article data-testid="plugin-results-row" style={{
        minWidth: 0, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 7,
        fontSize: 13, overflowWrap: 'anywhere',
      }}>
        <dl style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '0 0 12px' }}>
          {fields.map(field => (
            <div key={field.key} style={{ minWidth: 0 }}>
              <dt style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{t(`pluginResults.${field.key}`)}</dt>
              <dd style={{ margin: 0, color: field.key === 'subject' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
        {actions}
        {expanded && (
          <div data-testid="plugin-results-row-expanded" style={{
            marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-subtle)',
          }}>
            <StoredObservation observation={message.observation} />
          </div>
        )}
      </article>
    );
  }

  return (
    <>
      <tr data-testid="plugin-results-row" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {fields.map(field => (
          <td key={field.key} style={{
            padding: '9px 8px', verticalAlign: 'top', overflowWrap: 'anywhere',
            color: field.key === 'subject' ? 'var(--text-primary)' : 'var(--text-secondary)',
            minWidth: 170,
          }}>
            {field.value}
          </td>
        ))}
        <td style={{ padding: '9px 8px', verticalAlign: 'top', minWidth: 160 }}>{actions}</td>
      </tr>
      {expanded && (
        <tr data-testid="plugin-results-row-expanded">
          <td colSpan={7} style={{ padding: '0 12px 12px', background: 'var(--bg-tertiary)' }}>
            <div style={{ paddingTop: 10 }}>
              <StoredObservation observation={message.observation} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function PluginResultsPanel({ pluginId, pluginName, onClose }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [query, setQuery] = useState(() => ({
    pluginId,
    accountId: null,
    facet: 'all',
    cursors: [null],
    cursorIndex: 0,
  }));
  const [page, setPage] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [counts, setCounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [openError, setOpenError] = useState(null);

  const mounted = useRef(true);
  const listRequest = useRef(0);
  const openRequest = useRef(0);

  const queryReady = query.pluginId === pluginId;
  const currentCursor = query.cursors[query.cursorIndex] ?? null;
  const displayedPage = queryReady ? page : null;

  const invalidateDetail = useCallback(() => {
    setExpandedId(null);
  }, []);

  const invalidateOpen = useCallback(() => {
    openRequest.current += 1;
    setOpeningId(null);
    setOpenError(null);
  }, []);

  const resetToFirstPage = useCallback(() => {
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({ ...current, cursors: [null], cursorIndex: 0 }));
  }, [invalidateDetail, invalidateOpen]);

  useEffect(() => {
    if (query.pluginId !== pluginId) {
      listRequest.current += 1;
      invalidateDetail();
      invalidateOpen();
      setPage(null);
      setAccounts([]);
      setCounts([]);
      setLoading(true);
      setError(null);
      setQuery({ pluginId, accountId: null, facet: 'all', cursors: [null], cursorIndex: 0 });
    }
  }, [invalidateDetail, invalidateOpen, pluginId, query.pluginId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listRequest.current += 1;
      openRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!queryReady) return undefined;
    const requestId = ++listRequest.current;
    let active = true;
    setLoading(true);
    setError(null);
    setPage(null);
    invalidateDetail();
    invalidateOpen();

    getStoredResults(pluginId, {
      accountId: query.accountId,
      facet: query.facet,
      cursor: currentCursor,
      limit: PAGE_LIMIT,
    }).then(nextPage => {
      if (!active || !mounted.current || requestId !== listRequest.current) return;
      setPage(nextPage);
      setAccounts(Array.isArray(nextPage.accounts) ? nextPage.accounts : []);
      setCounts(Array.isArray(nextPage.counts) ? nextPage.counts : []);
      setLoading(false);
    }).catch(requestError => {
      if (!active || !mounted.current || requestId !== listRequest.current) return;
      setLoading(false);
      setError(requestError);
    });

    return () => {
      active = false;
      if (requestId === listRequest.current) listRequest.current += 1;
    };
  }, [currentCursor, invalidateDetail, invalidateOpen, pluginId, query.accountId, query.cursors, query.facet, queryReady]);

  const accountOptions = queryReady ? accounts : [];
  const countByFacet = useMemo(
    () => new Map((queryReady && !loading && !error ? counts : []).map(item => [item.facet, item.count])),
    [counts, error, loading, queryReady],
  );
  const facetOptions = useMemo(() => {
    const facets = Array.from(new Set((queryReady ? counts : []).map(item => item.facet).filter(item => item !== 'all')));
    return ['all', ...facets];
  }, [counts, queryReady]);

  const chooseAccount = event => {
    const nextAccountId = event.target.value || null;
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({ ...current, accountId: nextAccountId, cursors: [null], cursorIndex: 0 }));
  };

  const chooseFacet = event => {
    const nextFacet = event.target.value;
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({ ...current, facet: nextFacet, cursors: [null], cursorIndex: 0 }));
  };

  const chooseCount = nextFacet => {
    if (nextFacet === query.facet) return;
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({ ...current, facet: nextFacet, cursors: [null], cursorIndex: 0 }));
  };

  const goNext = () => {
    if (loading || !page?.nextCursor) return;
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({
      ...current,
      cursors: [...current.cursors.slice(0, current.cursorIndex + 1), page.nextCursor],
      cursorIndex: current.cursorIndex + 1,
    }));
  };

  const goPrevious = () => {
    if (loading || query.cursorIndex === 0) return;
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setLoading(true);
    setError(null);
    setQuery(current => ({ ...current, cursorIndex: current.cursorIndex - 1 }));
  };

  const toggleDetails = message => {
    invalidateOpen();
    setExpandedId(current => current === message.id ? null : message.id);
  };

  const openMessage = message => {
    const requestId = ++openRequest.current;
    const isCurrent = () => mounted.current && requestId === openRequest.current;
    setOpeningId(message.id);
    setOpenError(null);
    openStoredResultMessage(message.id, { isCurrent }).then(result => {
      if (!mounted.current || requestId !== openRequest.current) return;
      setOpeningId(null);
      if (result?.kind === 'superseded') return;
    }).catch(requestError => {
      if (!mounted.current || requestId !== openRequest.current) return;
      setOpeningId(null);
      setOpenError(isNotFound(requestError)
        ? { kind: 'gone' }
        : { kind: 'failed', message: errorMessage(requestError) });
    });
  };
  const closePanel = useCallback(() => {
    listRequest.current += 1;
    invalidateDetail();
    invalidateOpen();
    setPage(null);
    setError(null);
    onClose();
  }, [invalidateDetail, invalidateOpen, onClose]);

  const displayedError = !queryReady
    ? null
    : error
      ? t('pluginResults.loadFailed', { error: errorMessage(error) })
      : openError
        ? (openError.kind === 'gone'
          ? t('pluginResults.gone')
          : t('pluginResults.openFailed', { error: openError.message }))
        : null;

  const resultRows = displayedPage?.messages.map(message => (
    <ResultRow
      key={message.id}
      message={message}
      expanded={expandedId === message.id}
      opening={openingId === message.id}
      onToggleDetails={toggleDetails}
      onOpen={openMessage}
      mobile={isMobile}
      t={t}
    />
  ));
  const filterStyle = {
    display: 'flex', flexDirection: isMobile ? 'column' : 'row',
    alignItems: isMobile ? 'stretch' : 'center', gap: 6, minWidth: 0,
    flex: isMobile ? '1 1 100%' : '1 1 180px', fontSize: 12, color: 'var(--text-secondary)',
  };

  return (
    <div data-testid="plugin-results-panel" style={{ color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('pluginResults.title', { plugin: pluginName })}</h2>
          <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text-tertiary)' }}>{t('pluginResults.storedOnly')}</div>
          {displayedPage?.plugin && <StatusLine plugin={displayedPage.plugin} t={t} />}
          {displayedPage?.observedAt && (
            <div style={{ marginTop: 7, fontSize: 11, color: 'var(--text-tertiary)' }}>
              {t('pluginResults.observedAt', { time: formatDate(displayedPage.observedAt) })}
            </div>
          )}
        </div>
        <button type="button" onClick={closePanel} style={buttonStyle()} aria-label={t('pluginResults.close')}>
          {t('pluginResults.close')}
        </button>
      </div>

      <div style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
        <div>{t('pluginResults.basis')}</div>
        <div style={{ marginTop: 3 }}>{t('pluginResults.overlap')}</div>
        {displayedPage?.plugin.kind === 'rdap' && (
          <div style={{ marginTop: 3 }}>{t('pluginResults.newAtCheck')}</div>
        )}
      </div>

      {displayedError && (
        <div role="alert" data-testid="plugin-results-error" style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '9px 11px', marginBottom: 12, borderRadius: 6,
          color: 'var(--danger, #d94a4a)', background: 'rgba(248,113,113,0.1)',
          border: '1px solid rgba(248,113,113,0.25)', fontSize: 12,
        }}>
          <span>{displayedError}</span>
          {error && (
            <button type="button" onClick={resetToFirstPage} style={buttonStyle()}>{t('pluginResults.retry')}</button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label style={filterStyle}>
          <span>{t('pluginResults.account')}</span>
          <select
            value={query.accountId || ''}
            onChange={chooseAccount}
            style={selectStyle}
            data-testid="plugin-results-account"
          >
            <option value="">{t('pluginResults.allAccounts')}</option>
            {accountOptions.map(account => (
              <option key={account.id} value={account.id}>{account.emailAddress}</option>
            ))}
          </select>
        </label>
        <label style={filterStyle}>
          <span>{t('pluginResults.filter')}</span>
          <select
            value={query.facet}
            onChange={chooseFacet}
            style={selectStyle}
            data-testid="plugin-results-facet"
          >
            {facetOptions.map(resultFacet => (
              <option key={resultFacet} value={resultFacet}>
                {t(`pluginResults.facets.${resultFacet}`)}
                {countByFacet.has(resultFacet) ? ` (${countByFacet.get(resultFacet).toLocaleString()})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={resetToFirstPage} style={buttonStyle(loading)} disabled={loading}>
          {t('pluginResults.refresh')}
        </button>
      </div>

      {queryReady && !loading && !error && counts.length > 0 && (
        <div data-testid="plugin-results-counts" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {facetOptions.map(resultFacet => (
            <button
              type="button"
              key={resultFacet}
              onClick={() => chooseCount(resultFacet)}
              aria-pressed={query.facet === resultFacet}
              data-testid={`plugin-results-count-${resultFacet}`}
              style={{
                ...buttonStyle(query.facet === resultFacet),
                background: query.facet === resultFacet ? 'var(--accent)' : 'var(--bg-tertiary)',
                borderColor: query.facet === resultFacet ? 'var(--accent)' : 'var(--border)',
                color: query.facet === resultFacet ? 'var(--accent-text, #fff)' : 'var(--text-secondary)',
              }}
            >
              {t(`pluginResults.facets.${resultFacet}`)}{countByFacet.has(resultFacet) ? ` (${countByFacet.get(resultFacet).toLocaleString()})` : ''}
            </button>
          ))}
        </div>
      )}

      {loading && !displayedPage && (
        <div role="status" data-testid="plugin-results-loading" style={{ padding: '22px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          {t('pluginResults.loading')}
        </div>
      )}

      {!loading && !error && displayedPage && displayedPage.messages.length === 0 && (
        <div data-testid="plugin-results-empty" style={{ padding: '22px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          {t('pluginResults.empty')}
        </div>
      )}

      {displayedPage && displayedPage.messages.length > 0 && (isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>{resultRows}</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 7 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.account')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.folder')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.subject')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.sender')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.date')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('pluginResults.result')}</th>
                <th style={{ padding: '8px', color: 'var(--text-secondary)', fontWeight: 600 }} />
              </tr>
            </thead>
            <tbody>{resultRows}</tbody>
          </table>
        </div>
      ))}

      {displayedPage && (query.cursorIndex > 0 || displayedPage.nextCursor) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={goPrevious}
            disabled={loading || query.cursorIndex === 0}
            style={buttonStyle(loading || query.cursorIndex === 0)}
            data-testid="plugin-results-previous"
          >
            {t('pluginResults.previous')}
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={loading || !displayedPage.nextCursor}
            style={buttonStyle(loading || !displayedPage.nextCursor)}
            data-testid="plugin-results-next"
          >
            {t('pluginResults.next')}
          </button>
        </div>
      )}
    </div>
  );
}
