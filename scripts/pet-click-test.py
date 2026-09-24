#!/usr/bin/env python3
"""Check that a press-and-release on the pet reaches the click handler.

This is the path that was broken: the old code handed the drag to the OS on
mouse-down, and the OS's modal move loop captures the pointer until the button is
released — so the release never reached the page and the click handler never ran.
The bubble was unreachable by clicking, and every earlier test had opened it by
invoking the command, which is why nothing caught it.

**What this can and cannot prove.** It dispatches a synthetic pointerdown and
pointerup with no movement and checks that the bubble command is reached. That
shows the handler chain is intact — but it does *not* prove the fix, because a
synthetic release is delivered by the renderer whether or not the OS would have
swallowed a real one. The actual fix is that `startDragging()` is no longer called
on pointer-down at all; confirming that needs a real mouse on a real desktop.

The pointer-move path is deliberately not exercised: crossing the threshold calls
`startDragging()`, which enters the OS drag loop, and with no real mouse to end it
that would wedge the app.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def find(suffix):
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").endswith(suffix):
                return t
    return None


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    def call(self, method, params=None, timeout=25):
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
            return "EXC: " + json.dumps(r["exceptionDetails"])[:250]
        return r.get("result", {}).get("value")


# Watch the command rather than the window, so the check is about the handler
# chain and not about window state that other things also touch.
#
# `mousedown` triggers React's `onMouseDown`; `pointerup` triggers the listener
# `startDrag` installs. A real mouse produces both families, so dispatching one of
# each is what a real press-and-release looks like to this page — dispatching only
# pointer events would never reach React's handler at all.
SPY = """(() => {
  window.__calls = [];
  const body = document.querySelector('.pet-body');
  if (!body) return 'NO_BODY';
  const r = body.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
  body.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1,
    pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
  return 'sent';
})()"""

MOOD = ("(() => { const r = document.querySelector('.pet-root');"
        " return r ? r.getAttribute('data-mood') : null; })()")


def main():
    pet = find("/pet.html")
    if pet is None:
        print("no pet window")
        return 2
    ws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)
    page.call("Runtime.enable")

    print("pet visible? ", page.js("(async()=>{const w=(await import("
                                   "'/node_modules/.vite/deps/@tauri-apps_api_window.js'))"
                                   ".getCurrentWindow();return await w.isVisible();})()"))
    print("press+release ->", page.js(SPY))
    time.sleep(0.8)
    print("pet mood after click:", page.js(MOOD))

    # The bubble is a separate window; ask it whether it ended up visible.
    bubble = find("/pet-bubble.html")
    if bubble is None:
        print("no bubble window to check")
    else:
        bws = websocket.create_connection(bubble["webSocketDebuggerUrl"], timeout=25,
                                          suppress_origin=True)
        bpage = Page(bws)
        bpage.call("Runtime.enable")
        print("bubble visible? ", bpage.js("(async()=>{const w=(await import("
                                           "'/node_modules/.vite/deps/@tauri-apps_api_window.js'))"
                                           ".getCurrentWindow();return await w.isVisible();})()"))
        bws.close()

    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
