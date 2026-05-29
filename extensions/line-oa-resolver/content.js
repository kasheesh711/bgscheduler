let resolverState = {
  running: false,
  baseUrl: "",
  token: "",
  runId: "",
  rows: [],
  index: 0,
};

function normalize(value) {
  return (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visibleText(element) {
  return (element.innerText || element.textContent || "").trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function findSearchInput() {
  const candidates = [
    ...document.querySelectorAll("input[type='search'], input[placeholder*='Search' i], input[placeholder*='ค้นหา' i], input"),
  ];
  return candidates.find((input) => isVisible(input) && !input.disabled && input.offsetParent !== null) || null;
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function searchLineOa(code) {
  const input = findSearchInput();
  if (!input) return { mode: "selector_missing", candidates: [] };
  input.focus();
  setInputValue(input, code);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  await sleep(1400);
  return {
    mode: "dom_search",
    candidates: findChatCandidates(code),
  };
}

function findChatCandidates(code) {
  const normalizedCode = normalize(code);
  const clickable = [
    ...document.querySelectorAll("a, button, [role='button'], [data-testid], li, div"),
  ].filter((element) => isVisible(element));
  const seen = new Set();
  const candidates = [];
  for (const element of clickable) {
    const text = visibleText(element);
    if (!text || !normalize(text).includes(normalizedCode)) continue;
    const rect = element.getBoundingClientRect();
    const key = `${Math.round(rect.top)}:${Math.round(rect.left)}:${text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ element, text, top: rect.top });
  }
  return candidates
    .sort((a, b) => a.top - b.top)
    .slice(0, 5);
}

async function waitForChatUrl(timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (/^https:\/\/chat\.line\.biz\/U[a-fA-F0-9]{32}\/chat\/U[a-fA-F0-9]{32}/u.test(location.href)) {
      return location.href;
    }
    await sleep(250);
  }
  return null;
}

function currentChatTitle() {
  const heading = document.querySelector("h1, h2, [role='heading']");
  const headingText = heading ? visibleText(heading) : "";
  if (headingText && headingText.length <= 120) return headingText;
  const title = document.title.replace(/\s*-\s*LINE.*$/i, "").trim();
  return title || null;
}

function ensureOverlay() {
  let overlay = document.getElementById("line-oa-resolver-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "line-oa-resolver-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "width:340px",
    "border:1px solid #d8d4cb",
    "border-radius:12px",
    "background:#fff",
    "box-shadow:0 18px 50px rgba(0,0,0,.22)",
    "font:13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "color:#15171a",
    "padding:12px",
  ].join(";");
  document.body.appendChild(overlay);
  return overlay;
}

function hideOverlay() {
  document.getElementById("line-oa-resolver-overlay")?.remove();
}

function manualCapture(row, reason) {
  const overlay = ensureOverlay();
  overlay.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;">LINE OA Resolver paused</div>
    <div style="color:#636973;margin-bottom:8px;">${escapeHtml(reason)}</div>
    <div style="border:1px solid #ece7df;border-radius:8px;padding:8px;margin-bottom:8px;">
      <div style="font-size:11px;color:#636973;text-transform:uppercase;font-weight:700;">Search code</div>
      <div style="font-weight:700;">${escapeHtml(row.searchCode)}</div>
      <div style="font-size:12px;color:#636973;">${escapeHtml(row.studentName)}</div>
    </div>
    <button id="line-oa-capture-current" style="height:32px;border:0;border-radius:8px;padding:0 10px;background:#0b83b8;color:#fff;font-weight:700;cursor:pointer;">Capture current chat</button>
    <button id="line-oa-mark-no-match" style="height:32px;border:1px solid #d8d4cb;border-radius:8px;padding:0 10px;background:#fff;color:#15171a;font-weight:700;cursor:pointer;margin-left:6px;">No match</button>
  `;
  return new Promise((resolve) => {
    overlay.querySelector("#line-oa-capture-current").addEventListener("click", () => {
      const url = waitForCurrentUrl();
      hideOverlay();
      resolve(url
        ? { status: "matched", lineChatUrl: url, chatTitle: currentChatTitle(), captureMode: "manual", matchMode: "admin_selected" }
        : { status: "error", errorMessage: "Current page is not a LINE OA chat URL.", captureMode: "manual" });
    });
    overlay.querySelector("#line-oa-mark-no-match").addEventListener("click", () => {
      hideOverlay();
      resolve({ status: "no_match", errorMessage: reason, captureMode: "manual", matchMode: "admin_no_match" });
    });
  });
}

function waitForCurrentUrl() {
  return /^https:\/\/chat\.line\.biz\/U[a-fA-F0-9]{32}\/chat\/U[a-fA-F0-9]{32}/u.test(location.href)
    ? location.href
    : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function postRow(row, result) {
  const response = await fetch(`${resolverState.baseUrl}/api/line/contacts/oa-resolver/runs/${resolverState.runId}/rows`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolverState.token}`,
    },
    body: JSON.stringify({
      rows: [{
        rowId: row.rowId,
        status: result.status,
        lineChatUrl: result.lineChatUrl ?? null,
        chatTitle: result.chatTitle ?? null,
        matchMode: result.matchMode ?? null,
        captureMode: result.captureMode ?? null,
        errorMessage: result.errorMessage ?? null,
        evidence: {
          searchCode: row.searchCode,
          studentKey: row.studentKey,
          extensionUrl: location.href,
        },
      }],
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Scheduler row update failed (${response.status})`);
  }
}

async function processRow(row) {
  const search = await searchLineOa(row.searchCode);
  if (search.mode === "selector_missing") {
    return manualCapture(row, "Could not find the LINE OA search input. Search manually, open the correct chat, then capture.");
  }
  if (search.candidates.length === 0) {
    return { status: "no_match", matchMode: search.mode, captureMode: "extension", errorMessage: "No visible chat matched the student code." };
  }
  if (search.candidates.length > 1) {
    return manualCapture(row, `Found ${search.candidates.length} possible chats. Open the correct one, then capture.`);
  }

  search.candidates[0].element.click();
  const url = await waitForChatUrl();
  if (!url) {
    return manualCapture(row, "The single visible match did not open a chat URL. Open the correct chat, then capture.");
  }
  return {
    status: "matched",
    lineChatUrl: url,
    chatTitle: currentChatTitle() || search.candidates[0].text,
    matchMode: search.mode,
    captureMode: "extension",
  };
}

async function runResolver() {
  resolverState.running = true;
  for (; resolverState.index < resolverState.rows.length; resolverState.index += 1) {
    if (!resolverState.running) break;
    const row = resolverState.rows[resolverState.index];
    try {
      const result = await processRow(row);
      await postRow(row, result);
    } catch (error) {
      await postRow(row, {
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        matchMode: "extension_error",
        captureMode: "extension",
      });
    }
    await sleep(500);
  }
  resolverState.running = false;
  if (resolverState.index >= resolverState.rows.length) {
    hideOverlay();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "line-oa-resolver:ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "line-oa-resolver:stop") {
    resolverState.running = false;
    hideOverlay();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "line-oa-resolver:start") return false;
  resolverState = {
    running: true,
    baseUrl: message.baseUrl,
    token: message.token,
    runId: message.runId,
    rows: message.rows || [],
    index: 0,
  };
  void runResolver();
  sendResponse({ ok: true });
  return false;
});
