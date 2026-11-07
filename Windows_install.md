# EveryAgent Windows 安装指南

EveryAgent 是一个在 Docker 沙盒里自主运行多个 AI 研究体的平台：后端负责调度、计费、Judge 判定与隔离，每个 AI 跑在独立容器里，拥有私有工作区、可选虚拟屏与受控外网。

本指南只覆盖 **Windows 10/11 + Docker Desktop**。Linux 服务器安装请用发行包根目录的 `install.sh`。

---

## 1. 系统要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| 操作系统 | Windows 10 22H2 / Windows 11（x64） | Windows 11 |
| CPU | 4 核 | 8 核以上 |
| 内存 | 8 GB | 16 GB 以上 |
| 磁盘 | 30 GB 空闲 | 60 GB 以上（镜像约 4 GB，每个 AI 工作区另计） |
| 虚拟化 | 开启 BIOS 虚拟化 + WSL2 | 同左 |

每个 AI 容器默认 1 核 CPU、1 GB 内存；创建时可单独调大，开启虚拟屏（含陪伴模式）会自动保证至少 2 GB。同时运行的 AI 越多，内存需求越高。

> ARM64 Windows 也可运行，但 `ea-agent` 镜像按 linux/amd64 构建，模拟运行会很慢，不建议发行。

---

## 2. 安装依赖

> `install.ps1` 会自动安装缺失的 Node.js / WSL2 / Docker Desktop：优先用 winget，失败时回退官方安装包；需要管理员权限，会弹出 UAC 并在新窗口继续。本节的手动步骤供提前准备或自动安装失败时使用。

### 2.1 Node.js 24 LTS

后端使用 Node 内置的 `node:sqlite`，**必须 Node.js 22.5 以上，推荐 24 LTS**。

任选一种方式：

```powershell
winget install OpenJS.NodeJS.LTS
```

或从 <https://nodejs.org/> 下载 Windows 安装包（勾选 Add to PATH）。

安装后新开一个 PowerShell 验证：

```powershell
node -v
npm -v
```

应显示 `v24.x`。不要使用 WSL 里的 Node 运行后端。

### 2.2 Docker Desktop

1. 若未启用 WSL2，先以管理员身份执行：

   ```powershell
   wsl --install
   ```

   完成后重启电脑。
2. 安装 Docker Desktop：<https://www.docker.com/products/docker-desktop/>
3. 首次启动后在 **Settings** 中确认：
   - General → **Use the WSL 2 based engine** 已勾选；
   - Resources → 内存至少 8 GB、CPU 至少 4 核；
   - Advanced → **Disk image location** 选剩余空间大的盘。
4. 保持 Docker Desktop 处于运行状态，然后在 PowerShell 验证：

   ```powershell
   docker info --format "{{.OSType}}"
   ```

   必须输出 `linux`。若报错，说明 Docker Desktop 未启动或 WSL2 异常。

> 不要开启「Expose daemon on tcp://localhost:2375」，后端通过 Docker Desktop 的本地命名管道 `//./pipe/docker_engine` 访问 Docker，无需 TCP。

---

## 3. 解压发行包

建议解压到**短路径、无空格、无中文、非 OneDrive 同步目录**，例如：

```text
G:\everyagent
```

目录结构（发行包应包含）：

```text
everyagent/
├─ backend/           后端、面板、Judge、容器编排
├─ agent-image/       AI 运行镜像（含 agent harness、ollama、虚拟屏组件）
├─ egress-proxy/      容器出网白名单代理
├─ memory-service/    记忆库（后端直接引用）
├─ toolkits/          官方工具（bilic、mail-cli、video-cli，自动挂载到 AI 容器）
├─ tools/             构建、启动、环境检查脚本
├─ install.sh         Linux 安装脚本
└─ Windows_install.md 本文档
```

`agent-image/ollama-bin/ollama`（约 39 MB）是构建 AI 镜像必需的本地二进制，发行包必须包含。

---

## 4. 安装与启动

打开 PowerShell，进入解压目录：

```powershell
cd G:\everyagent
```

### 4.1 一键安装（推荐）

