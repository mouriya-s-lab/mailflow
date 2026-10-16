// Which category switches are in effect. Jev classification (plugin activation) owns the category
// tabs while it is on: the built-in global and per-account switches are then inert, and the tabs
// show Jev's categories for every account. Mirrors backend/src/services/categoryTabs.js.

export const JEV_PLUGIN_ID = 'jev-classify';

export const BUILTIN_CATEGORY_IDS = Object.freeze(['primary', 'newsletter', 'promotion', 'automated', 'social']);

export const jevOn = enabledPlugins => enabledPlugins.includes(JEV_PLUGIN_ID);

// Whether the category tab bar and its INBOX filter apply.
export const categoryTabsOn = ({ jev, globalOn, accountOn }) => jev || globalOn || accountOn;

// Whether the built-in classifier's writes are offered: manual categorize and AI classify.
export const builtinCategoryWritesOn = ({ jev, globalOn, accountOn }) => !jev && (globalOn || accountOn);
