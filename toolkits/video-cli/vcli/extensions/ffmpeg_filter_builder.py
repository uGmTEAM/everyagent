"""
纯函数式 ffmpeg filter_complex / -vf / -af 命令生成器。

不 import 任何 ffmpeg API，只返回字符串。
避免 render.py 里手拼 filter_complex 时的字符串模板地狱。

核心价值：
- 每个 filter 都是 (输入 label, 参数字典, 输出 label) → filter 字符串
- filter_complex 就是 [  每个 filter 串  ].join(';')
- 可独立测试、可复用、可做 dry-run 预览
"""

from __future__ import annotations

import re
from typing import Iterable, Sequence


# ── 参数序列化 ──────────────────────────────────────────────────

def kv_filter(name: str, params: dict | None = None) -> str:
    """
    生成 ffmpeg filter 串。

    params: {"param1": "val1", "param2": None, "param3": "3.14"}
    - None / "" / False 自动跳过
    - True 只保留 key
    """
    parts = [name]
    if params:
        for k, v in params.items():
            if v is None or v == "":
                continue
            if v is True:
                parts.append(str(k))
                continue
            # 转义 ffmpeg filter 参数值里的特殊字符
            v_esc = _escape_filter_val(str(v))
            parts.append(f"{k}={v_esc}")
    return ":".join(parts)


def chain_filter(filter_strings: Iterable[str]) -> str:
    """
    链式 filter（用在 -vf 或单个链 [label]...[label]）。
    [f"scale=...", f"setsar=1", f"fps=30"] → "scale=...:setsar=1:fps=30"
    但 ffmpeg 链式要用 ',' 分隔！
    """
    return ",".join(s for s in filter_strings if s)


def filter_complex(parts: Sequence[str]) -> str:
    """
    filter_complex 组装：用 ';' 分隔每个 filter 链。

    每个 part 是完整 filter（带 label），例如:
        "[0:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v0]"
        "[1:v]settb=AVTB,...[v1]"
        "[v0][v1]xfade=transition=fade:duration=0.6:offset=0.4[x1]"
    """
    return ";".join(p for p in parts if p)


def _escape_filter_val(val: str) -> str:
    """
    ffmpeg filter_complex 参数值转义。

    必须转义的字符：: , ; = ' " ( ) [ ] # 空格 反斜杠
    """
    escape_set = ("\\", ":", ",", ";", "=", "'", '"', "(", ")",
                  "[", "]", "#", " ")
    for ch in escape_set:
        val = val.replace(ch, f"\\{ch}")
    return val


# ── Video filters ────────────────────────────────────────────────

def f_format(fmt: str = "yuv420p") -> str:
    return kv_filter("format", {"pix_fmts": fmt})


def f_setsar(sar: float | int | str = 1) -> str:
    return kv_filter("setsar", {"sar": sar})


def f_fps(fps: float | int) -> str:
    return kv_filter("fps", {"fps": fps, "round": "near"})


def f_settb() -> str:
    return kv_filter("settb", {"expr": "AVTB"})


def f_setpts_reset() -> str:
    return kv_filter("setpts", {"expr": "PTS-STARTPTS"})


def f_scale(scale_w: int | float, scale_h: int | float,
             flags: str | None = None, flags_accurate: bool = True) -> str:
    """
    scale 滤镜。

    scale_w/scale_h 可以是整数也可以是 ffmpeg 表达式（如 "iw*2","-2"）。
    flags_accurate=True 自动加 flags=lanczos（高品质缩放）。
    """
    params: dict = {"w": scale_w, "h": scale_h}
    if flags:
        params["flags"] = flags
    elif flags_accurate:
        params["flags"] = "lanczos"
    return kv_filter("scale", params)


def f_crop(crop_w: int | float, crop_h: int | float,
           x: int | float, y: int | float,
           keep_aspect: bool = False) -> str:
    params = {"w": crop_w, "h": crop_h, "x": x, "y": y}
    if keep_aspect:
        params["keep_aspect"] = 1
    return kv_filter("crop", params)


def f_overlay(x: int | float | str = 0, y: int | float | str = 0,
              enable: str | None = None) -> str:
    """
    overlay 滤镜。
    x/y 支持整数、百分比、ffmpeg 表达式。
    enable 用于时间段切换：如 "between(t,5,10)" 表示 5-10s 才显示。
    """
    params = {"x": x, "y": y}
    if enable:
        params["enable"] = enable
    return kv_filter("overlay", params)


