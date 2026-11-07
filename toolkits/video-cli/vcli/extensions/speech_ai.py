"""
WhisperX 词级转写（hypit speech-evidence 的 Python 实现）。

移植自 hypit-ai/hypit，底层复用 WhisperX。
首次调用时自动 pip install whisperx（可选禁止）。

能做什么：
- transcribe(audio_path) → list[TranscriptWord]  词级时间戳
- phrase_durations(audio_path, phrases) → dict  直接返回短语时间（跳过中间 step）
- auto_scene_boundaries(audio_path, pause_threshold=0.5) → list[(start, end, text)]

和我们已有的 wordtiming.py 完美对接：
  words = transcribe("voice.mp3")
  matches = phrase_ranges(words, "viral video")
  → [PhraseMatch(text='viral video', start=1.08, end=1.75)]
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable, Sequence

from . import runtime as _rt
from .wordtiming import TranscriptWord, parse_transcript_words


# ── 配置 ────────────────────────────────────────────────────────

@dataclass
class WhisperXConfig:
    """WhisperX 调用参数（和 hypit activation.ts 的参数对齐）。"""
    model_name: str = "medium"       # tiny/base/small/medium/large-v3
    compute_type: str = "float16"    # float16/int8/float32
    language: str = "en"
    device: str = "cuda"             # cuda / cpu
    batch_size: int = 8              # ctranslate2 batch
    align_model: str = "wav2vec2"    # wav2vec2 / null（跳过对齐）
    auto_install: bool = True


# ── 核心 ────────────────────────────────────────────────────────

def transcribe(
    audio_path: str,
    config: WhisperXConfig | None = None,
) -> list[TranscriptWord]:
    """
    转写音频 → 带时间戳的词列表。

    自动处理：
    - 检查 whisperx 是否装了 → 没装则 pip install
    - GPU 自动探测（没 CUDA 就退回 cpu）
    - 返回格式和 wordtiming.TranscriptWord 一致
    """
    cfg = config or WhisperXConfig()

    # lazy import — 没装就自动 pip install
    wx = _rt.lazy_import("whisperx", auto_install=cfg.auto_install)

    # GPU 探测
    try:
        import torch
        has_cuda = torch.cuda.is_available()
    except Exception:
        has_cuda = False
    device = "cuda" if (cfg.device == "cuda" and has_cuda) else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    # 加载模型
    model = wx.load_model(
        cfg.model_name,
        device=device,
        compute_type=compute_type,
    )

    # 转写
    result = model.transcribe(
        audio_path,
        batch_size=cfg.batch_size,
        language=cfg.language,
    )

    # 词对齐（word-level timestamps 的关键步骤）
    if cfg.align_model and "segments" in result:
        try:
            align_model, metadata = wx.load_align_model(
                language_code=cfg.language,
                device=device,
            )
            result = wx.align(
                result["segments"],
                align_model,
                metadata,
                audio_path,
                device,
            )
        except Exception as e:
            print(f"[speech_ai] 对齐失败（跳过）: {e}", file=os.sys.stderr)

    # 提取词
    words: list[TranscriptWord] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            # WhisperX 输出 key 是 text/start/end/score
            words.append(TranscriptWord(
                text=w.get("word", w.get("text", "")).strip(),
                start=w.get("start"),
                end=w.get("end"),
                score=w.get("score"),
            ))

    return words


# ── 高层快捷函数 ────────────────────────────────────────────────

def phrase_durations(
    audio_path: str,
    phrases: Iterable[str],
    config: WhisperXConfig | None = None,
) -> dict[str, list[tuple[float, float]]]:
    """
    直接返回每个短语的所有时间范围（跳过中间步骤）。

    比先 transcribe 再 phrase_ranges 更方便。

    返回:
        {"viral video": [(1.08, 1.75), (8.42, 9.11)],
         "subscribe": [(3.20, 3.55)]}
    """
    from .wordtiming import phrase_ranges  # 延迟 import，避免循环

    words = transcribe(audio_path, config)
    result: dict[str, list[tuple[float, float]]] = {}
    for phrase in phrases:
        matches = phrase_ranges(words, phrase)
        result[phrase] = [(round(m.start, 3), round(m.end, 3)) for m in matches]
    return result


def auto_scene_boundaries(
    audio_path: str,
    pause_threshold: float = 0.5,
    min_scene_duration: float = 2.0,
    config: WhisperXConfig | None = None,
) -> list[dict]:
    """
    纯语音驱动的自动场景切分。

    原理：
    1. WhisperX 得到词级时间戳
    2. 按停顿 (>pause_threshold) 切分成语段
    3. 过滤掉太短的（<min_scene_duration）
    4. 每个语段 → 一个 scene

    返回:
        [{"start": 0.0, "end": 5.2, "text": "Welcome to the viral video today"},
         {"start": 5.7, "end": 12.3, "text": "We are going to show you something amazing"}, ...]
    """
    from .wordtiming import split_by_pauses  # 延迟 import

    words = transcribe(audio_path, config)
    segments = split_by_pauses(words, pause_threshold)

    scenes: list[dict] = []
    for seg in segments:
        if not seg:
            continue
        start = min(w.start for w in seg if w.start is not None)
        end = max(w.end for w in seg if w.end is not None)
        if start is None or end is None:
            continue
        duration = end - start
        if duration < min_scene_duration:
            continue
        text = " ".join(w.text for w in seg)
        scenes.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(duration, 3),
            "text": text,
        })

    return scenes


# ── 状态检查 ────────────────────────────────────────────────────

def is_available() -> bool:
    """WhisperX 是否已安装可用。"""
    return _rt.check_import("whisperx")


def get_status() -> _rt.RuntimeStatus:
    info = _rt.get_runtime("whisperx")
    return info._status if info else _rt.RuntimeStatus.FAILED
