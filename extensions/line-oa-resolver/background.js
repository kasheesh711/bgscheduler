function chromeCallback(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function sendDebuggerCommand(target, method, params) {
  return chromeCallback((done) => chrome.debugger.sendCommand(target, method, params, done));
}

async function debuggerClick(tabId, x, y) {
  const target = { tabId };
  let attached = false;
  try {
    await chromeCallback((done) => chrome.debugger.attach(target, "1.3", done));
    attached = true;
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true };
  } finally {
    if (attached) {
      await chromeCallback((done) => chrome.debugger.detach(target, done)).catch(() => undefined);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "line-oa-resolver:debugger-click") return false;
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "No active LINE OA tab was available for debugger click." });
    return false;
  }

  const x = Number(message.x);
  const y = Number(message.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    sendResponse({ ok: false, error: "Invalid click coordinates." });
    return false;
  }

  void debuggerClick(tabId, x, y)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});
