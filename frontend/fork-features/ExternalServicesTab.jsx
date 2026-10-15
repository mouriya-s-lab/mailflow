// Fork: admin settings for the external services behind Jev classification and link reputation
// (backend/fork-features/service-config). A stored key comes back as a mask: sending the mask
// keeps it, an empty field removes it, anything else replaces it.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../src/hooks/useMobile.js';
import { serviceConfigApi } from './api.js';

const REPUTATION_KEYS = [
  { field: 'spamhausDqsKey', labelKey: 'admin.externalServices.reputation.spamhausDqsKey' },
  { field: 'urlhausAuthKey', labelKey: 'admin.externalServices.reputation.urlhausAuthKey' },
  { field: 'safeBrowsingApiKey', labelKey: 'admin.externalServices.reputation.safeBrowsingApiKey' },
];

const cardStyle = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '20px 24px', marginBottom: 20, minWidth: 0, overflowWrap: 'anywhere',
};
const inputStyle = {
  width: '100%', minWidth: 0, boxSizing: 'border-box', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '7px 10px', color: 'var(--text-primary)', fontSize: 13,
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 };
const hintStyle = { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 };
const saveButtonStyle = (disabled, isMobile) => ({
  padding: '8px 18px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 7,
  fontSize: 13, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  minHeight: isMobile ? 44 : undefined, maxWidth: '100%', overflowWrap: 'anywhere',
});

function Card({ title, description, children, isMobile }) {
  return (
    <section style={{ ...cardStyle, padding: isMobile ? '16px 12px' : cardStyle.padding }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{title}</h3>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>{description}</div>
      {children}
    </section>
  );
}

function Field({ id, label, value, onChange, type = 'text', placeholder = '', hint = null, isMobile }) {
  return (
    <div style={{ marginBottom: 14, minWidth: 0 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        style={{ ...inputStyle, fontSize: isMobile ? 16 : inputStyle.fontSize, minHeight: isMobile ? 44 : undefined }}
      />
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}

function Message({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div role="status" aria-live="polite" style={{
      padding: '8px 12px', borderRadius: 6, marginBottom: 14, fontSize: 13, minWidth: 0, overflowWrap: 'anywhere',
      background: ok ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
      color: ok ? 'var(--green)' : 'var(--red)',
      border: `1px solid ${ok ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
    }}>{msg.text}</div>
  );
}

// Loads one service's admin config, keeps an editable copy, and saves it back. `saved` is what
// the server last returned, so the status line follows what is stored rather than the form.
function useServiceConfig(load, save) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let active = true;
    load()
      .then(({ config }) => { if (active) { setSaved(config); setForm(config); } })
      .catch(err => { if (active) setMsg({ type: 'error', text: err.message }); });
    return () => { active = false; };
  }, [load]);

  const submit = async e => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const { config } = await save(form);
      setSaved(config); setForm(config);
      setMsg({ type: 'ok', text: t('admin.externalServices.saved') });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return { saved, form, setForm, saving, msg, submit };
}

function JevSettings({ isMobile }) {
  const { t } = useTranslation();
  const { saved, form, setForm, saving, msg, submit } = useServiceConfig(serviceConfigApi.getJev, serviceConfigApi.saveJev);
  const set = field => value => setForm(f => ({ ...f, [field]: value }));
  const invalid = !form || !form.baseUrl.trim() || !form.model.trim();

  return (
    <Card title={t('admin.externalServices.jev.title')} description={t('admin.externalServices.jev.description')} isMobile={isMobile}>
      <Message msg={msg} />
      {form && (
        <form onSubmit={submit}>
          <div style={{ fontSize: 13, marginBottom: 14 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('admin.externalServices.jev.status')}: </span>
            <span data-testid="jev-status" style={{ color: saved.apiKey ? 'var(--green)' : 'var(--text-primary)' }}>
              {saved.apiKey ? t('admin.externalServices.jev.configured') : t('admin.externalServices.jev.unconfigured')}
            </span>
          </div>
          <Field id="fork-jev-base-url" label={t('admin.externalServices.jev.baseUrl')} value={form.baseUrl} onChange={set('baseUrl')} isMobile={isMobile} />
          <Field id="fork-jev-model" label={t('admin.externalServices.jev.model')} value={form.model} onChange={set('model')} isMobile={isMobile} />
          <Field
            id="fork-jev-api-key"
            isMobile={isMobile}
            label={t('admin.externalServices.jev.apiKey')}
            value={form.apiKey}
            onChange={set('apiKey')}
            type="password"
            placeholder={t('admin.externalServices.jev.apiKeyPh')}
            hint={saved.apiKey ? t('admin.externalServices.keepKey') : null}
          />
          <button type="submit" disabled={saving || invalid} style={saveButtonStyle(saving || invalid, isMobile)}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </form>
      )}
    </Card>
  );
}

function ReputationSettings({ isMobile }) {
  const { t } = useTranslation();
  const { saved, form, setForm, saving, msg, submit } = useServiceConfig(
    serviceConfigApi.getReputation, serviceConfigApi.saveReputation,
  );

  return (
    <Card title={t('admin.externalServices.reputation.title')} description={t('admin.externalServices.reputation.description')} isMobile={isMobile}>
      <Message msg={msg} />
      {form && (
        <form onSubmit={submit}>
          <label htmlFor="fork-rdap-switch" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, minHeight: isMobile ? 44 : undefined, cursor: 'pointer' }}>
            <button
              type="button"
              id="fork-rdap-switch"
              role="switch"
              aria-checked={form.rdapEnabled}
              aria-labelledby="fork-rdap-label"
              onClick={() => setForm(f => ({ ...f, rdapEnabled: !f.rdapEnabled }))}
              style={{
                width: 36, height: 20, borderRadius: 10, position: 'relative', cursor: 'pointer', flexShrink: 0,
                border: 'none', padding: 0, background: form.rdapEnabled ? 'var(--accent)' : 'var(--border)', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: form.rdapEnabled ? 18 : 2, width: 16, height: 16,
                borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
              }} />
            </button>
            <span id="fork-rdap-label" style={{ fontSize: 13, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>
              {t('admin.externalServices.reputation.rdap')}
            </span>
          </label>
          {REPUTATION_KEYS.map(({ field, labelKey }) => (
            <Field
              key={field}
              id={`fork-reputation-${field}`}
              isMobile={isMobile}
              label={t(labelKey)}
              value={form[field]}
              onChange={value => setForm(f => ({ ...f, [field]: value }))}
              type="password"
              placeholder={t('admin.externalServices.reputation.keyPh')}
              hint={saved[field] ? t('admin.externalServices.keepKey') : t('admin.externalServices.reputation.keyUnset')}
            />
          ))}
          <button type="submit" disabled={saving} style={saveButtonStyle(saving, isMobile)}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </form>
      )}
    </Card>
  );
}

export function ExternalServicesTab() {
  const { t } = useTranslation();
  const isMobile = useMobile();
  return (
    <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 20 }}>
        {t('admin.externalServices.description')}
      </p>
      <JevSettings isMobile={isMobile} />
      <ReputationSettings isMobile={isMobile} />
    </div>
  );
}
