"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { posix: path, win32: windowsPath } = require("node:path");
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
const MBOX_STORE = "mbox";
const MAILDIR_STORE = "maildir";
const WINDOWS_OS = "WINNT";
const NATIVE_PATHS = [["POSIX", path], ["Windows", windowsPath]];
const ACCOUNT_KEYS_PREF = "mail.accountmanager.accounts";
const SERVER_PREF_BRANCH = "mail.server.";
const UNICODE_STORAGE_NAME = "R\u00e9sum\u00e9";
const PANORAMA_PREF = "mail.panorama.enabled";
const NATIVE_DELETE_ERROR = "native delete failed";
const VIRTUAL_DEFINITIONS_FILE = "virtualFolders.dat";
const VIRTUAL_DEFINITIONS_HEADER = "version=1\n";
const VIRTUAL_DEFINITIONS_MAX_BYTES = 1024 * 1024;
const STORED_MAIL = "From sender@example.invalid\nMessage-ID: <must-survive>\n\nStored mail\n";
const MAILDIR_CUR = "cur";
const MAILDIR_TMP = "tmp";
const SUMMARY_DEFINITION = "saved-search definition";
const TOOLS = { CREATE: "createVirtualFolder", LIST: "listVirtualFolders", DELETE: "deleteVirtualFolder" };
const EVENT = {
  FLAGS: "flags", SET_FLAG: "setFlag", ADD: "addSubfolder", NOTIFY: "notifyFolderAdded",
  DELETE: "propagateDelete", ENUMERATE: "enumerate", CLOSE: "close", RELEASE: "release",
  SCOPE: "scope", TERMS: "terms", ONLINE: "online", CLEANUP: "cleanup", SAVE: "saveVirtualFolders",
  DIRECTORY_CLOSE: "closeDirectory", REMOVE: "remove", LOAD: "loadVirtualFolders",
  STREAM_OPEN: "openDefinitionStream", STREAM_CLOSE: "closeDefinitionStream",
  FORCE_CLOSE: "forceClosed", CACHED_DB: "cachedDBForFolder",
};

