"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path").posix;
const { loadFolderTools } = require("./helpers/folder-tools.cjs");

const VIRTUAL_FLAG = 0x20;
const OUTBOX_FLAG = 0x800;
const FORBIDDEN_ROLE_FLAGS = { Virtual: VIRTUAL_FLAG, Queue: OUTBOX_FLAG, Inbox: 0x1000, Trash: 0x100, AllMail: 0x8000 };
const CONDITIONS = [{ attrib: "subject", op: "contains", value: "invoice" }];
const VIEW_NAME = "Invoices";

const DENIED_ACCOUNT = "account2";
const HIDDEN_ACCOUNT = "account9";
const MISSING_URI = "mailbox://missing";
const ADDRESS_BOOK_URI = "jsaddrbook://abook.sqlite";
const PRESERVED_MESSAGE_ID = "must-survive";
const DB_UNREADABLE_ERROR = "own database unreadable";
const DB_CLOSE_ERROR = "database close failed";
const CHILDREN_UNREADABLE_ERROR = "children unavailable";
const SUBFOLDER_SUFFIX = ".sbd";
const SUMMARY_SUFFIX = ".msf";
const TOOLS = { CREATE: "createVirtualFolder", LIST: "listVirtualFolders", DELETE: "deleteVirtualFolder" };
const EVENT = {
  FLAGS: "flags", SET_FLAG: "setFlag", ADD: "addSubfolder", NOTIFY: "notifyFolderAdded",
  DELETE: "propagateDelete", ENUMERATE: "enumerate", CLOSE: "close", RELEASE: "release",
  SCOPE: "scope", TERMS: "terms", ONLINE: "online", CLEANUP: "cleanup", SAVE: "saveVirtualFolders",
  DIRECTORY_CLOSE: "closeDirectory",
};

