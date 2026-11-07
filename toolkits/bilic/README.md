# bilibili_client

B 站 Linux 命令行客户端，命令名 `bilic`。登录、下载、投稿、评论、弹幕、合集、直播录制全部在一个二进制里完成。

- 语言：Rust（edition 2024）
- 平台：Linux（x86_64 / aarch64），Windows/macOS 也可从源码编译
- 登录：终端扫码 / SESSDATA + bili_jct / 导入 biliup `cookies.json` / Netscape `cookies.txt`
- 下载：DASH 音视频、1080P/4K/HDR/杜比（受账号权限）、多 P、番剧、字幕、弹幕 XML/ASS、封面
- 投稿：全部字段可配置（命令行或 TOML 模板）、多 P、封面、定时发布、编辑、追加分 P、加入合集小节
- 互动：评论读取/发表/回复/删除/点赞/点踩、一键三连、关注/取关
- 私信：会话列表、历史消息、发送、回复、自动回复（识别并跳过自动/系统消息）
- 弹幕：按视频时间点发送、按墙钟定时发送、颜色/字号/模式、撤回
- 直播：房间信息、FLV/HLS 录制、直播弹幕录制（XML）、直播弹幕发送（实验性）
- 输出：人类可读或 `--json`，便于脚本调用

> 本项目仅供个人学习研究。请遵守 B 站用户协议与版权规定，不要用于批量搬运、刷量或商业用途。

## 安装

### 发行包（推荐）

```bash
tar xzf bilic-0.1.0-linux-x86_64.tar.gz
cd bilic-0.1.0-linux-x86_64
sudo sh install.sh                 # 默认装到 /usr/local
PREFIX=$HOME/.local sh install.sh   # 或者装到用户目录
bilic --version
```

包内含单文件二进制、`README`/`LICENSE`/`THIRD-PARTY`、bash/zsh/fish/powershell 补全脚本和 `install.sh`。校验和见 `dist/sha256sums.txt`。

### 从源码编译（Linux）

```bash
# 依赖：Rust >= 1.85、ffmpeg（下载合流/精确处理需要）、OpenSSL 开发头文件
sudo apt install ffmpeg pkg-config libssl-dev cmake perl
cargo build --release --bin bilic
sudo install -m 755 target/release/bilic /usr/local/bin/bilic
```

静态链接说明：项目默认使用系统 TLS（OpenSSL），产物依赖 glibc 与 libssl3。需要完全静态的二进制时，可自行把 `reqwest` / `tokio-tungstenite` 的 TLS 特性切换为 rustls，并用 `x86_64-unknown-linux-musl` 目标编译。

已附带的 Linux x86_64 构建产物：`dist/bilic-linux-x86_64`（Debian bookworm 环境构建，实测仅需 glibc ≥ 2.34、libssl3，Debian 12 / Ubuntu 22.04 及以上可直接运行）。Dockerfile 的构建阶段同样固定为 `rust:1.95-slim-bookworm`，避免用 trixie 构建后运行时 glibc 不兼容。

### Docker

```bash
docker build -t bilic .
docker run --rm -it -v "$PWD/data:/data" -e HOME=/data bilic login
```

## 登录

```bash
bilic login                    # 终端二维码扫码（默认）
bilic login --sessdata '...' --bili-jct '...' --dede-user-id 123456
bilic login --cookie-file ./cookies.json      # biliup 登录信息或 {SESSDATA,bili_jct}
bilic login --cookie-file ./cookies.txt       # Netscape cookies.txt
bilic login --refresh                          # 用 refresh_token 免扫码续期
bilic whoami
bilic logout
```

登录信息默认保存在 `~/.config/bilibili_client/cookies.json`（权限 0600），与 biliup 的 `cookies.json` 兼容，所有命令启动时自动读取，进程重启/机器重启后依然有效。

保存路径的优先级：`--cookie <path>` > 环境变量 `BILIBILI_CLIENT_COOKIE` > 配置文件里的 `cookie`（相对路径以配置文件所在目录为基准）> 默认路径。Docker 部署时把配置目录挂到卷上即可，例如 `-v bilic-data:/data -e HOME=/data`。

扫码登录会同时保存 B 站返回的 `refresh_token`。SESSDATA 过期后执行 `bilic login --refresh` 即可续期（会自动写回同一文件）；只有 refresh_token 也失效时才需要重新扫码。

