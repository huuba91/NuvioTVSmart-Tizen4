const NUVIO_LIVE_SPORTS_ADDON_ID = "community.nuvio.live-sports";

function normalizedHeaders(headers = {}) {
  return Object.entries(headers && typeof headers === "object" ? headers : {}).reduce((result, [name, value]) => {
    const key = String(name || "").trim().toLowerCase();
    const text = String(value ?? "").trim();
    if (key && text) result[key] = text;
    return result;
  }, {});
}

export function buildTizenAddonHlsProxyUrl(url, { addonId = "", addonBaseUrl = "", requestHeaders = {} } = {}) {
  const sourceUrl = String(url || "").trim();
  const baseUrl = String(addonBaseUrl || "").trim();
  if (!sourceUrl || !baseUrl || String(addonId || "").trim() !== NUVIO_LIVE_SPORTS_ADDON_ID) return sourceUrl;

  try {
    const source = new URL(sourceUrl);
    const addon = new URL(baseUrl);
    if (source.origin === addon.origin && source.pathname === "/api/manifest") return sourceUrl;
    if (!/\.m3u8(?:$|[?#])/i.test(sourceUrl)) return sourceUrl;

    const headers = normalizedHeaders(requestHeaders);
    const proxy = new URL("/api/manifest", addon.origin);
    proxy.searchParams.set("url", sourceUrl);
    if (headers.referer) proxy.searchParams.set("referer", headers.referer);
    if (headers.origin) proxy.searchParams.set("origin", headers.origin);
    return proxy.toString();
  } catch (_) {
    return sourceUrl;
  }
}
