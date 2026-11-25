"""Compare two revisions and a plain HTML control inside a regular, visible Safari window."""
import json
import os
import platform
import plistlib
import re
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

ORIGIN="http://127.0.0.1:4809"
OUT=Path("evidence")
OUT.mkdir(exist_ok=True)
READER=Path(os.environ.get("RUNNER_TEMP","/tmp"))/"read-pdf-pages"
result={"base":"359c97fd3c143e326068203ff83fcf7fb9d311eb","candidate":"db5048388b5f57895ef7e19d61b0a36d16964590",
        "browser":"regular Safari","version":subprocess.check_output(["safaridriver","--version"],text=True).strip(),
        "macOS":platform.mac_ver()[0],"architecture":platform.machine(),"observations":{}}
try:
    with open("/Applications/Safari.app/Contents/Info.plist","rb") as info:
        result["safariAppVersion"]=plistlib.load(info)["CFBundleShortVersionString"]
except (OSError,KeyError):
    pass
window_id=None
sequence=0

def save():
    (OUT/"safari.json").write_text(json.dumps(result,indent=2))

def apple(script):
    try:
        call=subprocess.run(["/usr/bin/osascript","-e",script],capture_output=True,text=True,timeout=15)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Safari automation timed out") from None
    if call.returncode:
        code=re.search(r'\((-?[0-9]+)\)',call.stderr)
        raise RuntimeError("macOS declined Safari operation"+(" ("+code[1]+")" if code else ""))
    return call.stdout.strip()

def window():
    if not window_id: raise RuntimeError("No AppleScript-controlled synthetic window")
    return "(first window whose id is "+window_id+")"