## 视频与下载

```bash
bilic video info BV1xx411c7mD
bilic video info 'https://www.bilibili.com/video/BV1xx411c7mD'

# 单 P 1080P，自动下载音视频并用 ffmpeg 合流
bilic video download BV1xx411c7mD -q 1080p

# 全部分 P，4 个并发，同时下封面/字幕/弹幕（含 ASS）
bilic video download BV1xx411c7mD --all-pages --jobs 4 \
  --with-cover --with-subtitle --with-danmaku --danmaku-ass

# 只下音频 / 只下封面
bilic video download BV1xx411c7mD --audio-only
bilic video cover BV1xx411c7mD -o cover.jpg

# 字幕（默认第一条，也可 --lang zh-CN；--raw 保存 JSON）
bilic video subtitle BV1xx411c7mD -p 1 --lang zh-CN

# 弹幕 XML（-p 指定分 P，--all-pages 全部）
bilic video danmaku BV1xx411c7mD -p 1 --ass

# 番剧：单集或整季
bilic video info ep123456
bilic video download ep123456 -q 1080p
bilic video download ss12345 --jobs 2
```

画质：`8k` `4k` `1080p60` `1080p` `720p` `480p` `360p`，或直接给 B 站 qn 数字。
编码：`--codec avc|hevc|av1`。没有对应编码时自动回退。
文件名模板：`--name "{title}/{p} {part}"`，支持 `{title}` `{bvid}` `{aid}` `{p}` `{part}` `{cid}` `{quality}`。
断点续传：下载中的文件保留 `.part`，重新执行同一命令会从断点继续；`--overwrite` 覆盖已有文件。
`--no-merge` 只保留分离的 `.video.m4s` / `.audio.m4s`，适合没有 ffmpeg 的环境。

> 4K/HDR/杜比/8K、部分番剧需要对应账号权限（大会员）。本工具**不实现大会员购买**：
> `bilic vip status` 查询状态，`bilic vip open` 打开官方购买页，支付由你在浏览器完成。

## 评论与互动

```bash
bilic comment list BV1xx411c7mD --sort hot --page 1 --size 20 --replies
bilic comment replies BV1xx411c7mD --rpid 321796935792 --page 1 --size 20
bilic comment send BV1xx411c7mD "写得很清楚"
bilic comment send BV1xx411c7mD "回复内容" --root 123456789
bilic comment delete BV1xx411c7mD --rpid 123456789
bilic comment like   BV1xx411c7mD --rpid 123456789
bilic comment dislike BV1xx411c7mD --rpid 123456789

# 收到的消息（需要登录）：回复我的 / @我的 / 赞我的
bilic comment received
bilic comment received --kind at
bilic comment received --kind like
bilic comment received --cursor 1171720295694360   # 翻下一页，游标取上次输出的 next_cursor

# 一键三连（默认用第一个收藏夹，也可 --folder-id）
bilic interact triple BV1xx411c7mD --coin 2 --folder-id 12345
bilic interact follow 12345678
bilic interact follow 12345678 --undo
```

`comment replies` 读取某条根评论下的楼中楼（分页）；`comment received` 读取「消息中心 → 回复我的」，回复类消息会同时显示对方回复内容、原评论和视频链接，`--json` 时输出 `next_cursor` / `is_end` 便于脚本翻页。

## 投稿

所有投稿字段都可以用命令行参数或 TOML 模板设置，命令行优先。

```bash
bilic upload template init upload.toml

bilic upload new a.mp4 b.mp4 \
  --template upload.toml \
  --title "标题" --tid 171 --tag "标签1,标签2" \
  --cover cover.jpg --desc "简介" --dynamic "粉丝动态" \
  --copyright 2 --source "转载来源" \
  --submit web --limit 3

# 定时发布（Unix 时间戳 / RFC3339 / "YYYY-MM-DD HH:MM:SS"）
bilic upload new a.mp4 --title "定时稿件" --dtime "2026-10-25 20:00:00"

# 投稿成功后加入合集小节
bilic upload new a.mp4 --title "第 1 集" --section-id 123456

# 编辑稿件（只改传入的字段）
bilic upload edit BV1xx411c7mD --title "新标题" --desc "新简介"

# 追加分 P
bilic upload append BV1xx411c7mD c.mp4 d.mp4
```

