"""渲染核心：场景切片 -> 拼接（转场）-> 混音/字幕/水印 -> 成片。"""

from __future__ import annotations

import json
import math
import os
import shutil
import threading
from pathlib import Path

from . import ass
from .errors import Codes, VcliError
from .presets import resolve_size
from .util import (emit, ensure_parent, filter_path, log, probe, run_ffmpeg)

IMAGE_KINDS = ("image", "color", "gradient")

# ffmpeg filter_complex 参数值中必须转义的特殊字符
_FILTER_ESCAPE = ("\\", ":", ",", ";", "=", "'", '"', "(", ")", "[", "]", "#", " ")


def _escape_ff_val(s: str) -> str:
    """把 ffmpeg filter_complex 参数值里的特殊字符加上反斜杠转义。"""
    for ch in _FILTER_ESCAPE:
        s = s.replace(ch, f"\\{ch}")
    return s


def _clip(src: Path) -> str:
    return f"'{src.as_posix()}'"


def plan(job: dict) -> dict:
    """计算每个场景的成片时长、起点与转场，校验转场是否过长。"""
    fps = int(job["video"].get("fps") or 30)
    scenes = job["scenes"]
    durations: list[float] = []
    for i, scene in enumerate(scenes):
        kind = scene["type"]
        if kind in ("video",):
            info = probe(scene["src"])
            offset = float(scene.get("start_time") or 0)
            src_dur = max(0.05, info["duration"] - offset)
            speed = max(0.01, float(scene.get("speed") or 1.0))
            if scene.get("duration"):
                out = float(scene["duration"])
                need = min(src_dur, out * speed)
                out = need / speed
            else:
                need = src_dur
                out = need / speed
            scene["_src_need"] = need
            scene["_offset"] = offset
            durations.append(max(0.2, out))
        else:
            durations.append(max(0.2, float(scene.get("duration") or 0)))

    trans = [0.0] * len(scenes)
    for i in range(1, len(scenes)):
        tr = scenes[i].get("transition") or {}
        if tr.get("type") in (None, "none"):
            continue
        t = float(tr.get("duration") or 0)
        limit = min(durations[i - 1], durations[i]) * 0.8
        trans[i] = max(0.0, min(t, limit))
        if trans[i] < t:
            log(f"警告: scenes[{i}].transition 过长，已缩短为 {trans[i]:.2f}s")

    starts = [0.0]
    total = durations[0]
    for i in range(1, len(scenes)):
        starts.append(total - trans[i])
        total += durations[i] - trans[i]
    for i, scene in enumerate(scenes):
        scene["_dur"] = durations[i]
    if total <= 0.1:
        raise VcliError(Codes.BAD_INPUT, "成片总时长过短")
    return {"durations": durations, "trans": trans, "starts": starts,
            "total": total, "fps": fps}


