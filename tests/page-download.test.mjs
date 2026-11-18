import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const script = manifest.contributes.pageScripts[0];
const source = new vm.Script(readFileSync(new URL(`../${script.js[0]}`, import.meta.url), "utf8"));
const rootUrl = "https://pan.quark.cn/s/share-1";

function element() {
  return {
    children: [],
    style: {},
    attributes: new Map(),
    listeners: new Map(),
    append(...children) { this.children.push(...children); },
    attachShadow(options) { this.shadow = element(); this.shadow.mode = options.mode; return this.shadow; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

function loadPage({ href = rootUrl, download } = {}) {
  const body = element();
  const location = { href };
  const document = { body, createElement: element, getElementById: (id) => body.children.find((item) => item.id === id) };
  const context = vm.createContext({ document, location, URL, window: { setTimeout() {}, clearTimeout() {} } });
  if (download) context.fluxdown = { download };
  const run = () => source.runInContext(context);
  run();
  return { body, location, run, controls: body.children[0]?.shadow.children };
}

test("registers one isolated top-level Quark share page script", () => {
  assert.equal(manifest.contributes.pageScripts.length, 1);
  assert.deepEqual(script.matches, ["https://pan.quark.cn/s/*"]);
  assert.equal(script.world, "isolated");
  assert.equal(script.allFrames, false);
  assert.ok(manifest.permissions.includes("pageScripts"));
});

test("mounts once and does not render on other pages or without the bridge", () => {
  const download = () => assert.fail("must not send without a click");
  const page = loadPage({ download });
  page.run();
  assert.equal(page.body.children.length, 1);
  assert.equal(page.controls[0].textContent, "用 FluxDown 下载");
  assert.equal(loadPage().body.children.length, 0);
  assert.equal(loadPage({ href: "https://pan.quark.cn/list", download }).body.children.length, 0);
  assert.equal(loadPage({ href: "https://pan.quark.cn.example/s/share-1", download }).body.children.length, 0);
});

test("a trusted click only sends the current share URL and ignores concurrent clicks", async () => {
  const requests = [];
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const page = loadPage({ download(request) { requests.push({ ...request }); return pending; } });
  const [button, status] = page.controls;
  const click = button.listeners.get("click");
  await click({ isTrusted: false });
  assert.deepEqual(requests, []);

  const nested = `${rootUrl}?pwd=abcd#/list/share/1234567890abcdef1234567890abcdef`;
  page.location.href = nested;
  const first = click({ isTrusted: true });
  assert.equal(button.disabled, true);
  await click({ isTrusted: true });
  assert.deepEqual(requests, [{ url: nested }]);
  complete({ ok: true });
  await first;
  assert.equal(status.textContent, "已发送至 FluxDown");
  assert.equal(button.disabled, false);

  page.location.href = "https://pan.quark.cn/list";
  await click({ isTrusted: true });
  assert.deepEqual(requests, [{ url: nested }]);
});

test("a failed bridge reply or rejection does not disclose its message and allows retry", async () => {
  const responses = [{ ok: false, message: "private response" }, new Error("private error"), { ok: true }];
  const { controls: [button, status] } = loadPage({ async download() {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  const click = button.listeners.get("click");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await click({ isTrusted: true });
    assert.match(status.textContent, /未能发送/);
    assert.doesNotMatch(status.textContent, /private/);
    assert.equal(button.disabled, false);
  }
  await click({ isTrusted: true });
  assert.equal(status.textContent, "已发送至 FluxDown");
});
