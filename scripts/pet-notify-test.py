#!/usr/bin/env python3
"""Check that a turn ending while the main window is hidden makes the pet insist.

The feature exists for the case where nobody is looking, so the test has to
actually hide the main window — checking it with the window up would exercise the
branch that deliberately does nothing. It also checks the negative: with the main
window visible, no notice should be raised.

Both directions matter. A notice that fires when you are already watching is
noise, and the pet is in the corner of a screen you are using for something else.
"""
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"
CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"
WINDOW = "/node_modules/.vite/deps/@tauri-apps_api_window.js"


def targets():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        return json.load(r)


def find(pred):
    for t in targets():
        if t.get("type") == "page" and pred(t):
            return t
    return None


def main_window():
    # The shell's own window, not the DSH page: its URL is the bare dev-server
    # root, which is a prefix of every other page's.
    return find(lambda t: t.get("url", "").rstrip("/") in
                ("http://localhost:1420", "tauri://localhost"))


def pet_window():
    return find(lambda t: t.get("url", "").endswith("/pet.html"))


def host_base():
    for t in targets():
        u = t.get("url", "")
        if u.startswith("http://127.0.0.1:"):
            return u.split("/?")[0].rstrip("/")
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
            return "EXC: " + json.dumps(r["exceptionDetails"])[:200]
        return r.get("result", {}).get("value")


MISSED = ("(() => { const r = document.querySelector('.pet-root');"
          " if (!r) return 'NO_PET';"
          " const b = document.querySelector('.pet-missed-badge');"
          " return JSON.stringify({ missed: r.getAttribute('data-missed'),"
          " badge: b ? b.textContent : null, title: b ? b.title : null }); })()")


def open_page(target):
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)
    page.call("Runtime.enable")
    return ws, page


def send_prompt(page, text):
    # Pick an ordinary session. Subagent sessions appear in the same corpus and
    # sort first when they are newest, but the host refuses to prompt them
    # ("owned by subagent routing") — a real refusal, but not the thing under
    # test here. Ordinary session ids are prefixed; subagent ones are bare uuids.
    return page.js("(async()=>{const c=await import('%s');"
                   " const q=JSON.parse(await c.invoke('pet_sessions'));"
                   " const ok=s=>String(s.id).startsWith('session-');"
                   " const pick=q.current && String(q.current).startsWith('session-')"
                   "   ? q.current : (q.sessions.find(ok)||{}).id;"
                   " if(!pick) return 'NO_SESSION';"
                   " return await c.invoke('pet_send_prompt',{sessionId:pick,text:%s});})()"
                   % (CORE, json.dumps(text)))


def main():
    pet = pet_window()
    mainw = main_window()
    if pet is None or mainw is None:
        print("missing window", pet is not None, mainw is not None)
        return 2
    pws, pet_page = open_page(pet)
    mws, main_page = open_page(mainw)

    def mood():
        return pet_page.js(MISSED)

    print("pet visible? ", pet_page.js("(async()=>{const w=(await import('%s'))"
                                       ".getCurrentWindow();return await w.isVisible();})()" % WINDOW))
    print("before:", mood())

    print("\n=== A. main window VISIBLE: no notice expected ===")
    main_page.js("(async()=>{const w=(await import('%s')).getCurrentWindow();"
                 " await w.show(); return 'shown';})()" % WINDOW)
    time.sleep(1.0)
    print("  send ->", send_prompt(pet_page, "probe-notify-a: 只回复 ok"))
    # The turn takes ~15-20s here because the model is unreachable and retries.
    for _ in range(40):
        time.sleep(1.0)
        state = json.loads(urllib.request.urlopen(
            host_base() + "/dsh-desktop-pet/state", timeout=10).read().decode("utf-8"))
        if state.get("lastEnd"):
            break
    time.sleep(1.0)
    print("  after turn, pet:", mood())

    print("\n=== B. main window HIDDEN: notice expected ===")
    main_page.js("(async()=>{const w=(await import('%s')).getCurrentWindow();"
                 " await w.hide(); return 'hidden';})()" % WINDOW)
    time.sleep(1.5)
    print("  main visible? ", main_page.js("(async()=>{const w=(await import('%s'))"
                                           ".getCurrentWindow();return await w.isVisible();})()" % WINDOW))
    print("  send ->", send_prompt(pet_page, "probe-notify-b: 只回复 ok"))
    for _ in range(40):
        time.sleep(1.0)
        m = mood()
        if m and "yes" in m or (m and "error" in m):
            break
    print("  after turn, pet:", mood())

    print("\n=== C. opening the bubble clears it ===")
    # Dispatch the key the pet's own handler listens for rather than invoking the
    # command directly: invoking it bypasses the page entirely, which is how the
    # first version of this test "failed" a clear that actually works. Enter is
    # used instead of a click because a click on the body starts an OS drag.
    print("  key:", pet_page.js("""(() => {
      const el = document.querySelector('.pet-body');
      if (!el) return 'NO_BODY';
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()"""))
    time.sleep(1.2)
    print("  pet:", mood())
    print("  bubble open? ", pet_page.js("(async()=>{const c=await import('%s');"
                                        " const b=document.querySelector('x');"
                                        " return 'n/a';})()" % CORE))

    pws.close()
    mws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
