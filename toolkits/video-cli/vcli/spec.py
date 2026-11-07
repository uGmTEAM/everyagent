"""job.json 的加载、默认值填充、路径解析与校验。"""

from __future__ import annotations

import json
from pathlib import Path

from .errors import Codes, VcliError
from .presets import ANIMS, FIT_MODES, KENBURNS_MODES, PRESETS, TRANSITIONS

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".heic", ".avif"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".ts", ".flv", ".wmv"}

DEFAULTS = {
    "version": 1,
    "project": "video",
    "output": None,
    "video": {
        "preset": "1080p",
        "size": None,
        "fps": 30,
        "crf": 20,
        "encoder": "libx264",
        "pix_fmt": "yuv420p",
        "audio_bitrate": "192k",
        "faststart": True,
    },
    "audio": {
        "normalize": False,
        "loudness": -16,
        "silent_track": True,
    },
    "subtitles": None,
    "watermark": None,
    "text_watermark": None,
    "scenes": [],
}

TEXT_STYLE = {
    "font": "Noto Sans CJK SC",
    "size": 64,
    "color": "#FFFFFF",
    "bold": True,
    "italic": False,
    "outline": 2,
    "outline_color": "#000000",
    "shadow": 0,
    "align": "center",
    "margin": 80,
    "line_spacing": 1.15,
    "opacity": 1.0,
}

SUBTITLE_STYLE = {
    "font": "Noto Sans CJK SC",
    "size": 46,
    "color": "#FFFFFF",
    "bold": True,
    "outline": 2.4,
    "outline_color": "#000000",
    "shadow": 0,
    "margin_v": 56,
    "margin_lr": 60,
    "opacity": 1.0,
    "max_chars": 18,
}