def navigate(url):
    global window_id
    if not url.startswith(ORIGIN+"/"): raise RuntimeError("Unexpected fixture origin")
    if window_id:
        apple('tell application "Safari" to set URL of current tab of '+window()+' to "'+url+'"')
        return
    try:
        ident=apple('tell application "Safari"\n activate\n make new document with properties {URL:"'+url+'"}\n return id of front window\nend tell')
        if not ident.isdigit(): raise RuntimeError("Safari did not identify the fixture window")
        window_id=ident
    except RuntimeError as exc:
        result["windowControlError"]=str(exc)
        # LaunchServices can still test whether the static/baseline/candidate content is visible.
        subprocess.run(["/usr/bin/open","-a","Safari",url],timeout=10,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def resize(width):
    apple('tell application "Safari"\n set fixture to '+window()+'\n if not ((URL of current tab of fixture) starts with "'+ORIGIN+'/") then error "Wrong window"\n set bounds of fixture to {40,45,'+str(width+40)+',775}\nend tell')

def menu(kind,item):
    title="Numbered PDF verification - "+kind
    apple('tell application "Safari"\n set fixture to '+window()+'\n if not ((URL of current tab of fixture) starts with "'+ORIGIN+'/'+kind+'?") then error "Wrong URL"\n activate\n set index of fixture to 1\nend tell\ntell application "System Events" to tell process "Safari"\n if name of front window does not contain "'+title+'" then error "Wrong fixture window"\n click menu bar item "View" of menu bar 1\n delay 0.2\n click menu item "'+item+'" of menu 1 of menu bar item "View" of menu bar 1\nend tell')

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

def capture(kind,label,number):
    target=OUT/(kind+"-"+label+".png")
    data={"captureAvailable":False,"numberRead":False}
    for delay in (.2,.6,1.5):
        time.sleep(delay)
        query=[READER,"--fixture-window","Numbered PDF verification - "+kind]
        if window_id:
            try:
                guarded=apple('tell application "Safari"\n set t to current tab of '+window()+'\n return ((URL of t) starts with "'+ORIGIN+'/'+kind+'?") and ((name of t) contains "Numbered PDF verification - '+kind+'")\nend tell')
                if guarded=="true":query.append(window_id)
            except RuntimeError:pass
        win=subprocess.run(query,capture_output=True,text=True,timeout=5)
        if win.returncode or not win.stdout.strip().isdigit(): continue
        shot=subprocess.run(["/usr/sbin/screencapture","-x","-o","-l",win.stdout.strip(),str(target)],
                            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
        if shot.returncode or not target.is_file(): continue
        data["captureAvailable"]=target.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        if data["captureAvailable"]:
            marker,scale=read_marker(target,number)
            if marker:
                data["numberRead"]=True
                data["visibleMarker"]=marker
                data["ocrImageScale"]=scale
                break
    return data

def observe(kind,label,run,number,condition=lambda value:True):
    result["step"]=kind+" "+label
    save()
    def ready():
        v=sample(kind,run,number)
        if not v:return None
        ok=v.get("hasText") if kind=="static" else v.get("hasInk") and v.get("headingInView") and v.get("viewerBusy")=="false"
        return v if ok and condition(v) else None
    v=wait_for(ready,16)
    seen={"expectedPage":number,"ready":bool(v),"geometry":v or sample(kind,run,number),**capture(kind,label,number)}
    valid=seen["ready"] and seen["numberRead"]
    if valid and kind!="static":
        expected=842/595 if number==22 else 595/842
        valid=v["viewerPages"]==40 and v["label"]=="Marked paper of Cedar sample, page "+str(number)+" of 45" and v["displayedHeight"]>0 and abs(v["displayedWidth"]/v["displayedHeight"]-expected)<.015
    seen["passed"]=bool(valid)
    result["observations"][kind+"-"+label]=seen
    save()
    return seen

def opened(kind,number):
    global sequence
    sequence+=1
    run=str(sequence)
    url=ORIGIN+"/"+kind+"?run="+run
    navigate(url+"#"+str(number))
    return run,url

def scoped(kind,name,operation):
    try:
        operation()
        return True
    except (RuntimeError,OSError,subprocess.SubprocessError) as exc:
        result.setdefault("operationErrors",{})[kind+"-"+name]=str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
        save()
        return False

def zoomed(before,after):
    return abs(before["outerWidth"]-after["outerWidth"])<=2 and (after["innerWidth"]<before["innerWidth"]*.94 or after["viewportScale"]>before["viewportScale"]*1.06)

def run_screen(kind,complete):
    run,url=opened(kind,1)
    scoped(kind,"initial-size",lambda:resize(850))
    first=observe(kind,"first",run,1)
    if not complete:return first
    navigate(url+"#22")
    middle=observe(kind,"middle",run,22)
    before=middle["geometry"] or {}
    changed=scoped(kind,"resize",lambda:resize(1200))
    observe(kind,"resized",run,22,lambda v:changed and v["outerWidth"]!=before.get("outerWidth") and v["pixelWidth"]!=before.get("pixelWidth"))
    navigate(url+"#40")
    observe(kind,"final",run,40)
    # Leave this document, then reopen with a fresh identifier to exclude a stale observation.
    away,_=opened("static",91)
    left=wait_for(lambda:sample("static",away,91),8)
    run,url=opened(kind,1)
    observe(kind,"reopen",run,1,lambda v:bool(left))
    navigate(url+"#22")
    firstZoom=observe(kind,"before-zoom",run,22)
    initial=firstZoom["geometry"] or {}
    changed=scoped(kind,"zoom-in",lambda:menu(kind,"Zoom In"))
    try:
        observe(kind,"zoom",run,22,lambda v:changed and bool(initial) and zoomed(initial,v))
        navigate(url+"#40")
        observe(kind,"zoom-final",run,40,lambda v:changed and bool(initial) and zoomed(initial,v))
    finally:
        if changed:
            restored=scoped(kind,"restore-zoom",lambda:menu(kind,"Zoom Out"))
            same=wait_for(lambda:(v if (v:=sample(kind,run,40)) and abs(v["innerWidth"]-initial["innerWidth"])<=2 and abs(v["viewportScale"]-initial["viewportScale"])<.02 else None),8)
            result.setdefault("restored",{})[kind]=bool(restored and same)
            save()
    return first

def main():
    def ready():
        with urlopen(ORIGIN+"/static",timeout=2) as response:return response.status==200
    if not wait_for(ready,60):raise RuntimeError("Synthetic fixture did not start")
    run,_=opened("static",91)
    static=observe("static","control",run,91)
    base=run_screen("base",static["passed"])
    candidate=run_screen("candidate",static["passed"])
    checks=("first","middle","resized","final","reopen","zoom","zoom-final")
    complete=all(result["observations"].get("candidate-"+key,{}).get("passed",False) for key in checks)
    if not static["passed"]:
        return "Static HTML control unreadable or unavailable. Runner visibility is unqualified."
    if not base["passed"] and not candidate["passed"]:
        return "Static HTML visible. Neither PDF revision passed the first numbered page."
    if base["passed"] and not candidate["passed"]:
        return "Static HTML and base PDF visible. Candidate first page requires investigation."
    if complete and result.get("restored",{}).get("candidate"):
        return "completed"
    return "Candidate Safari validation incomplete. Compare the retained per-stage controls."

if __name__=="__main__":
    save()
    try:result["status"]=main()
    except Exception as exc:
        result["status"]="incomplete"
        result["error"]=str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    finally:
        if window_id:
            scoped("fixture","close",lambda:apple('tell application "Safari" to close '+window()))
        save()
    print(result["status"])
    raise SystemExit(0 if result["status"]=="completed" else 1)
