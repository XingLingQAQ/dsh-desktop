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
print(ev("""(function(){
  window.__all=[];
  ['log','info','warn','error','debug'].forEach(function(k){
    var o=console[k];
    console[k]=function(){ try{ window.__all.push(k+': '+[].slice.call(arguments).map(String).join(' ').slice(0,220)); }catch(e){} return o.apply(console,arguments); };
  });
  window.__ev=[];
  window.__DSH_DESKTOP__.subscribe(function(ch){ window.__ev.push(ch.type+' '+ch.id); });
  return 'armed';
})()"""))
time.sleep(10)
print("events:", ev("JSON.stringify((window.__ev||[]).slice(-6))"))
print("console:", ev("JSON.stringify((window.__all||[]).slice(-14))"))
ws.close()
