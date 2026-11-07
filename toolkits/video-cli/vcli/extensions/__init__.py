"""
vcli.extensions — hypit 风格可选扩展库。

所有扩展均为纯算法实现 + lazy import AI 运行时。
AI 运行时首次调用自动 pip install（可禁止），或 Docker build-arg 预装。
按需 import，不导入则零开销。

用法示例：
    # 纯算法（零依赖）
    from vcli.extensions.wordtiming import phrase_ranges
    from vcli.extensions.spatial_math import center_offset

    # AI 运行时（首次自动装 whisperx）
    from vcli.extensions.speech_ai import transcribe
    words = transcribe("voice.mp3")

    # 查看可用运行时
    from vcli.extensions.runtime import list_runtimes
"""

__all__ = [
    "wordtiming", "temporal_math", "spatial_math", "ffmpeg_filter_builder",
    "runtime", "speech_ai", "chromium_subs", "autocrop",
]
