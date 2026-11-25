// Native controls for one foreground regular Safari window on the disposable runner.
// Check existing permissions only. Never request access or send input to an automation session.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc!=3) return 2;
    NSString *operation=[NSString stringWithUTF8String:argv[1]];
    NSString *guard=@"Numbered PDF verification - candidate regular";
    NSRunningApplication *front=NSWorkspace.sharedWorkspace.frontmostApplication;
    if (![front.bundleIdentifier isEqualToString:@"com.apple.Safari"]) { puts("Safari was not foreground"); return 1; }
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    NSDictionary *top=nil;
    for (NSDictionary *w in windows) {
      if ([w[(id)kCGWindowOwnerPID] intValue]==front.processIdentifier && [w[(id)kCGWindowLayer] intValue]==0) { top=w; break; }
    }
    if (![top[(id)kCGWindowName] containsString:guard]) { puts("Foreground Safari window did not identify the candidate"); return 1; }
    if ([operation isEqualToString:@"resize"]) {
      if (!AXIsProcessTrusted()) { puts("Accessibility permission unavailable for window sizing"); return 1; }
      AXUIElementRef app=AXUIElementCreateApplication(front.processIdentifier);
      CFTypeRef window=NULL, title=NULL;
      AXError status=AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute,&window);
      if (status==kAXErrorSuccess) status=AXUIElementCopyAttributeValue((AXUIElementRef)window,kAXTitleAttribute,&title);
      if (status==kAXErrorSuccess && [(__bridge NSString *)title containsString:guard]) {
        int width=atoi(argv[2]);
        if (width<700 || width>1800) status=kAXErrorIllegalArgument;
        else {
          CGSize size=CGSizeMake(width,740);
          AXValueRef value=AXValueCreate(kAXValueCGSizeType,&size);
          status=AXUIElementSetAttributeValue((AXUIElementRef)window,kAXSizeAttribute,value);
          CFRelease(value);
        }
      } else status=kAXErrorCannotComplete;
      if (title) CFRelease(title);
      if (window) CFRelease(window);
      CFRelease(app);
      printf("Accessibility window resize result %d\n",(int)status);
      return status==kAXErrorSuccess ? 0 : 1;
    }
    if (![operation isEqualToString:@"zoom-in"] && ![operation isEqualToString:@"actual-size"]) return 2;
    if (!CGPreflightPostEventAccess()) { puts("Native keyboard permission unavailable"); return 1; }
    BOOL increase=[operation isEqualToString:@"zoom-in"];
    CGKeyCode key=increase ? kVK_ANSI_Equal : kVK_ANSI_0;
    CGEventFlags modifiers=kCGEventFlagMaskCommand;
    if (increase && !strcmp(argv[2],"plus")) modifiers|=kCGEventFlagMaskShift;
    CGEventRef down=CGEventCreateKeyboardEvent(NULL,key,true), up=CGEventCreateKeyboardEvent(NULL,key,false);
    CGEventSetFlags(down,modifiers); CGEventSetFlags(up,modifiers);
    CGEventPost(kCGHIDEventTap,down); CGEventPost(kCGHIDEventTap,up);
    CFRelease(down);CFRelease(up);
    puts("Sent native Safari shortcut to the guarded foreground window");
    return 0;
  }
}
