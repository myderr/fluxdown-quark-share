import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const resolverSource = fs.readFileSync(path.join(root, "resolver.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function loadScript(source, flux, extra = {}) {
  const context = {
    flux,
    console,
    Date,
    Error,
    JSON,
    Math,
    Promise,
    String,
    Number,
    Array,
    Object,
    RegExp,
    Set,
    Map,
    isFinite,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout: extra.setTimeout || ((fn) => { Promise.resolve().then(fn); return 1; }),
    clearTimeout() {},
    ...extra.globals,
  };
  vm.runInNewContext(source, context, { filename: extra.filename || "plugin.js" });
  return context;
}

function loadResolver(flux = {}) {
  return loadScript(resolverSource, flux, { filename: "resolver.js" });
}

function loadMain(flux = {}) {
  return loadScript(mainSource, {
    tasks: { async get(taskId) { return { taskId, status: 3 }; } },
    logger: { warn() {} },
    ...flux,
  }, { filename: "main.js" });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      async get(key) { return values.has(key) ? values.get(key) : null; },
      async set(key, value) { values.set(key, value); },
    },
  };
}

function makeFetchQueue(responses, statuses = []) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (options) => {
    calls.push(options);
    const body = responses[index];
    const status = statuses[index] || 200;
    index += 1;
    if (body instanceof Error) throw body;
    return { status, headers: {}, body: JSON.stringify(body), truncated: false };
  };
  return { calls, fetchImpl };
}

function taskRecord(files, overrides = {}) {
  const now = Date.now();
  return {
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    files,
    ...overrides,
  };
}

test("manifest targets FluxDown 0.6.8 and declares localized settings", () => {
  assert.equal(manifest.identity, "myderr@quark-share");
  assert.equal(manifest.version, "0.2.1");
  assert.equal(manifest.minAppVersion, "0.6.8");
  assert.equal(manifest.resolvers[0].timeoutMs, 30000);
  assert.equal(manifest.resolvers[0].multi, true);
  assert.deepEqual(manifest.hooks.events, ["onDone", "onError", "onCancel"]);
  assert.equal(manifest.auth, undefined);
  assert.equal(manifest.main.entry, "main.js");
  assert.equal(manifest.main.background, true);
  assert.deepEqual(manifest.permissions, ["background", "tasks", "pageScripts"]);
  assert.equal(manifest.contributes.views[0].id, "cleanup");
  const settings = Object.fromEntries(manifest.settings.map((item) => [item.key, item]));
  assert.equal(settings.maxFiles.default, "200");
  assert.equal(settings.maxFiles.max, 1000);
  assert.equal(settings.cleanupIntervalHours.default, "6");
  assert.equal(settings.cookie.required, true);
  assert.equal(settings.cookie.widget, "textarea");
  assert.equal(settings.targetFolderId.required, false);
  for (const field of manifest.settings) {
    assert.equal(field.localizations.zh.title, field.title);
    assert.equal(field.localizations.zh.description, field.description);
    assert.ok(field.localizations.en.title.trim(), field.key);
    assert.ok(field.localizations.en.description.trim(), field.key);
  }
});

test("resolver exposes lifecycle, manifest, and cleanup entry points", () => {
  const context = loadResolver();
  for (const name of ["resolve", "parseShareUrl", "onDone", "onError", "onCancel", "readCleanupRegistry"]) {
    assert.equal(typeof context[name], "function", name);
  }
});

test("share URL parser handles root, nested directories, and invalid values", () => {
  const { parseShareUrl } = loadResolver();
  assert.deepEqual(clone(parseShareUrl("https://pan.quark.cn/s/example-share?pwd=abcd")), {
    pwdId: "example-share",
    passcode: "abcd",
    parentFid: "0",
  });
  assert.equal(
    parseShareUrl("https://pan.quark.cn/s/example-share?entry=webother#/list/share/00000000000000000000000000000001").parentFid,
    "00000000000000000000000000000001",
  );
  assert.throws(() => parseShareUrl("https://example.com/s/abc"), /invalid Quark share URL/i);
  assert.throws(() => parseShareUrl("https://pan.quark.cn/s/abc#/list/share/not-a-fid"), /invalid directory fid/i);
});

