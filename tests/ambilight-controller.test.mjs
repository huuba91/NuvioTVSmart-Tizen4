import assert from "node:assert/strict";
import test from "node:test";
import { createAmbilightSettingsStore } from "../js/data/local/ambilightSettingsStore.js";
import { createAmbilightController } from "../js/core/ambilight/ambilightController.js";

function memoryBackend(initial) {
  const data = new Map([["ambilightSettings", initial]]);
  return {
    get: (key, fallback) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : fallback),
    set: (key, value) => data.set(key, JSON.parse(JSON.stringify(value)))
  };
}

function eventTarget(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type) {
      (listeners[type] || []).forEach((fn) => fn({ type }));
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A controller wired to fakes: fetch records the path of every request and answers like the service.
function harness({ settings = {}, fetchFails = false, slowZones = false, tizen = true } = {}) {
  const store = createAmbilightSettingsStore(
    memoryBackend({
      enabled: true,
      bulbs: [{ id: "a", name: "A", pos: "left" }],
      ...settings,
      strip: { enabled: true, ...(settings.strip || {}) }
    })
  );
  const env = { calls: [], active: true, zoneResolvers: [] };
  env.fetchImpl = (url) => {
    const path = url.replace("http://tv", "");
    env.calls.push(path);
    if (fetchFails) {
      return Promise.reject(new Error("service down"));
    }
    const answer = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, active: env.active, bulbs: [] })
    };
    if (slowZones && path.startsWith("/ambilight/zones")) {
      return new Promise((resolve) => env.zoneResolvers.push(() => resolve(answer)));
    }
    return Promise.resolve(answer);
  };
  env.doc = eventTarget({ visibilityState: "visible" });
  env.win = eventTarget();
  env.nav = {
    beacons: [],
    sendBeacon(url) {
      this.beacons.push(url.replace("http://tv", ""));
      return true;
    }
  };
  env.store = store;
  env.controller = createAmbilightController({
    fetchImpl: env.fetchImpl,
    isTizen: () => tizen,
    ensureService: async () => "http://tv",
    store,
    doc: env.doc,
    win: env.win,
    nav: env.nav,
    log: { warn() {} },
    pingIntervalMs: 15
  });
  env.paths = () => env.calls.map((path) => path.split("?")[0]);
  env.last = () => env.calls[env.calls.length - 1];
  return env;
}

test("start sends the stored configuration, then pause/resume/blackout/stop follow the player", async () => {
  const env = harness();
  const { controller } = env;
  assert.equal(await controller.start(), true);
  assert.equal(controller.isActive(), true);
  const start = env.calls.find((path) => path.startsWith("/ambilight/start"));
  assert.ok(start.includes("strip=on&stripIp=192.168.129.19&ddpPort=4048"), start);
  assert.ok(start.includes("pause=black&source=capture"), start);

  controller.pause();
  controller.pause(); // a second pause event changes nothing
  await controller.whenSettled();
  assert.equal(env.calls.filter((path) => path.startsWith("/ambilight/pause")).length, 1);
  assert.equal(env.last(), "/ambilight/pause?mode=black");
  assert.equal(controller.isPaused(), true);

  controller.resume();
  await controller.whenSettled();
  assert.equal(env.last(), "/ambilight/resume");

  controller.blackout(); // playback error
  await controller.whenSettled();
  assert.equal(env.last(), "/ambilight/blackout");

  await controller.start(); // the player plays again after recovering
  await controller.whenSettled();
  assert.equal(env.last(), "/ambilight/resume");
  assert.equal(
    env.calls.filter((path) => path.startsWith("/ambilight/start")).length,
    1,
    "no second session"
  );

  controller.stop();
  await wait(5);
  assert.equal(env.last(), "/ambilight/stop");
  assert.equal(controller.isActive(), false);
});

test("blackoutOnPause off holds the colour; changing it while paused re-sends the pause", async () => {
  const env = harness({ settings: { blackoutOnPause: false } });
  await env.controller.start();
  env.controller.pause();
  await env.controller.whenSettled();
  assert.equal(env.last(), "/ambilight/pause?mode=hold");
  env.controller.updateConfig({ blackoutOnPause: true });
  await env.controller.whenSettled();
  const tail = env.calls.slice(-2);
  assert.ok(tail[0].startsWith("/ambilight/config?") && tail[0].includes("pause=black"), tail[0]);
  assert.equal(tail[1], "/ambilight/pause?mode=black");
  env.controller.stop();
});

test("pause and blackout while starting are applied once the session runs", async () => {
  const env = harness();
  const starting = env.controller.start();
  env.controller.pause();
  assert.equal(await starting, true);
  await env.controller.whenSettled();
  assert.equal(env.last(), "/ambilight/pause?mode=black");
  env.controller.stop();
});

test("app hidden goes dark, shown again resumes (or pauses when the player is paused), exit stops", async () => {
  const env = harness();
  const { controller, doc, win } = env;
  await controller.start();
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  await controller.whenSettled();
  assert.equal(env.last(), "/ambilight/blackout");
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await controller.whenSettled();
  assert.equal(env.last(), "/ambilight/resume");

  controller.pause();
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await controller.whenSettled();
  assert.deepEqual(env.calls.slice(-3), [
    "/ambilight/pause?mode=black",
    "/ambilight/blackout",
    "/ambilight/pause?mode=black"
  ]);

  win.fire("pagehide");
  assert.deepEqual(env.nav.beacons, ["/ambilight/stop"]);
  assert.equal(controller.isActive(), false);
  win.fire("beforeunload"); // nothing left to stop
  assert.equal(env.nav.beacons.length, 1);
});

