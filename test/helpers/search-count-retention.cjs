"use strict";

// Mirrors S13's message-header-retention.cjs driver: production snippets arrive
// on stdin, and only WeakRefs to fresh native-handle stand-ins survive allocation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const CHECKED_YIELDS = 3;
const GC_ATTEMPTS = 20;
const ACCOUNT_KEY = "account1";
const scenario = process.argv[2];
const distinctFolders = scenario === "many-folders";
const tracked = [];
const folders = new Map();
const server = { type: "imap" };
const account = { key: ACCOUNT_KEY, incomingServer: server };
const state = { rows: 0, databases: 0, headers: 0, yields: 0, resume: null, settled: false };

function messageId(key) { return `m-${key}@example.test`; }

function track(handle, label) {
  tracked.push({ ref: new WeakRef(handle), label });
  return handle;
}

// Shared methods stay outside allocation frames so fixture callbacks cannot
// accidentally retain a database or header through their enclosing scope.
function containsKey(key) {
  return Number.isInteger(key) && key > 0 && key <= state.rows &&
    (!distinctFolders || this.folder.key === key);
}

function getMsgHdrForKey(key) {
  assert.ok(containsKey.call(this, key));
  state.headers++;
  return track({ messageKey: key, messageId: messageId(key), flags: 0 }, `header ${state.headers}`);
}

function getDatabase() {
  state.databases++;
  return track({ folder: this, containsKey, getMsgHdrForKey }, `database ${state.databases}`);
}

function makeFolder(key) {
  const folder = { URI: `imap://${ACCOUNT_KEY}/Folder-${key}`, server, key };
  Object.defineProperty(folder, "msgDatabase", { get: getDatabase });
  folders.set(folder.URI, folder);
  return folder;
}

class FakeDate extends Date {
  static now() { return 0; }
}

function dispatchToMainThread(resolve) {
  assert.equal(state.resume, null, "Only one production yield may be pending");
  state.yields++;
  state.resume = resolve;
}

function progress() {
  return { databases: state.databases, headers: state.headers, yields: state.yields, tracked: tracked.length };
}

async function assertCollected(checkpoint, assertPending) {
  let survivors;
  for (let attempt = 0; attempt < GC_ATTEMPTS; attempt++) {
    // WeakRef construction/deref keeps targets alive for the current job. Cross
    // a turn before GC, and retain only labels after each collection attempt.
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    if (assertPending) assertPending();
    survivors = tracked.filter(({ ref }) => ref.deref() !== undefined).map(({ label }) => label);
    if (survivors.length === 0) return;
  }
  assert.fail(`${scenario} ${checkpoint}: retained handles: ${survivors.join(", ")}`);
}

function releaseYield() {
  const resolve = state.resume;
  state.resume = null;
  resolve();
}

async function main() {
  assert.ok(scenario === "single-folder" || distinctFolders);
  assert.equal(typeof global.gc, "function", "Child requires --expose-gc");
  const runtime = vm.createContext({
    Date: FakeDate,
    Services: { prefs: { getBoolPref: () => false }, tm: { dispatchToMainThread } },
    Ci: { nsMsgMessageFlags: { Expunged: 0x8 } },
    MailServices: {
      folderLookup: { getFolderForURL: uri => folders.get(uri) },
      accounts: { findAccountForServer: candidate => candidate === server ? account : null },
    },
    isAccountAllowed: () => true,
    getAllowedAccountIds: () => [ACCOUNT_KEY],
  });
  vm.runInContext(fs.readFileSync(0, "utf8"), runtime, { filename: "api-search-count-retention.js" });
  const chunkSize = vm.runInContext("SEARCH_YIELD_EVERY", runtime);
  const deadline = vm.runInContext("SEARCH_TIME_BUDGET_MS", runtime);
  assert.ok(Number.isInteger(chunkSize) && chunkSize > 1);
  state.rows = CHECKED_YIELDS * chunkSize + 1;
  const sharedFolder = distinctFolders ? null : makeFolder(0);
  const rows = Array.from({ length: state.rows }, (_, index) => {
    const key = index + 1;
    return { id: messageId(key), folderPath: (sharedFolder || makeFolder(key)).URI, _messageKey: key, _dateTs: key };
  });
  const pending = runtime.finishSearchResults(rows, 0, 0, "asc", true, true, { deadline, truncated: false });
  // Keep the operation and continuation alive throughout GC, recording failures
  // without an unhandled rejection while the driver withholds the next turn.
  const completion = pending.then(value => {
    state.settled = true;
    return { value };
  }).catch(error => {
    state.settled = true;
    return { error };
  });

  let checkedYields = 0;
  for (let yieldNumber = 1; yieldNumber <= CHECKED_YIELDS; yieldNumber++) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.settled, false, "Validation must still be pending");
    assert.equal(typeof state.resume, "function", "Production must be suspended at a yield");
    assert.equal(state.yields, yieldNumber);
    assert.equal(state.headers, yieldNumber * chunkSize);
    assert.equal(state.databases, distinctFolders ? state.headers : yieldNumber);
    assert.equal(tracked.length, state.databases + state.headers);

    const before = progress();
    const resolver = state.resume;
    await assertCollected(`yield ${yieldNumber}`, () => {
      assert.equal(state.settled, false, "GC must happen while validation is pending");
      assert.equal(state.resume, resolver, "The production yield must remain unresolved");
      assert.deepEqual(progress(), before, "No validation progress is allowed during GC");
    });
    checkedYields++;
    releaseYield();
  }

  const outcome = await completion;
  if (outcome.error) throw outcome.error;
  assert.equal(state.settled, true);
  assert.equal(state.resume, null);
  assert.equal(state.yields, CHECKED_YIELDS);
  assert.equal(state.headers, state.rows);
  assert.equal(state.databases, distinctFolders ? state.rows : CHECKED_YIELDS + 1);
  assert.deepEqual({ ...outcome.value }, { count: state.rows });
  // Also collect the tail chunk while the returned count remains alive.
  await assertCollected("after completion");
  assert.equal(outcome.value.count, state.rows);
  process.stdout.write(JSON.stringify({ scenario, checkedYields, ok: true }) + "\n");
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
