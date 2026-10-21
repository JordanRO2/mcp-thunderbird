"use strict";

// Searched isToolEnabled/getToolAccessConfig/onToolChange: they independently
// interpreted the deny-list. Share effective access between the Experiment and
// Options, while callers retain each tool's own configured preference.
// Classic script: loadSubScript binds `this` to its supplied scope; the
// Options page binds it to the window. No preference or DOM access lives here.
this.ToolAccess = (() => {
  const dependencies = Object.freeze({ dryRunCompose: Object.freeze(["sendMail"]) });
  function isEnabled(name, disabled, undisableable, visiting = new Set()) {
    if (undisableable.has(name)) return true;
    if (disabled.includes("__all__") || disabled.includes(name) || visiting.has(name)) return false;
    const parents = Object.hasOwn(dependencies, name) ? dependencies[name] : [];
    const next = new Set(visiting).add(name);
    return parents.every(parent => isEnabled(parent, disabled, undisableable, next));
  }
  return Object.freeze({ dependencies, isEnabled });
})();
