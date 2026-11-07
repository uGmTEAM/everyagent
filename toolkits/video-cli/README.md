# video-cli

面向 AI 的 Linux 命令行视频制作工具。**不需要手写 ffmpeg 滤镜**：AI 只写一份 `job.json`，一条命令产出成片；所有命令支持 `--json`，返回结构化结果与错误码。

- 运行形态：容器（推荐）或任意 Linux + Python 3.10+ + ffmpeg
- 依赖策略：`scripts/fetch_deps.sh` 把 ffmpeg 静态二进制、中文字体、yt-dlp 收进 `vendor/`，之后安装与容器构建不再下载大文件
- 所有视频处理由 ffmpeg 完成，字幕/标题由 ASS(libass) 渲染，不依赖 Pillow/ImageMagick

## 能力

| 类别 | 支持 |
| --- | --- |
| 素材 | 图片、视频、纯色、渐变 |
| 动效 | Ken Burns（推近/拉远/左右上下平移）、淡入淡出、滑动、转场 30 种 |
| 文字 | 标题动画（fade / fade_up / slide / typewriter）、任意坐标、字体/字号/描边/透明度 |
| 字幕 | SRT / ASS 烧录、自动折行、位置与样式配置 |
| 音频 | BGM 循环、场景配音、音量(dB)、淡入淡出、闪避 ducking、loudnorm 归一化 |
| 水印 | 图片水印（位置/宽度/透明度/时间段）、文字水印 |
| 规格 | 1080p/720p/4K/竖屏/方屏、任意 `宽x高`、fps、CRF |
| 工具 | probe、抽帧、封面（可带标题）、GIF、yt-dlp 下载、TTS/ASR 接口 |

## 快速开始（Docker）

```bash
cd video-cli

# 方式 A：联网构建（apt 装 ffmpeg + 中文字体）
docker build -t video-cli .

# 国内网络建议加镜像参数（实测可用）
docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t video-cli .

# 方式 B：离线依赖（先在有网机器上执行一次，把 vendor/ 一起拷走）
bash scripts/fetch_deps.sh
docker build -t video-cli .

mkdir -p work && cd work
docker run --rm -v "$PWD:/work" video-cli demo --out demo.mp4 --json
```

`/work` 是工作目录，`job.json`、素材、输出都放这里。容器内命令就是 `video`：

```bash
docker run --rm -v "$PWD:/work" video-cli render job.json --json
docker run --rm -v "$PWD:/work" video-cli doctor --json
```

## 本机安装（Linux）

```bash
bash scripts/fetch_deps.sh        # 可选：准备离线依赖
bash scripts/install.sh           # 装到 ~/.local/bin，字体装到 ~/.local/share/fonts
export PATH="$HOME/.local/bin:$PATH"
video doctor --json
```

## 命令

```bash
video render job.json [--out out.mp4] [--dry-run] [--keep-work] [--json]
video probe media.mp4 [--json]
video fonts [--dir ./fonts] [--json]
video frames media.mp4 --at 1,5.5,00:01:10 --out frames/ [--json]
video cover media.mp4 --at 1 --title "标题" --subtitle "副标题" [--width 1080] [--dim 0.25] [--json]
video gif media.mp4 --start 0 --end 3 --fps 12 --width 480 [--json]
video download URL --out downloads/ --quality 1080 [--audio-only] [--json]
video tts "要念的文字" --out voice.mp3 [--voice zh-CN-x] [--json]
video asr voice.mp3 --out subs.srt [--language zh] [--json]
video demo --out demo.mp4 [--json]
video init ./my-project [--json]
video doctor [--json]
video schema
```

- 退出码：`0` 成功，`1` 失败（带错误码），`2` 参数用法错误
- 所有子命令都支持 `--json` 与 `--verbose`
- `--json` 时 stdout 只有一行 JSON；进度事件以 NDJSON 写到 stderr：`{"event":"progress","phase":"scene[1]/3","percent":42.0,...}`
- 失败结构：`{"ok":false,"error":{"code":"E2001","message":"...","hint":"...","details":...}}`
- `--dry-run` 返回将执行的 ffmpeg 命令与时间轴，便于 AI 预检查

## job.json

最小可用：

```json
{
  "project": "hello",
  "output": "out/hello.mp4",
  "video": {"preset": "1080p", "fps": 30},
  "scenes": [
    {"type": "gradient", "gradient": {"from": "#0F172A", "to": "#1D4ED8"},
     "duration": 4,
     "texts": [{"content": "Hello", "pos": "center", "anim": "fade_up", "size": 96}]}
  ]
}
```

完整规范见 `schema/job.schema.json`（`video schema` 可直接打印），更多示例在 `examples/`。

### 顶层

| 字段 | 说明 |
| --- | --- |
| `project` | 项目名，缺省输出为 `out/<project>.mp4` |
| `output` | 成片路径，相对 job.json 所在目录 |
| `font_dir` | 自定义字体目录（传给 libass） |
| `video` | `preset` / `size` / `fps` / `crf` / `encoder` / `encode_preset` / `audio_bitrate` |
| `audio` | `normalize`、`loudness`、`silent_track`、`bgm` |
| `subtitles` | `src`(SRT) 或 `ass`、`style`、`font_dir` |
| `watermark` | 图片水印：`image`、`position`、`width`、`opacity`、`margin`、`start`、`end` |
| `text_watermark` | 文字水印：`content`、`position`、`size`、`color`、`opacity` |
| `scenes` | 场景数组，至少 1 个 |