// Native services only: production folder lookup, access control, terms,
// schemas, handlers, dispatch and sanitization run in the folder-tools VM.
function makeHarness({ denied = [], addressBooksRestricted = false, pathImpl = path, nativeClearsVirtual = true } = {}) {
  const events = [];
  const mutations = [];
  const folders = [];
  const aliases = new Map();
  const disk = new Map();
  const fileFailures = new Map();
  const fileAliases = new Map();
  const removeHooks = new Map();
  const hooks = {};
  const serviceFailures = {};
  const folderStates = new WeakMap();
  const virtualRegistry = new Map();
  const virtualListeners = new Set();
  const persistedViews = new Map();
  const profilePath = pathImpl === windowsPath ? "C:\\fixture-profile" : "/fixture-profile";
  const definitionsPath = pathImpl.join(profilePath, VIRTUAL_DEFINITIONS_FILE);
  disk.set(profilePath, { directory: true });
  const openDBs = [];
  const cachedDatabases = new Map();
  const cachedDatabasePaths = new Map();
  const servers = [1, 2, 9].map(index => ({
    key: `server${index}`, type: "none", hidden: index === 9,
  }));
  const accounts = servers.map((server, i) => ({
    key: `account${i === 2 ? 9 : i + 1}`, incomingServer: server, identities: [],
  }));

  function cacheDatabase(target, database, backing = target.filePath.path) {
    cachedDatabases.set(target, database);
    cachedDatabasePaths.set(backing, database);
  }

  // nsIFile snapshots must observe pre-existing native storage without touching
  // the host filesystem. Each clone shares disk entries but has its own path.
  // A sparse map still implies intermediate directories, as a real filesystem
  // does: backing/cur/message must be visible when enumerating backing.
  function diskEntry(filePath) {
    filePath = fileAliases.get(filePath) || filePath;
    if (disk.has(filePath)) return disk.get(filePath);
    const prefix = filePath.endsWith(pathImpl.sep) ? filePath : `${filePath}${pathImpl.sep}`;
    return [...disk.keys()].some(entry => entry.startsWith(prefix))
      ? { directory: true } : undefined;
  }

  function file(initialPath) {
    let currentPath = initialPath;
    return {
      get path() { return currentPath; },
      get parent() {
        const parentPath = pathImpl.dirname(currentPath);
        return parentPath === currentPath ? null : file(parentPath);
      },
      get target() {
        if (fileFailures.get(currentPath)?.target) throw new Error("resolved target unreadable");
        const entry = diskEntry(currentPath);
        return entry && "target" in entry ? entry.target : currentPath;
      },
      get leafName() {
        if (fileFailures.get(currentPath)?.leafName) throw new Error("directory entry unreadable");
        return pathImpl.basename(currentPath);
      },
      set leafName(value) { currentPath = pathImpl.join(pathImpl.dirname(currentPath), value); },
      clone: () => file(currentPath),
      equals(other) {
        if (fileFailures.get(currentPath)?.equals) throw new Error("storage identity unreadable");
        return (fileAliases.get(other.path) || other.path) === (fileAliases.get(currentPath) || currentPath);
      },
      exists() {
        if (fileFailures.get(currentPath)?.exists) throw new Error("storage existence unreadable");
        const entry = diskEntry(currentPath);
        return !!entry && entry.exists !== false;
      },
      isDirectory() {
        if (fileFailures.get(currentPath)?.isDirectory) throw new Error("storage type unreadable");
        return diskEntry(currentPath)?.directory === true;
      },
      isFile() {
        if (fileFailures.get(currentPath)?.isFile) throw new Error("file type unreadable");
        const entry = diskEntry(currentPath);
        return entry?.directory === false && entry.regular !== false;
      },
      isReadable() {
        if (fileFailures.get(currentPath)?.isReadable) throw new Error("storage permissions unreadable");
        const entry = diskEntry(currentPath);
        return !!entry && entry.readable !== false;
      },
      isSymlink() {
        if (fileFailures.get(currentPath)?.isSymlink) throw new Error("symlink state unreadable");
        return diskEntry(currentPath)?.symlink === true;
      },
      get fileSize() {
        if (fileFailures.get(currentPath)?.fileSize) throw new Error("storage size unreadable");
        const entry = diskEntry(currentPath);
        if (!entry) throw new Error("storage unavailable");
        return "size" in entry ? entry.size : Buffer.byteLength(entry.content || "");
      },
      remove(recursive) {
        mutations.push([EVENT.REMOVE, currentPath, recursive]);
        assert.equal(recursive, false, "storage cleanup must never recurse");
        removeHooks.get(currentPath)?.();
        if (fileFailures.get(currentPath)?.remove) throw new Error("native storage removal failed");
        const entry = diskEntry(currentPath);
        if (!entry) throw new Error("storage already absent");
        const prefix = `${currentPath}${pathImpl.sep}`;
        if (entry.directory && [...disk.keys()].some(name => name.startsWith(prefix))) {
          throw new Error("directory is not empty");
        }
        // Sparse entries imply real parent directories, which survive removal
        // of their last child. Materialize those parents before unlinking it.
        for (let parentPath = pathImpl.dirname(currentPath); !disk.has(parentPath); parentPath = pathImpl.dirname(parentPath)) {
          disk.set(parentPath, { directory: true });
          if (pathImpl.dirname(parentPath) === parentPath) break;
        }
        disk.delete(fileAliases.get(currentPath) || currentPath);
      },
      get directoryEntries() {
        if (fileFailures.get(currentPath)?.directoryEntries) throw new Error("directory unreadable");
        const borrowedEntries = [];
        return {
          *[Symbol.iterator]() {
            if (fileFailures.get(currentPath)?.iterate) throw new Error("directory iteration failed");
            const children = new Set();
            const prefix = currentPath.endsWith(pathImpl.sep) ? currentPath : `${currentPath}${pathImpl.sep}`;
            for (const entry of disk.keys()) {
              if (!entry.startsWith(prefix)) continue;
              const child = entry.slice(prefix.length).split(pathImpl.sep)[0];
              children.add(pathImpl.join(currentPath, child));
            }
            for (const child of children) {
              const entry = file(child);
              borrowedEntries.push(entry);
              yield entry;
            }
          },
          close() {
            events.push([EVENT.DIRECTORY_CLOSE, currentPath]);
            if (fileFailures.get(currentPath)?.invalidateEntriesOnClose) {
              for (const entry of borrowedEntries) entry.leafName += "-closed";
            }
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
      ? pathImpl.join(parent.isServer ? parent.filePath.path : `${parent.filePath.path}${SUBFOLDER_SUFFIX}`, encodeURIComponent(name))
      : pathImpl.join(pathImpl === windowsPath ? "C:\\fixture" : "/fixture", server.key);
    if (!parent) disk.set(storagePath, { directory: true });
    const result = {
      name, prettyName: name, parent, server,
      URI: parent ? `${parent.URI}/${encodeURIComponent(name)}` : `mailbox://${server.key}`,
      isServer: !parent,
      canCreateSubfolders: true,
      msgStore: { storeType: MBOX_STORE },
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
        virtualRegistry.set(child.URI, child);
        virtualListeners.add(child.URI);
      },
      propagateDelete(child, deleteStorage) {
        assert.ok(events.some(([event, uri]) => event === EVENT.RELEASE && uri === child.URI),
          "view-only inspection releases the database before deletion");
        mutations.push([EVENT.DELETE, child.URI, deleteStorage]);
        assert.equal(deleteStorage, false, "native detachment must not delete storage");
        hooks.beforeDetach?.(child);
        if (result.failures.delete) throw new Error(NATIVE_DELETE_ERROR);
        if (result.failures.noDetach) return;
        result.subFolders.splice(result.subFolders.indexOf(child), 1);
        folders.splice(folders.indexOf(child), 1);
        child.parent = null;
        virtualRegistry.delete(child.URI);
        virtualListeners.delete(child.URI);
        if (nativeClearsVirtual) {
          folderStates.get(child).flags &= ~VIRTUAL_FLAG;
          cacheDatabase(child, child.database);
        }
        hooks.afterDetach?.(child);
        if (result.failures.deleteAfterDetach) throw new Error(NATIVE_DELETE_ERROR);
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
      forceClosed() {
        events.push([EVENT.FORCE_CLOSE, result.URI]);
        if (result.failures.forceClose) throw new Error(DB_CLOSE_ERROR);
        if (cachedDatabases.get(result) === database) cachedDatabases.delete(result);
        for (const [backing, cached] of cachedDatabasePaths) {
          if (cached === database) cachedDatabasePaths.delete(backing);
        }
      },
    };
    Object.defineProperty(result, "msgDatabase", {
      configurable: true,
      get() {
        events.push(["database", result.URI]);
        if (result.failures.database) throw new Error(DB_UNREADABLE_ERROR);
        return database;
      },
      set(value) {
        assert.equal(value, null);
        events.push([EVENT.RELEASE, result.URI]);
      },
    });
    result.database = database;
    folderStates.set(result, state);
    folders.push(result);
    if (parent) parent.subFolders.push(result);
    return result;
  }

  const root = folder(null, "Local folders", 0, servers[0]);
  const otherRoot = folder(null, "Other account", 0, servers[1]);
  const hiddenRoot = folder(null, "Unified folders", 0, servers[2]);
  servers.forEach((server, i) => {
    server.rootFolder = [root, otherRoot, hiddenRoot][i];
    server.localPath = server.rootFolder.filePath.clone();
  });
  const source = folder(root, "Receipts");
  source.headers.push({ messageId: "real-source-mail" });
  const otherSource = folder(otherRoot, "Private receipts");
  const hiddenSource = folder(hiddenRoot, "Unified inbox");

  // Native saved-search registration and its serialized definitions are distinct:
  // detachment removes registration; saving commits that change for restart.
  function snapshotView(target) {
    return {
      uri: target.URI, name: target.name, parentURI: target.parent.URI,
      backing: target.filePath.path, summary: target.summaryFile.path,
      storeType: target.msgStore.storeType,
      definition: { ...target.definition, terms: Array.from(target.definition.terms) },
    };
  }

  function writePersistedViews() {
    const content = VIRTUAL_DEFINITIONS_HEADER + [...persistedViews.values()]
      .map(record => `uri=${record.uri}\nscope=${record.definition.scope}\nterms=ALL\nsearchOnline=false\n`).join("");
    disk.set(definitionsPath, { directory: false, content });
  }

  function loadPersistedViews() {
    for (const record of persistedViews.values()) {
      if (folders.some(item => item.URI === record.uri)) continue;
      const parent = folders.find(item => item.URI === record.parentURI);
      assert.ok(parent, "persisted saved-search parent must exist");
      const target = folder(parent, record.name, VIRTUAL_FLAG);
      target.URI = record.uri;
      target.filePath = file(record.backing);
      target.summaryFile = file(record.summary);
      target.msgStore.storeType = record.storeType;
      target.definition = { ...record.definition, terms: Array.from(record.definition.terms) };
      virtualRegistry.set(target.URI, target);
      virtualListeners.add(target.URI);
    }
  }

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
      mutations.push([EVENT.SAVE]);
      if (serviceFailures.save) throw new Error("saved-search persistence failed");
      if (serviceFailures.saveNoOp) return;
      persistedViews.clear();
      for (const target of virtualRegistry.values()) persistedViews.set(target.URI, snapshotView(target));
      writePersistedViews();
      hooks.afterSave?.();
    },
    openDBs,
    cachedDBForFolder(target) {
      events.push([EVENT.CACHED_DB, target.URI]);
      if (serviceFailures.cachedDatabase) throw new Error(DB_UNREADABLE_ERROR);
      return cachedDatabases.get(target) || null;
    },
    cachedDBForFilePath(backing) {
      events.push([EVENT.CACHED_DB, backing.path]);
      if (serviceFailures.cachedDatabase) throw new Error(DB_UNREADABLE_ERROR);
      return cachedDatabasePaths.get(backing.path) || null;
    },
    openFolderDB(target, leaveInvalidDB) {
      assert.equal(leaveInvalidDB, true, "database opening must not recover an invalid summary");
      events.push(["openFolderDB", target.URI]);
      if (target.failures.database) throw new Error(DB_UNREADABLE_ERROR);
      return target.database;
    },
  });
  runtime.MailServices.accounts.allServers = servers;
  runtime.MailServices.accounts.getIncomingServer = key => servers.find(server => server.key === key) || null;
  runtime.Services.prefs.getChildList = prefix => {
    assert.equal(prefix, SERVER_PREF_BRANCH);
    return [...servers.map(server => `${prefix}${server.key}.type`), `${prefix}default.type`];
  };
  runtime.Services.prefs.getCharPref = (name, fallback) => name === ACCOUNT_KEYS_PREF
    ? accounts.map(account => account.key).join(",") : fallback;
  runtime.MailServices.accounts.loadVirtualFolders = () => {
    events.push([EVENT.LOAD]);
    throw new Error("Loading saved searches can convert real folders and must never be called");
  };
  runtime.Services.dirsvc = {
    get(key) {
      assert.equal(key, "ProfD");
      if (serviceFailures.profile) throw new Error("profile directory unavailable");
      return file(profilePath);
    },
  };
  runtime.Ci.nsIFile = {};
  runtime.Ci.nsIFileInputStream = {};
  runtime.Cr = { NS_BASE_STREAM_CLOSED: "native stream closed" };
  runtime.NetUtil = { readInputStreamToString: (stream, count) => stream.read(count) };
  runtime.Cc["@mozilla.org/network/file-input-stream;1"] = {
    createInstance() {
      let content;
      let offset = 0;
      let streamPath;
      return {
        init(inputFile, flags) {
          assert.equal(flags, 0x01, "definition verification must open only for reading");
          streamPath = inputFile.path;
          events.push([EVENT.STREAM_OPEN, streamPath]);
          if (fileFailures.get(streamPath)?.streamInit) throw new Error("definition stream unavailable");
          const entry = diskEntry(streamPath);
          if (!entry) throw new Error("definition file absent");
          content = Buffer.from(entry.content || "").toString("latin1");
        },
        available() {
          if (fileFailures.get(streamPath)?.streamAvailable) throw new Error("definition availability unreadable");
          return content.length - offset;
        },
        read(count) {
          if (fileFailures.get(streamPath)?.streamRead) throw new Error("definition read failed");
          const result = content.slice(offset, offset + count);
          offset += result.length;
          return result;
        },
        close() {
          events.push([EVENT.STREAM_CLOSE, streamPath]);
          if (fileFailures.get(streamPath)?.streamClose) throw new Error("definition close failed");
        },
      };
    },
  };
  if (pathImpl === windowsPath) runtime.Services.appinfo = { OS: WINDOWS_OS };
  function view(parent = root, name = VIEW_NAME, scopes = [source.URI]) {
    const target = folder(parent, name, VIRTUAL_FLAG);
    target.definition = { scope: scopes.join("|"), terms: Array.from(runtime.buildSearchTerms(CONDITIONS)), online: false };
    virtualRegistry.set(target.URI, target);
    virtualListeners.add(target.URI);
    persistedViews.set(target.URI, snapshotView(target));
    writePersistedViews();
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
  function restart() {
    for (const target of virtualRegistry.values()) {
      target.parent.subFolders.splice(target.parent.subFolders.indexOf(target), 1);
      folders.splice(folders.indexOf(target), 1);
    }
    virtualRegistry.clear();
    virtualListeners.clear();
    loadPersistedViews();
  }
  function assertNoMutation() { assert.deepEqual(mutations, []); }
  return { runtime, accounts, folders, events, mutations, aliases, disk, fileFailures, fileAliases, removeHooks, hooks, serviceFailures, virtualRegistry, virtualListeners, persistedViews, restart, profile: file(profilePath), definitionsFile: file(definitionsPath), file, openDBs, cachedDatabases, cachedDatabasePaths, cacheDatabase, virtualFolderHelper, root, otherRoot, hiddenRoot, source, otherSource, hiddenSource, folder, view, create, dangling, assertNoMutation };
}

function assertRefused(result, pattern) {
  assert.equal(result.success, undefined);
  assert.equal(typeof result.error, "string");
  if (pattern) assert.match(result.error, pattern);
}

function wasReleased(h, target) {
  return h.events.some(([event, uri]) => event === EVENT.RELEASE && uri === target.URI);
}

function assertNativeDetachOnce(h, target) {
  assert.deepEqual(h.mutations.filter(([event]) => event === EVENT.DELETE), [[EVENT.DELETE, target.URI, false]]);
  assert.ok(h.mutations.filter(([event]) => event === EVENT.REMOVE).every(([, , recursive]) => recursive === false));
}

function assertRemovedView(result, { partial = false, persisted = true } = {}) {
  assert.equal(result.success, true, result.error);
  assert.equal(result.viewRemoved, true);
  assert.equal(result.persisted, persisted);
  assert.equal(result.partial, partial);
  assert.equal(result.cleanupComplete, !partial);
  assert.ok(Array.isArray(result.leftoverStorage));
  assert.ok(result.leftoverStorage.every(entry => typeof entry === "string"));
  if (partial) assert.equal(typeof result.warning, "string");
  else assert.deepEqual(Array.from(result.leftoverStorage), []);
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

describe("saved-search creation refuses filesystem aliases", () => {
  const SHORT_NAME = "RECEIP~1";
  const ORIGINAL_NAME = "Receipts2025";
  const SAFE_ALIAS_NAME = "New visible view";
  const ORIGINAL_DEFINITION = "original-definition";
  const ORIGINAL_STORAGE = "stored real mail";

  for (const platform of [undefined, "Linux", "Darwin", WINDOWS_OS]) {
    it(`refuses tilde followed by a digit before allocation on ${platform || "unspecified OS"}`, async () => {
      for (const name of [SHORT_NAME, "prefix~0suffix", "~9first", "embedded~123alias"]) {
        const h = makeHarness();
        if (platform) h.runtime.Services.appinfo = { OS: platform };
        assertRefused(await h.create({ name }), /~.*digit|alias|short.?name/i);
        h.assertNoMutation();
      }
    });
  }

  it("refuses the closed-original-database RECEIP~1 alias without calling addSubfolder", async () => {
    const h = makeHarness();
    const original = h.folder(h.root, ORIGINAL_NAME);
    const storage = { directory: false, content: ORIGINAL_STORAGE };
    h.disk.set(original.filePath.path, storage);
    h.disk.set(original.summaryFile.path, { directory: false });
    original.definition.scope = ORIGINAL_DEFINITION;
    assert.deepEqual(h.openDBs, []);
    let allocated;
    h.root.addSubfolder = name => {
      h.mutations.push([EVENT.ADD]);
      allocated = h.folder(h.root, name);
      allocated.URI = `${h.root.URI}/RECEIP%7E1`;
      h.fileAliases.set(allocated.filePath.path, original.filePath.path);
      h.fileAliases.set(allocated.summaryFile.path, original.summaryFile.path);
      allocated.definition = original.definition;
      return allocated;
    };
    assertRefused(await h.create({ name: SHORT_NAME }), /~.*digit|alias|short.?name/i);
    assert.equal(allocated, undefined);
    assert.equal(original.flags, 0);
    assert.equal(original.definition.scope, ORIGINAL_DEFINITION);
    assert.equal(h.disk.get(original.filePath.path), storage);
    h.assertNoMutation();
    assert.ok(!h.events.some(([event]) => [EVENT.CLOSE, EVENT.RELEASE, EVENT.ENUMERATE].includes(event)));
  });

  for (const [kind, suffix, directory] of [
    ["backing", "", false], ["summary", SUMMARY_SUFFIX, false], ["child directory", SUBFOLDER_SUFFIX, true],
  ]) {
    it(`refuses an allowed visible name whose returned ${kind} aliases existing closed-database storage`, async () => {
      const h = makeHarness();
      const original = h.folder(h.root, ORIGINAL_NAME);
      const originalPath = `${original.filePath.path}${suffix}`;
      const storage = { directory, content: ORIGINAL_STORAGE };
      h.disk.set(originalPath, storage);
      original.definition.scope = ORIGINAL_DEFINITION;
      assert.deepEqual(h.openDBs, []);
      assert.equal(h.cachedDatabases.size, 0);
      let allocated;
      h.root.addSubfolder = name => {
        h.mutations.push([EVENT.ADD]);
        allocated = h.folder(h.root, name);
        h.fileAliases.set(`${allocated.filePath.path}${suffix}`, originalPath);
        allocated.definition = original.definition;
        return allocated;
      };
      assertRefused(await h.create({ name: SAFE_ALIAS_NAME }), /storage|exist|alias/i);
      assert.notEqual(allocated.URI, original.URI);
      assert.notEqual(allocated.name, original.name);
      assert.notEqual(allocated.filePath.path, original.filePath.path);
      const returnedPath = h.file(`${allocated.filePath.path}${suffix}`);
      assert.equal(returnedPath.exists(), true);
      assert.equal(returnedPath.equals(h.file(originalPath)), true);
      assert.equal(allocated.flags, 0);
      assert.equal(original.flags, 0);
      assert.equal(original.definition.scope, ORIGINAL_DEFINITION);
      assert.equal(h.disk.get(originalPath), storage);
      assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
      assert.ok(!h.events.some(([event]) => [EVENT.CLOSE, EVENT.RELEASE, EVENT.ENUMERATE].includes(event)));
    });
  }

  it("refuses unreadable filesystem identity before setting Virtual or writing a definition", async () => {
    const h = makeHarness();
    const original = h.folder(h.root, ORIGINAL_NAME);
    h.disk.set(original.filePath.path, { directory: false, content: ORIGINAL_STORAGE });
    let allocated;
    h.root.addSubfolder = name => {
      h.mutations.push([EVENT.ADD]);
      allocated = h.folder(h.root, name);
      h.fileFailures.set(allocated.filePath.path, { equals: true });
      return allocated;
    };
    assertRefused(await h.create({ name: SAFE_ALIAS_NAME }), /identity unreadable/);
    assert.equal(allocated.flags, 0);
    assert.equal(allocated.definition.scope, "");
    assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
    assert.ok(!h.events.some(([event]) => [EVENT.CLOSE, EVENT.RELEASE].includes(event)));
  });

  it("retains independent preallocation file snapshots after the native enumerator closes", async () => {
    const h = makeHarness();
    const original = h.folder(h.root, ORIGINAL_NAME);
    const storage = { directory: false, content: ORIGINAL_STORAGE };
    h.disk.set(original.filePath.path, storage);
    h.fileFailures.set(h.root.filePath.path, { invalidateEntriesOnClose: true });
    let allocated;
    h.root.addSubfolder = name => {
      h.mutations.push([EVENT.ADD]);
      allocated = h.folder(h.root, name);
      h.fileAliases.set(allocated.filePath.path, original.filePath.path);
      return allocated;
    };
    assertRefused(await h.create({ name: SAFE_ALIAS_NAME }), /storage|exist|alias/i);
    assert.equal(allocated.flags, 0);
    assert.equal(h.disk.get(original.filePath.path), storage);
    assert.deepEqual(h.mutations.map(([event]) => event), [EVENT.ADD]);
    assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === h.root.filePath.path));
  });
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
    assertRemovedView(result);
    assertNativeDetachOnce(h, target);
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
      if (problem === DB_CLOSE_ERROR) target.failures.forceClose = true;
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

  for (const linkedSummary of [false, true]) {
    it(`never invokes the recovering flags getter${linkedSummary ? " before refusing a linked summary" : " during safe deletion"}`, () => {
      const h = makeHarness();
      const target = h.view();
      let flagReads = 0;
      Object.defineProperty(target, "flags", {
        get() { flagReads++; throw new Error("flags getter would recover a database"); },
      });
      if (linkedSummary) h.disk.set(target.summaryFile.path, { directory: false, symlink: true });
      const result = h.runtime.deleteVirtualFolder(target.URI);
      if (linkedSummary) {
        assertRefused(result);
        assert.ok(!h.events.some(([event]) => event === "openFolderDB"));
        assert.equal(wasReleased(h, target), false);
        h.assertNoMutation();
      } else {
        assertRemovedView(result);
        assertNativeDetachOnce(h, target);
      }
      assert.equal(flagReads, 0);
    });
  }

  it("refuses an unreadable in-memory Virtual flag without opening a database", () => {
    const h = makeHarness();
    const target = h.view();
    target.getFlag = () => { throw new Error("in-memory flag unavailable"); };
    assertRefused(h.runtime.deleteVirtualFolder(target.URI));
    assert.ok(!h.events.some(([event]) => event === "openFolderDB"));
    h.assertNoMutation();
  });

  it("does not retry a native delete that throws after it may have removed storage", () => {
    const h = makeHarness();
    const target = h.view();
    h.root.failures.delete = true;
    assertRefused(h.runtime.deleteVirtualFolder(target.URI), /detach failed/);
    assertNativeDetachOnce(h, target);
    assert.ok(wasReleased(h, target));
  });
});

describe("saved-search deletion proves exclusive registered storage ownership", () => {
  const STORAGE_PATHS = [["backing", ""], ["summary", SUMMARY_SUFFIX], ["child directory", SUBFOLDER_SUFFIX]];
  const INVENTORY_ERROR = "folder inventory unavailable";

  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const [targetKind, targetSuffix] of STORAGE_PATHS) {
      for (const [ownerKind, ownerSuffix] of STORAGE_PATHS) {
        it(`refuses ${platform} view ${targetKind} shared with another folder's ${ownerKind}`, () => {
          const h = makeHarness({ pathImpl });
          const target = h.view();
          const ownerPath = `${h.source.filePath.path}${ownerSuffix}`;
          const targetPath = `${target.filePath.path}${targetSuffix}`;
          h.fileAliases.set(ownerPath, targetPath);
          assert.notEqual(ownerPath, targetPath);
          assert.equal(h.file(ownerPath).equals(h.file(targetPath)), true);
          assert.deepEqual(h.openDBs, []);
          assertRefused(h.runtime.deleteVirtualFolder(target.URI));
          assert.equal(h.source.headers.length, 1);
          h.assertNoMutation();
        });
      }
    }

    for (const normalization of ["case", "Unicode", "dot segment"]) {
      it(`refuses ${platform} ownership ambiguity from ${normalization} even when native equals is false`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        let ownerPath;
        if (normalization === "Unicode") {
          const name = UNICODE_STORAGE_NAME;
          target.filePath = h.file(pathImpl.join(h.root.filePath.path, name));
          target.summaryFile = h.file(`${target.filePath.path}${SUMMARY_SUFFIX}`);
          ownerPath = pathImpl.join(h.root.filePath.path, name.normalize("NFD"));
        } else if (normalization === "dot segment") {
          ownerPath = `${target.filePath.parent.path}${pathImpl.sep}.${pathImpl.sep}${target.filePath.leafName}`;
        } else {
          ownerPath = target.filePath.path.toUpperCase();
        }
        h.source.filePath = h.file(ownerPath);
        assert.equal(h.source.filePath.equals(target.filePath), false);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    it(`refuses ${platform} view storage containing another registered folder's storage`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.disk.set(target.filePath.path, { directory: true });
      h.source.filePath = h.file(pathImpl.join(target.filePath.path, "OtherMail"));
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });

    it(`refuses ${platform} view storage nested within another folder's maildir`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.source.msgStore.storeType = MAILDIR_STORE;
      h.source.filePath = target.filePath.parent.clone();
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });

    it(`refuses ${platform} view storage containing another folder through a native ancestor alias`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.disk.set(target.filePath.path, { directory: true });
      const aliasParent = pathImpl.join(h.root.filePath.path, "VIEWAL~1");
      h.source.filePath = h.file(pathImpl.join(aliasParent, "OwnedMail"));
      h.source.summaryFile = h.file(`${h.source.filePath.path}${SUMMARY_SUFFIX}`);
      h.fileAliases.set(aliasParent, target.filePath.path);
      assert.equal(h.source.filePath.equals(target.filePath), false);
      assert.equal(h.source.filePath.parent.equals(target.filePath), true);
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });

    it(`refuses ${platform} view storage inside a maildir whose native ancestor identity is an alias`, () => {
      const h = makeHarness({ pathImpl });
      const parent = h.folder(h.root, "Container");
      const target = h.view(parent);
      h.disk.set(target.filePath.parent.path, { directory: true });
      h.source.msgStore.storeType = MAILDIR_STORE;
      h.source.filePath = h.file(pathImpl.join(h.root.filePath.path, "MAILDI~1"));
      h.fileAliases.set(h.source.filePath.path, target.filePath.parent.path);
      assert.equal(h.source.filePath.equals(target.filePath), false);
      assert.equal(h.source.filePath.equals(target.filePath.parent), true);
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });

    for (const nativeAlias of [false, true]) {
      it(`refuses another ${platform} account root sharing the view's storage namespace${nativeAlias ? " through a native alias" : " directly"}`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        if (nativeAlias) h.fileAliases.set(h.otherRoot.filePath.path, h.root.filePath.path);
        else h.otherRoot.filePath = h.root.filePath.clone();
        h.otherRoot.server.localPath = h.otherRoot.filePath.clone();
        assert.equal(h.otherRoot.filePath.equals(h.root.filePath), true);
        assert.equal(h.otherSource.filePath.equals(target.filePath), false);
        assert.equal(h.otherSource.summaryFile.equals(target.summaryFile), false);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    for (const [kind, suffix] of STORAGE_PATHS) {
      it(`refuses a ${platform} alias link in another registered folder's ${kind}`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        const ownerPath = `${h.otherSource.filePath.path}${suffix}`;
        const targetPath = `${target.filePath.path}${suffix}`;
        h.disk.set(ownerPath, {
          directory: suffix !== SUMMARY_SUFFIX,
          symlink: pathImpl !== windowsPath,
          target: targetPath,
        });
        assert.equal(h.file(ownerPath).equals(h.file(targetPath)), false);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    for (const location of ["account root", "above account root"]) {
      it(`refuses a ${platform} alias link ${location} of another registered account`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        let linkedPath = h.otherRoot.filePath.path;
        let targetPath = h.root.filePath.path;
        if (location === "above account root") {
          const aliasRoot = pathImpl === windowsPath ? "D:\\linked" : "/linked";
          const otherRootPath = pathImpl.join(aliasRoot, h.root.filePath.leafName);
          h.otherRoot.filePath = h.file(otherRootPath);
          h.otherRoot.server.localPath = h.otherRoot.filePath.clone();
          h.disk.set(otherRootPath, { directory: true });
          h.otherSource.filePath = h.file(pathImpl.join(otherRootPath, encodeURIComponent(h.otherSource.name)));
          h.otherSource.summaryFile = h.file(`${h.otherSource.filePath.path}${SUMMARY_SUFFIX}`);
          linkedPath = aliasRoot;
          targetPath = h.root.filePath.parent.path;
        }
        const owner = h.folder(h.otherRoot, VIEW_NAME);
        h.disk.set(linkedPath, { directory: true, symlink: pathImpl !== windowsPath, target: targetPath });
        assert.equal(owner.filePath.equals(target.filePath), false);
        assert.equal(owner.summaryFile.equals(target.summaryFile), false);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    it(`refuses an unreadable ${platform} storage ancestor belonging to another registered folder`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      const otherParent = h.folder(h.otherRoot, "Unreadable storage");
      const owner = h.folder(otherParent, VIEW_NAME);
      h.disk.set(owner.filePath.parent.path, { directory: true });
      h.fileFailures.set(owner.filePath.parent.path, { isReadable: true });
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });

    it(`allows distinct ${platform} sibling storage with a common name prefix`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.folder(h.root, `${VIEW_NAME}Suffix`);
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertRemovedView(result);
      assertNativeDetachOnce(h, target);
    });
  }

  it("recognizes alternate Windows separators as the same registered path", () => {
    const h = makeHarness({ pathImpl: windowsPath });
    const target = h.view();
    h.source.filePath = h.file(target.filePath.path.replace(/\\/g, "/"));
    assert.equal(h.source.filePath.equals(target.filePath), false);
    assertRefused(h.runtime.deleteVirtualFolder(target.URI));
    h.assertNoMutation();
  });

  for (const kind of ["hidden", "restricted", "saved search", "server root"]) {
    it(`checks storage belonging to another ${kind} without exposing its metadata`, () => {
      const h = makeHarness({ denied: [DENIED_ACCOUNT] });
      const target = h.view();
      const owner = kind === "hidden" ? h.hiddenSource : kind === "restricted" ? h.otherSource
        : kind === "saved search" ? h.view(h.root, "Other private view") : h.otherRoot;
      owner.filePath = target.filePath.clone();
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertRefused(result);
      assert.ok(!result.error.includes(owner.name));
      assert.ok(!result.error.includes(owner.URI));
      h.assertNoMutation();
    });
  }

  for (const inventory of ["allFolders", "accounts", "allServers", "configured accounts", "configured servers"]) {
    it(`finds shared storage visible only through ${inventory}`, () => {
      const h = makeHarness();
      const target = h.view();
      h.otherSource.summaryFile = target.summaryFile.clone();
      const service = h.runtime.MailServices.accounts;
      service.accounts = [h.accounts[0]];
      service.allServers = [h.root.server];
      service.allFolders = [h.root, h.source, target];
      h.runtime.Services.prefs.getCharPref = (name, fallback) => name === ACCOUNT_KEYS_PREF
        ? h.accounts[0].key : fallback;
      h.runtime.Services.prefs.getChildList = () => [`${SERVER_PREF_BRANCH}${h.root.server.key}.type`];
      if (inventory === "allFolders") service.allFolders.push(h.otherSource);
      if (inventory === "accounts") service.accounts.push(h.accounts[1]);
      if (inventory === "allServers") service.allServers.push(h.otherRoot.server);
      if (inventory === "configured accounts") {
        h.runtime.Services.prefs.getCharPref = (name, fallback) => name === ACCOUNT_KEYS_PREF
          ? `${h.accounts[0].key},${h.accounts[1].key}` : fallback;
      }
      if (inventory === "configured servers") {
        h.runtime.Services.prefs.getChildList = () => [`${SERVER_PREF_BRANCH}${h.otherRoot.server.key}.type`];
      }
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });
  }

  for (const failure of ["allFolders", "accounts", "allServers", "account preferences", "server preferences", "missing account", "missing server", "folder backing", "folder summary"]) {
    it(`refuses when ownership cannot be established because of ${failure}`, () => {
      const h = makeHarness();
      const target = h.view();
      if (["allFolders", "accounts", "allServers"].includes(failure)) {
        Object.defineProperty(h.runtime.MailServices.accounts, failure, { get() { throw new Error(INVENTORY_ERROR); } });
      }
      if (failure === "account preferences") h.runtime.Services.prefs.getCharPref = () => { throw new Error(INVENTORY_ERROR); };
      if (failure === "server preferences") h.runtime.Services.prefs.getChildList = () => { throw new Error(INVENTORY_ERROR); };
      if (failure === "missing account") {
        h.runtime.Services.prefs.getCharPref = (name, fallback) => name === ACCOUNT_KEYS_PREF ? "account404" : fallback;
      }
      if (failure === "missing server") h.runtime.Services.prefs.getChildList = () => [`${SERVER_PREF_BRANCH}server404.type`];
      if (failure === "folder backing") Object.defineProperty(h.otherSource, "filePath", { get() { throw new Error(INVENTORY_ERROR); } });
      if (failure === "folder summary") Object.defineProperty(h.otherSource, "summaryFile", { get() { throw new Error(INVENTORY_ERROR); } });
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });
  }
});

describe("saved-search deletion checks every native storage ancestor", () => {
  const OUTER_NAME = "Outer";
  const INNER_NAME = "Inner";
  const ANCESTORS = ["account root", "outer directory", "immediate parent"];

  for (const [platform, pathImpl] of NATIVE_PATHS) {
    it(`allows a deeply nested ${platform} view under its native parent storage`, () => {
      const h = makeHarness({ pathImpl });
      const outer = h.folder(h.root, OUTER_NAME);
      const inner = h.folder(outer, INNER_NAME);
      const target = h.view(inner);
      h.disk.set(target.filePath.path, { directory: true });
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertRemovedView(result);
      assertNativeDetachOnce(h, target);
    });

    for (const ancestor of ANCESTORS) {
      it(`refuses a ${platform} link at the ${ancestor} of a nested view`, () => {
        const h = makeHarness({ pathImpl });
        const outer = h.folder(h.root, OUTER_NAME);
        const inner = h.folder(outer, INNER_NAME);
        const target = h.view(inner);
        h.disk.set(target.filePath.path, { directory: true });
        const linkedPath = ancestor === "account root" ? h.root.filePath.path
          : ancestor === "outer directory" ? `${outer.filePath.path}${SUBFOLDER_SUFFIX}` : target.filePath.parent.path;
        h.disk.set(linkedPath, pathImpl === windowsPath
          ? { directory: true, target: "D:\\redirected\\account" }
          : { directory: true, symlink: true });
        if (pathImpl === windowsPath) assert.equal(h.file(linkedPath).isSymlink(), false);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    for (const failure of ["isReadable", "isDirectory", "isSymlink"]) {
      it(`refuses unreadable ${platform} intermediate ancestor ${failure}`, () => {
        const h = makeHarness({ pathImpl });
        const outer = h.folder(h.root, OUTER_NAME);
        const inner = h.folder(outer, INNER_NAME);
        const target = h.view(inner);
        h.disk.set(target.filePath.path, { directory: true });
        h.fileFailures.set(`${outer.filePath.path}${SUBFOLDER_SUFFIX}`, { [failure]: true });
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    for (const problem of ["missing local root", "different local root", "outside account root", "wrong native parent", "dot segment"]) {
      it(`refuses ${platform} storage with ${problem}`, () => {
        const h = makeHarness({ pathImpl });
        const parent = h.folder(h.root, OUTER_NAME);
        const target = h.view(parent);
        h.disk.set(target.filePath.path, { directory: true });
        if (problem === "missing local root") delete target.server.localPath;
        if (problem === "different local root") target.server.localPath = h.otherRoot.filePath.clone();
        if (problem === "outside account root") target.filePath = h.file(pathImpl.join(h.otherRoot.filePath.path, VIEW_NAME));
        if (problem === "wrong native parent") target.filePath = h.file(pathImpl.join(h.root.filePath.path, VIEW_NAME));
        if (problem === "dot segment") target.filePath = h.file(`${target.filePath.parent.path}${pathImpl.sep}.${pathImpl.sep}${VIEW_NAME}`);
        target.summaryFile = h.file(`${target.filePath.path}${SUMMARY_SUFFIX}`);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }

    for (const normalization of ["case", "Unicode"]) {
      it(`refuses native-distinct ${platform} configured roots that only match after ${normalization} normalization`, () => {
        const h = makeHarness({ pathImpl });
        if (normalization === "Unicode") {
          const rootPath = pathImpl.join(h.root.filePath.parent.path, UNICODE_STORAGE_NAME);
          h.root.filePath = h.file(rootPath);
          h.disk.set(rootPath, { directory: true });
          h.source.filePath = h.file(pathImpl.join(rootPath, encodeURIComponent(h.source.name)));
          h.source.summaryFile = h.file(`${h.source.filePath.path}${SUMMARY_SUFFIX}`);
          h.root.server.localPath = h.file(rootPath.normalize("NFD"));
        } else {
          h.root.server.localPath = h.file(h.root.filePath.path.toUpperCase());
        }
        const target = h.view();
        assert.equal(target.server.localPath.equals(target.server.rootFolder.filePath), false);
        assert.equal(target.server.localPath.path.normalize().toLowerCase(), h.root.filePath.path.normalize().toLowerCase());
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
      });
    }
  }
});

describe("saved-search deletion detaches and persists before nonrecursive cleanup", () => {
  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const storeType of [MBOX_STORE, MAILDIR_STORE]) {
      for (const nativeClearsVirtual of [true, false]) {
        it(`removes only the inspected ${platform} ${storeType} view with native flag clearing ${nativeClearsVirtual}`, async () => {
          const h = makeHarness({ pathImpl, nativeClearsVirtual });
          const target = h.view();
          const survivor = h.view(h.root, "Surviving view");
          target.msgStore.storeType = storeType;
          const backing = target.filePath.path;
          const summary = target.summaryFile.path;
          const children = `${backing}${SUBFOLDER_SUFFIX}`;
          h.disk.set(backing, { directory: true });
          h.disk.set(summary, { directory: false, content: SUMMARY_DEFINITION });
          h.disk.set(children, { directory: true });
          const inspected = [backing, summary, children];
          if (storeType === MAILDIR_STORE) {
            for (const name of [MAILDIR_CUR, MAILDIR_TMP]) {
              const entry = pathImpl.join(backing, name);
              h.disk.set(entry, { directory: true });
              inspected.push(entry);
            }
          }
          const mail = { directory: false, content: STORED_MAIL };
          h.disk.set(h.source.filePath.path, mail);
          const headers = h.source.headers.slice();
          const result = await h.runtime.callTool(TOOLS.DELETE, { folderPath: target.URI });
          assertRemovedView(result);
          assertNativeDetachOnce(h, target);
          assert.equal(target.parent, null);
          assert.ok(!h.root.subFolders.includes(target));
          assert.ok(!h.folders.includes(target));
          assert.equal(Boolean(target.flags & VIRTUAL_FLAG), !nativeClearsVirtual);
          assert.equal(h.virtualRegistry.has(target.URI), false);
          assert.equal(h.virtualListeners.has(target.URI), false);
          assert.equal(h.persistedViews.has(target.URI), false);
          const removed = h.mutations.filter(([event]) => event === EVENT.REMOVE).map(([, entry]) => entry);
          assert.deepEqual(removed.slice().sort(), inspected.slice().sort());
          for (const entry of inspected) assert.equal(h.file(entry).exists(), false);
          const saveIndex = h.mutations.findIndex(([event]) => event === EVENT.SAVE);
          assert.ok(saveIndex > h.mutations.findIndex(([event]) => event === EVENT.DELETE));
          assert.ok(saveIndex < h.mutations.findIndex(([event]) => event === EVENT.REMOVE));
          if (storeType === MAILDIR_STORE) {
            assert.ok(removed.indexOf(pathImpl.join(backing, MAILDIR_CUR)) < removed.indexOf(backing));
            assert.ok(removed.indexOf(pathImpl.join(backing, MAILDIR_TMP)) < removed.indexOf(backing));
          }
          assert.deepEqual(Array.from(h.runtime.listVirtualFolders(), row => row.path), [survivor.URI]);
          h.restart();
          assert.deepEqual(Array.from(h.runtime.listVirtualFolders(), row => row.path), [survivor.URI]);
          assert.equal(h.disk.get(h.source.filePath.path), mail);
          assert.deepEqual(h.source.headers, headers);
          assert.ok(!h.events.some(([event]) => event === EVENT.LOAD));
        });
      }
    }
  }

  it("never loads stale saved-search definitions that could convert a real folder", () => {
    const h = makeHarness();
    const target = h.view();
    const sourceFlags = h.source.flags;
    const sourceDefinition = { ...h.source.definition };
    h.disk.get(h.definitionsFile.path).content += `uri=${h.source.URI}\n`;
    let loads = 0;
    h.runtime.MailServices.accounts.loadVirtualFolders = () => {
      loads++;
      h.source.setFlag(VIRTUAL_FLAG);
      h.source.definition.scope = target.URI;
    };
    assertRemovedView(h.runtime.deleteVirtualFolder(target.URI));
    assert.equal(loads, 0);
    assert.equal(h.source.flags, sourceFlags);
    assert.deepEqual(h.source.definition, sourceDefinition);
  });

  it("refuses Panorama without detaching or touching storage", () => {
    const h = makeHarness();
    const target = h.view();
    h.runtime.Services.prefs.getBoolPref = (name, fallback) => name === PANORAMA_PREF ? true : fallback;
    assertRefused(h.runtime.deleteVirtualFolder(target.URI), /Panorama/i);
    h.assertNoMutation();
  });

  for (const failure of ["native before detach", "native no-op", "native after detach", "persistence throws", "persistence no-op", "cached database close"]) {
    it(`reports ${failure} honestly without deleting inspected storage`, () => {
      const h = makeHarness();
      const target = h.view();
      const backing = { directory: true };
      const summary = { directory: false, content: SUMMARY_DEFINITION };
      h.disk.set(target.filePath.path, backing);
      h.disk.set(target.summaryFile.path, summary);
      if (failure === "native before detach") h.root.failures.delete = true;
      if (failure === "native no-op") h.root.failures.noDetach = true;
      if (failure === "native after detach") h.root.failures.deleteAfterDetach = true;
      if (failure === "persistence throws") h.serviceFailures.save = true;
      if (failure === "persistence no-op") h.serviceFailures.saveNoOp = true;
      if (failure === "cached database close") {
        h.hooks.afterDetach = () => h.cacheDatabase(target, { forceClosed() { throw new Error(DB_CLOSE_ERROR); } });
      }
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertNativeDetachOnce(h, target);
      const removed = !["native before detach", "native no-op"].includes(failure);
      const persisted = !["persistence throws", "persistence no-op"].includes(failure);
      if (!removed) {
        assertRefused(result, /detach failed/);
        assert.equal(target.parent, h.root);
        assert.ok(h.root.subFolders.includes(target));
      } else {
        assertRemovedView(result, { partial: true, persisted });
        assert.ok(result.leftoverStorage.includes(target.filePath.path));
        assert.ok(result.leftoverStorage.includes(target.summaryFile.path));
        assert.equal(target.parent, null);
      }
      assert.equal(h.disk.get(target.filePath.path), backing);
      assert.equal(h.disk.get(target.summaryFile.path), summary);
      assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
      assert.equal(h.cachedDatabases.has(target), failure === "cached database close");
      if (removed) {
        h.restart();
        assert.equal(h.runtime.listVirtualFolders().some(row => row.path === target.URI), !persisted);
      }
    });
  }

  it("releases the cached database reopened by the native listener without invoking a recovering getter", () => {
    const h = makeHarness();
    const target = h.view();
    h.disk.set(target.filePath.path, { directory: true });
    const descriptor = Object.getOwnPropertyDescriptor(target, "msgDatabase");
    let getterCalls = 0;
    Object.defineProperty(target, "msgDatabase", {
      get() { getterCalls++; throw new Error("recovering getter must not run"); },
      set: descriptor.set,
    });
    let cachedCloses = 0;
    h.hooks.afterDetach = () => h.cacheDatabase(target, {
      forceClosed() {
        cachedCloses++;
        h.cachedDatabases.delete(target);
        h.cachedDatabasePaths.delete(target.filePath.path);
      },
    });
    h.removeHooks.set(target.filePath.path, () => {
      assert.equal(cachedCloses, 1);
      assert.equal(h.cachedDatabases.has(target), false);
    });
    assertRemovedView(h.runtime.deleteVirtualFolder(target.URI));
    assertNativeDetachOnce(h, target);
    assert.equal(cachedCloses, 1);
    assert.equal(getterCalls, 0);
  });

  it("reports unknown detachment state without persistence or cleanup if hierarchy inspection throws", () => {
    const h = makeHarness();
    const target = h.view();
    h.disk.set(target.filePath.path, { directory: true });
    h.hooks.afterDetach = () => Object.defineProperty(target, "parent", { get() { throw new Error(CHILDREN_UNREADABLE_ERROR); } });
    const result = h.runtime.deleteVirtualFolder(target.URI);
    assertRefused(result, /confirm.*detach/i);
    assert.equal(result.partial, true);
    assert.equal(result.viewRemoved, null);
    assert.equal(result.persisted, false);
    assert.equal(result.cleanupComplete, false);
    assertNativeDetachOnce(h, target);
    assert.ok(!h.mutations.some(([event]) => [EVENT.REMOVE, EVENT.SAVE].includes(event)));
    assert.equal(h.file(target.filePath.path).exists(), true);
  });
});

describe("saved-search deletion verifies persisted definitions without loading them", () => {
  const INVALID_DEFINITIONS = [
    ["retained target URI", target => `${VIRTUAL_DEFINITIONS_HEADER}uri=${target.URI}\n`],
    ["case-aliased target URI", target => `${VIRTUAL_DEFINITIONS_HEADER}uri=${target.URI.toUpperCase()}\n`],
    ["percent-aliased target URI", target => `${VIRTUAL_DEFINITIONS_HEADER}uri=${target.URI.replace("I", "%49")}\n`],
    ["malformed URI", () => `${VIRTUAL_DEFINITIONS_HEADER}uri=%\n`],
    ["unknown format version", () => "version=2\n"],
    ["missing format version", () => ""],
    ["invalid UTF-8", () => Buffer.from([0xff])],
    ["oversized definitions", () => VIRTUAL_DEFINITIONS_HEADER + "x".repeat(VIRTUAL_DEFINITIONS_MAX_BYTES)],
    ["underreported oversized definitions", () => VIRTUAL_DEFINITIONS_HEADER + "x".repeat(VIRTUAL_DEFINITIONS_MAX_BYTES), 1],
  ];

  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const [problem, content, size] of INVALID_DEFINITIONS) {
      it(`retains ${platform} storage after a native save leaves ${problem}`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        const backing = { directory: true };
        h.disk.set(target.filePath.path, backing);
        h.hooks.afterSave = () => {
          const entry = { directory: false, content: content(target) };
          if (size !== undefined) entry.size = size;
          h.disk.set(h.definitionsFile.path, entry);
        };
        assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true, persisted: false });
        assertNativeDetachOnce(h, target);
        assert.equal(h.disk.get(target.filePath.path), backing);
        assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
        assert.ok(!h.events.some(([event]) => event === EVENT.LOAD));
        assert.equal(h.events.filter(([event]) => event === EVENT.STREAM_OPEN).length,
          h.events.filter(([event]) => event === EVENT.STREAM_CLOSE).length);
      });
    }

    it(`refuses canonically equivalent ${platform} persisted target URIs`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view(h.root, UNICODE_STORAGE_NAME);
      const aliasURI = encodeURI(decodeURIComponent(target.URI).normalize("NFD"));
      assert.notEqual(aliasURI, target.URI);
      h.hooks.afterSave = () => h.disk.set(h.definitionsFile.path, {
        directory: false, content: `${VIRTUAL_DEFINITIONS_HEADER}uri=${aliasURI}\n`,
      });
      assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true, persisted: false });
      assertNativeDetachOnce(h, target);
      assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
    });

    it(`accepts a demonstrably absent ${platform} definition file without creating it`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.disk.set(target.filePath.path, { directory: true });
      h.hooks.afterSave = () => h.disk.delete(h.definitionsFile.path);
      assertRemovedView(h.runtime.deleteVirtualFolder(target.URI));
      assertNativeDetachOnce(h, target);
      assert.equal(h.disk.has(h.definitionsFile.path), false);
      assert.ok(!h.events.some(([event]) => [EVENT.STREAM_OPEN, EVENT.LOAD].includes(event)));
    });

    it(`refuses ambiguous ${platform} definition filenames`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      h.hooks.afterSave = () => h.disk.set(pathImpl.join(h.profile.path, VIRTUAL_DEFINITIONS_FILE.toUpperCase()), {
        directory: false, content: VIRTUAL_DEFINITIONS_HEADER,
      });
      assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true, persisted: false });
      assertNativeDetachOnce(h, target);
      assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
    });
  }

  for (const [location, failure] of [
    ["profile", "service"], ["profile", "isReadable"], ["profile", "directoryEntries"],
    ["profile", "iterate"], ["profile", "close"], ["definition", "isReadable"],
    ["definition", "isSymlink"], ["definition", "isFile"], ["definition", "fileSize"],
    ["definition", "streamInit"], ["definition", "streamAvailable"],
    ["definition", "streamRead"], ["definition", "streamClose"],
  ]) {
    it(`preserves storage when ${location} verification fails at ${failure}`, () => {
      const h = makeHarness();
      const target = h.view();
      const backing = { directory: true };
      h.disk.set(target.filePath.path, backing);
      if (failure === "service") h.serviceFailures.profile = true;
      else h.fileFailures.set((location === "profile" ? h.profile : h.definitionsFile).path, { [failure]: true });
      assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true, persisted: false });
      assertNativeDetachOnce(h, target);
      assert.equal(h.disk.get(target.filePath.path), backing);
      assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
      assert.equal(h.cachedDatabases.has(target), false);
      if (failure.startsWith("stream")) {
        assert.equal(h.events.filter(([event]) => event === EVENT.STREAM_OPEN).length, 1);
        assert.equal(h.events.filter(([event]) => event === EVENT.STREAM_CLOSE).length, 1);
      }
    });
  }

  for (const entry of [
    { directory: false, symlink: true }, { directory: true },
    { directory: false, size: -1 }, { directory: false, size: NaN },
  ]) {
    it(`preserves storage with an unexpected definition file ${JSON.stringify(entry)}`, () => {
      const h = makeHarness();
      const target = h.view();
      h.hooks.afterSave = () => h.disk.set(h.definitionsFile.path, entry);
      assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true, persisted: false });
      assertNativeDetachOnce(h, target);
      assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
    });
  }

  it("retains all storage when the nonrecovering cached-database lookup fails after detachment", () => {
    const h = makeHarness();
    const target = h.view();
    const backing = { directory: true };
    h.disk.set(target.filePath.path, backing);
    h.serviceFailures.cachedDatabase = true;
    assertRemovedView(h.runtime.deleteVirtualFolder(target.URI), { partial: true });
    assertNativeDetachOnce(h, target);
    assert.equal(h.disk.get(target.filePath.path), backing);
    assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
  });
});

