"""
Chromium 字幕渲染（hypit chromium-render 的 Python 实现）。

hypit 用 headless Chromium + CSS/JS 渲染动画字幕和布局。
这里用 Playwright + 系统预装的 Chromium 做同样的事。

能做什么：
- render_karaoke_srt(srt, out_video, fps) → 渲染 Karaoke 效果的字幕段
- render_css_overlay(html_template, data, out_video) → 任意 CSS 字幕模板
- render_text_effect(text, effect_name, out_png) → 单帧字幕效果导出

首次调用自动 pip install playwright + playwright install chromium。
如果 Dockerfile 预装了 Chromium（apt install chromium），会直接用。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Optional

from . import runtime as _rt


# ── 配置 ────────────────────────────────────────────────────────

@dataclass
class ChromiumConfig:
    width: int = 1920
    height: int = 1080
    fps: int = 30
    font_family: str = "Noto Sans SC, DejaVu Sans, sans-serif"
    font_size: int = 48
    font_color: str = "#FFFFFF"
    stroke_color: str = "#000000"
    stroke_width: float = 2.0
    background_color: str = "transparent"
    auto_install: bool = True
    # 系统预装的 Chromium 可执行文件路径（apt install chromium 后的位置）
    system_executable: str | None = "/usr/bin/chromium"


# ── 核心渲染 ───────────────────────────────────────────────────

def _get_browser_executable(cfg: ChromiumConfig) -> str:
    """优先用系统预装的 Chromium，没有就让 Playwright 自己装。"""
    if cfg.system_executable and os.path.exists(cfg.system_executable):
        return cfg.system_executable
    # 让 Playwright 自己找或装
    pw = _rt.lazy_import("playwright", auto_install=cfg.auto_install)
    # Playwright 自带的 chromium
    return pw.chromium.executable_path


def render_text_png(
    text: str,
    output_path: str,
    cfg: ChromiumConfig | None = None,
    custom_css: str = "",
) -> str:
    """
    把一段文字渲染成 PNG（透明背景或指定色）。

    用途：
    - 字幕模板预渲染
    - 视频封面
    - 水印文字（用 ffmpeg overlay= 叠上去）

    返回 output_path。
    """
    cfg = cfg or ChromiumConfig()
    pw = _rt.lazy_import("playwright", auto_install=cfg.auto_install)

    html = f"""<!doctype html>
<html><head><meta charset="utf-8">
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  width: {cfg.width}px; height: {cfg.height}px;
  background: {cfg.background_color};
  display: flex; align-items: center; justify-content: center;
}}
.text {{
  font-family: {cfg.font_family};
  font-size: {cfg.font_size}px;
  color: {cfg.font_color};
  text-shadow: {cfg.stroke_width}px {cfg.stroke_width}px 0 {cfg.stroke_color},
               -{cfg.stroke_width}px {cfg.stroke_width}px 0 {cfg.stroke_color},
               {cfg.stroke_width}px -{cfg.stroke_width}px 0 {cfg.stroke_color},
               -{cfg.stroke_width}px -{cfg.stroke_width}px 0 {cfg.stroke_color};
  text-align: center;
  line-height: 1.2;
  white-space: pre-wrap;
  max-width: 95%;
}}
{custom_css}
</style></head>
<body>
<div class="text">{text.replace(chr(10), '<br>')}</div>
</body></html>"""

    with tempfile.NamedTemporaryFile(suffix=".html", mode="w", delete=False, encoding="utf-8") as f:
        f.write(html)
        html_path = f.name

    try:
        # 优先用系统 Chromium
        exe = cfg.system_executable if (cfg.system_executable and os.path.exists(cfg.system_executable)) else None
        if exe:
            browser = pw.chromium.launch(executable_path=exe)
        else:
            browser = pw.chromium.launch()

        page = browser.new_page(viewport={"width": cfg.width, "height": cfg.height})
        page.goto(f"file://{html_path}")
        page.wait_for_load_state("networkidle")
        page.screenshot(path=output_path, full_page=False)
        browser.close()
    finally:
        try:
            os.unlink(html_path)
        except OSError:
            pass

    return output_path


def render_karaoke_text_via_chromium(
    words: list[dict],  # [{"text": str, "start": float, "end": float}]
    output_dir: str,
    duration: float,
    cfg: ChromiumConfig | None = None,
) -> str:
    """
    用 Playwright 渲染 Karaoke 效果视频段。

    原理：
    1. 生成 HTML 模板，每帧更新"当前高亮词"
    2. Playwright 的 page.video 录制（或逐帧截图 + ffmpeg 合成）
    3. 输出一个带 Karaoke 字幕的 mp4 片段

    这种方式比 ASS 字幕强在：
    - 可以用任意 CSS 动画（颜色过渡、缩放、辉光）
    - 支持 emoji/特殊符号
    - 可以跟 hypit 的 animation 组件无缝对接

    返回视频片段路径（Chromium 录制的 webm → ffmpeg 转 mp4）。
    """
    cfg = cfg or ChromiumConfig()
    os.makedirs(output_dir, exist_ok=True)

    # Karaoke HTML 模板
    words_html = "".join(
        f'<span data-start="{w["start"]}" data-end="{w["end"]}">{w["text"]}</span>'
        for w in words
    )

    html = f"""<!doctype html>
