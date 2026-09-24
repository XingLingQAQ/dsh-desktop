#!/usr/bin/env python3
"""Check the pet's motion and its reaction to being poked.

Both motion preferences are measured, because this machine reports
`prefers-reduced-motion: reduce` and the design deliberately keeps the one-shot
reaction while dropping the looping idle animation. Checking only the local
default would report "no animation" and hide whether the full-motion path works
at all.

The reaction is triggered with a keyboard event rather than a click: the body's
mouse-down handler hands the drag to the window manager, and starting an OS drag
loop from a synthetic press would block with no real mouse to end it.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"

READ = """(() => {
  const cs = (sel, p) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[p] : null;
  };
  return JSON.stringify({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    figure: cs('.pet-figure', 'animationName'),
    figureDur: cs('.pet-figure', 'animationDuration'),
    eye: cs('.pet-eye', 'animationName'),
    ear: cs('.pet-ear-left', 'animationName'),
    mood: document.querySelector('.pet-root')?.getAttribute('data-mood'),
    cheek: cs('.pet-cheek', 'opacity'),
    sparkle: cs('.pet-sparkle', 'opacity'),
    shadow: cs('.pet-shadow', 'transform'),
  });
})()"""

POKE = """(() => {
  const el = document.querySelector('.pet-body');
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'sent';
})()"""


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 100

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


def pet_ws():
    with urllib.request.urlopen(LIST, timeout=3) as r:
        for t in json.load(r):
            if t.get("type") == "page" and "pet.html" in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
    return None


def read(page, label):
    print(f"--- {label} ---")
    raw = page.js(READ)
    print(json.dumps(json.loads(raw), indent=2, ensure_ascii=False))


def main():
    url = pet_ws()
    if url is None:
        print("NO_PET_TARGET")
        return 2
    ws = websocket.create_connection(url, timeout=25, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    time.sleep(0.3)
    page = Page(ws)

    page.call("Emulation.setEmulatedMedia",
              {"features": [{"name": "prefers-reduced-motion", "value": "no-preference"}]})
    time.sleep(0.3)
    read(page, "full motion")

    print("--- poke ---")
    print("dispatch:", page.js(POKE))
    time.sleep(0.25)
    read(page, "right after poke")

    time.sleep(1.4)
    read(page, "after reaction settles")

    page.call("Emulation.setEmulatedMedia",
              {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
    time.sleep(0.3)
    read(page, "reduced motion")

    # The design keeps the user-triggered reaction under reduced motion and drops
    # only the looping idle animation, so this is the check that the trade-off is
    # actually what shipped.
    print("--- poke under reduced motion ---")
    print("dispatch:", page.js(POKE))
    time.sleep(0.25)
    read(page, "reduced motion, right after poke")

    page.call("Emulation.setEmulatedMedia", {"features": []})
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