// Native services only: production folder lookup, access control, terms,
// schemas, handlers, dispatch and sanitization run in the folder-tools VM.
function makeHarness({ denied = [], addressBooksRestricted = false } = {}) {
  const events = [];
  const mutations = [];
  const folders = [];
  const aliases = new Map();
  const disk = new Map();
  const fileFailures = new Map();
  const openDBs = [];
  const cachedDatabases = new Map();
  const servers = [1, 2, 9].map(index => ({
    key: `server${index}`, type: "none", hidden: index === 9,
  }));
  const accounts = servers.map((server, i) => ({
    key: `account${i === 2 ? 9 : i + 1}`, incomingServer: server, identities: [],
  }));

  // nsIFile snapshots must observe pre-existing native storage without touching
  // the host filesystem. Each clone shares disk entries but has its own path.
  function file(initialPath) {
    let currentPath = initialPath;
    return {
      get path() { return currentPath; },
      get parent() { return file(path.dirname(currentPath)); },
      get leafName() {
        if (fileFailures.get(currentPath)?.leafName) throw new Error("directory entry unreadable");
        return path.basename(currentPath);
      },
      set leafName(value) { currentPath = path.join(path.dirname(currentPath), value); },
      clone: () => file(currentPath),
      equals: other => other.path === currentPath,
      exists() {
        if (fileFailures.get(currentPath)?.exists) throw new Error("storage existence unreadable");
        return disk.has(currentPath);
      },
      isDirectory() {
        if (fileFailures.get(currentPath)?.isDirectory) throw new Error("storage type unreadable");
        return disk.get(currentPath)?.directory === true;
      },
      get directoryEntries() {
        if (fileFailures.get(currentPath)?.directoryEntries) throw new Error("directory unreadable");
        return {
          *[Symbol.iterator]() {
            if (fileFailures.get(currentPath)?.iterate) throw new Error("directory iteration failed");
            for (const entry of disk.keys()) {
              if (path.dirname(entry) === currentPath) yield file(entry);
            }
          },
          close() {
            events.push([EVENT.DIRECTORY_CLOSE, currentPath]);
            if (fileFailures.get(currentPath)?.close) throw new Error("directory close failed");
          },
        };
      },
    };
  }

  function folder(parent, name, flags = 0, server = parent?.server) {
    const headers = [];
    const state = { flags };
    const storagePath = parent
      ? path.join(parent.isServer ? parent.filePath.path : `${parent.filePath.path}${SUBFOLDER_SUFFIX}`, encodeURIComponent(name))
      : `/fixture/${server.key}`;
    if (!parent) disk.set(storagePath, { directory: true });
    const result = {
      name, prettyName: name, parent, server,
      URI: parent ? `${parent.URI}/${encodeURIComponent(name)}` : `mailbox://${server.key}`,
      isServer: !parent,
      canCreateSubfolders: true,
      filePath: file(storagePath),
      summaryFile: file(`${storagePath}${SUMMARY_SUFFIX}`),
      subFolders: [],
      headers,
      definition: { scope: "", terms: [], online: false },
      failures: {},
      get flags() { return state.flags; },
      set flags(value) { mutations.push([EVENT.FLAGS, result.URI]); state.flags = value; },
      getFlag(flag) { return (state.flags & flag) !== 0; },
      setFlag(flag) { mutations.push([EVENT.SET_FLAG, result.URI, flag]); state.flags |= flag; },
      isSpecialFolder(flag, ancestors) {
        return Boolean(state.flags & flag) || Boolean(ancestors && parent?.isSpecialFolder(flag, true));
      },
      get hasSubFolders() { return result.subFolders.length > 0; },
      containsChildNamed(childName) {
        return result.subFolders.some(child => child.name.toLowerCase() === childName.toLowerCase());
      },
      getChildWithURI(uri) {
        return aliases.get(uri) || result.subFolders.find(child => child.URI.toLowerCase() === uri.toLowerCase()) || null;
      },
      addSubfolder(childName) {
        mutations.push([EVENT.ADD, result.URI, childName]);
        // 153/158 may return a same-name existing child instead of throwing.
        const allocated = result.subFolders.find(child => child.name.toLowerCase() === childName.toLowerCase()) || folder(result, childName);
        // Native versions may already create a summary during addSubfolder.
        disk.set(allocated.filePath.parent.path, { directory: true });
        disk.set(allocated.summaryFile.path, { directory: false });
        return allocated;
      },
      notifyFolderAdded(child) {
        assert.ok(events.some(([event, uri, commit]) => event === EVENT.CLOSE && uri === child.URI && commit === true),
          "native creation closes the database before notifying");
        mutations.push([EVENT.NOTIFY, child.URI]);
      },
      propagateDelete(child, deleteStorage) {
        assert.ok(events.some(([event, uri]) => event === EVENT.RELEASE && uri === child.URI),
          "view-only inspection releases the database before deletion");
        mutations.push([EVENT.DELETE, child.URI, deleteStorage]);
        if (result.failures.delete) throw new Error("native delete failed");
      },
      getTotalMessages: () => 99,
      getNumUnread: () => 42,
    };
    const database = {
      summaryValid: true,
      enumerateMessages() {
        events.push([EVENT.ENUMERATE, result.URI]);
        if (result.failures.enumerate) throw new Error("own headers unreadable");
        return headers;
      },
      close(commit) {
        events.push([EVENT.CLOSE, result.URI, commit]);
        if (result.failures.close) throw new Error(DB_CLOSE_ERROR);
      },
    };
    Object.defineProperty(result, "msgDatabase", {
      configurable: true,
      get() {
        events.push(["database", result.URI]);
        if (result.failures.database) throw new Error(DB_UNREADABLE_ERROR);
        return database;
      },
      set(value) { assert.equal(value, null); events.push([EVENT.RELEASE, result.URI]); },
    });
    result.database = database;
    folders.push(result);
    if (parent) parent.subFolders.push(result);
    return result;
  }

  const root = folder(null, "Local folders", 0, servers[0]);
  const otherRoot = folder(null, "Other account", 0, servers[1]);
  const hiddenRoot = folder(null, "Unified folders", 0, servers[2]);
  servers.forEach((server, i) => { server.rootFolder = [root, otherRoot, hiddenRoot][i]; });
  const source = folder(root, "Receipts");
  source.headers.push({ messageId: "real-source-mail" });
  const otherSource = folder(otherRoot, "Private receipts");
  const hiddenSource = folder(hiddenRoot, "Unified inbox");

  const virtualFolderHelper = {
    createNewVirtualFolder() { throw new Error("Unsafe native allocation wrapper must not be called"); },
    wrapVirtualFolder(target) {
      events.push(["wrap", target.URI]);
      if (target.failures.wrap) throw new Error("wrapper unavailable");
      return {
        virtualFolder: target,
        get searchFolderURIs() {
          if (target.failures.scope) throw new Error("scope unreadable");
          return target.definition.scope;
        },
        get searchFolders() { throw new Error("Creating scope lookup must never be used while listing"); },
        set searchFolders(value) {
          mutations.push([EVENT.SCOPE, target.URI]);
          if (target.failures.setScope) throw new Error("scope write failed");
          target.definition.scope = value.map(item => item.URI).join("|");
        },
        get searchTerms() {
          if (target.failures.terms) throw new Error("conditions unreadable");
          return target.definition.terms;
        },
        set searchTerms(value) {
          mutations.push([EVENT.TERMS, target.URI]);
          if (target.failures.setTerms) throw new Error("conditions write failed");
          target.definition.terms = Array.from(value);
        },
        get onlineSearch() {
          if (target.failures.online) throw new Error("online setting unreadable");
          return target.definition.online;
        },
        set onlineSearch(value) {
          mutations.push([EVENT.ONLINE, target.URI]);
          target.definition.online = value;
        },
        cleanUpMessageDatabase() {
          events.push([EVENT.CLEANUP, target.URI]);
          try { target.msgDatabase.close(true); }
          finally { target.msgDatabase = null; }
        },
      };
    },
  };
  const runtime = loadFolderTools({
    accounts, folders,
    isAccountAllowed: key => !denied.includes(key),
    isAddressBookAccessRestricted: () => addressBooksRestricted,
    getFolderForURL: uri => aliases.get(uri) || folders.find(item => item.URI === uri) || null,
    virtualFolderHelper,
    saveVirtualFolders() {
      assert.equal(mutations.at(-1)[0], EVENT.NOTIFY, "persist only after native folder notification");
      mutations.push([EVENT.SAVE]);
    },
    openDBs,
    cachedDBForFolder: target => cachedDatabases.get(target) || null,
    openFolderDB(target, leaveInvalidDB) {
      assert.equal(leaveInvalidDB, true, "database opening must not recover an invalid summary");
      events.push(["openFolderDB", target.URI]);
      if (target.failures.database) throw new Error(DB_UNREADABLE_ERROR);
      return target.database;
    },
  });
  function view(parent = root, name = VIEW_NAME, scopes = [source.URI]) {
    const target = folder(parent, name, VIRTUAL_FLAG);
    target.definition = { scope: scopes.join("|"), terms: Array.from(runtime.buildSearchTerms(CONDITIONS)), online: false };
    return target;
  }
  function create(overrides = {}) {
    const args = { name: VIEW_NAME, parentFolderPath: root.URI, searchFolderPaths: [source.URI], conditions: CONDITIONS, searchOnline: false, ...overrides };
    return runtime.callTool(TOOLS.CREATE, args);
  }
  function dangling(name = VIEW_NAME) {
    const target = folder(root, name);
    root.subFolders.splice(root.subFolders.indexOf(target), 1);
    folders.splice(folders.indexOf(target), 1);
    target.parent = null;
    // Native lookup hides detached objects, but addSubfolder can return one.
    root.addSubfolder = () => {
      mutations.push([EVENT.ADD]);
      target.parent = root;
      root.subFolders.push(target);
      folders.push(target);
      return target;
    };
    return target;
  }
  function assertNoMutation() { assert.deepEqual(mutations, []); }
  return { runtime, accounts, folders, events, mutations, aliases, disk, fileFailures, file, openDBs, cachedDatabases, virtualFolderHelper, root, otherRoot, hiddenRoot, source, otherSource, hiddenSource, folder, view, create, dangling, assertNoMutation };
}

