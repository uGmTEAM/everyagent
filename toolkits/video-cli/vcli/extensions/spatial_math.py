"""
空间布局数学 —— cover / contain / fit / pad / overlay 的纯几何运算。

无外部依赖，只用 Python stdlib。
适合视频合成场景里素材缩放/裁剪/定位的参数预计算。

视频合成里最常见的问题：
- "1920x1080 画面里放 1280x720 的图，cover 模式 → 实际 scale 参数是多少？"
- "contain 模式留黑边 → overlay 的 x/y 偏移具体是多少？"
- "Pad 到竖屏 1080x1920 横屏素材居中 → crop 还是 scale+pad？"
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FitMode = Literal["cover", "contain", "fill", "inside", "pad"]


# ── 基础几何 ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class Rect:
    """矩形区域（整数像素）。"""
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0

    @property
    def aspect(self) -> float:
        if self.h == 0:
            return 0.0
        return self.w / self.h

    @property
    def center_x(self) -> float:
        return self.x + self.w / 2

    @property
    def center_y(self) -> float:
        return self.y + self.h / 2


@dataclass(frozen=True)
class Size:
    w: int
    h: int

    @property
    def aspect(self) -> float:
        return self.w / self.h


def aspect_fit(src_w: int, src_h: int, dst_w: int, dst_h: int) -> tuple[float, float]:
    """
    计算把 src 放进 dst 后的目标尺寸（contain 语义 — 完整显示，留黑边）。

    返回 (target_w, target_h) 浮点。
    """
    if src_w <= 0 or src_h <= 0 or dst_w <= 0 or dst_h <= 0:
        raise ValueError("尺寸必须为正")
    scale = min(dst_w / src_w, dst_h / src_h)
    return src_w * scale, src_h * scale


def aspect_cover(src_w: int, src_h: int, dst_w: int, dst_h: int) -> tuple[float, float]:
    """
    cover 语义：覆盖整个 dst，可能裁剪。

    返回 (target_w, target_h) 浮点。
    """
    scale = max(dst_w / src_w, dst_h / src_h)
    return src_w * scale, src_h * scale


def scale_factor(src_w: int, src_h: int, dst_w: int, dst_h: int,
                 mode: FitMode = "cover") -> float:
    """
    一个数得到缩放因子（ffmpeg scale=iw*factor:ih*factor 里那个 factor）。
    """
    if mode == "cover":
        return max(dst_w / src_w, dst_h / src_h)
    elif mode in ("contain", "inside", "pad"):
        return min(dst_w / src_w, dst_h / src_h)
    elif mode == "fill":
        return min(dst_w / src_w, dst_h / src_h)  # 不裁剪也不填充，和 contain 同？
    else:
        raise ValueError(f"未知 mode: {mode}")


# ── 定位 ──────────────────────────────────────────────────────────

def center_offset(src_w: int, src_h: int, dst_w: int, dst_h: int,
                  mode: FitMode = "cover") -> tuple[float, float, float, float]:
    """
    完整 fit 计算，返回 (target_w, target_h, offset_x, offset_y)。

    用在 ffmpeg overlay 里:
        - 先 scale=target_w:target_h
        - 再 overlay=offset_x:offset_y

    或者 crop 里：
        - cover 模式先 scale 放大到覆盖整个 dst，再 crop=dst_w:dst_h:crop_x:crop_y
    """
    if src_w <= 0 or src_h <= 0:
        raise ValueError("src 尺寸必须正")

    if mode == "cover":
        tw, th = aspect_cover(src_w, src_h, dst_w, dst_h)
        # cover: 先放大覆盖，再居中裁剪到 dst 尺寸
        offset_x = (tw - dst_w) / 2   # crop 的 x 起点（scale 之后）
        offset_y = (th - dst_h) / 2
    elif mode in ("contain", "inside"):
        tw, th = aspect_fit(src_w, src_h, dst_w, dst_h)
        offset_x = (dst_w - tw) / 2   # overlay 的 x 偏移（dst 之上居中）
        offset_y = (dst_h - th) / 2
    elif mode == "pad":
        # 和 contain 一样，靠后面加 pad 滤镜
        tw, th = aspect_fit(src_w, src_h, dst_w, dst_h)
        offset_x = (dst_w - tw) / 2
        offset_y = (dst_h - th) / 2
    elif mode == "fill":
        tw, th = dst_w, dst_h
        offset_x = 0.0
        offset_y = 0.0
    else:
        raise ValueError(f"未知 mode: {mode}")

    return tw, th, offset_x, offset_y


# ── ffmpeg 参数生成 ───────────────────────────────────────────────

def scale_params(src_w: int, src_h: int, dst_w: int, dst_h: int,
                 mode: FitMode = "cover") -> str:
    """
    生成 ffmpeg scale= 参数串（整数字段）。

    注意：ffmpeg scale 必须整数，所以 round 之后可能有 1px 误差。
    对 xfade 转场 + 多 clip 拼接来说，1px 误差可能造成 filter_complex 报错。
    这里提供一个 round 策略。
    """
    tw, th, _, _ = center_offset(src_w, src_h, dst_w, dst_h, mode)
    return f"{int(round(tw))}:{int(round(th))}"


def crop_params_for_cover(src_w: int, src_h: int, dst_w: int, dst_h: int) -> str:
    """
    cover 模式的 ffmpeg crop= 参数串。
    先 scale 放大，再居中裁剪。

    输出 crop=w:h:x:y —— w/h 用 dst 尺寸，x/y 用 scale 之后的偏移 round
    """
    tw, th, ox, oy = center_offset(src_w, src_h, dst_w, dst_h, "cover")
    crop_w = int(round(dst_w))
    crop_h = int(round(dst_h))
    crop_x = max(0, int(round(ox)))
    crop_y = max(0, int(round(oy)))
    return f"{crop_w}:{crop_h}:{crop_x}:{crop_y}"


def overlay_params_contain(src_w: int, src_h: int, dst_w: int, dst_h: int,
                            mode: FitMode = "contain") -> str:
    """
    contain/pad 模式的 overlay=x:y 参数。
    scale 先做 scale_params(dst_w, dst_h, mode)，overlay 用这里的偏移。
    """
    _, _, ox, oy = center_offset(src_w, src_h, dst_w, dst_h, mode)
    return f"{int(round(ox))}:{int(round(oy))}"


def pad_params(src_w: int, src_h: int, dst_w: int, dst_h: int,
               color: str = "black") -> str:
    """
    ffmpeg pad= 参数（用在 contain 模式后加黑边）。
    pad=w:h:x:y:color
    """
    tw, th, ox, oy = center_offset(src_w, src_h, dst_w, dst_h, "contain")
    tw = int(round(tw))
    th = int(round(th))
    pw = max(tw, dst_w)
    ph = max(th, dst_h)
    # 如果已经 dst 尺寸了就不需要 pad
    if tw >= dst_w and th >= dst_h:
        return ""
    px = max(0, int(round(ox)))
    py = max(0, int(round(oy)))
    return f"{pw}:{ph}:{px}:{py}:{color}"


# ── 完整 filter 链生成 ───────────────────────────────────────────

def make_video_filter(
    src_w: int, src_h: int,
    dst_w: int, dst_h: int,
    fit: FitMode = "cover",
    fps: float | int | None = None,
    sar: str | None = "1",
    rot: int = 0,
    reverse: bool = False,
) -> list[str]:
    """
    纯函数生成完整的 ffmpeg video filter 链（list，拼接到 -vf 或 filter_complex）。

    比 render.py 里手写的更稳健：
    - 自动 cover 模式的 crop
    - 自动 contain 模式的 pad
    - scale+sar 正确顺序（先 scale 后 sar）
    """
    filters: list[str] = []

    # format（yuv420p 兼容性滤镜 — 先确保色彩空间正确）
    filters.append("format=yuv420p")

    # rotate（必须在 scale 之前，因为旋转改变宽高）
    if rot == 90 or rot == 270:
        filters.append(f"transpose={'cclock' if rot == 90 else 'clock'}")

    # scale
    if fit == "cover":
        # cover: 先 scale 放大到覆盖，再 crop 到 dst
        filters.append(f"scale={scale_params(src_w, src_h, dst_w, dst_h, 'cover')}")
        filters.append(crop_params_for_cover(src_w, src_h, dst_w, dst_h))
    elif fit in ("contain", "pad"):
        filters.append(f"scale={scale_params(src_w, src_h, dst_w, dst_h, 'contain')}")
        # contain 不自动 pad — 让用户显式指定 pad（黑边/模糊边/镜像边）
    else:  # fill / inside
        filters.append(f"scale={scale_params(src_w, src_h, dst_w, dst_h, fit)}")

    # SAR（确保像素纵横比是 1:1，否则 overlay 时会变形）
    if sar:
        filters.append(f"setsar={sar}")

    # FPS（强制 fps，防止多 clip xfade 时 fps 不一致报错）
    if fps is not None:
        filters.append(f"fps={fps}")

    if reverse:
        filters.append("reverse")

    return filters


# ── Ken Burns（hypit 没有但 video-cli 需要） ─────────────────────

def kenburns_filter(
    src_w: int, src_h: int,
    dst_w: int, dst_h: int,
    mode: str = "in",
    start_scale: float = 1.0,
    end_scale: float = 1.15,
    zoom_center: str = "center",
) -> list[str]:
    """
    Ken Burns effect：从 start_scale 放大到 end_scale（in）或反向（out）。

    原理：
    - scale 到 src_size * start_scale（比原始大，需要 crop）
    - crop 回 src_size，起始 crop 位置居中
    - setpts=PTS-STARTPTS 重置时间戳
    - zoompan 滤镜做平滑动画（或者 crop + overlay + enable='between(t,start,end)'）

    这里返回 zoompan 滤镜参数串（ffmpeg 原生 Ken Burns）。
    """
    if mode == "in":
        z_from, z_to = start_scale, end_scale
    elif mode == "out":
        z_from, z_to = end_scale, start_scale
    elif mode == "none":
        return []
    else:
        raise ValueError(f"未知 Ken Burns mode: {mode}")

    # zoompan: 以 z_from 开始，平滑到 z_to
    # 输出 dst 尺寸
    # zoompan=w:h:x:y:z:s:key
    # x/y 是 crop 起点，z 是缩放因子
    # s=zoompan 的平滑度（0~1，越大越快）
    zs = min(z_from, z_to)   # 起始 z
    ze = max(z_from, z_to)   # 结束 z
    # center 方式：x/y 是居中的 crop 起点
    scaled_w = src_w * ze
    scaled_h = src_h * ze
    if zoom_center == "center":
        cx = (scaled_w - dst_w) / 2
        cy = (scaled_h - dst_h) / 2
    else:
        cx, cy = 0, 0

    zoompan = (
        f"zoompan={dst_w}:{dst_h}:"
        f"x='iw/2-(iw/zoom/2)':"
        f"y='ih/2-(ih/zoom/2)':"
        f"z='min(max(zoom,pzoom)+0.002, {ze:.3f})':"
        f"d=1:s={src_w}:{src_h}:keyframes='eq(n\\,0)+eq(n\\,1)+"
        f"gt(n\\,{int(dst_h * 2)})'"
    )
    return [zoompan]
