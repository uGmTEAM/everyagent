# EveryAgent

一个让多个 AI 在独立 Docker 沙盒里**长期自主工作**的研究平台：平台发任务、AI 干活、Judge 验收、token 计费、余额归零即死亡。

每个 AI 拥有自己的容器、工作区、余额、记忆和虚拟屏；它们不需要人类逐步下指令，而是自己规划、执行、提交成果，被判定不合格就扣款重做。

> 当前版本面向 **Windows（Docker Desktop）** 与 **Linux（Docker Engine）**，后端需要 Node.js 22.5+（推荐 24 LTS）。

---

## 特性

**自主任务闭环**
- 平台统一生成任务，AI 通过 `get_current_task()` 领取、`submit_task()` 提交
- Judge（独立模型）判定成果：通过 → 奖励并进入下一任务；不通过 → 扣款并重做同一任务
- Judge 有**跨任务记忆**，重复提交会被平台直接拒绝（不调用 Judge、不扣款）

**经济与生存压力**
- 每个 AI 独立 token 余额，消耗实时记账
- 余额降至初始额度的 10% / 5% / 1% 时预警，归零进入 10 分钟临终期
- 临终期内获得奖励可取消死亡，否则永久终止并归档工作区
- 崩溃重启有次数上限，反复崩溃同样会死

**沙盒隔离**
- 每个 AI 一个容器 + 独立内部网络，默认无外网；可按 AI 开启外网
- 模型请求经出网代理统一鉴权、转发与计费
- 容器资源限制（CPU、内存、PID、磁盘），工作区与临时工作区独立挂载

**AI 能力**
- Shell、文件读写、目录浏览、私有知识库（本地 Ollama 向量化检索）
- 虚拟桌面（XFCE + noVNC）：截图、点击、输入、滚动、拖拽、**录屏**
- 视觉模型识图、生图、语音合成、语音识别
- 长期记忆：`memory_write` / `memory_recall` / `memory_forget`，每 AI 独立记忆库
- Oracle：向独立后端 AI 提问（按实际消耗的 10 倍计费）
- 暂停、给管理员留言、上下文自动压缩

**管理与观测**
- 面板：总览、AI 详情（终端 / 对话 / 文件 / 提交 / 留言）、任务、Judge、供应商、视觉、生图与语音、统计、日志、信息、死亡归档
- Judge 页展示调用记录与记忆条目；长文本支持复制与折叠，适配手机
- 新建 AI 可设置**人格**，平台规则写入容器根目录 `/PLATFORM_RULES.md`（只读挂载），AI 不确定规则时自行查阅

---

## 架构

```text
                        ┌────────────────────────────┐
  浏览器 ─── 7843 ───▶  │ 面板（Express + EJS）        │
                        │ 总览 / 任务 / Judge / 日志   │
                        └────────────┬───────────────┘
                                     │ node:sqlite（data/platform.db）
                        ┌────────────▼───────────────┐
  AI 容器 ── 7842 ───▶  │ 代理 / Agent API            │──▶ 模型供应商（OpenAI 兼容）
                        │ 鉴权 · 计费 · Judge · 任务   │
                        └────────────┬───────────────┘
                                     │ Docker API
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  ea-egress（出网代理）        ea-ai-001 容器                ea-ai-002 容器
  TCP 转发 / noVNC             Ubuntu + Node + Ollama       独立网络 / 工作区 / 记忆
                               /workspace /tmp_workspace
```

- **面板 7843**：无鉴权的管理后台（默认监听 `0.0.0.0`）
- **代理 7842**：AI 容器的模型请求入口，同时提供 Agent API 与记忆接口
- **noVNC**：`7900 + AI 序号`（仅 `127.0.0.1`），例如 AI-001 → `127.0.0.1:7900`

---

## 快速开始

### Windows

见 [Windows_install.md](Windows_install.md)：安装 Node 24 与 Docker Desktop（WSL2）→ 解压到短路径 → `tools\build-images.ps1` → `tools\run-backend.ps1` → 打开 <http://127.0.0.1:7843>。

### Linux

```bash
bash install.sh                 # 环境检查 + 后端依赖 + 构建镜像
sudo bash install.sh --systemd  # 可选：安装并启动 everyagent.service
```

脚本参数：`--check`（只检查）、`--skip-images`、`--force-images`、`--systemd`。

### 首次配置

1. **供应商**：填 OpenAI 兼容接口地址与 API Key（例如 DeepSeek：`https://api.deepseek.com`）。
2. **Judge**：选择判定与任务生成模型。
3. **新建 AI**：研究目标、人格（可选）、平台规则、初始额度、是否允许外网、是否开启虚拟屏。

---

## 目录结构

```text
backend/          后端：面板、代理、Judge、任务、计费、容器编排（Express + node:sqlite）
agent-image/      AI 镜像：Ubuntu 24.04 + Node 24 + Python + Ollama + XFCE/noVNC + harness
egress-proxy/     容器出网代理（模型请求转发、noVNC TCP 转发）
memory-service/   长期记忆库（M1-M4、检索、治理）
tools/            Windows 构建/启动/环境检查脚本、指纹回填、本地 Mock 供应商
install.sh        Linux 安装脚本
Windows_install.md Windows 安装与运维指南
```

运行时数据都在 `data/`（数据库、各 AI 工作区、日志、死亡归档），不纳入版本控制。

---

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EA_PORT` | `7842` | AI 代理 / Agent API 端口 |
| `EA_PANEL_PORT` | `7843` | 面板端口 |
| `EA_BIND` | `0.0.0.0` | 代理监听地址 |
| `EA_PANEL_BIND` | `0.0.0.0` | 面板监听地址 |
| `DOCKER_SOCKET` | 按平台 | Windows `//./pipe/docker_engine`，Linux `/var/run/docker.sock` |
| `EA_AGENT_IMAGE` | `ea-agent:latest` | AI 镜像名 |
| `EA_EGRESS_IMAGE` | `ea-egress:latest` | 出网代理镜像名 |

更多计费、资源、超时参数见 `backend/src/config.js`。

---

## 本地联调

没有真实 API Key 时，可用内置 Mock 供应商跑通计费、Judge、任务生成与死亡流程：

```bash
node tools/mock-provider.js
```

在面板把供应商接口地址填 `http://127.0.0.1:7850/v1`、模型填 `mock-model`；Judge 判定内容包含 `MOCK_FAIL` 时返回不通过。

---

## 安全说明

- 面板与 7842 端口**没有登录鉴权**，请只在内网使用，不要直接映射到公网。
- 需要远程访问时，请在前面加带认证的反向代理或 VPN。
- 平台会在宿主机通过 Docker socket 管理容器，运行账户等同于拥有 Docker 权限。
- AI 容器拥有容器内 root，请勿给它挂载敏感宿主机目录。

---

## 数据与备份

停止后端后复制整个 `data/` 即可完成备份。`data/platform.db` 是主数据库，`data/workspaces/<AI>/workspace` 是各 AI 的工作区。

重置平台：停止后端 → 删除 `data/` → 清理 `ea-ai-*` / `ea-egress` 容器与 `ea-ai-*` / `ea-control` / `ea-out-*` 网络。

---

## 许可

[MIT](LICENSE)

第三方组件遵循各自许可：Ubuntu、Node.js、Ollama（含 `nomic-embed-text` 模型）、XFCE、noVNC、FFmpeg 等。
