# dsh-ssh-workspace

> 给 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的插件：**让一个会话的 workspace 直接落在远程 SSH 服务器上**。
> 会话里的 `read` / `write` / `edit` / `glob` / `grep` / `bash` 全部走 SFTP / SSH 通道，读写和命令都发生在远端；远程服务器信息保存在 DSH 里，随时可以新建一个「远程会话」。

---

## 目录

- [项目简介](#项目简介)
- [特性](#特性)
- [工作原理](#工作原理)
- [目录结构](#目录结构)
- [构建与加载到 DSH](#构建与加载到-dsh)
- [使用](#使用)
- [远端 workspace 语义](#远端-workspace-语义)
- [配置与数据](#配置与数据)
- [HTTP 接口](#http-接口)
- [测试](#测试)
- [开发须知](#开发须知)
- [隐私与安全](#隐私与安全)
- [已知限制](#已知限制)
- [许可与来源](#许可与来源)

---

## 项目简介

DSH 的会话默认在本机目录里工作（`ctx.fs` / `ctx.shell` 由本地 provider 提供）。本插件提供一套 **SSH/SFTP 版的 provider**，并把它绑定进一个 **Agent preset**：

- 每个保存的远程主机 = 一个 Agent preset `ssh-<别名>`；
- 用该 preset 新建的会话，`fs` 与 `shell` 被解析到远端的 `SshFileSystem` / `SshShellExecutor`；
- 于是 `read`/`write`/`edit`/`glob`/`grep`/`bash` 的每一次调用都落在远端服务器的工作目录里；
- 远程主机列表保存在 DSH 自己的存储里，提供 Agent 工具 + 侧边栏配置面板两种管理方式。

适合的场景：代码/构建环境在远端（堡垒机、容器、构建机），但你想用 DSH 的会话能力直接操作它，而不必在本地同步一份代码。

## 特性

- **会话即远端 workspace**：preset 级隔离，其他会话（本地 workspace）完全不受影响，互不干扰。
- **主机信息保存在 DSH 内**：`$DSH_HOME/ssh-workspace.json`（0600、原子写），不写进 preset 文本，preset 文档里看不到密码。
- **三种认证**：`agent`（走 `SSH_AUTH_SOCK`）、`password`、`key`（私钥文件 + 可选 passphrase）。
- **Web 配置面板**：侧边栏「SSH 远程工作区」里增删改查主机、测试连接、**浏览远端目录**选择 workspace 根目录，一键「连接」。
- **Agent 工具 `ssh_workspace`**：`list` / `save` / `remove` / `test` / `reload`，模型也能直接帮你保存主机。
- **可导入既有主机**：默认读取 `@linxin666/dsh-ssh` 的 `$DSH_HOME/dsh-ssh.json`，一份主机列表两处可用。
- **惰性连接**：插件激活时不拨号，服务器暂时不可达也不会阻塞 DSH 启动；错误在首次使用时报出。
- **零构建**：纯 ESM + 手写客户端 bundle，克隆即可用。

## 工作原理

```
宿主平面 (host plane)                          每个主机一个 preset（独立的 isolate realm）
┌──────────────────────────────┐               ┌──────────────────────────────────────────┐
│ ssh-workspace（cordis 服务） │  register()   │ cordis:group  isolate { fs, shell }      │
│  • HostStore  ~/.dsh/…       │ ────────────▶ │  ├─ dsh-ssh-workspace/session            │
│  • 工具 ssh_workspace        │               │  │     └── SshFileSystem   → ctx.fs      │
│  • HTTP 路由 /api/…          │               │  │         SshShellExecutor → ctx.shell  │
│  • 侧边栏面板（浏览器端）    │               │  ├─ tool-fs / tool-fs-search / tool-bash │
│  • 每主机注册一个 preset     │               │  └─ （standard preset 的其余工具）       │
└──────────────────────────────┘               └──────────────────────────────────────────┘
```

几个关键点：

1. **为什么必须是 preset 级隔离**：DSH 的工具（`tool-fs`、`tool-bash`）在**激活时**静态解析 `ctx.fs` / `ctx.shell`，而 `ToolExecution` 上下文里没有 `ctx`，所以无法按调用或按会话切换 provider。唯一可靠的接缝是「在 preset 的 isolate realm 内挂载自己的 provider + 同名官方工具行」，这样该 preset 的会话自然拿到 SSH provider。
2. **为什么 workspace 是「本地锚点」**：DSH 的 workspace 记录必须是**本地存在的目录**（注册时会 `stat`/`mkdir` 它），远端路径不可能成为会话的 `cwd`。因此每个主机在 `$DSH_HOME/ssh-workspaces/<别名>` 建一个本地锚点目录（内含 `.dsh-ssh-workspace.json` 标记，写明远端 root），并在 DSH 里注册一个标题为 `SSH · <别名> → <root>` 的 workspace。真正的读写仍被 preset 重映射到远端 root。
3. **路径重映射**：DSH 的 fs/bash 工具总是把**本机会话 cwd** 交给 provider，所以 provider 会把「落在锚点目录/本机 cwd 下的绝对路径」重新映射到远端 root，相对路径直接落在远端 root 下；root 之外的绝对路径会被 `FS_SANDBOX_DENIED` 拒绝（可在 preset 行里用 `enforceRoot: false` 放开）。
4. **会话内的自我认知**：preset 会把 persona 的 suffix 改写为「你的 workspace 是远端主机 …，工作目录是 …」，模型从第一轮就知道自己在远端工作。

## 目录结构

```
dsh-ssh-workspace/
├── package.json           # 依赖、exports、dsh.bundle / dsh.client 清单
├── cordis.patch.yml       # 往 profile 里插入宿主平面的 ssh-workspace 行
├── preset-remote.yml      # 生成 ssh-<alias> preset 用的模板（上游 standard preset 的副本）
├── lib/
│   ├── index.js           # 宿主平面：HostStore + ssh_workspace 工具 + HTTP 路由 + preset 注册
│   ├── store.js           # 主机存储（校验、脱敏、原子写、导入 dsh-ssh.json）
│   ├── ssh.js             # ssh2 连接管理（重连、SFTP、exec、错误码映射）
│   ├── session.js         # SshFileSystem / SshShellExecutor（会话内的 provider）
│   ├── preset.js          # 读取模板 → 生成 ssh-<alias> preset
│   ├── routes.js          # HTTP 路由（仅回环）
│   └── client.js          # 浏览器端：侧边栏面板 + 连接按钮（手写模块格式，无构建）
└── test/
    ├── smoke.mjs          # 离线单测（23 项）
    ├── local-e2e.mjs      # 真 SSH 端到端（37 项，内置 in-process SSH 服务器）
    ├── sshd.mjs           # 测试用 SSH/SFTP 服务器实现
    └── standalone-sshd.mjs# 起一个常驻测试服务器，供人工联调
```

## 构建与加载到 DSH

### 前置条件

| 项目 | 要求 |
| --- | --- |
| Node.js | `^22.19.0 || >=24.0.0`（原生 TS type-stripping 与 `node:util` 的 TextDecoder 用法） |
| DSH | `>= 0.1.7-rc.2`（`dsh` 命令可用，Web 端需 profile `web`） |
| 运行依赖 | `ssh2`（连接与 SFTP）、`yaml`（解析 preset 模板），随包安装 |
| 宿主提供 | `@deepseek-ai/cordis`、`dsh-fs`、`dsh-shell`、`dsh-tools`、`schemastery`、`react`（由 DSH 安装提供，声明为可选 peerDependency） |

### 构建

**无需构建**。源码就是运行代码（纯 ESM），浏览器端 `lib/client.js` 是手写的 `window.__ModuleLoader__.load({...})` 模块，由 DSH 直接加载：

```sh
# 可选：只为独立跑测试而安装依赖（在 DSH profile 内运行时依赖由 DSH 提供）
npm install --omit=dev
```

### 加载到 DSH

**方式 A：从源码目录 link 安装（开发/本地使用）**

```sh
dsh plugin --profile web add link:/绝对路径/dsh-ssh-workspace
```

`dsh.bundle.patch` 会把 `dsh-ssh-workspace` 追加到 profile 的 `dsh.profile.bundles`，`cordis.patch.yml` 则插入宿主平面那一行。

**方式 B：复制进 profile**

```sh
cp -R /绝对路径/dsh-ssh-workspace ~/.dsh/profiles/web/node_modules/
```

**方式 C：发布到 registry 后安装**

```sh
# package.json 里的 "private": true 需要先去掉（防止误发布）
dsh plugin --profile web add dsh-ssh-workspace
```

### 让改动生效

DSH 的插件组合发生在 **Host 启动时**；运行中的 Host 不会因为 `dsh plugin add` 自动把新插件 compose 进 loader。因此：

```sh
# 1) 重启 Host（最可靠）
curl -s -X POST http://127.0.0.1:3080/dsh-market/restart -H 'Origin: http://127.0.0.1:3080'

# 2) 或者用市场热插拔强制重新挂载（改写代码内容后仍需重启，模块按 URL 缓存）
curl -s -X POST http://127.0.0.1:3080/dsh-market/toggle \
  -H 'Origin: http://127.0.0.1:3080' -H 'content-type: application/json' \
  -d '{"name":"dsh-ssh-workspace","enabled":false}'
curl -s -X POST http://127.0.0.1:3080/dsh-market/toggle \
  -H 'Origin: http://127.0.0.1:3080' -H 'content-type: application/json' \
  -d '{"name":"dsh-ssh-workspace","enabled":true}'
```

### 验证加载成功

- 浏览器打开 `http://127.0.0.1:3080`，左下/侧边栏出现 **「SSH 远程工作区」**（图标 🖧）；
- `curl http://127.0.0.1:3080/api/dsh-ssh-workspace/hosts` 返回 `{"hosts":[…]}`（仅回环可访问）；
- 启动日志（市场重启 helper 的 `.err.log`）没有该插件的激活错误；
- 「新建会话」的 preset 列表里出现 `SSH · <别名>`。

## 使用

### 1. Web 面板（推荐）

侧边栏 **SSH 远程工作区**：

- **新增服务器**：别名 `alias`、`host`、`port`、`user`、认证方式（agent / password / key）、密码或私钥路径、**工作目录 root**、备注；
- **浏览远端目录**：直接连上服务器列目录，点进去 / 上一级，选好后「用此目录」回填 root —— 不确定远端目录结构时用它；
- **保存** / **编辑** / **删除**；
- **测试连接**：单次尝试、8 秒超时，返回明确成功或失败原因；
- **连接**：在 `ssh-<别名>` preset 上新建一个会话并自动跳转过去（会话的 preset 在创建时固定，无法中途切换，所以「连接」总是新建会话）。

### 2. Agent 工具 `ssh_workspace`

任何会话里都能用（模型也可以直接调用）：

```
list                                            # 列出已保存主机
save alias=box host=10.0.0.5 user=root authKind=key keyPath=~/.ssh/id_ed25519 root=/srv/app
test alias=box                                  # 拨号 + 校验 root 存在
remove alias=box
reload                                          # 重新读取存储（含导入）
```

### 3. 直接选 preset 开会话

不经过面板也行：新建会话时在 preset 选择器里选 **`SSH · <别名>`**，该会话的所有文件与命令操作都在远端。

## 远端 workspace 语义

- **root 约束**：远端路径被限制在该主机的 `root` 内。落在本地会话 cwd / 锚点目录下的绝对路径会被重映射到远端 root（`/Users/me/proj/a.txt` → `<root>/a.txt`），相对路径直接解析到远端 root 下；越界绝对路径报 `FS_SANDBOX_DENIED`（`enforceRoot: false` 可关闭）。
- **shell**：`bash` 通过 SSH exec 通道执行 `cd <workdir> && <命令>`，并注入该次调用的环境变量；`workdir` 由本机 cwd 映射而来，远端不存在时自动回退到 root。
- **文件版本**：写/编辑的乐观并发用 `mode:size:mtime` 作为版本标识，语义与本地 provider 一致：
  - 未先读就覆盖已存在文件：`FS_NOT_OBSERVED`
  - 版本过期 / 文件已消失：`FS_STALE_VERSION`
  - 找不到 `old_string`：`FS_EDIT_NOT_FOUND`；多处匹配未开 `replace_all`：`FS_AMBIGUOUS_EDIT`
  - 二进制或非 UTF-8：`FS_NOT_TEXT`；超过 `maxTextBytes`（默认 32 MiB）：`FS_TOO_LARGE`
- **写入方式**：先写同目录临时文件 `<name>.dsh-<rand>.tmp` 再 `rename`，避免半截文件；父目录会自动逐级创建。
- **连接复用**：一个 preset 一条 SSH 连接，fs 与 shell 共用；遇到传输层错误自动重拨（默认 3 次、指数退避），每次重连都重新读取凭据（改密码即可生效）。

## 配置与数据

### 主机存储 `$DSH_HOME/ssh-workspace.json`

```json
{
  "version": 1,
  "hosts": [
    {
      "alias": "box",
      "host": "10.0.0.5",
      "port": 22,
      "user": "root",
      "root": "/srv/app",
      "auth": { "kind": "key", "keyPath": "~/.ssh/id_ed25519" },
      "description": "构建机",
      "tags": [],
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

- `$DSH_HOME` 默认 `~/.dsh`；文件权限 `0600`，写入为先写临时文件再 `rename`（原子）。
- `alias` 规则：`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`，preset id 为 `ssh-<alias>`。
- `auth.kind`：`agent`（`SSH_AUTH_SOCK`，可用 `agentPath` 覆盖）、`password`（可含 `passphrase` 走 keyboard-interactive）、`key`（`keyPath` + 可选 `passphrase`）。
- 首次加载会**导入** `$DSH_HOME/dsh-ssh.json`（`@linxin666/dsh-ssh` 的存储）里的主机；被导入的记录会补一个 `root`（默认 `/`），可用 `importForeign: false` 关闭。

### 插件行配置（`cordis.patch.yml` / profile 补丁）

```yaml
- insert:
    - id: ssh-workspace
      name: dsh-ssh-workspace
      config:
        store: ~/.dsh/ssh-workspace.json   # 可选，覆盖默认存储路径
        importForeign: true                 # 可选，是否导入 dsh-ssh.json
        presets: true                       # 可选，是否为每个主机注册 preset
```

每个 `ssh-<alias>` preset 的会话行还可以单独配置：

```yaml
config:
  host: box            # 必填：主机别名
  root: /srv/app       # 远端 workspace 根目录，默认 /
  enforceRoot: true    # 是否强制 root 约束
  maxTextBytes: 33554432
```

## HTTP 接口

全部仅接受**回环**请求（`127.0.0.1` / `::1`），非回环返回 403：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dsh-ssh-workspace/hosts` | 主机列表（密码脱敏为 `***`） |
| `POST` | `/api/dsh-ssh-workspace/hosts` | 新增 / 更新主机 |
| `DELETE` | `/api/dsh-ssh-workspace/hosts?alias=<alias>` | 删除主机 |
| `POST` | `/api/dsh-ssh-workspace/test` | `{alias}` → 拨号测试 |
| `POST` | `/api/dsh-ssh-workspace/browse` | `{alias}` 或内联主机字段 + `{path}` → 列远端目录 |
| `POST` | `/api/dsh-ssh-workspace/reload` | 重新读取存储 |
| `POST` | `/api/dsh-ssh-workspace/connect` | `{alias}` → 新建远程会话，返回 `{sessionId, root, anchor, …}` |

## 测试

```sh
node test/smoke.mjs         # 23 项：存储、导入、模板解析、preset 结构（离线）
node test/local-e2e.mjs     # 37 项：真 SSH 端到端（内置 in-process SSH/SFTP 服务器）
node test/standalone-sshd.mjs 2222 /tmp/dsh-ws   # 常驻测试服务器（tester / secret）
```

`test/sshd.mjs` 是自包含的 ssh2 服务器实现（exec + SFTP + 目录读写），测试不需要任何外部主机；`standalone-sshd.mjs` 适合手工联调（在面板里把 host 填 `127.0.0.1:2222`、user `tester`、密码 `secret`）。

## 开发须知

- **服务类不要用 `#private` 字段**。`SshFileSystem` / `SshShellExecutor` 是 cordis 服务，取用时经过 tracker `Proxy`，私有字段会抛 `TypeError: Receiver must be an instance of class …`；用 `_name` 约定即可（`lib/ssh.js` 里的 `SshConnection` 不是服务，因此保留 `#private` 没问题）。
- **改代码必须重启 Host**。宿主模块按 specifier/URL 缓存，热挂载拿不到新代码。
- **浏览器端是手写模块**：`lib/client.js` 用 `window.__ModuleLoader__.load({ id, factory: (require) => … })` 包装，`require('react')` 由宿主模块系统提供；导出 `apply(ctx)` 与 `inject`，用 `ctx.slots.inject('sidebar.panellist', …)` / `ctx.slots.inject('main', …)` 注册 UI。
- **`preset-remote.yml` 是上游 `@deepseek-ai/dsh-web-app` 的 `standard` preset 副本**（用于生成 `ssh-<alias>` 的完整工具链）。升级 DSH 后如官方工具行有变化，需要同步这个文件；`lib/preset.js` 会用自定义 YAML tag 处理 `!!js` 条件（`disabled: !!js process.platform === 'win32'`），并按当前平台裁剪行。
- **preset 注册是 eager 的**：注册时就组合，失败会标记该 preset `broken`。因此插件激活阶段**不拨号 SSH**，一切连接都是惰性的。
- **`dsh.client` 清单必须写 `platform: "web"`**，否则客户端 bundle 不会被组合进 Web 端。
- **依赖解析**：`@deepseek-ai/*` 由 DSH 安装提供（profile 内的 symlink farm），`ssh2` / `yaml` 是本包的 dependencies。独立跑测试时若缺少 `@deepseek-ai/*`，可在包内建一个指向 DSH `node_modules` 的 `node_modules/@deepseek-ai` 软链（该目录已被 `.gitignore` 忽略）。

## 隐私与安全

**本仓库不包含任何私人信息或服务器信息**（逐文件核查过）：

- 源码、测试、`preset-remote.yml`、`package.json`、README 中没有真实主机名/IP、用户名、密码、私钥、token，也没有作者本机的绝对路径；示例一律使用 `10.0.0.5`、`127.0.0.1`、`/srv/app` 这类占位值；
- 测试里的 `tester` / `secret` 只是 in-process 测试服务器在 `127.0.0.1` 上随机端口使用的临时凭据，`test/sshd.mjs` 每次运行都现场生成主机密钥，不落盘、不引用任何外部服务器。

运行期的安全边界：

- 主机凭据只写在 `$DSH_HOME/ssh-workspace.json`（`0600`，原子写），**不会**进入 preset 文档，也不会出现在日志里；
- 工具与 HTTP 返回的主机记录都经过脱敏（密码显示为 `***`，只暴露 `hasPassphrase`）；
- HTTP 路由仅接受回环请求，非回环一律 403；`readJsonBody` 限制请求体大小（1 MiB）；
- 远端路径默认被限制在该主机的 `root` 内（`FS_SANDBOX_DENIED`）。

## 已知限制

- 每个 preset 一条 SSH 连接；不做 pty 多路复用，DSH 的持久终端（persistent shell）能力未接入，`bash` 走 exec 通道。
- `watch()`（文件监听）不被远端 provider 支持；`lstat` 不区分符号链接细节。
- 会话的 preset 在创建时固定，「连接」总是新建会话（DSH 不允许已开始的会话切换 preset）。
- 需要远端存在 `bash`（或 `sh` 兼容 shell）与可用的 SFTP 子系统。

## 许可与来源

- 本包以 **Apache License 2.0** 发布，完整文本见 [`LICENSE`](LICENSE)（未修改的标准 Apache-2.0 全文）。
- 第三方归属见 [`NOTICE`](NOTICE)。要点：`preset-remote.yml` 派生自 DSH 官方包 `@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml`（MIT License，Copyright (c) 2026 DeepSeek）；该文件仅作为生成 `ssh-<alias>` preset 的模板，其 MIT 许可与版权声明依 MIT 条款保留，升级 DSH 时建议重新同步。
- 其余代码为原创实现，仅通过公开的 cordis / DSH 插件接口（`ctx.fs`、`ctx.shell`、`ctx.tools`、`ctx.agentPresets`、`ctx.webServer`、`ctx.workspaceRegistry`、`ctx.slots`）与 DSH 交互。