function assertRefused(result, pattern) {
  assert.equal(result.success, undefined);
  assert.equal(typeof result.error, "string");
  if (pattern) assert.match(result.error, pattern);
}

function wasReleased(h, target) {
  return h.events.some(([event, uri]) => event === EVENT.RELEASE && uri === target.URI);
}

describe("saved-search creation does not convert existing folders", () => {
  it("creates a view with canonical deduplicated scope and native persistence through production dispatch", async () => {
    const h = makeHarness();
    const alias = "mailbox://alias/receipts";
    h.aliases.set(alias, h.source);
    const result = await h.create({ searchFolderPaths: [h.source.URI, alias, h.source.URI], searchOnline: true });
    assert.equal(result.success, true, result.error);
    const created = h.folders.find(item => item.URI === result.path);
    assert.ok(created);
    assert.equal(created.flags, VIRTUAL_FLAG);
    assert.deepEqual(Array.from(result.searchFolders), [h.source.URI]);
    assert.equal(created.definition.scope, h.source.URI);
    assert.equal(created.definition.terms[0].value.str, CONDITIONS[0].value);
    assert.equal(created.definition.online, true);
    assert.equal(created.database.summaryValid, true);
    assert.ok(wasReleased(h, created));
    const nativeCalls = h.mutations.map(([event]) => event);
    assert.deepEqual(nativeCalls, [EVENT.ADD, EVENT.SET_FLAG, EVENT.TERMS, EVENT.SCOPE, EVENT.ONLINE, EVENT.NOTIFY, EVENT.SAVE]);
    assert.ok(h.events.some(([event, uri, commit]) => event === EVENT.CLOSE && uri === created.URI && commit === true));
  });

  for (const saved of [false, true]) {
    it(`refuses case-insensitive name collision with ${saved ? "an existing view" : "a real folder"} before allocation`, async () => {
      const h = makeHarness();
      const existing = saved ? h.view() : h.folder(h.root, VIEW_NAME);
      existing.headers.push({ messageId: PRESERVED_MESSAGE_ID });
      const oldFlags = existing.flags;
      const oldDefinition = existing.definition;
      const result = await h.create({ name: VIEW_NAME.toLowerCase() });
      assertRefused(result, /exist|collision/i);
      assert.equal(existing.flags, oldFlags);
      assert.equal(existing.definition, oldDefinition);
      assert.equal(existing.headers.length, 1);
      h.assertNoMutation();
    });
  }

  for (const suffix of ["A/B", "A%2FB"]) {
    it(`refuses the native URI alias ${suffix} before allocation`, async () => {
      const h = makeHarness();
      const existing = h.folder(h.root, "Different visible name");
      h.aliases.set(`${h.root.URI}/${suffix}`, existing);
      const result = await h.create({ name: "A/B" });
      assertRefused(result, /exist|collision|alias/i);
      assert.equal(existing.flags, 0);
      h.assertNoMutation();
    });
  }

  it("refuses an existing object unexpectedly returned by addSubfolder before conversion or definition writes", async () => {
    const h = makeHarness();
    const existing = h.folder(h.root, "Real mail");
    existing.headers.push({ messageId: PRESERVED_MESSAGE_ID });
    h.root.addSubfolder = () => { h.mutations.push([EVENT.ADD]); return existing; };
    const result = await h.create();
    assertRefused(result);
    assert.equal(existing.flags, 0);
    assert.equal(existing.definition.scope, "");
    assert.equal(existing.headers.length, 1);
    assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
  });

  for (const problem of ["parent", "server", "URI", "children", ...Object.keys(FORBIDDEN_ROLE_FLAGS)]) {
    it(`refuses a native allocation with unexpected ${problem} without converting or deleting it`, async () => {
      const h = makeHarness();
      let allocated;
      h.root.addSubfolder = name => {
        h.mutations.push([EVENT.ADD]);
        allocated = h.folder(h.root, name);
        if (problem === "parent") allocated.parent = h.otherRoot;
        if (problem === "server") allocated.server = h.otherRoot.server;
        if (problem === "URI") allocated.URI += "-other";
        if (FORBIDDEN_ROLE_FLAGS[problem]) allocated.flags = FORBIDDEN_ROLE_FLAGS[problem];
        if (problem === "children") h.folder(allocated, "unexpected-child");
        return allocated;
      };
      const result = await h.create();
      assertRefused(result);
      assert.equal(allocated.definition.scope, "");
      assert.ok(!h.mutations.some(([event]) => [EVENT.SET_FLAG, EVENT.TERMS, EVENT.SCOPE, EVENT.DELETE, EVENT.SAVE].includes(event)));
    });
  }

  it("releases an allocated database when writing a definition fails without deleting it", async () => {
    const h = makeHarness();
    let allocated;
    h.root.addSubfolder = name => {
      allocated = h.folder(h.root, name);
      allocated.failures.setTerms = true;
      return allocated;
    };
    assertRefused(await h.create(), /write failed/i);
    assert.ok(wasReleased(h, allocated));
    assert.ok(h.events.some(([event]) => event === EVENT.CLEANUP));
    assert.ok(!h.mutations.some(([event]) => event === EVENT.DELETE || event === EVENT.SAVE));
  });

  it("refuses an unexpected wrapper without configuring or cleaning up the unrelated folder", async () => {
    const h = makeHarness();
    const unrelated = h.view(h.otherRoot, "Existing private view");
    const originalDefinition = unrelated.definition;
    let writes = 0;
    let cleanups = 0;
    h.virtualFolderHelper.wrapVirtualFolder = () => ({
      virtualFolder: unrelated,
      set searchTerms(_value) { writes++; },
      cleanUpMessageDatabase() { cleanups++; },
    });
    assertRefused(await h.create(), /wrapper/i);
    assert.equal(unrelated.definition, originalDefinition);
    assert.equal(unrelated.flags, VIRTUAL_FLAG);
    assert.equal(writes, 0);
    assert.equal(cleanups, 0);
    assert.ok(!h.mutations.some(([event]) => event === EVENT.DELETE || event === EVENT.SAVE));
  });

  it("preserves UTF-8 names while checking the native byte-escaped URI", async () => {
    const h = makeHarness();
    const name = "Café invoices";
    const result = await h.create({ name });
    assert.equal(result.success, true, result.error);
    assert.equal(result.path, `${h.root.URI}/${encodeURIComponent(name)}`);
  });
});

