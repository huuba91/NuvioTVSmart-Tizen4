const LIVE_TERMS = [
  "live", "sport", "football", "soccer", "basketball", "motorsport", "formula 1", "f1",
  "tennis", "hockey", "baseball", "cricket", "rugby", "boxing", "mma", "ufc"
];

function searchableCatalogText(addon = {}, catalog = {}) {
  return [addon.id, addon.displayName, addon.name, addon.baseUrl, catalog.id, catalog.name, catalog.apiType, catalog.type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function isLiveCatalog(addon = {}, catalog = {}) {
  const type = String(catalog.apiType || catalog.type || "").trim().toLowerCase();
  if (type === "channel") return true;
  const text = searchableCatalogText(addon, catalog);
  return LIVE_TERMS.some((term) => text.includes(term));
}

export function isLiveCatalogRow(row = {}) {
  return isLiveCatalog(
    { id: row.addonId, displayName: row.addonName, baseUrl: row.addonBaseUrl },
    { id: row.catalogId, name: row.catalogName, apiType: row.type || row.apiType }
  );
}

export function liveCatalogCategory(addon = {}, catalog = {}) {
  const text = searchableCatalogText(addon, catalog);
  const categories = [
    ["Football", ["football", "soccer"]],
    ["Motorsport", ["motorsport", "formula 1", "f1", "racing"]],
    ["Basketball", ["basketball", "nba"]],
    ["Combat sports", ["boxing", "mma", "ufc", "combat"]],
    ["Tennis", ["tennis"]], ["Hockey", ["hockey", "nhl"]],
    ["Baseball", ["baseball", "mlb"]], ["Cricket", ["cricket"]], ["Rugby", ["rugby"]]
  ];
  return categories.find(([, terms]) => terms.some((term) => text.includes(term)))?.[0] || "Live sports";
}

export function collectLiveCatalogDescriptors(addons = []) {
  const descriptors = [];
  const seen = new Set();
  (Array.isArray(addons) ? addons : []).forEach((addon) => {
    (Array.isArray(addon?.catalogs) ? addon.catalogs : []).forEach((catalog) => {
      if (!isLiveCatalog(addon, catalog)) return;
      const key = `${addon.baseUrl || ""}:${catalog.apiType || catalog.type || ""}:${catalog.id || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      descriptors.push({
        addonBaseUrl: addon.baseUrl || "", addonId: addon.id || "",
        addonName: addon.displayName || addon.name || "Live addon", catalogId: catalog.id || "",
        catalogName: catalog.name || "Live", type: catalog.apiType || catalog.type || "channel",
        category: liveCatalogCategory(addon, catalog),
        supportsSkip: Array.isArray(catalog.extra) && catalog.extra.some((entry) => String(entry?.name || entry).toLowerCase() === "skip")
      });
    });
  });
  return descriptors;
}

export function promoteLiveCatalogRows(rows = []) {
  const live = [];
  const remaining = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => (isLiveCatalogRow(row) ? live : remaining).push(row));
  return [...live, ...remaining];
}
