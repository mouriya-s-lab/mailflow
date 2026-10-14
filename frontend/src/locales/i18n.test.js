/**
 * Locale contracts: key availability, interpolation data and runtime plural resolution.
 * Natural translations may share words; source spelling is not a runtime contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';

const dir = dirname(fileURLToPath(import.meta.url));


// Locale-specific plural forms are allowed per locale. A locale may add forms
// required by its Intl.PluralRules categories without forcing every other locale
// to carry unused keys. Existing locale files may also define their own forms.
const LOCALE_SPECIFIC_KEYS_BY_LOCALE = {
  cs: new Set([
    'message.attachment_few', 'message.attachment_many',
    'messageList.bulkDeleted.title_few', 'messageList.bulkDeleted.title_many',
    'messageList.bulkDeleted.failBody_few', 'messageList.bulkDeleted.failBody_many',
    'messageList.bulkMoved.title_few', 'messageList.bulkMoved.title_many',
    'messageList.bulkMoved.failBody_few', 'messageList.bulkMoved.failBody_many',
    'messageList.bulkArchived.title_few', 'messageList.bulkArchived.title_many',
    'messageList.bulkArchived.failBody_few', 'messageList.bulkArchived.failBody_many',
    'sidebar.hiddenFolders_few', 'sidebar.hiddenFolders_many',
    'admin.messageList.markReadDelaySeconds_one',
    'admin.messageList.markReadDelaySeconds_few',
    'admin.messageList.markReadDelaySeconds_many',
  ]),
  pl: new Set([
    'message.attachment_few', 'message.attachment_many',
    'messageList.bulkDeleted.title_few', 'messageList.bulkDeleted.title_many',
    'messageList.bulkDeleted.failBody_few', 'messageList.bulkDeleted.failBody_many',
    'messageList.bulkMoved.title_few', 'messageList.bulkMoved.title_many',
    'messageList.bulkMoved.failBody_few', 'messageList.bulkMoved.failBody_many',
    'messageList.bulkArchived.title_few', 'messageList.bulkArchived.title_many',
    'messageList.bulkArchived.failBody_few', 'messageList.bulkArchived.failBody_many',
    'sidebar.hiddenFolders_few', 'sidebar.hiddenFolders_many',
    'admin.messageList.markReadDelaySeconds_one',
    'admin.messageList.markReadDelaySeconds_few',
    'admin.messageList.markReadDelaySeconds_many',
  ]),
};
const LOCALE_SPECIFIC_KEYS = new Set(
  Object.values(LOCALE_SPECIFIC_KEYS_BY_LOCALE).flatMap(keys => [...keys]),
);


function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      Object.assign(out, flatten(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

function loadLocales() {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const locales = {};
  for (const file of files) {
    const lang = file.replace('.json', '');
    locales[lang] = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
  return locales;
}


// ── tests ─────────────────────────────────────────────────────────────────────

const locales = loadLocales();
const langs = Object.keys(locales).sort();
const allKeys = [...new Set(langs.flatMap(l => Object.keys(locales[l])))].filter(k => !LOCALE_SPECIFIC_KEYS.has(k)).sort();

describe('i18n locale files', () => {


  describe('key coverage — every key must appear in every locale', () => {
    for (const lang of langs) {
      it(`${lang} has no missing keys`, () => {
        const present = new Set(Object.keys(locales[lang]));
        const missing = allKeys.filter(k => !present.has(k));
        assert.equal(missing.length, 0,
          `Missing keys:\n${missing.map(k => `  - ${k}`).join('\n')}`);
      });
    }
  });


  describe('placeholders — a translation keeps the {{placeholders}} en.json uses', () => {
    // A dropped placeholder silently drops text: message.attachmentRisk.armed, for one, carries a
    // risky attachment's whole warning in {{label}}.
    it('every locale uses the same {{...}} names as en.json for the keys they share', () => {
      const names = value => [...new Set([...String(value).matchAll(/\{\{\s*([^\s},]+)[^}]*\}\}/g)].map(m => m[1]))].sort().join(', ');
      const mismatches = [];
      for (const lang of langs) {
        if (lang === 'en') continue;
        for (const [key, value] of Object.entries(locales[lang])) {
          if (!(key in locales.en) || names(value) === names(locales.en[key])) continue;
          mismatches.push(`  ${lang} ${key}: {{${names(value)}}} but en has {{${names(locales.en[key])}}}`);
        }
      }
      assert.equal(mismatches.length, 0, `Placeholders differ from en.json:\n${mismatches.join('\n')}`);
    });
  });


});

describe('Polish plural resolution', () => {
  it('selects one/few/many forms for representative Polish counts', async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'pl',
      fallbackLng: false,
      resources: {
        pl: { translation: JSON.parse(readFileSync(join(dir, 'pl.json'), 'utf8')) },
      },
      interpolation: { escapeValue: false },
    });

    const expected = new Map([
      [1, '1 załącznik'],
      [2, '2 załączniki'],
      [5, '5 załączników'],
      [21, '21 załączników'],
      [22, '22 załączniki'],
      [25, '25 załączników'],
      [101, '101 załączników'],
      [102, '102 załączniki'],
      [111, '111 załączników'],
    ]);

    for (const [count, value] of expected) {
      assert.equal(instance.t('message.attachment', { count }), value, `count=${count}`);
    }
  });
});

describe('Czech plural resolution', () => {
  it('selects one/few/other forms for representative Czech counts', async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'cs',
      fallbackLng: false,
      resources: {
        cs: { translation: JSON.parse(readFileSync(join(dir, 'cs.json'), 'utf8')) },
      },
      interpolation: { escapeValue: false },
    });

    const expected = new Map([
      [1, '1 příloha'],
      [2, '2 přílohy'],
      [4, '4 přílohy'],
      [5, '5 příloh'],
      [21, '21 příloh'],
      [22, '22 příloh'],
      [101, '101 příloh'],
    ]);

    for (const [count, value] of expected) {
      assert.equal(instance.t('message.attachment', { count }), value, `count=${count}`);
    }
  });
});
