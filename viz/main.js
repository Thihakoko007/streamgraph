(function () {
  "use strict";

  var emptyState = document.getElementById("emptyState");
  var emptyStateMessage = document.getElementById("emptyStateMessage");
  var chartWrap = document.getElementById("chartWrap");

  // Surface anything that goes wrong directly on screen — same reasoning as the
  // dashboard-extension build: Tableau's embedded webview is hard to open devtools on.
  function showFatalError(message) {
    if (emptyStateMessage) emptyStateMessage.textContent = message;
    if (emptyState) emptyState.classList.add("visible");
    if (chartWrap) chartWrap.style.display = "none";
  }

  window.addEventListener("error", function (e) {
    showFatalError("Script error: " + (e && e.message ? e.message : "unknown error") + (e && e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : ""));
  });

  if (window.__scriptLoadError) {
    showFatalError(window.__scriptLoadError);
    return;
  }
  if (typeof d3 === "undefined") {
    showFatalError("D3 didn't load (window.d3 is undefined), but no script error fired — check the network tab for lib/d3.min.js.");
    return;
  }
  if (typeof tableau === "undefined") {
    showFatalError("The Tableau Extensions API didn't load (window.tableau is undefined), but no script error fired — check the network tab for lib/tableau.extensions.1.latest.js.");
    return;
  }

  var svg = d3.select("#chart");
  var tooltip = document.getElementById("tooltip");
  var legendEl = document.getElementById("legend");
  var configureBtn = document.getElementById("configureBtn");

  var currentWorksheet = null;
  var currentCategoryFieldName = null;
  var dimmedKey = null;
  var lastRows = []; // cached, re-laid-out on resize

  var DIALOG_URL = "configure.html";

  function getCurveStyle() {
    var s = tableau.extensions.settings.getAll();
    return s.curveStyle || "basis";
  }

  function showEmptyState(show, message) {
    if (message) emptyStateMessage.textContent = message;
    emptyState.classList.toggle("visible", show);
    chartWrap.style.display = show ? "none" : "block";
  }

  function configure() {
    try {
      tableau.extensions.ui
        .displayDialogAsync(DIALOG_URL, "", { height: 260, width: 420 })
        .then(function (closePayload) {
          if (closePayload === "saved" && lastRows.length) {
            renderStream(lastRows, getCurveStyle());
          }
        })
        .catch(function (error) {
          if (error && error.errorCode === tableau.ErrorCodes.DialogClosedByUser) return;
          showEmptyState(true, "Couldn't open the settings dialog: " + (error && error.message ? error.message : error));
        });
    } catch (err) {
      showEmptyState(true, "Configure failed before it could open a dialog: " + err.message);
    }
  }

  configureBtn.addEventListener("click", configure);

  // --- Reading the fields the user dropped on the Date / Category / Measure
  // encoding boxes on the Marks card, then the actual data behind them. ---

  function getEncodingFieldNames(visualSpec) {
    var marksSpec = visualSpec.marksSpecifications[visualSpec.activeMarksSpecificationIndex];
    var encodings = (marksSpec && marksSpec.encodings) || [];
    var byId = {};
    encodings.forEach(function (enc) {
      if (enc && enc.field && enc.field.name) byId[enc.id] = enc.field.name;
    });
    return {
      date: byId.date,
      category: byId.category,
      measure: byId.measure
    };
  }

  function refresh() {
    if (!currentWorksheet) return;

    currentWorksheet
      .getVisualSpecificationAsync()
      .then(function (visualSpec) {
        var fieldNames = getEncodingFieldNames(visualSpec);

        if (!fieldNames.date || !fieldNames.category || !fieldNames.measure) {
          var missing = [];
          if (!fieldNames.date) missing.push("Date");
          if (!fieldNames.category) missing.push("Category");
          if (!fieldNames.measure) missing.push("Measure");
          showEmptyState(
            true,
            "Drag a field onto the " + missing.join(", ") + " box" + (missing.length > 1 ? "es" : "") +
              " on the Marks card to draw the stream."
          );
          return;
        }

        currentCategoryFieldName = fieldNames.category;

        return currentWorksheet.getSummaryDataReaderAsync().then(function (reader) {
          return reader
            .getAllPagesAsync()
            .then(function (dataTable) {
              return dataTable;
            })
            .finally(function () {
              return reader.releaseAsync();
            });
        }).then(function (dataTable) {
          var columns = dataTable.columns;
          var dateCol = columns.find(function (c) { return c.fieldName === fieldNames.date; });
          var catCol = columns.find(function (c) { return c.fieldName === fieldNames.category; });
          var measCol = columns.find(function (c) { return c.fieldName === fieldNames.measure; });

          if (!dateCol || !catCol || !measCol) {
            showEmptyState(true, "Couldn't find the Date/Category/Measure fields in the returned data — try re-dropping them on the Marks card.");
            return;
          }

          var rows = dataTable.data.map(function (row) {
            var rawDate = row[dateCol.index].value;
            var parsed = new Date(rawDate);
            var xIsTemporal = !isNaN(parsed.getTime());
            return {
              x: xIsTemporal ? parsed : row[dateCol.index].formattedValue,
              xIsTemporal: xIsTemporal,
              category: row[catCol.index].formattedValue,
              value: +row[measCol.index].nativeValue || 0
            };
          });

          showEmptyState(false);
          lastRows = rows;
          renderStream(rows, getCurveStyle());
        });
      })
      .catch(function (err) {
        showEmptyState(true, "Couldn't read data from the worksheet: " + (err && err.message ? err.message : err));
      });
  }

  var curveMap = {
    basis: d3.curveBasis,
    natural: d3.curveNatural,
    step: d3.curveStep,
    linear: d3.curveLinear
  };

  function renderStream(rows, curveStyle) {
    if (!rows.length) {
      showEmptyState(true, "No data returned for the current Date / Category / Measure fields.");
      return;
    }

    var rect = chartWrap.getBoundingClientRect();
    var width = Math.max(rect.width, 50);
    var height = Math.max(rect.height, 50);
    var margin = { top: 16, right: 16, bottom: 26, left: 16 };

    svg.attr("viewBox", "0 0 " + width + " " + height);
    svg.attr("preserveAspectRatio", "none");
    svg.selectAll("*").remove();

    var xIsTemporal = rows[0].xIsTemporal;

    var categories = Array.from(new Set(rows.map(function (d) { return d.category; })));
    var xValues = Array.from(new Set(rows.map(function (d) { return xIsTemporal ? +d.x : d.x; })));
    xValues.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });

    // pivot into one row per x, one column per category
    var byX = new Map();
    xValues.forEach(function (xv) {
      var obj = { __x: xIsTemporal ? new Date(xv) : xv };
      categories.forEach(function (c) { obj[c] = 0; });
      byX.set(xv, obj);
    });
    rows.forEach(function (d) {
      var key = xIsTemporal ? +d.x : d.x;
      var obj = byX.get(key);
      if (obj) obj[d.category] = (obj[d.category] || 0) + d.value;
    });
    var pivoted = xValues.map(function (xv) { return byX.get(xv); });

    var stackGen = d3.stack()
      .keys(categories)
      .order(d3.stackOrderInsideOut)
      .offset(d3.stackOffsetWiggle);
    var series = stackGen(pivoted);

    var x = xIsTemporal
      ? d3.scaleUtc().domain(d3.extent(pivoted, function (d) { return d.__x; })).range([margin.left, width - margin.right])
      : d3.scalePoint().domain(pivoted.map(function (d) { return d.__x; })).range([margin.left, width - margin.right]).padding(0.5);

    var yMin = d3.min(series, function (s) { return d3.min(s, function (d) { return d[0]; }); });
    var yMax = d3.max(series, function (s) { return d3.max(s, function (d) { return d[1]; }); });
    var y = d3.scaleLinear().domain([yMin, yMax]).nice().range([height - margin.bottom, margin.top]);

    var color = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);

    var area = d3.area()
      .x(function (d) { return x(d.data.__x); })
      .y0(function (d) { return y(d[0]); })
      .y1(function (d) { return y(d[1]); })
      .curve(curveMap[curveStyle] || d3.curveBasis);

    var g = svg.append("g");

    g.selectAll("path.stream-path")
      .data(series)
      .join("path")
      .attr("class", "stream-path")
      .attr("d", area)
      .attr("fill", function (d) { return color(d.key); })
      .classed("dimmed", function (d) { return dimmedKey && dimmedKey !== d.key; })
      .on("mousemove", function (event, d) {
        showTooltip(event, d.key, pivoted, x, xIsTemporal);
      })
      .on("mouseleave", function () { tooltip.hidden = true; })
      .on("click", function (event, d) { selectCategory(d.key); });

    // x axis
    var axisG = svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (height - margin.bottom) + ")");
    if (xIsTemporal) {
      axisG.call(d3.axisBottom(x).ticks(Math.max(width / 90, 2)));
    } else {
      axisG.call(d3.axisBottom(x));
    }

    renderLegend(categories, color);
  }

  function showTooltip(event, key, pivoted, x, xIsTemporal) {
    var wrapRect = chartWrap.getBoundingClientRect();
    var mx = event.clientX - wrapRect.left;
    var bisect = xIsTemporal ? d3.bisector(function (d) { return d.__x; }).left : null;

    var nearest;
    if (xIsTemporal) {
      var x0 = x.invert(mx);
      var idx = bisect(pivoted, x0);
      nearest = pivoted[Math.min(Math.max(idx, 0), pivoted.length - 1)];
    } else {
      var closestDist = Infinity;
      pivoted.forEach(function (d) {
        var dist = Math.abs(x(d.__x) - mx);
        if (dist < closestDist) { closestDist = dist; nearest = d; }
      });
    }

    if (!nearest) return;

    var label = xIsTemporal ? d3.timeFormat("%b %Y")(nearest.__x) : nearest.__x;
    tooltip.innerHTML = "<strong>" + key + "</strong><br/>" + label + ": " + d3.format(",.0f")(nearest[key] || 0);
    tooltip.style.left = mx + "px";
    tooltip.style.top = (event.clientY - chartWrap.getBoundingClientRect().top - 8) + "px";
    tooltip.hidden = false;
  }

  function renderLegend(categories, color) {
    legendEl.innerHTML = "";
    categories.forEach(function (cat) {
      var item = document.createElement("div");
      item.className = "legend-item" + (dimmedKey && dimmedKey !== cat ? " dimmed" : "");
      var swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = color(cat);
      var label = document.createElement("span");
      label.textContent = cat;
      item.appendChild(swatch);
      item.appendChild(label);
      item.addEventListener("mouseenter", function () { setDimmed(cat); });
      item.addEventListener("mouseleave", function () { setDimmed(null); });
      item.addEventListener("click", function () { selectCategory(cat); });
      legendEl.appendChild(item);
    });
  }

  function setDimmed(key) {
    dimmedKey = key;
    d3.selectAll("path.stream-path").classed("dimmed", function (d) { return dimmedKey && dimmedKey !== d.key; });
    d3.selectAll(".legend-item").classed("dimmed", function (_, i, nodes) {
      return dimmedKey && nodes[i].textContent.trim() !== dimmedKey;
    });
  }

  function selectCategory(key) {
    if (!currentWorksheet || !currentCategoryFieldName) return;
    currentWorksheet
      .selectMarksByValueAsync(
        [{ fieldName: currentCategoryFieldName, value: key }],
        tableau.SelectionUpdateType.Replace
      )
      .catch(function (err) { console.error(err.message); });
  }

  // Redraw on container resize (no-scroll, always fits its zone)
  var resizeTimer = null;
  new ResizeObserver(function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (lastRows.length) renderStream(lastRows, getCurveStyle());
    }, 80);
  }).observe(chartWrap);

  // Same reasoning as the dashboard-extension build: initializeAsync() only resolves
  // when a real Tableau host answers its handshake. Show a "still connecting" status if
  // it's taking a while, but never stop waiting for the real promise — a slow-but-real
  // handshake must still be allowed to succeed late and take over from the timeout message.
  var initResolved = false;
  var initTimeout = setTimeout(function () {
    if (initResolved) return;
    showEmptyState(
      true,
      "Still connecting to Tableau… If this doesn't change in a few seconds, either this " +
        "file was opened outside Tableau (expected — this only works added as a mark type " +
        "from the Marks card in Tableau 2024.2+), or Tableau can't reach your GitHub Pages " +
        "URL right now (check your network or firewall)."
    );
  }, 8000);

  try {
    tableau.extensions
      .initializeAsync({ configure: configure })
      .then(function () {
        initResolved = true;
        clearTimeout(initTimeout);
        currentWorksheet = tableau.extensions.worksheetContent.worksheet;
        currentWorksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
        refresh();
      })
      .catch(function (err) {
        initResolved = true;
        clearTimeout(initTimeout);
        showEmptyState(true, "Failed to initialize: " + (err && err.message ? err.message : err));
      });
  } catch (err) {
    initResolved = true;
    clearTimeout(initTimeout);
    showEmptyState(true, "initializeAsync threw synchronously: " + err.message);
  }
})();