def render(job: dict, *, out: str | None = None, workdir: str | None = None,
           json_mode: bool = False, dry_run: bool = False, keep_work: bool = False,
           resume: bool = False) -> dict:
    width, height = resolve_size(job["video"])
    fps = int(job["video"].get("fps") or 30)
    out_path = Path(out).expanduser().resolve() if out else Path(job["output"])
    if not out_path.is_absolute():
        out_path = (Path.cwd() / out_path).resolve()
    plan_data = plan(job)
    total = plan_data["total"]
    scenes = job["scenes"]

    wd = Path(workdir).expanduser().resolve() if workdir else out_path.parent / f".{out_path.stem}.work"
    wd.mkdir(parents=True, exist_ok=True)
    ensure_parent(out_path)

    commands: list[dict] = []
    style = job.get("video", {})
    crf = int(style.get("crf") or 20)
    encoder = style.get("encoder") or "libx264"
    encode_preset = style.get("encode_preset") or "medium"
    pix_fmt = style.get("pix_fmt") or "yuv420p"

    # ---------- 1. 场景切片 ----------
    clip_files: list[Path] = []
    # 并行度：CPU 核数的 1/4，上限 8（避免资源挤爆）
    workers = max(1, min(8, (os.cpu_count() or 4) // 4))

    # —— 崩溃恢复 timeline ——
    timeline_path = wd / "timeline.json"
    timeline_lock = threading.Lock()
    timeline: dict[str, list[int]] = {"scene_done": []}
    if resume and timeline_path.exists():
        try:
            timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
            log(f"resume: timeline loaded, {len(timeline.get('scene_done', []))} scenes done")
        except (json.JSONDecodeError, OSError):
            timeline = {"scene_done": []}
            log("resume: timeline.json 损坏，从头开始")
    else:
        timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    def _mark_done(i: int) -> None:
        """线程安全地写 timeline.json。"""
        with timeline_lock:
            timeline.setdefault("scene_done", [])
            if i not in timeline["scene_done"]:
                timeline["scene_done"].append(i)
                timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    def _slice(i: int, scene: dict, dur: float) -> tuple[int, Path, float]:
        clip = wd / f"s{i:03d}.mp4"
        args = _scene_args(scene, clip, width, height, fps, dur, job)
        run_ffmpeg(args, cwd=wd, total=dur, phase=f"scene[{i}]/{len(scenes)}", json_mode=json_mode)
        emit({"event": "scene_done", "index": i, "file": clip.name, "duration": round(dur, 3)})
        _mark_done(i)
        return i, clip, dur

    done_set = set(timeline.get("scene_done", []))

    if dry_run or workers <= 1 or len(scenes) <= 3:
        # 串行
        for i, scene in enumerate(scenes):
            dur = plan_data["durations"][i]
            clip = wd / f"s{i:03d}.mp4"
            clip_files.append(clip)
            args = _scene_args(scene, clip, width, height, fps, dur, job)
            commands.append({"phase": f"scene[{i}]", "cwd": str(wd),
                             "cmd": ["ffmpeg", "-y", *args]})
            if dry_run or i in done_set:
                continue
            run_ffmpeg(args, cwd=wd, total=dur, phase=f"scene[{i}]/{len(scenes)}", json_mode=json_mode)
            emit({"event": "scene_done", "index": i, "file": clip.name, "duration": round(dur, 3)})
            _mark_done(i)
    else:
        # 并行渲染场景切片
        from concurrent.futures import ThreadPoolExecutor, as_completed
        tasks = [(i, scenes[i], plan_data["durations"][i]) for i in range(len(scenes))
                 if i not in done_set]
        for i, scene in enumerate(scenes):
            clip_files.append(wd / f"s{i:03d}.mp4")
            args = _scene_args(scene, wd / f"s{i:03d}.mp4", width, height, fps, plan_data["durations"][i], job)
            commands.append({"phase": f"scene[{i}]", "cwd": str(wd),
                             "cmd": ["ffmpeg", "-y", *args]})
        if tasks:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                futures = [ex.submit(_slice, i, scenes[i], plan_data["durations"][i])
                           for i, scenes_i, dur_i in tasks]
                for fut in as_completed(futures):
                    fut.result()

    if dry_run:
        if len(scenes) > 1:
            if all(t <= 0 for t in plan_data["trans"][1:]):
                commands.append({"phase": "concat", "cwd": str(wd),
                                 "cmd": ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                                         "-i", "concat.txt", "-c", "copy", "vbase.mp4"]})
            else:
                types = [(s.get("transition") or {}).get("type") or "fade" for s in scenes]
                group_cmds, _ = _build_group_cmds(clip_files, plan_data, types, wd, fps, scenes)
                commands.extend({"phase": c["phase"], "cwd": str(wd), "cmd": c["cmd"]}
                                for c in group_cmds)
        has_overlay = bool(job.get("subtitles") or job.get("text_watermark"))
        ass_file = wd / "overlay.ass"
        final_args, _ = _final_args(job, plan_data, wd / "vbase.mp4",
                                    ass_file if has_overlay else None, job.get("watermark"),
                                    out_path, width, height, total, encoder, crf,
                                    encode_preset, pix_fmt)
        commands.append({"phase": "mux", "cwd": str(wd), "cmd": ["ffmpeg", "-y", *final_args]})
        return {"ok": True, "dry_run": True, "output": str(out_path),
                "width": width, "height": height, "fps": fps,
                "duration": round(total, 3), "workdir": str(wd),
                "timeline": [{"index": i, "start": round(plan_data["starts"][i], 3),
                              "duration": round(plan_data["durations"][i], 3),
                              "transition": round(plan_data["trans"][i], 3)}
                             for i in range(len(scenes))],
                "commands": commands}

    # ---------- 2. 视频拼接 ----------
    vbase = wd / "vbase.mp4"
    if len(scenes) == 1:
        shutil.copyfile(clip_files[0], vbase)
    elif all(t <= 0 for t in plan_data["trans"][1:]):
        _concat_copy(clip_files, vbase, wd, fps, json_mode)
    else:
        types = [(s.get("transition") or {}).get("type") or "fade" for s in scenes]
        cmds, files = _build_group_cmds(clip_files, plan_data, types, wd, fps, scenes)
        for c in cmds:
            run_ffmpeg(c["args"], cwd=wd, total=c.get("total"), phase=c["phase"],
                       json_mode=json_mode)
        if len(files) == 1:
            os.replace(files[0], vbase)
        else:
            _concat_filter(files, vbase, wd, fps, json_mode)

    # ---------- 3. 字幕 / 水印 ----------
    ass_file = wd / "overlay.ass"
    has_overlay = _build_overlay(job, ass_file, width, height, total)
    wm = job.get("watermark")

    # ---------- 4. 音频 + 最终编码 ----------
    final_args, audio_desc = _final_args(job, plan_data, vbase, ass_file if has_overlay else None,
                                         wm, out_path, width, height, total,
                                         encoder, crf, encode_preset, pix_fmt)
    commands.append({"phase": "mux", "cwd": str(wd), "cmd": ["ffmpeg", "-y", *final_args]})
    run_ffmpeg(final_args, cwd=wd, total=total, phase="mux", json_mode=json_mode)

    info = probe(out_path)
    result = {
        "ok": True,
        "output": str(out_path),
        "size": info.get("size", 0),
        "duration": info.get("duration", round(total, 3)),
        "width": info.get("video", {}).get("width", width) if info.get("video") else width,
        "height": info.get("video", {}).get("height", height) if info.get("video") else height,
        "fps": info.get("video", {}).get("fps", fps) if info.get("video") else fps,
        "has_audio": info.get("has_audio", False),
        "scenes": len(scenes),
        "audio": audio_desc,
        "workdir": str(wd) if keep_work else None,
    }
    if not keep_work:
        shutil.rmtree(wd, ignore_errors=True)
    return result


# --------------------------------------------------------------------------
# 场景切片
# --------------------------------------------------------------------------

def _scene_args(scene: dict, clip: Path, w: int, h: int, fps: int, dur: float,
                job: dict) -> list[str]:
    frames = max(1, int(round(dur * fps)))
    kind = scene["type"]
    text_file = None
    if scene.get("texts"):
        text_file = clip.with_suffix(".ass")
        ass.scene_text_ass(text_file, {**scene, "duration": dur}, w, h,
                           job.get("text_style") or {})

    sub_chain = ""
    if text_file is not None:
        fonts = f":fontsdir='{filter_path(job['font_dir'])}'" if job.get("font_dir") else ""
        sub_chain = f",subtitles=filename='{text_file.name}'{fonts}"

    if kind == "image":
        args = ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(scene["src"]),
                "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                "-pix_fmt", "yuv420p", "-r", str(fps)]
        chain = _image_chain(scene, w, h, fps, frames, dur,
                             sub_chain if scene.get("fit") == "blur" else "")
        if scene.get("fit") == "blur":
            args += ["-filter_complex", chain, "-map", "[vout]"]
        else:
            args += ["-vf", chain + sub_chain]
        args += ["-frames:v", str(frames), str(clip)]
        return args

    if kind in ("color", "gradient"):
        src = _lavfi_source(scene, w, h, fps, dur)
        args = ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", src, "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                "-pix_fmt", "yuv420p", "-r", str(fps)]
        vf = f"format=yuv420p,setsar=1,scale={w}:{h},fps={fps}{sub_chain}"
        args += ["-vf", vf, "-frames:v", str(frames), str(clip)]
        return args

    # video
    need = float(scene.get("_src_need") or dur)
    offset = float(scene.get("_offset") or 0)
    speed = max(0.01, float(scene.get("speed") or 1.0))
    prep = [f"fps={fps}", f"trim=0:{need:.3f}", f"setpts=(PTS-STARTPTS)/{speed:.6f}"]
    rot = int(scene.get("rotate") or 0)
    if rot == 90:
        prep.append("transpose=1")
    elif rot == 270:
        prep.append("transpose=2")
    elif rot == 180:
        prep.append("hflip,vflip")
    if scene.get("reverse"):
        prep.append("reverse")
    prep_str = ",".join(prep)

    args = []
    if offset > 0:
        args += ["-ss", f"{offset:.3f}"]
    args += ["-i", str(scene["src"]), "-an", "-t", f"{dur:.3f}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
             "-pix_fmt", "yuv420p", "-r", str(fps)]

    if scene.get("fit") == "blur":
        graph = (f"[0:v]{prep_str},format=yuv420p[prep];"
                 f"[prep]split=2[pb][pf];"
                 f"[pb]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                 f"gblur=sigma=32[bg];"
                 f"[pf]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];"
                 f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps},format=yuv420p"
                 f"{sub_chain}[vout]")
        args += ["-filter_complex", graph, "-map", "[vout]"]
    else:
        chain = ",".join([x for x in (prep_str, _fit_chain(scene.get("fit"), w, h, fps),
                                      sub_chain.strip(",")) if x])
        args += ["-vf", chain]
    args += ["-frames:v", str(frames), str(clip)]
    return args


