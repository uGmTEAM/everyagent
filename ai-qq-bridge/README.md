# ai-qq-bridge

面向 AI 的 QQ 通信桥。参考 NapCatQQ 的**进程内通信方式**，但代码从零实现：

- 运行在 QQ NT（Linux / Electron）主进程里，直接调用 `wrapper.node` 暴露的 Session / Service
- 不自建 QQ 协议、不实现加密和长连接，全部复用 QQ 内核的 MSF 网络层
- 不做原生 Hook，不依赖 QQ 版本函数偏移
- 对 AI 只暴露一个简单的 HTTP API（拉取出队 + 发送），零第三方运行时依赖

```
┌────────────────────────── 单容器 ──────────────────────────┐
│  Xvfb :99                                                  │
│    └─ QQ NT (Electron) ── main 被替换为 bridge-loader.cjs  │
│          └─ ai-qq-bridge (ESM)                             │
│                ├─ wrapper.node ── Session / Kernel Service  │
│                ├─ 事件监听 → 未读队列（按月 JSONL）          │
│                └─ HTTP API :3100 ← AI 容器                  │
└────────────────────────────────────────────────────────────┘
```

## 与 NapCat 的关系

| 项目 | NapCat | 本项目 |
|---|---|---|
| 平台 | Windows / Linux | Linux 容器 |
| 注入方式 | Windows 远程 DLL + IAT Hook；Linux 脚本替换入口 | 直接改 `resources/app/package.json` 的 `main` |
| 原生 Hook | MoeHoo / napi2native 按版本偏移抓包 | **不做** |
| 对外协议 | OneBot 11（默认启用） | 自定义 AI API（默认）；OneBot 11 兼容层默认关闭 |
| 依赖 | pnpm 生态 | 仅 Node 内置模块 |

## 方式一：tar.gz 安装包（Docker 容器内）

在开发机打包：

```powershell
# 只打桥接程序
powershell -ExecutionPolicy Bypass -File scripts\package-tar.ps1

# 把 QQ deb 一起打进包（离线部署推荐）
powershell -ExecutionPolicy Bypass -File scripts\package-tar.ps1 -QqDeb D:\QQ_3.2.34_260924_amd64_01.deb
```

产物：`dist/ai-qq-bridge-0.1.0-linux.tar.gz`（含 SHA256 输出）。

在已有容器里安装：

```bash
docker cp dist/ai-qq-bridge-0.1.0-linux.tar.gz <container>:/tmp/
docker exec -it <container> bash -c "cd /tmp && tar xzf ai-qq-bridge-0.1.0-linux.tar.gz && ./ai-qq-bridge-0.1.0/install.sh --data /data --with-deps"

# 如果容器里没有 QQ：
docker exec -it <container> bash -c "cd /tmp && ./ai-qq-bridge-0.1.0/install.sh --data /data --qq-deb /tmp/qq.deb --with-deps"

# 前台启动（Xvfb + QQ + 桥接服务）
docker exec -it <container> aiqq-run
```

说明：

- 包默认**不含 QQ**（约 47KB）；用 `-QqDeb` 打包会附带 `vendor/qq.deb`
- `--with-deps` 会在容器内用 `apt-get` 安装 Xvfb 和 Electron 运行库；已有这些依赖时去掉
- 不需要在容器里装 Node：安装与运行都使用 QQ 自带 Electron 的 Node 运行时
- 安装脚本会写入默认配置 `/data/config.json`、注入 QQ 入口，并生成 `aiqq-run`、`aiqq-node`、`aiqq-patch`、`aiqq-install-qq`
- 卸载：`./ai-qq-bridge-0.1.0/uninstall.sh`（保留数据），加 `--purge` 删除数据
- 容器重启后需要重新执行 `aiqq-run`；如果容器有自启动机制，把 `aiqq-run` 设为启动命令即可

## 方式二：Docker 镜像

```bash
# 1. 构建（QQ_DEB_URL 可省略：默认读取官方 linuxConfig.js 取最新 deb；生产建议传固定 URL 锁版本）
docker build -t ai-qq-bridge \
  --build-arg QQ_DEB_URL="https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_x.y.z_xxxxxx_amd64_01.deb" \
  .

# 2. 运行（单容器，数据全部落在 ./data）
docker run -d --name ai-qq-bridge \
  -p 3100:3100 \
  -v "$PWD/data:/data" \
  --shm-size=512m \
  ai-qq-bridge
```

