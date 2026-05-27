"""
Evolution API Gateway Adapter for Hermes Agent.

Registers as a native gateway platform so `hermes gateway run` handles
WhatsApp messages routed through Evolution API + Router.

Architecture:
  Evolution API (Zel3) → Router (Droplet) → this adapter (HTTP) → Hermes Agent → reply via Evolution
"""
import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional

import aiohttp
from aiohttp import web

log = logging.getLogger("hermes.gateway.evolution")

EVOLUTION_URL = os.getenv("EVOLUTION_URL", "https://evolution.blackgroup-bia.shop")
EVOLUTION_INSTANCE = os.getenv("EVOLUTION_INSTANCE", "Zel3")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY", "")
BRIDGE_PORT = int(os.getenv("ZEL_BRIDGE_PORT", "3001"))

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


def _extract_message(payload: dict):
    d = payload.get("data", payload)
    k = d.get("key", {})
    jid = k.get("remoteJid", "")
    if k.get("fromMe"):
        return None, None, None
    m = d.get("message", {})
    text = (
        m.get("conversation")
        or m.get("extendedTextMessage", {}).get("text")
        or m.get("imageMessage", {}).get("caption")
        or ""
    )
    if m.get("audioMessage"):
        text = "[audio recebido]"
    phone = jid.replace("@s.whatsapp.net", "")
    return jid, phone, text.strip()


if HAS_GATEWAY:

    class EvolutionAdapter(BasePlatformAdapter):
        """Receive WhatsApp messages via Evolution API webhooks, reply via Evolution REST."""

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
            log.info(f"Evolution adapter listening on 127.0.0.1:{BRIDGE_PORT}")
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
            })

        async def _handle_webhook(self, request: web.Request) -> web.Response:
            try:
                payload = await request.json()
            except Exception:
                return web.json_response({"status": "bad_request"}, status=400)

            jid, phone, text = _extract_message(payload)
            if not jid or not text:
                return web.json_response({"status": "ignored"})

            log.info(f"MSG {phone}: {text[:80]}")

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
                platform_hint="WhatsApp via Evolution API — shared number with Router",
            )
        )

    register_evolution()
    log.info("Evolution gateway adapter registered")
