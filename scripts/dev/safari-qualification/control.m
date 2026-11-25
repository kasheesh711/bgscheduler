// Native controls for one foreground regular Safari window on the disposable runner.
// Check existing permissions only. Never request access or send input to an automation session.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>

static AXUIElementRef childWithTitle(AXUIElementRef node, NSString *wanted, int depth) {
  if (!node || depth<=0) return NULL;
  CFTypeRef children=NULL;
  if (AXUIElementCopyAttributeValue(node,kAXChildrenAttribute,&children)!=kAXErrorSuccess) return NULL;
  AXUIElementRef match=NULL;
  for (id child in (__bridge NSArray *)children) {
    AXUIElementRef item=(__bridge AXUIElementRef)child;
    CFTypeRef title=NULL;
    AXUIElementCopyAttributeValue(item,kAXTitleAttribute,&title);
    BOOL found=[(__bridge NSString *)title isEqualToString:wanted];
    if (title) CFRelease(title);
    match=found ? (AXUIElementRef)CFRetain(item) : childWithTitle(item,wanted,depth-1);
    if (match) break;
  }
  CFRelease(children);return match;
}

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
    if ([operation hasPrefix:@"menu-"]) {
      if (!AXIsProcessTrusted()) { puts("Accessibility permission unavailable for the Safari View menu"); return 1; }
      NSString *itemName=[operation isEqualToString:@"menu-in"] ? @"Zoom In" : [operation isEqualToString:@"menu-out"] ? @"Zoom Out" : nil;
      if (!itemName) return 2;
      AXUIElementRef app=AXUIElementCreateApplication(front.processIdentifier);
      CFTypeRef bar=NULL;
      AXUIElementCopyAttributeValue(app,kAXMenuBarAttribute,&bar);
      AXUIElementRef view=childWithTitle((AXUIElementRef)bar,@"View",1);
      AXError status=view ? AXUIElementPerformAction(view,kAXPressAction) : kAXErrorNoValue;
      AXUIElementRef item=NULL;
      if (status==kAXErrorSuccess) {
        [NSThread sleepForTimeInterval:.2];
        item=childWithTitle(view,itemName,3);
        status=item ? AXUIElementPerformAction(item,kAXPressAction) : kAXErrorNoValue;
        if (status!=kAXErrorSuccess) AXUIElementPerformAction(view,kAXCancelAction);
      }
      if (item) CFRelease(item);
      if (view) CFRelease(view);
      if (bar) CFRelease(bar);
      CFRelease(app);
      printf("Accessibility Safari View menu result %d\n",(int)status);
      return status==kAXErrorSuccess ? 0 : 1;
    }
    if (![operation isEqualToString:@"zoom-in"] && ![operation isEqualToString:@"zoom-out"]) return 2;
    if (!CGPreflightPostEventAccess()) { puts("Native keyboard permission unavailable"); return 1; }
    BOOL increase=[operation isEqualToString:@"zoom-in"];
    CGKeyCode key=increase ? kVK_ANSI_Equal : kVK_ANSI_Minus;
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