或使用 `docker/docker-compose.yml`。

> 构建阶段会尝试安装 QQ。如果所在网络访问 `qqdl.gtimg.cn` 返回 403/超时，镜像仍会构建成功；把 Linux QQ 的 `.deb` 放到 `./data/qq.deb` 后启动容器，入口脚本会自动安装，也可以再次用 `--build-arg QQ_DEB_URL=...` 构建。

首次启动后：

```bash
curl -s http://127.0.0.1:3100/v1/login/qrcode | jq -r .qr_base64 | base64 -d > qrcode.png
# 手机 QQ 扫码，成功后服务端自动删除二维码文件
curl -s http://127.0.0.1:3100/health | jq
```

AI 容器与桥接容器同主机时，把 `127.0.0.1` 换成宿主内网 IP 即可；也可以让 AI 容器加入 compose 网络后直接访问 `http://ai-qq-bridge:3100`，或给 AI 容器加 `--add-host=host.docker.internal:host-gateway`。默认**不鉴权**；需要时设置 `BRIDGE_HTTP_TOKEN` 或配置 `http.token`。

## 配置

配置优先级：`BRIDGE_CONFIG` 指定文件 > `/data/config.json` > 内置默认值 > 环境变量覆盖。

完整示例见 [config.example.json](config.example.json)。关键项：

```json
{
  "http": { "host": "0.0.0.0", "port": 3100, "token": "" },
  "qq": {
    "account": "",
    "autoLogin": true,
    "switchOnKick": true,
    "qrTimeoutSec": 180
  },
  "accounts": [
    { "uin": "10001", "note": "主账号" },
    { "uin": "10002", "note": "备用账号" }
  ],
  "onebot": { "enabled": false, "port": 3000, "token": "" }
}
```

> 使用 `accounts` 多账号时，`qq.account` 与环境变量 `BRIDGE_ACCOUNT` 都要留空，否则会覆盖账号列表当前项，导致切换无效。

## AI API

所有接口返回 JSON。消息体统一结构：

```json
{
  "id": "743...",
  "time": 1761700000,
  "chat_type": "group",
  "conversation": { "id": "123456", "qq": "123456", "name": "测试群" },
  "sender": { "uin": "20000", "uid": "u_xxx", "name": "小明" },
  "self": false,
  "segments": [
    { "type": "text", "text": "你好" },
    { "type": "at", "qq": "20001", "name": "小红" },
    { "type": "image", "file": "a.png", "size": 1234, "width": 100, "height": 80,
      "local_path": "/data/media/2026-10/xxx.png", "media_url": "/v1/media/2026-10/xxx.png" },
    { "type": "file", "name": "报告.pdf", "size": 9000, "attachment_id": "msgId:elementId" },
    { "type": "reply", "id": "上一条的 msgId", "seq": "123" }
  ]
}
```

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 登录状态、队列、版本、能力探测 |
| GET | `/v1/status` | 详细状态 |
| GET | `/v1/login/qrcode` | 获取二维码（base64 / url），扫码后自动清理 |
| POST | `/v1/login/refresh` | 刷新二维码 |
| POST | `/v1/login/quick` | `{ "uin": "10001" }` 快速登录 |
| GET | `/v1/accounts` | 账号列表与当前索引 |
| POST | `/v1/accounts/switch` | `{ "index": 1 }` 或 `{ "uin": "10002" }` |
| GET | `/v1/messages?limit=20&wait=5` | **拉取即出队**，`wait` 为长轮询秒数 |
| POST | `/v1/messages` | 发送消息 |
| GET | `/v1/messages/history?type=group&id=123456&limit=20` | 从 QQ 拉最近历史（不入队） |
| GET | `/v1/groups` | 群列表 |
| GET | `/v1/groups/:gid/members?limit=100&offset=0` | 群成员列表 |
| GET | `/v1/groups/:gid/info` | 群资料 |
| GET | `/v1/friends` | 好友列表 |
| GET | `/v1/friends/:uin/profile` | 好友/用户资料 |
| GET | `/v1/self/profile` | 自己的资料 |
| POST | `/v1/messages/revoke` | 撤回消息 |
| GET | `/v1/social/probe` | 加好友/加群能力探测（实验性） |
| POST | `/v1/friends/add` | 加好友（实验性，需开启 features.experimentalSocial） |
| POST | `/v1/groups/join` | 加群（实验性，需开启 features.experimentalSocial） |
| POST | `/v1/media/fetch` | 按 `message_id + element_id` 下载文件/语音/视频 |
| POST | `/v1/media` | 上传/登记媒体：`base64` / `path` / `url` |
| GET | `/v1/media/<rel>` | 下载已保存媒体 |
| GET | `/v1/logs?tail=200` | 内存日志尾部 |

