#!/usr/bin/env python3
"""
Hermes gateway — suppress system notifications (zel-agnostic).

Adds 4 config-driven guards to the Hermes gateway run loop that prevent
internal status messages from leaking into the user's chat channel
(WhatsApp via Evolution, Telegram, etc.):

    A) "⚡ Interrupting current task" / "⏳ Queued" / "⏩ Steered" (busy-ack)
    B) "💾 Self-improvement review: ..." (background memory review callback)
    C) "⏳ Still working... (N min elapsed)" (long-running heartbeat)
    D) "⚠️ No activity for N min" (inactivity warning)

Each guard reads a per-user flag from ~/.hermes/config.yaml::gateway.*
(default: false → original Hermes behaviour preserved):

    gateway:
      suppress_busy_ack: true
      suppress_self_improvement: true
      suppress_heartbeat: true
      suppress_inactivity_warning: true

Edits the *installed* venv copy of gateway/run.py shared by all instances
(/opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py). Each Zel
opts in via its own config.yaml.

Idempotent: re-running does not duplicate the inserts. Creates a timestamped
backup and runs ``python -m py_compile`` to validate before keeping the new
file. On syntax error, restores the backup automatically.

Usage:
    sudo python3 patch-hermes-suppress-system-notifications.py

Upgrade resilience: Hermes upgrades will overwrite the patched file. Re-run
this script after any ``pip install --upgrade hermes-agent``.
"""
import pathlib, shutil, datetime, subprocess, sys, os

TARGET = pathlib.Path(
    os.environ.get(
        "HERMES_GATEWAY_RUN_PATH",
        "/opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py",
    )
)

# ---------- PATCH A: busy-ack guard ----------
NEEDLE_A = (
    "        status_detail = f\" ({', '.join(status_parts)})\" if status_parts else \"\"\n"
    "        if is_steer_mode:"
)
INJECT_A = (
    "        status_detail = f\" ({', '.join(status_parts)})\" if status_parts else \"\"\n"
    "\n"
    "        # ZEL-PATCH: per-user opt-out for busy-ack messages\n"
    "        # (\"⚡ Interrupting current task\", \"⏳ Queued\", \"⏩ Steered\").\n"
    "        # Controlled via ~/.hermes/config.yaml -> gateway.suppress_busy_ack: true\n"
    "        try:\n"
    "            _zel_gw_cfg = _load_gateway_config().get(\"gateway\", {}) or {}\n"
    "            if _zel_gw_cfg.get(\"suppress_busy_ack\", False):\n"
    "                logger.debug(\"[busy-ack] suppressed via gateway.suppress_busy_ack=true\")\n"
    "                return True\n"
    "        except Exception:\n"
    "            pass\n"
    "\n"
    "        if is_steer_mode:"
)

# ---------- PATCH B: bg-review guard ----------
NEEDLE_B = (
    "            def _bg_review_send(message: str) -> None:\n"
    "                if not _status_adapter or not _run_still_current():\n"
    "                    return\n"
    "                if not _bg_review_release.is_set():"
)
INJECT_B = (
    "            def _bg_review_send(message: str) -> None:\n"
    "                if not _status_adapter or not _run_still_current():\n"
    "                    return\n"
    "                # ZEL-PATCH: per-user opt-out for\n"
    "                # \"💾 Self-improvement review: ...\" notifications.\n"
    "                # Controlled via ~/.hermes/config.yaml -> gateway.suppress_self_improvement: true\n"
    "                try:\n"
    "                    _zel_gw_cfg = _load_gateway_config().get(\"gateway\", {}) or {}\n"
    "                    if _zel_gw_cfg.get(\"suppress_self_improvement\", False):\n"
    "                        logger.debug(\"[bg-review] suppressed via gateway.suppress_self_improvement=true\")\n"
    "                        return\n"
    "                except Exception:\n"
    "                    pass\n"
    "                if not _bg_review_release.is_set():"
)