def _fit_chain(fit: str | None, w: int, h: int, fps: int) -> str:
    if fit == "contain":
        return (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p")
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={w}:{h},setsar=1,fps={fps},format=yuv420p")


def _image_chain(scene: dict, w: int, h: int, fps: int, frames: int, dur: float,
                 tail: str = "") -> str:
    fit = scene.get("fit") or "cover"
    if fit == "blur":
        prep = (f"[0:v]fps={fps},format=yuv420p[prep];"
                f"[prep]split=2[pb][pf];"
                f"[pb]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                f"gblur=sigma=32[bg];"
                f"[pf]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];")
        return prep + (f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps},"
                       f"format=yuv420p{tail}[vout]")
    if fit == "contain":
        return _fit_chain("contain", w, h, fps)

    kb = scene.get("kenburns") or {}
    mode = kb.get("mode") or "none"
    zoom = max(1.0, float(kb.get("zoom") or 1.15))
    if mode == "none":
        return _fit_chain("cover", w, h, fps)

    big_w, big_h = w * 2, h * 2
    base = (f"scale={big_w}:{big_h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={big_w}:{big_h},setsar=1")
    step = (zoom - 1.0) / max(1, frames)
    center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if mode == "in":
        z = f"min(1+{step:.7f}*on,{zoom:.4f})"
        pos = center
    elif mode == "out":
        z = f"max({zoom:.4f}-{step:.7f}*on,1.0)"
        pos = center
    elif mode == "left":
        z = f"{zoom:.4f}"
        pos = f"x='(iw-iw/zoom)*(1-on/{frames})':y='ih/2-(ih/zoom/2)'"
    elif mode == "right":
        z = f"{zoom:.4f}"
        pos = f"x='(iw-iw/zoom)*on/{frames}':y='ih/2-(ih/zoom/2)'"
    elif mode == "up":
        z = f"{zoom:.4f}"
        pos = f"x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/{frames})'"
    else:  # down
        z = f"{zoom:.4f}"
        pos = f"x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/{frames}'"
    return (f"{base},zoompan=z='{z}':{pos}:d={frames}:s={w}x{h}:fps={fps},"
            f"setsar=1,fps={fps},format=yuv420p")


