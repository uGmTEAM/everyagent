"""通用工具：ffmpeg 调用、进度解析、探测、路径与时间格式。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from .errors import Codes, VcliError

VERBOSE = False

_EMIT_LOCK = threading.Lock()


def ffmpeg_bin() -> str:
    return os.environ.get("VCLI_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_bin() -> str:
    return os.environ.get("VCLI_FFPROBE") or shutil.which("ffprobe") or "ffprobe"


def require_tools() -> None:
    miss = [n for n, p in (("ffmpeg", ffmpeg_bin()), ("ffprobe", ffprobe_bin())) if not shutil.which(p) and not Path(p).exists()]
    if miss:
        raise VcliError(Codes.DEP_MISSING, f"缺少依赖: {', '.join(miss)}")


def log(msg: str, *, json_mode: bool = False) -> None:
    """日志统一走 stderr，避免污染 stdout 的 JSON 结果。"""
    print(msg, file=sys.stderr, flush=True)


def emit(event: dict) -> None:
    """输出一行 NDJSON 事件到 stderr（线程安全）。"""
    with _EMIT_LOCK:
        print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def fingerprint(path: Path) -> dict:
    st = path.stat()
    return {"path": str(path), "size": st.st_size, "mtime": int(st.st_mtime)}


def fmt_seconds(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def ass_time(sec: float) -> str:
    """秒 -> ASS 时间 H:MM:SS.cc。"""
    cs = int(round(max(0.0, sec) * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def parse_ratio(v: str | None, default: float = 0.0) -> float:
    if not v:
        return default
    try:
        if "/" in v:
            a, b = v.split("/", 1)
            b = float(b)
            return float(a) / b if b else default
        return float(v)
    except (ValueError, ZeroDivisionError):
        return default


def filter_path(p: str | Path) -> str:
    """转义 ffmpeg 滤镜参数中的路径。"""
    s = str(p).replace("\\", "/")
    for ch in ("\\", ":", "'", "[", "]", ",", ";"):
        s = s.replace(ch, "\\" + ch)
    return s


def probe(path: str | Path) -> dict:
    """ffprobe 精简结果。"""
    cmd = [
        ffprobe_bin(), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    except FileNotFoundError:
        raise VcliError(Codes.DEP_MISSING, "找不到 ffprobe")
    if proc.returncode != 0:
        raise VcliError(Codes.FFMPEG_FAILED, f"ffprobe 失败: {path}", details=proc.stderr[-1500:])
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0.0)
    fps = parse_ratio((v or {}).get("avg_frame_rate")) or parse_ratio((v or {}).get("r_frame_rate"), 30.0)
    result = {
        "path": str(path),
        "duration": round(duration, 3),
        "size": int(fmt.get("size") or 0),
        "bit_rate": int(fmt.get("bit_rate") or 0),
        "format": fmt.get("format_name"),
        "has_video": v is not None,
        "has_audio": a is not None,
    }
    if v:
        result["video"] = {
            "codec": v.get("codec_name"),
            "width": int(v.get("width") or 0),
            "height": int(v.get("height") or 0),
            "fps": round(fps, 3),
            "pix_fmt": v.get("pix_fmt"),
            "duration": round(float(v.get("duration") or duration), 3),
            "sar": v.get("sample_aspect_ratio"),
        }
    if a:
        result["audio"] = {
            "codec": a.get("codec_name"),
            "sample_rate": int(a.get("sample_rate") or 0),
            "channels": int(a.get("channels") or 0),
            "duration": round(float(a.get("duration") or duration), 3),
        }
    return result


def run_ffmpeg(
    args: list[str],
    *,
    cwd: str | Path | None = None,
    total: float | None = None,
    phase: str = "render",
    json_mode: bool = False,
    quiet: bool = False,
) -> str:
    """执行 ffmpeg，解析 -progress 并向 stderr 推送进度事件；失败抛 VcliError。"""
    cmd = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "verbose" if VERBOSE else "warning",
           "-progress", "pipe:1", "-y", *args]
    if VERBOSE:
        log("$ " + " ".join(cmd), json_mode=json_mode)
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
    except FileNotFoundError:
        raise VcliError(Codes.DEP_MISSING, "找不到 ffmpeg 可执行文件")

    stderr_buf: list[str] = []

    def _drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_buf.append(line)
            if VERBOSE:
                print(line.rstrip(), file=sys.stderr, flush=True)

    t = threading.Thread(target=_drain, daemon=True)
    t.start()
    last = 0.0
    last_pct = -1.0
    timeout = max(300, int(total * 4)) if total and total > 0 else None
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key != "out_time_us":
                continue
            try:
                last = int(val) / 1_000_000.0
            except ValueError:
                continue
            if total and total > 0:
                pct = min(99.9, round(last / total * 100, 1))
                if pct != last_pct:
                    last_pct = pct
                    if json_mode and not quiet:
                        emit({"event": "progress", "phase": phase, "out_time": round(last, 2),
                              "total": round(total, 2), "percent": pct})
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise VcliError(Codes.FFMPEG_FAILED, f"ffmpeg 超时（>{timeout}s），phase={phase}",
                        details=f"run_ffmpeg total={total}")
    except KeyboardInterrupt:
        proc.kill()
        raise
    t.join(timeout=5)
    err = "".join(stderr_buf).strip()
    if proc.returncode != 0:
        tail = "\n".join(err.splitlines()[-40:])
        raise VcliError(Codes.FFMPEG_FAILED, f"ffmpeg 执行失败（exit={proc.returncode}）",
                        details=tail[-4000:])
    return err


def run_cmd(cmd: list[str], *, cwd: str | Path | None = None, timeout: int | None = None,
            code: str = Codes.FFMPEG_FAILED, what: str = "命令") -> str:
    try:
        proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError:
        raise VcliError(Codes.DEP_MISSING, f"找不到可执行文件: {cmd[0]}")
    except subprocess.TimeoutExpired:
        raise VcliError(code, f"{what} 超时")
    if proc.returncode != 0:
        raise VcliError(code, f"{what} 失败（exit={proc.returncode}）",
                        details=(proc.stderr or proc.stdout)[-2000:])
    return proc.stdout


def ensure_parent(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise VcliError(Codes.IO, f"无法创建目录: {path.parent}", details=str(exc))


def resolve_path(base: Path, value: str | Path) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (base / p)


def hex_to_ass(color: str, alpha: int = 0) -> str:
    """#RRGGBB / #AARRGGBB -> &HAABBGGRR (ASS)。"""
    c = str(color).strip().lstrip("#")
    if len(c) == 8:  # AARRGGBB
        a, r, g, b = c[0:2], c[2:4], c[4:6], c[6:8]
    elif len(c) == 6:
        a, r, g, b = "00", c[0:2], c[2:4], c[4:6]
    elif len(c) == 3:
        a, r, g, b = "00", c[0] * 2, c[1] * 2, c[2] * 2
    else:
        a, r, g, b = "00", "FF", "FF", "FF"
    if alpha:
        a = f"{max(0, min(255, int(alpha))):02X}"
    return f"&H{a}{b}{g}{r}".upper()


