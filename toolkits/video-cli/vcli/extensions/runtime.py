"""
AI 运行时自动安装 + lazy import 机制。

所有 AI 扩展模块共享这套基础设施：
- lazy_import(): 尝试 import，失败 → 可选自动 pip install → 再试
- _ensure_runtime(): 检查运行时是否可用
- RuntimeStatus: 枚举 AVAILABLE / NEEDS_INSTALL / FAILED

安装策略（三层，按优先级）：
1. vendor/extensions/<name>/ 有 wheel → --no-index --find-links 完全离线
2. 在线 pip install（runtime.auto_install_allowed=True 时）
3. 都不行 → raise ImportError 带友好提示

设计原则：
- 默认不预装任何 AI 包（保持 Docker 镜像 309MB 瘦）
- 联网机器上 bash scripts/fetch_ai_deps.sh 拉好 wheel 放进 vendor/
- 之后 Docker build + runtime install 完全离线
"""

from __future__ import annotations

import enum
import os
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional


# ── vendor 离线 wheel 查找路径 ─────────────────────────────────

def _find_vendor_dir(runtime_name: str) -> Optional[Path]:
    """
    查找 vendor/extensions/<runtime_name>/ 目录。

    搜索顺序：
    1. 硬编码默认 /opt/video-cli/vendor/extensions/<name>  （Docker 容器内）
    2. 当前工作目录 vendor/extensions/<name>
    3. PYTHONPATH 第一个路径下 vendor/extensions/<name>
    """
    candidates = [
        Path("/opt/video-cli/vendor/extensions") / runtime_name,
        Path.cwd() / "vendor" / "extensions" / runtime_name,
    ]
    for p in candidates:
        if p.is_dir() and any(p.glob("*.whl")):
            return p
    return None


class RuntimeStatus(str, enum.Enum):
    AVAILABLE = "available"
    NEEDS_INSTALL = "needs_install"
    FAILED = "failed"


@dataclass
class RuntimeInfo:
    """一个运行时的元信息。"""
    name: str                    # "whisperx", "playwright", "ultralytics"
    import_name: str             # Python import 名 "whisperx"
    pip_packages: tuple[str, ...]  # ("whisperx",) 或 ("playwright", "playwright[all]")
    description: str
    auto_install_allowed: bool = True  # 是否允许首次调用时自动 pip install
    install_extra_step: Optional[Callable[[], None]] = None  # 比如 playwright install chromium
    _status: RuntimeStatus = RuntimeStatus.NEEDS_INSTALL
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


# ── 注册表 ──────────────────────────────────────────────────────

_RUNTIMES: dict[str, RuntimeInfo] = {}


def register_runtime(info: RuntimeInfo) -> RuntimeInfo:
    _RUNTIMES[info.name] = info
    return info


def get_runtime(name: str) -> Optional[RuntimeInfo]:
    return _RUNTIMES.get(name)


def list_runtimes() -> list[RuntimeInfo]:
    return list(_RUNTIMES.values())


# ── 核心：lazy import + 自动装 ───────────────────────────────────

def check_import(name: str) -> bool:
    """不真的 import，只检查模块是否已安装（用 importlib.util.find_spec）。"""
    import importlib.util
    return importlib.util.find_spec(name) is not None


def lazy_import(runtime_name: str, auto_install: bool | None = None) -> Any:
    """
    尝试 import 一个运行时的顶层模块。

    流程：
    1. 检查已安装？ → return import 结果
    2. 没装且 auto_install=True → pip install → 再试
    3. 没装且 auto_install=False 或未设置 → raise ImportError 带友好提示
    """
    info = _RUNTIMES.get(runtime_name)
    if info is None:
        raise KeyError(f"未知运行时: {runtime_name}. 已注册: {list(_RUNTIMES.keys())}")

    # 读锁：避免多线程同时装
    if check_import(info.import_name):
        info._status = RuntimeStatus.AVAILABLE
        return _do_import(info.import_name)

    # 没装
    should_install = auto_install if auto_install is not None else info.auto_install_allowed

    with info._lock:
        # 双重检查（装完之后）
        if check_import(info.import_name):
            info._status = RuntimeStatus.AVAILABLE
            return _do_import(info.import_name)

        if not should_install:
            info._status = RuntimeStatus.NEEDS_INSTALL
            raise ImportError(
                f"运行时 '{runtime_name}' 未安装。\n"
                f"  pip install {' '.join(info.pip_packages)}\n"
                f"或: video install-runtime {runtime_name}\n"
                f"或: docker build --build-arg WITH_{runtime_name.upper()}=1 ..."
            )

        # 自动安装
        print(f"[vcli.extensions] 首次使用，正在自动安装 {runtime_name}...", file=sys.stderr)
        try:
            _pip_install(info.pip_packages, runtime_name=runtime_name)
            if info.install_extra_step:
                info.install_extra_step()
            info._status = RuntimeStatus.AVAILABLE
        except Exception as e:
            info._status = RuntimeStatus.FAILED
            raise RuntimeError(
                f"自动安装 '{runtime_name}' 失败: {e}\n"
                f"可手动: pip install {' '.join(info.pip_packages)}"
            ) from e

    return _do_import(info.import_name)


