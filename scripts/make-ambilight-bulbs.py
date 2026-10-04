"""Writes ambilight-bulbs.json for the Tizen ambilight from a tinytuya folder.

The folder is the one that holds devices.json (from `python -m tinytuya wizard`), bulbs.py with
EXCLUDE_NAMES / EXCLUDE_IPS / POSITIONS, and optionally bulb_ips.json (last seen addresses) and
positions.json (positions picked in the PC hub). Excluded devices are never written. Only
protocol 3.3 bulbs are supported by the TV.

The output holds the bulbs' local keys: it is git-ignored and must never be shared. The app's
Ambilight settings decide each bulb's position (left / center / right / off); the position written
here is only the starting value, and bulbs the PC hub has not seen lately start as off.

    python scripts/make-ambilight-bulbs.py --tuya-dir "D:\\06 ai\\Projects\\tuya"
"""
import argparse
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSITIONS = ("left", "center", "right")


def literal(bulbs_py, name, default):
    """Value of a top-level NAME = <literal> assignment in bulbs.py, without importing it."""
    if not bulbs_py.exists():
        return default
    tree = ast.parse(bulbs_py.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None) == name:
            return ast.literal_eval(node.value)
    return default


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def colour_format(dev):
    """DP 5's format from the wizard's data point list, as bulbs.py decides it: colour_data_v2 means
    hhhhssssvvvv (0-1000), colour_data the classic rrggbbhhhhssvv. "" when unknown (the TV then
    reads it from the bulb's own status)."""
    mapping = dev.get("mapping") if isinstance(dev.get("mapping"), dict) else {}
    code = (mapping.get("5") or {}).get("code") if isinstance(mapping.get("5"), dict) else ""
    return {"colour_data_v2": "hsv16", "colour_data": "rgb8"}.get(code or "", "")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tuya-dir", required=True, type=Path, help="folder with devices.json and bulbs.py")
    parser.add_argument("--out", type=Path, default=ROOT / "ambilight-bulbs.json")
    args = parser.parse_args()
    tuya = args.tuya_dir

    bulbs_py = tuya / "bulbs.py"
    exclude_names = [n.lower() for n in literal(bulbs_py, "EXCLUDE_NAMES", [])] + ["groei"]
    exclude_ips = set(literal(bulbs_py, "EXCLUDE_IPS", []))
    positions = {k.lower(): v for k, v in literal(bulbs_py, "POSITIONS", {}).items()}
    positions.update({k.lower(): v for k, v in read_json(tuya / "positions.json", {}).items()})
    cache = read_json(tuya / "bulb_ips.json", {})
    active = set(cache.get("_last_active", []))

    bulbs = []
    for dev in read_json(tuya / "devices.json", []):
        name = dev.get("name") or dev["id"]
        seen = cache.get(dev["id"]) if isinstance(cache.get(dev["id"]), dict) else {}
        ip = seen.get("ip") or dev.get("ip") or ""
        version = str(seen.get("ver") or dev.get("version") or "")
        if ip in exclude_ips or any(x in name.lower() for x in exclude_names):
            print("skipping %s: excluded" % name)
            continue
        if not dev.get("key") or not ip:
            print("skipping %s: no local key or address" % name)
            continue
        if version and not version.startswith("3.3"):
            print("skipping %s: protocol %s is not supported on the TV (only 3.3)" % (name, version))
            continue
        lower = name.lower()
        position = positions.get(lower) or ("left" if "left" in lower else "right" if "right" in lower else "center")
        if position not in POSITIONS:
            position = "center"
        if active and dev["id"] not in active:
            position = "off"  # not seen by the PC hub lately (unplugged?): switch it on in the app
        entry = {"name": name, "id": dev["id"], "key": dev["key"], "ip": ip, "pos": position}
        fmt = colour_format(dev)
        if fmt:
            entry["format"] = fmt
        bulbs.append(entry)
        print("bulb %-14s %-15s starts on %-6s colour format %s" % (name, ip, position, fmt or "from the bulb"))

    args.out.write_text(json.dumps(bulbs, indent=1), encoding="utf-8")
    print("wrote %s with %d bulb(s); keep it private, it holds local keys" % (args.out, len(bulbs)))


if __name__ == "__main__":
    main()