describe("saved-search cleanup preserves storage changed after inspection", () => {
  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const storeType of [MBOX_STORE, MAILDIR_STORE]) {
      const locations = ["backing", "child directory", ...(storeType === MAILDIR_STORE ? [MAILDIR_CUR, MAILDIR_TMP] : [])];
      for (const location of locations) {
        for (const timing of ["after detach", "at native removal"]) {
          it(`preserves new ${platform} ${storeType} mail in ${location} ${timing}`, () => {
            const h = makeHarness({ pathImpl });
            const target = h.view();
            target.msgStore.storeType = storeType;
            const backing = target.filePath.path;
            const children = `${backing}${SUBFOLDER_SUFFIX}`;
            h.disk.set(backing, { directory: true });
            h.disk.set(children, { directory: true });
            h.disk.set(target.summaryFile.path, { directory: false, content: SUMMARY_DEFINITION });
            if (storeType === MAILDIR_STORE) {
              for (const name of [MAILDIR_CUR, MAILDIR_TMP]) h.disk.set(pathImpl.join(backing, name), { directory: true });
            }
            const removalPath = location === "backing" ? backing : location === "child directory" ? children
              : pathImpl.join(backing, location);
            const messagePath = pathImpl.join(removalPath, "late-message.eml");
            const mail = { directory: false, content: STORED_MAIL };
            const inject = () => h.disk.set(messagePath, mail);
            if (timing === "after detach") h.hooks.afterDetach = inject;
            else h.removeHooks.set(removalPath, inject);
            const result = h.runtime.deleteVirtualFolder(target.URI);
            assertRemovedView(result, { partial: true });
            assertNativeDetachOnce(h, target);
            assert.equal(h.disk.get(messagePath), mail);
            assert.ok(result.leftoverStorage.includes(location === "child directory" ? children : backing));
            assert.ok(!h.mutations.some(([event, entry]) => event === EVENT.REMOVE && entry === messagePath));
            assert.equal(h.virtualRegistry.has(target.URI), false);
            assert.equal(h.persistedViews.has(target.URI), false);
            h.restart();
            assert.ok(!h.runtime.listVirtualFolders().some(row => row.path === target.URI));
            assert.equal(h.disk.get(messagePath).content, STORED_MAIL);
          });
        }
      }

      it(`retains a ${platform} ${storeType} backing directory replaced with a regular mail file during detachment`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        target.msgStore.storeType = storeType;
        const backing = target.filePath.path;
        const mail = { directory: false, content: STORED_MAIL };
        h.disk.set(backing, { directory: true });
        h.hooks.afterDetach = () => h.disk.set(backing, mail);
        const result = h.runtime.deleteVirtualFolder(target.URI);
        assertRemovedView(result, { partial: true });
        assertNativeDetachOnce(h, target);
        assert.equal(h.disk.get(backing), mail);
        assert.ok(result.leftoverStorage.includes(backing));
        assert.ok(!h.mutations.some(([event, entry]) => event === EVENT.REMOVE && entry === backing));
      });

      for (const [kind, suffix] of [["backing", ""], ["summary", SUMMARY_SUFFIX], ["child directory", SUBFOLDER_SUFFIX]]) {
        it(`retains uninspected ${platform} ${storeType} ${kind} created after initially absent storage`, () => {
          const h = makeHarness({ pathImpl });
          const target = h.view();
          target.msgStore.storeType = storeType;
          const addedPath = `${target.filePath.path}${suffix}`;
          const added = { directory: suffix === SUBFOLDER_SUFFIX || (suffix === "" && storeType === MAILDIR_STORE), content: STORED_MAIL };
          h.hooks.afterDetach = () => h.disk.set(addedPath, added);
          const result = h.runtime.deleteVirtualFolder(target.URI);
          assertRemovedView(result, { partial: true });
          assertNativeDetachOnce(h, target);
          assert.equal(h.disk.get(addedPath), added);
          assert.ok(result.leftoverStorage.includes(addedPath));
          assert.ok(!h.mutations.some(([event]) => event === EVENT.REMOVE));
        });
      }
    }

    it(`refuses even an empty ${platform} regular mbox backing before an append-on-detach hook can run`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      const mail = { directory: false, content: "" };
      h.disk.set(target.filePath.path, mail);
      let detachAttempts = 0;
      h.hooks.beforeDetach = () => { detachAttempts++; mail.content = STORED_MAIL; };
      assertRefused(h.runtime.deleteVirtualFolder(target.URI), /regular backing file/);
      assert.equal(detachAttempts, 0);
      assert.equal(h.disk.get(target.filePath.path), mail);
      assert.equal(mail.content, "");
      h.assertNoMutation();
    });

    it(`retains ${platform} storage when an inspected removal fails without retrying recursively`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      const backing = { directory: true };
      h.disk.set(target.filePath.path, backing);
      h.fileFailures.set(target.filePath.path, { remove: true });
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertRemovedView(result, { partial: true });
      assertNativeDetachOnce(h, target);
      assert.equal(h.disk.get(target.filePath.path), backing);
      assert.deepEqual(h.mutations.filter(([event]) => event === EVENT.REMOVE), [[EVENT.REMOVE, target.filePath.path, false]]);
    });

    it(`uses cloned ${platform} inspection paths after enumeration and native folder metadata change`, () => {
      const h = makeHarness({ pathImpl });
      const target = h.view();
      const backing = target.filePath.path;
      const summary = target.summaryFile.path;
      h.disk.set(backing, { directory: true });
      h.disk.set(summary, { directory: false, content: SUMMARY_DEFINITION });
      h.fileFailures.set(h.root.filePath.path, { invalidateEntriesOnClose: true });
      const mailPath = pathImpl.join(h.root.filePath.path, "UnrelatedMail");
      const mail = { directory: false, content: STORED_MAIL };
      h.disk.set(mailPath, mail);
      let originalCloses = 0;
      let unrelatedCloses = 0;
      const unrelatedDatabase = { forceClosed() { unrelatedCloses++; } };
      h.cacheDatabase(h.source, unrelatedDatabase, mailPath);
      h.hooks.afterDetach = () => {
        h.cacheDatabase(target, {
          forceClosed() {
            originalCloses++;
            h.cachedDatabases.delete(target);
            h.cachedDatabasePaths.delete(backing);
          },
        }, backing);
        target.filePath.leafName = pathImpl.basename(mailPath);
        target.summaryFile.leafName = pathImpl.basename(mailPath) + SUMMARY_SUFFIX;
      };
      const result = h.runtime.deleteVirtualFolder(target.URI);
      assertRemovedView(result);
      assertNativeDetachOnce(h, target);
      assert.deepEqual(h.mutations.filter(([event]) => event === EVENT.REMOVE).map(([, entry]) => entry).sort(), [backing, summary].sort());
      assert.equal(h.disk.get(mailPath), mail);
      assert.equal(originalCloses, 1);
      assert.equal(unrelatedCloses, 0);
      assert.equal(h.cachedDatabasePaths.get(mailPath), unrelatedDatabase);
      assert.ok(h.events.some(([event, entry]) => event === EVENT.CACHED_DB && entry === backing));
    });
  }
});

