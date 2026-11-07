"""常用输出规格预设。"""

from __future__ import annotations

PRESETS: dict[str, tuple[int, int]] = {
    "1080p": (1920, 1080),
    "720p": (1280, 720),
    "480p": (854, 480),
    "4k": (3840, 2160),
    "vertical_1080": (1080, 1920),
    "vertical_720": (720, 1280),
    "vertical_480": (480, 854),
    "square_1080": (1080, 1080),
    "square_720": (720, 720),
}

# 可用的 xfade 转场（ffmpeg 5.1+ 完整列表，共 46 种）
# 按视觉类别分组，方便 AI 选择
TRANSITIONS = [
    # —— 融合类（柔和，通用推荐）——
    "fade", "fadeblack", "fadewhite", "fadegrays", "fadefast", "fadeslow",
    "dissolve", "distance", "hblur",
    # —— 擦拭类（方向性明显）——
    "wipeleft", "wiperight", "wipeup", "wipedown",
    "wipetl", "wipetr", "wipebl", "wipebr",
    # —— 滑动类 ——
    "slideleft", "slideright", "slideup", "slidedown",
    # —— 圆形/矩形裁剪 ——
    "circlecrop", "rectcrop", "circleopen", "circleclose",
    # —— 开合类 ——
    "vertopen", "vertclose", "horzopen", "horzclose",
    # —— 平滑类 ——
    "smoothleft", "smoothright", "smoothup", "smoothdown",
    # —— 像素化/切片 ——
    "pixelize", "hlslice", "hrslice", "vuslice", "vdslice",
    # —— 对角擦除 ——
    "diagtl", "diagtr", "diagbl", "diagbr",
    # —— 其他 ——
    "radial", "zoomin", "squeezeh", "squeezev",
]

FIT_MODES = ["cover", "contain", "blur"]
KENBURNS_MODES = ["none", "in", "out", "left", "right", "up", "down"]
ANIMS = ["none", "fade", "fade_up", "fade_down", "slide_left", "slide_right", "typewriter"]


def resolve_size(video_cfg: dict) -> tuple[int, int]:
    """从 video.preset / video.size 解析输出宽高。"""
    size = video_cfg.get("size")
    if size:
        w, h = str(size).lower().split("x")
        return int(w), int(h)
    name = video_cfg.get("preset", "1080p")
    if name not in PRESETS:
        raise KeyError(name)
    return PRESETS[name]
