# dsh-app-diagnostics

给 dsh 做的 App 增加三项能力：**服务端主动取证、授权远程调试、权限与审计**。MIT 开源，非 DeepSeek 官方产品。

## 做到什么程度

- App 主动通过 HTTPS 连接服务端；服务端指定设备读取日志/文件、只读查询 SQLite、查看运行状态。
- 常用快照可以注册，但不是只能读预先列好的字段；授权范围内可按路径读文件、按 SQL 查数据库，调试权限允许执行表达式、看变量和打断点。
- 请求离线保留，使用同一 requestId 追踪结果。执行结果不明时返回 unknown，不自动重做可能有副作用的操作。
- 开发 AI 用 MCP 或 CLI 调用。管理员签发设备范围、权限、有效期；普通开发者凭证不能签发权限。
- 调试通信与超时保护放在独立 Worker，主线程停在断点时仍能继续、清理。结束解除本次断点；业务暂停/恢复由 App 可选接入的安全点钩子负责，不捏造通用任务模型。

## 接入与部署

完整命令、配置和协议见 [English README](README.md)。先运行：

```sh
npm ci
npm test
node examples/demo.mjs
npm pack
```

把生成的 tgz 用 `dsh plugin --profile YOUR_PROFILE add /absolute/path/package.tgz` 安装到目标 profile。部署方配置 serverUrl、私有 stateDir、一次性配对码、允许权限和可读取根目录后启用；插件初始禁用，避免无服务器或无授权时启动。这是部署配置，不要求用户每查一次日志点确认；是否由组织授权或用户授权，部署方负责。

服务端既可独立运行，也可将 `dsh-app-diagnostics/server` 挂到官方 `webServer` 上；同一服务器可以继续提供原有更新接口。**本项目不重新实现或冒充官方升级服务。**

## 官方能力与本插件边界

复用官方 Cordis 和 WebServer；读取官方已有 Session 日志，保留原格式，不强制改写业务。官方 Inspector 已挂载时，通过公开 `cordis.getTree()` 获取状态。主动调试使用 Node 标准 Inspector 的独立 Worker 通道。

已验证 Cordis 4.0.5、WebServer 0.2.1-rc.3。官方旧版本需要另测，不能把这些测试当作所有 dsh 版本兼容保证。

## 授权必须说清

权限分别是 inspect、files.read、database.read、debug。文件/数据库读取受部署方配置的 roots 限制；插件自己的凭证与执行记录目录不能通过普通文件读取拿走。

**debug 具有宿主进程的代码执行权限**，能超出文件读取的根目录限制。它不是“纯读权限”。`throwOnSideEffect` 是调试选项，不是沙箱。服务端可见采集内容；不是对服务端管理员也保密的端到端加密。仅回环开发允许显式 HTTP，外部部署必须 HTTPS。

## 验证与未覆盖部分

测试包括真实取证链路、离线补取、权限隔离、撤权、请求去重、服务器重启后的不确定结果、SQLite 写入拒绝/查询超时、真实断点与超时恢复、官方插件挂载/卸载。

实现 Node Host 调试及部署方配置的 CDP 目标适配；App 自己提供现有 Renderer/浏览器端点，插件不会创建浏览器或开放调试端口。Node 断点与真实 Chromium 页面已做独立验证；未把 Chromium 验证冒充打包 Electron 产品验收。没有自动记录所有业务分支，也无法还原没记录的历史。未宣称已经验过打包后的 Electron 安装包或用户真实业务。

采集结果可能含业务敏感信息，请按 [SECURITY.md](SECURITY.md) 管理权限与留存。本项目不包含任何特定业务应用的代码、真实用户数据、内部地址或凭证。
