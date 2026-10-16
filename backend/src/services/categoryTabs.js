// The category tabs of the INBOX bar. One source is in effect per user:
//   builtin  the five fixed categories, stored in messages.category by the ingest classifier and rules;
//   jev      Jev's own categories, read from the decision Jev recorded in the message's plugin
//            annotation. It does not depend on where the message sits, so folder moves are irrelevant.
//   Jev's tabs end with `other`: mail Jev has not decided, and mail decided for a category since removed.
// While Jev is activated for the user, the built-in source is inert: no tab reads messages.category.
import { jevCategoryTabs } from '../plugins/api.js';
import { OTHER_TAB_ID } from '../plugins/jev-classify/model.js';

export const BUILTIN_CATEGORY_IDS = Object.freeze(['primary', 'newsletter', 'promotion', 'automated', 'social']);
export const BUILTIN_TABS = Object.freeze({ kind: 'builtin', ids: BUILTIN_CATEGORY_IDS });

export async function categoryTabsFor(userId) {
  const categories = await jevCategoryTabs(userId);
  return categories ? { kind: 'jev', categories } : BUILTIN_TABS;
}

// Every id a tab filter accepts under `tabs`.
export const tabIds = tabs => (tabs.kind === 'jev'
  ? [...tabs.categories.map(({ id }) => id), OTHER_TAB_ID]
  : tabs.ids);

// A message's tab id under `tabs`, as SQL plus the parameters it binds, numbered from `index`.
// Built-in: NULL reads as primary. Jev: the recorded choice when it names a current category, else
// `other` (undecided, or decided for a category since removed). The current ids are a parameter, never
// SQL text, so a category id cannot reach the query.
export function tabExpr(tabs, index, alias = 'm') {
  if (tabs.kind === 'builtin') return { sql: `COALESCE(${alias}.category, 'primary')`, params: [] };
  const choice = `${alias}.plugin_annotations #>> '{"jev-classify",category,decision,choice}'`;
  return {
    sql: `(CASE WHEN ${choice} = ANY($${index}::text[]) THEN ${choice} ELSE '${OTHER_TAB_ID}' END)`,
    params: [tabs.categories.map(({ id }) => id)],
  };
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
