(function () {
  "use strict";

  const panelId = "fluxdown-quark-share-download";
  const label = "用 FluxDown 下载";

  function shareUrl() {
    const url = new URL(location.href);
    return url.origin === "https://pan.quark.cn" && /^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? url.href : "";
  }

  if (!shareUrl() || typeof fluxdown === "undefined" || typeof fluxdown.download !== "function" || document.getElementById(panelId)) return;

  const panel = document.createElement("div");
  panel.id = panelId;
  Object.assign(panel.style, {
    position: "fixed",
    right: "max(16px, env(safe-area-inset-right))",
    bottom: "max(20px, env(safe-area-inset-bottom))",
    zIndex: "10000",
  });
  const shadow = panel.attachShadow({ mode: "closed" });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  Object.assign(button.style, {
    minHeight: "44px",
    padding: "0 14px",
    border: "1px solid #164dad",
    borderRadius: "8px",
    backgroundColor: "#1755be",
    color: "#fff",
    font: "600 14px/1.3 system-ui, sans-serif",
    cursor: "pointer",
    boxShadow: "0 2px 8px #0003",
  });

  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.hidden = true;
  Object.assign(status.style, {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    right: "0",
    boxSizing: "border-box",
    width: "max-content",
    maxWidth: "min(240px, calc(100vw - 36px))",
    padding: "8px 10px",
    border: "1px solid #d2d9e4",
    borderRadius: "8px",
    backgroundColor: "#fff",
    color: "#182538",
    textAlign: "left",
    font: "14px/1.4 system-ui, sans-serif",
    boxShadow: "0 2px 8px #0002",
  });

  let clearStatus;

  function announce(text) {
    window.clearTimeout(clearStatus);
    status.hidden = !text;
    status.textContent = text;
  }

  button.addEventListener("click", async function (event) {
    if (!event.isTrusted || button.disabled) return;
    const url = shareUrl();
    if (!url) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    announce("正在发送…");
    try {
      const result = await fluxdown.download({ url });
      if (!result || !result.ok) throw new Error("Download handoff failed");
      announce("已发送至 FluxDown");
      clearStatus = window.setTimeout(function () { announce(""); }, 4000);
    } catch (error) {
      announce("未能发送，请检查 FluxDown 与浏览器扩展的连接后重试。");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });

  shadow.append(button, status);
  document.body.append(panel);
}());
