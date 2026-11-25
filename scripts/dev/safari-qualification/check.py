"""Qualify native resizing and page zoom in two isolated modes of real Intel Safari."""
import base64
import json
import os
import platform
import plistlib
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ORIGIN="http://127.0.0.1:4809"
OUT=Path("evidence")
OUT.mkdir(exist_ok=True)
READER=Path(os.environ.get("RUNNER_TEMP","/tmp"))/"read-pdf-pages"
result={"base":"359c97fd3c143e326068203ff83fcf7fb9d311eb","candidate":"db5048388b5f57895ef7e19d61b0a36d16964590",
        "browser":"Safari","version":subprocess.check_output(["safaridriver","--version"],text=True).strip(),
        "macOS":platform.mac_ver()[0],"architecture":platform.machine(),"observations":{}}
try:
    with open("/Applications/Safari.app/Contents/Info.plist","rb") as info:
        result["safariAppVersion"]=plistlib.load(info)["CFBundleShortVersionString"]
except (OSError,KeyError):
    pass
DRIVER="http://127.0.0.1:4810"
CONTROL=READER.parent/"safari-control"
session=None

def save():
    (OUT/"safari.json").write_text(json.dumps(result,indent=2))

def wait_for(action,seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            v=action()
            if v:return v
        except OSError:pass
        time.sleep(.2)
    return None

def sample(kind,run,number):
    with urlopen(ORIGIN+"/qualification-sample?kind="+kind+"&run="+run,timeout=3) as conn: value=json.load(conn)
    if value and value.get("run")==run and value.get("kind")==kind and value.get("page")==number: return value

def read_marker(target,number):
    def recognize(image):
        reading=subprocess.run([READER,str(image),str(number)],capture_output=True,text=True,timeout=20)
        return reading.stdout.strip() if reading.returncode==0 else None
    marker=recognize(target)
    if marker:return marker,1
    # Enlarge only the existing screenshot pixels for small landscape headings.
    # Preserve the unchanged, full native screenshot for independent inspection.
    with target.open("rb") as source:
        header=source.read(24)
    width,height=struct.unpack(">II",header[16:24])
    with tempfile.TemporaryDirectory() as folder:
        enlarged=Path(folder)/"enlarged.png"
        scaled=subprocess.run(["/usr/bin/sips","-z",str(height*3),str(width*3),str(target),"--out",str(enlarged)],
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
        return (recognize(enlarged),3) if scaled.returncode==0 else (None,1)

def driver_request(route,body=None,method=None):
    content=None if body is None else json.dumps(body).encode()
    with urlopen(Request(DRIVER+route,data=content,method=method,headers={"Content-Type":"application/json"}),timeout=20) as r:
        return json.load(r)["value"]

def cmd(route,body=None,method=None):
    return driver_request("/session/"+session+route,body,method)

def error(exc):
    if isinstance(exc,HTTPError):return "Safari WebDriver HTTP "+str(exc.code)
    return str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__

def route(mode,oldrun,newrun,kind,number):
    path="/"+kind+"?run="+newrun+"#"+str(number)
    if mode=="driver":
        cmd("/url",{"url":ORIGIN+path})
    elif oldrun:
        q=urlencode({"current":oldrun,"next":path})
        with urlopen(Request(ORIGIN+"/native-navigation?"+q,data=b"",method="POST"),timeout=5) as r:
            if r.status!=204:raise RuntimeError("Local navigation request was declined")
    else:
        subprocess.run(["/usr/bin/open","-a","Safari",ORIGIN+path],timeout=10,check=True,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def capture(mode,label,number):
    target=OUT/(mode+"-"+label+".png")
    data={"numberRead":False}
    for delay in (.15,.7,1.4):
        time.sleep(delay)
        methods=["SafariDriver viewport","identified Safari window"] if mode=="driver" else ["identified Safari window"]
        for method in methods:
            if method=="SafariDriver viewport":
                try:target.write_bytes(base64.b64decode(cmd("/screenshot"),validate=True))
                except (OSError,ValueError):continue
            else:
                win=subprocess.run([READER,"--fixture-window","Numbered PDF verification - candidate "+mode],capture_output=True,text=True,timeout=5)
                if win.returncode or not win.stdout.strip().isdigit():continue
                shot=subprocess.run(["/usr/sbin/screencapture","-x","-o","-l",win.stdout.strip(),str(target)],
                                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
                if shot.returncode:continue
            if not target.is_file() or not target.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):continue
            marker,scale=read_marker(target,number)
            data.update({"capture":method,"visibleMarker":marker,"ocrImageScale":scale,"numberRead":bool(marker)})
            if marker:return data
    return data

def ready(v):
    return v and v.get("hasInk") and v.get("headingInView") and v.get("viewerBusy")=="false"

def observe(mode,label,run,number,condition=lambda value:True):
    result["step"]=mode+" "+label;save()
    def sufficient():
        v=sample("candidate",run,number)
        return v if ready(v) and condition(v) else None
    v=wait_for(sufficient,10)
    seen={"geometry":v or sample("candidate",run,number),"ready":bool(v),**capture(mode,label,number)}
    ratio=842/595 if number==22 else 595/842
    passed=bool(v and seen["numberRead"] and v["viewerPages"]==40 and v["label"]=="Marked paper of Cedar sample, page "+str(number)+" of 45"
                and v["displayedHeight"]>0 and abs(v["displayedWidth"]/v["displayedHeight"]-ratio)<.015)
    seen["passed"]=passed;result["observations"][mode+"-"+label]=seen;save()
    return seen

def changed(a,b):
    return abs(a["outerWidth"]-b["outerWidth"])<=2 and (b["innerWidth"]<a["innerWidth"]*.94 or b["viewportScale"]>a["viewportScale"]*1.06)

def restored(a,b):
    return abs(a["outerWidth"]-b["outerWidth"])<=2 and abs(a["innerWidth"]-b["innerWidth"])<=2 and abs(a["viewportScale"]-b["viewportScale"])<.02

def control(mode,operation,arg):
    record={"operation":operation,"argument":arg}
    try:
        if mode=="regular":
            r=subprocess.run([CONTROL,operation,arg],capture_output=True,text=True,timeout=8)
            record.update({"result":r.stdout.strip(),"accepted":r.returncode==0})
        elif operation=="resize":
            rect=cmd("/window/rect",{"width":int(arg),"height":740})
            record.update({"result":{"width":rect["width"],"height":rect["height"]},"accepted":True})
        else:
            keys=["\ue03d"]
            if operation=="zoom-in" and arg=="plus":keys.append("\ue008")
            keys.append("=" if operation=="zoom-in" else "-")
            presses=[{"type":"keyDown","value":k} for k in keys]+[{"type":"keyUp","value":k} for k in reversed(keys)]
            cmd("/actions",{"actions":[{"type":"key","id":"native-safari-shortcut","actions":presses}]})
            cmd("/actions",method="DELETE");record.update({"result":"SafariDriver performed keyboard actions","accepted":True})
    except Exception as exc:record.update({"result":error(exc),"accepted":False})
    result.setdefault("controls",{}).setdefault(mode,[]).append(record);save()
    return record["accepted"]

def test(mode):
    run=mode+"1"
    route(mode,None,run,"candidate",22)
    before=observe(mode,"before-resize",run,22)
    initial=before["geometry"]
    if not initial:raise RuntimeError("No initial candidate layout")
    width="850" if initial["outerWidth"]>1000 else "1200"
    control(mode,"resize",width)
    resized=observe(mode,"resized",run,22,lambda v:abs(v["outerWidth"]-initial["outerWidth"])>=80 and v["pixelWidth"]!=initial["pixelWidth"])
    route(mode,run,run,"candidate",40)
    observe(mode,"final",run,40)
    away=mode+"2";route(mode,run,away,"static",91)
    left=wait_for(lambda:sample("static",away,91),10)
    reopened=mode+"3";route(mode,away,reopened,"candidate",1)
    observe(mode,"reopen",reopened,1,lambda v:bool(left))
    run=reopened
    route(mode,run,run,"candidate",22)
    prezoom=observe(mode,"before-zoom",run,22)
    anchor=prezoom["geometry"]
    if not anchor:raise RuntimeError("No candidate geometry before native zoom")
    # Accept only measured native zoom at fixed outer window size. A content key event alone does not count.
    was_zoomed=False;keys_accepted=False;restore_operation="zoom-out"
    for key in ("plus","equal"):
        if not control(mode,"zoom-in",key):break
        keys_accepted=True
        was_zoomed=bool(wait_for(lambda:(v if (v:=sample("candidate",run,22)) and changed(anchor,v) else None),4))
        if was_zoomed:break
    # Use the authorized View menu only after delivered shortcuts had no effect.
    # A denied keyboard action is recorded without trying another native input path.
    if mode=="regular" and keys_accepted and not was_zoomed and control(mode,"menu-in","View"):
        restore_operation="menu-out"
        was_zoomed=bool(wait_for(lambda:(v if (v:=sample("candidate",run,22)) and changed(anchor,v) else None),5))
    try:
        observe(mode,"zoom",run,22,lambda v:was_zoomed and changed(anchor,v))
        route(mode,run,run,"candidate",40)
        observe(mode,"zoom-final",run,40,lambda v:was_zoomed and changed(anchor,v))
    finally:
        if was_zoomed:
            for _ in range(3):
                if not control(mode,restore_operation,"minus"):break
                if wait_for(lambda:(v if (v:=sample("candidate",run,40)) and restored(anchor,v) else None),4):break
            observe(mode,"restored",run,40,lambda v:restored(anchor,v))
    away=mode+"4";route(mode,run,away,"static",91)
    left=wait_for(lambda:sample("static",away,91),10)
    reopened=mode+"5";route(mode,away,reopened,"candidate",1)
    observe(mode,"zoom-reopen",reopened,1,lambda v:bool(left))

def main():
    global session
    def fixture():
        with urlopen(ORIGIN+"/static",timeout=2) as response:return response.status==200
    if not wait_for(fixture,60):raise RuntimeError("Fixture unavailable")
    try:
        if not wait_for(lambda:driver_request("/status")["ready"],12):raise RuntimeError("SafariDriver unavailable")
        start=driver_request("/session",{"capabilities":{"alwaysMatch":{"browserName":"safari"}}})
        session=start["sessionId"];caps=start["capabilities"]
        result["driverVersion"]=caps.get("browserVersion")
        if str(caps.get("browserName")).lower()!="safari":raise RuntimeError("Expected genuine Safari")
        test("driver")
    except Exception as exc:result.setdefault("modeErrors",{})["driver"]=error(exc)
    finally:
        if session:
            try:cmd("",method="DELETE")
            except Exception as exc:
                result["driverCloseError"]=error(exc);save()
                # Native input must never touch Safari's protected automation window.
                return "Incomplete. SafariDriver session closure could not be confirmed."
            session=None
        save()
    def has(mode,*labels):
        return all(result["observations"].get(mode+"-"+label,{}).get("passed",False) for label in labels)
    size=("before-resize","resized","final","reopen")
    zoom=("before-zoom","zoom","zoom-final","restored","zoom-reopen")
    if not (has("driver",*size) and has("driver",*zoom)):
        try:test("regular")
        except Exception as exc:result.setdefault("modeErrors",{})["regular"]=error(exc)
    result["resizeEvidence"]=[m for m in ("driver","regular") if has(m,*size)]
    result["zoomEvidence"]=[m for m in ("driver","regular") if has(m,*zoom)]
    return "completed" if result["resizeEvidence"] and result["zoomEvidence"] else "Incomplete. Inspect measured geometry, screenshots and native permission outcomes."

if __name__=="__main__":
    save()
    try:result["status"]=main()
    except Exception as exc:result["status"]="incomplete";result["error"]=error(exc)
    save();print(result["status"]);raise SystemExit(0 if result["status"]=="completed" else 1)
