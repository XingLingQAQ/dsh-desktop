#!/usr/bin/env python3
"""Open the bubble in the middle of a live turn and report what it says.

The bubble's own check only proves it renders; this proves it renders *the
session*, which is the point of having it. It sends a message, waits for the turn
to be under way, and then reads the card.
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"
CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"


def targets():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        return json.load(r)


def find(suffix):
    for t in targets():
        if t.get("type") == "page" and t.get("url", "").endswith(suffix):
            return t
    return None


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    def call(self, method, params=None, timeout=20):
        self.n += 1
        mid = self.n
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                return m.get("result", {})
        return None

    def js(self, expr):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            return "EXC: " + json.dumps(r["exceptionDetails"])[:200]
        return r.get("result", {}).get("value")


READ = """(() => {
  const el = document.querySelector('.pet-bubble');
  if (!el) return 'NO_CARD';
  const q = (s) => { const n = document.querySelector(s); return n ? n.innerText : null };
  return JSON.stringify({ tone: el.getAttribute('data-tone'), state: q('.pet-bubble-state'),
                          session: q('.pet-bubble-session'), foot: q('.pet-bubble-foot') });
})()"""


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "probe10 ok"
    # Send with the existing helper so the send path is identical to the one the
    # turn test uses.
    subprocess.run([sys.executable, "dsh-send.py", text, "--send"], check=False, timeout=60)
    # Give the turn a moment to be under way: the host needs to see turn/start
    # before the card can say anything but "idle".
    time.sleep(3.0)

    pet = find("/pet.html")
    bubble = find("/pet-bubble.html")
    if pet is None or bubble is None:
        print("missing target")
        return 2
    pws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    pet_page = Page(pws)
    pet_page.call("Runtime.enable")
    bws = websocket.create_connection(bubble["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    bubble_page = Page(bws)
    bubble_page.call("Runtime.enable")

    pet_page.js("(async () => { const c = await import('%s');"
                " await c.invoke('show_pet_bubble'); return 'ok'; })()" % CORE)
    time.sleep(1.0)
    print("bubble open, mid-turn content:")
    print(" ", bubble_page.js(READ))

    # And what the host believes at the same moment, for comparison.
    for t in targets():
        u = t.get("url", "")
        if u.startswith("http://127.0.0.1:"):
            base = u.split("/?")[0].rstrip("/")
            break
    else:
        base = None
    if base:
        with urllib.request.urlopen(base + "/dsh-desktop-pet/state", timeout=10) as r:
            s = json.loads(r.read().decode("utf-8"))
        print("host says:", json.dumps({k: s.get(k) for k in
                                        ("activity", "title", "turn", "lastEnd")},
                                       ensure_ascii=False))

    pws.close()
    bws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
