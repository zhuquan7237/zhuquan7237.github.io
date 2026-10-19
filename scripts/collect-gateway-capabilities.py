#!/usr/bin/env python3
"""Collect model names and capabilities from every gateway the desktop client
is configured with, and write them as a catalogue layer.

Why local: the capability catalogue's CI job can only read public directories
(models.dev, OpenRouter). A private gateway (CodeBuddy's pool, CPA, the relays
on this machine) publishes its own context window, output cap, image support
and reasoning levels in `/v1/models`, but reaching it needs the key — and keys
never leave this machine. So this script runs here, writes
`dl/capabilities-gateways.json`, and `build-capabilities.mjs` merges that file
as a layer above the public directories and below the hand-written overrides.

    python scripts/collect-gateway-capabilities.py           # write the layer
    python scripts/collect-gateway-capabilities.py --dry-run  # report only

Exit code 0 when at least one gateway answered; 1 when every gateway failed
(the caller must then keep the previous file instead of publishing an empty
layer).
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dl" / "capabilities-gateways.json"
TIMEOUT = 25

REGION_PREFIX = re.compile(r"^(?:cn|us|eu|sg|hk|jp|kr|tw|global|intl|oversea|overseas|cn2|gcp|aws|azure):", re.I)
SUFFIXES = re.compile(
    r"-(thinking|reasoning|non-thinking|high|low|medium|extra-low|mini-high|preview|beta|alpha|exp|"
    r"experimental|free|latest|instruct|chat|turbo)$",
    re.I,
)
LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}


def normalize(model_id: str) -> str:
    """Mirror model-vision's normalizeModelId so duplicates merge across routes."""
    value = str(model_id or "").strip().lower()
    value = re.sub(r"^[~@]+", "", value)
    value = REGION_PREFIX.sub("", value)
    value = re.sub(r":.*$", "", value)
    value = value.split("/")[-1] or value
    previous = None
    while previous != value:
        previous = value
        value = SUFFIXES.sub("", value)
    return re.sub(r"-{2,}", "-", re.sub(r"[._\s]+", "-", value)).strip("-")


def positive(value):
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def engine_levels(values):
    kept = []
    for value in values or []:
        text = str(value or "").strip().lower()
        if text in LEVELS and text not in kept:
            kept.append(text)
    return kept


def row_capabilities(row: dict):
    """Read the spellings gateways actually publish (mirrors upstreamCapabilities)."""
    raw = (
        (row.get("architecture") or {}).get("input_modalities")
        or row.get("input_modalities")
        or (row.get("capabilities") or {}).get("input")
        or row.get("modalities")
    )
    modalities = None
    if isinstance(raw, list):
        kept = [m for m in raw if m in ("text", "image")]
        if kept:
            modalities = list(dict.fromkeys(kept))
    if modalities is None:
        flag = row.get("supports_images", row.get("supports_vision", (row.get("capabilities") or {}).get("vision")))
        if flag is True:
            modalities = ["text", "image"]
        elif flag is False:
            modalities = ["text"]

    context = positive(
        row.get("context_length")
        or row.get("context_window")
        or row.get("max_context_length")
        or row.get("max_input_tokens")
        or row.get("max_allowed_size")
    )
    output = positive(
        row.get("max_output_tokens")
        or row.get("max_tokens")
        or (row.get("top_provider") or {}).get("max_completion_tokens")
    )

    reasoning = None
    options = row.get("reasoning_options") or row.get("reasoning_efforts") or row.get("reasoningEfforts")
    if isinstance(options, list):
        flattened = []
        for entry in options:
            if isinstance(entry, str):
                flattened.append(entry)
            elif isinstance(entry, dict) and isinstance(entry.get("values"), list):
                flattened.extend(entry["values"])
        levels = engine_levels(flattened)
        if levels:
            reasoning = levels
        elif options:
            reasoning = 1
    if reasoning is None:
        flag = row.get("reasoning", (row.get("capabilities") or {}).get("reasoning", row.get("supports_reasoning")))
        if flag is False:
            reasoning = 0
        elif flag is True:
            reasoning = 1
        elif isinstance(row.get("reasoning_effort"), str) and row["reasoning_effort"].strip():
            # A default effort proves reasoning but does not enumerate levels.
            reasoning = 1

    out = {"id": str(row.get("id") or "")}
    if modalities:
        out["modalities"] = modalities
    if context:
        out["context"] = context
    if output:
        out["output"] = output
    if reasoning is not None:
        out["reasoning"] = reasoning
    return out


