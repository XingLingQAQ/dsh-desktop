#!/usr/bin/env python3
"""Send a message in the DSH UI and watch the pet's state throughout.

Everything happens in one process on purpose. Doing the send and the sampling as
separate steps kept racing — the sampler would finish before the click — and the
resulting "nothing changed" was indistinguishable from a real failure.

It reports the plugin's own `eventCount` alongside the activity, because those
two answer different questions: no events at all means the subscription is not
receiving, while events arriving without the activity moving means the mapping is
wrong.
"""
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def page_target():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").startswith("http://127.0.0.1:"):
                return t
    return None


def host_base():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            u = t.get("url", "")
            if u.startswith("http://127.0.0.1:"):
                return u.split("/?")[0].rstrip("/")
    return None


def pet_target():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").endswith("/pet.html"):
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
            return "EXC: " + json.dumps(r["exceptionDetails"])[:300]
        return r.get("result", {}).get("value")


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "probe: 只回复 ok"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0

    target = page_target()
    base = host_base()
    if target is None or base is None:
        print("no DSH page")
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)
    state_url = base + "/dsh-desktop-pet/state"

    # A second connection to the pet window, so the sampling loop can report what
    # the pet is *showing* and not only what the host is publishing. Those are two
    # different links in the chain and only one of them can break at a time.
    pet = pet_target()
    pet_ws = None
    pet_page = None
    if pet is not None:
        pet_ws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=25,
                                             suppress_origin=True)
        pet_page = Page(pet_ws)
        pet_page.call("Runtime.enable")

    def pet_mood():
        if pet_page is None:
            return None
        return pet_page.js(
            "(() => { const r = document.querySelector('.pet-root');"
            " return r ? r.getAttribute('data-mood') : null; })()")

    def state():
        try:
            with urllib.request.urlopen(state_url, timeout=5) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            return None

    before = state()
    print("before:", json.dumps({k: before.get(k) for k in
                                 ("activity", "eventCount", "turn")} if before else None,
                                ensure_ascii=False), "pet mood:", pet_mood())

    # Focus, clear, type.
    box = page.js("""(() => {
      const el = document.querySelector('div[contenteditable=true]');
      if (!el) return null;
      el.focus();
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()""")
    if box in (None, "null"):
        print("no composer")
        ws.close()
        return 2
    p = json.loads(box)
    for kind in ("mousePressed", "mouseReleased"):
        page.call("Input.dispatchMouseEvent", {"type": kind, "x": p["x"], "y": p["y"],
                                               "button": "left", "clickCount": 1})
    time.sleep(0.2)
    for key, code, vk, mods in (("a", "KeyA", 65, 2), ("Delete", "Delete", 46, 0)):
        for kind in ("keyDown", "keyUp"):
            page.call("Input.dispatchKeyEvent", {"type": kind, "key": key, "code": code,
                                                 "modifiers": mods,
                                                 "windowsVirtualKeyCode": vk,
                                                 "nativeVirtualKeyCode": vk})
    time.sleep(0.2)
    page.call("Input.insertText", {"text": text})
    time.sleep(0.4)
    typed = page.js("document.querySelector('div[contenteditable=true]').innerText")
    print("typed:", json.dumps(typed, ensure_ascii=False))
    if not typed:
        print("composer empty, aborting")
        ws.close()
        return 2

    print("clicking send…")
    print("  ", page.js("""(() => {
      const b = document.querySelector('button[class*="_primary"]');
      if (!b) return 'NO_BUTTON';
      b.click();
      return 'clicked';
    })()"""))

    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        s = state()
        if s is not None:
            mood = pet_mood()
            key = (s.get("activity"), s.get("tool"), s.get("turn"),
                   (s.get("lastEnd") or {}).get("kind"), s.get("eventCount"), mood)
            if key != last:
                print(f"  {time.strftime('%H:%M:%S')}  host={str(s.get('activity')):8s} "
                      f"turn={s.get('turn')} end={key[3]} events={s.get('eventCount')} "
                      f"| pet mood={mood}")
                last = key
        time.sleep(0.3)

    final = state()
    print("final:", json.dumps(final, ensure_ascii=False)[:300])
    print("pet mood:", pet_mood())
    if pet_ws is not None:
        pet_ws.close()
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
