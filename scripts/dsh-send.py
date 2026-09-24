#!/usr/bin/env python3
"""Type into the DSH composer with real input events, then send.

`execCommand('insertText')` reports success but leaves the box empty here: the
composer is a React-controlled contenteditable, so it only accepts text that
arrives through the browser's own input pipeline. CDP's `Input.insertText` goes
through that pipeline, which is why this uses it rather than setting text from
script.

Used to generate a real turn so the pet's session-state mapping can be checked
against live events rather than against a reading of the source.
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
    send = "--send" in sys.argv
    target = page_target()
    if target is None:
        print("no DSH page")
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)

    # Focus the composer and put the caret in it.
    box = page.js("""(() => {
      const el = document.querySelector('div[contenteditable=true]');
      if (!el) return null;
      el.focus();
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()""")
    if box in (None, "null"):
        print("composer not found")
        ws.close()
        return 2
    point = json.loads(box)
    page.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": point["x"],
                                           "y": point["y"], "button": "left", "clickCount": 1})
    page.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": point["x"],
                                           "y": point["y"], "button": "left", "clickCount": 1})
    time.sleep(0.2)
    # Clear whatever draft is in there first. The composer restores its last
    # draft, so without this a second run appends to the first run's text and the
    # result is one long message instead of the one that was asked for.
    page.call("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 2,
        "windowsVirtualKeyCode": 65, "nativeVirtualKeyCode": 65,
    })
    page.call("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2,
        "windowsVirtualKeyCode": 65, "nativeVirtualKeyCode": 65,
    })
    page.call("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "Delete", "code": "Delete",
        "windowsVirtualKeyCode": 46, "nativeVirtualKeyCode": 46,
    })
    page.call("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "Delete", "code": "Delete",
        "windowsVirtualKeyCode": 46, "nativeVirtualKeyCode": 46,
    })
    time.sleep(0.2)
    page.call("Input.insertText", {"text": text})
    time.sleep(0.3)
    landed = page.js("document.querySelector('div[contenteditable=true]').innerText")
    print("typed:", json.dumps(landed, ensure_ascii=False)[:120])

    if send and landed:
        # Click the composer's primary button rather than pressing Enter: Enter
        # does not submit in this composer, and the send control is the button
        # carrying the composer's `_primary` class at its bottom-right.
        target = page.js("""(() => {
          const composer = document.querySelector('div[contenteditable=true]');
          if (!composer) return null;
          const box = composer.getBoundingClientRect();
          // Prefer the composer's own primary class over any `_primary` on the
          // page: a generic match has picked a different button often enough that
          // a send silently not happening was mistaken for a host problem twice.
          const exact = document.querySelector('button.uV2eYG_primary');
          const candidates = exact ? [exact] : [...document.querySelectorAll('button')];
          let best = null;
          candidates.forEach((b) => {
            const r = b.getBoundingClientRect();
            if (r.width === 0) return;
            const primary = exact ? true : String(b.className).includes('primary');
            const below = r.y > box.y;
            const near = Math.abs((r.y + r.height / 2) - (box.y + box.height));
            if (primary && below && (best === null || near < best.near)) {
              best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), near };
            }
          });
          return best === null ? null : JSON.stringify(best);
        })()""")
        if target in (None, "null"):
            print("send button not found")
        else:
            p = json.loads(target)
            page.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": p["x"],
                                                   "y": p["y"], "button": "left", "clickCount": 1})
            page.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": p["x"],
                                                   "y": p["y"], "button": "left", "clickCount": 1})
            time.sleep(0.5)
            after = page.js("document.querySelector('div[contenteditable=true]').innerText")
            print("after click, box:", json.dumps(after, ensure_ascii=False)[:80])
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