双击发行包根目录的 `install.bat`：会自动请求管理员权限（UAC），然后在管理员窗口中调用 `install.ps1` 完成安装。也可以在 PowerShell 中直接执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

脚本依次完成：

1. 环境检查：安装目录、Node.js、npm、WSL2、Docker（Linux 容器）、磁盘、内存、端口；缺失的 Node.js / WSL2 / Docker Desktop 会自动安装（需要管理员权限，会弹出 UAC 并在新窗口继续）；
2. 安装后端依赖（`backend/node_modules`）；
3. 构建 `ea-egress:latest` 与 `ea-agent:latest`（已存在则跳过）；
4. 准备 `data\` 目录；
5. 创建开机自启快捷方式：登录 Windows 后在后台启动平台服务，不自动打开浏览器。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Check` | 只做环境检查，不做任何改动 |
| `-NoAutoInstall` | 不自动安装系统依赖，只检查并提示 |
| `-SkipDocker` | 跳过 Docker 检查与镜像构建（Windows Sandbox 或无 Docker 环境下验证面板） |
| `-SkipImages` | 跳过镜像构建（镜像已准备好时） |
| `-ForceImages` | 强制重建两个镜像 |
| `-NoAutostart` | 不创建开机自启快捷方式 |
| `-OpenPanelOnStartup` | 登录后同时打开面板 |

> **Windows Sandbox**：沙盒不支持嵌套虚拟化，WSL2 与 Docker Desktop 无法运行。在沙盒内请用 `install.bat -SkipDocker` 只验证安装流程与管理面板；AI 容器必须在宿主机（或支持嵌套虚拟化的虚拟机）中运行。

安装完成后可立即启动（也可以双击 `start-everyagent.bat`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-everyagent.ps1
```

### 4.2 环境检查（可选，手工安装时使用）

```powershell
powershell -ExecutionPolicy Bypass -File tools\verify-env.ps1
```

会打印 Node、Docker、WSL、磁盘、端口（7842/7843）和已有镜像状态，不做任何改动。

### 4.3 手工安装

不使用一键脚本时，按下面步骤操作。

安装后端依赖：

```powershell
cd backend
npm install
cd ..
```

（`tools\run-backend.ps1` 也会在缺少 `node_modules` 时自动安装。）

构建 Docker 镜像（首次必做）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-images.ps1
```

- 构建 `ea-egress:latest` 与 `ea-agent:latest`，合计约 4 GB；
- 首次需要联网下载 apt 包、Node、ollama 模型，耗时较长；网络不稳时直接重跑即可（Docker 会复用缓存）；
- 可用 `docker images` 确认两个镜像已出现。

### 4.4 启动后端

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-backend.ps1
```

- 面板：<http://127.0.0.1:7843>
- AI 代理：`http://127.0.0.1:7842`（供容器出网代理回连，不要关闭）
- **这个 PowerShell 窗口需要保持打开**；关闭窗口会停止平台。

也可以改用快捷启动脚本（后台隐藏运行，不占用窗口）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-everyagent.ps1
```

脚本会检查 Docker（必要时拉起 Docker Desktop 并等待就绪）、隐藏启动后端，面板就绪后自动打开浏览器。运行日志在 `data\logs\launcher.log`、`backend.out.log`、`backend.err.log`。已在运行时再次执行只会直接打开面板，不会重复启动。

启动后终端应看到：

```text
[panel] http://0.0.0.0:7843
[proxy] http://0.0.0.0:7842
[docker] 出网代理已就绪
```

---

## 5. 首次配置

打开面板后按顺序完成：

1. **供应商**：填写 OpenAI 兼容接口地址与 API Key，例如 DeepSeek：
   - 接口地址：`https://api.deepseek.com`
   - 模型：`deepseek-reasoner`、`deepseek-chat`
   - 若使用其他兼容服务（OpenAI、Moonshot、自建网关），填对应的 `base_url` 与模型名。
2. **Judge**：选择判定模型和任务生成模型（可复用上面的供应商）。
3. **新建 AI**：
   - 研究目标（必填）
   - 人格（可选，写入系统提示，创建后不可修改）
   - 平台规则 / 补充规则（写入容器根目录的 `/PLATFORM_RULES.md`）
   - 初始额度、是否允许外网、是否开启虚拟屏、视觉模型等。
