#!/usr/bin/env python3
"""
Validate a Zel's Hermes config: print the resolved values for every key
that participates in the "silent execution" profile (custom + official +
per-platform), plus a tier-check for evolution/whatsapp display defaults.

Run as the target Zel's user so HERMES_HOME and the cached config are read
from /home/<user>/.hermes:

    sudo -u adonai /opt/hermes/venv/bin/python3 validate-zel-config.py
    sudo -u simon  /opt/hermes/venv/bin/python3 validate-zel-config.py

Or override the home explicitly:

    HERMES_HOME=/home/simon/.hermes /opt/hermes/venv/bin/python3 validate-zel-config.py
"""
import sys, os, pathlib, argparse

VENV_SITE = "/opt/hermes/venv/lib/python3.13/site-packages"
sys.path.insert(0, VENV_SITE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--user",
        help="Override HERMES_HOME to /home/<user>/.hermes (use with caution; "
             "by default reads from current $HERMES_HOME or /root/.hermes).",
    )
    args = parser.parse_args()

    if args.user:
        os.environ["HERMES_HOME"] = f"/home/{args.user}/.hermes"

    hermes_home = pathlib.Path(os.environ.get("HERMES_HOME", "/root/.hermes"))
    print(f"HERMES_HOME = {hermes_home}")

    import gateway.run as gr
    gr._hermes_home = hermes_home
    cfg = gr._load_gateway_config()

    gw = cfg.get("gateway", {}) or {}
    print("\n=== GATEWAY (custom patches) ===")
    for k in ("suppress_busy_ack", "suppress_self_improvement",
              "suppress_heartbeat", "suppress_inactivity_warning"):
        print(f"  {k} = {gw.get(k)}")

    disp = cfg.get("display", {}) or {}
    print("\n=== DISPLAY (official Hermes) ===")
    for k in ("busy_ack_enabled", "busy_ack_detail", "busy_input_mode",
              "interim_assistant_messages", "long_running_notifications",
              "background_process_notifications", "show_reasoning",
              "streaming", "cleanup_progress"):
        print(f"  {k} = {disp.get(k)}")

    from gateway.display_config import resolve_display_setting
    print("\n=== resolved per-platform (evolution) ===")
    for k in ("tool_progress", "show_reasoning", "streaming",
              "cleanup_progress", "tool_preview_length"):
        print(f"  evolution.{k} = {resolve_display_setting(cfg, 'evolution', k)}")

    print("\n=== resolved per-platform (whatsapp) ===")
    for k in ("tool_progress", "show_reasoning", "streaming",
              "cleanup_progress", "tool_preview_length"):
        print(f"  whatsapp.{k} = {resolve_display_setting(cfg, 'whatsapp', k)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