describe("saved-search allocation proves storage was not already present", () => {
  for (const [kind, suffix, directory] of [
    ["mbox", "", false], ["maildir", "", true],
    ["summary", SUMMARY_SUFFIX, false], ["child directory", SUBFOLDER_SUFFIX, true],
  ]) {
    it(`refuses an orphan with existing ${kind} before conversion, case-insensitively`, async () => {
      const h = makeHarness();
      const orphan = h.dangling();
      const existingPath = `${orphan.filePath.path}${suffix}`;
      const diskAlias = path.join(path.dirname(existingPath), path.basename(existingPath).toUpperCase());
      const existingStorage = { directory };
      h.disk.set(diskAlias, existingStorage);
      assertRefused(await h.create());
      assert.equal(orphan.flags, 0);
      assert.equal(orphan.definition.scope, "");
      assert.equal(h.disk.get(diskAlias), existingStorage);
      assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
      assert.ok(!h.events.some(([event]) => event === EVENT.CLOSE || event === EVENT.RELEASE));
    });
  }

  it("refuses canonically equivalent Unicode storage names before converting a cached orphan", async () => {
    const h = makeHarness();
    const name = "Caf\u00e9";
    const orphan = h.dangling(name);
    const storagePath = path.join(h.root.filePath.path, name);
    orphan.filePath = h.file(storagePath);
    orphan.summaryFile = h.file(`${storagePath}${SUMMARY_SUFFIX}`);
    const existingPath = storagePath.normalize("NFD");
    const existingStorage = { directory: false };
    h.disk.set(existingPath, existingStorage);
    assertRefused(await h.create({ name }));
    assert.equal(orphan.flags, 0);
    assert.equal(h.disk.get(existingPath), existingStorage);
    assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
  });

  for (const hasHeaders of [false, true]) {
    it(`refuses a cached orphan database with ${hasHeaders ? "stored headers" : "no headers"} without closing or changing it`, async () => {
      const h = makeHarness();
      const orphan = h.dangling();
      if (hasHeaders) orphan.headers.push({ messageId: PRESERVED_MESSAGE_ID });
      h.openDBs.push(orphan.database);
      h.cachedDatabases.set(orphan, orphan.database);
      assertRefused(await h.create());
      assert.equal(orphan.flags, 0);
      assert.equal(orphan.headers.length, hasHeaders ? 1 : 0);
      assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
      assert.ok(!h.events.some(([event]) => [EVENT.CLOSE, EVENT.RELEASE, EVENT.ENUMERATE].includes(event)));
    });
  }

  it("allows a new nested view when native allocation creates its summary after the snapshot", async () => {
    const h = makeHarness();
    const parent = h.folder(h.root, "Projects");
    const childDirectory = `${parent.filePath.path}${SUBFOLDER_SUFFIX}`;
    assert.equal(h.disk.has(childDirectory), false);
    const result = await h.create({ parentFolderPath: parent.URI });
    assert.equal(result.success, true, result.error);
    const created = h.folders.find(item => item.URI === result.path);
    assert.equal(h.disk.get(childDirectory).directory, true);
    assert.equal(h.disk.get(created.summaryFile.path).directory, false);
  });

  for (const [problem, change] of [
    ["storage outside expected directory", (h, target) => { target.filePath = h.file(`${h.otherRoot.filePath.path}/elsewhere`); }],
    ["summary outside expected directory", (h, target) => { target.summaryFile = h.file(`${h.otherRoot.filePath.path}/elsewhere${SUMMARY_SUFFIX}`); }],
    ["summary with unrelated basename", (h, target) => { target.summaryFile = h.file(`${h.root.filePath.path}/unrelated${SUMMARY_SUFFIX}`); }],
    ["missing storage path", (_h, target) => { target.filePath = null; }],
  ]) {
    it(`refuses an allocated folder with ${problem} before Virtual is set`, async () => {
      const h = makeHarness();
      let allocated;
      h.root.addSubfolder = name => {
        h.mutations.push([EVENT.ADD]);
        allocated = h.folder(h.root, name);
        change(h, allocated);
        return allocated;
      };
      assertRefused(await h.create());
      assert.equal(allocated.flags, 0);
      assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
    });
  }

  for (const [problem, configure, mustClose] of [
    ["unknown existence", h => h.fileFailures.set(h.root.filePath.path, { exists: true }), false],
    ["unknown directory type", h => h.fileFailures.set(h.root.filePath.path, { isDirectory: true }), false],
    ["non-directory", h => h.disk.set(h.root.filePath.path, { directory: false }), false],
    ["unreadable entries", h => h.fileFailures.set(h.root.filePath.path, { directoryEntries: true }), false],
    ["failing iteration", h => h.fileFailures.set(h.root.filePath.path, { iterate: true }), true],
    ["failing close", h => h.fileFailures.set(h.root.filePath.path, { close: true }), true],
    ["unreadable entry", h => {
      const entry = `${h.root.filePath.path}/unknown`;
      h.disk.set(entry, { directory: false });
      h.fileFailures.set(entry, { leafName: true });
    }, true],
  ]) {
    it(`refuses ${problem} while snapshotting the parent before allocation`, async () => {
      const h = makeHarness();
      configure(h);
      assertRefused(await h.create());
      h.assertNoMutation();
      if (mustClose) assert.ok(h.events.some(([event]) => event === EVENT.DIRECTORY_CLOSE));
    });
  }
});

