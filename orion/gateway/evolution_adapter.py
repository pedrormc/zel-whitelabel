"""
Evolution API Gateway Adapter for Hermes Agent.

Registers as a native gateway platform so `hermes gateway run` handles
WhatsApp messages routed through Evolution API + Router.

Supports: text, audio (Groq Whisper STT), images (Groq Vision).
"""
import asyncio
import base64
import json
import logging
import os
import tempfile
from typing import Any, Dict, Optional

import aiohttp
from aiohttp import web

log = logging.getLogger("hermes.gateway.evolution")

EVOLUTION_URL = os.getenv("EVOLUTION_URL", "https://evolution.blackgroup-bia.shop")
EVOLUTION_INSTANCE = os.getenv("EVOLUTION_INSTANCE", "Zel3")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY", "")
BRIDGE_PORT = int(os.getenv("ZEL_BRIDGE_PORT", "3001"))
ALLOWED_PHONES = [p.strip() for p in os.getenv("ALLOWED_PHONES", "").split(",") if p.strip()]
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_VISION_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_STT_MODEL = "whisper-large-v3-turbo"
GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

try:
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        SendResult,
        SessionSource,
    )
    from gateway.platform_registry import platform_registry, PlatformEntry

    HAS_GATEWAY = True
except ImportError:
    HAS_GATEWAY = False


def _extract_message_type(payload: dict):
    """Extract message info and detect type (text, audio, image)."""
    d = payload.get("data", payload)
    k = d.get("key", {})
    jid = k.get("remoteJid", "")
    msg_id = k.get("id", "")
    if k.get("fromMe"):
        return None, None, None, None, None
    m = d.get("message", {})
    phone = jid.replace("@s.whatsapp.net", "")

    if m.get("audioMessage"):
        return jid, phone, "", "audio", msg_id
    if m.get("imageMessage"):
        caption = m.get("imageMessage", {}).get("caption", "")
        return jid, phone, caption, "image", msg_id
    if m.get("videoMessage"):
        caption = m.get("videoMessage", {}).get("caption", "")
        return jid, phone, caption, "video", msg_id

    text = (
        m.get("conversation")
        or m.get("extendedTextMessage", {}).get("text")
        or ""
    )
    return jid, phone, text.strip(), "text", msg_id


async def _download_media_base64(session: aiohttp.ClientSession, msg_id: str) -> Optional[str]:
    """Download media from Evolution API as base64."""
    url = f"{EVOLUTION_URL}/chat/getBase64FromMediaMessage/{EVOLUTION_INSTANCE}"
    headers = {"apikey": EVOLUTION_APIKEY, "Content-Type": "application/json"}
    body = {"message": {"key": {"id": msg_id}}, "convertToMp4": False}
    try:
        async with session.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            # Evolution API returns 201 Created for getBase64FromMediaMessage
            # (and 200 on older versions). Accept any 2xx.
            if resp.ok:
                data = await resp.json()
                return data.get("base64", None)
            body_preview = (await resp.text())[:300]
            log.error(f"Media download failed: status={resp.status} body={body_preview!r}")
            return None
    except Exception as e:
        log.error(f"Media download error: {e}")
        return None


