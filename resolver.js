(function () {
  "use strict";

  var QUARK_API_BASE = "https://drive.quark.cn/1/clouddrive";
  var QUARK_REFERER = "https://pan.quark.cn";
  var QUARK_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch";
  var SHARE_PAGE_SIZE = 50;
  var MAX_SHARE_PAGES = 20;
  var TASK_POLL_INTERVAL_MS = 250;
  var RESOLVE_DEADLINE_MS = 28000;
  var CLEANUP_STORAGE_KEY = "quarkCleanupRegistryV2";
  var LEGACY_CLEANUP_STORAGE_KEY = "quarkCleanupRegistryV1";
  var CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var CLEANUP_MAX_TASKS = 200;
  var CLEANUP_MAX_BYTES = 60000;
  var CLEANUP_RETRY_BASE_MS = 5 * 60 * 1000;
  var CLEANUP_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

  function decodePart(value) {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch (error) {
      throw new Error("invalid URL encoding");
    }
  }

  function queryValue(rawUrl, key) {
    var queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) return "";
    var queryEnd = rawUrl.indexOf("#", queryStart);
    if (queryEnd < 0) queryEnd = rawUrl.length;
    var query = rawUrl.slice(queryStart + 1, queryEnd).split("&");
    for (var i = 0; i < query.length; i += 1) {
      if (!query[i]) continue;
      var pair = query[i].split("=");
      if (decodePart(pair[0]) === key) return decodePart(pair.slice(1).join("="));
    }
    return "";
  }

  function parseShareUrl(rawUrl) {
    if (typeof rawUrl !== "string") throw new Error("invalid Quark share URL");
    var value = rawUrl.trim();
    var match = /^(?:https?):\/\/pan\.quark\.cn\/s\/([^/?#]+)/i.exec(value);
    if (!match) throw new Error("invalid Quark share URL");
    var parentFid = "0";
    var hashIndex = value.indexOf("#");
    if (hashIndex >= 0) {
      var fragment = value.slice(hashIndex + 1);
      var nestedMatch = /\/list\/share\/([A-Za-z0-9_-]{32})(?:[/?#]|$)/i.exec(fragment);
      var nestedMarker = /\/list\/share\/([^/?#]+)/i.exec(fragment);
      if (nestedMarker && !nestedMatch) throw new Error("invalid directory fid");
      if (nestedMatch) parentFid = nestedMatch[1];
    }
    return {
      pwdId: decodePart(match[1]),
      passcode: queryValue(value, "pwd"),
      parentFid: parentFid,
    };
  }

  function normalizeMaxFiles(value) {
    var limit = value === undefined || value === null || value === "" ? 200 : Number(value);
    if (!isFinite(limit) || Math.floor(limit) !== limit || limit < 1 || limit > 1000) {
      throw new Error("maxFiles must be an integer between 1 and 1000");
    }
    return limit;
  }

  function isDirectFile(entry) {
    return entry && entry.dir !== true && entry.file !== false && typeof entry.fid === "string" && !!entry.fid;
  }

  function safeFileName(value, fallback) {
    var raw = typeof value === "string" ? value : "";
    var name = "";
    for (var i = 0; i < raw.length; i += 1) {
      var ch = raw.charAt(i);
      var code = raw.charCodeAt(i);
      name += ch === "\\" || ch === "/" || code < 32 || code === 127 ? "_" : ch;
    }
    name = name.replace(/\.\./g, "._").trim();
    if (name.length > 180) name = name.slice(0, 180);
    return name || fallback || "download";
  }

  function normalizeCookie(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\r?\n+/g, "; ").replace(/;\s*;/g, ";").replace(/^;\s*|\s*;$/g, "");
  }

  function warn(message) {
    if (typeof flux !== "undefined" && flux.logger && typeof flux.logger.warn === "function") {
      flux.logger.warn(message);
    } else if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(message);
    }
  }

  function hasStorage() {
    return typeof flux !== "undefined" && flux.storage && typeof flux.storage.get === "function" && typeof flux.storage.set === "function";
  }

  function asInteger(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? Math.floor(number) : fallback;
  }

  function normalizeTaskRecord(record, now) {
    if (!record || !Array.isArray(record.files)) return null;
    var createdAt = asInteger(record.createdAt, now);
    if (createdAt > now + 60000 || now - createdAt > CLEANUP_MAX_AGE_MS) return null;
    var files = [];
    for (var i = 0; i < record.files.length; i += 1) {
      var item = record.files[i];
      if (!item || typeof item.fid !== "string" || !item.fid) continue;
      files.push({
        fid: item.fid,
        fileName: typeof item.fileName === "string" ? item.fileName : "",
      });
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
      var record = normalizeTaskRecord(parsed.tasks[ids[i]], now);
      if (record) registry.tasks[String(ids[i])] = record;
    }
    return registry;
  }

  async function readRegistryKey(key, now) {
    if (!hasStorage()) return null;
    try {
      var raw = await flux.storage.get(key);
      if (!raw) return null;
      return normalizeRegistry(JSON.parse(raw), now);
    } catch (error) {
      warn("Quark cleanup storage read failed");
      return null;
    }
  }

  async function readCleanupRegistry() {
    if (!hasStorage()) return { tasks: {} };
    var now = Date.now();
    var current = await readRegistryKey(CLEANUP_STORAGE_KEY, now);
    if (current) return current;
    var legacy = await readRegistryKey(LEGACY_CLEANUP_STORAGE_KEY, now);
    return legacy || { tasks: {} };
  }

  function pruneCleanupRegistry(registry, now) {
    var ids = Object.keys(registry.tasks);
    for (var i = 0; i < ids.length; i += 1) {
      var record = normalizeTaskRecord(registry.tasks[ids[i]], now);
      if (!record) delete registry.tasks[ids[i]];
      else registry.tasks[ids[i]] = record;
    }
    ids = Object.keys(registry.tasks).sort(function (left, right) {
      return Number(registry.tasks[right].createdAt) - Number(registry.tasks[left].createdAt);
    });
    while (ids.length > CLEANUP_MAX_TASKS) delete registry.tasks[ids.pop()];
    while (JSON.stringify(registry).length > CLEANUP_MAX_BYTES && ids.length > 0) delete registry.tasks[ids.pop()];
  }

  async function writeCleanupRegistry(registry) {
    if (!hasStorage()) return;
    pruneCleanupRegistry(registry, Date.now());
    await flux.storage.set(CLEANUP_STORAGE_KEY, JSON.stringify(registry));
  }

  async function rememberCleanupFiles(taskId, files, savedFids) {
    if (!taskId || !Array.isArray(files) || !Array.isArray(savedFids) || files.length !== savedFids.length || !hasStorage()) return;
    try {
      var registry = await readCleanupRegistry();
      var previous = registry.tasks[String(taskId)];
      var mapped = previous ? previous.files.slice() : [];
      for (var i = 0; i < files.length; i += 1) {
        var fid = String(savedFids[i]);
        if (mapped.some(function (item) { return item.fid === fid; })) continue;
        mapped.push({
          fid: fid,
          fileName: String(files[i].file_name || files[i].name || ""),
        });
      }
      var now = Date.now();
      registry.tasks[String(taskId)] = {
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: "",
        files: mapped,
      };
      await writeCleanupRegistry(registry);
    } catch (error) {
      warn("Quark cleanup storage write failed");
    }
  }

  function retryDelay(attempts) {
    var exponent = Math.max(0, Math.min(12, attempts - 1));
    return Math.min(CLEANUP_RETRY_MAX_MS, CLEANUP_RETRY_BASE_MS * Math.pow(2, exponent));
  }

  function markRecordFailure(record, message, now) {
    record.attempts = Math.max(0, asInteger(record.attempts, 0)) + 1;
    record.updatedAt = now;
    record.nextAttemptAt = now + retryDelay(record.attempts);
    record.lastError = String(message || "cleanup failed").slice(0, 300);
  }

  async function markCleanupError(taskId, message) {
    if (typeof taskId !== "string" || !taskId || !hasStorage()) return;
    try {
      var registry = await readCleanupRegistry();
      var record = registry.tasks[String(taskId)];
      if (!record) return;
      markRecordFailure(record, message, Date.now());
      await writeCleanupRegistry(registry);
    } catch (error) {
      warn("Quark cleanup failure state could not be saved");
    }
  }

  function loadCookie() {
    var configured = typeof flux !== "undefined" && flux.settings ? normalizeCookie(flux.settings.cookie) : "";
    if (configured) return configured;
    throw new Error("Quark Cookie is required; set it in the plugin settings");
  }

  async function waitForNextPoll() {
    if (typeof setTimeout === "function") {
      await new Promise(function (resolve) { setTimeout(resolve, TASK_POLL_INTERVAL_MS); });
      return;
    }
    var until = Date.now() + TASK_POLL_INTERVAL_MS;
    while (Date.now() < until) {
      // QuickJS does not always expose a timer API.
    }
  }

  function encodeQuery(query) {
    var parts = [];
    var keys = Object.keys(query || {});
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = query[key];
      if (value === undefined || value === null) continue;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    }
    return parts.join("&");
  }

  function apiError(message) {
    return new Error("Quark API " + message);
  }

  function apiMessage(parsed) {
    if (!parsed || typeof parsed !== "object") return "";
    var value = typeof parsed.message === "string" ? parsed.message : (typeof parsed.msg === "string" ? parsed.msg : "");
    return value.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function createQuarkClient(settings, fetchImpl) {
    settings = settings || {};
    var cookie = normalizeCookie(settings.cookie);
    var transport = fetchImpl;
    if (typeof transport !== "function") {
      if (typeof flux === "undefined" || !flux.fetch) throw new Error("flux.fetch is unavailable");
      transport = function (options) { return flux.fetch(options); };
    }

    async function request(path, method, query, body) {
      var queryString = encodeQuery(query || {});
      var headers = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Referer: QUARK_REFERER,
        "User-Agent": QUARK_USER_AGENT,
      };
      if (cookie) headers.Cookie = cookie;
      var options = {
        url: QUARK_API_BASE + path + (queryString ? "?" + queryString : ""),
        method: method || "GET",
        headers: headers,
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      var response;
      try {
        response = await transport(options);
      } catch (error) {
        throw apiError("request failed");
      }
      if (!response || typeof response.status !== "number") throw apiError("returned an invalid HTTP response");
      if (response.truncated) throw apiError("response was truncated");
      var parsed;
      try {
        parsed = JSON.parse(response.body || "");
      } catch (error) {
        if (response.status < 200 || response.status >= 300) throw apiError("HTTP " + response.status);
        throw apiError("returned invalid JSON");
      }
      if (!parsed || typeof parsed !== "object") throw apiError("returned an invalid response");
      var message = apiMessage(parsed);
      if (parsed.code !== undefined && Number(parsed.code) !== 0) {
        throw apiError("code " + Number(parsed.code) + (message ? ": " + message : ""));
      }
      if (response.status < 200 || response.status >= 300 || (parsed.status !== undefined && Number(parsed.status) >= 400 && parsed.code === undefined)) {
        throw apiError("HTTP " + response.status + (message ? ": " + message : ""));
      }
      return parsed;
    }

    async function getSharePage(pwdId, stoken, parentFid, page) {
      var response = await request("/share/sharepage/detail", "GET", {
        pr: "ucpro",
        fr: "pc",
        pwd_id: pwdId,
        stoken: stoken,
        pdir_fid: parentFid,
        force: "0",
        _page: String(page),
        _size: String(SHARE_PAGE_SIZE),
        _fetch_banner: "0",
        _fetch_share: "0",
        _fetch_total: "1",
        _sort: "file_type:asc,updated_at:desc",
        ver: "2",
        fetch_share_full_path: "0",
      });
      if (!response.data || !Array.isArray(response.data.list)) throw apiError("detail response did not contain a file list");
      var total = response.data.metadata && response.data.metadata._total;
      if (total === undefined && response.data.total !== undefined) total = response.data.total;
      return { list: response.data.list, total: asInteger(total, -1) };
    }

    return {
      async getShareToken(pwdId, passcode) {
        var response = await request("/share/sharepage/token", "POST", { pr: "ucpro", fr: "pc" }, {
          pwd_id: pwdId,
          passcode: passcode || "",
        });
        if (!response.data || typeof response.data.stoken !== "string" || !response.data.stoken) throw apiError("response did not contain stoken");
        return { stoken: response.data.stoken };
      },

      async getShareDetail(pwdId, stoken, parentFid) {
        var page = await getSharePage(pwdId, stoken, parentFid, 1);
        return page.list;
      },

      async listShareFiles(pwdId, stoken, parentFid, limit, selectedFid, deadlineMs) {
        var files = [];
        var seen = new Set();
        for (var pageNumber = 1; pageNumber <= MAX_SHARE_PAGES && files.length < limit; pageNumber += 1) {
          ensureDeadline(deadlineMs);
          var page = await getSharePage(pwdId, stoken, parentFid, pageNumber);
          for (var i = 0; i < page.list.length && files.length < limit; i += 1) {
            var entry = page.list[i];
            if (!isDirectFile(entry)) continue;
            if (selectedFid) {
              if (entry.fid === selectedFid) return [entry];
            } else if (!seen.has(entry.fid)) {
              seen.add(entry.fid);
              files.push(entry);
            }
          }
          if (page.list.length < SHARE_PAGE_SIZE) break;
          if (page.total >= 0 && pageNumber * SHARE_PAGE_SIZE >= page.total) break;
        }
        return files;
      },

      async saveFiles(files, targetFolderId, pwdId, stoken) {
        if (!Array.isArray(files) || files.length === 0) throw apiError("cannot save an empty file list");
        var fids = [];
        var tokens = [];
        for (var i = 0; i < files.length; i += 1) {
          if (!files[i] || typeof files[i].fid !== "string" || !files[i].fid || typeof files[i].share_fid_token !== "string" || !files[i].share_fid_token) throw apiError("detail response contained an invalid file");
          fids.push(files[i].fid);
          tokens.push(files[i].share_fid_token);
        }
        var response = await request("/share/sharepage/save", "POST", {
          pr: "ucpro",
          fr: "pc",
          uc_param_str: "",
          app: "clouddrive",
        }, {
          fid_list: fids,
          fid_token_list: tokens,
          to_pdir_fid: targetFolderId,
          pwd_id: pwdId,
          stoken: stoken,
          pdir_fid: "0",
          scene: "link",
        });
        if (!response.data || typeof response.data.task_id !== "string" || !response.data.task_id) throw apiError("save response did not contain task_id");
        return { taskId: response.data.task_id };
      },

      async waitTask(taskId, deadlineMs) {
        var retryIndex = 0;
        while (Date.now() < deadlineMs) {
          var response = await request("/task", "GET", {
            pr: "ucpro",
            fr: "pc",
            uc_param_str: "",
            task_id: taskId,
            retry_index: String(retryIndex),
          });
          if (!response.data || response.data.status === undefined) throw apiError("task response did not contain status");
          var status = Number(response.data.status);
          if (status === 2) {
            var saved = response.data.save_as && response.data.save_as.save_as_top_fids;
            if (!Array.isArray(saved) || saved.length === 0) throw apiError("task response did not contain saved file IDs");
            return { savedFids: saved.map(function (fid) { return String(fid); }) };
          }
          if (status !== 0 && status !== 1) throw apiError("save task failed");
          retryIndex += 1;
          if (Date.now() < deadlineMs) await waitForNextPoll();
        }
        throw apiError("save task timed out");
      },

      async getDownloadUrls(fids) {
        if (!Array.isArray(fids) || fids.length === 0) throw apiError("cannot get links for an empty file list");
        var response = await request("/file/download", "POST", { pr: "ucpro", fr: "pc", uc_param_str: "" }, { fids: fids });
        if (!Array.isArray(response.data) || response.data.length !== fids.length) throw apiError("download response count did not match saved files");
        return response.data.map(function (item) {
          if (!item || typeof item.download_url !== "string" || !item.download_url) throw apiError("download response did not contain a link");
          return { fid: item.fid ? String(item.fid) : "", url: item.download_url };
        });
      },

      async deleteFiles(fids) {
        if (!Array.isArray(fids) || fids.length === 0) throw apiError("cannot delete an empty file list");
        var response = await request("/file/delete", "POST", { pr: "ucpro", fr: "pc", uc_param_str: "" }, {
          action_type: 2,
          filelist: fids,
          exclude_fids: [],
        });
        if (response.code !== 0 && response.code !== "0") throw apiError("did not confirm deletion");
        return { taskId: response.data && typeof response.data.task_id === "string" ? response.data.task_id : "" };
      },
    };
  }

  function ensureDeadline(deadlineMs) {
    if (Date.now() >= deadlineMs) throw new Error("Quark resolver timed out");
  }

  function selectedResolverItem(value) {
    if (typeof value !== "string" || !value) return "";
    var at = value.indexOf("@");
    return (at >= 0 ? value.slice(0, at) : value).trim();
  }

  async function resolve(ctx) {
    if (!ctx || typeof ctx.url !== "string") throw new Error("invalid resolver context");
    if (typeof flux === "undefined" || !flux.settings) throw new Error("Quark settings are unavailable");
    var deadlineMs = Date.now() + RESOLVE_DEADLINE_MS;
    var settings = flux.settings;
    var selectedFid = selectedResolverItem(ctx.resolverItem);
    var targetFolderId = typeof settings.targetFolderId === "string" ? settings.targetFolderId.trim() : String(settings.targetFolderId || "").trim();
    if (selectedFid && !/^[A-Za-z0-9_-]+$/.test(targetFolderId)) throw new Error("请在插件设置填写有效的夸克目标目录 ID，根目录为 0");
    var maxFiles = normalizeMaxFiles(settings.maxFiles);
    var cookie = loadCookie();
    var share = parseShareUrl(ctx.url);
    ensureDeadline(deadlineMs);
    var client = createQuarkClient({ cookie: cookie });
    var token = await client.getShareToken(share.pwdId, share.passcode);
    ensureDeadline(deadlineMs);
    var files = await client.listShareFiles(share.pwdId, token.stoken, share.parentFid, maxFiles, selectedFid, deadlineMs);
    ensureDeadline(deadlineMs);

    if (!selectedFid) {
      if (files.length === 0) throw new Error("no direct files in the scanned share pages");
      return {
        manifest: {
          name: "夸克分享文件",
          items: files.map(function (file, index) {
            var item = {
              id: String(file.fid),
              name: safeFileName(file.file_name || file.name, "download-" + (index + 1)),
              kind: "file",
            };
            if (typeof file.size === "number" && isFinite(file.size) && file.size >= 0) item.size = Math.floor(file.size);
            return item;
          }),
        },
      };
    }

    var file = files[0];
    if (!file) throw new Error("selected Quark file is no longer available");
    var fileName = safeFileName(file.file_name || file.name, "download");
    var saved = await client.saveFiles([file], targetFolderId, share.pwdId, token.stoken);
    ensureDeadline(deadlineMs);
    var task = await client.waitTask(saved.taskId, deadlineMs);
    if (task.savedFids.length !== 1) throw new Error("Quark API saved file count did not match the selected file");
    var savedFid = task.savedFids[0];
    await rememberCleanupFiles(ctx.taskId, [file], [savedFid]);
    var links = await client.getDownloadUrls([savedFid]);
    var link = null;
    for (var i = 0; i < links.length; i += 1) if (!link || links[i].fid === savedFid) link = links[i];
    if (!link || !link.url) throw new Error("Quark API did not return a download link");
    var result = {
      url: link.url,
      fileName: fileName,
      extraHeaders: {
        Cookie: cookie,
        Referer: QUARK_REFERER,
        "User-Agent": QUARK_USER_AGENT,
      },
      ephemeral: true,
    };
    if (typeof file.size === "number" && isFinite(file.size) && file.size >= 0) result.totalBytes = Math.floor(file.size);
    return result;
  }

  function fileBaseName(filePath) {
    if (typeof filePath !== "string") return "";
    var slash = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
    return filePath.slice(slash + 1);
  }

  async function cleanupTask(taskId, filePath, removeAll) {
    if (typeof taskId !== "string" || !taskId || !hasStorage()) return;
    var registry = await readCleanupRegistry();
    var record = registry.tasks[String(taskId)];
    if (!record || !Array.isArray(record.files) || record.files.length === 0) return;
    var matches;
    if (removeAll) {
      matches = record.files.slice();
    } else {
      var name = fileBaseName(filePath);
      matches = record.files.filter(function (item) { return item && item.fileName === name; });
      if (matches.length === 0 && record.files.length === 1) matches = record.files.slice();
      if (matches.length !== 1) {
        warn("Quark cleanup skipped because the completed filename was not unique");
        return;
      }
    }
    try {
      var cookie = loadCookie();
      var client = createQuarkClient({ cookie: cookie });
      await client.deleteFiles(matches.map(function (item) { return item.fid; }));
      registry = await readCleanupRegistry();
      record = registry.tasks[String(taskId)];
      if (!record) return;
      var deleted = {};
      for (var i = 0; i < matches.length; i += 1) deleted[matches[i].fid] = true;
      record.files = record.files.filter(function (item) { return !deleted[item.fid]; });
      if (record.files.length === 0) {
        delete registry.tasks[String(taskId)];
      } else {
        record.updatedAt = Date.now();
        record.nextAttemptAt = Date.now();
        record.lastError = "";
      }
      await writeCleanupRegistry(registry);
    } catch (error) {
      await markCleanupError(taskId, String(error && error.message ? error.message : error));
      warn("Quark cleanup request failed; cleanup record retained");
    }
  }

  async function onDone(ctx) {
    if (!ctx) return;
    await cleanupTask(ctx.taskId, ctx.filePath, false);
  }

  async function onError(ctx) {
    if (!ctx) return;
    await markCleanupError(ctx.taskId, ctx.message || "download failed");
  }

  async function onCancel(ctx) {
    if (!ctx) return;
    await cleanupTask(ctx.taskId, "", true);
  }

  globalThis.parseShareUrl = parseShareUrl;
  globalThis.normalizeMaxFiles = normalizeMaxFiles;
  globalThis.createQuarkClient = createQuarkClient;
  globalThis.resolve = resolve;
  globalThis.onDone = onDone;
  globalThis.onError = onError;
  globalThis.onCancel = onCancel;
  globalThis.readCleanupRegistry = readCleanupRegistry;
  globalThis.writeCleanupRegistry = writeCleanupRegistry;
}());
