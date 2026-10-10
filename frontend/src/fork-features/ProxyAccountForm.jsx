// Fork: add a mailbox through the email-oauth2-proxy (backend/fork-features/emailproxyAccounts.js).
// The proxy produces the provider's consent link; the user signs in in their own
// browser, which then lands on the client's registered localhost redirect. That
// page does not load; its address carries the authorisation code, so the user
// pastes it back here and MailFlow finishes adding the account.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';

// Brand names, not translated.
const PROVIDERS = [
  { id: 'microsoft', label: 'Microsoft · Outlook / Hotmail / Microsoft 365' },
  { id: 'google', label: 'Google · Gmail / Google Workspace' },
];

const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 };
const primaryButton = (disabled) => ({
  padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 7,
  color: 'white', fontSize: 13, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
});
const secondaryButton = {
  padding: '10px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
};

export function ProxyAccountForm({ onAdded, onCancel }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState('microsoft');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // idle -> starting -> awaiting -> completing (-> onAdded); errors return to idle or awaiting
  const [phase, setPhase] = useState('idle');
  const [flow, setFlow] = useState(null); // { flow_id, permission_url, redirect_uri }
  const [responseUrl, setResponseUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    setPhase('starting');
    try {
      const started = await api.startProxyAccount({ provider, email_address: email.trim(), name: name.trim() || undefined });
      setFlow(started);
      setPhase('awaiting');
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  };

  const complete = async () => {
    setError('');
    setPhase('completing');
    try {
      const account = await api.completeProxyAccount(flow.flow_id, responseUrl.trim());
      onAdded(account);
    } catch (err) {
      setError(err.message);
      // 400 with a matching flow (wrong address pasted) can be retried; others need a new sign-in.
      if (err.status === 400 && /does not start with/.test(err.message)) {
        setPhase('awaiting');
      } else {
        setFlow(null);
        setResponseUrl('');
        setPhase('idle');
      }
    }
  };

  const cancel = async () => {
    if (flow) await api.cancelProxyAccount(flow.flow_id).catch(() => {});
    onCancel();
  };

  const copyLink = async () => {
    if ((await copyToClipboard(flow.permission_url)).ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const locked = phase !== 'idle';

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
        {t('admin.accounts.proxy.intro')}
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>{t('admin.accounts.proxy.provider')}</label>
        <select value={provider} disabled={locked} onChange={e => setProvider(e.target.value)} style={inputStyle}>
          {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>{t('admin.accounts.proxy.email')} <span style={{ color: 'var(--red)' }}>*</span></label>
        <input type="email" value={email} disabled={locked} onChange={e => setEmail(e.target.value)} style={inputStyle} />
      </div>

      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>{t('admin.accounts.proxy.name')}</label>
        <input value={name} disabled={locked} onChange={e => setName(e.target.value)} style={inputStyle} />
      </div>

      {flow && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>
            {t('admin.accounts.proxy.step1', { email: email.trim() })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <a href={flow.permission_url} target="_blank" rel="noopener noreferrer"
              style={{ ...primaryButton(false), textDecoration: 'none' }}>
              {t('admin.accounts.proxy.openLink')}
            </a>
            <button type="button" onClick={copyLink} style={secondaryButton}>
              {copied ? t('admin.accounts.proxy.copied') : t('admin.accounts.proxy.copyLink')}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
            {t('admin.accounts.proxy.step2', { redirect: flow.redirect_uri })}
          </div>
          <textarea value={responseUrl} disabled={phase === 'completing'} rows={3}
            onChange={e => setResponseUrl(e.target.value)}
            placeholder={`${flow.redirect_uri}/?code=…`}
            style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }} />
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {!flow ? (
          <button type="button" onClick={start} disabled={phase === 'starting' || !email.trim()}
            style={primaryButton(phase === 'starting' || !email.trim())}>
            {phase === 'starting' ? t('admin.accounts.proxy.starting') : t('admin.accounts.proxy.start')}
          </button>
        ) : (
          <button type="button" onClick={complete} disabled={phase === 'completing' || !responseUrl.trim()}
            style={primaryButton(phase === 'completing' || !responseUrl.trim())}>
            {phase === 'completing' ? t('admin.accounts.proxy.completing') : t('admin.accounts.proxy.complete')}
          </button>
        )}
        <button type="button" onClick={cancel} style={secondaryButton}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

// The "add account" view: the upstream password form or the OAuth-proxy flow.
export function AddAccountView({ imapForm, onAdded, onCancel }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('imap');
  const tab = (id, label) => (
    <button type="button" key={id} onClick={() => setMode(id)} style={{
      padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500,
      border: `1px solid ${mode === id ? 'var(--accent)' : 'var(--border)'}`,
      background: mode === id ? 'var(--accent-dim)' : 'transparent',
      color: mode === id ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer',
    }}>{label}</button>
  );
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {tab('imap', t('admin.accounts.proxy.modeImap'))}
        {tab('proxy', t('admin.accounts.proxy.modeProxy'))}
      </div>
      {mode === 'imap' ? imapForm : <ProxyAccountForm onAdded={onAdded} onCancel={onCancel} />}
    </div>
  );
}