4. 创建后平台会自动拉起容器，AI 通过出网代理访问模型接口开始工作。

> 新建的 AI 会读取 `/PLATFORM_RULES.md`（只读挂载）；老版本创建的 AI 仍使用内联规则，互不影响。

---

## 6. 端口与网络

| 端口 | 用途 | 监听 |
| --- | --- | --- |
| 7843 | 管理面板 | 0.0.0.0 |
| 7842 | AI 代理 / Agent API | 0.0.0.0 |
| 7900 + 序号 | 虚拟屏 noVNC（如 AI-001 → 7900） | 127.0.0.1 |

- 首次启动时若 Windows 防火墙弹窗，勾选**专用网络**允许访问，否则宿主机可能无法回连容器。
- 局域网访问面板：`http://<本机IP>:7843`（注意安全提示）。
- **面板与 7842 端口没有鉴权**，不要做公网端口映射；确需远程访问时请加带认证的反向代理或 VPN。

默认端口可用环境变量覆盖（启动前设置）：

```powershell
$env:EA_PANEL_PORT = "8843"
$env:EA_PORT = "8842"
```

---

## 7. 日常运维

### 停止

在运行后端的 PowerShell 窗口按 `Ctrl+C`，等待出现「正在关闭...」再关闭窗口。优雅退出会写入 `data/runtime.json` 的 `clean=true`。

若直接结束进程或强制关机，下次启动会走恢复流程，可能给容器内 AI 补偿 token，属于异常路径，尽量避免。

### 数据与备份

| 路径 | 内容 |
| --- | --- |
| `data/platform.db` | 主数据库（AI、任务、提交、请求、记忆、事件） |
| `data/workspaces/<AI>/workspace` | 每个 AI 的私有工作区（容器内 `/workspace`） |
| `data/tmp_workspace` | 临时工作区 / 公共语料（容器内 `/tmp_workspace`） |
| `data/logs` | 服务端日志 |
| `data/death_agents` | 死亡 AI 的归档 zip |

备份时停止后端，复制整个 `data/` 目录即可。

### 重置平台

停止后端，删除或改名 `data/` 与 Docker 中 `ea-ai-*`、`ea-egress` 容器与 `ea-ai-*`、`ea-control`、`ea-out-*` 网络，然后重新启动。

### 卸载

停止后端 → 删除 `data/` → 删除镜像与容器（`docker rm -f ea-egress`、`docker network prune`）→ 删除安装目录 → 卸载 Node.js 与 Docker Desktop（如不再需要）。

---

## 8. 常见问题

**启动报「出网代理镜像 ea-egress:latest 不存在」**
先运行 `powershell -ExecutionPolicy Bypass -File tools\build-images.ps1`。

**无法连接 Docker（dockerode 报错）**
Docker Desktop 未启动、WSL2 未就绪，或 Docker context 指向了远程主机。执行：

```powershell
docker context ls
docker info
```

必要时切回 `desktop-linux`：`docker context use desktop-linux`。

**端口 7842 / 7843 被占用**

```powershell
Get-NetTCPConnection -LocalPort 7842,7843 -ErrorAction SilentlyContinue
```

结束占用进程，或通过 `EA_PORT` / `EA_PANEL_PORT` 换端口（换 7842 时需同时更新出网代理，建议直接停掉旧实例）。

**镜像构建失败**
多为网络问题（Node 下载、apt、ollama 模型）。检查 Docker Desktop 剩余空间后重跑；也可给 Docker 配置镜像加速。

**AI 连不上模型接口**
确认 `ea-egress` 容器在运行、后端 7842 可访问；AI 只有在创建时勾选「允许外网」才能出网；模型接口地址必须是容器可经出网代理转发的地址。

**虚拟屏看不到画面 / 截图空白**
创建 AI 时需开启虚拟屏；镜像内已强制软件渲染（`LIBGL_ALWAYS_SOFTWARE=1` 等），若仍空白，先访问 `127.0.0.1:7900+序号` 确认 noVNC 正常，再查看容器内 `/var/log/browser.log`。