def f_xfade(transition: str = "fade", duration: float = 0.6,
            offset: float = 0.4,
            expr: str | None = None,
            params: dict | None = None) -> str:
    """
    xfade 转场滤镜。

    transition: fade/wipeleft/wiperight/circlecrop/dissolve/hblur/squeezeh/fadegrays/...
    expr: 自定义过渡曲线（如 "st=min(1, (1/0.6)*t)"）
    params: 额外 ffmpeg xfade 参数（如 "adjust=0.05"）
    """
    p: dict = {
        "transition": transition,
        "duration": duration,
        "offset": offset,
    }
    if expr:
        p["expr"] = expr  # kv_filter 会转义
    if params:
        p.update(params)
    return kv_filter("xfade", p)


def f_fade_black(duration_in: float = 0.5, fade_type: str = "in",
                 color: str = "black") -> str:
    """
    fade 滤镜（fadeblack / fadewhite 等）。
    ffmpeg 原生 fadeblack 有 alpha 通道，通常加 duration。
    """
    p = {"type": fade_type, "duration": duration_in}
    if fade_type == "in":
        p["start"] = 0
    return kv_filter("fade", p)


def f_zoompan(out_w: int, out_h: int, zoom_expr: str = "zoom+0.002",
              duration_per_frame: int = 1,
              sx_expr: str = "iw/2-(iw/zoom/2)",
              sy_expr: str = "ih/2-(ih/zoom/2)") -> str:
    """
    zoompan 滤镜 — Ken Burns 效果。
    """
    return kv_filter("zoompan", {
        "z": zoom_expr,
        "x": sx_expr,
        "y": sy_expr,
        "d": duration_per_frame,
        "s": f"{out_w}x{out_h}",
    })


def f_subtitles(srt_path: str, style: str | None = None) -> str:
    """
    subtitles 滤镜。style 可选 ASS 格式样式字符串。
    """
    p: dict = {"filename": srt_path}
    if style:
        p["force_style"] = style
    return kv_filter("subtitles", p)


# ── Audio filters ────────────────────────────────────────────────

def f_anull() -> str:
    return "anull"


def f_atrim(start: float, end: float | None = None, tail: float | None = None) -> str:
    p: dict = {}
    if tail is not None:
        p["duration"] = tail
    else:
        p["start"] = start
        if end is not None:
            p["end"] = end
    return kv_filter("atrim", p)


def f_asetpts_reset() -> str:
    return kv_filter("asetpts", {"expr": "PTS-STARTPTS"})


def f_aresample(rate: int = 48000) -> str:
    return kv_filter("aresample", {"sample_rate": rate})


def f_aformat(fmt: str = "sample_fmts=fltp:channel_layouts=stereo") -> str:
    """
    aformat 滤镜：控制采样格式/声道布局。
    """
    return f"aformat={fmt}"


def f_volume(volume_db: float = 0.0) -> str:
    """
    volume 滤镜。volume_db=0 表示不变。
    """
    return kv_filter("volume", {"volume": f"{volume_db}dB"})


def f_adelay(delay_ms: float | str = 0) -> str:
    """
    adelay 滤镜：音频延迟。
    delay_ms: 可以是单数字（立体声对称）或 "0|0"。
    """
    return kv_filter("adelay", {"delays": delay_ms})


def f_afade(afade_type: str = "in", start: float = 0, duration: float = 1.0) -> str:
    """
    afade 滤镜：淡入淡出。
    """
    return kv_filter("afade", {
        "t": afade_type,
        "st": start,
        "d": duration,
    })


def f_amix(input_count: int, duration: str = "longest",
           normalize: bool = False, dropout_transition: float | None = None) -> str:
    """
    amix 滤镜：混音。
    视频音频混合核心。
    dropout_transition 防止某轨突然消失时的咔嗒声。
    """
    p: dict = {
        "inputs": input_count,
        "duration": duration,
        "normalize": int(normalize),
    }
    if dropout_transition is not None:
        p["dropout_transition"] = dropout_transition
    return kv_filter("amix", p)


def f_asplit(n: int = 2) -> str:
    return kv_filter("asplit", {"outputs": n})


def f_loudnorm(i: float = -16.0, tp: float = -1.5, lra: float = 11.0) -> str:
    """
    loudnorm 滤镜：EBU R128 响度归一。
    """
    return kv_filter("loudnorm", {
        "I": i,
        "TP": tp,
        "LRA": lra,
    })


def f_sidechaincompress(threshold: float = 0.02, ratio: float = 6.0,
                        attack: int = 20, release: int = 400,
                        makeup: float | None = None) -> str:
    """
    sidechaincompress 滤镜：闪避（bgm ducking 核心）。

    用法:
        - 输入 0 是被压缩者（BGM）
        - 输入 1 是触发器（语音）
    ffmpeg 用 sidechaincompress 时要先 asplit 语音轨
    """
    p: dict = {
        "threshold": threshold,
        "ratio": ratio,
        "attack": attack,
        "release": release,
    }
    if makeup is not None:
        p["makeup"] = makeup
    return kv_filter("sidechaincompress", p)


