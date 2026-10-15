// Jev classification plugin — settings block under Settings → Categories, rendered only while the
// user has the plugin activated. Three parts: the category list, each account's settings, and the
// running state from /status (services, queue, backfill, failures, incidents).
//
// Two sources, kept apart: the configuration being edited comes from GET /categories and
// GET /accounts and is replaced only by what a save returns; the running state comes from
// GET /status, fetched on mount, every 15 seconds and after every action, newest request winning.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../../hooks/useMobile.js';
import { jevClassifyApi } from './api.js';
import {
  MAX_CATEGORIES, accountDraft, addedDraft, categoryDrafts, parseAccountDraft, parseCategoryDrafts, routingTargets,
} from './model.js';

export const STATUS_REFRESH_MS = 15_000;

// Source names are product names, the same in every language.
const REPUTATION_SOURCES = [
  { id: 'rdap', name: 'RDAP' },
  { id: 'spamhaus_dbl', name: 'Spamhaus DBL' },
  { id: 'urlhaus', name: 'URLhaus' },
  { id: 'safe_browsing', name: 'Google Safe Browsing' },
];
const QUEUE_ORIGINS = ['backfill', 'new_mail'];
const QUEUE_STATES = ['pending', 'retry', 'done', 'terminal'];

const cardStyle = {
  border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-secondary)',
  minWidth: 0, overflowWrap: 'anywhere',
};
const headingStyle = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 6px',
};
const hintStyle = { fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px' };
const inputStyle = {
  width: '100%', minWidth: 0, boxSizing: 'border-box', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '6px 9px', color: 'var(--text-primary)', fontSize: 13,
};
const fieldErrorStyle = { fontSize: 11, color: 'var(--red)', marginTop: 3 };
const primaryButton = (disabled, isMobile) => ({
  padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-text)',
  fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  minHeight: isMobile ? 44 : undefined, minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
});
const secondaryButton = (disabled, isMobile) => ({
  padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text-secondary)', fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  minHeight: isMobile ? 44 : undefined, minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
});

const formatTime = iso => new Date(iso).toLocaleString();

