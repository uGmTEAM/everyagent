"""
hypit 风格 temporal domain 数学模块。

移植自 hypit-ai/hypit packages/temporal/ + packages/timeline/
纯算法：帧/秒互转（保守取整）、重叠 clip 解析、时间线完整性检查。

可解决的问题：
- xfade 帧边界 off-by-one（hypit 用保守取整）
- 多 clip 争抢同一时间区域的冲突
- 时间线 gap/overlap 自动检测
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence


# ── 帧/秒互转 ─────────────────────────────────────────────────────

def duration_in_frames(duration_seconds: float, fps: int | float) -> int:
    """
    秒 → 帧数（hypit 保守取整：floor，避免超出预期范围）。

    hypit durationInFrames 语义: "how many frames this span covers"
    保守策略防止 n 秒被四舍五入成 n+1 帧导致最后一帧越界。
    """
    if fps <= 0:
        raise ValueError(f"fps 必须为正: {fps}")
    if duration_seconds < 0:
        return 0
    return int(duration_seconds * fps)


def frame_boundary_time(frame_index: int, fps: int | float) -> float:
    """帧索引 → 秒（这一帧开始的时间点）。"""
    if frame_index < 0:
        raise ValueError(f"frame_index 不能为负: {frame_index}")
    if fps <= 0:
        raise ValueError(f"fps 必须为正: {fps}")
    return frame_index / fps


def frame_end_time(frame_index: int, fps: int | float) -> float:
    """帧索引 → 秒（这一帧结束的时间点，即下一帧开始）。"""
    return frame_boundary_time(frame_index + 1, fps)


def nearest_frame(time_seconds: float, fps: int | float) -> int:
    """秒 → 最近的帧索引（round）。"""
    return int(round(time_seconds * fps))


def snap_to_frame(time_seconds: float, fps: int | float, mode: str = "floor") -> float:
    """
    把时间戳对齐到帧边界。

    mode:
      - "floor"   向下取整（保守，hypit 默认）
      - "ceil"    向上取整
      - "nearest" 最近
    """
    fps = float(fps)
    if mode == "floor":
        return int(time_seconds * fps) / fps
    elif mode == "ceil":
        return (int(time_seconds * fps) + (1 if time_seconds * fps % 1 else 0)) / fps
    elif mode == "nearest":
        return round(time_seconds * fps) / fps
    else:
        raise ValueError(f"未知 mode: {mode}")


# ── 区间操作 ──────────────────────────────────────────────────────

@dataclass(frozen=True, order=True)
class Interval:
    """时间区间 [start, end)，end 为排他。"""
    start: float
    end: float

    def __post_init__(self):
        if self.start > self.end:
            raise ValueError(f"Interval start > end: {self.start} > {self.end}")

    @property
    def duration(self) -> float:
        return self.end - self.start

    def contains(self, t: float) -> bool:
        return self.start <= t < self.end

    def intersects(self, other: Interval) -> bool:
        return self.start < other.end and other.start < self.end

    def intersection(self, other: Interval) -> Interval | None:
        s = max(self.start, other.start)
        e = min(self.end, other.end)
        if s >= e:
            return None
        return Interval(s, e)

    def union(self, other: Interval) -> Interval | None:
        if not self.intersects(other):
            return None
        return Interval(min(self.start, other.start), max(self.end, other.end))


def merge_intervals(intervals: Iterable[Interval]) -> list[Interval]:
    """
    合并重叠区间。

    算法: 按 start 排序 → 逐个看是否扩展当前区间
    hypit composition 里对多 clip scene 的时间线做相同操作。
    """
    sorted_ivs = sorted(intervals)
    merged: list[Interval] = []
    for iv in sorted_ivs:
        if merged and merged[-1].intersects(iv):
            last = merged[-1]
            merged[-1] = Interval(min(last.start, iv.start), max(last.end, iv.end))
        else:
            merged.append(iv)
    return merged


def subtract_intervals(
    base: Interval,
    cuts: Sequence[Interval],
) -> list[Interval]:
    """
    从 base 区间里挖掉 cuts，返回剩下的区间列表。

    用途: scene A 和 scene B 有 0.6s xfade 重叠区域，
    但各自内容时间线不重叠——xfade 只是过渡，不是同时播放。
    """
    remaining = [base]
    for cut in cuts:
        new_remaining: list[Interval] = []
        for iv in remaining:
            inter = iv.intersection(cut)
            if inter is None:
                new_remaining.append(iv)
                continue
            before = Interval(iv.start, inter.start) if inter.start > iv.start else None
            after = Interval(inter.end, iv.end) if inter.end < iv.end else None
            if before and before.duration > 0:
                new_remaining.append(before)
            if after and after.duration > 0:
                new_remaining.append(after)
        remaining = new_remaining
    return [iv for iv in remaining if iv.duration > 0]


# ── 时间线完整性 ──────────────────────────────────────────────────

@dataclass
class TimelineReport:
    """时间线健康检查结果。"""
    total_duration: float
    gap_count: int
    overlap_count: int
    gaps: list[Interval] = field(default_factory=list)
    overlaps: list[Interval] = field(default_factory=list)
    coverage: float = 0.0  # 被 clip 覆盖的时间比例

    @property
    def is_complete(self) -> bool:
        return self.gap_count == 0 and self.overlap_count == 0


def check_timeline(
    clips: Sequence[tuple[float, float]],
    total_duration: float | None = None,
    merge_xfade_overlap: bool = True,
) -> TimelineReport:
    """
    检查时间线的 gap/overlap。

    clips: [(start, end), ...] —— 每个 clip 的时间区间
    total_duration: 预期总时长（不传则用最后一个 clip 的 end）
    merge_xfade_overlap: True → 相邻 clip 重叠视为 xfade 过渡（不报错）

    hypit 在 admission 阶段对 composition 做这个检查。
    """
    intervals = [Interval(s, e) for s, e in clips]
    if not intervals:
        return TimelineReport(total_duration=total_duration or 0.0,
                              gap_count=0, overlap_count=0)

    # 合并相邻/重叠 clip（xfade 过渡是有意重叠，算一次连续播放）
    sorted_ivs = sorted(intervals)
    merged = merge_intervals(sorted_ivs) if merge_xfade_overlap else list(sorted_ivs)

    # 算 total
    if total_duration is None:
        total_duration = max(iv.end for iv in intervals)

    # 找 gap（在 merged 区间之间）
    gaps: list[Interval] = []
    prev_end = 0.0
    for iv in merged:
        if iv.start > prev_end + 1e-6:
            gaps.append(Interval(prev_end, iv.start))
        prev_end = max(prev_end, iv.end)
    if prev_end < total_duration - 1e-6:
        gaps.append(Interval(prev_end, total_duration))

    # 找 overlap（merged 之后还存在的区间重叠才是 bug）
    overlaps: list[Interval] = []
    for i in range(len(merged)):
        for j in range(i + 1, len(merged)):
            inter = merged[i].intersection(merged[j])
            if inter and inter.duration > 1e-6:
                overlaps.append(inter)

    # coverage
    covered = sum(iv.duration for iv in merged)
    coverage = covered / total_duration if total_duration > 0 else 0.0

    return TimelineReport(
        total_duration=total_duration,
        gap_count=len(gaps),
        overlap_count=len(overlaps),
        gaps=gaps,
        overlaps=overlaps,
        coverage=round(coverage, 4),
    )


# ── xfade 帧边界保守对齐 ──────────────────────────────────────────

def xfade_safe_offset(duration_seconds: float, fps: int,
                      mode: str = "conservative") -> float:
    """
    把 xfade 的 duration snap 到帧边界。

    mode:
      - "conservative": floor（hypit 默认，防止最后一帧越界）
      - "aggressive":    ceil
      - "exact":        保持原样（可能产生半帧，ffmpeg 会处理）

    问题根源: 0.6s xfade 在 30fps = 18 帧，刚好整除;
              0.5s xfade 在 30fps = 15 帧，也整除;
              0.3s xfade 在 30fps = 9 帧（0.3*30=9），整除;
              但 0.333s xfade 在 30fps = 9.99 帧，round=10，但 duration_in_frames 用 floor=9
              → 实际 xfade 持续 0.3s 而不是 0.333s，产生 0.033s gap。
    """
    frames = duration_in_frames(duration_seconds, fps)
    if mode == "conservative":
        return frame_end_time(frames - 1, fps) if frames > 0 else 0.0
    elif mode == "aggressive":
        return frame_end_time(frames, fps)
    else:  # exact
        return duration_seconds


def scene_safe_duration(
    src_duration: float,
    transition_duration: float,
    fps: int,
    is_last: bool = False,
) -> float:
    """
    计算场景的安全时长，考虑下一个 xfade 的重叠。

    场景 duration 不含 xfade 部分（xfade 在两个 scene 之间）。
    所以 scene_i 的安全时长 = min(src_duration, total_plan_duration)
                         - transition_duration（如果不是最后一个）

    保守策略：防止 scene 内容被 xfade 吃掉。
    """
    if is_last:
        safe = src_duration
    else:
        # 把 transition 时间排除在 scene 内容之外
        safe = src_duration - transition_duration
    # snap 到帧边界
    frames = duration_in_frames(safe, fps)
    return frame_end_time(frames - 1, fps) if frames > 0 else 0.0