def hex_to_ffmpeg(color: str, alpha: float = 1.0) -> str:
    """#RRGGBB -> 0xRRGGBB@a，用于 drawbox/color。"""
    c = str(color).strip().lstrip("#")
    if len(c) == 8:
        c = c[2:]
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        c = "000000"
    return f"0x{c.upper()}@{max(0.0, min(1.0, alpha)):.3f}"


def font_families(extra_dirs: list[str] | None = None) -> list[str]:
    """列出可用字体族；优先 fc-list，回退扫描字体目录。"""
    names: set[str] = set()
    if shutil.which("fc-list"):
        try:
            out = run_cmd(["fc-list", "--format", "%{family}\n"], what="fc-list")
            for line in out.splitlines():
                first = line.split(",")[0].strip()
                if first:
                    names.add(first)
        except VcliError:
            pass
    dirs = [Path(d) for d in (extra_dirs or [])]
    dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
             Path("/data/fonts")]
    if not names:
        for d in dirs:
            if not d.exists():
                continue
            for f in d.rglob("*"):
                if f.suffix.lower() in (".ttf", ".otf", ".ttc", ".otc"):
                    names.add(f.stem)
    return sorted(names, key=str.lower)


_SRT_TS = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def srt_time_to_sec(ts: str) -> float:
    m = _SRT_TS.search(ts)
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000.0


def parse_time(value) -> float:
    """支持 12.5 / '12.5' / '00:01:30' / '1:30.5'。"""
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if ":" not in s:
        return float(s)
    parts = s.split(":")
    total = 0.0
    for p in parts:
        total = total * 60 + float(p)
    return total
