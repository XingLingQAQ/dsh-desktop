#!/usr/bin/env python3
"""Open 设置 -> 插件, expand the native group, and report what it lists.

Navigation is idempotent: clicking 设置 when the dialog is already open would
close it, which is what made earlier runs report "not found: 插件". Each step
checks the current state first and only clicks when the state is wrong.
"""
import json
import sys
import time
import urllib.request

import websocket

VER = "http://127.0.0.1:9222/json/version"
ws = websocket.create_connection(
    json.load(urllib.request.urlopen(VER, timeout=3))["webSocketDebuggerUrl"],
    timeout=10, suppress_origin=True,
)


def rf(ident, deadline):
    while time.time() < deadline:
        try:
            m = json.loads(ws.recv())
        except Exception:
            break
        if m.get("id") == ident:
            return m
    return None


ws.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
targets = (rf(1, time.time() + 5) or {}).get("result", {}).get("targetInfos", [])
content = next((t for t in targets if t.get("type") == "page"
                and "1420" not in t.get("url", "")
                and t.get("url", "").startswith("http://127.0.0.1:")), None)
if not content:
    print("no content target")
    raise SystemExit
ws.send(json.dumps({"id": 2, "method": "Target.attachToTarget",
                    "params": {"targetId": content["targetId"], "flatten": True}}))
sid = rf(2, time.time() + 5)["result"]["sessionId"]
ws.send(json.dumps({"id": 3, "method": "Runtime.enable", "sessionId": sid}))
rf(3, time.time() + 3)

counter = [10]


def ev(expr):
    counter[0] += 1
    ident = counter[0]
    ws.send(json.dumps({"id": ident, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True},
                        "sessionId": sid}))
    m = rf(ident, time.time() + 15)
    return m.get("result", {}).get("result", {}).get("value") if m else None


# Deliberately no `div`: a wrapper div can have the same textContent as the
# button inside it and sorts earlier in document order, so including div
# clicked the wrapper (a no-op) and the dialog never opened.
CLICK = """
(function(text){
  var nodes = [].slice.call(document.querySelectorAll('button,[role=button],[role=tab],a,li'));
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if ((n.textContent || '').trim() === text && n.offsetParent !== null) { n.click(); return 'clicked ' + text }
  }
  return 'not found: ' + text;
})(%s)
"""


def click(label, wait=1.8):
    print(ev(CLICK % json.dumps(label)))
    time.sleep(wait)


# 1. Settings dialog: only click 设置 if no dialog is open.
if not ev("document.querySelectorAll('[role=dialog]').length"):
    click("设置")
else:
    print("settings dialog already open")

# 2. Plugins tab: only click 插件 if the manager is not mounted yet.
if not ev("document.querySelectorAll('.dsx-mgr').length"):
    click("插件")
else:
    print("plugins tab already active")

if not ev("document.querySelectorAll('.dsx-mgr').length"):
    print("manager still not mounted; clickable labels:", ev(
        "JSON.stringify([].slice.call(document.querySelectorAll('button,[role=tab],[role=button]'))"
        ".filter(function(n){return n.offsetParent!==null})"
        ".map(function(n){return (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24)})"
        ".filter(function(s){return s.length>0}).slice(0,40))"))
    ws.close()
    raise SystemExit

# 3. Native group: expand only if its list is not rendered.
if not ev("document.querySelectorAll('.dsx-mgr-native-list').length"):
    print(ev("""
    (function(){
      var heads = [].slice.call(document.querySelectorAll('.dsx-mgr-native-head'));
      if (!heads.length) return 'native head missing';
      heads[0].click();
      return 'expanded native group';
    })()
    """))
    time.sleep(2.5)
else:
    print("native group already expanded")

print("count badge:", ev(
    "((document.querySelector('.dsx-mgr-native-count')||{}).textContent||'').trim()"))
print("rows:", ev(
    "JSON.stringify([].slice.call(document.querySelectorAll('.dsx-mgr-native-list > li'))"
    ".map(function(li){return {"
    "  id: (li.querySelector('.dsx-mgr-native-id')||{}).textContent||'',"
    "  mod: ((li.querySelector('.dsx-mgr-native-short')||{}).getAttribute?"
    "        li.querySelector('.dsx-mgr-native-short').getAttribute('title'):'')||'',"
    "  enabled: li.getAttribute('data-enabled')"
    "}}))"))
print("file:// rows still listed:", ev(
    "[].slice.call(document.querySelectorAll('.dsx-mgr-native-list .dsx-mgr-native-short'))"
    ".filter(function(n){return (n.getAttribute('title')||'').indexOf('file://')===0}).length"))
if len(sys.argv) > 1:
    print("error banner:", ev(
        "((document.querySelector('.dsx-mgr-error')||{}).textContent||'').trim()"))
ws.close()
