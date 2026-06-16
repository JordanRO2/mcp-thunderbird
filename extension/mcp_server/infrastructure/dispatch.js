"use strict";

/**
 * infrastructure/dispatch.js — JSON-RPC tool dispatch + arg validation/coercion
 * + the tool-handler registry that interface modules plug into.
 *
 * The `tools` METADATA array itself stays in api.js (a structural test parses
 * api.js source for the `{ name: "…" }` declarations and asserts their count
 * and names, so the literal array is the guarded single source of truth).
 * This module consumes that array via ctx.tools and builds the per-name
 * inputSchema lookup from it.
 *
 * Dispatch model (migration-friendly):
 *   - Interface modules register a handler with registerToolHandler(name, fn).
 *     fn receives the raw args object and returns (or awaits) the tool result.
 *   - callTool(name, args) prefers a registered handler; if none exists it
 *     delegates to ctx.legacyCallTool — the original switch in api.js that
 *     still serves every not-yet-migrated domain. This lets domains migrate to
 *     the interface layer one at a time without a flag day.
 *
 * Consumes from ctx: tools
 * Registers onto ctx:
 *   toolSchemas, validateToolArgs, coerceToolArgs,
 *   registerToolHandler, callTool, __toolHandlers
 */
module.exports = function register(ctx) {
  const { tools, validateAgainstSchema } = ctx;

  /**
   * Build a lookup from tool name to inputSchema for fast validation.
   */
  const toolSchemas = Object.create(null);
  for (const t of tools) {
    toolSchemas[t.name] = t.inputSchema;
  }

  /**
   * Validate tool arguments against the tool's inputSchema.
   * Checks required fields, types (string, number, boolean, array, object),
   * and rejects unknown properties.
   * Returns an array of error strings (empty = valid).
   */
  function validateToolArgs(name, args) {
    const schema = toolSchemas[name];
    if (!schema) return [`Unknown tool: ${name}`];

    const errors = [];
    const props = schema.properties || {};
    const required = schema.required || [];

    // Check required fields
    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        errors.push(`Missing required parameter: ${key}`);
      }
    }

    // Check types and reject unknown properties
    for (const [key, value] of Object.entries(args)) {
      // Use hasOwnProperty to prevent inherited properties like
      // 'constructor' or 'toString' from bypassing unknown-param checks.
      const propSchema = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
      if (!propSchema) {
        errors.push(`Unknown parameter: ${key}`);
        continue;
      }
      if (value === undefined || value === null) continue;

      // Array length bounds (minItems/maxItems) sit OUTSIDE validateAgainstSchema
      // (the shared schema walker in security_helpers.js intentionally does not
      // check them), so enforce them here. This keeps the batch caps (e.g.
      // getMessages maxItems) honored before the handler runs.
      if (Array.isArray(value)) {
        if (propSchema.minItems !== undefined && value.length < propSchema.minItems) {
          errors.push(`Parameter '${key}' must contain at least ${propSchema.minItems} item(s)`);
        }
        if (propSchema.maxItems !== undefined && value.length > propSchema.maxItems) {
          errors.push(`Parameter '${key}' must contain at most ${propSchema.maxItems} item(s)`);
        }
      }

      validateAgainstSchema(value, propSchema, key, errors);
    }

    return errors;
  }

  /**
   * Coerce tool arguments to match expected schema types.
   * MCP clients may send "true"/"false" as strings for booleans,
   * "50" as strings for numbers, or JSON-encoded arrays as strings.
   * Mutates and returns the args object.
   */
  function coerceToolArgs(name, args) {
    const schema = toolSchemas[name];
    if (!schema) return args;
    const props = schema.properties || {};
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      const propSchema = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
      if (!propSchema) continue;
      const expected = propSchema.type;
      if (expected === "boolean" && typeof value === "string") {
        if (value === "true") args[key] = true;
        else if (value === "false") args[key] = false;
      } else if (expected === "number" && typeof value === "string") {
        // Reject blank/whitespace strings -- Number("") is 0 which
        // would silently coerce empty input into a valid number.
        if (value.trim() === "") continue;
        const n = Number(value);
        if (Number.isFinite(n)) args[key] = n;
      } else if (expected === "integer" && typeof value === "string") {
        if (value.trim() === "") continue;
        const n = Number(value);
        if (Number.isFinite(n) && Number.isInteger(n)) args[key] = n;
      } else if (expected === "array" && typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) args[key] = parsed;
        } catch (e) {
          // Leave value as-is so validator surfaces a typed error to the client.
          console.warn(`thunderbird-mcp: coerceToolArgs JSON.parse failed for key=${key}:`, e.message);
        }
      }
    }
    return args;
  }

  // ── Tool-handler registry ──
  // Interface modules call registerToolHandler(name, fn) to own a tool.
  const __toolHandlers = Object.create(null);
  function registerToolHandler(name, fn) {
    __toolHandlers[name] = fn;
  }

  /**
   * Dispatch a tool call. A handler registered via the interface layer wins;
   * otherwise we fall back to the legacy switch (ctx.legacyCallTool) for any
   * domain not yet migrated to the interface layer.
   */
  async function callTool(name, args) {
    const handler = __toolHandlers[name];
    if (handler) {
      return await handler(args);
    }
    if (typeof ctx.legacyCallTool === "function") {
      return await ctx.legacyCallTool(name, args);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  Object.assign(ctx, {
    toolSchemas, validateToolArgs, coerceToolArgs,
    registerToolHandler, callTool, __toolHandlers,
  });
};