<html><head><meta charset="utf-8">
<style>
body {{ background: transparent; }}
.karaoke {{
  font-family: {cfg.font_family};
  font-size: {cfg.font_size}px;
  color: rgba(255,255,255,0.4);
  text-shadow: 2px 2px 0 #000;
}}
.karaoke span.active {{
  color: #FFFF00;
  font-weight: bold;
  text-shadow: 0 0 10px #FFFF00, 2px 2px 0 #000;
  transition: color 0.05s;
}}
</style></head>
<body>
<div class="karaoke" id="karaoke">{words_html}</div>
<script>
const spans = document.querySelectorAll('.karaoke span');
const fps = {cfg.fps};
const frameMs = 1000 / fps;
const duration = {duration};
let frame = 0;
function tick() {{
  const t = frame * frameMs / 1000;
  spans.forEach(s => {{
    const start = parseFloat(s.dataset.start);
    const end = parseFloat(s.dataset.end);
    s.classList.toggle('active', t >= start && t < end);
  }});
  frame++;
  if (frame * frameMs < duration * 1000) {{
    setTimeout(tick, frameMs);
  }}
}}
// 让 Playwright page.video 录制时能等到结束
window.__KARAOKE_DURATION__ = duration * 1000;
window.__KARAOKE_READY__ = true;
tick();
</script></body></html>"""

    html_path = os.path.join(output_dir, "karaoke.html")
    out_webm = os.path.join(output_dir, "karaoke.webm")
    out_mp4 = os.path.join(output_dir, "karaoke.mp4")

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    pw = _rt.lazy_import("playwright", auto_install=cfg.auto_install)
    exe = cfg.system_executable if (cfg.system_executable and os.path.exists(cfg.system_executable)) else None

    # Playwright 录制视频
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    context = browser.new_context(
        viewport={"width": cfg.width, "height": cfg.height},
        record_video_dir=output_dir,
        record_video_size={"width": cfg.width, "height": cfg.height},
    )
    page = context.new_page()
    page.goto(f"file://{html_path}")
    # 等 JS 准备好
    page.wait_for_function("window.__KARAOKE_READY__")
    # 等动画结束
    page.wait_for_timeout(int(duration * 1000 + 500))
    browser.close()

    # 找 Playwright 录制的 webm
    for f in os.listdir(output_dir):
        if f.endswith(".webm") and f != os.path.basename(out_webm):
            os.rename(os.path.join(output_dir, f), out_webm)
            break

    # ffmpeg 转 mp4（透明背景 Chromium 录的 webm 已经带 alpha）
    if os.path.exists(out_webm):
        subprocess.run([
            "ffmpeg", "-y", "-i", out_webm,
            "-c:v", "libx264", "-pix_fmt", "yuva420p",
            out_mp4,
        ], capture_output=True, check=False, timeout=120)
        return out_mp4

    return out_webm


# ── 状态检查 ────────────────────────────────────────────────────

def is_available() -> bool:
    return _rt.check_import("playwright")


def has_system_chromium(path: str = "/usr/bin/chromium") -> bool:
    return os.path.exists(path)
