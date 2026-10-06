// UI: buttons, live table, probes, report/export, remote-control focus. ES5 only.
(function (R) {
  "use strict";
  var doc = document, running = false;
  function $(id) { return doc.getElementById(id); }
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  var tbody = doc.querySelector("#results tbody");
  function rowFor(test) {
    var tr = doc.getElementById("row-" + test.id);
    if (tr) return tr;
    tr = doc.createElement("tr");
    tr.id = "row-" + test.id;
    tr.className = "nav";
    tr.tabIndex = 0;
    tr.innerHTML = "<td></td><td class='st'></td><td></td>";
    tr.cells[0].textContent = test.name;
    tbody.appendChild(tr);
    return tr;
  }
  function paint(result) {
    var tr = $("row-" + result.id);
    if (!tr) return;
    tr.cells[1].textContent = result.status;
    tr.cells[1].className = "st " + result.status;
    tr.cells[2].textContent = result.error && result.status !== "PASS" ? result.error + (result.value ? "  |  " + R.short(result.value, 140) : "") : R.short(result.value, 260) + (result.error ? "  (" + result.error + ")" : "");
  }
  function build() {
    tbody.innerHTML = "";
    R.tests.forEach(function (t) { var tr = rowFor(t); tr.cells[1].textContent = "-"; tr.cells[1].className = "st"; tr.cells[2].textContent = ""; });
  }
  function counts() {
    var c = R.counts();
    $("status").innerHTML = "Completed: " + c.done + " / " + c.total + " &middot; Timestamp: " + R.stamp();
    return c;
  }
  function showReport() {
    $("fingerprint").textContent = R.fingerprint().join("\n");
    $("report").value = JSON.stringify(R.report(), null, 1);
  }
  function summary(c) {
    $("summary").textContent = "RECON COMPLETE   Passed: " + c.PASS + "   Blocked: " + c.BLOCKED + "   Unavailable: " + c.NOT_AVAILABLE + "   Partial: " + c.PARTIAL + "   Failed: " + (c.FAIL + c.ERROR);
  }

  function runGroup(group) {
    if (running) return;
    running = true;
    $("summary").textContent = "running...";
    $("bar").style.width = "0";
    R.run(group, function (result, index, total) {
      paint(result);
      $("bar").style.width = Math.round(index / total * 100) + "%";
      counts();
    }, function () {
      running = false;
      summary(counts());
      showReport();
    });
  }

  ["all", "system", "filesystem", "process", "ipc"].forEach(function (g) { $("b-" + g).onclick = function () { runGroup(g); }; });
  $("b-clear").onclick = function () {
    if (running) return;
    R.results = {}; R.order = []; R.log = []; R.manualProbes = [];
    build(); counts();
    $("summary").textContent = ""; $("fingerprint").textContent = "(run the tests)"; $("report").value = ""; $("exported").textContent = "";
    $("probe-out").textContent = ""; $("dc-out").textContent = "";
  };

  function formatProbe(info) {
    return ["PATH     " + info.path, "EXISTS   " + (info.exists ? "YES" : "NO"), "TYPE     " + info.type, "SIZE     " + info.size, "MODIFIED " + info.modified,
      "READABLE " + (info.readable ? "YES" : "NO") + "   LISTABLE " + (info.listable ? "YES" : "NO") + "   RW-RESOLVE " + (info.writableByResolve ? "YES" : "NO"),
      info.entries ? "ENTRIES  (" + info.entryCount + ") " + info.entries.join(", ") : "", info.firstBytesHex ? "FIRST BYTES " + info.firstBytesHex + "\n         " + info.firstBytesText + (info.looksLikeJpeg ? "\n         looks like a JPEG" : "") : "",
      "ERROR    " + (info.error || "-")].filter(function (l) { return l; }).join("\n");
  }
  $("b-probe").onclick = function () {
    var path = $("probe-path").value.replace(/^\s+|\s+$/g, "");
    $("probe-out").textContent = "probing...";
    R.probePath(path, { nameLimit: 60 }, function (info) { R.manualProbes.push(info); $("probe-out").textContent = formatProbe(info); });
  };
  $("b-dc").onclick = function () {
    R.inputs.dcapturePath = $("dc-path").value.replace(/^\s+|\s+$/g, "");
    $("dc-out").textContent = "probing (about 3 s)...";
    var ids = ["dcapture.known_path", "dcapture.watch"], i = 0, text = [];
    (function next() {
      if (i >= ids.length) { $("dc-out").textContent = text.join("\n\n"); showReport(); return; }
      var id = ids[i++], test = null, j;
      for (j = 0; j < R.tests.length; j++) if (R.tests[j].id === id) test = R.tests[j];
      R.runTest(test, function (r) { paint(r); text.push(r.name + ": " + r.status + (r.error ? " (" + r.error + ")" : "") + "\n" + R.short(r.value, 700)); counts(); next(); });
    })();
  };

  function stampName() {
    var d = new Date();
    return "nu7100-recon-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".json";
  }
  // Writes the report into one virtual root; cb(message) always fires (9 s guard).
  function saveTo(root, name, body, cb) {
    var finished = false, timer = setTimeout(function () { end(root + ": no answer in 9 s"); }, 9000);
    function end(msg) { if (finished) return; finished = true; clearTimeout(timer); cb(msg); }
    R.resolveAny([root], "rw", function (error, dir) {
      if (error) { end(root + ": cannot open (" + error + ")"); return; }
      try {
        var file = dir.createFile(name);
        file.openStream("w", function (stream) {
          try { stream.write(body); stream.close(); end(root + ": SAVED as " + (R.safe(function () { return file.toURI(); }) || file.fullPath) + "  (virtual path " + file.fullPath + ")"); }
          catch (e) { end(root + ": write failed (" + R.errText(e) + ")"); }
        }, function (e2) { end(root + ": open failed (" + R.errText(e2) + ")"); }, "w");
      } catch (e3) { end(root + ": create failed (" + R.errText(e3) + ")"); }
    });
  }
  $("b-export").onclick = function () {
    showReport();
    var name = stampName(), body = $("report").value, lines = ["EXPORT " + name + " (" + body.length + " bytes)"], roots = ["documents", "wgt-private", "wgt-private-tmp", "downloads", "file:///tmp", "file:///dev/shm"], i = 0;
    $("exported").textContent = lines.join("\n") + "\nsaving...";
    (function next() {
      if (i >= roots.length) {
        lines.push("The same JSON is in the REPORT box at the bottom of the page (press the DOWN arrow to reach it).");
        $("exported").textContent = lines.join("\n");
        return;
      }
      saveTo(roots[i++], name, body, function (msg) { lines.push(msg); $("exported").textContent = lines.join("\n") + "\nsaving..."; next(); });
    })();
  };

  // remote control: arrows move the focus, BACK exits
  doc.addEventListener("keydown", function (e) {
    var k = e.keyCode, items, idx, step = 0;
    if (k === 10009) { try { window.tizen.application.getCurrentApplication().exit(); } catch (x) { /* ignore */ } return; }
    if (k === 38 || k === 37) step = -1; else if (k === 40 || k === 39) step = 1; else return;
    items = doc.querySelectorAll(".nav");
    idx = Array.prototype.indexOf.call(items, doc.activeElement);
    idx = Math.max(0, Math.min(items.length - 1, idx + step));
    items[idx].focus();
    e.preventDefault();
  });
  try { window.tizen.tvinputdevice.registerKey("ColorF0Red"); } catch (e) { /* not needed */ }

  build();
  counts();
  $("b-all").focus();
})(Recon);
