import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function installQrStub() {
  globalThis.qrcode = () => ({
    addData(value) {
      this.value = value;
    },
    make() {},
    getModuleCount() {
      return 21;
    },
    isDark(row, column) {
      return (row + column) % 2 === 0;
    },
    createDataURL(cellSize, margin) {
      return `data:image/gif;base64,stub-${cellSize}-${margin}-${this.value}`;
    }
  });
}

test("QR image fallback renders a local data URL without canvas", async () => {
  installQrStub();
  const { QrCodeGenerator } = await import("../js/core/qr/qrCodeGenerator.js");
  const image = { tagName: "IMG", src: "", width: 0, height: 0 };

  QrCodeGenerator.generate(image, "https://example.test/login", 320);

  assert.equal(image.width, 320);
  assert.equal(image.height, 320);
  assert.match(image.src, /^data:image\/gif;base64,stub-/);
  assert.match(image.src, /https:\/\/example\.test\/login$/);
});

test("bundled QR library produces a self-contained GIF for the legacy image path", async () => {
  const source = await readFile(
    new URL("../assets/libs/qrcode-generator.js", import.meta.url),
    "utf8"
  );
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.__qrcode = qrcode;`, context);
  globalThis.qrcode = context.__qrcode;
  const { QrCodeGenerator } = await import("../js/core/qr/qrCodeGenerator.js");

  const dataUrl = QrCodeGenerator.createDataUrl("https://example.test/legal-login", 320);

  assert.match(dataUrl, /^data:image\/gif;base64,/);
  assert.ok(dataUrl.length > 500, "generated GIF should contain QR pixels");
});

test("canvas renderer uses integer modules and never reads the pixel buffer", async () => {
  installQrStub();
  const { QrCodeGenerator } = await import("../js/core/qr/qrCodeGenerator.js");
  const rectangles = [];
  const context = {
    fillStyle: "",
    fillRect(...args) {
      rectangles.push(args);
    },
    getImageData() {
      throw new Error("pixel-buffer readback must not be used");
    },
    putImageData() {
      throw new Error("pixel-buffer writeback must not be used");
    }
  };
  const canvas = {
    tagName: "CANVAS",
    width: 0,
    height: 0,
    getContext(kind) {
      return kind === "2d" ? context : null;
    }
  };

  QrCodeGenerator.generate(canvas, "legal-test-payload", 320);

  assert.deepEqual(rectangles[0], [0, 0, 320, 320]);
  assert.ok(rectangles.length > 1);
  rectangles.slice(1).forEach(([x, y, width, height]) => {
    assert.ok(Number.isInteger(x));
    assert.ok(Number.isInteger(y));
    assert.ok(Number.isInteger(width));
    assert.ok(Number.isInteger(height));
  });
});

test("HTML renderer paints integer-aligned dark runs without image or canvas APIs", async () => {
  installQrStub();
  const { QrCodeGenerator } = await import("../js/core/qr/qrCodeGenerator.js");
  const documentRef = {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        ownerDocument: documentRef,
        className: "",
        attributes: {},
        children: [],
        style: { cssText: "" },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        }
      };
    }
  };
  const container = documentRef.createElement("div");
  container.innerHTML = "old content";

  const root = QrCodeGenerator.renderHtml(container, "legal-test-payload", 320);

  assert.equal(container.innerHTML, "");
  assert.equal(container.children.at(-1), root);
  assert.equal(root.className, "qr-html-grid");
  assert.match(root.style.cssText, /width:320px;height:320px/);
  assert.match(root.style.cssText, /background:#fff/);
  assert.ok(root.children.length > 0);
  root.children.forEach((run) => {
    assert.equal(run.tagName, "I");
    assert.match(run.style.cssText, /background:#000/);
    assert.match(run.style.cssText, /left:\d+px;top:\d+px;width:\d+px;height:\d+px/);
  });
});
