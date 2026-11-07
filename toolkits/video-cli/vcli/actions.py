"""非渲染类子命令：探测、抽帧、封面、GIF、下载、诊断、示例。"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from . import ass, llm, spec
from .errors import Codes, VcliError
from .util import (ffmpeg_bin, font_families, probe, run_cmd, run_ffmpeg)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".avif"}


def probe_file(path: str) -> dict:
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise VcliError(Codes.MISSING_FILE, f"文件不存在: {p}")
    info = probe(p)
    info["ok"] = True
    return info


def frames(path: str, at: list[float], outdir: str) -> dict:
    src = Path(path).expanduser().resolve()
    if not src.exists():
        raise VcliError(Codes.MISSING_FILE, f"文件不存在: {src}")
    out = Path(outdir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for i, t in enumerate(at):
        dst = out / f"frame_{i:03d}_{t:.2f}s.png"
        args = ["-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-update", "1", str(dst)]
        run_ffmpeg(args, phase="frames")
        files.append(str(dst))
    return {"ok": True, "frames": files, "count": len(files), "outdir": str(out)}


def cover(src: str, out: str | None, at: float = 0.0, width: int | None = None,
          title: str | None = None, subtitle: str | None = None,
          style: dict | None = None, font_dir: str | None = None,
          dim: float = 0.25) -> dict:
    source = Path(src).expanduser().resolve()
    if not source.exists():
        raise VcliError(Codes.MISSING_FILE, f"文件不存在: {source}")
    dst = Path(out).expanduser().resolve() if out else source.with_name(source.stem + "_cover.png")
    dst.parent.mkdir(parents=True, exist_ok=True)

    tmpdir = Path(tempfile.mkdtemp(prefix="vcli-cover-"))
    try:
        if source.suffix.lower() in IMAGE_EXT:
            frame = source
        else:
            frame = tmpdir / "frame.png"
            run_ffmpeg(["-ss", f"{at:.3f}", "-i", str(source), "-frames:v", "1",
                        "-update", "1", str(frame)], phase="cover")
        info = probe(frame)
        w = width or (info.get("video", {}) or {}).get("width") or 1280
        h = int(round(w * (info.get("video", {}).get("height") or 720) /
                      max(1, (info.get("video", {}).get("width") or 1280))))
        if width:
            h = int(round((info["video"]["height"] / info["video"]["width"]) * width))

        has_text = bool(title or subtitle)
        args = ["-i", str(frame), "-frames:v", "1", "-update", "1"]
        vf = [f"scale={w}:{h}" if width else None]
        if has_text and dim > 0:
            vf.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{max(0.0, min(0.9, dim)):.2f}:t=fill")
        if has_text:
            st = {**spec.TEXT_STYLE, **(style or {})}
            base_size = int(st.get("size", 64))
            title_size = int(base_size * 1.3)
            sub_size = max(16, int(base_size * 0.55))
            title_y = int(h * 0.44)
            texts = []
            if title:
                texts.append({"content": title, "pos": [w // 2, title_y],
                              "anim": "none", "size": title_size,
                              "color": st.get("color", "#FFFFFF")})
            if subtitle:
                texts.append({"content": subtitle,
                              "pos": [w // 2, title_y + int(title_size * 1.25)],
                              "anim": "none", "size": sub_size,
                              "color": "#E5E7EB", "opacity": 0.9})
            fake = {"duration": 1.0, "texts": texts,
                    "fallback_font": st.get("font")}
            ass_path = tmpdir / "cover.ass"
            ass.scene_text_ass(ass_path, fake, w, h, st)
            fonts = f":fontsdir='{font_dir}'" if font_dir else ""
            vf.append(f"subtitles=filename='{ass_path.as_posix()}'{fonts}")
        if any(vf):
            args += ["-vf", ",".join([x for x in vf if x])]
        args += [str(dst)]
        run_ffmpeg(args, phase="cover")
        return {"ok": True, "output": str(dst), "width": w, "height": h}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def gif(src: str, out: str | None, start: float = 0.0, end: float | None = None,
        fps: int = 12, width: int = 480) -> dict:
    p = Path(src).expanduser().resolve()
    if not p.exists():
        raise VcliError(Codes.MISSING_FILE, f"文件不存在: {p}")
    info = probe(p)
    duration = info.get("duration") or 0
    end = duration if end is None else min(end, duration)
    if end <= start:
        raise VcliError(Codes.BAD_INPUT, "end 必须大于 start")
    dst = Path(out).expanduser().resolve() if out else p.with_suffix(".gif")
    dst.parent.mkdir(parents=True, exist_ok=True)
    graph = (f"[0:v]fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];"
             f"[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer")
    args = ["-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(p),
            "-filter_complex", graph, "-loop", "0", str(dst)]
    run_ffmpeg(args, total=max(0.1, end - start), phase="gif")
    return {"ok": True, "output": str(dst), "size": dst.stat().st_size,
            "start": start, "end": end, "fps": fps, "width": width}


def download(url: str, outdir: str, quality: str = "1080", audio_only: bool = False) -> dict:
    tool = shutil.which("yt-dlp")
    if not tool:
        raise VcliError(Codes.DEP_MISSING, "未安装 yt-dlp",
                        hint="在容器内执行 `bash scripts/install.sh`，或 python3 -m pip install yt-dlp")
    out = Path(outdir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [tool, "-P", str(out), "-o", "%(title).120s.%(ext)s",
           "--no-playlist", "--no-simulate", "--print", "after_move:filepath"]
    if audio_only:
        cmd += ["-x", "--audio-format", "mp3"]
    else:
        cmd += ["--merge-output-format", "mp4",
                "-f", f"bv*[height<={quality}]+ba/b[height<={quality}]/b"]
    cmd += [url]
    stdout = run_cmd(cmd, timeout=1800, code=Codes.NETWORK, what="yt-dlp")
    files = [line.strip() for line in stdout.splitlines() if line.strip().startswith(str(out))]
    result = {"ok": True, "outdir": str(out), "files": files}
    if files:
        result.update(probe_file(files[-1]))
    return result


def doctor() -> dict:
    report: dict = {"ok": True, "python": None, "ffmpeg": None, "ffprobe": None,
                    "filters": {}, "encoders": {}, "fonts": {}, "yt_dlp": None,
                    "missing": []}
    import platform
    report["python"] = platform.python_version()
    for name, exe in (("ffmpeg", ffmpeg_bin()), ("ffprobe", shutil.which("ffprobe") or "ffprobe")):
        if not (shutil.which(exe) or Path(exe).exists()):
            report["missing"].append(name)
            report["ok"] = False
            continue
        try:
            first = run_cmd([exe, "-version"], what=name).splitlines()[0]
            report[name] = first
        except VcliError:
            report["missing"].append(name)
            report["ok"] = False
    if report["ffmpeg"]:
        try:
            filters = run_cmd([ffmpeg_bin(), "-hide_banner", "-filters"], what="ffmpeg -filters")
            for key in ("subtitles", "zoompan", "xfade", "sidechaincompress", "loudnorm", "gradients"):
                report["filters"][key] = key in filters
            enc = run_cmd([ffmpeg_bin(), "-hide_banner", "-encoders"], what="ffmpeg -encoders")
            for key in ("libx264", "aac", "libx265"):
                report["encoders"][key] = key in enc
        except VcliError:
            report["ok"] = False
    fams = font_families()
    report["fonts"] = {"count": len(fams), "sample": fams[:12]}
    if not fams:
        report["missing"].append("fonts")
    ytdlp = shutil.which("yt-dlp")
    if ytdlp:
        try:
            report["yt_dlp"] = run_cmd([ytdlp, "--version"], what="yt-dlp").strip()
        except VcliError:
            report["yt_dlp"] = "error"
    else:
        report["yt_dlp"] = None
    if not report["filters"].get("subtitles"):
        report["ok"] = False
        report["missing"].append("libass(subtitles)")
    return report


DEMO_SRT = """1
00:00:00,600 --> 00:00:03,000
字幕也可以自动烧录

