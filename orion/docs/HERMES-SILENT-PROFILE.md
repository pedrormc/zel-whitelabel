# Hermes Gateway — Silent Execution Profile

A canonical config + patch stack to eliminate Hermes' internal status
notifications on one-way / mobile channels (WhatsApp via Evolution,
Signal, SMS, etc.).

## Problem

Hermes is built around interactive terminal/Telegram UX where mid-turn
status updates, tool breadcrumbs, busy acknowledgments, heartbeats and
self-improvement notices are useful signal. On WhatsApp via Evolution
the same messages are pure noise — each one is a permanent line in the
user's chat history that they can't edit, can't dismiss, and didn't ask
for.

Concretely, the following system strings were leaking into the Adonai
Zel's WhatsApp before this profile was applied:

| String | Origin |
|--------|--------|
| `⚡ Interrupting current task` | `gateway/run.py:2724` |
| `⏳ Queued for the next turn` | `gateway/run.py:2719` |
| `⏩ Steered into current run` | `gateway/run.py:2714` |
| `💾 Self-improvement review: ...` | `run_agent.py:4466` → `_bg_review_send` |
| `⏳ Still working... (N min elapsed)` | `gateway/run.py:16046` |
| `⚠️ No activity for N min` | `gateway/run.py:16143` |
| Tool breadcrumb per tool call | `display.tool_progress` |
| Mid-turn assistant updates | `display.interim_assistant_messages` |
| Token streaming | `display.streaming` |
| Background process completions | `display.background_process_notifications` |

## Three-layer defense

### Layer 1 — Custom patches (`patches/patch-hermes-suppress-system-notifications.py`)

Adds four config-driven guards inside `gateway/run.py` (installed venv
copy, shared by all Zels). Each guard reads a flag from the per-Zel
`~/.hermes/config.yaml::gateway.*` block. Default false → original
Hermes behaviour preserved for Zels that don't opt in.

| Patch | Suppresses | Flag |
|-------|------------|------|
| A | busy-ack (interrupting/queued/steered) | `gateway.suppress_busy_ack` |
| B | self-improvement review | `gateway.suppress_self_improvement` |
| C | "Still working..." heartbeat | `gateway.suppress_heartbeat` |
| D | "No activity" inactivity warning | `gateway.suppress_inactivity_warning` |

Idempotent. Creates a timestamped backup. Runs `py_compile` to validate;
restores the backup automatically on syntax error.

### Layer 2 — Official Hermes flags (`display.*`)

Standard config keys already supported by Hermes. Native, future-proof,
no patching required:

```yaml
display:
  busy_ack_enabled: false                    # native equivalent of patch A
  busy_ack_detail: false
  busy_input_mode: queue                     # nicer than interrupt+ack on mobile
  interim_assistant_messages: false
  long_running_notifications: false
  background_process_notifications: error
  show_reasoning: false
  streaming: false
  cleanup_progress: false
```

### Layer 3 — Per-platform `display.platforms.<key>` overrides

Hermes' `display_config.resolve_display_setting()` looks up
`display.platforms.<platform>.<key>` first, then global `display.<key>`,
then a built-in tier default. The Evolution adapter registers itself as
`Platform("evolution")`, which is NOT in `_PLATFORM_DEFAULTS` —so it
falls back to `_GLOBAL_DEFAULTS` (`tool_progress: "all"`, the worst case
for WhatsApp). Set explicit overrides:

```yaml
display:
  platforms:
    evolution:
      tool_progress: off
      show_reasoning: false
      tool_preview_length: 0
      streaming: false
      cleanup_progress: false
    whatsapp:   # robust to adapter swap
      tool_progress: off
      show_reasoning: false
      tool_preview_length: 0
      streaming: false
      cleanup_progress: false
```

## Apply

### One-time bootstrap (shared venv — affects all Zels that opt in)

```bash
sudo python3 /opt/zel/orion/patches/patch-hermes-suppress-system-notifications.py
```

### Per Zel (opt-in by setting the flags)

```bash
sudo /opt/hermes/venv/bin/python3 /opt/zel/orion/scripts/apply-zel-silent-profile.py --user adonai
sudo /opt/hermes/venv/bin/python3 /opt/zel/orion/scripts/apply-zel-silent-profile.py --user simon
sudo systemctl restart hermes-gateway@adonai.service hermes-gateway@simon.service
```

### Validate

```bash
sudo -u adonai /opt/hermes/venv/bin/python3 /opt/zel/orion/scripts/validate-zel-config.py
sudo -u simon  /opt/hermes/venv/bin/python3 /opt/zel/orion/scripts/validate-zel-config.py
```

Expected output (per Zel):

```
=== GATEWAY (custom patches) ===
  suppress_busy_ack = True
  suppress_self_improvement = True
  suppress_heartbeat = True
  suppress_inactivity_warning = True

=== DISPLAY (official Hermes) ===
  busy_ack_enabled = False
  busy_input_mode = queue
  interim_assistant_messages = False
  long_running_notifications = False
  streaming = False
  ...

=== resolved per-platform (evolution) ===
  evolution.tool_progress = off
  evolution.streaming = False
  ...
```

## Reverting

The patch script keeps timestamped backups:

```bash
# Find the backup
ls /opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py.bak-zel-*

# Restore
sudo cp /opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py.bak-zel-<stamp> \
        /opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py
sudo systemctl restart hermes-gateway@<user>.service
```

Or simply set the four `gateway.suppress_*` flags back to `false` in the
Zel's `~/.hermes/config.yaml` — no code revert needed, since the guards
default to no-op when the flag is missing/false.

## Upgrade caveat

`/opt/hermes/venv/lib/python3.13/site-packages/gateway/run.py` is a pip
install copy. Any `pip install --upgrade hermes-agent` will overwrite
it. Re-run the patch script after every Hermes upgrade. Track this in
your post-upgrade checklist.

A future upstream PR could turn these into native Hermes flags
(`display.suppress_busy_ack` etc.) and the patches would no longer be
needed. Until then, the patch script + the official `display.*` flags
together give defense in depth: if the upgrade overwrites the patches,
the official flags still neutralize most noise (everything except the
self-improvement review and the inactivity warning have native
equivalents).

## Trade-offs

| What you lose | When it matters |
|---------------|-----------------|
| No "Interrupting current task" ack | User doesn't know their second message interrupted the first — mitigated by setting `busy_input_mode: queue` so it doesn't interrupt at all |
| No "Still working..." heartbeat | Long-running turns appear stuck — mitigated because the final response always arrives; users can use `/stop` if they really want to abort |
| No tool breadcrumbs | User can't see what tools fired — by design; the final response narrates the work |
| No mid-turn updates | Conversation feels "all-at-once" — appropriate for mobile chat |

If a Zel's user wants any of these back, flip the relevant flag in their
`config.yaml` and restart the gateway. The profile is granular — they
can opt out of individual items.

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full Orion architecture
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — common Hermes/Evolution issues
- `configs/silent-profile.example.yaml` — copy-paste reference
- Hermes upstream: [`cli-config.yaml.example`](https://github.com/nousresearch/hermes-agent) `display:` block