模板字段见 `bilic upload template init` 生成的文件；未知字段会原样提交给 B 站接口（`--extra '{"字段":"值"}'` 也可追加）。
提交接口：`--submit web|app|bcut`（默认 `web`；`app` / `bcut` 需要 TV 端 access_token，普通扫码登录一般用 `web`）。

上传过程中会在 `~/.cache/bilibili_client/upload-*.json` 记录进度：中断后重新执行同一命令会跳过已上传的分 P；投稿成功后自动删除。若换了文件内容或账号，会生成新的进度文件。

#### 412 风控与线路切换

B 站对上传接口会做 IP 级风控（常见 HTTP 412 / `{"code":601,"message":"上传过快"}` / HTML 风控页）。`bilic upload` 的应对策略：

- **UPOS 分片上传阶段**：默认自动尝试多条线路。首选 `--line` 指定的线路或 AUTO 测速选出的最快线路；触发风控后按指数退避（30s → 60s → 120s）切换下一条候选线路（bldsa / cnbldsa / bda2 / tx / alia 等，共 16 条），最多换 `--line-retry-max`（默认 3）次。`--no-auto-line-retry` 可关掉自动换线路。
- **submit 阶段**（member.bilibili.com 接口）：不走线路切换。如果这里被风控，说明 IP 本身被标记，`--proxy` 换 IP 是唯一解法。
- **错误提示**：触发风控时直接报"上传被 B 站风控拦截"，并根据是否已使用 `--proxy` 给出"换 IP / 等待冷却 / 换账号"的具体建议，不会把原始 HTML 风控页或底层 `reqwest` 错误直接扔给用户。

代理参数 `--proxy http://127.0.0.1:7890` 会贯穿所有 HTTP 客户端：UPOS 分片上传的 `StatelessClient`、登录态里的 `StatefulClient`、API 客户端、submit 接口。没有代理参数时上传全部直连。

### 合集管理

```bash
bilic season list
bilic season sections 123456
bilic season add 123456 --vid BV1xx411c7mD --vid BV1yy411c7mE
bilic season remove 987654321          # 参数是 episode id，不是 aid
bilic season sort 123456 1001 "正片" 987654321 987654322
```

## 弹幕发送

```bash
# 视频 1 分 30 秒处发一条滚动弹幕
bilic danmaku send BV1xx411c7mD "前方高能" --at 00:01:30

# 顶部弹幕，红色，36 号字；--dry-run 只看请求
bilic danmaku send BV1xx411c7mD "名场面" --at 90s \
  --mode top --color '#FF0000' --fontsize 36 --dry-run

# 墙钟定时：到 2026-10-25 20:00 自动发送（进程需保持运行）
bilic danmaku send BV1xx411c7mD "定时弹幕" --at 0 --schedule "2026-10-25 20:00:00"

# 撤回
bilic danmaku recall --dmid 123456789 BV1xx411c7mD -p 1
```

定时发送有两种用法：

- 常驻：`--schedule "..."`，进程等到时间点自动发送；
- cron：用系统 cron 在目标时刻执行不带 `--schedule` 的命令（推荐加 `--json`）。

## 直播

```bash
# 房间信息 + 拉流地址
bilic live info 6

# 录制直播（自动识别 FLV/HLS），同时录弹幕
bilic live record 6 -o ./record --danmaku --duration 2h

# 只录弹幕为 XML
bilic live danmaku 6 --duration 30m

# 在直播间发弹幕（实验性，依赖 B 站旧版 HTTP 接口）
bilic live send 6 "你好"
```

退出：`Ctrl+C`。中途退出时会把 `.part` 收尾为正式文件；FLV 可能缺少末尾索引，播放器一般仍可打开。

## 私信

```bash
# 会话列表 / 未读数
bilic message list
bilic message unread

# 与某人的最近消息
bilic message history 12345678 --count 30

# 直接发送
bilic message send 12345678 "你好"

# 回复最新一条消息：检测到自动消息默认跳过，--force 可强制发送
bilic message reply 12345678 "收到"
bilic message reply 12345678 "收到" --force

# 单次自动回复（支持 {name} {mid} {content} 占位符）
bilic message auto-reply 12345678 --text "你好 {name}，已收到：{content}"

# 常驻监听未读并自动回复（--once 只跑一轮）
bilic message watch --template reply.txt --interval 60
bilic message watch --text "已收到你的消息" --once --dry-run

# 标记已读
bilic message read 12345678
```

