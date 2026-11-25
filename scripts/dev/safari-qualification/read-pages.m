// Read only the expected synthetic marker with Apple's on-device Vision framework.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Vision/Vision.h>

static NSDictionary *readPage(NSURL *file, NSNumber *page) {
  VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
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
    if (argc==2 && !strcmp(argv[1],"--fixture-window")) {
      // Pick an on-screen Safari window only when its title identifies the synthetic fixture uniquely.
      NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
      NSNumber *found = nil;
      for (NSDictionary *w in windows) {
        NSString *owner=w[(id)kCGWindowOwnerName], *title=w[(id)kCGWindowName];
        if ([owner isEqualToString:@"Safari"] && [title containsString:@"Numbered PDF verification"] && [w[(id)kCGWindowLayer] intValue]==0) {
          if (found) return 1;
          found=w[(id)kCGWindowNumber];
        }
      }
      if (!found) return 1;
      printf("%u\n",found.unsignedIntValue);
      return 0;
    }
    if (argc!=2 && argc!=3) return 2;
    NSURL *location = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    if (argc==3) {
      NSNumber *page = @([[NSString stringWithUTF8String:argv[2]] integerValue]);
      return [readPage(location,page)[@"numberRead"] boolValue] ? 0 : 1;
    }
    NSDictionary *expected = @{@"first":@1, @"middle":@22, @"resized":@22, @"final":@40,
                               @"reopen":@1, @"zoom":@22, @"zoom-final":@40};
    NSMutableDictionary *results = [NSMutableDictionary dictionary];
    BOOL allPassed=YES;
    for (NSString *key in expected) {
      NSURL *file=[location URLByAppendingPathComponent:[key stringByAppendingPathExtension:@"png"]];
      results[key]=readPage(file,expected[key]);
      allPassed = allPassed && [results[key][@"numberRead"] boolValue];
    }
    NSData *json=[NSJSONSerialization dataWithJSONObject:results options:NSJSONWritingPrettyPrinted error:nil];
    if (![json writeToURL:[location URLByAppendingPathComponent:@"numbered-pages.json"] atomically:YES]) return 2;
    puts(allPassed ? "Read all seven page numbers in actual Safari screenshots." : "At least one required screenshot did not show its expected page number.");
    return allPassed ? 0 : 1;
  }
}