**内存不足、Docker Desktop 卡死**
减少同时运行的 AI 数量，或在 Docker Desktop Resources 中提高内存；每个 AI 默认 1 GB，开启虚拟屏的 AI 至少 2 GB，可创建时单独调大。

**中文路径或空格导致异常**
请把发行包移动到 `G:\everyagent` 这类纯英文短路径后重新安装（Docker 挂载路径对特殊字符敏感）。

---

## 9. 快捷启动与开机自启

### 9.1 一键加入 Windows 启动栏

运行 `install.ps1` 时会自动完成本步骤；下面的命令用于手工安装、移动目录后重建，或首次补建。

安装完成并至少成功启动过一次后，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1
```

会在 Windows「启动」文件夹创建 `EveryAgent.lnk`：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EveryAgent.lnk
```

- 登录 Windows 后自动运行 `tools\start-everyagent.ps1`，后台隐藏启动平台；
- 默认不自动打开浏览器；如需登录后同时打开面板，加参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -OpenPanelOnStartup
```

### 9.2 管理自启

```powershell
# 重新执行会覆盖旧快捷方式，安装目录移动后也用它更新路径
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1

# 移除自启
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove
```

也可以打开「任务管理器 → 启动应用」临时禁用 `EveryAgent`，无需删除快捷方式。

### 9.3 注意事项

- Docker Desktop 必须先于平台就绪；`start-everyagent.ps1` 会自动尝试拉起 Docker Desktop 并最多等待约 90 秒。Docker 启动较慢时，平台仍会启动，但 AI 容器可能暂时不可用。
- 隐藏运行后没有控制台窗口可按 `Ctrl+C`。需要停止时，可在任务管理器结束占用 7843 端口的 `node.exe`；日常调试建议仍用 `tools\run-backend.ps1` 前台启动。
- 快捷启动日志：`data\logs\launcher.log`；后端输出：`data\logs\backend.out.log`、`backend.err.log`。
- 安装目录移动后必须重新执行安装脚本，否则快捷方式里的脚本路径会失效。

---

## 10. 维护者：打包清单

发行包建议包含：

```text
backend/ agent-image/ egress-proxy/ memory-service/ toolkits/ tools/
install.sh install.ps1 Windows_install.md
```

**不要包含**：`data/`、`credentials.md`、`.screenshots/`、`test-output/`、各级 `bakup/` 目录、`backend/node_modules/`、`*.zip`、`bilibili_client/`、`video-cli/`（后两者是独立产品，按需另发）。

注意保留 `agent-image/ollama-bin/ollama`，否则 `ea-agent` 构建会失败。

推荐用 7-Zip 打包（`Compress-Archive` 不支持排除子目录，容易把 `backend/src/bakup` 等备份和 node_modules 带进发行包）：

```powershell
7z a -tzip everyagent-1.0.0.zip backend agent-image egress-proxy memory-service tools install.sh install.ps1 Windows_install.md `
  -xr!node_modules -xr!bakup -xr!data -xr!test-output -xr!.screenshots -xr!*.zip
```

没有 7-Zip 时，先用 robocopy 复制到干净目录再压缩（robocopy 退出码 1 表示复制成功）：

```powershell
$dist = "$env:TEMP\everyagent-dist"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
foreach ($dir in "backend","agent-image","egress-proxy","memory-service","tools") {
  robocopy $dir "$dist\$dir" /E /XD node_modules bakup data .screenshots | Out-Null
}
Copy-Item install.sh,install.ps1,Windows_install.md $dist
Compress-Archive -Path "$dist\*" -DestinationPath everyagent-1.0.0.zip
```

发行前自查（用 7-Zip 时）：

```powershell
7z l everyagent-1.0.0.zip | Select-String "bakup|node_modules|credentials|platform.db"
```

应没有输出。用 Compress-Archive 时可直接检查 `$env:TEMP\everyagent-dist` 目录里是否残留上述内容。

分发前建议在一台干净 Windows 上按本文档完整走一遍：安装依赖 → 构建镜像 → 启动 → 配置供应商 → 新建 AI 并完成一次提交。