describe("saved-search input and privacy boundaries", () => {
  for (const name of [".hidden", "trailing.", "trailing~", "trailing ", "semi;colon", "hash#name", "control\nname", "back\\slash", ""]) {
    it(`refuses Thunderbird-invalid or unsafe name ${JSON.stringify(name)} without allocation`, async () => {
      const h = makeHarness();
      assertRefused(await h.create({ name }));
      h.assertNoMutation();
    });
  }

  for (const name of ["Inbox", "iNbOx", "Trash", "Unsent Messages", "Outbox", "Drafts", "Sent", "Templates", "Archives"]) {
    it(`refuses root name ${name} before native code assigns a special role`, async () => {
      const h = makeHarness();
      assertRefused(await h.create({ name }), /role|outbox|special|reserved/i);
      h.assertNoMutation();
    });
  }

  for (const problem of ["virtual", "outbox", "outbox descendant", "cannot create", "unknown capability", "hidden", "restricted"]) {
    it(`refuses ${problem} creation parents before allocation`, async () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      let parent = h.folder(h.root, "Parent");
      if (problem === "virtual") parent = h.view();
      if (problem === "outbox") parent = h.folder(h.root, "Queue", OUTBOX_FLAG);
      if (problem === "outbox descendant") parent = h.folder(h.folder(h.root, "Queue", OUTBOX_FLAG), "Nested");
      if (problem === "cannot create") parent.canCreateSubfolders = false;
      if (problem === "unknown capability") delete parent.canCreateSubfolders;
      if (problem === "hidden") parent = h.hiddenRoot;
      if (problem === "restricted") parent = h.otherRoot;
      assertRefused(await h.create({ parentFolderPath: parent.URI }));
      h.assertNoMutation();
    });
  }

  for (const problem of ["root", "virtual", "hidden", "restricted", "unresolved", "empty", "wildcard", "non-string"]) {
    it(`refuses ${problem} search scope before allocation`, async () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      const path = {
        root: h.root.URI, virtual: h.view().URI, hidden: h.hiddenSource.URI,
        restricted: h.otherSource.URI, unresolved: MISSING_URI, empty: "", wildcard: "*", "non-string": 123,
      }[problem];
      assertRefused(await h.create({ searchFolderPaths: [h.source.URI, path] }));
      h.assertNoMutation();
    });
  }

  for (const op of ["isInAB", "isntInAB"]) {
    it(`refuses ${op} while address books are restricted, before allocation`, async () => {
      const h = makeHarness({ addressBooksRestricted: true });
      assertRefused(await h.create({ conditions: [{ attrib: "from", op, value: ADDRESS_BOOK_URI }] }), /address book/i);
      h.assertNoMutation();
    });
  }

  it("allows address-book conditions with the existing opt-in", async () => {
    const h = makeHarness();
    const result = await h.create({ conditions: [{ attrib: "from", op: "isInAB", value: ADDRESS_BOOK_URI }] });
    assert.equal(result.success, true, result.error);
  });

  for (const args of [{ name: null }, { parentFolderPath: null }, { searchFolderPaths: [] }, { conditions: [] }, { conditions: [{ ...CONDITIONS[0], attrib: "bad" }] }, { searchOnline: "true" }]) {
    it(`refuses malformed creation input ${JSON.stringify(args)} before allocation`, async () => {
      const h = makeHarness();
      assertRefused(await h.create(args));
      h.assertNoMutation();
    });
  }
});

