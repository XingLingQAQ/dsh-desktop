#!/usr/bin/env python3
"""Drive the bubble's own controls and report what happened.

Phase three is about the bubble *doing* things rather than describing them, so
this exercises the three commands it calls — list, select, send — through the
real UI rather than by hitting the routes directly. That way a mismatch between
what the Rust command passes and what the plugin expects shows up here.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


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
            return "EXC: " + json.dumps(r["exceptionDetails"])[:300]
        return r.get("result", {}).get("value")


CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"

# One expression per command, so a failure names the command it belongs to.
LIST_CMD = ("(async () => { const c = await import('%s');"
            " const raw = await c.invoke('pet_sessions');"
            " const v = JSON.parse(raw);"
            " return JSON.stringify({ current: v.current, count: v.sessions.length,"
            " first: v.sessions[0] ? Object.keys(v.sessions[0]) : null,"
            " sample: v.sessions.slice(0,3) }); })()" % CORE)

SELECT_CMD = ("(async () => { const c = await import('%s');"
              " const raw = await c.invoke('pet_sessions');"
              " const v = JSON.parse(raw);"
              " const other = v.sessions.find(s => s.id !== v.current) || v.sessions[0];"
              " if (!other) return 'NO_SESSION';"
              " const id = await c.invoke('pet_select_session', { sessionId: other.id });"
              " return JSON.stringify({ picked: other.id, returned: id }); })()" % CORE)

SEND_CMD = ("(async () => { const c = await import('%s');"
            " const raw = await c.invoke('pet_sessions');"
            " const v = JSON.parse(raw);"
            " if (!v.current) return 'NO_CURRENT';"
            " const out = await c.invoke('pet_send_prompt',"
            "   { sessionId: v.current, text: %s });"
            " return out; })()" % (CORE, json.dumps("probe-ui: 只回复 ok")))

READ_UI = """(() => {
  const card = document.querySelector('.pet-bubble');
  if (!card) return 'NO_CARD';
  const q = (s) => { const n = document.querySelector(s); return n ? n.innerText : null };
  return JSON.stringify({
    tone: card.getAttribute('data-tone'),
    state: q('.pet-bubble-state'),
    session: q('.pet-bubble-session'),
    foot: q('.pet-bubble-foot'),
    hasInput: !!document.querySelector('.pet-bubble input, .pet-bubble textarea'),
    hasSend: !!document.querySelector('button[type=submit], .pet-bubble button'),
    buttons: document.querySelectorAll('.pet-bubble button').length,
  });
})()"""


def main():
    bubble = find("/pet-bubble.html")
    pet = find("/pet.html")
    if bubble is None or pet is None:
        print("missing window")
        return 2
    bws = websocket.create_connection(bubble["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    page = Page(bws)
    page.call("Runtime.enable")
    pws = websocket.create_connection(pet["webSocketDebuggerUrl"], timeout=25,
                                      suppress_origin=True)
    pet_page = Page(pws)
    pet_page.call("Runtime.enable")
    pet_page.js("(async () => { const c = await import('%s');"
                " await c.invoke('show_pet_bubble'); return 'ok'; })()" % CORE)
    time.sleep(1.0)

    print("=== rendered UI ===")
    print(" ", page.js(READ_UI))

    print("\n=== pet_sessions ===")
    print(" ", page.js(LIST_CMD))

    print("\n=== pet_select_session ===")
    print(" ", page.js(SELECT_CMD))
    time.sleep(0.6)

    print("\n=== pet_send_prompt ===")
    print(" ", page.js(SEND_CMD))
    time.sleep(3.0)
    print("  host state after send:")
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
        print("   ", json.dumps({k: s.get(k) for k in
                                 ("activity", "sessionId", "turn", "lastEnd")},
                                ensure_ascii=False))

    bws.close()
    pws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
