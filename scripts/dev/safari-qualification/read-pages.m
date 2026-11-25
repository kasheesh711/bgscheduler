// Read only the expected synthetic marker with Apple's on-device Vision framework.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Vision/Vision.h>

static NSDictionary *readPage(NSURL *file, NSNumber *page) {
  VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  // Narrow landscape previews have a visible 8–10 pixel heading in a full-window capture.
  request.minimumTextHeight = 0.005;
  request.usesLanguageCorrection = NO;
  request.recognitionLanguages = @[@"en-US"];
  NSString *match = nil;
  if ([[NSFileManager defaultManager] fileExistsAtPath:file.path]) {
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:file options:@{}];
    if ([handler performRequests:@[request] error:nil]) {
      NSString *pattern = [NSString stringWithFormat:@"\\bcedar\\s+0?%@\\b|\\bpage\\s+%@\\s+of\\s+45\\b", page, page];
      for (VNRecognizedTextObservation *observation in request.results) {
        NSString *text = [observation topCandidates:1].firstObject.string;
        NSRange range = [text.lowercaseString rangeOfString:pattern options:NSRegularExpressionSearch];
        if (range.location != NSNotFound) {
          match = [text substringWithRange:range];
          break;
        }
      }
    }
  }
  return @{@"expectedPage":page, @"numberRead":@(match != nil), @"visibleMarker":match ?: @""};
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if ((argc==3 || argc==4) && !strcmp(argv[1],"--fixture-window")) {
      // Pick an on-screen Safari window only when its title identifies the synthetic fixture uniquely.
      NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
      NSString *fixtureTitle=[NSString stringWithUTF8String:argv[2]];
      if (![fixtureTitle hasPrefix:@"Numbered PDF verification - "]) return 1;
      NSNumber *found = nil;
      for (NSDictionary *w in windows) {
        NSString *owner=w[(id)kCGWindowOwnerName], *title=w[(id)kCGWindowName];
        BOOL matchingName=[title containsString:fixtureTitle];
        // If macOS withholds window titles, use only the independently verified Safari
        // document's window id. The caller checks the tab's title and loopback URL.
        BOOL matchingId=argc==4 && !title.length && [w[(id)kCGWindowNumber] unsignedIntValue]==strtoul(argv[3],NULL,10);
        if ([owner isEqualToString:@"Safari"] && (matchingName || matchingId) && [w[(id)kCGWindowLayer] intValue]==0) {
          if (found) return 1;
          found=w[(id)kCGWindowNumber];
        }
      }
      if (!found) return 1;
      printf("%u\n",found.unsignedIntValue);
      return 0;
    }
    if (argc!=3) return 2;
    NSURL *location=[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    NSNumber *expected=@([[NSString stringWithUTF8String:argv[2]] integerValue]);
    NSDictionary *reading=readPage(location,expected);
    if (![reading[@"numberRead"] boolValue]) return 1;
    puts([reading[@"visibleMarker"] UTF8String]);
    return 0;
  }
}
