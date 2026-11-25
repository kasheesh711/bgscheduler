"""Read the same middle sheet after explicitly scrolling it into view in regular Intel Safari."""
import json
import os
import platform
import plistlib
import struct
import subprocess
import tempfile
import time
from pathlib import Path
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
CONTROL=READER.parent/"safari-control"

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

def document_loaded(kind,run,position):
    with urlopen(ORIGIN+"/document-loaded?kind="+kind+"&run="+run,timeout=3) as conn: value=json.load(conn)
    if value and value.get("kind")==kind and value.get("run")==run and value.get("position")=="#"+str(position) and value.get("readyState")=="complete" and value.get("documentId"):
        return value

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

def navigate(current,newrun,kind,position):
    path="/"+kind+"?run="+newrun+"#"+str(position)
    if current:
        q=urlencode({"current":current,"next":path})
        with urlopen(Request(ORIGIN+"/native-navigation?"+q,data=b"",method="POST"),timeout=5) as response:
            if response.status!=204:raise RuntimeError("Local navigation request was declined")
    else:
        subprocess.run(["/usr/bin/open","-a","Safari",ORIGIN+path],timeout=10,check=True,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def capture(label,number):
    target=OUT/(label+".png");data={"numberRead":False}
    for delay in (.15,.7,1.4):
        time.sleep(delay)
        win=subprocess.run([READER,"--fixture-window","Numbered PDF verification - candidate regular"],capture_output=True,text=True,timeout=5)
        if win.returncode or not win.stdout.strip().isdigit():continue
        shot=subprocess.run(["/usr/sbin/screencapture","-x","-o","-l",win.stdout.strip(),str(target)],
                            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
        if shot.returncode or not target.is_file() or not target.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):continue
        marker,scale=read_marker(target,number)
        data.update({"visibleMarker":marker,"ocrImageScale":scale,"numberRead":bool(marker)})
        if marker:return data
    return data

def ready(v):
    return v and v.get("hasInk") and v.get("headingInView") and v.get("viewerBusy")=="false"

def observe(label,run,number,position,condition=lambda value:True,begin=None):
    result["step"]=label;save()
    timeline=[]
    started=time.monotonic()
    if begin:begin()
    def sufficient():
        try:
            v=sample("candidate",run,number)
            state={k:v.get(k) for k in ("position","viewerBusy","hasInk","headingInView")} if v else {"sampleAvailable":False}
        except OSError as exc:
            v=None
            state={"sampleAvailable":False,"requestError":type(exc).__name__}
        if not timeline or timeline[-1]["state"]!=state:
            timeline.append({"atMs":round((time.monotonic()-started)*1000),"state":state})
        return v if ready(v) and v.get("position")=="#"+str(position) and condition(v) else None
    v=wait_for(sufficient,max(0,10-(time.monotonic()-started)))
    elapsed=round((time.monotonic()-started)*1000)
    seen={"readinessLimitMs":10000,"readinessElapsedMs":elapsed,"readinessHistory":timeline,"geometry":v or sample("candidate",run,number),"ready":bool(v),**capture(label,number)}
    ratio=842/595 if number==22 else 595/842
    passed=bool(v and seen["numberRead"] and v["viewerPages"]==40 and v["label"]=="Marked paper of Cedar sample, page "+str(number)+" of 45"
                and v["displayedHeight"]>0 and abs(v["displayedWidth"]/v["displayedHeight"]-ratio)<.015)
    seen["passed"]=passed;result["observations"][label]=seen;save()
    return seen

def changed(a,b):
    return abs(a["outerWidth"]-b["outerWidth"])<=2 and (b["innerWidth"]<a["innerWidth"]*.94 or b["viewportScale"]>a["viewportScale"]*1.06)

def restored(a,b):
    return abs(a["outerWidth"]-b["outerWidth"])<=2 and abs(a["innerWidth"]-b["innerWidth"])<=2 and abs(a["viewportScale"]-b["viewportScale"])<.02

def control(operation,arg):
    r=subprocess.run([CONTROL,operation,arg],capture_output=True,text=True,timeout=8)
    result.setdefault("controls",[]).append({"operation":operation,"argument":arg,"accepted":r.returncode==0,"result":r.stdout.strip()})
    save();return r.returncode==0

def main():
    def fixture():
        with urlopen(ORIGIN+"/static",timeout=2) as response:return response.status==200
    if not wait_for(fixture,60):raise RuntimeError("Fixture unavailable")
    run="regular1"
    launched=time.monotonic()
    navigate(None,run,"candidate",22)
    dispatched=time.monotonic()
    loaded=wait_for(lambda:document_loaded("candidate",run,22),60)
    finished=time.monotonic()
    result["launchAndNavigation"]={"launchCommandMs":round((dispatched-launched)*1000),
        "navigationAfterLaunchCommandMs":round((finished-dispatched)*1000),"launchToLoadReceiptMs":round((finished-launched)*1000),"document":loaded}
    save()
    if not loaded:raise RuntimeError("Regular Safari did not report completion of the new synthetic document navigation")
    first=observe("middle-before-resize",run,22,22,begin=lambda:navigate(run,run,"candidate",22))
    initial=first["geometry"]
    if not initial:raise RuntimeError("No initial regular Safari measurement")
    width="850" if initial["outerWidth"]>1000 else "1200"
    control("resize",width)
    size_changed=lambda v:abs(v["outerWidth"]-initial["outerWidth"])>=80 and v["pixelWidth"]!=initial["pixelWidth"]
    wait_for(lambda:(v if (v:=sample("candidate",run,22)) and size_changed(v) else None),8)
    navigate(run,run,"candidate","22-resize")
    resized=observe("middle-after-resize-scroll",run,22,"22-resize",size_changed)
    anchor=resized["geometry"]
    if not anchor:raise RuntimeError("No regular Safari measurement after resize")
    was_zoomed=False
    try:
        for key in ("plus","equal"):
            if not control("zoom-in",key):break
            was_zoomed=bool(wait_for(lambda:(v if (v:=sample("candidate",run,22)) and changed(anchor,v) else None),6))
            if was_zoomed:break
        navigate(run,run,"candidate","22-zoom")
        observe("middle-after-zoom-scroll",run,22,"22-zoom",lambda v:was_zoomed and changed(anchor,v))
        navigate(run,run,"candidate",40)
        observe("final-while-zoomed",run,40,40,lambda v:was_zoomed and changed(anchor,v))
        navigate(run,"regular2","static",91)
        left=wait_for(lambda:sample("static","regular2",91),10)
        run="regular3";navigate("regular2",run,"candidate",1)
        observe("fresh-first-page",run,1,1,lambda v:bool(left))
        result["rubricPass"]=all(result["observations"].get(key,{}).get("passed",False) for key in
            ("middle-before-resize","middle-after-resize-scroll","middle-after-zoom-scroll","final-while-zoomed","fresh-first-page"))
        save()
    finally:
        result["zoomCleanup"]={"method":"Safari Actual Size (Command-0)","applied":False,"restored":False}
        if was_zoomed:
            try:
                fresh=sample("candidate","regular3",1)
                doc=document_loaded("candidate","regular3",1)
                if not fresh or not doc or fresh.get("documentId")!=doc["documentId"]:
                    raise RuntimeError("Fresh candidate document could not be verified for cleanup")
                last=None
                def original_size():
                    nonlocal last
                    v=sample("candidate","regular3",1)
                    if v and v.get("documentId")==doc["documentId"] and v.get("position")=="#1":
                        last=v
                        if restored(anchor,v):return v
                    return None
                def cleanup_measurement():
                    return wait_for(original_size,8)
                applied=control("actual-size","command-0")
                back=cleanup_measurement()
                result["zoomCleanup"].update({"applied":applied,"documentId":doc["documentId"],"before":fresh,
                    "referenceWidth":anchor["innerWidth"],"commandResult":last,"restored":bool(back),"observed":last})
                if applied and not back:
                    menu=control("actual-size-menu","Actual Size")
                    if menu:back=cleanup_measurement()
                    result["zoomCleanup"].update({"menuApplied":menu,"restored":bool(back),"observed":last})
            except Exception as exc:result["zoomCleanup"]["error"]=type(exc).__name__
        save()
    return "completed" if result.get("rubricPass") else "Incomplete. Inspect the native screenshots and viewport measurements."

if __name__=="__main__":
    save()
    try:result["status"]=main()
    except Exception as exc:
        result["status"]="incomplete";result["error"]=str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    save();print(result["status"]);raise SystemExit(0 if result["status"]=="completed" else 1)