def dsh_home() -> Path:
    settings = Path(os.environ.get("APPDATA", "")) / "DeepSeek" / "desktop-settings.json"
    if settings.exists():
        try:
            configured = json.loads(settings.read_text(encoding="utf-8")).get("dshHome")
            if configured:
                return Path(configured)
        except (OSError, ValueError):
            pass
    return Path(os.environ.get("APPDATA", "")) / "DeepSeek" / "dsh-home"


def load_yaml(path: Path):
    try:
        import yaml  # noqa: PLC0415 - optional at import time
    except ImportError:  # pragma: no cover - the scheduled runner has PyYAML
        raise SystemExit("PyYAML is required: python -m pip install pyyaml")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def providers(home: Path):
    """provider id -> {baseURL, apiKeyRef, models[]}, from every layer the engine reads."""
    found = {}
    for relative in ("profiles/web/cordis.patch.yml", "cordis.patch.yml"):
        path = home / relative
        if not path.exists():
            continue
        try:
            document = load_yaml(path)
        except Exception as error:  # noqa: BLE001 - a broken layer must not stop the other
            print(f"  ! {relative}: {error}", file=sys.stderr)
            continue
        stack = [document]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                section = node.get("providers")
                if isinstance(section, dict):
                    for name, entry in section.items():
                        if isinstance(entry, dict) and entry.get("baseURL"):
                            slot = found.setdefault(name, {
                                "baseURL": str(entry["baseURL"]),
                                "apiKeyRef": entry.get("apiKeyEnv") or entry.get("apiKeyRef"),
                                "models": [],
                            })
                            for model in entry.get("models") or []:
                                if isinstance(model, dict) and isinstance(model.get("id"), str):
                                    slot["models"].append(model["id"])
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return found


def credentials(home: Path):
    """apiKeyEnv -> value, from the engine's credential store plus the environment."""
    out = {}
    path = home / ".credentials.yaml"
    if path.exists():
        try:
            document = load_yaml(path)
            refs = document.get("refs") if isinstance(document, dict) else None
            if isinstance(refs, dict):
                for key, value in refs.items():
                    if isinstance(value, str) and value:
                        out[str(key)] = value
        except Exception as error:  # noqa: BLE001
            print(f"  ! credentials: {error}", file=sys.stderr)
    for key, value in os.environ.items():
        if value and key.endswith(("_API_KEY", "_KEY", "_TOKEN")):
            out.setdefault(key, value)
    return out


