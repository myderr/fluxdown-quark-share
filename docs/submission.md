# Quark Share Resolver 提交说明

## 插件信息

- Identity：`myderr@quark-share`
- 版本：`0.2.2`
- 最低应用版本：`0.6.8`
- 权限：`background`、`tasks`、`pageScripts`
- 包内文件：`manifest.json`、`resolver.js`、`main.js`、`page-download.js`

## 功能摘要

`myderr@quark-share` 是 FluxDown 的原生多文件 resolver：

1. 使用插件设置中的 Cookie 访问夸克网盘。
2. 分页读取分享目录的直属文件，通过 `multi: true` 和 `manifest` 交给 FluxDown 展示文件选择器。
3. 用户确认后，第二段解析只转存选中的 fid，校验直链使用 HTTPS 且指向已确认的下载主机，再附带 Cookie 返回直链。
4. 多个选中文件会由 FluxDown 创建任务组，各自独立解析和清理。

插件不递归子文件夹，最多预览 1000 个直属文件。目标目录必须提前创建，根目录填写 `0`。

## 生命周期与清理

插件声明 `onDone`、`onError`、`onCancel`：

- `onDone`：删除当前任务对应的临时转存文件。
- `onCancel`：删除当前任务的全部临时转存文件。
- `onError`：只写入失败次数和退避时间，不立即删除。FluxDown 0.6.7 的失败事件可能在自动重试前触发，立即删除会破坏重试。

`main.js` 以 `background: true` 随 daemon 运行，按设置间隔执行清理。后台和手动清理都先核对 FluxDown 任务状态，跳过活动任务及状态不明的记录。失败记录采用指数退避。活动栏中的“夸克清理”视图可查看记录并手动触发检查。

任务删除、daemon 停止或应用崩溃时没有关闭 hook；这些场景由后台清扫兜底。

## Cookie

插件不实现登录流程。用户在插件设置中粘贴 `pan.quark.cn` 的 Cookie，解析、下载和清理均使用该配置，不读取浏览器任务附带的 Cookie。

## 权限说明

- `background`：让 `main.js` 常驻并按计划清理失败的临时转存。
- `tasks`：只调用 `flux.tasks.get` 判断任务是否可以安全清理，不修改 FluxDown 任务。
- `pageScripts`：只在 `https://pan.quark.cn/s/*` 的顶层分享页显示按钮；用户点击后通过扩展将分享页地址交给 FluxDown，不读取登录态。

插件没有申请 `auth`、`intercept`、`browserRules` 或 `desktop` 权限。

## 验证

```powershell
node --check resolver.js
node --check main.js
node --test tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1
```

测试覆盖：

- manifest 与最低版本；
- 分享 URL 解析；
- 50 项分页；
- 第一段 manifest 不转存；
- 第二段只转存选中 fid；
- `onDone` / `onCancel` 清理；
- `onError` 退避而不误删；
- 清理失败保留记录；
- 只使用设置中的 Cookie，拒绝不受信任的下载直链并保留清理记录；
- 后台清扫跳过活动、暂缓和状态未知的任务；
- 页面按钮的作用范围、URL 传递以及失败后重试。

## 打包与发布

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1
(Get-FileHash .\dist\quark-share-0.2.2.fxplug -Algorithm SHA256).Hash.ToLower()
```

生成 `dist/quark-share-0.2.2.fxplug` 后，在作者仓库发布 `v0.2.2`，只上传这一个 `.fxplug` 附件。首次登记作者仓库时，向官方索引提交只修改 `registry.json` 的 PR；登记完成后，索引会自动读取后续的正式 GitHub Release 并生成版本分片。

发布前必须确认未包含真实 Cookie、下载直链或本地配置。
