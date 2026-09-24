#!/usr/bin/env python3
"""Report the host's session state and the pet's face at the same moment.

The two are separate links — the host publishes, the shell relays, the pet
renders — and printing them together is what makes a divergence obvious instead
of something to be worked out from two logs.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"

MOOD = ("(() => { const r = document.querySelector('.pet-root');"
        " return r ? r.getAttribute('data-mood') : null; })()")


def main():
    base = None
    pet = None
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            u = t.get("url", "")
            if u.startswith("http://127.0.0.1:") and base is None:
                base = u.split("/?")[0].rstrip("/")
            if u.endswith("/pet.html"):
                pet = t
    if base is None or pet is None:
        print("missing host or pet")
        return 2

    with urllib.request.urlopen(base + "/dsh-desktop-pet/state", timeout=10) as r:
        state = json.loads(r.read().decode("utf-8"))
    keep = ("activity", "sessionId", "title", "turn", "lastEnd", "eventCount")
    print("host:", json.dumps({k: state.get(k) for k in keep}, ensure_ascii=False))

    ws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=20,
                                     suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": MOOD, "returnByValue": True}}))
    end = time.time() + 10
    while time.time() < end:
        m = json.loads(ws.recv())
        if m.get("id") == 1:
            print("pet mood:", m["result"]["result"]["value"])
            break
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