test("share detail pagination follows all pages needed to find direct files", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ dir: true, fid: `d-${index}`, file_name: `dir-${index}` }));
  const queued = makeFetchQueue([
    { code: 0, data: { list: firstPage, metadata: { _total: 52 } } },
    { code: 0, data: { list: [
      { dir: false, file: true, fid: "f1", file_name: "one.apk", share_fid_token: "t1", size: 101 },
      { dir: false, file: true, fid: "f2", file_name: "two.apk", share_fid_token: "t2", size: 102 },
    ], metadata: { _total: 52 } } },
  ]);
  const context = loadResolver();
  const client = context.createQuarkClient({ cookie: "cookie-value" }, queued.fetchImpl);
  const entries = await client.listShareFiles("share-1", "stoken-1", "0", 1, "", Date.now() + 1000);
  assert.deepEqual(clone(entries.map((item) => item.fid)), ["f1"]);
  assert.equal(queued.calls.length, 2);
  assert.match(queued.calls[0].url, /_page=1/);
  assert.match(queued.calls[1].url, /_page=2/);
});

test("Quark API errors preserve code and sanitized message without leaking Cookie", async () => {
  const queued = makeFetchQueue([{ code: 1001, message: "invalid share" }]);
  const context = loadResolver();
  const client = context.createQuarkClient({ cookie: "uid=secret; session=secret" }, queued.fetchImpl);
  await assert.rejects(
    () => client.getShareToken("share-1", ""),
    (error) => /code 1001/.test(error.message) && /invalid share/.test(error.message) && !/secret/.test(error.message),
  );
});

test("first resolve pass returns a manifest without transferring any file", async () => {
  const queued = makeFetchQueue([
    { code: 0, data: { stoken: "stoken-1" } },
    { code: 0, data: { list: [
      { dir: false, file: true, fid: "f1", file_name: "one.apk", share_fid_token: "t1", size: 101 },
      { dir: false, file: true, fid: "f2", file_name: "two.apk", share_fid_token: "t2", size: 102 },
    ] } },
  ]);
  const context = loadResolver({
    settings: { cookie: "cookie-value", maxFiles: 200 },
    fetch: queued.fetchImpl,
  });
  const result = clone(await context.resolve({
    taskId: "preview-task",
    url: "https://pan.quark.cn/s/share-1",
    resolverItem: "",
  }));
  assert.equal(result.manifest.items.length, 2);
  assert.deepEqual(result.manifest.items.map((item) => item.id), ["f1", "f2"]);
  assert.equal(queued.calls.length, 2);
  assert.equal(queued.calls.some((call) => call.url.includes("/share/sharepage/save")), false);
  await assert.rejects(context.resolve({ url: "https://pan.quark.cn/s/share-1", resolverItem: "f1" }), /目标目录 ID/);
  assert.equal(queued.calls.length, 2);
});

test("second resolve pass transfers only the selected manifest item and records cleanup", async () => {
  const queued = makeFetchQueue([
    { code: 0, data: { stoken: "stoken-1" } },
    { code: 0, data: { list: [
      { dir: false, file: true, fid: "f1", file_name: "one.apk", share_fid_token: "t1", size: 101 },
      { dir: false, file: true, fid: "f2", file_name: "two.apk", share_fid_token: "t2", size: 102 },
    ] } },
    { code: 0, data: { task_id: "save-task" } },
    { code: 0, data: { status: 2, save_as: { save_as_top_fids: ["saved-2"] } } },
    { code: 0, data: [{ fid: "saved-2", download_url: "https://download.example/two.apk" }] },
  ]);
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify({
    tasks: { "task-42": taskRecord([{ fid: "previous", fileName: "two.apk" }]) },
  }) });
  const context = loadResolver({
    settings: { cookie: "cookie-value", targetFolderId: "target-1", maxFiles: 1 },
    fetch: queued.fetchImpl,
    storage: store.storage,
  });
  const result = clone(await context.resolve({
    taskId: "task-42",
    url: "https://pan.quark.cn/s/share-1",
    resolverItem: "f2",
  }));
  assert.equal(result.url, "https://download.example/two.apk");
  assert.equal(result.fileName, "two.apk");
  assert.deepEqual(JSON.parse(queued.calls[2].body).fid_list, ["f2"]);
  const registry = JSON.parse(store.values.get("quarkCleanupRegistryV2"));
  assert.deepEqual(registry.tasks["task-42"].files, [
    { fid: "previous", fileName: "two.apk" },
    { fid: "saved-2", fileName: "two.apk" },
  ]);
});