def _lavfi_source(scene: dict, w: int, h: int, fps: int, dur: float) -> str:
    kind = scene["type"]
    if kind == "color":
        color = str(scene.get("color") or "#000000").lstrip("#")
        if len(color) == 3:
            color = "".join(c * 2 for c in color)
        src = f"color=c=0x{color}:s={w}x{h}:r={fps}:d={dur:.3f}"
        if scene.get("gradient"):
            pass
        return src
    grad = scene.get("gradient") or {}
    frm = str(grad.get("from") or "#000000").lstrip("#")
    to = str(grad.get("to") or "#333333").lstrip("#")
    return (f"gradients=s={w}x{h}:r={fps}:d={dur:.3f}:c0=0x{frm}:c1=0x{to}"
            f":x0=0:y0=0:x1={w}:y1={h}")


# --------------------------------------------------------------------------
# 拼接
# --------------------------------------------------------------------------

def _concat_copy(clips: list[Path], dst: Path, wd: Path, fps: int, json_mode: bool) -> None:
    lst = wd / "concat.txt"
    lst.write_text("".join(f"file '{c.name}'\n" for c in clips), encoding="utf-8")
    args = ["-f", "concat", "-safe", "0", "-i", lst.name, "-c", "copy",
            "-fflags", "+genpts", "-avoid_negative_ts", "make_zero", dst.name]
    try:
        run_ffmpeg(args, cwd=wd, total=0, phase="concat", json_mode=json_mode, quiet=True)
    except VcliError:
        _concat_filter(clips, dst, wd, fps, json_mode)