自动消息识别规则：

- 系统消息（`sys_msg_type != 0`）或系统会话
- 已知系统账号（`sender_uid == 1`）
- 文本命中关键词：自动回复、机器人、客服、欢迎关注、感谢关注、请勿回复、勿回、auto reply 等
- 自动回复模式额外跳过非文本消息（图片/分享，`msg_type != 1`）；手动 `reply` 不受此限制

`reply` / `auto-reply` / `watch` 默认跳过自动消息并输出跳过原因；`--force` 可强制回复。
`watch` 会把已回复的 `msg_key` 记录在 `~/.cache/bilibili_client/dm-state.json`，避免重复回复。
`--dry-run` 只打印将要发送的内容。

## 配置

默认配置文件：`~/.config/bilibili_client/config.toml`

```toml
# cookie 文件路径（相对路径按配置文件所在目录解析）
# cookie = "cookies.json"

# HTTP 代理
# proxy = "http://127.0.0.1:7890"

# 下载目录与文件名模板
download_dir = "."
filename = "{title}/{p} {part}"

# ffmpeg 路径
ffmpeg = "ffmpeg"

# 投稿默认值
limit = 3
submit = "web"          # web | app | bcut
# line = "auto"         # bldsa / cnbldsa / ... / auto

# 私信自动回复
# dm_auto_reply = "你好 {name}，已收到你的消息：{content}"
# dm_poll_seconds = 60
```

环境变量：`BILIBILI_CLIENT_COOKIE`、`BILIBILI_CLIENT_PROXY`、`RUST_LOG`。

## JSON 输出

所有命令都支持全局 `--json`，输出结构化结果，例如：

```bash
bilic --json video info BV1xx411c7mD | jq '.title, .owner.name'
bilic --json video download BV1xx411c7mD | jq '.files[].output'
```

## 项目结构

```
src/
  cli.rs             命令行定义
  config.rs          配置与路径
  output.rs          JSON / 文本输出
  api/
    client.rs        Cookie、CSRF、统一响应
    wbi.rs           WBI 签名
    account.rs       扫码登录、账号、大会员查询
    video.rs         视频/番剧信息、播放地址、字幕、弹幕
    download.rs      下载命令与 ffmpeg 合流
    file.rs          断点续传下载
    comment.rs       评论
    interact.rs      三连、关注
    upload.rs        投稿、模板、编辑、追加
    season.rs        合集
    danmaku.rs       视频弹幕发送/撤回/定时
    live.rs          直播信息、录制、直播弹幕
    dm.rs            私信：会话、历史、发送、回复、自动回复
vendor/
  biliup/            从 biliup 提取的登录/投稿/线路/合集/直播解析实现（MIT）
  danmaku-factory/   弹幕 XML -> ASS（MIT）
tests/
  smoke_anon.sh      匿名接口冒烟（info/评论/封面/弹幕/发送 dry-run/补全）
  smoke_merge.sh     DASH 下载 + ffmpeg 合流冒烟
```

冒烟脚本在装有 `ffmpeg` 的 Linux（或挂载本目录的容器）中执行。最近一次实测产物留在 `tests/artifacts/`（已 gitignore）：360P 合流 mp4（82.2 s / 8.19 MB，h264 + aac）、封面 jpg、弹幕 xml 与 ass。

## 已知限制

- B 站接口会变动；若某个命令返回 `B站接口错误 -xxx`，请带上 `-vv` 日志反馈。
- 大会员购买、支付、风控验证码不做自动化。
- 直播弹幕发送使用旧版 HTTP 接口，属于实验性能力；失败的常见原因是登录态、房间限制或接口调整。
- 番剧下载依赖账号权限；付费/大会员内容可能仍返回试看片段。
- 投稿暂不支持上传外挂字幕文件；`--open-subtitle` 只打开字幕开关。
- `--submit app|bcut` 依赖 TV 端 access_token，普通网页 Cookie 登录请用默认的 `web`。
- 未实现：动态/专栏/收藏夹批量、粉丝列表等；这些不在当前命令集中。

## 许可

MIT。`vendor/biliup` 与 `vendor/danmaku-factory` 来自 [biliup/biliup](https://github.com/biliup/biliup)，遵循其 MIT / Apache-2.0 许可，详见 `THIRD-PARTY.md`。