describe("saved-search listing reveals only wholly accessible views", () => {
  it("uses listAccounts account keys and canonical scope through production dispatch", async () => {
    const h = makeHarness();
    const target = h.view();
    const accountRows = h.runtime.listAccounts();
    const result = await h.runtime.callTool(TOOLS.LIST, { accountId: accountRows[0].id });
    assert.equal(result.length, 1);
    assert.equal(result[0].accountId, "account1");
    assert.equal(result[0].name, VIEW_NAME);
    assert.equal(result[0].path, target.URI);
    assert.deepEqual(Array.from(result[0].searchFolders), [h.source.URI]);
    assert.equal(result[0].terms[0].value, CONDITIONS[0].value);
    assert.equal(result[0].onlineSearch, false);
    assert.ok(wasReleased(h, target));
    h.assertNoMutation();
  });

  for (const accountId of ["server1", "missing", DENIED_ACCOUNT, HIDDEN_ACCOUNT, 123, {}, [], null, ""]) {
    it(`rejects unavailable or malformed account ID ${JSON.stringify(accountId)} before wrapping views`, () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      h.view();
      assertRefused(h.runtime.listVirtualFolders(accountId));
      assert.deepEqual(h.events, []);
      h.assertNoMutation();
    });
  }

  for (const problem of ["restricted scope", "hidden scope", "wildcard", "mixed wildcard", "unresolved", "empty", "scope getter", "terms getter", "online getter"]) {
    it(`omits the entire view for ${problem} and releases its database`, () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      const target = h.view(h.root, "Private metadata must not appear");
      if (problem === "restricted scope") target.definition.scope += `|${h.otherSource.URI}`;
      if (problem === "hidden scope") target.definition.scope += `|${h.hiddenSource.URI}`;
      if (problem === "wildcard") target.definition.scope = "*";
      if (problem === "mixed wildcard") target.definition.scope += "|*";
      if (problem === "unresolved") target.definition.scope += "|mailbox://missing";
      if (problem === "empty") target.definition.scope = "";
      if (problem === "scope getter") target.failures.scope = true;
      if (problem === "terms getter") target.failures.terms = true;
      if (problem === "online getter") target.failures.online = true;
      const result = h.runtime.listVirtualFolders();
      assert.deepEqual(Array.from(result), []);
      assert.ok(wasReleased(h, target));
      h.assertNoMutation();
    });
  }

  it("skips hidden and inaccessible view folders without wrapping or revealing their metadata", () => {
    const h = makeHarness({ denied: [DENIED_ACCOUNT] });
    h.view(h.hiddenRoot, "Unified private view");
    h.view(h.otherRoot, "Restricted private view");
    assert.deepEqual(Array.from(h.runtime.listVirtualFolders()), []);
    assert.deepEqual(h.events, []);
    h.assertNoMutation();
  });

  it("omits unreadable wrappers without preventing another safe view from being returned", () => {
    const h = makeHarness();
    const broken = h.view(h.root, "Broken");
    broken.failures.wrap = true;
    const safe = h.view(h.root, "Safe");
    const result = h.runtime.listVirtualFolders();
    assert.deepEqual(Array.from(result, row => row.path), [safe.URI]);
    assert.ok(wasReleased(h, safe));
    h.assertNoMutation();
  });

  it("omits a view whose cleanup fails, releases its handle and continues listing", () => {
    const h = makeHarness();
    const broken = h.view(h.root, "Unreadable database");
    broken.failures.close = true;
    const safe = h.view(h.root, "Safe");
    const result = h.runtime.listVirtualFolders();
    assert.deepEqual(Array.from(result, row => row.path), [safe.URI]);
    assert.ok(wasReleased(h, broken));
    assert.ok(wasReleased(h, safe));
    h.assertNoMutation();
  });
});

