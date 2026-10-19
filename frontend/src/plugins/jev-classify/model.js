// Jev classification plugin — the settings page's pure half: the editable forms of the categories
// and of an account's settings, and their parse into the request bodies of /api/jev-classify.
// The rules mirror the server's parser (backend/src/plugins/jev-classify/model.js), which stays the
// authority; checking them here keeps an invalid form from being sent at all.

export const MIN_CATEGORIES = 2;
export const MAX_CATEGORIES = 24;
export const MAX_LABEL_CHARS = 100;
export const MAX_DESCRIPTION_CHARS = 1000;
const MAX_ID_CHARS = 64;
// Not a category: the Other tab's id, which no category may take (the server rejects it too).
export const OTHER_TAB_ID = 'other';

export const isInbox = path => path.toUpperCase() === 'INBOX';

// ── Categories ────────────────────────────────────────────────────────────────
// A draft row is { key, id, label, description }: `id` is the stored id (null for a row added in
// this form, which gets one from its name when saved) and `key` is the row's identity in the
// editor, stable while the name is edited. Keys of stored rows are `saved:<id>` and keys of added
// rows `added:<n>`; ':' never occurs in a category id, so the two can never coincide.

export const categoryDrafts = categories =>
  categories.map(({ id, label, description }) => ({ key: `saved:${id}`, id, label, description }));

export const addedDraft = n => ({ key: `added:${n}`, id: null, label: '', description: '' });

// The id of a new category: the ASCII letters and digits of its name (accents dropped) in
// lowercase, words joined by '-', or 'category' when the name has none; '-2', '-3', … when that id
// is taken.
export function categoryIdFor(label, taken) {
  const base = label.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_ID_CHARS).replace(/-+$/, '') || 'category';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID_CHARS - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

// A field's problem: { kind: 'required' } | { kind: 'too_long', max }.
function textProblem(text, max) {
  if (!text) return { kind: 'required' };
  if (text.length > max) return { kind: 'too_long', max };
  return null;
}

// Draft rows → { ok: true, categories } | { ok: false, errors }, with
// errors = { size: { min, max, current } | null, rows: Record<key, { label?, description? }> }.
export function parseCategoryDrafts(drafts) {
  const size = drafts.length < MIN_CATEGORIES || drafts.length > MAX_CATEGORIES
    ? { min: MIN_CATEGORIES, max: MAX_CATEGORIES, current: drafts.length }
    : null;
  const taken = new Set([OTHER_TAB_ID, ...drafts.flatMap(draft => (draft.id === null ? [] : [draft.id]))]);
  const rows = {};
  const categories = drafts.map(draft => {
    const label = draft.label.trim();
    const description = draft.description.trim();
    const problems = {};
    const labelProblem = textProblem(label, MAX_LABEL_CHARS);
    const descriptionProblem = textProblem(description, MAX_DESCRIPTION_CHARS);
    if (labelProblem) problems.label = labelProblem;
    if (descriptionProblem) problems.description = descriptionProblem;
    if (labelProblem || descriptionProblem) rows[draft.key] = problems;
    let { id } = draft;
    if (id === null) {
      id = categoryIdFor(label, taken);
      taken.add(id);
    }
    return { id, label, description };
  });
  if (size || Object.keys(rows).length) return { ok: false, errors: { size, rows } };
  return { ok: true, categories };
}

// ── Spam judgment prompt ──────────────────────────────────────────────────────

export const MAX_SPAM_INSTRUCTIONS_CHARS = 2000;

// The editor's text → { ok: true, instructions } | { ok: false, problem }, by the rules of PUT /spam-instructions.
export function parseSpamInstructionsDraft(text) {
  const instructions = text.trim();
  if (!instructions) return { ok: false, problem: { kind: 'required' } };
  if (instructions.length > MAX_SPAM_INSTRUCTIONS_CHARS) return { ok: false, problem: { kind: 'too_long', max: MAX_SPAM_INSTRUCTIONS_CHARS } };
  return { ok: true, instructions };
}

// ── Account settings ──────────────────────────────────────────────────────────
// The form keeps the confidence as the text in its input; routing maps category ids to targets.

export const accountDraft = config => ({
  enabled: config.enabled,
  classifyNewMail: config.classifyNewMail,
  createFolders: config.createFolders,
  trainSpam: config.trainSpam,
  routingMinConfidence: String(config.routingMinConfidence),
  routing: { ...config.routing },
});

// The targets a category can be routed to: the account's processable folders (or labels), never INBOX.
export const routingTargets = folders => folders.filter(folder => !isInbox(folder));

// The draft → { ok: true, settings } (the six fields PUT /accounts/:id takes) | { ok: false, errors },
// errors = { routingMinConfidence?: true, routing: Record<categoryId, path> } where each routing
// entry is a stored target the account no longer offers. Routing of categories that no longer
// exist is dropped.
export function parseAccountDraft(draft, { categoryIds, folders }) {
  const text = draft.routingMinConfidence.trim();
  const confidence = Number(text);
  const confidenceValid = text !== '' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  const offered = new Set(routingTargets(folders));
  const routing = {};
  const unavailable = {};
  for (const id of categoryIds) {
    const target = draft.routing[id];
    if (target === undefined) continue;
    if (offered.has(target)) routing[id] = target;
    else unavailable[id] = target;
  }
  if (!confidenceValid || Object.keys(unavailable).length) {
    return { ok: false, errors: { ...(confidenceValid ? {} : { routingMinConfidence: true }), routing: unavailable } };
  }
  return {
    ok: true,
    settings: {
      enabled: draft.enabled,
      classifyNewMail: draft.classifyNewMail,
      routing,
      createFolders: draft.createFolders,
      trainSpam: draft.trainSpam,
      routingMinConfidence: confidence,
    },
  };
}
