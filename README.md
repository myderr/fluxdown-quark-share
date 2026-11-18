# Quark Share Resolver

一个面向 **FluxDown 0.6.8+** 的夸克网盘分享解析插件。插件会分页读取分享目录，在新版下载窗口中展示可选文件；用户确认后才转存选中的文件，并返回临时下载直链。任务结束或取消后会清理夸克网盘中的临时副本。

## 安装与配置

在 FluxDown 的“设置 → 扩展 → 插件”中安装 `.fxplug`，然后在插件设置中：

1. 粘贴 `pan.quark.cn` 登录后的完整 Cookie（可在浏览器开发者工具的网络请求中复制）。
2. 填写目标目录 `fid`；根目录为 `0`。仅预览时可以留空，开始下载前必须填写。插件不会自动创建目录。

插件不提供登录界面。解析、转存和清理都使用设置中的 Cookie，不使用浏览器任务附带的 Cookie，避免不同账号之间无法清理。Cookie 过期后请从同一账号重新获取；切换账号前请先处理旧账号的临时转存。

Cookie 等同于登录会话凭据，请勿提交到 Git、截图或分享给他人。

## 从夸克网页发送下载

1. 在 FluxDown 中允许插件的 `pageScripts` 权限并启用插件。
2. 在 FluxDown 浏览器扩展的设置中，打开「页面脚本」，启用 `Quark Share Resolver`。按扩展提示开启浏览器的用户脚本权限。
3. 刷新 `https://pan.quark.cn/s/…` 分享页，点击右下角的「用 FluxDown 下载」。要弹出文件选择，请关闭 FluxDown 的免打扰下载。

按钮只发送当前分享页地址，保留地址中的 `pwd` 提取码和子目录定位，不替换夸克原生下载按钮，也不读取网页 Cookie。页面脚本授权范围仅为夸克分享页；不启用它也可以照常在 FluxDown 里粘贴分享链接。

## 配置项

- **夸克网盘 Cookie**：必填，用于解析、转存和清理。
- **目标目录 ID**：转存时必填，用于接收临时转存文件的夸克目录 `fid`。
- **最多列出文件数**：默认 200，范围 1–1000。只列出分享链接当前目录的直属文件，不递归子文件夹。
- **后台清理间隔**：默认 6 小时，范围 1–168 小时。

## 多文件选择

插件声明了 FluxDown 的 `multi: true` resolver：

1. 第一段解析只读取分享目录，返回 `manifest` 文件清单。
2. FluxDown 在新建下载窗口中展示文件选择器，用户可以多选。
3. 每个被选中的文件进入第二段解析，只转存并解析该文件对应的 fid。
4. 多个文件会作为任务组创建，避免先把未选择的文件也转存一遍。

目录列表按每页 50 项、最多 20 页扫描。文件夹和重复条目不占预览名额。

## 清理策略

- `onDone`：按当前任务和完成文件名删除对应的临时转存文件。
- `onCancel`：用户关闭插件或变体选择窗口时，删除当前任务的临时转存文件。
- `onError`：**不立即删除**。新版 FluxDown 的 `onError` 可能在自动重试前触发，立即删除会让重试失败；插件只记录失败时间和退避时间。
- 后台清理：`main.js` 随 daemon 常驻，按配置间隔检查到期记录。仅清理已完成任务，或已失败 / 已删除且记录至少静置 5 分钟的任务；等待中、下载中、暂停中或状态无法确认的任务一律保留。清理失败后采用指数退避。
- 清理页面：活动栏中的“夸克清理”可查看残留记录、最近错误，并手动尝试清理到期记录。手动清理也遵守任务状态和退避限制。

插件申请 `background` 以定时清理，并使用 `tasks` 中的 `get` 查询任务状态；不通过该权限创建、暂停、恢复或删除 FluxDown 任务。升级时 FluxDown 可能需要重新授权。

任务被删除、daemon 停止或应用崩溃时仍然没有可用的关闭事件；这些情况由下一次后台清扫或手动清理兜底。删除操作只会把文件移入夸克回收站，不会清空回收站。

## 错误与限制

- 单次解析的宿主超时设为 30 秒；插件内部预算为 28 秒。
- 插件不扫描目标目录，也不自动去重；同名冲突仍由夸克服务端处理。
- 清理记录保存在 `quarkCleanupRegistryV2`，旧版 `quarkCleanupRegistryV1` 会在读取时迁移。
- 清理失败会保留记录并展示最近错误。超过 30 天的记录会被修剪，最多保留 200 个任务且总大小不超过约 60 KB。

## 开发与测试

```powershell
node --check resolver.js
node --check main.js
node --test tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1
```

测试使用模拟接口响应，不包含真实 Cookie、凭据或下载链接。

## 打包

- 插件 ID：`myderr@quark-share`
- 当前版本：`0.2.1`
- 最低 FluxDown 版本：`0.6.8`（支持市场要求的双语设置字段）
- 输出：`dist/quark-share-0.2.1.fxplug`
- 包内文件：`manifest.json`、`resolver.js`、`main.js`、`page-download.js`

在插件作者仓库的正式 GitHub Release 上传唯一的 `.fxplug` 附件。作者仓库登记后，新版本由官方索引自动校验和收录，无需手动修改索引分片。

## 参考资料

- [FluxDown 插件 API](https://fluxdown.com/docs/zh/plugins/api-reference/)
- [FluxDown 事件钩子](https://fluxdown.com/docs/zh/plugins/hooks-guide/)
- [OpenList 夸克驱动文档](https://doc.oplist.org/guide/drivers/quark)（仅用于获取 Cookie 和目录 `fid`）