def _concat_filter(clips: list[Path], dst: Path, wd: Path, fps: int,
                   json_mode: bool) -> None:
    inputs: list[str] = []
    graph: list[str] = []
    for i, c in enumerate(clips):
        inputs += ["-i", c.name]
        graph.append(f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v{i}]")
    labels = "".join(f"[v{i}]" for i in range(len(clips)))
    graph.append(f"{labels}concat=n={len(clips)}:v=1:a=0[vout]")
    args = [*inputs, "-filter_complex", ";".join(graph), "-map", "[vout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
            "-pix_fmt", "yuv420p", "-r", str(fps), dst.name]
    run_ffmpeg(args, cwd=wd, phase="concat", json_mode=json_mode)


def _build_group_cmds(clips: list[Path], plan_data: dict, types: list[str],
                      wd: Path, fps: int, scenes: list[dict] | None = None) -> tuple[list[dict], list[Path]]:
    """有转场的相邻场景用 xfade 成组，硬切处分组，最后 concat，保证时长精确。"""
    durations = plan_data["durations"]
    trans = plan_data["trans"]
    groups: list[list[int]] = [[0]]
    for i in range(1, len(clips)):
        if trans[i] > 0:
            groups[-1].append(i)
        else:
            groups.append([i])

    cmds: list[dict] = []
    files: list[Path] = []
    for gi, group in enumerate(groups):
        if len(group) == 1:
            files.append(clips[group[0]])
            continue
        local_starts = [0.0]
        cur = durations[group[0]]
        for k in range(1, len(group)):
            idx = group[k]
            local_starts.append(cur - trans[idx])
            cur += durations[idx] - trans[idx]
        inputs: list[str] = []
        graph: list[str] = []
        for k, idx in enumerate(group):
            inputs += ["-i", clips[idx].name]
            graph.append(f"[{k}:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v{k}]")
        label = "v0"
        for k in range(1, len(group)):
            idx = group[k]
            out = f"x{k}"
            kind = types[idx] if types[idx] not in ("none", None) else "fade"
            tr_obj = (scenes[idx].get("transition")
                      if scenes and idx < len(scenes) else None)
            expr = (tr_obj or {}).get("expr") if isinstance(tr_obj, dict) else None
            xfade_param = f"transition={kind}:duration={trans[idx]:.3f}:offset={local_starts[k]:.3f}"
            if expr:
                xfade_param += f":expr={_escape_ff_val(expr)}"
            graph.append(f"[{label}][v{k}]xfade={xfade_param}[{out}]")
            label = out
        out_file = wd / f"g{gi:02d}.mp4"
        args = [*inputs, "-filter_complex", ";".join(graph), "-map", f"[{label}]",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                "-pix_fmt", "yuv420p", "-r", str(fps), out_file.name]
        cmds.append({"phase": f"transitions[{gi}]", "args": args, "total": cur,
                     "cmd": ["ffmpeg", "-y", *args]})
        files.append(out_file)

    if len(files) > 1:
        inputs = []
        graph = []
        for i, f in enumerate(files):
            inputs += ["-i", f.name]
            graph.append(f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v{i}]")
        labels = "".join(f"[v{i}]" for i in range(len(files)))
        graph.append(f"{labels}concat=n={len(files)}:v=1:a=0[vj]")
        args = [*inputs, "-filter_complex", ";".join(graph), "-map", "[vj]",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                "-pix_fmt", "yuv420p", "-r", str(fps), "vbase.mp4"]
        cmds.append({"phase": "join", "args": args, "total": plan_data["total"],
                     "cmd": ["ffmpeg", "-y", *args]})
    return cmds, files


