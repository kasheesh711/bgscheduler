// Read visible numbers from captured pixels with Apple's on-device Vision framework.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSURL *directory = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
    NSDictionary *expected = @{@"first": @1, @"middle": @22, @"resized": @22, @"final": @40,
                               @"reopen": @1, @"zoom": @22, @"zoom-final": @40};
    NSMutableDictionary *results = [NSMutableDictionary dictionary];
    BOOL allPassed = YES;
    for (NSString *name in expected) {
      NSURL *file = [directory URLByAppendingPathComponent:[name stringByAppendingPathExtension:@"png"]];
      NSMutableArray *lines = [NSMutableArray array];
      if ([[NSFileManager defaultManager] fileExistsAtPath:file.path]) {
        VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.recognitionLanguages = @[@"en-US"];
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:file options:@{}];
        if ([handler performRequests:@[request] error:nil]) {
          for (VNRecognizedTextObservation *observation in request.results) {
            NSString *text = [observation topCandidates:1].firstObject.string;
            if (text) [lines addObject:text];
          }
        }
      }
      NSString *visible = [[lines componentsJoinedByString:@" "] lowercaseString];
      NSString *pattern = [NSString stringWithFormat:@"\\bcedar\\s+0?%@\\b|\\bpage\\s+%@\\s+of\\s+45\\b", expected[name], expected[name]];
      BOOL found = [visible rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
      results[name] = @{@"expectedPage": expected[name], @"numberRead": @(found), @"reading": lines};
      allPassed = allPassed && found;
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:results options:NSJSONWritingPrettyPrinted error:nil];
    if (![json writeToURL:[directory URLByAppendingPathComponent:@"numbered-pages.json"] atomically:YES]) return 2;
    puts(allPassed ? "Read all seven expected page numbers from the captured Safari pixels."
                   : "At least one numbered Safari image is missing or unreadable.");
    return allPassed ? 0 : 1;
  }
}