### 拉取

```bash
curl -s "http://127.0.0.1:3100/v1/messages?limit=20&wait=5"
```

- 游标由服务端维护，`pull` 成功即推进并持久化
- 重启后从游标处恢复，未读不丢
- `wait` 最多 30 秒，无消息时到点返回空数组
- 响应里的 `next_cursor` 可用于核对；`cursor_matched` 表示客户端传入的 `cursor` 是否匹配

### 发送

```bash
curl -s -X POST http://127.0.0.1:3100/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "target": { "type": "group", "id": "123456" },
    "segments": [
      { "type": "reply", "id": "7430000000000000000" },
      { "type": "at", "qq": "20001", "name": "小红" },
      { "type": "text", "text": " 你好" },
      { "type": "image", "path": "/data/uploads/a.png" }
    ]
  }'
```

- `target.type`：`group` / `private`；`private.id` 可填 QQ 号或 `u_` 开头的 UID
- 支持的段：`text`、`at`、`reply`、`image`、`file`、`face`、`forward`（仅转发已有消息）
- 图片/文件支持 `path` 或 `base64`；也可以先 `POST /v1/media` 换取路径
- 私聊发送时自动把 QQ 号转换成 UID

合并转发（转发已有消息）：

```json
{
  "target": { "type": "group", "id": "123456" },
  "segments": [{ "type": "forward", "message_ids": ["743...", "744..."] }]
}
```

### 附件按需下载

图片默认自动下载（`media.autoDownloadImages`）；文件/语音/视频只返回元数据，调用：

```bash
curl -s -X POST http://127.0.0.1:3100/v1/media/fetch \
  -H 'Content-Type: application/json' \
  -d '{
    "message_id": "743...",
    "element_id": "elementId",
    "chat_type": "group",
    "conversation_id": "123456"
  }'
```

## 账号与掉线

- `accounts` 按顺序轮换；被踢下线 / 静默离线 / 主动退出时自动切到下一个账号
- 切换通过退出码 `75` 交给容器入口脚本重启 QQ，登录态仍由 QQ 数据目录保留
- 切换期间无法接收消息；重新登录后按 `queue.lastReceiveAt` 做一次最近消息补拉
- 登录失败或异常退登时 `/v1/messages` 直接返回 `503 not_ready`
- 手动切换：`POST /v1/accounts/switch`

### 群、好友与撤回

```bash
curl -s "http://127.0.0.1:3100/v1/groups/123456/members?limit=50"
curl -s "http://127.0.0.1:3100/v1/groups/123456/info"
curl -s "http://127.0.0.1:3100/v1/friends/20001/profile"
curl -s "http://127.0.0.1:3100/v1/self/profile"

curl -s -X POST http://127.0.0.1:3100/v1/messages/revoke \
  -H 'Content-Type: application/json' \
  -d '{"chat_type":"group","conversation_id":"123456","message_id":"743..."}'
```

群成员来自 `GroupService.getAllMemberList`，按群缓存 5 分钟；返回字段 `uin/uid/name/card/role/join_time`。

### 实验性：加好友 / 加群

内核确实暴露了 `NodeIKernelAddBuddyService.addBuddy` 和 `GroupService.reqToJoinGroup`，但参数结构没有公开文档，NapCat 自己也没有封装对应 Action。因此这两个接口默认关闭，只提供探测和实验入口：

```bash
curl -s http://127.0.0.1:3100/v1/social/probe
# 开启实验能力：配置 features.experimentalSocial=true 或 BRIDGE_EXPERIMENTAL_SOCIAL=1

curl -s -X POST http://127.0.0.1:3100/v1/friends/add \
  -H 'Content-Type: application/json' \
  -d '{"uin":"20001","message":"你好","remark":"AI"}'

curl -s -X POST http://127.0.0.1:3100/v1/groups/join \
  -H 'Content-Type: application/json' \
  -d '{"group_id":"123456","message":"申请理由"}'
```