describe("saved-search deletion rejects unsafe summaries before opening a database", () => {
  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const normalization of ["case", "Unicode"]) {
      for (const [kind, suffix] of [["backing", ""], ["summary", SUMMARY_SUFFIX], ["child directory", SUBFOLDER_SUFFIX]]) {
        it(`refuses native-distinct ${platform} ${kind} found only by ${normalization} normalization`, () => {
          const h = makeHarness({ pathImpl });
          const target = h.view();
          if (normalization === "Unicode") {
            target.filePath = h.file(pathImpl.join(h.root.filePath.path, UNICODE_STORAGE_NAME));
            target.summaryFile = h.file(`${target.filePath.path}${SUMMARY_SUFFIX}`);
          }
          const expected = `${target.filePath.path}${suffix}`;
          const candidateName = normalization === "case" ? pathImpl.basename(expected).toUpperCase()
            : pathImpl.basename(expected).normalize("NFD");
          const candidate = pathImpl.join(h.root.filePath.path, candidateName);
          const storage = { directory: suffix !== SUMMARY_SUFFIX, content: STORED_MAIL };
          h.disk.set(candidate, storage);
          assert.equal(h.file(candidate).equals(h.file(expected)), false);
          assertRefused(h.runtime.deleteVirtualFolder(target.URI));
          assert.equal(h.disk.get(candidate), storage);
          assert.ok(!h.events.some(([event]) => event === "openFolderDB"));
          assert.equal(wasReleased(h, target), false);
          h.assertNoMutation();
        });
      }
    }

    for (const [kind, entry] of [
      ["symlink", { directory: false, symlink: true }],
      ["unreadable file", { directory: false, readable: false }],
      ["directory", { directory: true }],
      ["nonregular file", { directory: false, regular: false }],
      ["unknown type", {}],
    ]) {
      it(`refuses a ${platform} summary that is a ${kind} without opening or committing it`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        h.disk.set(target.summaryFile.path, entry);
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        assert.equal(h.disk.get(target.summaryFile.path), entry);
        assert.ok(!h.events.some(([event]) => ["openFolderDB", EVENT.CLOSE, EVENT.FORCE_CLOSE].includes(event)));
        assert.equal(wasReleased(h, target), false);
        h.assertNoMutation();
      });
    }
  }
});

