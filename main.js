(function () {
  "use strict";

  var svg = d3.select("#chart");
  var tooltip = document.getElementById("tooltip");
  var legendEl = document.getElementById("legend");
  var emptyState = document.getElementById("emptyState");
  var emptyStateMessage = document.getElementById("emptyStateMessage");
  var chartWrap = document.getElementById("chartWrap");
  var configureBtn = document.getElementById("configureBtn");
  var emptyConfigureBtn = document.getElementById("emptyConfigureBtn");

  var currentWorksheet = null;
  var dimmedKey = null;
  var lastRows = []; // cached, re-laid-out on resize

  var DIALOG_URL = "configure.html";

  function getSettings() {
    var s = tableau.extensions.settings.getAll();
    return {
      worksheetName: s.worksheetName,
      dateField: s.dateField,
      categoryField: s.categoryField,
      measureField: s.measureField,
      curveStyle: s.curveStyle || "basis"
    };
  }

  function isConfigured(s) {
    return !!(s.worksheetName && s.dateField && s.categoryField && s.measureField);
  }

  function showEmptyState(show, message) {
    if (message) emptyStateMessage.textContent = message;
    emptyState.classList.toggle("visible", show);
    chartWrap.style.display = show ? "none" : "block";
  }

  function configure() {
    tableau.extensions.ui
      .displayDialogAsync(DIALOG_URL, "", { height: 560, width: 480 })
      .then(function (closePayload) {
        if (closePayload === "saved") {
          bindWorksheetAndRender();
        }
      })
      .catch(function (error) {
        if (error.errorCode !== tableau.ErrorCodes.DialogClosedByUser) {
          console.error(error.message);
        }
      });
  }

  configureBtn.addEventListener("click", configure);
  emptyConfigureBtn.addEventListener("click", configure);

  var listenerCleanups = [];
  function clearListeners() {
    listenerCleanups.forEach(function (fn) { fn(); });
    listenerCleanups = [];
  }

  function bindWorksheetAndRender() {
    clearListeners();
    var settings = getSettings();

    if (!isConfigured(settings)) {
      showEmptyState(true);
      return;
    }

    var worksheets = tableau.extensions.dashboardContent.dashboard.worksheets;
    var ws = worksheets.find(function (w) { return w.name === settings.worksheetName; });

    if (!ws) {
      showEmptyState(true);
      return;
    }

    currentWorksheet = ws;
    showEmptyState(false);

    var refresh = function () { fetchAndRender(ws, settings); };

    listenerCleanups.push(ws.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh));
    listenerCleanups.push(ws.addEventListener(tableau.TableauEventType.FilterChanged, refresh));
    listenerCleanups.push(ws.addEventListener(tableau.TableauEventType.MarkSelectionChanged, refresh));

    refresh();
  }

  function fetchAndRender(ws, settings) {
    ws.getSummaryDataAsync({ ignoreSelection: true }).then(function (data) {
      var columns = data.columns;
      var dateCol = columns.find(function (c) { return c.fieldName === settings.dateField; });
      var catCol = columns.find(function (c) { return c.fieldName === settings.categoryField; });
      var measCol = columns.find(function (c) { return c.fieldName === settings.measureField; });

      if (!dateCol || !catCol || !measCol) {
        showEmptyState(true);
        return;
      }

      var rows = data.data.map(function (row) {
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

      lastRows = rows;
      lastCurve = settings.curveStyle;
      renderStream(rows, settings.curveStyle);
    });
  }

  var lastCurve = "basis";

  var curveMap = {
    basis: d3.curveBasis,
    natural: d3.curveNatural,
    step: d3.curveStep,
    linear: d3.curveLinear
  };

  function renderStream(rows, curveStyle) {
    if (!rows.length) {
      showEmptyState(true);
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
      .x(function (d) { return x(xIsTemporal ? d.data.__x : d.data.__x); })
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
    if (!currentWorksheet) return;
    var settings = getSettings();
    currentWorksheet
      .selectMarksByValueAsync(
        [{ fieldName: settings.categoryField, value: key }],
        tableau.SelectionUpdateType.Replace
      )
      .catch(function (err) { console.error(err.message); });
  }

  // Redraw on container resize (no-scroll, always fits its zone)
  var resizeTimer = null;
  new ResizeObserver(function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (lastRows.length) renderStream(lastRows, lastCurve);
    }, 80);
  }).observe(chartWrap);

  // initializeAsync() only resolves when a real Tableau host answers its handshake.
  // Opened standalone (e.g. double-clicked as a file, or the host is unreachable), it
  // just hangs forever with no error — which used to leave a blank white page. Show a
  // "still connecting" status if it's taking a while, but — important — never stop
  // waiting for the real promise. A slow-but-real Tableau handshake (fetching the API
  // script fresh, establishing the session) must still be allowed to succeed late and
  // take over from the timeout message; abandoning it here is what silently broke the
  // Configure button last time (it kept calling into an extension object that had, in
  // fact, gone on to initialize a few seconds after we'd already given up on it).
  var initResolved = false;
  var initTimeout = setTimeout(function () {
    if (initResolved) return;
    showEmptyState(
      true,
      "Still connecting to Tableau… If this doesn't change in a few seconds, either this " +
        "file was opened outside Tableau (expected — add it via the Extension object on a " +
        "dashboard to see it live), or Tableau can't reach tableau.github.io / your GitHub " +
        "Pages URL right now (check your network or firewall)."
    );
  }, 8000);

  tableau.extensions
    .initializeAsync({ configure: configure })
    .then(function () {
      initResolved = true;
      clearTimeout(initTimeout);
      bindWorksheetAndRender();
    })
    .catch(function (err) {
      initResolved = true;
      clearTimeout(initTimeout);
      showEmptyState(true, "Failed to initialize: " + (err && err.message ? err.message : err));
    });
})();