2
00:00:03,600 --> 00:00:06,200
支持 SRT / ASS / 自动换行

3
00:00:06,800 --> 00:00:10,000
一份 JSON 生成整条片子
"""


def demo(out: str = "demo.mp4") -> dict:
    from .render import render as do_render
    dst = Path(out).expanduser().resolve()
    base = dst.parent
    base.mkdir(parents=True, exist_ok=True)
    srt_path = base / "demo.srt"
    srt_path.write_text(DEMO_SRT, encoding="utf-8")
    raw = {
        "project": "demo",
        "output": dst.name,
        "video": {"preset": "720p", "fps": 30},
        "scenes": [
            {"type": "gradient", "gradient": {"from": "#0b1220", "to": "#1d4ed8"},
             "duration": 3.4,
             "texts": [
                 {"content": "video-cli", "pos": "center", "anim": "fade_up", "size": 96},
                 {"content": "命令行视频制作工具", "pos": [640, 440], "anim": "fade",
                  "size": 38, "color": "#C7D2FE"},
             ],
             "transition": {"type": "fade", "duration": 0.5}},
            {"type": "color", "color": "#0F172A", "duration": 3.2,
             "texts": [{"content": "AI 只写一份 job.json", "pos": "center",
                        "anim": "fade_up", "size": 62}],
             "transition": {"type": "slideleft", "duration": 0.5}},
            {"type": "gradient", "gradient": {"from": "#7C2D12", "to": "#0F172A"},
             "duration": 3.4,
             "texts": [{"content": "video render job.json --json", "pos": "center",
                        "anim": "fade_up", "size": 52}]},
        ],
        "subtitles": {"src": srt_path.name, "style": {"size": 34, "margin_v": 40}},
        "text_watermark": {"content": "generated by video-cli"},
    }
    job = spec.normalize(raw, base)
    errors = spec.validate(job)
    if errors:
        raise VcliError(Codes.BAD_INPUT, "示例 job 校验失败", details={"errors": errors})
    (base / "demo.job.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    result = do_render(job, out=str(dst), json_mode=False)
    result["job"] = str(base / "demo.job.json")
    result["srt"] = str(srt_path)
    return result


INIT_JOB = {
    "project": "my-video",
    "output": "out/my-video.mp4",
    "video": {"preset": "1080p", "fps": 30, "crf": 20},
    "audio": {"normalize": True, "loudness": -16,
              "bgm": {"src": "assets/bgm.mp3", "volume_db": -14,
                      "fade_in": 1, "fade_out": 2, "ducking": True}},
    "subtitles": {"src": "subs.srt",
                  "style": {"font": "Noto Sans CJK SC", "size": 46, "margin_v": 56}},
    "scenes": [
        {"type": "image", "src": "assets/01.jpg", "duration": 4,
         "kenburns": {"mode": "in", "zoom": 1.15},
         "texts": [{"content": "标题", "pos": "center", "anim": "fade_up", "size": 88}],
         "transition": {"type": "fade", "duration": 0.5}},
        {"type": "video", "src": "assets/02.mp4", "duration": 5, "fit": "blur",
         "transition": {"type": "slideleft", "duration": 0.5}},
        {"type": "color", "color": "#0F172A", "duration": 3,
         "texts": [{"content": "感谢观看", "pos": "center", "anim": "fade", "size": 72}]},
    ],
}


def init(directory: str = ".") -> dict:
    base = Path(directory).expanduser().resolve()
    (base / "assets").mkdir(parents=True, exist_ok=True)
    job_path = base / "job.json"
    if job_path.exists():
        raise VcliError(Codes.IO, f"job.json 已存在: {job_path}")
    job_path.write_text(json.dumps(INIT_JOB, ensure_ascii=False, indent=2), encoding="utf-8")
    srt = base / "subs.srt"
    if not srt.exists():
        srt.write_text("1\n00:00:00,500 --> 00:00:03,000\n在这里写字幕\n", encoding="utf-8")
    return {"ok": True, "job": str(job_path), "srt": str(srt),
            "assets": str(base / "assets"),
            "next": "把图片/视频/音乐放进 assets/，改 job.json 后执行 video render job.json --json"}