# ---------- PATCH C: heartbeat "Still working..." guard ----------
NEEDLE_C = (
    "                try:\n"
    "                    _notify_res = await _notify_adapter.send(\n"
    "                        source.chat_id,\n"
    "                        f\"⏳ Still working... ({_elapsed_mins} min elapsed{_status_detail})\",\n"
    "                        metadata=_status_thread_metadata,\n"
    "                    )"
)
INJECT_C = (
    "                # ZEL-PATCH: per-user opt-out for\n"
    "                # \"⏳ Still working... (N min elapsed)\" heartbeat.\n"
    "                # Controlled via ~/.hermes/config.yaml -> gateway.suppress_heartbeat: true\n"
    "                try:\n"
    "                    _zel_gw_cfg = _load_gateway_config().get(\"gateway\", {}) or {}\n"
    "                    if _zel_gw_cfg.get(\"suppress_heartbeat\", False):\n"
    "                        logger.debug(\"[heartbeat] suppressed via gateway.suppress_heartbeat=true\")\n"
    "                        return\n"
    "                except Exception:\n"
    "                    pass\n"
    "                try:\n"
    "                    _notify_res = await _notify_adapter.send(\n"
    "                        source.chat_id,\n"
    "                        f\"⏳ Still working... ({_elapsed_mins} min elapsed{_status_detail})\",\n"
    "                        metadata=_status_thread_metadata,\n"
    "                    )"
)

# ---------- PATCH D: inactivity warning guard ----------
NEEDLE_D = (
    "                        if _warn_adapter:\n"
    "                            _elapsed_warn = int(_agent_warning // 60) or 1\n"
    "                            _remaining_mins = int((_agent_timeout - _agent_warning) // 60) or 1\n"
    "                            try:\n"
    "                                await _warn_adapter.send(\n"
    "                                    source.chat_id,\n"
    "                                    f\"⚠️ No activity for {_elapsed_warn} min. \"\n"
    "                                    f\"If the agent does not respond soon, it will \"\n"
    "                                    f\"be timed out in {_remaining_mins} min. \"\n"
    "                                    f\"You can continue waiting or use /reset.\","
)
INJECT_D = (
    "                        if _warn_adapter:\n"
    "                            # ZEL-PATCH: per-user opt-out for\n"
    "                            # \"⚠️ No activity for N min\" inactivity warning.\n"
    "                            # Controlled via ~/.hermes/config.yaml -> gateway.suppress_inactivity_warning: true\n"
    "                            try:\n"
    "                                _zel_gw_cfg = _load_gateway_config().get(\"gateway\", {}) or {}\n"
    "                                if _zel_gw_cfg.get(\"suppress_inactivity_warning\", False):\n"
    "                                    logger.debug(\"[inactivity-warn] suppressed via gateway.suppress_inactivity_warning=true\")\n"
    "                                    _warn_adapter = None\n"
    "                            except Exception:\n"
    "                                pass\n"
    "                        if _warn_adapter:\n"
    "                            _elapsed_warn = int(_agent_warning // 60) or 1\n"
    "                            _remaining_mins = int((_agent_timeout - _agent_warning) // 60) or 1\n"
    "                            try:\n"
    "                                await _warn_adapter.send(\n"
    "                                    source.chat_id,\n"
    "                                    f\"⚠️ No activity for {_elapsed_warn} min. \"\n"
    "                                    f\"If the agent does not respond soon, it will \"\n"
    "                                    f\"be timed out in {_remaining_mins} min. \"\n"
    "                                    f\"You can continue waiting or use /reset.\","
)

PATCHES = [
    ("A", "suppress_busy_ack", NEEDLE_A, INJECT_A),
    ("B", "suppress_self_improvement", NEEDLE_B, INJECT_B),
    ("C", "suppress_heartbeat", NEEDLE_C, INJECT_C),
    ("D", "suppress_inactivity_warning", NEEDLE_D, INJECT_D),
]


def main() -> int:
    if not TARGET.exists():
        print(f"FATAL: {TARGET} not found")
        return 1
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backup = TARGET.with_suffix(TARGET.suffix + f".bak-zel-{stamp}")
    shutil.copy2(TARGET, backup)
    print(f"BACKUP: {backup}")

    src = TARGET.read_text()
    changed = False

    for letter, flag_key, needle, inject in PATCHES:
        sentinel = f"gateway.{flag_key}: true"
        if sentinel in src:
            print(f"PATCH {letter} ({flag_key}): already applied")
            continue
        if needle not in src:
            print(f"PATCH {letter} ({flag_key}): NEEDLE NOT FOUND — skip")
            continue
        src = src.replace(needle, inject, 1)
        print(f"PATCH {letter} ({flag_key}): applied")
        changed = True

    if not changed:
        print("NO CHANGES (all patches already applied)")
        return 0

    TARGET.write_text(src)
    print("WRITE OK")

    r = subprocess.run(
        ["python3", "-m", "py_compile", str(TARGET)],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print("SYNTAX ERROR — restoring backup")
        print(r.stderr)
        shutil.copy2(backup, TARGET)
        return 4
    print("SYNTAX OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