test("onError records backoff instead of deleting a transfer needed by retry", async () => {
  const registry = {
    tasks: {
      "task-42": taskRecord([{ fid: "saved-1", fileName: "one.apk" }]),
    },
  };
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify(registry) });
  const queued = makeFetchQueue([]);
  const context = loadResolver({
    settings: { cookie: "cookie-value", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
    storage: store.storage,
    logger: { warn() {} },
  });
  await context.onError({ taskId: "task-42", message: "temporary network failure" });
  assert.equal(queued.calls.length, 0);
  const record = JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks["task-42"];
  assert.equal(record.attempts, 1);
  assert.ok(record.nextAttemptAt > Date.now());
  assert.match(record.lastError, /temporary network failure/);
});

test("onDone and onCancel delete only their own registered transfer records", async () => {
  const registry = {
    tasks: {
      "task-done": taskRecord([{ fid: "saved-done", fileName: "done.apk" }]),
      "task-cancel": taskRecord([
        { fid: "saved-cancel-1", fileName: "one.apk" },
        { fid: "saved-cancel-2", fileName: "two.apk" },
      ]),
    },
  };
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify(registry) });
  const queued = makeFetchQueue([
    { code: 0, data: { task_id: "delete-1" } },
    { code: 0, data: { task_id: "delete-2" } },
  ]);
  const context = loadResolver({
    settings: { cookie: "cookie-value", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
    storage: store.storage,
    logger: { warn() {} },
  });
  await context.onDone({ taskId: "task-done", filePath: "D:/download/done.apk" });
  await context.onCancel({ taskId: "task-cancel", reason: "variant_selection_cancelled" });
  assert.deepEqual(JSON.parse(queued.calls[0].body).filelist, ["saved-done"]);
  assert.deepEqual(JSON.parse(queued.calls[1].body).filelist, ["saved-cancel-1", "saved-cancel-2"]);
  assert.deepEqual(JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks, {});
});

test("cleanup sweep retains records on failure and clears only successful deletes", async () => {
  const registry = {
    tasks: {
      "task-fail": taskRecord([{ fid: "saved-fail", fileName: "fail.apk" }]),
      "task-ok": taskRecord([{ fid: "saved-ok", fileName: "ok.apk" }], { createdAt: Date.now() + 1 }),
    },
  };
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify(registry) });
  const queued = makeFetchQueue([
    { code: 1001, message: "delete rejected" },
    { code: 0, data: { task_id: "delete-ok" } },
  ]);
  const context = loadMain({
    settings: { cookie: "cookie-value", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
    storage: store.storage,
    logger: { warn() {} },
  });
  const result = await context.sweepCleanup();
  assert.equal(result.cleaned, 1);
  assert.equal(result.failed, 1);
  const remaining = JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks;
  assert.equal(remaining["task-ok"], undefined);
  assert.equal(remaining["task-fail"].attempts, 1);
  assert.match(remaining["task-fail"].lastError, /code 1001/);
});

test("background cleanup entry deletes due records and clears the registry", async () => {
  const registry = {
    tasks: {
      "task-42": taskRecord([{ fid: "saved-1", fileName: "one.apk" }], { nextAttemptAt: 0 }),
    },
  };
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify(registry) });
  const queued = makeFetchQueue([{ code: 0, data: { task_id: "delete-task" } }]);
  const flux = {
    settings: { cookie: "cookie-value", cleanupIntervalHours: 6 },
    storage: store.storage,
    fetch: queued.fetchImpl,
    logger: { warn() {} },
    events: { on() {} },
    timers: { setTimeout() { return 1; }, setInterval() { return 2; } },
    ui: { view() {}, h() {}, toast() {} },
  };
  const context = loadMain(flux);
  const result = await context.sweepCleanup();
  assert.equal(result.cleaned, 1);
  assert.deepEqual(JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks, {});
  assert.equal(queued.calls.length, 1);
});