async def _transcribe_audio(session: aiohttp.ClientSession, audio_b64: str) -> str:
    """Transcribe audio using Groq Whisper (free tier)."""
    if not GROQ_API_KEY:
        return "[audio recebido — transcricao indisponivel: GROQ_API_KEY nao configurada]"
    try:
        audio_bytes = base64.b64decode(audio_b64)
        data = aiohttp.FormData()
        data.add_field("file", audio_bytes, filename="audio.ogg", content_type="audio/ogg")
        data.add_field("model", GROQ_STT_MODEL)
        data.add_field("language", "pt")
        data.add_field("response_format", "json")
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
        async with session.post(GROQ_STT_URL, data=data, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
            if resp.status == 200:
                result = await resp.json()
                text = result.get("text", "").strip()
                log.info(f"Whisper transcribed: {text[:60]}...")
                return text if text else "[audio sem fala detectada]"
            body = await resp.text()
            log.error(f"Whisper error {resp.status}: {body[:200]}")
            return f"[audio recebido — erro na transcricao: {resp.status}]"
    except Exception as e:
        log.error(f"Whisper exception: {e}")
        return f"[audio recebido — erro: {e}]"


async def _describe_image(session: aiohttp.ClientSession, image_b64: str, caption: str = "") -> str:
    """Describe image using Groq Vision (free tier)."""
    if not GROQ_API_KEY:
        return "[imagem recebida — visao indisponivel: GROQ_API_KEY nao configurada]"
    try:
        prompt = "Descreva esta imagem em detalhe, em portugues brasileiro. Seja objetivo."
        if caption:
            prompt = f"O usuario enviou esta imagem com a legenda: '{caption}'. Descreva o conteudo da imagem em detalhe, em portugues brasileiro."
        content = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
        body = {
            "model": GROQ_VISION_MODEL,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 500,
        }
        async with session.post(GROQ_VISION_URL, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status == 200:
                result = await resp.json()
                desc = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                log.info(f"Vision described: {desc[:60]}...")
                return desc if desc else "[imagem sem descricao]"
            body_text = await resp.text()
            log.error(f"Vision error {resp.status}: {body_text[:200]}")
            return f"[imagem recebida — erro na analise: {resp.status}]"
    except Exception as e:
        log.error(f"Vision exception: {e}")
        return f"[imagem recebida — erro: {e}]"


if HAS_GATEWAY:

    class EvolutionAdapter(BasePlatformAdapter):
        """Receive WhatsApp messages via Evolution API webhooks, reply via Evolution REST.
        Supports text, audio (Groq Whisper), and images (Groq Vision)."""

        name = "evolution"
        label = "Evolution WhatsApp"

        def __init__(self, config=None, platform=None):
            if platform is None:
                from gateway.config import Platform
                platform = Platform("evolution")
            super().__init__(config, platform)
            self._app: Optional[web.Application] = None
            self._runner: Optional[web.AppRunner] = None
            self._site: Optional[web.TCPSite] = None
            self._session: Optional[aiohttp.ClientSession] = None
            self._background_tasks: set = set()

        async def connect(self) -> bool:
            self._session = aiohttp.ClientSession()
            self._app = web.Application()
            self._app.router.add_post("/", self._handle_webhook)
            self._app.router.add_get("/", self._handle_health)
            self._app.router.add_get("/health", self._handle_health)

            self._runner = web.AppRunner(self._app, access_log=None)
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, "127.0.0.1", BRIDGE_PORT)
            await self._site.start()
            media = []
            if GROQ_API_KEY:
                media.append("audio(whisper)")
                media.append("image(vision)")
            log.info(f"Evolution adapter listening on 127.0.0.1:{BRIDGE_PORT} media={media or 'text-only'}")
            return True

        async def disconnect(self) -> None:
            if self._site:
                await self._site.stop()
            if self._runner:
                await self._runner.cleanup()
            if self._session:
                await self._session.close()
            log.info("Evolution adapter disconnected")

        async def send(
            self,
            chat_id: str,
            content: str,
            reply_to: Optional[str] = None,
            metadata: Optional[Dict[str, Any]] = None,
        ) -> SendResult:
            if not EVOLUTION_APIKEY:
                log.error("EVOLUTION_APIKEY not set")
                return SendResult(success=False, message_id=None)
            phone = chat_id.replace("@s.whatsapp.net", "")
            url = f"{EVOLUTION_URL}/message/sendText/{EVOLUTION_INSTANCE}"
            headers = {"apikey": EVOLUTION_APIKEY, "Content-Type": "application/json"}
            body = {"number": phone, "text": content}
            try:
                async with self._session.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    status = resp.status
                    log.info(f"Evolution -> {phone[:8]}... status={status}")
                    return SendResult(success=(status == 201), message_id=None)
            except Exception as e:
                log.error(f"Evolution send error: {e}")
                return SendResult(success=False, message_id=None)

        async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
            phone = chat_id.replace("@s.whatsapp.net", "")
            return {"name": phone, "type": "dm"}

        async def _handle_health(self, request: web.Request) -> web.Response:
            return web.json_response({
                "status": "ok",
                "platform": "evolution",
                "engine": "hermes-gateway",
                "port": BRIDGE_PORT,
                "media": {"audio": bool(GROQ_API_KEY), "image": bool(GROQ_API_KEY)},
            })

        async def _handle_webhook(self, request: web.Request) -> web.Response:
            try:
                payload = await request.json()
            except Exception:
                return web.json_response({"status": "bad_request"}, status=400)

            jid, phone, text, msg_type, msg_id = _extract_message_type(payload)
            if not jid:
                return web.json_response({"status": "ignored"})

            if ALLOWED_PHONES and phone not in ALLOWED_PHONES:
                log.info(f"FILTERED {phone} (not in ALLOWED_PHONES)")
                return web.json_response({"status": "filtered"})

            if msg_type == "audio" and msg_id:
                log.info(f"AUDIO {phone}: downloading and transcribing...")
                b64 = await _download_media_base64(self._session, msg_id)
                if b64:
                    text = await _transcribe_audio(self._session, b64)
                else:
                    text = "[audio recebido — nao foi possivel baixar a midia]"
                log.info(f"AUDIO->TEXT {phone}: {text[:80]}")

            elif msg_type == "image" and msg_id:
                log.info(f"IMAGE {phone}: downloading and describing...")
                b64 = await _download_media_base64(self._session, msg_id)
                if b64:
                    description = await _describe_image(self._session, b64, text)
                    text = f"[O usuario enviou uma imagem. Descricao: {description}]"
                    if text:
                        text += f"\n[Legenda do usuario: {text}]"
                else:
                    text = "[imagem recebida — nao foi possivel baixar a midia]"
                log.info(f"IMAGE->TEXT {phone}: {text[:80]}")

            elif msg_type == "video":
                text = text or "[video recebido — transcricao de video nao suportada ainda]"

            if not text:
                return web.json_response({"status": "ignored"})

            log.info(f"MSG({msg_type}) {phone}: {text[:80]}")

            from gateway.config import Platform
            event = MessageEvent(
                text=text,
                message_type=MessageType.TEXT,
                source=SessionSource(
                    chat_id=jid,
                    user_id=phone,
                    user_name=phone,
                    platform=Platform("evolution"),
                ),
                raw_message=payload,
                message_id=f"evo-{phone}-{id(payload)}",
            )

            task = asyncio.create_task(self._process(event))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)

            return web.json_response({"status": "received"})

        async def _process(self, event: MessageEvent):
            try:
                await self.handle_message(event)
            except Exception as e:
                log.error(f"Process error: {e}", exc_info=True)

    def register_evolution():
        platform_registry.register(
            PlatformEntry(
                name="evolution",
                label="Evolution WhatsApp",
                adapter_factory=lambda cfg: EvolutionAdapter(cfg),
                check_fn=lambda: bool(EVOLUTION_APIKEY),
                validate_config=lambda cfg: True,
                required_env=["EVOLUTION_APIKEY"],
                install_hint="Set EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY in .env",
                platform_hint="WhatsApp via Evolution API — text, audio (Whisper), images (Vision)",
            )
        )

    register_evolution()
    log.info("Evolution gateway adapter registered (media support: audio+image)")