def _build_overlay(job: dict, path: Path, w: int, h: int, total: float) -> bool:
    subs = job.get("subtitles")
    srt_text = None
    if subs and subs.get("src"):
        srt_text = ass.read_text(subs["src"])
    if subs and subs.get("ass"):
        # 直接使用已有 ASS 时，把它当字幕源复制，再追加文字水印
        existing = ass.read_text(subs["ass"])
        srt_text = _ass_to_cues(existing)
    text_wm = job.get("text_watermark")
    if not srt_text and not text_wm:
        return False
    style = (subs or {}).get("style") or {}
    ass.overlay_ass(path, w, h, total, srt_text=srt_text, subtitle_style=style, text_wm=text_wm)
    return True


def _ass_to_cues(text: str) -> str:
    """把已有 ASS 的 Dialogue 转成简化 SRT，便于重新排版。"""
    rows = []
    for i, line in enumerate(text.splitlines()):
        if not line.startswith("Dialogue:"):
            continue
        parts = line.split(",", 9)
        if len(parts) < 10:
            continue
        start, end, body = parts[1].strip(), parts[2].strip(), parts[9]
        body = body[body.rfind("}") + 1:] if "}" in body else body
        body = body.replace("\\N", "\n").replace("\\n", "\n")
        rows.append(f"{i + 1}\n{start.replace('.', ',')} --> {end.replace('.', ',')}\n{body}\n")
    return "\n".join(rows)


