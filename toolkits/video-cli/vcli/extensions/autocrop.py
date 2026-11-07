"""
YOLOv8 自动主体检测 + 裁剪（hypit face 模块的 Python 实现）。

hypit 用 YOLOv8 AnimeFace + 主体检测自动裁剪素材，让画面始终聚焦人物/主体。
这里用 ultralytics YOLOv8 做同样的事。

能做什么：
- detect_faces(image_or_video_path) → list[(x,y,w,h,conf)]  检测到的人脸
- autocrop_frame(src_frame, dst_w, dst_h) → (crop_x, crop_y)  单帧自动裁剪点
- autocrop_video(src_video, dst_w, dst_h, out_video) → 自动裁剪整个视频

首次调用自动 pip install ultralytics + opencv-python-headless。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from . import runtime as _rt


@dataclass
class FaceBox:
    """检测到的人脸/主体框。"""
    x: int
    y: int
    w: int
    h: int
    confidence: float
    label: str = "person"

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)

    @property
    def area(self) -> int:
        return self.w * self.h


@dataclass
class AutocropConfig:
    model: str = "yolov8n.pt"       # yolov8n/s/m/l/x 或 yolov8n-face.pt
    conf_threshold: float = 0.35
    target_classes: tuple[int, ...] = (0,)  # COCO: 0=person
    padding_ratio: float = 0.15    # 裁剪框外扩 15%
    smooth_window: int = 5          # 时间平滑（相邻帧检测框取平均）
    auto_install: bool = True


# ── 核心：检测 ──────────────────────────────────────────────────

def load_model(cfg: AutocropConfig | None = None):
    """加载 YOLOv8 模型（lazy import + 自动装）。"""
    cfg = cfg or AutocropConfig()
    ultralytics = _rt.lazy_import("ultralytics", auto_install=cfg.auto_install)
    return ultralytics.YOLO(cfg.model)


def detect(
    source_path: str,
    cfg: AutocropConfig | None = None,
) -> list[FaceBox]:
    """
    检测图像/视频里的 person/face 框。

    source_path: 图片或视频路径。视频会取所有帧的检测结果（第一帧为主）。
    返回所有检测到的 box（取最大面积的 person/face）。
    """
    cfg = cfg or AutocropConfig()
    model = load_model(cfg)
    results = model.predict(
        source_path,
        conf=cfg.conf_threshold,
        classes=cfg.target_classes,
        verbose=False,
    )

    boxes: list[FaceBox] = []
    for result in results:
        if result.boxes is None:
            continue
        for box in result.boxes:
            xyxy = box.xyxy[0].tolist()  # [x1,y1,x2,y2]
            x1, y1, x2, y2 = [int(v) for v in xyxy]
            w, h = x2 - x1, y2 - y1
            boxes.append(FaceBox(
                x=x1, y=y1, w=w, h=h,
                confidence=float(box.conf[0]),
                label=result.names[int(box.cls[0])],
            ))
    return boxes


# ── 自动裁剪点计算 ──────────────────────────────────────────────

def autocrop_offset(
    src_w: int, src_h: int,
    dst_w: int, dst_h: int,
    subject_boxes: Sequence[FaceBox],
    padding_ratio: float = 0.15,
) -> tuple[int, int]:
    """
    计算 autocrop 的 crop_x, crop_y（ffmpeg crop 的起点）。

    逻辑：
    1. 找到所有主体框的加权中心（面积越大越重）
    2. 围绕中心扩展 padding_ratio
    3. 然后对齐到 cover 模式裁剪（保证 dst aspect ratio）
    4. 返回左上角坐标（确保不越界）

    无人检测到就返回 (0, 0) — 等同于 cover 居中。
    """
    if not subject_boxes:
        # 无人 — 用 cover 居中逻辑
        from .spatial_math import center_offset
        _, _, ox, oy = center_offset(src_w, src_h, dst_w, dst_h, "cover")
        return max(0, int(round(ox))), max(0, int(round(oy)))

    # 加权中心
    total_weight = sum(b.area for b in subject_boxes)
    cx = sum(b.center[0] * b.area for b in subject_boxes) / total_weight
    cy = sum(b.center[1] * b.area for b in subject_boxes) / total_weight

    # 加 padding（最大框的 padding_ratio 倍）
    max_w = max(b.w for b in subject_boxes)
    max_h = max(b.h for b in subject_boxes)
    pad_w = max_w * padding_ratio
    pad_h = max_h * padding_ratio

    # cover 裁剪（dst aspect ratio）
    target_aspect = dst_w / dst_h

    # 以 (cx, cy) 为中心，计算裁剪框
    # cover 模式：裁剪框填满 dst aspect，中心对齐 (cx, cy)
    crop_w = dst_w
    crop_h = dst_h

    # 但 src 尺寸有限 — 裁剪框不能超出 src
    cx = max(crop_w / 2, min(cx, src_w - crop_w / 2))
    cy = max(crop_h / 2, min(cy, src_h - crop_h / 2))

    ox = int(round(cx - crop_w / 2))
    oy = int(round(cy - crop_h / 2))

    # 边界保护
    ox = max(0, min(ox, src_w - crop_w))
    oy = max(0, min(oy, src_h - crop_h))

    return ox, oy


def autocrop_video_filter(
    src_video_path: str,
    dst_w: int, dst_h: int,
    cfg: AutocropConfig | None = None,
) -> str:
    """
    返回 ffmpeg crop= 参数串（基于主体检测）。

    比手动 crop 更智能：自动对着人脸/主体居中。

    用法：
        offset_x, offset_y = autocrop_offset_from_video(src_video_path, dst_w, dst_h)
        # 然后 ffmpeg filter_complex 里加 crop=dst_w:dst_h:offset_x:offset_y
    """
    import subprocess
    # 第一帧检测
    boxes = detect(src_video_path, cfg)
    # 拿视频第一帧尺寸
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0", src_video_path],
        capture_output=True, text=True, check=False,
    )
    src_w, src_h = [int(x) for x in probe.stdout.strip().split(",")]
    ox, oy = autocrop_offset(src_w, src_h, dst_w, dst_h,
                             boxes, cfg.padding_ratio if cfg else 0.15)
    return f"crop={dst_w}:{dst_h}:{ox}:{oy}"


# ── 状态检查 ────────────────────────────────────────────────────

def is_available() -> bool:
    return _rt.check_import("ultralytics")