function Message({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div role="status" style={{
      padding: '7px 11px', borderRadius: 6, margin: '10px 0', fontSize: 12, minWidth: 0, overflowWrap: 'anywhere',
      background: ok ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
      color: ok ? 'var(--green)' : 'var(--red)',
      border: `1px solid ${ok ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
    }}>{msg.text}</div>
  );
}

function Checkbox({ checked, onChange, label, isMobile }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer',
      minHeight: isMobile ? 44 : undefined, minWidth: 0,
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
    </label>
  );
}

// GET /status on mount and every STATUS_REFRESH_MS; `refresh` for after an action. Only the newest
// request may set the state, so a slow poll cannot overwrite what an action just fetched.
function useJevStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await jevClassifyApi.getStatus();
      if (mine === generation.current) { setStatus(next); setError(null); }
    } catch (err) {
      if (mine === generation.current) setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [refresh]);

  return { status, error, refresh };
}

// ── Services ──────────────────────────────────────────────────────────────────

function JevService({ jev }) {
  const { t } = useTranslation();
  switch (jev.kind) {
    case 'unconfigured':
      return (
        <div role="alert" data-testid="jev-unconfigured" style={{
          padding: '9px 12px', borderRadius: 6, fontSize: 13, marginBottom: 10,
          background: 'rgba(248,113,113,0.1)', color: 'var(--red)', border: '1px solid rgba(248,113,113,0.3)',
        }}>
          {t('jevClassify.service.jevUnconfigured')}
        </div>
      );
    case 'configured':
      return (
        <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>
          {t('jevClassify.service.jevConfigured', { model: jev.model, baseUrl: jev.baseUrl })}
        </div>
      );
    default:
      throw new Error(`unknown Jev status ${JSON.stringify(jev.kind)}`);
  }
}

function sourceStateText(t, state) {
  switch (state) {
    case 'enabled': return t('jevClassify.service.sourceConfigured');
    case 'unconfigured': return t('jevClassify.service.sourceUnconfigured');
    case 'disabled': return t('jevClassify.service.sourceDisabled');
    default: throw new Error(`unknown reputation source state ${JSON.stringify(state)}`);
  }
}

function Services({ status, error }) {
  const { t } = useTranslation();
  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <div style={headingStyle}>{t('jevClassify.service.title')}</div>
      {error && <Message msg={{ type: 'error', text: t('jevClassify.service.refreshFailed', { error }) }} />}
      {status ? (
        <>
          <JevService jev={status.jev} />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('jevClassify.service.reputation')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
            {REPUTATION_SOURCES.map(source => (
              <span key={source.id} data-testid={`reputation-${source.id}`} style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {source.name}: <span style={{ color: 'var(--text-primary)' }}>
                  {t(status.reputation[source.id].activated ? 'jevClassify.service.pluginActivated' : 'jevClassify.service.pluginInactive')}
                  {' · '}{sourceStateText(t, status.reputation[source.id].configuration)}
                </span>
              </span>
            ))}
          </div>
        </>
      ) : (!error && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>)}
    </div>
  );
}

// ── Categories ────────────────────────────────────────────────────────────────

function textProblemText(t, problem) {
  switch (problem.kind) {
    case 'required': return t('jevClassify.categories.required');
    case 'too_long': return t('jevClassify.categories.tooLong', { max: problem.max });
    default: throw new Error(`unknown field problem ${JSON.stringify(problem.kind)}`);
  }
}

function CategoriesEditor({ saved, onSaved, isMobile }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState(() => categoryDrafts(saved.categories));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const nextKey = useRef(0);
  const fieldStyle = { ...inputStyle, fontSize: isMobile ? 16 : 13, minHeight: isMobile ? 44 : undefined };

  useEffect(() => { setDrafts(categoryDrafts(saved.categories)); setAttempted(false); }, [saved]);

  // After a refused save the errors follow the form as it is edited.
  const parsed = parseCategoryDrafts(drafts);
  const errors = attempted && !parsed.ok ? parsed.errors : null;

  const edit = (key, field, value) => {
    setDrafts(rows => rows.map(row => (row.key === key ? { ...row, [field]: value } : row)));
    setMsg(null);
  };
  const add = () => {
    nextKey.current += 1;
    const row = addedDraft(nextKey.current);
    setDrafts(rows => [...rows, row]);
    setMsg(null);
  };
  const remove = key => { setDrafts(rows => rows.filter(row => row.key !== key)); setMsg(null); };

  const save = async () => {
    setAttempted(true);
    setMsg(null);
    if (!parsed.ok) return;
    setSaving(true);
    try {
      await jevClassifyApi.saveCategories(parsed.categories);
      const next = await jevClassifyApi.getCategories();
      onSaved(next);
      setMsg({ type: 'ok', text: t('jevClassify.categories.saved') });
    } catch (err) {
      setMsg({ type: 'error', text: t('jevClassify.categories.saveFailed', { error: err.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }} data-testid="jev-categories">
      <div style={headingStyle}>{t('jevClassify.categories.title')}</div>
      <p style={hintStyle}>{t('jevClassify.categories.description', { revision: saved.revision })}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {drafts.map(row => {
          const rowErrors = errors?.rows[row.key];
          return (
            <div key={row.key} data-testid="jev-category-row" style={{
              display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, alignItems: 'flex-start', minWidth: 0,
            }}>
              <div style={{ flex: isMobile ? 'none' : '0 0 30%', width: isMobile ? '100%' : undefined, minWidth: 0 }}>
                <input
                  value={row.label}
                  onChange={e => edit(row.key, 'label', e.target.value)}
                  placeholder={t('jevClassify.categories.namePh')}
                  aria-label={t('jevClassify.categories.name')}
                  aria-invalid={Boolean(rowErrors?.label)}
                  style={fieldStyle}
                />
                {rowErrors?.label && <div data-testid="field-error" style={fieldErrorStyle}>{textProblemText(t, rowErrors.label)}</div>}
              </div>
              <div style={{ flex: isMobile ? 'none' : 1, width: isMobile ? '100%' : undefined, minWidth: 0 }}>
                <textarea
                  value={row.description}
                  onChange={e => edit(row.key, 'description', e.target.value)}
                  placeholder={t('jevClassify.categories.descriptionPh')}
                  aria-label={t('jevClassify.categories.descriptionLabel')}
                  aria-invalid={Boolean(rowErrors?.description)}
                  rows={2}
                  style={{ ...fieldStyle, resize: 'vertical', fontFamily: 'inherit' }}
                />
                {rowErrors?.description && <div data-testid="field-error" style={fieldErrorStyle}>{textProblemText(t, rowErrors.description)}</div>}
              </div>
              <button type="button" onClick={() => remove(row.key)} style={secondaryButton(false, isMobile)}>
                {t('jevClassify.categories.remove')}
              </button>
            </div>
          );
        })}
      </div>
      {errors?.size && (
        <div data-testid="field-error" style={{ ...fieldErrorStyle, fontSize: 12, marginTop: 8 }}>
          {t('jevClassify.categories.sizeError', errors.size)}
        </div>
      )}
      <Message msg={msg} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={saving} style={primaryButton(saving, isMobile)}>
          {saving ? t('common.saving') : t('jevClassify.categories.save')}
        </button>
        <button type="button" onClick={add} disabled={drafts.length >= MAX_CATEGORIES} style={secondaryButton(drafts.length >= MAX_CATEGORIES, isMobile)}>
          {t('jevClassify.categories.add')}
        </button>
      </div>
    </div>
  );
}

// ── Accounts ──────────────────────────────────────────────────────────────────

function AccountSettings({ account, categories, onSaved, isMobile }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => accountDraft(account.config));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const fieldStyle = { ...inputStyle, fontSize: isMobile ? 16 : 13, minHeight: isMobile ? 44 : undefined };

  useEffect(() => { setDraft(accountDraft(account.config)); setAttempted(false); }, [account]);

  const { labelStore } = account;
  const targets = routingTargets(account.folders);
  const parsed = parseAccountDraft(draft, { categoryIds: categories.map(c => c.id), folders: account.folders });
  const errors = attempted && !parsed.ok ? parsed.errors : null;
  const set = (field, value) => { setDraft(d => ({ ...d, [field]: value })); setMsg(null); };
  const route = (categoryId, target) => {
    setDraft(d => {
      const routing = { ...d.routing };
      if (target === '') delete routing[categoryId];
      else routing[categoryId] = target;
      return { ...d, routing };
    });
    setMsg(null);
  };

  const save = async () => {
    setAttempted(true);
    setMsg(null);
    if (!parsed.ok) return;
    setSaving(true);
    try {
      onSaved(await jevClassifyApi.saveAccount(account.id, parsed.settings));
      setMsg({ type: 'ok', text: t('jevClassify.accounts.saved') });
    } catch (err) {
      setMsg({ type: 'error', text: t('jevClassify.accounts.saveFailed', { error: err.message }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <Checkbox checked={draft.enabled} onChange={v => set('enabled', v)} label={t('jevClassify.accounts.enabled')} isMobile={isMobile} />
        <Checkbox checked={draft.classifyNewMail} onChange={v => set('classifyNewMail', v)} label={t('jevClassify.accounts.classifyNewMail')} isMobile={isMobile} />
        <Checkbox
          checked={draft.createFolders}
          onChange={v => set('createFolders', v)}
          label={labelStore ? t('jevClassify.accounts.createLabels') : t('jevClassify.accounts.createFolders')}
          isMobile={isMobile}
        />
        <Checkbox checked={draft.trainSpam} onChange={v => set('trainSpam', v)} label={t('jevClassify.accounts.trainSpam')} isMobile={isMobile} />
        <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', minWidth: 0 }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{labelStore ? t('jevClassify.accounts.minConfidenceLabels') : t('jevClassify.accounts.minConfidence')}</span>
          <input
            type="number" min="0" max="1" step="0.05"
            value={draft.routingMinConfidence}
            onChange={e => set('routingMinConfidence', e.target.value)}
            aria-invalid={Boolean(errors?.routingMinConfidence)}
            data-testid="jev-min-confidence"
            style={{ ...fieldStyle, width: 90, maxWidth: '100%' }}
          />
        </label>
        {errors?.routingMinConfidence && (
          <div data-testid="field-error" style={fieldErrorStyle}>{t('jevClassify.accounts.minConfidenceError')}</div>
        )}
      </div>

      <div style={headingStyle}>{labelStore ? t('jevClassify.accounts.routingLabels') : t('jevClassify.accounts.routingFolders')}</div>
      <p style={hintStyle}>{t('jevClassify.accounts.routingHint')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {categories.map(category => {
          const current = draft.routing[category.id] ?? '';
          const unavailable = current !== '' && !targets.includes(current);
          return (
            <div key={category.id}>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: 10, minWidth: 0 }}>
                <span style={{ flex: isMobile ? 'none' : '0 0 35%', fontSize: 12, color: 'var(--text-secondary)', minWidth: 0, overflowWrap: 'anywhere' }}>
                  {category.label}
                </span>
                <select
                  value={current}
                  onChange={e => route(category.id, e.target.value)}
                  aria-label={category.label}
                  data-testid={`jev-route-${category.id}`}
                  aria-invalid={Boolean(errors?.routing[category.id])}
                  style={{ ...fieldStyle, flex: isMobile ? 'none' : 1, maxWidth: '100%' }}
                >
                  <option value="">{t('jevClassify.accounts.notRouted')}</option>
                  {unavailable && (
                    <option value={current} disabled>{t('jevClassify.accounts.unavailableTarget', { path: current })}</option>
                  )}
                  {targets.map(path => <option key={path} value={path}>{path}</option>)}
                </select>
              </div>
              {errors?.routing[category.id] && (
                <div data-testid="field-error" style={fieldErrorStyle}>
                  {t('jevClassify.accounts.unavailableTargetError', { path: errors.routing[category.id] })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Message msg={msg} />
      <button type="button" onClick={save} disabled={saving} style={primaryButton(saving, isMobile)}>
        {saving ? t('common.saving') : t('jevClassify.accounts.save')}
      </button>
    </div>
  );
}

function runStateText(t, state) {
  switch (state) {
    case 'enabled': return t('jevClassify.run.enabled');
    case 'paused': return t('jevClassify.run.paused');
    default: throw new Error(`unknown account run state ${JSON.stringify(state)}`);
  }
}

function backfillText(t, run) {
  switch (run.kind) {
    case 'idle':
      return t('jevClassify.backfill.idle');
    case 'running':
      return t('jevClassify.backfill.running', {
        startedAt: formatTime(run.startedAt), processed: run.processed, marked: run.marked, failed: run.failed,
      });
    case 'completed':
      return t('jevClassify.backfill.completed', {
        finishedAt: formatTime(run.finishedAt), processed: run.processed, failed: run.failed,
      });
    case 'stopped':
      return t('jevClassify.backfill.stopped', {
        stoppedAt: formatTime(run.stoppedAt), processed: run.processed, marked: run.marked, failed: run.failed,
      });
    default:
      throw new Error(`unknown backfill run ${JSON.stringify(run.kind)}`);
  }
}

function nextDueText(t, nextDue) {
  switch (nextDue.kind) {
    case 'none': return null;
    case 'due_now': return t('jevClassify.queue.dueNow');
    case 'scheduled': return t('jevClassify.queue.scheduled', { time: formatTime(nextDue.dueAt) });
    default: throw new Error(`unknown next due ${JSON.stringify(nextDue.kind)}`);
  }
}

const QUEUE_HEADER_KEYS = {
  pending: 'jevClassify.queue.pending',
  retry: 'jevClassify.queue.retry',
  done: 'jevClassify.queue.done',
  terminal: 'jevClassify.queue.terminal',
};
const QUEUE_ORIGIN_KEYS = { backfill: 'jevClassify.queue.backfill', new_mail: 'jevClassify.queue.newMail' };

function AccountStatus({ accountId, status, refreshStatus, isMobile }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  // One action at a time per account; the status is fetched again whatever the outcome.
  const act = async (name, call, okText) => {
    setBusy(name);
    setMsg(null);
    try {
      const result = await call();
      if (okText) setMsg({ type: 'ok', text: okText(result) });
    } catch (err) {
      setMsg({ type: 'error', text: t('jevClassify.actionFailed', { error: err.message }) });
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  };

  if (!status) return <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>;
  const running = status.backfill.kind === 'running';
  const due = nextDueText(t, status.nextDue);

  return (
    <div data-testid={`jev-status-${accountId}`}>
      <div style={headingStyle}>{t('jevClassify.backfill.title')}</div>
      <p style={hintStyle}>{t('jevClassify.backfill.description')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span data-testid="jev-backfill" style={{ fontSize: 13, color: 'var(--text-primary)', flex: isMobile ? '1 1 100%' : 1, minWidth: isMobile ? 0 : 200, overflowWrap: 'anywhere' }}>
          {backfillText(t, status.backfill)}
        </span>
        {running ? (
          <button type="button" disabled={busy !== null} style={secondaryButton(busy !== null, isMobile)}
            onClick={() => act('stop', () => jevClassifyApi.stopBackfill(accountId))}>
            {t('jevClassify.backfill.stop')}
          </button>
        ) : (
          <button type="button" disabled={busy !== null} style={primaryButton(busy !== null, isMobile)}
            onClick={() => act('start', () => jevClassifyApi.startBackfill(accountId))}>
            {t('jevClassify.backfill.start')}
          </button>
        )}
      </div>

      <div style={headingStyle}>{t('jevClassify.queue.title')}</div>
      {isMobile ? (
        <div style={{ display: 'grid', gap: 10, marginBottom: 6, minWidth: 0 }}>
          {QUEUE_ORIGINS.map(origin => (
            <div key={origin} data-testid={`jev-queue-${origin}`} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t(QUEUE_ORIGIN_KEYS[origin])}</div>
              <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 12px', margin: '6px 0 0', fontSize: 12 }}>
                {QUEUE_STATES.map(state => (
                  <div key={state} style={{ minWidth: 0 }}>
                    <dt style={{ color: 'var(--text-tertiary)' }}>{t(QUEUE_HEADER_KEYS[state])}</dt>
                    <dd style={{ margin: '2px 0 0', color: 'var(--text-primary)' }}>{status.queue[origin][state]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 12, marginBottom: 6 }}>
          <thead>
            <tr>
              <th />
              {QUEUE_STATES.map(state => (
                <th key={state} style={{ textAlign: 'right', padding: '2px 10px', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t(QUEUE_HEADER_KEYS[state])}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {QUEUE_ORIGINS.map(origin => (
              <tr key={origin} data-testid={`jev-queue-${origin}`}>
                <td style={{ padding: '2px 10px 2px 0', color: 'var(--text-secondary)' }}>{t(QUEUE_ORIGIN_KEYS[origin])}</td>
                {QUEUE_STATES.map(state => (
                  <td key={state} style={{ textAlign: 'right', padding: '2px 10px', color: 'var(--text-primary)' }}>{status.queue[origin][state]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
        {due && <span>{due}</span>}
        <span>
          {status.lastDecidedAt
            ? t('jevClassify.stats.lastDecided', { time: formatTime(status.lastDecidedAt) })
            : t('jevClassify.stats.neverDecided')}
        </span>
        <span>{t('jevClassify.stats.jevCalls', { calls: status.jevCalls })}</span>
      </div>

      {status.terminalFailed > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10, minWidth: 0 }}>
          <span data-testid="jev-terminal-failed" style={{ fontSize: 13, color: 'var(--red)', minWidth: 0, overflowWrap: 'anywhere' }}>
            {t('jevClassify.failures.count', { failed: status.terminalFailed })}
          </span>
          <button type="button" disabled={busy !== null} style={secondaryButton(busy !== null, isMobile)}
            onClick={() => act('retry', () => jevClassifyApi.retryFailed(accountId),
              ({ reset }) => t('jevClassify.failures.retried', { reset }))}>
            {t('jevClassify.failures.retry')}
          </button>
        </div>
      )}

      {status.incidents.length > 0 && (
        <div data-testid="jev-incidents" style={{ marginBottom: 10 }}>
          <div style={headingStyle}>{t('jevClassify.incidents.title')}</div>
          <p style={hintStyle}>{t('jevClassify.incidents.description')}</p>
          {isMobile ? (
            <div style={{ display: 'grid', gap: 10, marginBottom: 6, minWidth: 0 }}>
              {status.incidents.map((incident, index) => (
                <dl key={index} data-testid="jev-incident" style={{
                  display: 'grid', gap: 4, margin: 0, padding: '8px 0', minWidth: 0,
                  borderBottom: '1px solid var(--border-subtle)', fontSize: 12, overflowWrap: 'anywhere',
                }}>
                  <dt style={{ color: 'var(--text-tertiary)' }}>{t('jevClassify.incidents.messageId')}</dt>
                  <dd style={{ margin: '0 0 4px', minWidth: 0, color: 'var(--text-primary)' }}>{incident.messageId ?? t('jevClassify.incidents.noMessageId')}</dd>
                  <dt style={{ color: 'var(--text-tertiary)' }}>{t('jevClassify.incidents.target')}</dt>
                  <dd style={{ margin: '0 0 4px', minWidth: 0, color: 'var(--text-primary)' }}>{incident.target}</dd>
                  <dt style={{ color: 'var(--text-tertiary)' }}>{t('jevClassify.incidents.at')}</dt>
                  <dd style={{ margin: 0, minWidth: 0, color: 'var(--text-primary)' }}>{formatTime(incident.at)}</dd>
                </dl>
              ))}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 12, width: '100%', marginBottom: 6, overflowWrap: 'anywhere' }}>
              <thead>
                <tr style={{ color: 'var(--text-tertiary)', textAlign: 'left' }}>
                  <th style={{ fontWeight: 500, padding: '2px 8px 2px 0' }}>{t('jevClassify.incidents.messageId')}</th>
                  <th style={{ fontWeight: 500, padding: '2px 8px' }}>{t('jevClassify.incidents.target')}</th>
                  <th style={{ fontWeight: 500, padding: '2px 8px' }}>{t('jevClassify.incidents.at')}</th>
                </tr>
              </thead>
              <tbody>
                {status.incidents.map((incident, index) => (
                  <tr key={index} data-testid="jev-incident" style={{ color: 'var(--text-primary)' }}>
                    <td style={{ padding: '2px 8px 2px 0', overflowWrap: 'anywhere' }}>{incident.messageId ?? t('jevClassify.incidents.noMessageId')}</td>
                    <td style={{ padding: '2px 8px', overflowWrap: 'anywhere' }}>{incident.target}</td>
                    <td style={{ padding: '2px 8px', overflowWrap: 'anywhere' }}>{formatTime(incident.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" disabled={busy !== null} style={secondaryButton(busy !== null, isMobile)}
            onClick={() => act('clear', () => jevClassifyApi.clearIncidents(accountId))}>
            {t('jevClassify.incidents.clear')}
          </button>
        </div>
      )}
      <Message msg={msg} />
    </div>
  );
}

function AccountCard({ account, categories, status, onSaved, refreshStatus, isMobile }) {
  const { t } = useTranslation();
  return (
    <div style={cardStyle} data-testid={`jev-account-${account.id}`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', flex: isMobile ? '1 1 100%' : 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {account.emailAddress}
        </span>
        {account.labelStore && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', maxWidth: '100%', overflowWrap: 'anywhere' }}>{t('jevClassify.accounts.labelStore')}</span>
        )}
        {status && (
          <span data-testid="jev-run-state" style={{
            fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, maxWidth: '100%', overflowWrap: 'anywhere',
            background: status.state === 'enabled' ? 'rgba(74,222,128,0.12)' : 'var(--bg-tertiary)',
            color: status.state === 'enabled' ? 'var(--green)' : 'var(--text-tertiary)',
          }}>{runStateText(t, status.state)}</span>
        )}
      </div>
      <AccountSettings account={account} categories={categories} onSaved={onSaved} isMobile={isMobile} />
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '14px 0' }} />
      <AccountStatus accountId={account.id} status={status} refreshStatus={refreshStatus} isMobile={isMobile} />
    </div>
  );
}

// ── The block ─────────────────────────────────────────────────────────────────

export default function JevClassifySettings({ initialSubTab }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const sectionRef = useRef(null);
  const [categories, setCategories] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const { status, error: statusError, refresh: refreshStatus } = useJevStatus();

  // The Plugins tab's "configure" link lands here, once the block has its full height.
  const loaded = categories !== null && accounts !== null;
  useEffect(() => {
    if (loaded && initialSubTab === 'jev-classify') sectionRef.current.scrollIntoView({ block: 'start' });
  }, [initialSubTab, loaded]);

  useEffect(() => {
    let active = true;
    Promise.all([jevClassifyApi.getCategories(), jevClassifyApi.getAccounts()])
      .then(([loadedCategories, loadedAccounts]) => {
        if (!active) return;
        setCategories(loadedCategories);
        setAccounts(loadedAccounts);
      })
      .catch(err => { if (active) setLoadError(err.message); });
    return () => { active = false; };
  }, []);

  const accountSaved = view => {
    setAccounts(list => list.map(account => (account.id === view.id ? view : account)));
    refreshStatus();
  };
  const statusOf = id => status?.accounts.find(account => account.id === id) ?? null;

  return (
    <section ref={sectionRef} data-testid="jev-classify-settings" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '24px 0 20px' }} />
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, marginBottom: 2 }}>{t('jevClassify.title')}</div>
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 0, marginBottom: 16 }}>{t('jevClassify.description')}</p>

      <Services status={status} error={statusError} />

      {loadError && <Message msg={{ type: 'error', text: t('jevClassify.loadFailed', { error: loadError }) }} />}
      {categories && accounts && (
        <>
          <CategoriesEditor saved={categories} onSaved={setCategories} isMobile={isMobile} />
          <div style={headingStyle}>{t('jevClassify.accounts.title')}</div>
          {accounts.length === 0 ? (
            <p style={hintStyle}>{t('jevClassify.accounts.none')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {accounts.map(account => (
                <AccountCard
                  key={account.id}
                  account={account}
                  categories={categories.categories}
                  status={statusOf(account.id)}
                  onSaved={accountSaved}
                  refreshStatus={refreshStatus}
                  isMobile={isMobile}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
