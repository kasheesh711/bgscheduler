"""Run on the temporary macOS runner. Only an invented loopback document is visited."""
import atexit
import base64
import json
import re
import subprocess
import time
import traceback
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

def step(label, number=None):
    report["step"] = label
    report["expectedPage"] = number
    save()

def require(ok, description):
    if not ok:
        raise RuntimeError(description)

def diagnostic():
    if not session: return
    try:
        owned = js("return location.origin === arguments[0] && document.title === 'Numbered PDF verification'", SITE)
        if not owned: return
        number = report.get("expectedPage") or 1
        report["atFailure"] = js("return window.pdfQualification?.inspect(arguments[0]) ?? {documentReady:document.readyState, canvasCount:document.querySelectorAll('canvas').length, innerWidth, innerHeight}", number)
        # WebDriver captures the synthetic viewport only. Never take a desktop screenshot.
        raw = base64.b64decode(cmd("/screenshot"),validate=True)
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            (OUT/"failure-viewport.png").write_bytes(raw)
    except Exception as exc:
        report["diagnosticError"] = type(exc).__name__

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
    # In Safari the renderer may release its canvas between WebDriver commands.
    # Return the pixels and their layout from the same browser callback.
    def poll():
        value = js("return window.pdfQualification?.read(arguments[0],true)",number)
        if value:
            report["latestLayout"] = {k:v for k,v in value.items() if k!="png"}
        return value if value and condition(value) else None
    return wait(poll)

def record(label, value):
    require(isinstance(value, dict), label+": painted page sample was absent")
    metadata = {k:v for k,v in value.items() if k!="png"}
    report["observations"][label] = metadata
    save()
    png = base64.b64decode(value.get("png",""),validate=True)
    require(png.startswith(b"\x89PNG\r\n\x1a\n"), label+": captured page had no PNG signature")
    (OUT/(label+".png")).write_bytes(png)
    require(value["viewerPages"]==40, label+": expected the 40-page preview cap")
    number = int(value["page"])
    require(value["label"]=="Marked paper of Cedar sample, page "+str(number)+" of 45",
            label+": page label did not match its document and total")
    expected = 842/595 if number==22 else 595/842
    require(value["displayedHeight"]>0, label+": painted page had zero height")
    require(abs(value["displayedWidth"]/value["displayedHeight"]-expected)<.015,
            label+": displayed aspect ratio did not match the numbered source page")
    require(value["headingInView"] and value["hasInk"], label+": numbered page was outside the visible viewer or lacked source ink")

def scaled(before,now):
    return now and abs(now["outerWidth"]-before["outerWidth"])<=2 and (
        now["innerWidth"]<=before["innerWidth"]*.94 or now["viewportScale"]>=before["viewportScale"]*1.06)

def driver_zoom(before):
    # Safari's actual keyboard shortcut. Count a zoom only if the measured viewport changes.
    for key in ("+", "="):
        try:
            cmd("/actions",{"actions":[{"type":"key","id":"zoom","actions":[
                {"type":"keyDown","value":"\ue03d"},{"type":"keyDown","value":key},
                {"type":"keyUp","value":key},{"type":"keyUp","value":"\ue03d"}]}]})
            cmd("/actions",method="DELETE")
            value=reading(22,lambda x:scaled(before,x))
        except (HTTPError, RuntimeError, TimeoutError):
            continue
        report["zoomControl"]="Safari Command-plus"
        record("zoom",value)
        step("final page under keyboard zoom",40)
        scroll(40);record("zoom-final",reading(40))
        return True
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
    step("open native Safari fixture",22)
    window_id=apple('tell application "Safari"\n activate\n make new document with properties {URL:"'+SITE+'/?native=1#22"}\n set bounds of front window to {40,50,1040,780}\n return id of front window\nend tell')
    require(window_id.isdigit(),"Safari did not identify the synthetic window")
    window="(first window whose id is "+window_id+")"
    def sample(number):
        value=request(SITE+"/qualification-sample")
        return value if value and value["page"]==number else None
    try:
        before=wait(lambda:sample(22)); record("native-before",before.copy())
        step("native View menu zoom",22)
        apple('tell application "Safari"\n activate\n set index of '+window+' to 1\n if not ((URL of current tab of '+window+') starts with "'+SITE+'/") then error "Wrong fixture window"\nend tell\ntell application "System Events" to tell process "Safari"\n if name of front window does not contain "Numbered PDF verification" then error "Wrong fixture window"\n click menu bar item "View" of menu bar 1\n delay 0.2\n click menu item "Zoom In" of menu 1 of menu bar item "View" of menu bar 1\nend tell')
        zoomed=wait(lambda:(v if (v:=sample(22)) and scaled(before,v) else None))
        report["zoomControl"]="Safari View > Zoom In";record("zoom",zoomed)
        step("final page under native zoom",40)
        apple('tell application "Safari" to set URL of current tab of '+window+' to "'+SITE+'/?native=1#40"')
        record("zoom-final",wait(lambda:sample(40)))
    finally:
        apple('tell application "Safari" to close '+window)

def main():
    global session
    report["safaridriverVersion"]=subprocess.check_output(["safaridriver","--version"],text=True).strip()
    report["macOS"]=subprocess.check_output(["sw_vers","-productVersion"],text=True).strip()
    step("wait for fixture and Safari WebDriver"); wait(ready,50)
    step("start real Safari")
    details=request(DRIVER+"/session",{"capabilities":{"alwaysMatch":{"browserName":"safari"}}})["value"]
    session=details["sessionId"]
    caps=details["capabilities"]
    report["browser"]={k:caps.get(k) for k in ("browserName","browserVersion","platformName")}
    require(str(caps["browserName"]).lower()=="safari","WebDriver session is not genuine Safari")
    step("first navigation",1)
    cmd("/window/rect",{"width":850,"height":740})
    goto()
    step("first page",1)
    scroll(1); record("first",reading(1))
    step("middle landscape page",22)
    scroll(22); record("middle",reading(22))
    old=report["observations"]["middle"]
    step("keep page 22 after resizing",22)
    cmd("/window/rect",{"width":1200,"height":780})
    record("resized",reading(22,lambda v:v["pixelWidth"]!=old["pixelWidth"]))
    step("final page",40)
    scroll(40); record("final",reading(40))
    step("reopen the document",1)
    cmd("/url",{"url":"about:blank"}); goto(); scroll(1); record("reopen",reading(1))
    step("measure middle page before zoom",22)
    scroll(22); record("before-zoom",reading(22))
    before=report["observations"]["before-zoom"]
    step("Safari keyboard page zoom",22)
    if not driver_zoom(before):
        close();native_zoom()
    report["status"]="completed";save()

atexit.register(close)
if __name__=="__main__":
    try:main()
    except Exception as exc:
        report["status"]="incomplete"
        frames = traceback.extract_tb(exc.__traceback__)
        report["checkLine"] = next((f.lineno for f in reversed(frames) if Path(f.filename).name=="check.py"),None)
        diagnostic()
        if isinstance(exc,HTTPError):report["error"]="Safari WebDriver HTTP "+str(exc.code)
        elif isinstance(exc,RuntimeError): report["error"]=str(exc)
        else:report["error"]=type(exc).__name__
        save()
        print("Incomplete Safari check at",report.get("step"),"line",report["checkLine"],":",report["error"])
        raise SystemExit(1)