def probe(name: str, entry: dict, key: str | None):
    base = entry["baseURL"].rstrip("/")
    url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
    request = urllib.request.Request(url, headers={"user-agent": "dsh-capabilities-collector"})
    if key:
        request.add_header("authorization", f"Bearer {key}")
    started = time.time()
    payload = None
    last_error = ""
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                payload = json.loads(response.read().decode("utf-8", "replace"))
            break
        except urllib.error.HTTPError as error:
            return {"ok": False, "error": f"HTTP {error.code}", "models": [], "ms": int((time.time() - started) * 1000)}
        except Exception as error:  # noqa: BLE001 - timeouts, DNS, TLS: retry once, then give up
            last_error = str(error)[:160]
            if attempt == 0:
                time.sleep(1.5)
    if payload is None:
        return {"ok": False, "error": last_error, "models": [], "ms": int((time.time() - started) * 1000)}

    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        rows = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {"ok": False, "error": "no model list in reply", "models": [], "ms": int((time.time() - started) * 1000)}

    models = [caps for caps in (row_capabilities(row) for row in rows if isinstance(row, dict)) if caps["id"]]
    return {"ok": True, "error": "", "models": models, "ms": int((time.time() - started) * 1000)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="report without writing the layer")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    home = dsh_home()
    routes = providers(home)
    refs = credentials(home)
    if not routes:
        print(f"no providers found under {home}", file=sys.stderr)
        return 1

    results = {}
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = {}
        for name, entry in routes.items():
            ref = entry.get("apiKeyRef")
            key = refs.get(ref) if ref else None
            jobs[pool.submit(probe, name, entry, key)] = name
        for job in futures.as_completed(jobs):
            name = jobs[job]
            try:
                results[name] = job.result()
            except Exception as error:  # noqa: BLE001
                results[name] = {"ok": False, "error": str(error)[:160], "models": [], "ms": 0}

    # Merge by normalised id; a later route may state a field an earlier one
    # omitted, but never overwrite a stated value with silence.
    merged: dict[str, dict] = {}
    published: dict[str, set[str]] = {}
    for name in sorted(results):
        result = results[name]
        if not result["ok"]:
            continue
        for caps in result["models"]:
            identity = normalize(caps["id"])
            if not identity:
                continue
            published.setdefault(identity, set()).add(caps["id"])
            entry = merged.setdefault(identity, {"id": caps["id"]})
            for field in ("modalities", "context", "output", "reasoning"):
                if field in caps and field not in entry:
                    entry[field] = caps[field]

    # A model the client is configured with but its gateway does not publish
    # still deserves a row: without one, a variant cannot inherit its family's
    # levels and the client shows "unknown" forever.
    for name in sorted(routes):
        for mid in routes[name].get("models", []):
            identity = normalize(mid)
            if identity and identity not in merged:
                merged[identity] = {"id": mid}

    previous = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            previous = {normalize(row.get("id", "")): row for row in old.get("models", []) if isinstance(row, dict)}
            previous_at = old.get("generatedAt", "?")
        except ValueError:
            previous_at = "unreadable"
    else:
        previous_at = "none"

    ok = [name for name, result in results.items() if result["ok"]]
    failed = {name: result["error"] for name, result in results.items() if not result["ok"]}
    # Which spelling to print: keep yesterday's when the gateway still publishes
    # it, so a new route joining the pool does not look like a mass rename.
    for key, entry in merged.items():
        if previous.get(key, {}).get("id") in published.get(key, set()):
            entry["id"] = previous[key]["id"]
    added = sorted(merged[k]["id"] for k in merged.keys() - previous.keys())
    removed = sorted(previous[k]["id"] for k in previous.keys() - merged.keys())
    # A real rename is the old spelling disappearing while the model stays.
    renamed = sorted(
        f'{previous[k].get("id")} → {merged[k]["id"]}'
        for k in merged.keys() & previous.keys()
        if previous[k].get("id") and merged[k]["id"] != previous[k].get("id")
    )
    changed = sorted(
        merged[k]["id"]
        for k in merged.keys() & previous.keys()
        if any(merged[k].get(f) != previous[k].get(f) for f in ("modalities", "context", "output", "reasoning"))
    )

    volatile = bool(added or removed or renamed or changed)
    document = {
        "version": 1,
        # Keep the previous stamp when nothing moved: a timestamp-only rewrite
        # would commit and redeploy the catalogue every single day for nothing.
        "generatedAt": (
            datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            if volatile or previous_at in ("none", "unreadable", "?")
            else previous_at
        ),
        "source": "gateway /v1/models probe (scripts/collect-gateway-capabilities.py)",
        # `ms` is deliberately absent: latency is a report number, not data, and
        # including it made every run look like a change.
        "providers": {
            name: {"ok": result["ok"], "count": len(result["models"]), "error": result["error"]}
            for name, result in sorted(results.items())
        },
        "models": [merged[k] for k in sorted(merged)],
    }

    if not args.quiet:
        print(f"gateways : {len(ok)}/{len(results)} answered, {len(merged)} models")
        if failed:
            print("silent   : " + ", ".join(f"{name} ({error})" for name, error in sorted(failed.items())))
        print(f"previous : {previous_at} ({len(previous)} models)")
        if added:
            print(f"new      : {len(added)} — " + ", ".join(added[:25]) + (" …" if len(added) > 25 else ""))
        if removed:
            print(f"gone     : {len(removed)} — " + ", ".join(removed[:25]) + (" …" if len(removed) > 25 else ""))
        if renamed:
            print(f"renamed  : {len(renamed)} — " + ", ".join(renamed[:12]) + (" …" if len(renamed) > 12 else ""))
        if changed:
            print(f"changed  : {len(changed)} — " + ", ".join(changed[:25]) + (" …" if len(changed) > 25 else ""))

    if not ok:
        print("every gateway failed — keeping the previous layer", file=sys.stderr)
        return 1
    if args.dry_run or not merged:
        return 0 if merged else 1

    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote    : {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
