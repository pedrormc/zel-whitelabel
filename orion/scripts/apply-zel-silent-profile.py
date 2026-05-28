#!/usr/bin/env python3
"""
Apply the "silent execution" profile to a Zel's Hermes config.yaml.

This sets the canonical block of options that minimize gateway noise on
one-way / mobile channels (WhatsApp via Evolution, Signal, SMS, etc.):

    * Custom gateway.suppress_* flags (require patch-hermes-suppress-system-notifications.py)
    * Official Hermes display.* flags (busy_ack_enabled, busy_input_mode, ...)
    * Per-platform display.platforms.{evolution,whatsapp}.* overrides

Idempotent: deep-merges into the existing config, only writes when something
actually changes. Backs up the config with a timestamp before writing.

Usage:
    sudo /opt/hermes/venv/bin/python3 apply-zel-silent-profile.py --user adonai
    sudo /opt/hermes/venv/bin/python3 apply-zel-silent-profile.py --user simon
    sudo /opt/hermes/venv/bin/python3 apply-zel-silent-profile.py --config /custom/path/config.yaml

After applying, restart the gateway:
    systemctl restart hermes-gateway@<user>.service
"""
import pathlib, datetime, shutil, sys, argparse, yaml

# Canonical silent profile (deep-merged into the target config).
PROFILE = {
    "gateway": {
        # Custom patches — require patch-hermes-suppress-system-notifications.py
        "suppress_busy_ack": True,
        "suppress_self_improvement": True,
        "suppress_heartbeat": True,
        "suppress_inactivity_warning": True,
    },
    "display": {
        # Official Hermes flags
        "busy_ack_enabled": False,
        "busy_ack_detail": False,
        "busy_input_mode": "queue",
        "interim_assistant_messages": False,
        "long_running_notifications": False,
        "background_process_notifications": "error",
        "cleanup_progress": False,
        "show_reasoning": False,
        "streaming": False,
        "platforms": {
            "evolution": {
                "tool_progress": "off",
                "show_reasoning": False,
                "tool_preview_length": 0,
                "streaming": False,
                "cleanup_progress": False,
            },
            "whatsapp": {
                "tool_progress": "off",
                "show_reasoning": False,
                "tool_preview_length": 0,
                "streaming": False,
                "cleanup_progress": False,
            },
        },
    },
}


def deep_merge(base: dict, patch: dict) -> tuple[dict, bool]:
    """Merge patch into base. Returns (merged, changed)."""
    changed = False
    for k, v in patch.items():
        if isinstance(v, dict):
            sub_base = base.get(k)
            if not isinstance(sub_base, dict):
                base[k] = {}
                sub_base = base[k]
                changed = True
            sub_merged, sub_changed = deep_merge(sub_base, v)
            base[k] = sub_merged
            changed = changed or sub_changed
        else:
            if base.get(k) != v:
                base[k] = v
                changed = True
    return base, changed


def resolve_config_path(args) -> pathlib.Path:
    if args.config:
        return pathlib.Path(args.config)
    if args.user:
        return pathlib.Path(f"/home/{args.user}/.hermes/config.yaml")
    raise SystemExit("ERROR: must provide --user or --config")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--user", help="Zel username (resolves /home/<user>/.hermes/config.yaml)")
    parser.add_argument("--config", help="Explicit path to config.yaml (overrides --user)")
    parser.add_argument("--dry-run", action="store_true", help="Print resulting config without writing")
    args = parser.parse_args()

    cfg_path = resolve_config_path(args)
    if not cfg_path.exists():
        print(f"FATAL: {cfg_path} not found")
        return 1

    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backup = cfg_path.with_suffix(cfg_path.suffix + f".bak-silent-{stamp}")

    with open(cfg_path) as f:
        cfg = yaml.safe_load(f) or {}

    merged, changed = deep_merge(cfg, PROFILE)

    if args.dry_run:
        print(yaml.safe_dump(merged, sort_keys=False, default_flow_style=False, allow_unicode=True))
        print(f"\n[dry-run] would{' ' if changed else ' NOT '}write changes to {cfg_path}")
        return 0

    if not changed:
        print(f"NO CHANGES — silent profile already applied to {cfg_path}")
        return 0

    shutil.copy2(cfg_path, backup)
    print(f"BACKUP: {backup}")

    with open(cfg_path, "w") as f:
        yaml.safe_dump(merged, f, sort_keys=False, default_flow_style=False, allow_unicode=True)
    print(f"WROTE: {cfg_path}")

    print("\n--- gateway block ---")
    print(yaml.safe_dump({"gateway": merged.get("gateway")}, sort_keys=False, default_flow_style=False, allow_unicode=True))
    print("--- display block (keys touched) ---")
    disp = merged.get("display") or {}
    keys_touched = ("busy_ack_enabled", "busy_ack_detail", "busy_input_mode",
                    "interim_assistant_messages", "long_running_notifications",
                    "background_process_notifications", "cleanup_progress",
                    "show_reasoning", "streaming", "platforms")
    subset = {k: disp[k] for k in keys_touched if k in disp}
    print(yaml.safe_dump({"display": subset}, sort_keys=False, default_flow_style=False, allow_unicode=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
