(function () {
  "use strict";

  var curveStyle = document.getElementById("curveStyle");
  var okBtn = document.getElementById("okBtn");
  var cancelBtn = document.getElementById("cancelBtn");

  tableau.extensions.initializeDialogAsync().then(function () {
    var savedSettings = tableau.extensions.settings.getAll();
    if (savedSettings.curveStyle) {
      curveStyle.value = savedSettings.curveStyle;
    }
  });

  okBtn.addEventListener("click", function () {
    tableau.extensions.settings.set("curveStyle", curveStyle.value);
    tableau.extensions.settings.saveAsync().then(function () {
      tableau.extensions.ui.closeDialog("saved");
    });
  });

  cancelBtn.addEventListener("click", function () {
    tableau.extensions.ui.closeDialog("cancelled");
  });
})();
