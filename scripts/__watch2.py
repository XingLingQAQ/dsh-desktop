import json, time, urllib.request
import websocket
ws=websocket.create_connection(json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version",timeout=3))["webSocketDebuggerUrl"],timeout=15,suppress_origin=True)
def rf(i,d):
    while time.time()<d:
        try: m=json.loads(ws.recv())
        except Exception: break
        if m.get("id")==i: return m
ws.send(json.dumps({"id":1,"method":"Target.getTargets"}))
ts=(rf(1,time.time()+5) or {}).get("result",{}).get("targetInfos",[])
c=next(t for t in ts if t.get("type")=="page" and t.get("url","").startswith("http://127.0.0.1:"))
ws.send(json.dumps({"id":2,"method":"Target.attachToTarget","params":{"targetId":c["targetId"],"flatten":True}}))
sid=rf(2,time.time()+5)["result"]["sessionId"]
n=[900]
def send(m,p):
    n[0]+=1;i=n[0]; ws.send(json.dumps({"id":i,"method":m,"params":p,"sessionId":sid})); return rf(i,time.time()+30)
def ev(e):
    m=send("Runtime.evaluate",{"expression":e,"returnByValue":True})
    return (m or {}).get("result",{}).get("result",{}).get("value")
# 钩住 loadBundle 用的 appendChild，记录 script src
ev("""(function(){
  window.__scripts=[];
  var ap=Element.prototype.appendChild;
  Element.prototype.appendChild=function(node){
    try{ if(node && node.tagName==='SCRIPT'){ window.__scripts.push(node.src); } }catch(e){}
    return ap.apply(this, arguments);
  };
  return 'hooked';
})()""")
time.sleep(9)
print("scripts appended:", ev("JSON.stringify((window.__scripts||[]).slice(-6))"))
print("trace:", ev("JSON.stringify((window.__hmrTrace||[]).slice(-6))"))
ws.close()
