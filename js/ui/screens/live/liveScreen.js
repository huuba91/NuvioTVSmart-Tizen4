import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { catalogRepository } from "../../../data/repository/catalogRepository.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { collectLiveCatalogDescriptors } from "../../../core/addons/liveCatalogs.js";
import { renderLoadingIndicator } from "../../components/loadingIndicator.js";
import { activateLegacySidebarAction, bindRootSidebarEvents, getSidebarProfileState, renderRootSidebar } from "../../components/sidebarNavigation.js";

const LIVE_CATALOG_LIMIT = 16;
const LIVE_ITEMS_PER_ROW = 12;

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function liveBadgeText(item = {}) {
  const text = `${item.name || ""} ${item.description || ""}`.toLowerCase();
  return /\b(upcoming|starts?|kick[- ]?off|tomorrow)\b/.test(text) ? "UPCOMING" : "LIVE";
}

export function renderLiveContent({ loading = false, rows = [] } = {}, renderRow = () => "") {
  if (loading) {
    return `<div class="live-state live-focus-anchor focusable" data-action="waitForLiveCatalogs" tabindex="0">${renderLoadingIndicator()}<span>Finding live events…</span></div>`;
  }
  if (rows.length) {
    return rows.map((row, rowIndex) => renderRow(row, rowIndex)).join("");
  }
  return `<div class="live-state live-empty"><span class="material-icons">live_tv</span><h2>No live catalogs found</h2><p>Install or enable a live TV or sports addon, then return here.</p></div>`;
}

export class LiveScreenController {
  constructor() {
    this.container = null;
    this.rows = [];
    this.loading = false;
    this.layout = {};
    this.profile = null;
    this.loadToken = 0;
    this.boundKeyDown = (event) => this.onKeyDown(event);
  }

  async mount() {
    this.container = document.getElementById("live");
    ScreenUtils.show(this.container);
    this.loadToken += 1;
    const token = this.loadToken;
    this.loading = true;
    this.rows = [];
    this.layout = LayoutPreferences.get();
    this.profile = await getSidebarProfileState({ cacheOnly: true }).catch(() => null);
    this.render();
    document.addEventListener("keydown", this.boundKeyDown);

    const addons = await addonRepository.getInstalledAddons({ staleWhileRevalidate: true }).catch(() => []);
    const descriptors = collectLiveCatalogDescriptors(addons).slice(0, LIVE_CATALOG_LIMIT);
    const results = await Promise.all(descriptors.map(async (descriptor) => {
      const result = await catalogRepository.getCatalog({ ...descriptor, skip: 0, skipStep: 100, supportsSkip: descriptor.supportsSkip });
      return result?.status === "success" && result.data?.items?.length
        ? { ...descriptor, items: result.data.items.slice(0, LIVE_ITEMS_PER_ROW) }
        : null;
    }));
    if (token !== this.loadToken || Router.getCurrent() !== "live") return;
    this.rows = results.filter(Boolean);
    this.loading = false;
    this.render();
  }

  render() {
    if (!this.container) return;
    const content = renderLiveContent(
      { loading: this.loading, rows: this.rows },
      (row, rowIndex) => this.renderRow(row, rowIndex)
    );
    this.container.innerHTML = `<div class="home-shell live-shell">
      ${renderRootSidebar({ selectedRoute: "live", profile: this.profile, layout: this.layout })}
      <main class="home-main live-main"><header class="live-header">
        <div class="live-heading-row"><span class="live-pulse"></span><h1>Live</h1></div>
        <p>Sports, channels, and events from your installed addons.</p>
      </header><div class="live-content">${content}</div></main></div>`;
    ScreenUtils.indexFocusables(this.container);
    bindRootSidebarEvents(this.container, { currentRoute: "live" });
    this.container.querySelectorAll(".live-event-card").forEach((node) => {
      node.onclick = () => this.openItem(node);
      node.onfocus = () => node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    ScreenUtils.setInitialFocus(this.container, ".live-event-card.focusable, .live-focus-anchor.focusable, .focusable");
  }

  renderRow(row, rowIndex) {
    const cards = row.items.map((item, itemIndex) => {
      const badge = liveBadgeText(item);
      return `<article class="live-event-card focusable" data-action="openLiveDetail"
        data-item-id="${escapeHtml(item.id)}" data-item-type="${escapeHtml(item.type || row.type || "channel")}"
        data-item-title="${escapeHtml(item.name || "Live event")}" data-poster-src="${escapeHtml(item.poster || "")}"
        data-backdrop-src="${escapeHtml(item.background || "")}" data-addon-base-url="${escapeHtml(row.addonBaseUrl)}"
        data-addon-id="${escapeHtml(row.addonId)}" data-addon-name="${escapeHtml(row.addonName)}"
        data-catalog-type="${escapeHtml(row.type)}" data-index-key="${rowIndex}:${itemIndex}">
        <div class="live-event-art">${item.background || item.poster
          ? `<img src="${escapeHtml(item.background || item.poster)}" alt="" loading="lazy" decoding="async" />`
          : `<span class="material-icons live-event-placeholder">sports</span>`}
          <span class="live-event-badge ${badge.toLowerCase()}">${badge}</span></div>
        <div class="live-event-copy"><h3>${escapeHtml(item.name || "Live event")}</h3>
          <p>${escapeHtml(item.releaseInfo || row.category || row.catalogName)}</p></div></article>`;
    }).join("");
    return `<section class="live-row"><div class="live-row-heading"><h2>${escapeHtml(row.catalogName || row.category)}</h2>
      <span>${escapeHtml(row.addonName)}</span></div><div class="live-row-track">${cards}</div></section>`;
  }

  openItem(node) {
    Router.navigate("detail", {
      itemId: node.dataset.itemId, itemType: node.dataset.itemType || "channel",
      fallbackTitle: node.dataset.itemTitle || "Live event", fallbackPoster: node.dataset.posterSrc || "",
      fallbackBackground: node.dataset.backdropSrc || "", addonBaseUrl: node.dataset.addonBaseUrl || "",
      addonId: node.dataset.addonId || "", addonName: node.dataset.addonName || "",
      catalogType: node.dataset.catalogType || node.dataset.itemType || "channel"
    });
  }

  onKeyDown(event) {
    if (Router.getCurrent() !== "live") return;
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    const code = Number(event?.keyCode || 0);
    if (code !== 13 && code !== 32) return;
    event.preventDefault?.();
    const focused = this.container?.querySelector(".focusable.focused") || document.activeElement;
    const action = String(focused?.dataset?.action || "");
    if (action === "openLiveDetail") this.openItem(focused);
    else activateLegacySidebarAction(action, "live");
  }

  cleanup() {
    this.loadToken += 1;
    document.removeEventListener("keydown", this.boundKeyDown);
    ScreenUtils.hide(this.container);
    this.container = null;
  }
}

export const LiveScreen = new LiveScreenController();
