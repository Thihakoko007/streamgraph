(function () {
  "use strict";

  var worksheetSelect = document.getElementById("worksheetSelect");
  var dateField = document.getElementById("dateField");
  var categoryField = document.getElementById("categoryField");
  var measureField = document.getElementById("measureField");
  var curveStyle = document.getElementById("curveStyle");
  var okBtn = document.getElementById("okBtn");
  var cancelBtn = document.getElementById("cancelBtn");

  var worksheets = [];
  var savedSettings = {};

  tableau.extensions.initializeDialogAsync().then(function () {
    savedSettings = tableau.extensions.settings.getAll();
    worksheets = tableau.extensions.dashboardContent.dashboard.worksheets;

    worksheetSelect.innerHTML = "";
    worksheets.forEach(function (ws) {
      var opt = document.createElement("option");
      opt.value = ws.name;
      opt.textContent = ws.name;
      worksheetSelect.appendChild(opt);
    });

    if (savedSettings.worksheetName && worksheets.some(function (w) { return w.name === savedSettings.worksheetName; })) {
      worksheetSelect.value = savedSettings.worksheetName;
    }

    if (savedSettings.curveStyle) {
      curveStyle.value = savedSettings.curveStyle;
    }

    loadFieldsForSelectedWorksheet();
  });

  worksheetSelect.addEventListener("change", loadFieldsForSelectedWorksheet);

  function loadFieldsForSelectedWorksheet() {
    var ws = worksheets.find(function (w) { return w.name === worksheetSelect.value; });
    if (!ws) return;

    ws.getSummaryDataAsync({ ignoreSelection: true, maxRows: 1 }).then(function (data) {
      var columns = data.columns; // [{fieldName, dataType, index}]

      fillSelect(dateField, columns, function (c) {
        return c.dataType === tableau.DataType.Date || c.dataType === tableau.DataType.DateTime;
      }, savedSettings.dateField);

      fillSelect(categoryField, columns, function (c) {
        return c.dataType === tableau.DataType.String || c.dataType === tableau.DataType.Bool;
      }, savedSettings.categoryField);

      fillSelect(measureField, columns, function (c) {
        return c.dataType === tableau.DataType.Int || c.dataType === tableau.DataType.Float;
      }, savedSettings.measureField);
    });
  }

  function fillSelect(selectEl, columns, preferredTest, savedValue) {
    selectEl.innerHTML = "";
    columns.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.fieldName;
      opt.textContent = c.fieldName;
      selectEl.appendChild(opt);
    });

    if (savedValue && columns.some(function (c) { return c.fieldName === savedValue; })) {
      selectEl.value = savedValue;
      return;
    }

    var preferred = columns.find(preferredTest);
    if (preferred) selectEl.value = preferred.fieldName;
  }

  okBtn.addEventListener("click", function () {
    tableau.extensions.settings.set("worksheetName", worksheetSelect.value);
    tableau.extensions.settings.set("dateField", dateField.value);
    tableau.extensions.settings.set("categoryField", categoryField.value);
    tableau.extensions.settings.set("measureField", measureField.value);
    tableau.extensions.settings.set("curveStyle", curveStyle.value);

    tableau.extensions.settings.saveAsync().then(function () {
      tableau.extensions.ui.closeDialog("saved");
    });
  });

  cancelBtn.addEventListener("click", function () {
    tableau.extensions.ui.closeDialog("cancelled");
  });
})();
