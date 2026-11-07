"""命令行入口：所有子命令都支持 --json，输出供 AI 直接解析。"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

from . import actions, llm, spec, util
from .errors import Codes, VcliError
from .render import render as render_video


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="video",
        description="video-cli：面向 AI 的 Linux 命令行视频制作工具（ffmpeg + ASS）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n  video render job.json --json\n  video demo --out demo.mp4\n  video doctor --json",
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text)
        sp.add_argument("--json", action="store_true", help="输出单行 JSON 结果")
        sp.add_argument("--verbose", action="store_true", help="输出 ffmpeg 完整日志")
        return sp

    r = add("render", "按 job.json 渲染成片")
    r.add_argument("job")
    r.add_argument("--out")
    r.add_argument("--workdir")
    r.add_argument("--dry-run", action="store_true", help="只输出将要执行的命令，不渲染")
    r.add_argument("--keep-work", action="store_true", help="保留中间文件")
    r.add_argument("--resume", action="store_true", help="从 workdir/timeline.json 恢复，跳过已完成切片")

    pr = add("probe", "读取媒体信息")
    pr.add_argument("path")

    f = add("fonts", "列出可用字体")
    f.add_argument("--dir", action="append", default=[], help="额外字体目录，可重复")

    fr = add("frames", "按时间点抽帧")
    fr.add_argument("path")
    fr.add_argument("--at", required=True, help="秒或时间点，逗号分隔，如 1,2.5,00:00:04")
    fr.add_argument("--out", required=True)

    c = add("cover", "生成封面图（可加标题）")
    c.add_argument("path")
    c.add_argument("--out")
    c.add_argument("--at", default="0")
    c.add_argument("--width", type=int)
    c.add_argument("--title")
    c.add_argument("--subtitle")
    c.add_argument("--font-dir")
    c.add_argument("--dim", type=float, default=0.25, help="标题模式下背景压暗程度 0-0.9")

    g = add("gif", "导出 GIF")
    g.add_argument("path")
    g.add_argument("--out")
    g.add_argument("--start", default="0")
    g.add_argument("--end")
    g.add_argument("--fps", type=int, default=12)
    g.add_argument("--width", type=int, default=480)

    d = add("download", "用 yt-dlp 下载素材")
    d.add_argument("url")
    d.add_argument("--out", default="downloads")
    d.add_argument("--quality", default="1080", help="限制高度，如 1080/720")
    d.add_argument("--audio-only", action="store_true")

    t = add("tts", "调用外部 TTS 接口生成配音")
    t.add_argument("text")
    t.add_argument("--out", required=True)
    t.add_argument("--voice")
    t.add_argument("--speed", type=float, default=1.0)
    t.add_argument("--format", default="mp3")
    t.add_argument("--url")
    t.add_argument("--token")

    a = add("asr", "调用外部 ASR 接口生成字幕")
    a.add_argument("path")
    a.add_argument("--out", required=True, help="输出 .srt")
    a.add_argument("--language", default="auto")
    a.add_argument("--url")
    a.add_argument("--token")

    demo = add("demo", "生成一条示例视频（无需素材）")
    demo.add_argument("--out", default="demo.mp4")

    ini = add("init", "生成 job.json 模板")
    ini.add_argument("directory", nargs="?", default=".")

    add("doctor", "检查 ffmpeg/字体/依赖")
    add("schema", "打印 job.json 的 JSON Schema")
    return p


def _times(values: str) -> list[float]:
    return [util.parse_time(x) for x in values.split(",") if x.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    util.VERBOSE = bool(args.verbose)
    json_mode = bool(getattr(args, "json", False))
    try:
        result = dispatch(args)
    except VcliError as err:
        return _fail(err, json_mode)
    except KeyboardInterrupt:
        err = VcliError(Codes.INTERNAL, "已中断")
        return _fail(err, json_mode)
    except Exception as exc:  # noqa: BLE001
        if util.VERBOSE:
            import traceback
            traceback.print_exc()
        err = VcliError(Codes.INTERNAL, f"{type(exc).__name__}: {exc}")
        return _fail(err, json_mode)

    if json_mode:
        print(json.dumps(result, ensure_ascii=False))
    else:
        _human(args, result)
    return 0


def dispatch(args) -> dict:
    cmd = args.command
    if cmd == "render":
        job, _ = spec.load_job(args.job)
        return render_video(job, out=args.out, workdir=args.workdir,
                            json_mode=args.json, dry_run=args.dry_run,
                            keep_work=args.keep_work, resume=args.resume)
    if cmd == "probe":
        return actions.probe_file(args.path)
    if cmd == "fonts":
        fams = util.font_families(args.dir)
        return {"ok": True, "count": len(fams), "fonts": fams}
    if cmd == "frames":
        return actions.frames(args.path, _times(args.at), args.out)
    if cmd == "cover":
        return actions.cover(args.path, args.out, util.parse_time(args.at), args.width,
                             args.title, args.subtitle, None, args.font_dir, args.dim)
    if cmd == "gif":
        return actions.gif(args.path, args.out, util.parse_time(args.start),
                           util.parse_time(args.end) if args.end else None,
                           args.fps, args.width)
    if cmd == "download":
        return actions.download(args.url, args.out, args.quality, args.audio_only)
    if cmd == "tts":
        return llm.tts(args.text, Path(args.out).expanduser().resolve(), voice=args.voice,
                       speed=args.speed, fmt=args.format, url=args.url, token=args.token)
    if cmd == "asr":
        data = llm.asr(Path(args.path).expanduser().resolve(), language=args.language,
                       url=args.url, token=args.token)
        out = Path(args.out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(data["srt"], encoding="utf-8")
        return {"ok": True, "output": str(out), "segments": data.get("segments")}
    if cmd == "demo":
        return actions.demo(args.out)
    if cmd == "init":
        return actions.init(args.directory)
    if cmd == "doctor":
        return actions.doctor()
    if cmd == "schema":
        path = Path(__file__).resolve().parent.parent / "schema" / "job.schema.json"
        if not path.exists():
            raise VcliError(Codes.MISSING_FILE, f"schema 文件缺失: {path}")
        return json.loads(path.read_text(encoding="utf-8"))
    raise VcliError(Codes.BAD_INPUT, f"未知命令: {cmd}")


def _fail(err: VcliError, json_mode: bool) -> int:
    if json_mode:
        print(json.dumps({"ok": False, "error": err.to_dict()}, ensure_ascii=False))
    else:
        print(f"[{err.code}] {err.message}", file=sys.stderr)
        if err.hint:
            print(f"提示: {err.hint}", file=sys.stderr)
        if err.details:
            detail = err.details if isinstance(err.details, str) else json.dumps(err.details, ensure_ascii=False, indent=2)
            print(detail, file=sys.stderr)
    return 1


def _human(args, res: dict) -> None:
    cmd = args.command
    if cmd == "render":
        if res.get("dry_run"):
            print(f"dry-run: {res['output']}  {res['width']}x{res['height']}  {res['duration']}s")
            for item in res.get("commands", []):
                print(f"\n# {item['phase']} (cwd={item['cwd']})")
                print(shlex.join(item["cmd"]))
            return
        mb = res.get("size", 0) / 1024 / 1024
        print(f"完成: {res['output']}")
        print(f"  {res['width']}x{res['height']}  {res['fps']}fps  {res['duration']}s  {mb:.2f}MB  "
              f"{res['scenes']} 场景  音频={'有' if res['has_audio'] else '无'}")
        return
    if cmd == "fonts":
        print(f"共 {res['count']} 个字体族：")
        for name in res["fonts"]:
            print(f"  {name}")
        return
    if cmd == "probe":
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if cmd == "doctor":
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if cmd == "schema":
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    if cmd == "frames":
        print(f"抽出 {res['count']} 帧 -> {res['outdir']}")
        for f in res["frames"]:
            print(f"  {f}")
        return
    if cmd == "demo":
        print(f"示例视频: {res['output']}")
        print(f"job 模板: {res['job']}")
        return
    if cmd == "init":
        print(f"已生成: {res['job']}")
        print(f"字幕后: {res['srt']}")
        print(f"素材目录: {res['assets']}")
        print(res["next"])
        return
    if cmd == "asr":
        print(f"已写入: {res['output']}")
        return
    for key in ("output", "outdir"):
        if res.get(key):
            print(f"输出: {res[key]}")
            break
    for key in ("duration", "size", "count"):
        if res.get(key) is not None:
            print(f"{key}: {res[key]}")