def _do_import(name: str) -> Any:
    import importlib
    return importlib.import_module(name)


def _pip_install(packages: tuple[str, ...],
                 runtime_name: str | None = None,
                 allow_online: bool = True) -> None:
    """
    pip install — 三层策略。

    1. vendor/extensions/<name>/ 有 wheel → --no-index --find-links 离线装
    2. allow_online=True → 在线 pip install
    3. 都不行 → raise RuntimeError
    """
    # 层 1：vendor 离线
    if runtime_name:
        vendor_dir = _find_vendor_dir(runtime_name)
        if vendor_dir is not None:
            cmd = [
                sys.executable, "-m", "pip", "install", "--quiet", "--no-input",
                "--no-index", "--find-links", str(vendor_dir),
                *packages,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if result.returncode == 0:
                print(f"[runtime] {runtime_name} 从 vendor 离线安装成功", file=sys.stderr)
                return
            # 离线装失败（缺依赖？）→ fallback 在线
            print(f"[runtime] vendor 离线装 {runtime_name} 失败，尝试在线...", file=sys.stderr)

    # 层 2：在线
    if allow_online:
        cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--no-input", *packages]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode == 0:
            return
        raise RuntimeError(f"pip install failed:\n{result.stderr}")

    # 层 3：都不行
    raise RuntimeError(
        f"离线/在线安装均失败。\n"
        f"请先在联网机器上: bash scripts/fetch_ai_deps.sh {runtime_name}\n"
        f"再把 vendor/extensions/ 目录拷过来，或开启联网安装。"
    )


def install_runtime(runtime_name: str) -> bool:
    """
    显式安装一个运行时（给 CLI subcommand 用）。
    返回 True=成功。
    """
    info = _RUNTIMES.get(runtime_name)
    if info is None:
        return False
    try:
        with info._lock:
            _pip_install(info.pip_packages, runtime_name=runtime_name)
            if info.install_extra_step:
                info.install_extra_step()
            info._status = RuntimeStatus.AVAILABLE
        return True
    except Exception as e:
        info._status = RuntimeStatus.FAILED
        print(f"安装失败: {e}", file=sys.stderr)
        return False


# ── 预置的运行时定义 ────────────────────────────────────────────

def _setup_playwright() -> None:
    """playwright 装完之后要额外 install chromium。"""
    import subprocess as _sp
    _sp.run([sys.executable, "-m", "playwright", "install", "chromium"],
            capture_output=True, timeout=300, check=False)


def register_all_defaults() -> None:
    """注册所有默认运行时（调用一次就好）。"""
    register_runtime(RuntimeInfo(
        name="whisperx",
        import_name="whisperx",
        pip_packages=("whisperx",),
        description="词级转写（hypit speech-evidence 底层）",
        auto_install_allowed=True,
    ))
    register_runtime(RuntimeInfo(
        name="playwright",
        import_name="playwright",
        pip_packages=("playwright",),
        description="Chromium 渲染（hypit chromium-render 底层）",
        auto_install_allowed=True,
        install_extra_step=_setup_playwright,
    ))
    register_runtime(RuntimeInfo(
        name="ultralytics",
        import_name="ultralytics",
        pip_packages=("ultralytics", "opencv-python-headless"),
        description="YOLOv8 自动人脸/主体检测",
        auto_install_allowed=True,
    ))
    register_runtime(RuntimeInfo(
        name="opencv",
        import_name="cv2",
        pip_packages=("opencv-python-headless",),
        description="OpenCV（图像处理/模糊/检测）",
        auto_install_allowed=True,
    ))


# 模块加载时自动注册
register_all_defaults()