def load_job(path: str | Path) -> tuple[dict, Path]:
    job_path = Path(path).expanduser().resolve()
    if not job_path.exists():
        raise VcliError(Codes.MISSING_FILE, f"job 文件不存在: {job_path}")
    try:
        raw = json.loads(job_path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise VcliError(Codes.BAD_INPUT, f"JSON 解析失败: {exc}", details={"line": exc.lineno, "col": exc.colno})
    if not isinstance(raw, dict):
        raise VcliError(Codes.BAD_INPUT, "job.json 顶层必须是对象")
    job = normalize(raw, job_path.parent)
    errors = validate(job)
    if errors:
        raise VcliError(Codes.BAD_INPUT, "job.json 校验未通过", details={"errors": errors})
    return job, job_path


def normalize(raw: dict, base: Path) -> dict:
    job = json.loads(json.dumps(raw))  # 深拷贝，避免修改调用方数据

    job.setdefault("version", 1)
    job["project"] = str(job.get("project") or "video")
    job["video"] = {**DEFAULTS["video"], **(job.get("video") or {})}
    job["audio"] = {**DEFAULTS["audio"], **(job.get("audio") or {})}
    job["scenes"] = job.get("scenes") or []

    if not job.get("output"):
        safe = "".join(c for c in job["project"] if c not in '\\/:*?"<>|').strip() or "video"
        job["output"] = f"out/{safe}.mp4"
    job["output"] = str(_abs(base, job["output"]))

    for i, scene in enumerate(job["scenes"]):
        if not isinstance(scene, dict):
            continue
        scene["_index"] = i
        scene.setdefault("type", _scene_kind(scene))
        scene["duration"] = scene.get("duration")
        scene.setdefault("fit", "cover")
        scene.setdefault("rotate", 0)
        scene.setdefault("speed", 1.0)
        scene.setdefault("reverse", False)
        kb = scene.get("kenburns")
        if isinstance(kb, str):
            kb = {"mode": kb}
        if kb:
            kb = {"mode": "in", "zoom": 1.15, **kb}
        scene["kenburns"] = kb or {"mode": "none", "zoom": 1.0}
        tr = scene.get("transition")
        if isinstance(tr, str):
            tr = {"type": tr}
        if tr:
            tr = {"type": "fade", "duration": 0.6, **tr}
        scene["transition"] = tr or {"type": "none", "duration": 0.0}
        if scene.get("src"):
            scene["src"] = str(_abs(base, scene["src"]))
        audios = scene.get("audios")
        if audios is None and scene.get("audio"):
            audios = scene["audio"] if isinstance(scene["audio"], list) else [scene["audio"]]
        scene["audios"] = []
        for a in audios or []:
            if isinstance(a, str):
                a = {"src": a}
            if not isinstance(a, dict) or not a.get("src"):
                continue
            a = {"start": 0.0, "volume_db": 0.0, "fade_in": 0.0, "fade_out": 0.0, **a}
            a["src"] = str(_abs(base, a["src"]))
            scene["audios"].append(a)
        texts = scene.get("texts") or []
        scene["texts"] = [_text(t, base, scene) for t in texts if isinstance(t, dict) or isinstance(t, str)]

    bgm = job["audio"].get("bgm")
    if isinstance(bgm, str):
        bgm = {"src": bgm}
    if isinstance(bgm, dict) and bgm.get("src"):
        bgm = {"volume_db": -14.0, "fade_in": 1.0, "fade_out": 2.0, "loop": True,
               "ducking": True, "duck_ratio": 8.0, "duck_threshold": 0.03, **bgm}
        bgm["src"] = str(_abs(base, bgm["src"]))
        job["audio"]["bgm"] = bgm
    else:
        job["audio"]["bgm"] = None

    subs = job.get("subtitles")
    if isinstance(subs, str):
        subs = {"src": subs}
    if isinstance(subs, dict):
        subs = {"burn": True, "font_dir": None, "style": {}, **subs}
        subs["style"] = {**SUBTITLE_STYLE, **(subs.get("style") or {})}
        for key in ("src", "ass"):
            if subs.get(key):
                subs[key] = str(_abs(base, subs[key]))
        job["subtitles"] = subs
    else:
        job["subtitles"] = None

    wm = job.get("watermark")
    if isinstance(wm, dict) and wm.get("image"):
        wm = {"position": "top-right", "margin": 24, "width": 160, "opacity": 0.85,
              "start": 0.0, "end": None, **wm}
        wm["image"] = str(_abs(base, wm["image"]))
        job["watermark"] = wm
    else:
        job["watermark"] = None

    tw = job.get("text_watermark")
    if isinstance(tw, str):
        tw = {"content": tw}
    if isinstance(tw, dict) and tw.get("content"):
        tw = {"position": "bottom-right", "size": 28, "color": "#FFFFFF",
              "opacity": 0.55, "margin": 24, **tw}
        job["text_watermark"] = tw
    else:
        job["text_watermark"] = None

    if job.get("font_dir"):
        job["font_dir"] = str(_abs(base, job["font_dir"]))
    if job["subtitles"] and job["subtitles"].get("font_dir"):
        job["font_dir"] = job["subtitles"]["font_dir"]
    return job


def _abs(base: Path, value: str) -> Path:
    p = Path(str(value))
    return p if p.is_absolute() else (base / p).resolve()


def _scene_kind(scene: dict) -> str:
    t = scene.get("type")
    if t:
        return str(t).lower()
    if scene.get("gradient"):
        return "gradient"
    if scene.get("color") and not scene.get("src"):
        return "color"
    src = str(scene.get("src") or "")
    ext = Path(src).suffix.lower()
    if ext in VIDEO_EXT:
        return "video"
    return "image"


def _text(item, base: Path, scene: dict) -> dict:
    if isinstance(item, str):
        item = {"content": item}
    t = {"content": str(item.get("content", "")), "start": 0.0, "end": None,
         "style": "body", "pos": "center", "anim": "fade", "duration": 0.5, **item}
    t["content"] = t["content"].replace("\\n", "\n")
    return t


def validate(job: dict) -> list[str]:
    errs: list[str] = []
    v = job["video"]
    if not v.get("size") and v.get("preset") not in PRESETS:
        errs.append(f"video.preset 不支持: {v.get('preset')}（可选: {', '.join(PRESETS)}）")
    if v.get("size"):
        try:
            w, h = str(v["size"]).lower().split("x")
            int(w), int(h)
        except ValueError:
            errs.append("video.size 必须是 宽x高，例如 1920x1080")
    try:
        if int(v.get("fps", 30)) <= 0:
            errs.append("video.fps 必须大于 0")
    except (TypeError, ValueError):
        errs.append("video.fps 必须是数字")
    for key in ("crf",):
        try:
            int(v.get(key, 20))
        except (TypeError, ValueError):
            errs.append(f"video.{key} 必须是整数")

    scenes = job["scenes"]
    if not scenes:
        errs.append("scenes 至少需要 1 个场景")

    for i, scene in enumerate(scenes):
        at = f"scenes[{i}]"
        kind = scene.get("type")
        if kind not in ("image", "video", "color", "gradient"):
            errs.append(f"{at}.type 不支持: {kind}")
            continue
        if kind in ("image", "video"):
            src = scene.get("src")
            if not src:
                errs.append(f"{at}.src 必填")
            elif not Path(src).exists():
                errs.append(f"{at}.src 不存在: {src}")
        if kind in ("image", "color", "gradient"):
            d = scene.get("duration")
            if not isinstance(d, (int, float)) or d <= 0:
                errs.append(f"{at}.duration 必填且大于 0")
        if kind == "gradient" and not scene.get("gradient"):
            errs.append(f"{at}.gradient 必填（如 {{\"from\":\"#000\",\"to\":\"#333\",\"angle\":90}}）")
        if scene.get("fit") not in FIT_MODES:
            errs.append(f"{at}.fit 不支持: {scene.get('fit')}")
        kb = scene.get("kenburns") or {}
        if kb.get("mode") not in KENBURNS_MODES:
            errs.append(f"{at}.kenburns.mode 不支持: {kb.get('mode')}")
        try:
            if float(kb.get("zoom", 1.15)) < 1.0:
                errs.append(f"{at}.kenburns.zoom 必须 >= 1.0")
        except (TypeError, ValueError):
            errs.append(f"{at}.kenburns.zoom 必须是数字")
        tr = scene.get("transition") or {}
        if i > 0 and tr.get("type") not in TRANSITIONS + ["none"]:
            errs.append(f"{at}.transition.type 不支持: {tr.get('type')}")
        try:
            if float(tr.get("duration", 0)) < 0:
                errs.append(f"{at}.transition.duration 不能为负")
        except (TypeError, ValueError):
            errs.append(f"{at}.transition.duration 必须是数字")
        try:
            if float(scene.get("speed", 1.0)) <= 0:
                errs.append(f"{at}.speed 必须大于 0")
        except (TypeError, ValueError):
            errs.append(f"{at}.speed 必须是数字")
        if scene.get("rotate") not in (0, 90, 180, 270):
            errs.append(f"{at}.rotate 仅支持 0/90/180/270")
        for j, t in enumerate(scene.get("texts") or []):
            if t.get("anim") not in ANIMS:
                errs.append(f"{at}.texts[{j}].anim 不支持: {t.get('anim')}")
            if not t.get("content"):
                errs.append(f"{at}.texts[{j}].content 不能为空")
        for j, a in enumerate(scene.get("audios") or []):
            if not Path(a["src"]).exists():
                errs.append(f"{at}.audios[{j}].src 不存在: {a['src']}")

    audio = job["audio"]
    bgm = audio.get("bgm")
    if bgm and not Path(bgm["src"]).exists():
        errs.append(f"audio.bgm.src 不存在: {bgm['src']}")

    subs = job.get("subtitles")
    if subs:
        if not subs.get("src") and not subs.get("ass"):
            errs.append("subtitles 需要 src（srt）或 ass")
        for key in ("src", "ass"):
            if subs.get(key) and not Path(subs[key]).exists():
                errs.append(f"subtitles.{key} 不存在: {subs[key]}")

    wm = job.get("watermark")
    if wm and not Path(wm["image"]).exists():
        errs.append(f"watermark.image 不存在: {wm['image']}")
    if job.get("font_dir") and not Path(job["font_dir"]).exists():
        errs.append(f"font_dir 不存在: {job['font_dir']}")
    return errs
