"""
hypit 风格 word-level timing 模块。

移植自 hypit-ai/hypit packages/speech-evidence/src/transcript-document.ts
纯算法：16kHz sample ↔ seconds 投影、逐字时间戳、短语定位。

无外部依赖，可选 import。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence


# ── 类型 ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TranscriptWord:
    """一个带时间戳的转写词。start/end 可能为 None（未知）。"""
    text: str
    start: float | None = None
    end: float | None = None
    score: float | None = None

    def __post_init__(self):
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ValueError(f"word end precedes start: {self!r}")


@dataclass(frozen=True)
class FrameWords:
    """某个时间点的活跃词 + 上下文窗口（hypit 'wordsAt' 语义）。"""
    active: tuple[TranscriptWord, ...]
    context: tuple[TranscriptWord, ...]


@dataclass(frozen=True)
class PhraseMatch:
    """phrase_ranges 找到的短语匹配结果。"""
    text: str
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


# ── 核心数学 ──────────────────────────────────────────────────────

SAMPLE_RATE = 16_000  # hypit speech-evidence 的固定采样率


def seconds_from_samples(sample: int | None, sample_rate: int = SAMPLE_RATE) -> float | None:
    """16kHz sample 计数 → 秒（保留 3 位小数）。"""
    if sample is None:
        return None
    return round(sample / sample_rate, 3)


def samples_from_seconds(seconds: float | None, sample_rate: int = SAMPLE_RATE) -> int | None:
    """秒 → sample 计数（取整）。"""
    if seconds is None:
        return None
    return int(round(seconds * sample_rate))


def sample_boundary(master_sample_rate: int, target_sample_rate: int = SAMPLE_RATE) -> int:
    """
    投影主音频采样率边界到目标采样率域。

    移植自 hypit speech-evidence/index.ts::speechEvidenceSampleBoundary
    公式: ceil(master * target / master)

    用途：当主语音轨是 48kHz 时，需要知道 16kHz evidence 轨对应的 sample 边界。
    """
    if not isinstance(master_sample_rate, int) or master_sample_rate <= 0:
        raise ValueError(f"master_sample_rate 必须是正整数: {master_sample_rate}")
    if not isinstance(target_sample_rate, int) or target_sample_rate <= 0:
        raise ValueError(f"target_sample_rate 必须是正整数: {target_sample_rate}")
    # hypit 原始公式: (BigInt(master) * 16000n * 2n + 48000n) / (48000n * 2n)
    # 简化为 ceil(master * target / master_rate)
    return int((master_sample_rate * target_sample_rate + master_sample_rate - 1) // master_sample_rate)


# ── 转写投影 ──────────────────────────────────────────────────────

def transcript_from_evidence(
    evidence: dict,
    source: str = "",
    language: str = "en",
    sample_rate: int = SAMPLE_RATE,
) -> dict:
    """
    把 sample 精度的 speech evidence 投影成 seconds 精度的人可读转写文档。

    移植自 hypit transcriptDocumentFromEvidence。

    evidence 格式:
        {
            "sampleFrames": int,            # 总 sample 数
            "passages": [
                {
                    "startSample": int,
                    "endSampleExclusive": int,
                    "words": [{"text": str, "startSample": int,
                               "endSampleExclusive": int, "score": float}]
                }
            ]
        }
    """
    passages_out = []
    for passage in evidence.get("passages", []):
        words_out = []
        for w in passage.get("words", []):
            word_out = {"text": w["text"]}
            for sk, ok in (("startSample", "start_seconds"),
                           ("endSampleExclusive", "end_seconds")):
                if w.get(sk) is not None:
                    word_out[ok] = seconds_from_samples(w[sk], sample_rate)
            if w.get("score") is not None:
                word_out["score"] = w["score"]
            words_out.append(word_out)
        passage_out = {
            "text": " ".join(w["text"] for w in words_out),
            "words": words_out,
        }
        for sk, ok in (("startSample", "start_seconds"),
                       ("endSampleExclusive", "end_seconds")):
            if passage.get(sk) is not None:
                passage_out[ok] = seconds_from_samples(passage[sk], sample_rate)
        passages_out.append(passage_out)

    return {
        "format": "vcli.transcript@1",
        "source": source,
        "language": language,
        "audio_seconds": seconds_from_samples(evidence["sampleFrames"], sample_rate) or 0.0,
        "passages": passages_out,
    }


# ── 解析 ──────────────────────────────────────────────────────────

def parse_transcript_words(data: dict | str, subject: str = "transcript") -> list[TranscriptWord]:
    """
    解析转写 JSON → 扁平 word 列表。

    支持两种格式:
      - hypit.transcript@1: {"format": "...", "passages": [{"words": [...]}]}
      - vcli.transcript@1: 同上（seconds 字段）
      - 原始: [{"text": str, "start": float, "end": float}]
      - WhisperX: [{"word": str, "start": float, "end": float, "score": float}]
    """
    if isinstance(data, str):
        data = json.loads(data)

    # 格式 1: passages-based
    if isinstance(data, dict) and "passages" in data:
        words: list[TranscriptWord] = []
        for passage in data.get("passages", []):
            for w in passage.get("words", []):
                words.append(_from_dict(w))
        return words

    # 格式 2: flat list
    if isinstance(data, list):
        return [_from_dict(w) for w in data]

    raise ValueError(f"{subject}: 无法识别的转写格式")


def _from_dict(w: dict) -> TranscriptWord:
    # WhisperX 用 "word", hypit 用 "text"
    text = w.get("text") or w.get("word") or ""
    start = w.get("start_seconds", w.get("start", w.get("startTime")))
    end = w.get("end_seconds", w.get("end", w.get("endTime")))
    score = w.get("score", w.get("probability"))
    if not isinstance(text, str):
        raise ValueError(f"word.text 必须是字符串, got {type(text)}")
    if start is not None and not isinstance(start, (int, float)):
        raise ValueError(f"word.start 必须是数字")
    if end is not None and not isinstance(end, (int, float)):
        raise ValueError(f"word.end 必须是数字")
    return TranscriptWord(
        text=text.strip(),
        start=float(start) if start is not None else None,
        end=float(end) if end is not None else None,
        score=float(score) if score is not None else None,
    )


# ── 查询 ──────────────────────────────────────────────────────────

def words_at(words: Sequence[TranscriptWord], at: float) -> FrameWords:
    """
    某个时间点活跃的词 + 上下文窗口。

    移植自 hypit::wordsAt。
    - active = 当前时刻被"正在说"的词（start <= at < end）
    - context = 以第一个 active 为锚点，前后各 3 个词的窗口
    """
    active = [w for w in words
              if w.start is not None and w.end is not None
              and w.start <= at < w.end]

    if active:
        anchor = words.index(active[0])
        last = words.index(active[-1])
    else:
        # 找离 at 最近的词作为锚点
        anchor = -1
        dist = float("inf")
        for i, w in enumerate(words):
            t = w.start if w.start is not None else w.end
            if t is None:
                continue
            d = abs(t - at)
            if d < dist:
                dist = d
                anchor = i
        last = anchor

    if anchor < 0:
        context: tuple[TranscriptWord, ...] = ()
    else:
        context = tuple(words[max(0, anchor - 3): last + 4])

    return FrameWords(active=tuple(active), context=context)


def phrase_ranges(
    words: Sequence[TranscriptWord],
    text: str,
) -> list[PhraseMatch]:
    """
    在转写中查找短语出现的所有位置（时间范围）。

    移植自 hypit::phraseRanges。
    - 标点/大小写不敏感 (NFKC normalize + lowercase + strip punctuation)
    - 返回每个匹配的精确 start/end 秒

    用途: scene 不手动写 duration，而是 "找到 voice 轨里说 'viral video' 的那段当场景"。
    """
    query = _searchable(text)
    if not query:
        raise ValueError("--around 需要一个词或短语")

    matches: list[PhraseMatch] = []
    for first in range(len(words)):
        if not _searchable(words[first].text):
            continue
        joined = ""
        for last in range(first, len(words)):
            joined += _searchable(words[last].text)
            if joined != query:
                if len(joined) > len(query):
                    break
                continue
            start = words[first].start
            end = words[last].end
            if start is None or end is None:
                raise ValueError(
                    f"短语 {text!r} 的边界时间缺失，检查转写或手动指定 start/end"
                )
            matches.append(PhraseMatch(text=text, start=start, end=end))
    return matches


def _searchable(text: str) -> str:
    r"""
    NFKC 规范化 + 小写 + 去掉标点/空白。
    hypit 原始: normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "")
    """
    import unicodedata
    normalized = unicodedata.normalize("NFKC", text).casefold()
    cleaned = re.sub(r"[\W_]+", "", normalized, flags=re.UNICODE)
    return cleaned


# ── 辅助 ──────────────────────────────────────────────────────────

def word_coverage(words: Sequence[TranscriptWord]) -> float:
    """所有有时间戳的词覆盖的总时长（秒）。"""
    total = 0.0
    for w in words:
        if w.start is not None and w.end is not None:
            total += max(0.0, w.end - w.start)
    return total


def word_density(words: Sequence[TranscriptWord], total_audio: float) -> float:
    """词密度（词数/秒），用于判断语音节奏快慢。"""
    if total_audio <= 0:
        return 0.0
    return len([w for w in words if w.start is not None]) / total_audio


def split_by_pauses(
    words: Sequence[TranscriptWord],
    pause_threshold: float = 0.5,
) -> list[list[TranscriptWord]]:
    """
    按停顿把词序列切成段。

    pause_threshold: 词间 gap > 此值算一次停顿，切分。
    常用: 0.3s 自然停顿 / 0.5s 句子边界 / 1.0s 段落边界。
    """
    segments: list[list[TranscriptWord]] = []
    seg: list[TranscriptWord] = []
    for i, w in enumerate(words):
        if seg and i > 0:
            prev = words[i - 1]
            if prev.end is not None and w.start is not None:
                gap = w.start - prev.end
                if gap > pause_threshold:
                    segments.append(seg)
                    seg = []
        seg.append(w)
    if seg:
        segments.append(seg)
    return segments
