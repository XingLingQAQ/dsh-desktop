#!/usr/bin/env python3
"""Sample the pet's session-state route and report the transitions it goes through.

This is the check that matters for phase 2: it is the difference between "the
mapping function looks right" and "a real turn actually moves the pet". The
route is read directly rather than through the pet window, so a failure here is
a host-side failure and not a rendering one.
"""
import json
import sys
import time
import urllib.request

LIST = "http://127.0.0.1:9222/json"


def host_base():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            u = t.get("url", "")
            if u.startswith("http://127.0.0.1:"):
                return u.split("/?")[0].rstrip("/")
    return None


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    base = host_base()
    if base is None:
        print("no host")
        return 2
    url = base + "/dsh-desktop-pet/state"
    print("sampling", url)
    deadline = time.time() + seconds
    last = None
    seen = []
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                state = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            time.sleep(0.3)
            continue
        key = (state.get("activity"), state.get("tool"), state.get("turn"),
               (state.get("lastEnd") or {}).get("kind"),
               (state.get("lastEnd") or {}).get("code"))
        if key != last:
            stamp = time.strftime("%H:%M:%S")
            print(f"  {stamp}  activity={state.get('activity'):8s} tool={state.get('tool')} "
                  f"turn={state.get('turn')} end={key[3]}/{key[4]} "
                  f"title={json.dumps(state.get('title'), ensure_ascii=False)[:40]}")
            seen.append(key)
            last = key
        time.sleep(0.25)
    print("distinct states:", len(seen))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
