import assert from "node:assert/strict";
import test from "node:test";

import { nativeVideoEngine } from "../js/core/player/engines/nativeVideoEngine.js";

function createFakeVideo() {
  const children = [];
  return {
    src: "",
    loaded: false,
    removeAttribute(name) {
      if (name === "src") this.src = "";
    },
    querySelectorAll(selector) {
      return selector === "source" ? children : [];
    },
    appendChild(node) {
      children.push(node);
    },
    load() {
      this.loaded = true;
    },
    children
  };
}

test("native video engine can bypass dynamic source nodes for legacy Tizen files", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { src: "", type: "", remove() {} };
    }
  };
  try {
    const video = createFakeVideo();
    assert.equal(
      nativeVideoEngine.load(video, "https://example.test/video.mp4", "video/mp4", {
        preferDirectSrc: true
      }),
      true
    );
    assert.equal(video.src, "https://example.test/video.mp4");
    assert.equal(video.children.length, 0);
    assert.equal(video.loaded, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("native video engine retains typed source nodes by default", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { src: "", type: "", remove() {} };
    }
  };
  try {
    const video = createFakeVideo();
    assert.equal(
      nativeVideoEngine.load(video, "https://example.test/video.mpd", "application/dash+xml"),
      true
    );
    assert.equal(video.src, "");
    assert.equal(video.children.length, 1);
    assert.equal(video.children[0].src, "https://example.test/video.mpd");
    assert.equal(video.children[0].type, "application/dash+xml");
  } finally {
    globalThis.document = previousDocument;
  }
});
