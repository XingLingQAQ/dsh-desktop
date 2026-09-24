#!/usr/bin/env python3
"""Open and close the pet's bubble, reporting what it renders.

The bubble is a second window, so it is checked from its own page rather than
inferred from the pet's. It is also checked for *content* and not just
visibility: an empty card that appears on click would pass a visibility check and
still be useless.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"
CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"
WINDOW = "/node_modules/.vite/deps/@tauri-apps_api_window.js"


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
            return "EXC: " + json.dumps(r["exceptionDetails"])[:300]
        return r.get("result", {}).get("value")


BUBBLE_READ = """(() => {
  const el = document.querySelector('.pet-bubble');
  if (!el) return 'NO_CARD';
  const cs = getComputedStyle(el);
  const head = document.querySelector('.pet-bubble-state');
  const session = document.querySelector('.pet-bubble-session');
  const foot = document.querySelector('.pet-bubble-foot');
  const dot = document.querySelector('.pet-bubble-dot');
  return JSON.stringify({
    tone: el.getAttribute('data-tone'),
    state: head ? head.innerText : null,
    session: session ? session.innerText : null,
    foot: foot ? foot.innerText : null,
    dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
    bg: cs.backgroundColor,
    radius: cs.borderRadius,
    anim: cs.animationName,
  });
})()"""


def main():
    pet = find("/pet.html")
    bubble = find("/pet-bubble.html")
    if pet is None or bubble is None:
        print("missing pet or bubble target")
        return 2

    pws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    pet_page = Page(pws)
    pet_page.call("Runtime.enable")

    bws = websocket.create_connection(bubble["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    bubble_page = Page(bws)
    bubble_page.call("Runtime.enable")

    def visible():
        return pet_page.js(
            "(async () => { const w = (await import('%s')).getCurrentWindow();"
            " return 'pet'; })()" % WINDOW) and bubble_page.js(
            "(async () => { const w = (await import('%s')).getCurrentWindow();"
            " return await w.isVisible(); })()" % WINDOW)

    def toggle():
        return pet_page.js(
            "(async () => { const core = await import('%s');"
            " await core.invoke('show_pet_bubble'); return 'ok'; })()" % CORE)

    print("initial visible:", visible())
    print("content while hidden:", bubble_page.js(BUBBLE_READ))

    print("\n--- open ---")
    print("toggle:", toggle())
    time.sleep(0.8)
    print("visible:", visible())
    print("content:", bubble_page.js(BUBBLE_READ))

    print("\n--- close (toggle) ---")
    print("toggle:", toggle())
    time.sleep(0.8)
    print("visible:", visible())

    pws.close()
    bws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