describe("saved-search deletion proves backing storage is empty", () => {

  for (const [platform, pathImpl] of NATIVE_PATHS) {
    for (const nativeThrows of [false, true]) {
        it(`detaches an empty native mbox directory once on ${platform}${nativeThrows ? ", even when native detachment throws" : ""}`, async () => {
          const h = makeHarness({ pathImpl });
          const target = h.view();
          h.disk.set(target.filePath.path, { directory: true });
          h.disk.set(target.summaryFile.path, { directory: false, content: SUMMARY_DEFINITION });
          h.root.failures.delete = nativeThrows;
          assert.match(target.filePath.path, pathImpl === windowsPath ? /^[A-Z]:\\/ : /^\//);
          const result = await h.runtime.callTool(TOOLS.DELETE, { folderPath: target.URI });
          if (nativeThrows) assertRefused(result, /detach failed/);
          else assertRemovedView(result);
          assertNativeDetachOnce(h, target);
          assert.ok(h.events.some(([event, uri]) => event === EVENT.ENUMERATE && uri === target.URI));
          assert.ok(wasReleased(h, target));
          assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === target.filePath.path));
        });
    }

    for (const [kind, arrange] of [
      ["nonempty directory", (h, target) => h.disk.set(pathImpl.join(target.filePath.path, "message"), { directory: false, content: STORED_MAIL })],
      ["directory containing an empty subdirectory", (h, target) => h.disk.set(pathImpl.join(target.filePath.path, MAILDIR_CUR), { directory: true })],
      ["symlink directory", (h, target) => h.disk.set(target.filePath.path, { directory: true, symlink: true })],
    ]) {
      it(`refuses mbox backing that is a ${kind} on ${platform}`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        h.disk.set(target.filePath.path, { directory: true });
        arrange(h, target);
        const before = Array.from(h.disk.entries());
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        assert.deepEqual(Array.from(h.disk.entries()), before);
        h.assertNoMutation();
      });
    }

    for (const failure of ["directoryEntries", "iterate", "close"]) {
      it(`refuses an unreadable mbox backing directory (${failure}) on ${platform}`, () => {
        const h = makeHarness({ pathImpl });
        const target = h.view();
        h.disk.set(target.filePath.path, { directory: true });
        h.fileFailures.set(target.filePath.path, { [failure]: true });
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
        if (failure !== "directoryEntries") {
          assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === target.filePath.path));
        }
      });
    }
  }

  it("refuses an empty Windows reparse backing directory even when isSymlink reports false", () => {
    const h = makeHarness({ pathImpl: windowsPath });
    const target = h.view();
    h.disk.set(target.filePath.path, { directory: true, target: "D:\\redirected\\mail" });
    assert.equal(target.filePath.isSymlink(), false);
    assertRefused(h.runtime.deleteVirtualFolder(target.URI));
    h.assertNoMutation();
  });

  for (const kind of [MBOX_STORE, MAILDIR_STORE, "orphan child directory"]) {
    it(`preserves unindexed ${kind} mail despite a valid empty database and no registered children`, async () => {
      const h = makeHarness();
      const target = h.view();
      if (kind === MAILDIR_STORE) target.msgStore.storeType = MAILDIR_STORE;
      const backing = target.filePath.path;
      const childDirectory = `${backing}${SUBFOLDER_SUFFIX}`;
      const storedPath = kind === MBOX_STORE ? backing
        : kind === MAILDIR_STORE ? `${backing}/${MAILDIR_CUR}/message` : `${childDirectory}/UnindexedMail`;
      if (kind !== MBOX_STORE) h.disk.set(kind === MAILDIR_STORE ? backing : childDirectory, { directory: true });
      const stored = { directory: false, content: STORED_MAIL };
      h.disk.set(storedPath, stored);
      if (kind === MAILDIR_STORE) {
        assert.equal(h.disk.has(`${backing}/${MAILDIR_CUR}`), false,
          "sparse fixture must reveal the implied cur directory without an explicit map entry");
      }
      assert.equal(target.database.summaryValid, true);
      assert.equal(target.headers.length, 0);
      assert.equal(target.hasSubFolders, false);
      let deletions = 0;
      h.root.propagateDelete = (folder, deleteStorage) => {
        assert.equal(folder, target);
        assert.equal(deleteStorage, false);
        deletions++;
        for (const entry of [...h.disk.keys()]) {
          if (entry === backing || entry.startsWith(`${backing}/`) ||
              entry === childDirectory || entry.startsWith(`${childDirectory}/`)) h.disk.delete(entry);
        }
      };
      assertRefused(await h.runtime.callTool(TOOLS.DELETE, { folderPath: target.URI }));
      assert.equal(deletions, 0);
      assert.equal(h.disk.get(storedPath), stored);
      assert.equal(target.flags, VIRTUAL_FLAG);
      h.assertNoMutation();
    });
  }

  for (const [kind, arrange] of [
    ["absent storage", () => {}],
    ["absent maildir storage", (_h, target) => { target.msgStore.storeType = MAILDIR_STORE; }],
    ["empty backing directory", (h, target) => {
      target.msgStore.storeType = MAILDIR_STORE;
      h.disk.set(target.filePath.path, { directory: true });
    }],
    ["empty expected maildir directories", (h, target) => {
      target.msgStore.storeType = MAILDIR_STORE;
      h.disk.set(target.filePath.path, { directory: true });
      h.disk.set(`${target.filePath.path}/${MAILDIR_CUR}`, { directory: true });
      h.disk.set(`${target.filePath.path}/${MAILDIR_TMP}`, { directory: true });
    }],
    ["empty orphan child directory", (h, target) => h.disk.set(`${target.filePath.path}${SUBFOLDER_SUFFIX}`, { directory: true })],
    ["nonempty summary with absent backing", (h, target) => h.disk.set(target.summaryFile.path, { directory: false, content: SUMMARY_DEFINITION })],
  ]) {
    it(`allows view-only deletion with ${kind}, retaining the own-header check`, async () => {
      const h = makeHarness();
      const target = h.view();
      arrange(h, target);
      const result = await h.runtime.callTool(TOOLS.DELETE, { folderPath: target.URI });
      assertRemovedView(result);
      assertNativeDetachOnce(h, target);
      assert.ok(h.events.some(([event, uri]) => event === EVENT.ENUMERATE && uri === target.URI));
      assert.ok(wasReleased(h, target));
    });
  }

  for (const [kind, arrange] of [
    ["regular backing file even when zero-byte", (h, target) => h.disk.set(target.filePath.path, { directory: false, size: 0 })],
    ["unreadable backing file", (h, target) => h.disk.set(target.filePath.path, { directory: false, readable: false })],
    ["unreadable backing directory", (h, target) => h.disk.set(target.filePath.path, { directory: true, readable: false })],
    ["nonregular backing file", (h, target) => h.disk.set(target.filePath.path, { directory: false, regular: false })],
    ["unknown backing type", (h, target) => h.disk.set(target.filePath.path, {})],
    ["regular backing for maildir", (h, target) => h.disk.set(target.filePath.path, { directory: false })],
    ["symlink backing file", (h, target) => h.disk.set(target.filePath.path, { directory: false, symlink: true })],
    ["symlink backing directory", (h, target) => h.disk.set(target.filePath.path, { directory: true, symlink: true })],
    ["dangling backing symlink", (h, target) => h.disk.set(target.filePath.path, { directory: false, symlink: true, exists: false })],
    ["unexpected empty maildir subdirectory", (h, target) => h.disk.set(`${target.filePath.path}/new`, { directory: true })],
    ["unexpected empty maildir file", (h, target) => h.disk.set(`${target.filePath.path}/lock`, { directory: false })],
    ["message in temporary maildir", (h, target) => h.disk.set(`${target.filePath.path}/${MAILDIR_TMP}/inflight`, { directory: false, content: STORED_MAIL })],
    ["non-directory maildir cur entry", (h, target) => h.disk.set(`${target.filePath.path}/${MAILDIR_CUR}`, { directory: false })],
    ["symlink maildir cur entry", (h, target) => h.disk.set(`${target.filePath.path}/${MAILDIR_CUR}`, { directory: true, symlink: true })],
    ["unreadable maildir cur entry", (h, target) => h.disk.set(`${target.filePath.path}/${MAILDIR_CUR}`, { directory: true, readable: false })],
    ["non-directory child storage", (h, target) => h.disk.set(`${target.filePath.path}${SUBFOLDER_SUFFIX}`, { directory: false })],
    ["symlink child directory", (h, target) => h.disk.set(`${target.filePath.path}${SUBFOLDER_SUFFIX}`, { directory: true, symlink: true })],
    ["unreadable child directory", (h, target) => h.disk.set(`${target.filePath.path}${SUBFOLDER_SUFFIX}`, { directory: true, readable: false })],
    ["unknown child storage type", (h, target) => h.disk.set(`${target.filePath.path}${SUBFOLDER_SUFFIX}`, {})],
    ["unreadable parent directory", (h, target) => h.disk.set(target.filePath.parent.path, { directory: true, readable: false })],
    ["symlink parent directory", (h, target) => h.disk.set(target.filePath.parent.path, { directory: true, symlink: true })],
    ["missing backing path", (_h, target) => { target.filePath = null; }],
  ]) {
    it(`refuses ${kind} without deleting raw storage`, () => {
      const h = makeHarness();
      const target = h.view();
      if (kind.includes(MAILDIR_STORE)) target.msgStore.storeType = MAILDIR_STORE;
      arrange(h, target);
      const before = Array.from(h.disk.entries());
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      assert.deepEqual(Array.from(h.disk.entries()), before);
      h.assertNoMutation();
    });
  }

  for (const size of [undefined, null, "0", -1, NaN, Infinity, 0.5]) {
    it(`refuses invalid backing file size ${String(size)} without deletion`, () => {
      const h = makeHarness();
      const target = h.view();
      h.disk.set(target.filePath.path, { directory: false, size });
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });
  }

  for (const storeType of [undefined, null, "", "future-store"]) {
    it(`refuses unsupported storage backend ${String(storeType)} even with absent backing`, () => {
      const h = makeHarness();
      const target = h.view();
      target.msgStore.storeType = storeType;
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });
  }

  it("refuses an unreadable storage backend without deleting anything", () => {
    const h = makeHarness();
    const target = h.view();
    Object.defineProperty(target, "msgStore", { get() { throw new Error("message store unavailable"); } });
    assertRefused(h.runtime.deleteVirtualFolder(target.URI));
    h.assertNoMutation();
  });

  it("allows readable Windows storage whose resolved ancestor targets are unchanged", () => {
    const h = makeHarness();
    const target = h.view();
    h.runtime.Services.appinfo = { OS: WINDOWS_OS };
    h.disk.set(target.filePath.path, { directory: true });
    const result = h.runtime.deleteVirtualFolder(target.URI);
    assertRemovedView(result);
    assertNativeDetachOnce(h, target);
  });

  for (const [kind, arrange] of [
    ["redirected backing file", (h, target) => h.disk.set(target.filePath.path, { directory: false, target: "/redirected/mail" })],
    ["junction ancestor", (h, target) => h.disk.set(target.filePath.parent.path, { directory: true, target: "/redirected/account" })],
    ["empty target", (h, target) => h.disk.set(target.filePath.path, { directory: false, target: "" })],
    ["unreadable target", (h, target) => h.fileFailures.set(target.filePath.path, { target: true })],
  ]) {
    it(`refuses a Windows ${kind} even when isSymlink reports false`, () => {
      const h = makeHarness();
      const target = h.view();
      h.runtime.Services.appinfo = { OS: WINDOWS_OS };
      h.disk.set(target.filePath.path, { directory: false });
      arrange(h, target);
      assert.equal(target.filePath.isSymlink(), false);
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
    });
  }

  for (const failure of ["isFile", "isDirectory", "isReadable", "isSymlink", "fileSize", "equals"]) {
    it(`refuses unreadable backing ${failure} metadata without deletion`, () => {
      const h = makeHarness();
      const target = h.view();
      if (failure === "isDirectory") target.msgStore.storeType = MAILDIR_STORE;
      h.disk.set(target.filePath.path, { directory: failure === "isDirectory" });
      h.fileFailures.set(target.filePath.path, { [failure]: true });
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
      if (failure === "equals") {
        assert.equal(wasReleased(h, target), false, "ownership must be established before opening the database");
      } else {
        assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === target.filePath.parent.path));
      }
    });
  }

  for (const location of ["parent", "backing", "cur", "child directory"]) {
    for (const failure of ["directoryEntries", "iterate", "close"]) {
      it(`refuses ${location} ${failure} failure and closes acquired enumerators`, () => {
        const h = makeHarness();
        const target = h.view();
        if (location === "backing" || location === MAILDIR_CUR) target.msgStore.storeType = MAILDIR_STORE;
        const targetPath = location === "parent" ? target.filePath.parent.path
          : location === "backing" ? target.filePath.path
            : location === "cur" ? `${target.filePath.path}/${MAILDIR_CUR}`
              : `${target.filePath.path}${SUBFOLDER_SUFFIX}`;
        h.disk.set(targetPath, { directory: true });
        h.fileFailures.set(targetPath, { [failure]: true });
        assertRefused(h.runtime.deleteVirtualFolder(target.URI));
        h.assertNoMutation();
        if (failure !== "directoryEntries") {
          assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === targetPath));
        }
      });
    }
  }

  for (const failure of ["leafName", "isDirectory", "isReadable", "isSymlink"]) {
    it(`refuses unreadable maildir entry ${failure} and closes its parent enumerator`, () => {
      const h = makeHarness();
      const target = h.view();
      target.msgStore.storeType = MAILDIR_STORE;
      const current = `${target.filePath.path}/${MAILDIR_CUR}`;
      h.disk.set(current, { directory: true });
      h.fileFailures.set(current, { [failure]: true });
      assertRefused(h.runtime.deleteVirtualFolder(target.URI));
      h.assertNoMutation();
      assert.ok(h.events.some(([event, entry]) => event === EVENT.DIRECTORY_CLOSE && entry === target.filePath.path));
    });
  }
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
