#!/usr/bin/env python3
"""
Set the fallback provider chain on a Zel's Hermes config.

When the primary model (claude-opus-4-7 by default) returns rate-limit
or overload errors, Hermes will automatically try the next provider in
the chain instead of bubbling the error up to the user.

Default chain: Opus 4.7 → Sonnet 4.6 → Haiku 4.5 (all on Anthropic).
Override with --chain "model1@provider1,model2@provider2,...".

Idempotent: timestamped backup, only writes when chain actually changes.

Usage:
    sudo /opt/hermes/venv/bin/python3 apply-zel-fallback-chain.py --user adonai
    sudo /opt/hermes/venv/bin/python3 apply-zel-fallback-chain.py --user simon \
        --chain "claude-sonnet-4-6@anthropic,claude-haiku-4-5@anthropic"
"""
import pathlib, datetime, shutil, sys, argparse, yaml

DEFAULT_CHAIN = [
    {"provider": "anthropic", "model": "claude-sonnet-4-6"},
    {"provider": "anthropic", "model": "claude-haiku-4-5"},
]


def parse_chain(spec: str) -> list[dict]:
    chain = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "@" not in entry:
            raise SystemExit(f"Bad chain entry {entry!r} — expected 'model@provider'")
        model, provider = entry.split("@", 1)
        chain.append({"provider": provider.strip(), "model": model.strip()})
    return chain


def resolve_path(args) -> pathlib.Path:
    if args.config:
        return pathlib.Path(args.config)
    if args.user:
        return pathlib.Path(f"/home/{args.user}/.hermes/config.yaml")
    raise SystemExit("ERROR: must provide --user or --config")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--user", help="Zel username")
    parser.add_argument("--config", help="Explicit config.yaml path")
    parser.add_argument(
        "--chain",
        help="Comma-separated list of 'model@provider' entries. "
             "Default: claude-sonnet-4-6@anthropic,claude-haiku-4-5@anthropic",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cfg_path = resolve_path(args)
    if not cfg_path.exists():
        print(f"FATAL: {cfg_path} not found")
        return 1

    chain = parse_chain(args.chain) if args.chain else DEFAULT_CHAIN

    with open(cfg_path) as f:
        cfg = yaml.safe_load(f) or {}

    current = cfg.get("fallback_providers") or []
    if current == chain:
        print(f"NO CHANGES — fallback chain already set on {cfg_path}")
        return 0

    if args.dry_run:
        print("Would write fallback_providers:")
        print(yaml.safe_dump(chain, default_flow_style=False))
        return 0

    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backup = cfg_path.with_suffix(cfg_path.suffix + f".bak-fallback-{stamp}")
    shutil.copy2(cfg_path, backup)
    print(f"BACKUP: {backup}")

    cfg["fallback_providers"] = chain
    if "fallback_model" in cfg:
        cfg.pop("fallback_model")  # drop legacy single-dict key

    with open(cfg_path, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False, allow_unicode=True)
    print(f"WROTE: {cfg_path}")
    print("\nfallback_providers chain:")
    print(yaml.safe_dump(chain, default_flow_style=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