test("resolver uses the configured Cookie even when the task carries another account", async () => {
  const queued = makeFetchQueue([
    { code: 0, data: { stoken: "stoken-1" } },
    { code: 0, data: { list: [{ dir: false, file: true, fid: "f1", file_name: "one.apk", share_fid_token: "t1", size: 101 }] } },
  ]);
  const context = loadResolver({
    settings: { cookie: "configured-cookie", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
  });
  await context.resolve({
    taskId: "preview-task",
    url: "https://pan.quark.cn/s/share-1",
    resolverItem: "",
    cookies: "captured-cookie",
  });
  assert.equal(queued.calls[0].headers.Cookie, "configured-cookie");
});

test("cleanup sweep migrates legacy V1 records into V2 on success", async () => {
  const legacy = {
    tasks: {
      "legacy-task": {
        createdAt: Date.now(),
        files: [{ fid: "legacy-fid", fileName: "legacy.apk" }],
      },
    },
  };
  const store = makeStorage({ quarkCleanupRegistryV1: JSON.stringify(legacy) });
  const queued = makeFetchQueue([{ code: 0, data: { task_id: "delete-task" } }]);
  const context = loadMain({
    settings: { cookie: "cookie-value", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
    storage: store.storage,
    logger: { warn() {} },
  });
  const result = await context.sweepCleanup();
  assert.equal(result.cleaned, 1);
  assert.deepEqual(JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks, {});
  assert.equal(store.values.get("quarkCleanupRegistryV1"), JSON.stringify(legacy));
});


test("resolver normalizes the configured Cookie and fails clearly without one", async () => {
  const queued = makeFetchQueue([
    { code: 0, data: { stoken: "stoken-1" } },
    { code: 0, data: { list: [] } },
  ]);
  const context = loadResolver({
    settings: { cookie: "a=1;\nb=2", targetFolderId: "target-1", maxFiles: 200 },
    fetch: queued.fetchImpl,
  });
  await context.resolve({ taskId: "t", url: "https://pan.quark.cn/s/share-1", resolverItem: "" }).catch(() => {});
  assert.equal(queued.calls[0].headers.Cookie, "a=1; b=2");

  const missing = loadResolver({ settings: { cookie: "", targetFolderId: "target-1", maxFiles: 200 }, fetch: queued.fetchImpl });
  await assert.rejects(
    missing.resolve({ taskId: "t", url: "https://pan.quark.cn/s/share-1", resolverItem: "", cookies: "captured-cookie" }),
    /Cookie is required; set it in the plugin settings/,
  );
});

test("cleanup skips active, paused, recent, and deferred tasks and keeps scanning", async () => {
  const oldTime = Date.now() - 360000;
  const taskStates = { queued: 0, active: 1, paused: 2, retrying: 5, failed: 4, "failed-old": 4, deferred: 3 };
  const taskIds = [...Object.keys(taskStates), "missing-recent", "missing-old", "unavailable"];
  const records = Object.fromEntries(taskIds.map((id) => [id, taskRecord([{ fid: id }], {
    createdAt: oldTime,
    updatedAt: ["failed", "missing-recent"].includes(id) ? Date.now() : oldTime,
    nextAttemptAt: id === "deferred" ? Date.now() + 60000 : 0,
  })]));
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify({ tasks: records }) });
  const queued = makeFetchQueue([{ code: 0 }, { code: 0 }]);
  const context = loadMain({
    storage: store.storage,
    fetch: queued.fetchImpl,
    settings: { cookie: "cookie-value" },
    tasks: { async get(taskId) {
      if (taskId.startsWith("missing")) throw new Error("not found");
      if (taskId === "unavailable") throw new Error("daemon is shutting down");
      return { taskId, status: taskStates[taskId] };
    } },
  });
  const outcome = await context.sweepCleanup();
  assert.equal(outcome.cleaned, 2);
  assert.match(outcome.error, /无法确认/);
  assert.deepEqual(queued.calls.map((call) => JSON.parse(call.body).filelist), [["failed-old"], ["missing-old"]]);
  await context.sweepCleanup("paused");
  assert.equal(queued.calls.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks),
    taskIds.filter((id) => !["failed-old", "missing-old"].includes(id)));
});

test("cleanup preserves records added while a delete request is in flight", async () => {
  const store = makeStorage({ quarkCleanupRegistryV2: JSON.stringify({ tasks: {
    done: taskRecord([{ fid: "done-fid" }]),
  } }) });
  const context = loadMain({
    settings: { cookie: "cookie-value" },
    storage: store.storage,
    async fetch() {
      const registry = JSON.parse(store.values.get("quarkCleanupRegistryV2"));
      registry.tasks.new = taskRecord([{ fid: "new-fid" }]);
      registry.tasks.done.files.push({ fid: "another-fid", fileName: "another.zip" });
      await store.storage.set("quarkCleanupRegistryV2", JSON.stringify(registry));
      return { status: 200, body: '{"code":0}' };
    },
  });
  await context.sweepCleanup();
  const remaining = JSON.parse(store.values.get("quarkCleanupRegistryV2")).tasks;
  assert.deepEqual(Object.keys(remaining), ["done", "new"]);
  assert.deepEqual(remaining.done.files, [{ fid: "another-fid", fileName: "another.zip" }]);
});
