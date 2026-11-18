(function () {
  "use strict";

  var CLEANUP_STORAGE_KEY = "quarkCleanupRegistryV2";
  var LEGACY_CLEANUP_STORAGE_KEY = "quarkCleanupRegistryV1";
  var API_BASE = "https://drive.quark.cn/1/clouddrive";
  var MAX_TASKS_PER_SWEEP = 5;
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var TASK_SETTLE_MS = 5 * 60 * 1000;
  var openViews = new Set();
  var sweeping = false;

  function normalizeCookie(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\r?\n+/g, "; ").replace(/;\s*;/g, ";").replace(/^;\s*|\s*;$/g, "");
  }

  function warn(message) {
    if (flux.logger && typeof flux.logger.warn === "function") flux.logger.warn(message);
  }

  function asInteger(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? Math.floor(number) : fallback;
  }

  function normalizeRecord(record, now) {
    if (!record || !Array.isArray(record.files)) return null;
    var createdAt = asInteger(record.createdAt, now);
    if (createdAt > now + 60000 || now - createdAt > MAX_AGE_MS) return null;
    var files = [];
    for (var i = 0; i < record.files.length; i += 1) {
      var item = record.files[i];
      if (!item || typeof item.fid !== "string" || !item.fid) continue;
      files.push({ fid: item.fid, fileName: typeof item.fileName === "string" ? item.fileName : "" });
    }
    if (files.length === 0) return null;
    return {
      createdAt: createdAt,
      updatedAt: asInteger(record.updatedAt, createdAt),
      attempts: Math.max(0, asInteger(record.attempts, 0)),
      nextAttemptAt: Math.max(0, asInteger(record.nextAttemptAt, 0)),
      lastError: typeof record.lastError === "string" ? record.lastError.slice(0, 300) : "",
      files: files,
    };
  }

  function normalizeRegistry(parsed, now) {
    var registry = { tasks: {} };
    if (!parsed || typeof parsed !== "object" || !parsed.tasks || typeof parsed.tasks !== "object") return registry;
    var ids = Object.keys(parsed.tasks);
    for (var i = 0; i < ids.length; i += 1) {
      var record = normalizeRecord(parsed.tasks[ids[i]], now);
      if (record) registry.tasks[String(ids[i])] = record;
    }
    return registry;
  }

  async function readRegistryKey(key, now) {
    var raw = await flux.storage.get(key);
    if (!raw) return null;
    try {
      return normalizeRegistry(JSON.parse(raw), now);
    } catch (error) {
      warn("Quark cleanup registry is malformed");
      return null;
    }
  }

  async function readRegistry() {
    var now = Date.now();
    var current = await readRegistryKey(CLEANUP_STORAGE_KEY, now);
    if (current) return current;
    return (await readRegistryKey(LEGACY_CLEANUP_STORAGE_KEY, now)) || { tasks: {} };
  }

  async function writeRegistry(registry) {
    await flux.storage.set(CLEANUP_STORAGE_KEY, JSON.stringify(registry));
  }

  function loadCookie() {
    var cookie = flux.settings ? normalizeCookie(flux.settings.cookie) : "";
    if (cookie) return cookie;
    throw new Error("夸克 Cookie 未配置，请在插件设置中填写");
  }

  async function deleteFiles(fids, cookie) {
    var response;
    try {
      response = await flux.fetch({
        url: API_BASE + "/file/delete?pr=ucpro&fr=pc&uc_param_str=",
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Cookie: cookie,
          Referer: "https://pan.quark.cn",
        },
        body: JSON.stringify({ action_type: 2, filelist: fids, exclude_fids: [] }),
      });
    } catch (error) {
      throw new Error("夸克删除请求失败");
    }
    if (!response || typeof response.status !== "number") throw new Error("夸克删除接口返回了无效 HTTP 响应");
    if (response.status < 200 || response.status >= 300) throw new Error("夸克删除接口 HTTP " + response.status);
    if (response.truncated) throw new Error("夸克删除接口响应不完整");
    var parsed;
    try {
      parsed = JSON.parse(response.body || "");
    } catch (error) {
      throw new Error("夸克删除接口返回了无效 JSON");
    }
    if (!parsed || parsed.code === undefined) throw new Error("夸克删除接口返回无效响应");
    if (parsed.code !== 0 && parsed.code !== "0") throw new Error("夸克删除接口 code " + Number(parsed.code));
  }

  function retryDelay(attempts) {
    var exponent = Math.max(0, Math.min(12, attempts - 1));
    return Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, exponent));
  }

  function markFailure(record, message, now) {
    record.attempts = Math.max(0, asInteger(record.attempts, 0)) + 1;
    record.updatedAt = now;
    record.nextAttemptAt = now + retryDelay(record.attempts);
    record.lastError = String(message || "清理失败").slice(0, 300);
  }

  function refreshViews() {
    for (var state of openViews) {
      refreshView(state).catch(function () { warn("Quark cleanup view refresh failed"); });
    }
  }

  async function refreshView(state) {
    await loadViewState(state);
    if (openViews.has(state)) state.ctx.refresh();
  }

  async function isSafeToClean(taskId, record, now) {
    try {
      var task = await flux.tasks.get(taskId);
      if (!task || task.taskId !== taskId) return false;
      return task.status === 3 || (task.status === 4 && now - record.updatedAt >= TASK_SETTLE_MS);
    } catch (error) {
      if (error && error.message === "not found") return now - record.updatedAt >= TASK_SETTLE_MS;
      throw new Error("无法确认 FluxDown 任务状态，已保留临时文件");
    }
  }

  async function sweepCleanup(taskId) {
    if (sweeping) return { error: "正在清理，请稍后再试" };
    sweeping = true;
    try {
      return await cleanDueRecords(taskId);
    } finally {
      sweeping = false;
    }
  }

  async function cleanDueRecords(taskId) {
    var registry = await readRegistry();
    var now = Date.now();
    var ids = Object.keys(registry.tasks).sort(function (left, right) {
      return Number(registry.tasks[left].createdAt) - Number(registry.tasks[right].createdAt);
    });
    var selected = [];
    for (var i = 0; i < ids.length; i += 1) {
      if (taskId && ids[i] !== taskId) continue;
      var record = registry.tasks[ids[i]];
      if (!record) continue;
      if (record.nextAttemptAt > now) continue;
      selected.push(ids[i]);
    }
    if (selected.length === 0) return { cleaned: 0, failed: 0, remaining: ids.length };
    if (!flux.tasks || typeof flux.tasks.get !== "function") return { error: "未授予任务权限，无法安全清理" };
    var cookie;
    try {
      cookie = loadCookie();
    } catch (error) {
      return { cleaned: 0, failed: 0, remaining: ids.length, error: String(error.message || error) };
    }
    var cleaned = 0;
    var failed = 0;
    var remaining = ids.length;
    var statusError = "";
    for (var j = 0; j < selected.length && cleaned + failed < MAX_TASKS_PER_SWEEP; j += 1) {
      var id = selected[j];
      var current = (await readRegistry()).tasks[id];
      if (!current || current.nextAttemptAt > now) continue;
      try {
        if (!(await isSafeToClean(id, current, now))) continue;
      } catch (error) {
        statusError = error.message;
        continue;
      }
      var deleted = new Set();
      var failure = "";
      try {
        for (var start = 0; start < current.files.length; start += 100) {
          var chunk = current.files.slice(start, start + 100).map(function (item) { return item.fid; });
          await deleteFiles(chunk, cookie);
          chunk.forEach(function (fid) { deleted.add(fid); });
        }
        cleaned += 1;
      } catch (error) {
        failure = error.message || "清理失败";
        failed += 1;
      }
      var latest = await readRegistry();
      var latestRecord = latest.tasks[id];
      if (latestRecord) {
        latestRecord.files = latestRecord.files.filter(function (item) { return !deleted.has(item.fid); });
        if (latestRecord.files.length === 0) delete latest.tasks[id];
        else if (failure) markFailure(latestRecord, failure, Date.now());
        await writeRegistry(latest);
      }
      remaining = Object.keys(latest.tasks).length;
    }
    if (cleaned || failed) refreshViews();
    return { cleaned: cleaned, failed: failed, remaining: remaining, error: statusError };
  }

  async function loadViewState(state) {
    var registry = await readRegistry();
    var ids = Object.keys(registry.tasks).sort(function (left, right) {
      return Number(registry.tasks[left].createdAt) - Number(registry.tasks[right].createdAt);
    });
    var rows = [];
    var fileCount = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var record = registry.tasks[ids[i]];
      fileCount += record.files.length;
      rows.push({
        key: ids[i],
        task: ids[i].length > 12 ? ids[i].slice(0, 8) + "..." : ids[i],
        files: record.files.map(function (item) { return item.fileName || item.fid; }).join(", "),
        created: record.createdAt,
        attempts: record.attempts,
        error: record.lastError || "—",
      });
    }
    state.rows = rows;
    state.fileCount = fileCount;
  }

  if (flux.events && typeof flux.events.on === "function") {
    flux.events.on("onDone", refreshViews);
    flux.events.on("onError", refreshViews);
    flux.events.on("onCancel", refreshViews);
  }

  if (flux.timers && typeof flux.timers.setInterval === "function") {
    var hours = Number(flux.settings && flux.settings.cleanupIntervalHours);
    if (!isFinite(hours) || hours < 1) hours = 6;
    flux.timers.setTimeout(function () { sweepCleanup().catch(function () { warn("Quark cleanup sweep failed"); }); }, 60000);
    flux.timers.setInterval(function () { sweepCleanup().catch(function () { warn("Quark cleanup sweep failed"); }); }, hours * 60 * 60 * 1000);
  }

  if (flux.ui && typeof flux.ui.view === "function") {
    flux.ui.view("cleanup", {
      async init(ctx) {
        var state = { ctx: ctx, rows: [], fileCount: 0, error: "" };
        await loadViewState(state);
        openViews.add(state);
        return state;
      },

      render(state) {
        var h = flux.ui.h;
        return h("stack", { gap: "md", padding: "md" },
          h("heading", { text: "夸克临时转存清理" }),
          h("text", { text: state.rows.length + " 个任务 · " + state.fileCount + " 个临时文件" }),
          h("stack", { key: "actions", direction: "row", gap: "sm", align: "center" },
            h("button", { key: "cleanup", text: "立即清理到期记录", variant: "primary" }),
            h("button", { key: "refresh", text: "刷新", variant: "outline" })),
          state.error ? h("callout", { tone: "danger", title: "清理失败", text: state.error }) : null,
          h("table", {
            key: "records",
            columns: [
              { key: "task", title: "任务" },
              { key: "files", title: "文件" },
              { key: "created", title: "创建时间", kind: "time" },
              { key: "attempts", title: "尝试次数" },
              { key: "error", title: "最近错误" },
            ],
            rows: state.rows,
            rowActions: [{ id: "cleanup", label: "尝试清理", tone: "danger" }],
            emptyText: "没有待清理的临时转存文件",
          }));
      },

      async event(state, ev) {
        var cleanAll = ev.type === "press" && ev.node === "root/actions/cleanup";
        var cleanOne = ev.type === "rowAction" && ev.node === "root/records" && ev.action === "cleanup" && typeof ev.key === "string" && !!ev.key;
        if (cleanAll || cleanOne) {
          var result = await sweepCleanup(cleanOne ? ev.key : undefined);
          state.error = result.error || "";
          if (result.failed > 0) flux.ui.toast("warning", "已清理 " + result.cleaned + " 个任务，" + result.failed + " 个失败");
          else if (result.cleaned > 0) flux.ui.toast("success", "已清理 " + result.cleaned + " 个任务");
          else if (!result.error) flux.ui.toast("info", "没有可清理的到期记录");
        } else if (ev.type !== "press" || ev.node !== "root/actions/refresh") {
          return;
        } else {
          state.error = "";
        }
        await loadViewState(state);
      },

      dispose(state) {
        openViews.delete(state);
      },
    });
  }

  globalThis.sweepCleanup = sweepCleanup;
  globalThis.readQuarkCleanupRegistry = readRegistry;
}());