`preset` 可选：`1080p` `720p` `480p` `4k` `vertical_1080` `vertical_720` `vertical_480` `square_1080` `square_720`；或用 `size: "1920x1080"`。

`bgm` 可写字符串路径，或对象：

```json
{"src": "assets/bgm.mp3", "volume_db": -16, "fade_in": 1, "fade_out": 2,
 "loop": true, "ducking": true, "duck_threshold": 0.03, "duck_ratio": 8}
```

`ducking` 在有配音时自动压低 BGM（sidechaincompress）。

### 场景

| 字段 | 说明 |
| --- | --- |
| `type` | `image` / `video` / `color` / `gradient` |
| `src` | 图片或视频路径（相对 job.json） |
| `duration` | 成片时长；图片/纯色/渐变必填；视频可截断 |
| `color` / `gradient` | 纯色 `#RRGGBB`；渐变 `{"from":"#000","to":"#333"}` |
| `fit` | `cover`（裁切铺满）/ `contain`（黑边）/ `blur`（模糊背景） |
| `kenburns` | `{"mode":"in|out|left|right|up|down","zoom":1.18}`，仅图片有效 |
| `transition` | 与**上一场景**之间的转场：`{"type":"fade","duration":0.6}` |
| `texts` | 文字数组，时间相对场景起点 |
| `audios` | 场景音频数组（配音），时间相对场景起点 |
| `start_time` | 视频素材起始偏移（秒） |
| `speed` / `reverse` / `rotate` | 变速 / 倒放 / 旋转 0/90/180/270 |

`texts` 元素：

```json
{"content": "标题\n换行", "start": 0, "end": 3, "pos": "center",
 "anim": "fade_up", "size": 88, "color": "#FFFFFF", "font": "Noto Sans CJK SC",
 "outline": 2, "outline_color": "#000000", "opacity": 1, "max_chars": 22}
```

- `pos`：`center` `top` `bottom` `top-left` `top-right` `bottom-left` `bottom-right` `center-left` `center-right`，或 `[x, y]`
- `anim`：`none` `fade` `fade_up` `fade_down` `slide_left` `slide_right` `typewriter`
- 中文换行按显示宽度自动折行；`\n` 强制换行

### 时间轴

- 转场会让后一段提前开始，工具自动计算每段起点与总时长
- 场景 `audios` 的 `start` 会叠加场景起点，与画面自动对齐
- 转场时长超过相邻片段 80% 时自动缩短并告警

## 语音接口协议（可选）

工具不内置模型，只调用 HTTP 服务，方便接 Kokoro、GPT-SoVITS、FunASR、Whisper 等。

TTS：`VCLI_TTS_URL`，POST JSON

```json
{"text": "...", "voice": "default", "speed": 1.0, "format": "mp3"}
```

响应可以是 `audio/*` 二进制，或 `{"audio_base64": "..."}` / `{"url": "..."}`。

ASR：`VCLI_ASR_URL`，POST JSON

```json
{"audio_base64": "...", "language": "auto", "format": "srt", "filename": "voice.mp3"}
```

响应 `{"srt": "..."}` 或 `{"segments": [{"start": 0.5, "end": 2.1, "text": "..."}]}`。

鉴权：`VCLI_TTS_TOKEN` / `VCLI_ASR_TOKEN`（Bearer）。也可用 `--url` / `--token` 按次指定。

## AI 使用建议

1. 先 `video doctor --json`，确认 `ffmpeg`、`libass`、字体可用
2. 用 `video schema` 获取字段全集，生成 `job.json`
3. **先 `video render job.json --dry-run --json`** 检查时间轴与命令，再正式渲染
4. 解析 stdout 的 JSON；stderr 的 `progress/scene_done` 事件可用于展示进度
5. 出错按 `error.code` 分支处理：
   - `E1001` 参数/JSON 错误（看 `details.errors`）
   - `E1002` 素材缺失
   - `E2001` ffmpeg 失败（`--verbose` 看日志）
   - `E3001` 缺依赖 / `E3002` 缺字体
   - `E4001` TTS/ASR/下载失败

## 目录

```
video-cli/
├── bin/video              # 启动器
├── vcli/                  # CLI、job 校验、ASS、渲染、外部接口
├── schema/job.schema.json # job 规范
├── examples/              # 示例 job
├── vendor/                # 离线依赖（fetch_deps.sh 生成）
├── scripts/               # 依赖抓取/安装/冒烟测试
├── Dockerfile
└── README.md
```

## 已知限制

- 场景内的视频音频默认不保留，只使用 `audios` / `bgm`
- 倒放（`reverse`）会把整段读入内存，适合短片
- 未启用硬件编码；容器内统一 libx264，保证可移植
- 视频素材与输出分辨率不一致时按 `fit` 处理；高码率 4K 长片建议拆段渲染