describe("saved-search deletion is view-only", () => {
  it("deletes an empty own database once even when displayed view counts are positive", async () => {
    const h = makeHarness();
    const target = h.view();
    const result = await h.runtime.callTool(TOOLS.DELETE, { folderPath: target.URI });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(h.mutations, [[EVENT.DELETE, target.URI, true]]);
    assert.ok(wasReleased(h, target));
    assert.ok(h.events.some(([event, uri]) => event === EVENT.ENUMERATE && uri === target.URI));
  });

  for (const problem of ["real folder", "root", "children", "own header", "database unreadable", "invalid summary", "unknown summary", "headers unreadable", "children unreadable", "child iterator unreadable", DB_CLOSE_ERROR, "hidden", "restricted", "unresolved"]) {
    it(`refuses deletion for ${problem} without a storage deletion call`, () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      let target = h.view();
      if (problem === "real folder") target = h.source;
      if (problem === "root") target.parent = null;
      if (problem === "children") h.folder(target, "Real mail child");
      if (problem === "own header") target.headers.push({ messageId: "real-mail" });
      if (problem === "database unreadable") target.failures.database = true;
      if (problem === "invalid summary") target.database.summaryValid = false;
      if (problem === "unknown summary") delete target.database.summaryValid;
      if (problem === "headers unreadable") target.failures.enumerate = true;
      if (problem === "children unreadable") Object.defineProperty(target, "hasSubFolders", { get() { throw new Error(CHILDREN_UNREADABLE_ERROR); } });
      if (problem === "child iterator unreadable") {
        Object.defineProperty(target, "hasSubFolders", { value: false });
        Object.defineProperty(target, "subFolders", { get() { throw new Error(CHILDREN_UNREADABLE_ERROR); } });
      }
      if (problem === DB_CLOSE_ERROR) target.failures.close = true;
      if (problem === "hidden") target = h.view(h.hiddenRoot);
      if (problem === "restricted") target = h.view(h.otherRoot);
      const uri = problem === "unresolved" ? MISSING_URI : target.URI;
      assertRefused(h.runtime.deleteVirtualFolder(uri));
      h.assertNoMutation();
      if (["own header", "headers unreadable"].includes(problem)) assert.ok(wasReleased(h, target));
    });
  }

  it("refuses a missing native summary without invoking the folder getter that could rebuild an empty DB", () => {
    const h = makeHarness();
    const target = h.view();
    target.failures.database = true;
    let recoveringGetterCalls = 0;
    Object.defineProperty(target, "msgDatabase", {
      get() { recoveringGetterCalls++; return { summaryValid: true, enumerateMessages: () => [], close() {} }; },
      set(value) { assert.equal(value, null); },
    });
    assertRefused(h.runtime.deleteVirtualFolder(target.URI), /unreadable/);
    assert.equal(recoveringGetterCalls, 0);
    h.assertNoMutation();
  });

  it("does not retry a native delete that throws after it may have removed storage", () => {
    const h = makeHarness();
    const target = h.view();
    h.root.failures.delete = true;
    assertRefused(h.runtime.deleteVirtualFolder(target.URI), /native delete failed/);
    assert.deepEqual(h.mutations, [[EVENT.DELETE, target.URI, true]]);
    assert.ok(wasReleased(h, target));
  });
});

describe("saved-search production schemas", () => {
  it("registers normal folders tools with their expected CRUD metadata", () => {
    const h = makeHarness();
    const tools = h.runtime.buildTools();
    for (const [name, crud] of [[TOOLS.CREATE, "create"], [TOOLS.LIST, "read"], [TOOLS.DELETE, "delete"]]) {
      const tool = tools.find(item => item.name === name);
      assert.ok(tool, name);
      assert.equal(tool.group, "folders");
      assert.equal(tool.crud, crud);
    }
    const create = tools.find(item => item.name === TOOLS.CREATE);
    assert.deepEqual(Array.from(create.inputSchema.required), ["name", "parentFolderPath", "searchFolderPaths", "conditions"]);
    const filter = tools.find(item => item.name === "createFilter");
    assert.ok(create.inputSchema.properties.conditions.items.properties.booleanAnd.description.startsWith(
      filter.inputSchema.properties.conditions.items.properties.booleanAnd.description));
  });
});
