"""统一错误码与异常定义。所有命令失败时输出同一结构，便于 AI 解析。"""

from __future__ import annotations


class Codes:
    BAD_INPUT = "E1001"          # 参数/JSON 结构错误
    MISSING_FILE = "E1002"       # 素材文件不存在
    UNSUPPORTED = "E1003"        # 不支持的格式或能力
    FFMPEG_FAILED = "E2001"      # ffmpeg/ffprobe 执行失败
    ENCODE_FAILED = "E2002"      # 渲染失败
    DEP_MISSING = "E3001"        # 缺少系统依赖
    NO_FONT = "E3002"            # 找不到字体
    NETWORK = "E4001"            # 外部接口/下载失败
    IO = "E5001"                 # 读写文件失败
    INTERNAL = "E9001"           # 未预期异常


HINTS = {
    Codes.BAD_INPUT: "检查 job.json 字段名、类型与必填项，可用 `video schema` 查看完整规范。",
    Codes.MISSING_FILE: "确认素材路径存在；相对路径以 job.json 所在目录为基准。",
    Codes.UNSUPPORTED: "用 `video doctor --json` 查看当前容器支持的能力。",
    Codes.FFMPEG_FAILED: "用 --verbose 重新运行以查看 ffmpeg 完整日志。",
    Codes.ENCODE_FAILED: "先降低分辨率或改用 --dry-run 检查生成的命令。",
    Codes.DEP_MISSING: "在容器内执行 `bash scripts/install.sh` 或重新构建镜像。",
    Codes.NO_FONT: "用 `video fonts --json` 查看可用字体，或在 job.json 中指定已有字体。",
    Codes.NETWORK: "检查网络、端点地址与鉴权变量（VCLI_TTS_URL / VCLI_ASR_URL）。",
    Codes.IO: "检查目录权限与磁盘空间。",
    Codes.INTERNAL: "附带完整日志反馈问题。",
}


class VcliError(Exception):
    """带错误码的异常。"""

    def __init__(self, code: str, message: str, hint: str | None = None, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint or HINTS.get(code)
        self.details = details

    def to_dict(self) -> dict:
        data = {"code": self.code, "message": self.message}
        if self.hint:
            data["hint"] = self.hint
        if self.details:
            data["details"] = self.details
        return data
