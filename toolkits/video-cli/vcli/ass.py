"""ASS 字幕/标题生成：把 job.json 中的文字与 SRT 统一转成 ASS，交给 libass 烧录。"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from .errors import Codes, VcliError
from .util import ass_time, hex_to_ass, srt_time_to_sec

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},&H000000FF,{outline_color},&H00000000,{bold},{italic},0,0,100,100,0,0,1,{outline},{shadow},2,{ml},{mr},{mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _escape(text: str) -> str:
    text = text.replace("\\", "\\\u200b").replace("{", "｛").replace("}", "｝")
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\N")


def _cells(ch: str) -> float:
    if ch in " \t":
        return 0.5
    return 1.0 if unicodedata.east_asian_width(ch) in ("W", "F", "A") else 0.55


def wrap_text(text: str, max_cells: int) -> str:
    """按显示宽度折行，保留手动换行。"""
    out: list[str] = []
    for para in text.split("\n"):
        line, width = "", 0.0
        for ch in para:
            w = _cells(ch)
            if width + w > max_cells and line:
                out.append(line.rstrip())
                line, width = ch, w
            else:
                line += ch
                width += w
        out.append(line.rstrip())
    return "\n".join(out)


def _style_tags(style: dict, inline: dict, opacity: float) -> str:
    s = {**style, **{k: v for k, v in inline.items() if v is not None}}
    tags = []
    if s.get("font"):
        tags.append(f"\\fn{s['font']}")
    if s.get("size"):
        tags.append(f"\\fs{int(round(float(s['size'])))}")
    if s.get("color"):
        tags.append(f"\\c{hex_to_ass(s['color'])}&")
    if s.get("outline_color"):
        tags.append(f"\\3c{hex_to_ass(s['outline_color'])}&")
    if s.get("outline") is not None:
        tags.append(f"\\bord{float(s['outline']):.1f}")
    if s.get("shadow") is not None:
        tags.append(f"\\shad{float(s['shadow']):.1f}")
    if s.get("bold"):
        tags.append("\\b1")
    elif "bold" in inline and inline.get("bold") is False:
        tags.append("\\b0")
    if s.get("italic"):
        tags.append("\\i1")
    if s.get("line_spacing"):
        tags.append(f"\\fsp{max(0.0, (float(s['line_spacing']) - 1) * float(s.get('size', 60))):.1f}")
    alpha = int(round((1.0 - max(0.0, min(1.0, opacity))) * 255))
    if alpha:
        tags.append(f"\\alpha&H{alpha:02X}&")
    return "".join(tags)


def _anchor(pos, width: int, height: int, margin: int) -> tuple[int, int, int]:
    """返回 (x, y, ass_alignment)。"""
    if isinstance(pos, (list, tuple)) and len(pos) == 2:
        return int(pos[0]), int(pos[1]), 5
    p = str(pos or "center").strip().lower().replace("_", "-")
    table = {
        "center": (width // 2, height // 2, 5),
        "top": (width // 2, margin, 8),
        "bottom": (width // 2, height - margin, 2),
        "top-left": (margin, margin, 7),
        "top-right": (width - margin, margin, 9),
        "bottom-left": (margin, height - margin, 1),
        "bottom-right": (width - margin, height - margin, 3),
        "center-left": (margin, height // 2, 4),
        "center-right": (width - margin, height // 2, 6),
    }
    if p in table:
        return table[p]
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$", p)
    if m:
        return int(float(m.group(1))), int(float(m.group(2))), 5
    return table["center"]


def scene_text_ass(path: Path, scene: dict, width: int, height: int, style: dict) -> None:
    """为单个场景生成标题 ASS，时间相对场景起点。"""
    lines = [HEADER.format(
        w=width, h=height,
        font=style.get("font", "Noto Sans CJK SC"), size=int(style.get("size", 64)),
        primary=hex_to_ass(style.get("color", "#FFFFFF")),
        outline_color=hex_to_ass(style.get("outline_color", "#000000")),
        bold=-1 if style.get("bold", True) else 0,
        italic=-1 if style.get("italic") else 0,
        outline=float(style.get("outline", 2)), shadow=float(style.get("shadow", 0)),
        ml=int(style.get("margin", 80)), mr=int(style.get("margin", 80)),
        mv=int(style.get("margin", 80)),
    )]
    dur = float(scene.get("duration") or 0)
    for item in scene.get("texts") or []:
        start = float(item.get("start") or 0)
        end = item.get("end")
        end = dur if end is None else min(dur, float(end))
        if end <= start:
            continue
        content = wrap_text(str(item.get("content") or ""), int(item.get("max_chars") or 22))
        inline = {k: item.get(k) for k in ("font", "size", "color", "outline", "outline_color",
                                           "bold", "italic", "line_spacing")}
        opacity = float(item.get("opacity", 1.0))
        tags = _style_tags(style, inline, opacity)
        x, y, an = _anchor(item.get("pos"), width, height, int(item.get("margin", style.get("margin", 80))))
        anim = item.get("anim") or "fade"
        adur = float(item.get("anim_duration") or 0.5)
        if anim == "typewriter":
            _typewriter(lines, content, start, end, tags, x, y, an, adur)
            continue
        move = ""
        if anim == "fade_up":
            move = f"\\move({x},{y + 48},{x},{y},0,{int(adur * 1000)})"
        elif anim == "fade_down":
            move = f"\\move({x},{y - 48},{x},{y},0,{int(adur * 1000)})"
        elif anim == "slide_left":
            move = f"\\move({x + 90},{y},{x},{y},0,{int(adur * 1000)})"
        elif anim == "slide_right":
            move = f"\\move({x - 90},{y},{x},{y},0,{int(adur * 1000)})"
        fade = "\\fad(350,350)" if anim != "none" else ""
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,"
                     f"{{{tags}\\an{an}\\pos({x},{y}){move}{fade}}}{_escape(content)}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _typewriter(lines: list[str], content: str, start: float, end: float,
                tags: str, x: int, y: int, an: int, adur: float) -> None:
    plain = content.replace("\n", "")
    total = max(0.3, min(adur, end - start))
    n = max(1, len(plain))
    step = total / n
    for k in range(1, n + 1):
        seg_start = start + step * (k - 1)
        shown = _escape(plain[:k])
        lines.append(f"Dialogue: 0,{ass_time(seg_start)},{ass_time(end)},Default,,0,0,0,,"
                     f"{{{tags}\\an{an}\\pos({x},{y})}}{shown}")


def parse_srt(text: str) -> list[dict]:
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    blocks = re.split(r"\n\s*\n", text.strip())
    out = []
    for block in blocks:
        rows = [r for r in block.split("\n") if r.strip()]
        if not rows:
            continue
        idx = 0
        if not re.search(r"\d+:\d+:\d+", rows[0]) and len(rows) > 1:
            idx = 1
        m = re.search(r"(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)", rows[idx])
        if not m:
            continue
        body = "\n".join(rows[idx + 1:]).strip()
        body = re.sub(r"<[^>]+>", "", body)
        if not body:
            continue
        out.append({"start": srt_time_to_sec(m.group(1)), "end": srt_time_to_sec(m.group(2)),
                    "text": body, "_ass": True})
    return out


def overlay_ass(path: Path, width: int, height: int, duration: float, *,
                srt_text: str | None = None, subtitle_style: dict | None = None,
                text_wm: dict | None = None, extra_cues: list[dict] | None = None) -> None:
    """生成最终成片用的 ASS：外挂字幕 + 文字水印。"""
    st = subtitle_style or {}
    font = st.get("font") or "Noto Sans CJK SC"
    size = int(st.get("size") or 46)
    lines = [HEADER.format(
        w=width, h=height, font=font, size=size,
        primary=hex_to_ass(st.get("color", "#FFFFFF")),
        outline_color=hex_to_ass(st.get("outline_color", "#000000")),
        bold=-1 if st.get("bold", True) else 0,
        italic=-1 if st.get("italic") else 0,
        outline=float(st.get("outline", 2.4)), shadow=float(st.get("shadow", 0)),
        ml=int(st.get("margin_lr", 60)), mr=int(st.get("margin_lr", 60)),
        mv=int(st.get("margin_v", 56)),
    )]
    max_chars = int(st.get("max_chars") or 18)
    opacity = float(st.get("opacity", 1.0))
    tags = _style_tags(st, {}, opacity)

    cues = parse_srt(srt_text) if srt_text else []
    cues += extra_cues or []
    for cue in cues:
        start, end = float(cue["start"]), float(cue["end"])
        if end <= start:
            continue
        content = wrap_text(cue["text"], max_chars)
        if cue.get("_ass"):
            body = _escape(content)
        else:
            body = _escape(content)
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,"
                     f"{{{tags}\\an2\\pos({width // 2},{height - int(st.get('margin_v', 56))})}}{body}")

    if text_wm and text_wm.get("content"):
        x, y, an = _anchor(text_wm.get("position", "bottom-right"), width, height,
                           int(text_wm.get("margin", 24)))
        wm_style = {"font": font, "size": int(text_wm.get("size", 28)),
                    "color": text_wm.get("color", "#FFFFFF"), "outline": 1.2,
                    "outline_color": "#000000", "bold": False}
        wm_tags = _style_tags(wm_style, {}, float(text_wm.get("opacity", 0.55)))
        start = float(text_wm.get("start", 0.0) or 0.0)
        end = text_wm.get("end")
        end = duration if end is None else min(duration, float(end))
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,"
                     f"{{{wm_tags}\\an{an}\\pos({x},{y})}}{_escape(str(text_wm['content']))}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_text(path: str | Path) -> str:
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise VcliError(Codes.IO, f"读取字幕失败: {path}", details=str(exc))
    for enc in ("utf-8-sig", "utf-16", "gb18030", "big5", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")
