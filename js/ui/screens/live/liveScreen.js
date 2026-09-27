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
export const LIVE_INITIAL_FOCUS_SELECTOR = ".live-event-card.focusable, .live-focus-anchor.focusable";

export function resolveLiveGridMove({ row = 0, col = 0, direction = "", rowLengths = [] } = {}) {
  const currentRow = Math.max(0, Number(row) || 0);
  const currentCol = Math.max(0, Number(col) || 0);
  const lengths = Array.isArray(rowLengths) ? rowLengths.map((value) => Math.max(0, Number(value) || 0)) : [];
  if (direction === "left") {
    return currentCol > 0 ? { zone: "content", row: currentRow, col: currentCol - 1 } : { zone: "sidebar" };
  }
  if (direction === "right") {
    return currentCol + 1 < (lengths[currentRow] || 0)
      ? { zone: "content", row: currentRow, col: currentCol + 1 }
      : null;
  }
  const rowDelta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!rowDelta) return null;
  const targetRow = currentRow + rowDelta;
  const targetLength = lengths[targetRow] || 0;
  if (targetRow < 0 || targetRow >= lengths.length || !targetLength) return null;
  return { zone: "content", row: targetRow, col: Math.min(currentCol, targetLength - 1) };
}

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
  return `<div class="live-state live-empty live-focus-anchor focusable" data-action="waitForLiveCatalogs" tabindex="0"><span class="material-icons">live_tv</span><h2>No live catalogs found</h2><p>Install or enable a live TV or sports addon, then return here.</p></div>`;
}

export class LiveScreenController {
  constructor() {
    this.container = null;
    this.rows = [];
    this.loading = false;
    this.layout = {};
    this.profile = null;
    this.loadToken = 0;
    this.lastContentFocus = { row: 0, col: 0 };
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
      node.onfocus = () => {
        this.lastContentFocus = {
          row: Math.max(0, Number(node.dataset.liveRow || 0)),
          col: Math.max(0, Number(node.dataset.liveCol || 0))
        };
        node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };
    });
    // Do not append a generic `.focusable` fallback here. querySelector() uses
    // document order, not selector-list order, so the earlier profile button
    // would win over Live content and receive the Enter event that opened this
    // route on older Tizen remotes.
    ScreenUtils.setInitialFocus(this.container, LIVE_INITIAL_FOCUS_SELECTOR);
  }

  renderRow(row, rowIndex) {
    const cards = row.items.map((item, itemIndex) => {
      const badge = liveBadgeText(item);
      return `<article class="live-event-card focusable" data-action="openLiveDetail"
        data-item-id="${escapeHtml(item.id)}" data-item-type="${escapeHtml(item.type || row.type || "channel")}"
        data-item-title="${escapeHtml(item.name || "Live event")}" data-poster-src="${escapeHtml(item.poster || "")}"
        data-backdrop-src="${escapeHtml(item.background || "")}" data-addon-base-url="${escapeHtml(row.addonBaseUrl)}"
        data-addon-id="${escapeHtml(row.addonId)}" data-addon-name="${escapeHtml(row.addonName)}"
        data-catalog-type="${escapeHtml(row.type)}" data-index-key="${rowIndex}:${itemIndex}"
        data-live-row="${rowIndex}" data-live-col="${itemIndex}">
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

  focusNode(node, { scroll = true } = {}) {
    if (!node) return false;
    this.container?.querySelectorAll(".focusable.focused").forEach((item) => item.classList.remove("focused"));
    node.classList.add("focused");
    try {
      node.focus({ preventScroll: true });
    } catch (_) {
      node.focus?.();
    }
    if (scroll) node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  }

  getContentTarget(row, col) {
    return this.container?.querySelector(
      `.live-event-card[data-live-row="${Math.max(0, Number(row) || 0)}"][data-live-col="${Math.max(0, Number(col) || 0)}"]`
    ) || null;
  }

  focusLiveSidebar() {
    const target =
      this.container?.querySelector(".home-sidebar .home-nav-item.selected") ||
      this.container?.querySelector(".modern-sidebar-panel .modern-sidebar-nav-item.selected") ||
      this.container?.querySelector(".home-sidebar .focusable, .modern-sidebar-panel .focusable");
    return this.focusNode(target, { scroll: false });
  }

  handleLiveDpad(event) {
    const code = Number(event?.keyCode || 0);
    const direction = code === 37 ? "left" : code === 39 ? "right" : code === 38 ? "up" : code === 40 ? "down" : "";
    if (!direction) return false;

    const focused = this.container?.querySelector(".focusable.focused") || document.activeElement;
    const card = focused?.matches?.(".live-event-card") ? focused : null;
    const inSidebar = Boolean(focused?.closest?.(".home-sidebar, .modern-sidebar-panel"));
    event.preventDefault?.();

    if (inSidebar) {
      if (direction === "right") {
        const target = this.getContentTarget(this.lastContentFocus.row, this.lastContentFocus.col) ||
          this.container?.querySelector(LIVE_INITIAL_FOCUS_SELECTOR);
        this.focusNode(target);
      }
      return true;
    }
    if (!card) {
      if (direction === "left") this.focusLiveSidebar();
      return true;
    }

    const rowLengths = Array.from(this.container?.querySelectorAll(".live-row") || []).map(
      (rowNode) => rowNode.querySelectorAll(".live-event-card").length
    );
    const result = resolveLiveGridMove({
      row: card.dataset.liveRow,
      col: card.dataset.liveCol,
      direction,
      rowLengths
    });
    if (result?.zone === "sidebar") return this.focusLiveSidebar();
    if (result?.zone === "content") return this.focusNode(this.getContentTarget(result.row, result.col));
    return true;
  }

  onKeyDown(event) {
    if (Router.getCurrent() !== "live") return;
    if (this.handleLiveDpad(event)) return;
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
    ScreenUtils.hide(this.container);
    this.container = null;
  }
}

export const LiveScreen = new LiveScreenController();
