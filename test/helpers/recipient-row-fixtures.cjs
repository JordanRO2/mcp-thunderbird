"use strict";

// Real-parser cases with empty groups, standalone comments or names without an
// address. A short list keeps its original display, including those entries.
module.exports = [
  { raw: 'Empty: (no recipients);, (comment), "Display only" <>, Empty:;', mailboxes: 0 },
  { raw: 'Empty: (no recipients);, a@x, (comment), "Display only" <>', mailboxes: 1 },
  { raw: "(leading), a@x, Empty: (no recipients);, b@x, (trailing)", mailboxes: 2 },
  { raw: "Empty: (no recipients);, a@x, b@x, c@x", mailboxes: 3 },
  { raw: "Empty:; (no recipients), a@x, b@x, c@x", mailboxes: 3 },
  { raw: "a@x, b@x, c@x, (comment)", mailboxes: 3 },
  { raw: "(comment), a@x, b@x, c@x", mailboxes: 3 },
  { raw: '"Display only" <>, a@x, b@x, c@x', mailboxes: 3 },
  { raw: "  Empty: (nobody);, =?UTF-8?Q?Doe=2C_John?= <j@x>, b@x, c@x  ", mailboxes: 3 },
  {
    raw: "Empty: (no recipients);, a@x, b@x, c@x, d@x",
    mailboxes: 4, summary: "a@x, b@x, c@x (+1 more)",
  },
  {
    raw: "a@x, b@x, c@x, d@x, (comment)",
    mailboxes: 4, summary: "a@x, b@x, c@x (+1 more)",
  },
  {
    raw: "(comment), a@x, b@x, c@x, d@x",
    mailboxes: 4, summary: "a@x, b@x, c@x (+1 more)",
  },
  {
    raw: "Empty:;, a@x, b@x, c@x, d@x, Empty: (nobody);",
    mailboxes: 4, summary: "a@x, b@x, c@x (+1 more)",
  },
  {
    raw: 'Empty: (no recipients);, a@x, (comment), b@x, "Display only" <>, c@x, d@x, e@x',
    mailboxes: 5, summary: "a@x, b@x, c@x (+2 more)",
  },
  {
    raw: "Empty: (nobody);, =?UTF-8?Q?Doe=2C_John?= <j@x>, b@x, c@x, d@x, e@x, (comment)",
    mailboxes: 5, summary: '"Doe, John" <j@x>, b@x, c@x (+2 more)',
  },
];
