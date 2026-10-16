// The category tabs of the INBOX bar. One source is in effect per user:
//   builtin  the five fixed categories, stored in messages.category by the ingest classifier and rules;
//   jev      Jev's own categories, read from the decision Jev recorded in the message's plugin
//            annotation. It does not depend on where the message sits, so folder moves are irrelevant.
// While Jev is activated for the user, the built-in source is inert: no tab reads messages.category.
import { jevCategoryTabs } from '../plugins/api.js';

export const BUILTIN_CATEGORY_IDS = Object.freeze(['primary', 'newsletter', 'promotion', 'automated', 'social']);
export const BUILTIN_TABS = Object.freeze({ kind: 'builtin', ids: BUILTIN_CATEGORY_IDS });

export async function categoryTabsFor(userId) {
  const categories = await jevCategoryTabs(userId);
  return categories ? { kind: 'jev', categories } : BUILTIN_TABS;
}

export const tabIds = tabs => (tabs.kind === 'jev' ? tabs.categories.map(({ id }) => id) : tabs.ids);

// SQL for a message's tab id under `tabs`; NULL when the message has no tab in that source.
export function tabExpr(tabs, alias = 'm') {
  return tabs.kind === 'jev'
    ? `(${alias}.plugin_annotations #>> '{"jev-classify",category,decision,choice}')`
    : `COALESCE(${alias}.category, 'primary')`;
}

// The folders a Jev tab view spans: INBOX, and the folder Jev physically moved a message to. Routing
// moves INBOX mail out of INBOX, and its tab must keep it. A label route ('labeled') leaves the INBOX
// copy where it is and adds a copy elsewhere, so only a 'moved' route widens the scope: that keeps each
// message to one row.
export function jevFolderScope(alias = 'm') {
  return `(${alias}.folder = 'INBOX' OR (`
    + `${alias}.plugin_annotations #>> '{"jev-classify",category,action,effect}' = 'moved' AND `
    + `${alias}.folder = ${alias}.plugin_annotations #>> '{"jev-classify",category,action,target}'))`;
}