test("Tizen app exit event stops the lights", async () => {
  const env = harness();
  await env.controller.start();
  env.doc.fire("nuvio:beforeExitApp");
  assert.deepEqual(env.nav.beacons, ["/ambilight/stop"]);
});

test("ambilight failures never throw into playback", async () => {
  const env = harness({ fetchFails: true });
  const { controller } = env;
  assert.equal(await controller.start(), false);
  assert.equal(controller.isActive(), false);
  assert.doesNotThrow(() => {
    controller.pause();
    controller.resume();
    controller.blackout();
    controller.updateConfig({ strip: { ip: "10.0.0.2" } });
    controller.setLevel(50);
    controller.stop();
  });

  const broken = createAmbilightController({
    fetchImpl: () => {
      throw new Error("no fetch");
    },
    isTizen: () => true,
    ensureService: async () => {
      throw new Error("service will not start");
    },
    store: createAmbilightSettingsStore(memoryBackend({ enabled: true })),
    doc: null,
    win: null,
    nav: null,
    log: { warn() {} }
  });
  assert.equal(await broken.start(), false);
  assert.equal(
    broken.attachZoneSource({
      subscribe: () => {
        throw new Error("bad source");
      }
    }),
    false
  );
  assert.equal(broken.attachZoneSource(null), false);
});

test("nothing is sent when ambilight is off or not on the TV", async () => {
  const off = harness({ settings: { enabled: false } });
  assert.equal(await off.controller.start(), false);
  const web = harness({ tizen: false });
  assert.equal(await web.controller.start(), false);
  assert.deepEqual([...off.calls, ...web.calls], []);
});

test("a session the service dropped (watchdog) is started again on the next ping", async () => {
  const env = harness();
  await env.controller.start();
  env.active = false;
  await wait(40);
  env.active = true;
  await wait(20);
  assert.ok(env.calls.filter((path) => path.startsWith("/ambilight/start")).length >= 2);
  assert.equal(env.controller.isActive(), true);
  env.controller.stop();
});

test("updateConfig saves to the store and updates the running session live", async () => {
  const env = harness();
  await env.controller.start();
  env.controller.updateConfig({ strip: { ip: "10.0.0.9", saturation: 150 } });
  await env.controller.whenSettled();
  assert.equal(env.store.get().strip.ip, "10.0.0.9");
  assert.equal(env.store.get().strip.enabled, true, "other strip settings kept");
  assert.ok(env.last().startsWith("/ambilight/config?"));
  assert.ok(
    env.last().includes("stripIp=10.0.0.9") && env.last().includes("stripSat=150"),
    env.last()
  );
  env.controller.updateConfig({ enabled: false });
  await wait(5);
  assert.equal(env.last(), "/ambilight/stop");
  assert.equal(env.controller.isActive(), false);
});

function fakeSource() {
  const source = { listener: null, unsubscribed: false };
  source.subscribe = (listener) => {
    source.listener = listener;
    return () => {
      source.unsubscribed = true;
      source.listener = null;
    };
  };
  source.emit = (frameId, colour) =>
    source.listener?.({
      zones: Array.from({ length: 8 }, () => colour),
      frameId,
      ptsMs: frameId * 40
    });
  return source;
}

test("an attached zone source feeds the service: fresh frames only, newest wins, nothing while paused", async () => {
  const env = harness({ slowZones: true });
  const { controller } = env;
  const source = fakeSource();
  controller.attachZoneSource(source);
  await controller.start();
  assert.ok(
    env.calls.find((path) => path.startsWith("/ambilight/start")).includes("source=external")
  );

  source.emit(1, [255, 0, 0]);
  assert.equal(env.last(), "/ambilight/zones?z=" + "ff0000".repeat(8) + "&frame=1&pts=40");
  source.emit(2, [0, 255, 0]); // waits: one request out at a time
  source.emit(3, [0, 0, 255]); // replaces frame 2
  source.emit(2, [9, 9, 9]); // stale id
  assert.equal(env.calls.filter((path) => path.startsWith("/ambilight/zones")).length, 1);
  env.zoneResolvers.shift()();
  await wait(5);
  assert.equal(env.last(), "/ambilight/zones?z=" + "0000ff".repeat(8) + "&frame=2&pts=120");
  env.zoneResolvers.shift()();
  await wait(5);
  source.emit(4, [0, 0, 255]); // same colours as the last frame sent: suppressed
  assert.equal(env.calls.filter((path) => path.startsWith("/ambilight/zones")).length, 2);

  controller.pause();
  source.emit(5, [255, 255, 0]);
  await controller.whenSettled();
  assert.equal(
    env.calls.filter((path) => path.startsWith("/ambilight/zones")).length,
    2,
    "no zones while paused"
  );
  controller.resume();
  source.emit(6, [255, 255, 0]);
  assert.ok(env.last().startsWith("/ambilight/zones?z=ffff00"));
  env.zoneResolvers.shift()();

  controller.detachZoneSource();
  await controller.whenSettled();
  assert.equal(source.unsubscribed, true);
  assert.equal(env.last(), "/ambilight/config?source=capture");
  controller.stop();
});

test("start({ zoneSource }) attaches the source; attaching later switches a running session", async () => {
  const env = harness();
  await env.controller.start();
  env.controller.attachZoneSource(fakeSource());
  await env.controller.whenSettled();
  assert.equal(env.last(), "/ambilight/config?source=external");
  env.controller.stop();

  const other = harness();
  await other.controller.start({ zoneSource: fakeSource() });
  assert.ok(
    other.calls.find((path) => path.startsWith("/ambilight/start")).includes("source=external")
  );
  other.controller.stop();
});
