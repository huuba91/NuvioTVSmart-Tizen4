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
