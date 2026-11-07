"""外部语音能力接口（TTS / ASR）。只定义协议，不绑定具体模型。

环境变量：
  VCLI_TTS_URL    TTS 端点（HTTP POST JSON）
  VCLI_TTS_TOKEN  可选 Bearer Token
  VCLI_TTS_VOICE  默认音色
  VCLI_ASR_URL    ASR 端点
  VCLI_ASR_TOKEN  可选 Bearer Token
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from .errors import Codes, VcliError
from .util import probe

TTS_PROTOCOL = {
    "request": {"text": "string", "voice": "string?", "speed": "1.0", "format": "mp3|wav"},
    "response": "audio/* 二进制，或 JSON: {audio_base64} / {url}",
}

ASR_PROTOCOL = {
    "request": {"audio_base64": "string", "language": "zh|en|auto", "format": "srt|json"},
    "response": "JSON: {srt: string} 或 {segments: [{start, end, text}]}",
}


def _post(url: str, payload: dict, token: str | None, timeout: int = 300) -> tuple[bytes, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        body = exc.read()[:800].decode("utf-8", "replace")
        raise VcliError(Codes.NETWORK, f"接口返回 HTTP {exc.code}", details=body)
    except urllib.error.URLError as exc:
        raise VcliError(Codes.NETWORK, f"接口连接失败: {url}", details=str(exc.reason))
    except TimeoutError:
        raise VcliError(Codes.NETWORK, f"接口超时: {url}")


def tts(text: str, out: Path, *, voice: str | None = None, speed: float = 1.0,
        fmt: str = "mp3", url: str | None = None, token: str | None = None) -> dict:
    endpoint = url or os.environ.get("VCLI_TTS_URL")
    if not endpoint:
        raise VcliError(Codes.NETWORK, "未配置 TTS 接口（VCLI_TTS_URL 或 --url）",
                        hint="实现方式见 README「语音接口协议」，任何 HTTP 服务均可接入。")
    payload = {"text": text, "voice": voice or os.environ.get("VCLI_TTS_VOICE") or "default",
               "speed": speed, "format": fmt}
    body, ctype = _post(endpoint, payload, token or os.environ.get("VCLI_TTS_TOKEN"))
    out.parent.mkdir(parents=True, exist_ok=True)
    if ctype.startswith("audio/") or (body[:4] in (b"ID3\x03", b"RIFF", b"OggS") or body[:2] == b"\xff\xfb"):
        out.write_bytes(body)
        source = "binary"
    else:
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise VcliError(Codes.NETWORK, "TTS 返回既不是音频也不是 JSON", details=body[:400].decode("utf-8", "replace"))
        if data.get("audio_base64"):
            out.write_bytes(base64.b64decode(data["audio_base64"]))
            source = "base64"
        elif data.get("url"):
            try:
                with urllib.request.urlopen(data["url"], timeout=300) as resp:
                    out.write_bytes(resp.read())
            except (urllib.error.URLError, TimeoutError) as exc:
                raise VcliError(Codes.NETWORK, "TTS 音频下载失败", details=str(exc))
            source = "url"
        else:
            raise VcliError(Codes.NETWORK, "TTS JSON 缺少 audio_base64/url", details=data)
    info = probe(out)
    return {"ok": True, "output": str(out), "bytes": out.stat().st_size,
            "duration": info.get("duration"), "source": source}


def asr(media: Path, *, language: str = "auto", url: str | None = None,
        token: str | None = None) -> dict:
    endpoint = url or os.environ.get("VCLI_ASR_URL")
    if not endpoint:
        raise VcliError(Codes.NETWORK, "未配置 ASR 接口（VCLI_ASR_URL 或 --url）",
                        hint="实现方式见 README「语音接口协议」。")
    raw = media.read_bytes()
    payload = {"audio_base64": base64.b64encode(raw).decode("ascii"),
               "language": language, "format": "srt", "filename": media.name}
    body, _ = _post(endpoint, payload, token or os.environ.get("VCLI_ASR_TOKEN"))
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise VcliError(Codes.NETWORK, "ASR 返回不是 JSON", details=body[:400].decode("utf-8", "replace"))
    if data.get("srt"):
        return {"ok": True, "srt": data["srt"], "segments": None}
    segs = data.get("segments")
    if not isinstance(segs, list):
        raise VcliError(Codes.NETWORK, "ASR JSON 缺少 srt/segments", details=data)
    return {"ok": True, "srt": cues_to_srt(segs), "segments": segs}


def cues_to_srt(cues: list[dict]) -> str:
    def ts(sec: float) -> str:
        ms = int(round(max(0.0, float(sec)) * 1000))
        h, rem = divmod(ms, 3600000)
        m, rem = divmod(rem, 60000)
        s, ms = divmod(rem, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    rows = []
    for i, cue in enumerate(cues, 1):
        rows.append(f"{i}\n{ts(cue.get('start', 0))} --> {ts(cue.get('end', 0))}\n"
                    f"{str(cue.get('text', '')).strip()}\n")
    return "\n".join(rows)
