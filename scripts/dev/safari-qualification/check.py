"""Run on the temporary macOS runner. Only an invented loopback document is visited."""
import atexit
import base64
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SITE = "http://127.0.0.1:4809"
DRIVER = "http://127.0.0.1:4810"
OUT = Path("evidence")
OUT.mkdir(exist_ok=True)
report = {"candidate": "db5048388b5f57895ef7e19d61b0a36d16964590", "observations": {}}
session = None

def save():
    (OUT / "safari.json").write_text(json.dumps(report, indent=2))

def request(url, body=None, method=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    with urlopen(Request(url,data=data,method=method,headers={"Content-Type":"application/json"}),timeout=timeout) as response:
        return json.load(response)

def wait(action, seconds=20):
    limit = time.monotonic()+seconds
    while time.monotonic()<limit:
        value = action()
        if value: return value
        time.sleep(.2)
    raise RuntimeError("Timed out waiting for the current Safari observation")

def cmd(route, body=None, method=None):
    return request(DRIVER+"/session/"+session+route, body, method)["value"]

def js(script, *args):
    return cmd("/execute/sync", {"script":script,"args":list(args)})

def close():
    global session
    if session:
        try: cmd("",method="DELETE")
        except (HTTPError, URLError, TimeoutError): pass
        session=None

def ready():
    try:
        with urlopen(SITE,timeout=2) as r: ok=r.status==200
        return ok and request(DRIVER+"/status",timeout=2)["value"]["ready"]
    except (OSError, ValueError):return False

def goto():
    cmd("/url",{"url":SITE+"/"})
    wait(lambda:js("return !!window.pdfQualification && document.querySelectorAll('canvas').length===40"))

def scroll(number):
    wait(lambda:js("return window.pdfQualification?.go(arguments[0])",number))

def reading(number, condition=lambda value:True):
    def poll():
        value=js("return window.pdfQualification?.read(arguments[0])",number)
        return value if value and condition(value) else None
    wait(poll)
    return js("return window.pdfQualification.read(arguments[0],true)",number)

def record(label,value):
    assert value and value["viewerPages"]==40 and value["label"].endswith("page "+str(value["page"])+" of 45")
    if value["page"]==22:
        assert abs(value["displayedWidth"]/value["displayedHeight"]-842/595)<.015
    else:
        assert abs(value["displayedWidth"]/value["displayedHeight"]-595/842)<.015
    png=base64.b64decode(value.pop("png"),validate=True)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    (OUT/(label+".png")).write_bytes(png)
    report["observations"][label]=value
    save()

def scaled(before,now):
    return now and abs(now["outerWidth"]-before["outerWidth"])<=2 and (
        now["innerWidth"]<=before["innerWidth"]*.94 or now["viewportScale"]>=before["viewportScale"]*1.06)

def driver_zoom(before):
    # Safari's actual keyboard shortcut. Count a zoom only if the measured viewport changes.
    for key in ("+", "="):
        cmd("/actions",{"actions":[{"type":"key","id":"zoom","actions":[
            {"type":"keyDown","value":"\ue03d"},{"type":"keyDown","value":key},
            {"type":"keyUp","value":key},{"type":"keyUp","value":"\ue03d"}]}]})
        cmd("/actions",method="DELETE")
        try:
            value=reading(22,lambda x:scaled(before,x))
            report["zoomControl"]="Safari Command-plus";record("zoom",value)
            scroll(40);record("zoom-final",reading(40))
            return True
        except RuntimeError:pass
    return False

def apple(script):
    # Keep diagnostics short. Do not record user, runner or process details.
    result=subprocess.run(["/usr/bin/osascript","-e",script],capture_output=True,text=True,timeout=15)
    if result.returncode:
        code=re.search(r'\((-?[0-9]+)\)',result.stderr)
        raise RuntimeError("macOS declined native GUI operation"+(" ("+code[1]+")" if code else ""))
    return result.stdout.strip()

def native_zoom():
    # WebDriver key events can stay inside webpage content. Use Safari's View menu in a
    # dedicated normal window if that happened. No preference or permission is changed.
    window_id=apple('tell application "Safari"\n activate\n make new document with properties {URL:"'+SITE+'/?native=1#22"}\n set bounds of front window to {40,50,1040,780}\n return id of front window\nend tell')
    assert window_id.isdigit()
    window="(first window whose id is "+window_id+")"
    def sample(number):
        value=request(SITE+"/qualification-sample")
        return value if value and value["page"]==number else None
    try:
        before=wait(lambda:sample(22)); record("native-before",before.copy())
        apple('tell application "Safari"\n activate\n set index of '+window+' to 1\n if not ((URL of current tab of '+window+') starts with "'+SITE+'/") then error "Wrong fixture window"\nend tell\ntell application "System Events" to tell process "Safari"\n if name of front window does not contain "Numbered PDF verification" then error "Wrong fixture window"\n click menu bar item "View" of menu bar 1\n delay 0.2\n click menu item "Zoom In" of menu 1 of menu bar item "View" of menu bar 1\nend tell')
        zoomed=wait(lambda:(v if (v:=sample(22)) and scaled(before,v) else None))
        report["zoomControl"]="Safari View > Zoom In";record("zoom",zoomed)
        apple('tell application "Safari" to set URL of current tab of '+window+' to "'+SITE+'/?native=1#40"')
        record("zoom-final",wait(lambda:sample(40)))
    finally:
        apple('tell application "Safari" to close '+window)

def main():
    global session
    report["safaridriverVersion"]=subprocess.check_output(["safaridriver","--version"],text=True).strip()
    report["macOS"]=subprocess.check_output(["sw_vers","-productVersion"],text=True).strip()
    save(); wait(ready,50)
    details=request(DRIVER+"/session",{"capabilities":{"alwaysMatch":{"browserName":"safari"}}})["value"]
    session=details["sessionId"]
    caps=details["capabilities"]
    report["browser"]={k:caps.get(k) for k in ("browserName","browserVersion","platformName")}
    assert str(caps["browserName"]).lower()=="safari"
    save()
    cmd("/window/rect",{"width":850,"height":740});goto();scroll(1);record("first",reading(1))
    scroll(22);record("middle",reading(22));old=report["observations"]["middle"]
    cmd("/window/rect",{"width":1200,"height":780})
    record("resized",reading(22,lambda v:v["pixelWidth"]!=old["pixelWidth"]))
    scroll(40);record("final",reading(40))
    cmd("/url",{"url":"about:blank"});goto();scroll(1);record("reopen",reading(1))
    scroll(22);record("before-zoom",reading(22));before=report["observations"]["before-zoom"]
    try:zoom_ok=driver_zoom(before)
    except (HTTPError, RuntimeError, TimeoutError):zoom_ok=False
    if not zoom_ok:
        close();native_zoom()
    report["status"]="completed";save()

atexit.register(close)
if __name__=="__main__":
    try:main()
    except Exception as exc:
        report["status"]="incomplete"
        if isinstance(exc,HTTPError):report["error"]="Safari WebDriver HTTP "+str(exc.code)
        elif isinstance(exc,RuntimeError): report["error"]=str(exc)
        else:report["error"]=type(exc).__name__
        save()
        print("Incomplete Safari check:",report["error"])
        raise SystemExit(1)