如果默认参数在你的 QQ 版本上不生效，可以用 `args` 直接透传原生参数：

```json
{ "uin": "20001", "args": ["<uid>", { "msg": "你好" }, {}] }
```

该能力需要真机验证，失败会返回 400，不会影响正常收发消息。

## QQ 版本升级

启动时会读取 `resources/app/package.json` 的版本，并与 [supported-versions.json](src/qq/supported-versions.json) 比对。未验证版本：

1. 日志出现 `当前 QQ 版本 ... 不在已验证列表内`
2. `/health` 的 `capabilities.missing` 会列出缺失的内核方法
3. 按提示备份 `/data`，更新镜像内 QQ 后重启
4. 若 `missing` 非空，按缺失项调整 `src/qq/*.mjs` 中的接口调用；本项目不依赖函数偏移，通常只需适配方法名/参数

QQ 自动更新会替换 `package.json`，入口脚本每次启动都会重新注入，不会失效。

## OneBot 11 兼容层

默认关闭。开启后提供：

- HTTP API：`POST http://host:3000/<action>`，支持 `get_login_info`、`get_status`、`get_version_info`、`get_group_list`、`get_friend_list`、`send_msg`、`send_private_msg`、`send_group_msg`
- 正向 WebSocket：`:3001`
- 反向 WebSocket：`onebot.reverseWebsocket`
- HTTP POST 上报：`onebot.webhook`
- 心跳：30 秒

事件里的 `message_id` 使用 32 位短 ID（原 ID 在 `raw_message_id`），字符串消息不解析 CQ 码。

## SSH 运维

消息 API 只通过 HTTP 暴露；SSH 仅用于运维，不提供消息能力：

```bash
ssh root@host
docker logs -f ai-qq-bridge
docker exec -it ai-qq-bridge aiqq-node /opt/ai-qq-bridge/scripts/doctor.mjs
docker exec -it ai-qq-bridge sh -c 'curl -s 127.0.0.1:3100/health'
docker restart ai-qq-bridge
```

## 目录结构

```
src/
  index.mjs              启动编排
  config.mjs             配置合并
  logger.mjs             日志（文件 + 内存尾部）
  accounts.mjs           多账号索引与切换
  qq/
    wrapper.mjs          QQ 目录探测、wrapper.node 加载、版本/AppID
    session.mjs          engine / login / session 初始化
    login.mjs            扫码、快速登录、掉线状态
    event-bus.mjs        内核调用 + Listener 回调封装
    api.mjs              发送、群/好友、历史、附件下载
    msg-elements.mjs     消息段 → QQ 元素
    msg-parse.mjs        QQ 消息 → 统一结构
    events.mjs           收消息入队、掉线、补拉
  store/
    queue.mjs            按月 JSONL 未读队列与游标
    media.mjs            媒体落盘
  http/
    server.mjs            HTTP 服务
    routes.mjs            AI API 路由
  onebot/                OneBot 11 兼容层（默认关闭）
loader/bridge-loader.cjs QQ 入口替换文件
scripts/                 注入、体检、自检
docker/                  Dockerfile 辅助、入口脚本、compose
```

## 自检与体检

```bash
node scripts/selfcheck.mjs   # 零依赖自检，产物在 test-output/<时间戳>/
node scripts/doctor.mjs      # 检查 QQ 目录、版本、AppID、注入状态
node scripts/patch-qq.mjs --app-dir /opt/QQ/resources/app
node scripts/patch-qq.mjs --restore
```

## 已知限制

- 当前实现未在真实 QQ 账号上做端到端验证；首次部署需要扫码并观察 `/health` 与日志
- 不做原生 Hook，因此没有底层报文、数据库密钥、群表情回应等能力
- 合并转发只支持转发已有 `message_ids`，不支持自定义节点
- 语音/视频仅接收元数据，不支持发送
- 频道消息、戳一戳、群公告暂不支持（`/health.capabilities` 中标记为 false）
- 加好友/加群为实验性接口，内核方法存在但参数未公开，需要真机验证
- 发送图片/文件依赖内核的 RichMedia 缓存路径；不同 QQ 版本若方法签名变化，会在日志中提示并回退原路径
- 群与私聊全部接收，只过滤自己发送的消息；消息量很大时建议在 AI 侧按会话过滤
- 单容器默认免鉴权，请勿把 `3100` 暴露到公网