def f_alimiter(limit: float = 0.95, attack: float = 5.0, release: float = 50.0) -> str:
    """
    alimiter 滤镜：限制器（防止削波）。
    """
    return kv_filter("alimiter", {
        "limit": limit,
        "attack": attack,
        "release": release,
    })


# ── 常见组合模式 ─────────────────────────────────────────────────

def xfade_chain(
    clips: int,
    transition: str = "fade",
    duration: float = 0.6,
    offset_base: float | None = None,
    expr: str | None = None,
    first_label: str = "v0",
) -> tuple[str, list[str]]:
    """
    生成一串 xfade 把 N 个 clip 拼成一个。

    返回 (filter_complex 字符串, 每个 clip 的 setpts+settb 链)

    clip 0 → [v0]  (settb+setpts+format)
    clip 1 → [v1]  (settb+setpts+format)
    clip 2 → [v2]  ...
    然后 [v0][v1]xfade→[x1]
         [x1][v2]xfade→[x2]
         ...
    """
    if clips < 2:
        raise ValueError("至少 2 个 clip 才能 xfade")

    # 每个 clip 前置处理
    clip_filters: list[str] = []
    for i in range(clips):
        clip_filters.append(
            f"[{i}:v]{f_settb()},{f_setpts_reset()},{f_format('yuv420p')}[{first_label}{i}]"
        )

    # xfade 链
    xfade_filters: list[str] = []
    if offset_base is None:
        offset_base = duration  # 简单默认: offset = duration

    prev_label = f"{first_label}0"
    for i in range(1, clips):
        cur_label = f"{first_label}{i}"
        out_label = f"x{i}"
        offset = offset_base * i  # 每个 xfade 在 scene_i-1 起点后 duration*i 秒
        xfade_filters.append(
            f"[{prev_label}][{cur_label}]{f_xfade(transition=transition, duration=duration, offset=offset, expr=expr)}[{out_label}]"
        )
        prev_label = out_label

    all_filters = clip_filters + xfade_filters
    return filter_complex(all_filters), all_filters


def amix_chain(
    track_labels: list[str],
    output_label: str = "amix",
    batch_size: int = 10,
    dropout: float = 2.0,
) -> str:
    """
    分批 amix（>batch_size 轨时分批合并，防止 ffmpeg 崩溃）。

    track_labels = ["voice_a0", "voice_a1", ..., "voice_a14", "bgm"]
    分批: [a0..a9] → [vb0], [a10..a14] → [vb1], [vb0][vb1] → [output_label]
    """
    if not track_labels:
        return ""

    if len(track_labels) <= batch_size:
        inputs_str = "][".join(track_labels)
        return f"[{inputs_str}]{f_amix(len(track_labels), dropout_transition=dropout)}[{output_label}]"

    # 分批
    chunks = [track_labels[i:i + batch_size] for i in range(0, len(track_labels), batch_size)]
    intermediates = [f"vb{i}" for i in range(len(chunks))]

    filters: list[str] = []
    for i, chunk in enumerate(chunks):
        inputs_str = "][".join(chunk)
        filters.append(f"[{inputs_str}]{f_amix(len(chunk), dropout_transition=dropout)}[{intermediates[i]}]")

    # 中间再合并
    inputs_str = "][".join(intermediates)
    filters.append(f"[{inputs_str}]{f_amix(len(intermediates), dropout_transition=dropout)}[{output_label}]")

    return filter_complex(filters)


def ducking_chain(
    voice_label: str = "voice",
    bgm_label: str = "bgm",
    threshold: float = 0.02,
    ratio: float = 6.0,
    attack: int = 20,
    release: int = 400,
    make_voice_copy_label: str = "vsc",
    mixed_label: str = "mix",
) -> str:
    """
    BGM ducking 链：语音出现时自动压 BGM。

    voice → asplit → [voice_keep][vsc]
    bgm + vsc → sidechaincompress → bgmduck
    voice_keep + bgmduck → amix → mix
    """
    parts = [
        f"[{voice_label}]{f_asplit(2)}[{make_voice_copy_label}][voice_keep]",
        f"[{bgm_label}][{make_voice_copy_label}]{f_sidechaincompress(threshold=threshold, ratio=ratio, attack=attack, release=release)}[bgmduck]",
        f"[voice_keep][bgmduck]{f_amix(2, dropout_transition=2.0)}[{mixed_label}]",
    ]
    return filter_complex(parts)
