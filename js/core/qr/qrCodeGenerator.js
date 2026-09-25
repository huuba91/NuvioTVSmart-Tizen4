// js/core/qr/qrCodeGenerator.js
/* global qrcode */

export const QrCodeGenerator = {
  create(content) {
    if (typeof qrcode !== "function") {
      throw new Error("QR code library is unavailable");
    }
    const qr = qrcode(0, "M");
    qr.addData(String(content || ""));
    qr.make();
    return qr;
  },

  getLayout(qr, size) {
    const requestedSize = Math.max(1, Math.floor(Number(size) || 512));
    const moduleCount = qr.getModuleCount();
    const quietZoneModules = 4;
    const totalModules = moduleCount + quietZoneModules * 2;
    const moduleSize = Math.max(1, Math.floor(requestedSize / totalModules));
    const renderedSize = moduleCount * moduleSize;
    const margin = Math.max(
      quietZoneModules * moduleSize,
      Math.floor((requestedSize - renderedSize) / 2)
    );

    return { requestedSize, moduleCount, moduleSize, margin };
  },

  createDataUrl(content, size = 512) {
    const qr = this.create(content);
    const { moduleSize, margin } = this.getLayout(qr, size);
    if (typeof qr.createDataURL !== "function") {
      throw new Error("QR code image fallback is unavailable");
    }
    return qr.createDataURL(moduleSize, margin);
  },

  renderHtml(container, content, size = 512) {
    if (!container) {
      throw new Error("QR code container is required");
    }
    const documentRef =
      container.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!documentRef || typeof documentRef.createElement !== "function") {
      throw new Error("HTML document is unavailable");
    }

    const qr = this.create(content);
    const { requestedSize, moduleCount, moduleSize, margin } = this.getLayout(qr, size);
    const root = documentRef.createElement("div");
    root.className = "qr-html-grid";
    root.setAttribute("role", "img");
    root.style.cssText =
      `position:relative;display:block;width:${requestedSize}px;height:${requestedSize}px;` +
      "overflow:hidden;background:#fff;";
    let runCount = 0;
    let darkModuleCount = 0;

    // Render one ordinary HTML element per horizontal dark run. This avoids
    // every image, SVG, and Canvas path while keeping the DOM reasonably small.
    for (let row = 0; row < moduleCount; row++) {
      let column = 0;
      while (column < moduleCount) {
        if (!qr.isDark(row, column)) {
          column += 1;
          continue;
        }
        const runStart = column;
        while (column < moduleCount && qr.isDark(row, column)) {
          column += 1;
        }
        const runLength = column - runStart;
        const run = documentRef.createElement("div");
        run.setAttribute("aria-hidden", "true");
        run.style.cssText =
          `position:absolute;display:block;left:${margin + runStart * moduleSize}px;` +
          `top:${margin + row * moduleSize}px;width:${runLength * moduleSize}px;` +
          `height:${moduleSize}px;background:#000;`;
        root.appendChild(run);
        runCount += 1;
        darkModuleCount += runLength;
      }
    }

    root.dataset.moduleCount = String(moduleCount);
    root.dataset.darkModuleCount = String(darkModuleCount);
    root.dataset.runCount = String(runCount);

    container.innerHTML = "";
    container.appendChild(root);
    return root;
  },

  generate(target, content, size = 512) {
    if (!target) {
      throw new Error("QR code target is required");
    }

    // A GIF data URL avoids Canvas pixel-buffer readback. That path is used
    // by the Tizen 4 authentication screen because Chromium 56 firmware can
    // leave a canvas visually blank after getImageData()/putImageData().
    if (String(target.tagName || "").toLowerCase() === "img") {
      target.width = Math.max(1, Math.floor(Number(size) || 512));
      target.height = target.width;
      target.src = this.createDataUrl(content, target.width);
      return target;
    }

    const qr = this.create(content);
    const { requestedSize, moduleCount, moduleSize, margin } = this.getLayout(qr, size);
    const ctx = target.getContext?.("2d");
    if (!ctx) {
      throw new Error("2D canvas is unavailable");
    }

    target.width = requestedSize;
    target.height = requestedSize;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, requestedSize, requestedSize);
    ctx.fillStyle = "#000000";

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(
            margin + col * moduleSize,
            margin + row * moduleSize,
            moduleSize,
            moduleSize
          );
        }
      }
    }
    return target;
  }
};