def _final_args(job: dict, plan_data: dict, vbase: Path, ass_file: Path | None,
                wm: dict | None, out_path: Path, w: int, h: int, total: float,
                encoder: str, crf: int, encode_preset: str, pix_fmt: str) -> tuple[list[str], dict]:
    inputs = ["-i", vbase.name]
    filters: list[str] = []
    idx = 1
    total = plan_data["total"]

    # —— 提前解析输出格式，决定是否支持音频链 ——
    _suffix = out_path.suffix.lower()
    _fmt = OUTPUT_FORMATS.get(_suffix, OUTPUT_FORMATS[".mp4"])
    _supports_audio = bool(_fmt.get("audio_encoder"))

    # 视频：字幕
    vlabel = "0:v"
    if ass_file is not None:
        fonts = f":fontsdir='{filter_path(job['font_dir'])}'" if job.get("font_dir") else ""
        filters.append(f"[0:v]subtitles=filename='{ass_file.name}'{fonts}[vsub]")
        vlabel = "vsub"

    # 视频：图片水印
    if wm:
        inputs += ["-i", str(wm["image"])]
        wm_idx = idx
        idx += 1
        pos = str(wm.get("position") or "top-right")
        m = int(wm.get("margin") or 24)
        wm_w = int(wm.get("width") or 160)
        xy = {
            "top-left": f"{m}:{m}",
            "top-right": f"W-w-{m}:{m}",
            "bottom-left": f"{m}:H-h-{m}",
            "bottom-right": f"W-w-{m}:H-h-{m}",
            "center": "(W-w)/2:(H-h)/2",
        }.get(pos, f"W-w-{m}:{m}")
        enable = ""
        start = float(wm.get("start") or 0)
        end = wm.get("end")
        if start > 0 or end is not None:
            e = total if end is None else min(total, float(end))
            enable = f":enable='between(t,{start:.3f},{e:.3f})'"
        filters.append(f"[{wm_idx}:v]scale={wm_w}:-2,format=rgba,"
                       f"colorchannelmixer=aa={float(wm.get('opacity', 0.85)):.3f}[wm]")
        filters.append(f"[{vlabel}][wm]overlay={xy}{enable}[vout]")
        vlabel = "vout"

    # 音频
    audio_filters: list[str] = []
    voice_labels: list[str] = []
    has_audio = False
    for i, scene in enumerate(job["scenes"]):
        if not _supports_audio:
            continue
        dur = plan_data["durations"][i]
        base_start = plan_data["starts"][i]
        for a in scene.get("audios") or []:
            inputs += ["-i", str(a["src"])]
            aidx = idx
            idx += 1
            has_audio = True
            vol = float(a.get("volume_db") or 0)
            fade_in = float(a.get("fade_in") or 0)
            fade_out = float(a.get("fade_out") or 0)
            start = max(0.0, base_start + float(a.get("start") or 0))
            chain = [f"atrim=0:{dur:.3f}", "asetpts=PTS-STARTPTS", "aresample=48000",
                     "aformat=sample_fmts=fltp:channel_layouts=stereo"]
            if abs(vol) > 0.01:
                chain.append(f"volume={vol:.2f}dB")
            if fade_in > 0:
                chain.append(f"afade=t=in:st=0:d={fade_in:.3f}")
            if fade_out > 0:
                chain.append(f"afade=t=out:st={max(0.0, dur - fade_out):.3f}:d={fade_out:.3f}")
            chain.append(f"adelay={int(round(start * 1000))}|{int(round(start * 1000))}")
            label = f"sa{i}_{len(voice_labels)}"
            audio_filters.append(f"[{aidx}:a]{','.join(chain)}[{label}]")
            voice_labels.append(label)

    bgm = job["audio"].get("bgm")
    bgm_label = None
    if _supports_audio and bgm:
        if bgm.get("loop", True):
            inputs += ["-stream_loop", "-1"]
        inputs += ["-i", str(bgm["src"])]
        bidx = idx
        idx += 1
        has_audio = True
        vol = float(bgm.get("volume_db") or 0)
        chain = [f"atrim=0:{total:.3f}", "asetpts=PTS-STARTPTS", "aresample=48000",
                 "aformat=sample_fmts=fltp:channel_layouts=stereo"]
        if abs(vol) > 0.01:
            chain.append(f"volume={vol:.2f}dB")
        if float(bgm.get("fade_in") or 0) > 0:
            chain.append(f"afade=t=in:st=0:d={float(bgm['fade_in']):.3f}")
        if float(bgm.get("fade_out") or 0) > 0:
            chain.append(f"afade=t=out:st={max(0.0, total - float(bgm['fade_out'])):.3f}:"
                         f"d={float(bgm['fade_out']):.3f}")
        bgm_label = "bgm"
        audio_filters.append(f"[{bidx}:a]{','.join(chain)}[{bgm_label}]")

    amix_label = None
    AMIX_BATCH = 10
    if voice_labels:
        if len(voice_labels) == 1:
            voice_label = voice_labels[0]
        elif len(voice_labels) <= AMIX_BATCH:
            labels = "".join(f"[{x}]" for x in voice_labels)
            audio_filters.append(f"{labels}amix=inputs={len(voice_labels)}:duration=longest:normalize=0[voice]")
            voice_label = "voice"
        else:
            mid_labels: list[str] = []
            for i in range(0, len(voice_labels), AMIX_BATCH):
                batch = voice_labels[i:i + AMIX_BATCH]
                bl = "".join(f"[{x}]" for x in batch)
                out = f"vb_{i // AMIX_BATCH}"
                audio_filters.append(f"{bl}amix=inputs={len(batch)}:duration=longest:normalize=0[{out}]")
                mid_labels.append(out)
            ml = "".join(f"[{x}]" for x in mid_labels)
            audio_filters.append(f"{ml}amix=inputs={len(mid_labels)}:duration=longest:normalize=0[voice]")
            voice_label = "voice"
        if bgm_label:
            duck = bgm.get("ducking", True)
            if duck:
                th = float(bgm.get("duck_threshold") or 0.03)
                ratio = float(bgm.get("duck_ratio") or 8)
                audio_filters.append(f"[{voice_label}]asplit=2[vsc][vmix]")
                audio_filters.append(f"[{bgm_label}][vsc]sidechaincompress=threshold={th}:"
                                     f"ratio={ratio}:attack=20:release=400[bgmduck]")
                audio_filters.append(f"[bgmduck][vmix]amix=inputs=2:duration=first:"
                                     f"normalize=0[mix]")
            else:
                audio_filters.append(f"[{bgm_label}][{voice_label}]amix=inputs=2:duration=first:"
                                     f"normalize=0[mix]")
            amix_label = "mix"
        else:
            amix_label = voice_label
    elif bgm_label:
        amix_label = bgm_label
    elif _supports_audio and job["audio"].get("silent_track", True):
        inputs += ["-f", "lavfi", "-t", f"{total:.3f}", "-i",
                   "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_filters.append(f"[{idx}:a]anull[aout]")
        amix_label = "aout"
        idx += 1
        has_audio = True

    if amix_label:
        if job["audio"].get("normalize"):
            loud = float(job["audio"].get("loudness") or -16)
            audio_filters.append(f"[{amix_label}]loudnorm=I={loud}:TP=-1.5:LRA=11,"
                                 f"aformat=sample_fmts=fltp:sample_rates=48000:"
                                 f"channel_layouts=stereo[aout]")
            amix_label = "aout"

    graph = ";".join(filters + audio_filters)
    args: list[str] = [*inputs]
    if graph:
        args += ["-filter_complex", graph]
    args += ["-map", "0:v" if vlabel == "0:v" else f"[{vlabel}]"]
    if has_audio and amix_label:
        args += ["-map", f"[{amix_label}]"]

    # —— 按输出后缀自动选择编码器/容器 ——
    args += ["-c:v", _fmt["video_encoder"]]
    if _fmt.get("video_extra"):
        args += _fmt["video_extra"](encoder, crf, encode_preset)
    if _fmt.get("pix_fmt"):
        args += ["-pix_fmt", _fmt["pix_fmt"]]
    if _fmt.get("video_flags") is not None:
        args += _fmt["video_flags"]
    else:
        args += ["-movflags", "+faststart"]
    if has_audio and amix_label and _supports_audio:
        args += ["-c:a", _fmt["audio_encoder"]]
        if _fmt.get("audio_bitrate"):
            args += ["-b:a", str(_fmt["audio_bitrate"])]
    if _fmt.get("loop") is not None:
        args += ["-loop", str(_fmt["loop"])]
    args += ["-t", f"{total:.3f}", str(out_path)]

    desc = {"bgm": bool(bgm), "scene_audio": len(voice_labels),
            "ducking": bool(bgm and bgm.get("ducking", True) and voice_labels),
            "normalized": bool(job["audio"].get("normalize")),
            "format": _suffix.lstrip(".")}
    return args, desc


# 输出格式配置：后缀 → {video_encoder, pix_fmt, audio_encoder, audio_bitrate, video_extra, loop, video_flags}
def _video_extra_264(enc: str, crf: int, preset: str) -> list[str]:
    return ["-preset", preset, "-crf", str(crf)]


OUTPUT_FORMATS = {
    ".mp4": {"video_encoder": "libx264", "pix_fmt": "yuv420p",
             "audio_encoder": "aac", "audio_bitrate": 192000,
             "video_extra": _video_extra_264},
    ".mkv": {"video_encoder": "libx264", "pix_fmt": "yuv420p",
             "audio_encoder": "aac", "audio_bitrate": 192000,
             "video_extra": _video_extra_264},
    ".mov": {"video_encoder": "libx264", "pix_fmt": "yuv420p",
             "audio_encoder": "aac", "audio_bitrate": 192000,
             "video_extra": _video_extra_264},
    ".webm": {"video_encoder": "libvpx-vp9", "pix_fmt": "yuv420p",
              "audio_encoder": "libopus", "audio_bitrate": 128000,
              "video_extra": lambda e, c, p: ["-b:v", "3M", "-deadline", "good"],
              "video_flags": []},
    ".gif": {"video_encoder": "gif", "pix_fmt": None,
             "audio_encoder": None, "loop": 0, "video_flags": []},
    ".webp": {"video_encoder": "libwebp", "pix_fmt": None,
              "audio_encoder": None, "loop": 0, "video_flags": []},
    ".apng": {"video_encoder": "apng", "pix_fmt": "rgba",
              "audio_encoder": None, "loop": 0, "video_flags": []},
}
