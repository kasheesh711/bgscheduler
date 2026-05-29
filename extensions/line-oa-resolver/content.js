let resolverState = {
  running: false,
  baseUrl: "",
  token: "",
  runId: "",
  rows: [],
  index: 0,
  processedRows: 0,
  capturedRows: 0,
  recentCaptures: [],
};

const RESUME_STATE_KEY = "begifted-line-oa-resolver-state";
const LINE_OA_CHAT_URL_RE = /^https:\/\/chat\.line\.biz\/(U[a-fA-F0-9]{32})\/chat\/(U[a-fA-F0-9]{32})/u;
const LINE_OA_ACCOUNT_RE = /^https:\/\/chat\.line\.biz\/(U[a-fA-F0-9]{32})(?:\/|$)/u;
const candidateUtils = globalThis.LineOaResolverCandidateUtils || {};

function normalize(value) {
  if (typeof candidateUtils.normalize === "function") return candidateUtils.normalize(value);
  return (value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lineOaChatParts(url) {
  const match = String(url || "").match(LINE_OA_CHAT_URL_RE);
  return match ? { lineOaAccountId: match[1], lineUserId: match[2] } : null;
}

function isLineOaChatUrl(url) {
  return Boolean(lineOaChatParts(url));
}

function lineUserIdFromUrl(url) {
  return lineOaChatParts(url)?.lineUserId || null;
}

function currentAccountRootUrl() {
  const match = location.href.match(LINE_OA_ACCOUNT_RE);
  return match ? `https://chat.line.biz/${match[1]}/` : null;
}

function persistResolverState() {
  try {
    sessionStorage.setItem(RESUME_STATE_KEY, JSON.stringify({
      ...resolverState,
      savedAt: Date.now(),
    }));
  } catch {
    // Ignore storage failures; server-side row persistence is still the source of truth.
  }
}

function clearResolverState() {
  try {
    sessionStorage.removeItem(RESUME_STATE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function restoreResolverState() {
  try {
    const raw = sessionStorage.getItem(RESUME_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.running || !parsed.baseUrl || !parsed.token || !parsed.runId || !Array.isArray(parsed.rows)) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > 30 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function ensureSearchContext() {
  if (!isLineOaChatUrl(location.href)) return true;
  const rootUrl = currentAccountRootUrl();
  if (!rootUrl) return true;
  persistResolverState();
  resolverState.running = false;
  location.assign(rootUrl);
  return false;
}

function relationshipRoleFromText(value) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (/\b(mom|mum|mother|mama|mami)\b/u.test(normalized) || /แม่|คุณแม่/u.test(normalized)) return "mom";
  if (/\b(dad|father|papa|daddy)\b/u.test(normalized) || /พ่อ|คุณพ่อ/u.test(normalized)) return "dad";
  if (/\b(secretary|assistant|admin|pa)\b/u.test(normalized) || /เลขา|ผู้ช่วย/u.test(normalized)) return "secretary";
  return "other";
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
  if (!input) return { mode: "selector_missing", candidates: [], rawDomHitCount: 0, visualRowCount: 0 };
  input.focus();
  setInputValue(input, code);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  await sleep(1400);
  const result = findChatCandidates(code);
  return {
    mode: "dom_search",
    ...result,
  };
}

function findChatCandidates(code) {
  const normalizedCode = normalize(code);
  const inputRect = rectObject(findSearchInput());
  const rawElements = [
    ...document.querySelectorAll("a[href*='/chat/'], [role='link'], [role='button'], button, li, [data-testid], div, span"),
  ].filter((element) => isVisible(element));
  const rawHits = [];
  let rawDomHitCount = 0;

  for (const element of rawElements) {
    const text = visibleText(element);
    if (!text || !normalize(text).includes(normalizedCode)) continue;
    const elementRect = rectObject(element);
    if (!elementRect || !rectIsInSearchColumn(elementRect, inputRect)) continue;
    rawDomHitCount += 1;

    const rowElement = closestVisualChatRow(element, normalizedCode, inputRect);
    if (!rowElement) continue;
    const rowRect = rectObject(rowElement);
    if (!rowRect || !rectIsInSearchColumn(rowRect, inputRect)) continue;
    rawHits.push({
      element: rowElement,
      text: visibleText(rowElement) || text,
      rect: rowRect,
      lineChatUrl: chatUrlFromElement(rowElement) || chatUrlFromElement(element),
    });
  }

  const collapsed = typeof candidateUtils.collapseVisualRows === "function"
    ? candidateUtils.collapseVisualRows(rawHits, { limit: 5 })
    : rawHits.slice(0, 5);

  return {
    rawDomHitCount,
    visualRowCount: collapsed.length,
    candidates: collapsed.map((candidate, index) => {
      const rect = candidate.rect || rectObject(candidate.element);
      return {
        ...candidate,
        index,
        top: rect?.top ?? 0,
        clickX: rect ? rect.left + Math.min(Math.max(rect.width * 0.42, 48), rect.width - 24) : null,
        clickY: rect ? rect.top + rect.height / 2 : null,
        fingerprint: candidate.fingerprint || candidateUtils.candidateFingerprint?.(candidate) || `${index}:${candidate.text}`,
      };
    }),
  };
}

function chatUrlFromElement(element) {
  const anchor = element.matches?.("a[href]") ? element : element.querySelector?.("a[href]");
  const href = anchor?.getAttribute?.("href");
  if (!href) return null;
  const url = new URL(href, location.href).toString();
  return isLineOaChatUrl(url) ? url : null;
}

function rectObject(elementOrRect) {
  if (!elementOrRect) return null;
  const rect = typeof elementOrRect.getBoundingClientRect === "function"
    ? elementOrRect.getBoundingClientRect()
    : elementOrRect;
  const top = Number(rect.top);
  const left = Number(rect.left);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![top, left, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    top,
    left,
    width,
    height,
    right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
    bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height,
  };
}

function rectIsInSearchColumn(rect, inputRect) {
  if (typeof candidateUtils.rectIsInSearchColumn === "function") {
    return candidateUtils.rectIsInSearchColumn(rect, inputRect);
  }
  if (!inputRect) return true;
  const paddedLeft = inputRect.left - 32;
  const paddedRight = inputRect.right + Math.max(96, inputRect.width * 0.8);
  return rect.right >= paddedLeft
    && rect.left <= paddedRight
    && rect.bottom >= inputRect.bottom - 24;
}

function closestVisualChatRow(element, normalizedCode, inputRect) {
  const candidates = [];
  let current = element;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isVisible(current)) {
      const rect = rectObject(current);
      const text = visibleText(current);
      if (
        rect
        && text
        && normalize(text).includes(normalizedCode)
        && rectIsInSearchColumn(rect, inputRect)
        && rect.width >= 180
        && rect.height >= 34
        && rect.height <= 190
      ) {
        candidates.push({ element: current, rect, text });
      }
    }
    current = current.parentElement;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => rowCandidateScore(b) - rowCandidateScore(a));
  return candidates[0].element;
}

function rowCandidateScore(candidate) {
  const hasChatHref = chatUrlFromElement(candidate.element) ? 1 : 0;
  const clickableRole = candidate.element.matches?.("a, button, [role='button'], [role='link'], li") ? 1 : 0;
  return hasChatHref * 10_000
    + clickableRole * 2_500
    + Math.min(candidate.rect.width, 800) * 8
    + Math.min(candidate.rect.height, 160) * 16
    + Math.min(candidate.text.length, 260);
}

async function waitForChatUrl(timeoutMs = 5000, previousUrl = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (isLineOaChatUrl(location.href) && (!previousUrl || location.href !== previousUrl)) {
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

function currentAdminNoteText() {
  const candidates = [
    ...document.querySelectorAll("[data-testid], [aria-label], [title], div, span"),
  ]
    .filter((element) => isVisible(element))
    .map((element) => visibleText(element) || element.getAttribute("aria-label") || element.getAttribute("title") || "")
    .map((text) => text.trim())
    .filter((text) => text && text.length <= 240)
    .filter((text) => relationshipRoleFromText(text) !== "unknown");
  return candidates[0] || null;
}

function candidateFromCurrentChat(input) {
  const lineChatUrl = input.afterClickUrl || waitForCurrentUrl();
  if (!lineChatUrl) return null;
  const adminNoteRaw = input.adminNoteRaw || currentAdminNoteText();
  return {
    lineChatUrl,
    chatTitle: currentChatTitle() || input.chatTitle || null,
    adminNoteRaw,
    relationshipRole: relationshipRoleFromText([adminNoteRaw, input.chatTitle].filter(Boolean).join(" ")),
    candidateRank: input.candidateRank,
    captureMode: input.captureMode,
    matchMode: input.matchMode,
    searchCode: input.searchCode,
  };
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

function manualCapture(row, reason, evidence = {}) {
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
      const candidate = candidateFromCurrentChat({
        candidateRank: 1,
        captureMode: "manual",
        matchMode: "admin_selected",
        searchCode: row.searchCode,
      });
      hideOverlay();
      resolve(candidate
        ? { status: "matched", lineChatUrl: candidate.lineChatUrl, chatTitle: candidate.chatTitle, candidates: [candidate], captureMode: "manual", matchMode: "admin_selected", evidence }
        : { status: "error", errorMessage: "Current page is not a LINE OA chat URL.", captureMode: "manual", evidence });
    });
    overlay.querySelector("#line-oa-mark-no-match").addEventListener("click", () => {
      hideOverlay();
      resolve({ status: "no_match", errorMessage: reason, captureMode: "manual", matchMode: "admin_no_match", evidence });
    });
  });
}

function waitForCurrentUrl() {
  return isLineOaChatUrl(location.href)
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
        candidates: result.candidates ?? undefined,
        matchMode: result.matchMode ?? null,
        captureMode: result.captureMode ?? null,
        errorMessage: result.errorMessage ?? null,
        evidence: {
          searchCode: row.searchCode,
          studentKey: row.studentKey,
          extensionUrl: location.href,
          ...(result.evidence ?? {}),
        },
      }],
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Scheduler row update failed (${response.status})`);
  }
}

function debuggerMouseClick(candidate) {
  const x = Number(candidate.clickX);
  const y = Number(candidate.clickY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return Promise.resolve({ ok: false, error: "Candidate row has no valid click coordinates." });
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "line-oa-resolver:debugger-click",
      x,
      y,
    }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ ok: false, error: lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No debugger click response." });
    });
  });
}

async function clickCandidate(candidate) {
  const debuggerResult = await debuggerMouseClick(candidate);
  if (debuggerResult?.ok) {
    return { clickMethod: "debugger_mouse", debuggerResult };
  }

  candidate.element?.click?.();
  return {
    clickMethod: "dom_fallback",
    debuggerError: debuggerResult?.error || "Debugger click failed.",
  };
}

function selectCandidate(candidates, candidateIndex, expectedFingerprint) {
  if (expectedFingerprint) {
    const byFingerprint = candidates.find((candidate) => candidate.fingerprint === expectedFingerprint);
    if (byFingerprint) return byFingerprint;
  }
  return candidates[candidateIndex] || null;
}

async function waitForSearchResults(searchCode, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isLineOaChatUrl(location.href) && findSearchInput()) {
      const search = await searchLineOa(searchCode);
      if (search.mode !== "selector_missing") return { ok: true, search };
    }
    await sleep(250);
  }
  return { ok: false };
}

async function returnToSearchResults(searchCode) {
  const beforeBackUrl = location.href;
  window.history.back();
  const result = await waitForSearchResults(searchCode);
  return {
    ...result,
    beforeBackUrl,
    afterBackUrl: location.href,
  };
}

async function captureCandidateForSearch(row, searchCode, candidateIndex, options = {}) {
  if (!ensureSearchContext()) return { deferred: true };
  const search = await searchLineOa(searchCode);
  const candidate = selectCandidate(search.candidates, candidateIndex, options.expectedFingerprint);
  if (!candidate) {
    return { error: `Candidate ${candidateIndex + 1} disappeared before capture.` };
  }

  const beforeClickUrl = location.href;
  const clickResult = await clickCandidate(candidate);
  const afterClickUrl = await waitForChatUrl(5000, beforeClickUrl);
  const clickChangedUrl = Boolean(afterClickUrl && afterClickUrl !== beforeClickUrl);
  if (!afterClickUrl || !clickChangedUrl) {
    return {
      error: "Candidate did not open a LINE OA chat URL.",
      evidence: {
        rawDomHitCount: search.rawDomHitCount,
        visualRowCount: search.visualRowCount,
        candidateRowFingerprint: candidate.fingerprint,
        beforeClickUrl,
        afterClickUrl: afterClickUrl || location.href,
        clickedCandidateText: candidate.text,
        clickedCandidateHref: candidate.lineChatUrl,
        clickChangedUrl,
        clickMethod: clickResult.clickMethod,
        debuggerError: clickResult.debuggerError,
      },
    };
  }

  return {
    candidate: candidateFromCurrentChat({
      chatTitle: currentChatTitle() || candidate.text,
      adminNoteRaw: candidate.text,
      candidateRank: candidateIndex + 1,
      captureMode: "extension",
      matchMode: "dom_search",
      searchCode,
      afterClickUrl,
    }),
    evidence: {
      rawDomHitCount: search.rawDomHitCount,
      visualRowCount: search.visualRowCount,
      candidateRowFingerprint: candidate.fingerprint,
      beforeClickUrl,
      afterClickUrl,
      clickedCandidateText: candidate.text,
      clickedCandidateHref: candidate.lineChatUrl,
      clickChangedUrl,
      clickMethod: clickResult.clickMethod,
      debuggerError: clickResult.debuggerError,
    },
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate?.lineChatUrl) continue;
    const key = candidate.lineChatUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function captureSearchCodeCandidates(row, searchCode) {
  if (!ensureSearchContext()) return { deferred: true };
  const search = await searchLineOa(searchCode);
  if (search.mode === "selector_missing") {
    return manualCapture(row, "Could not find the LINE OA search input. Search manually, open the correct chat, then capture.");
  }
  if (search.candidates.length === 0) {
    return {
      candidates: [],
      mode: search.mode,
      evidence: [{
        rawDomHitCount: search.rawDomHitCount,
        visualRowCount: search.visualRowCount,
        clickMethod: null,
      }],
    };
  }

  const captured = [];
  const evidence = [];
  const initialCandidates = search.candidates.map((candidate) => ({
    fingerprint: candidate.fingerprint,
    text: candidate.text,
  }));
  for (let index = 0; index < search.candidates.length; index += 1) {
    const result = await captureCandidateForSearch(row, searchCode, index, {
      expectedFingerprint: initialCandidates[index]?.fingerprint,
    });
    if (result.deferred) return result;
    if (result.error) {
      return manualCapture(row, `${result.error} Search manually, open the correct chat, then capture.`, {
        searchMode: search.mode,
        rawDomHitCount: search.rawDomHitCount,
        visualRowCount: search.visualRowCount,
        candidateRowFingerprint: initialCandidates[index]?.fingerprint,
        clickedCandidateText: initialCandidates[index]?.text,
        attemptEvidence: [
          ...evidence,
          ...(result.evidence ? [result.evidence] : []),
        ],
      });
    }
    if (result.candidate) captured.push(result.candidate);
    if (result.evidence) evidence.push(result.evidence);
    if (index < search.candidates.length - 1) {
      const returned = await returnToSearchResults(searchCode);
      evidence.push({
        beforeBackUrl: returned.beforeBackUrl,
        afterBackUrl: returned.afterBackUrl,
        returnedToSearchResults: returned.ok,
      });
      if (!returned.ok) {
        return manualCapture(row, "Captured one chat but could not return to LINE OA search results for the remaining candidates. Open the correct chat manually, then capture.", {
          searchMode: search.mode,
          rawDomHitCount: search.rawDomHitCount,
          visualRowCount: search.visualRowCount,
          attemptEvidence: evidence,
        });
      }
    }
  }

  return {
    candidates: dedupeCandidates(captured),
    mode: search.candidates.length > 1 ? "multi_visual_row" : search.mode,
    evidence,
  };
}

async function processRow(row) {
  const searchCodes = (row.searchCodes && row.searchCodes.length > 0 ? row.searchCodes : [row.searchCode]).filter(Boolean);
  const allCandidates = [];
  const attemptedCodes = [];
  const attemptEvidence = [];

  for (const searchCode of searchCodes) {
    attemptedCodes.push(searchCode);
    const result = await captureSearchCodeCandidates(row, searchCode);
    if (result.deferred) return result;
    if (result.status) return result;
    allCandidates.push(...(result.candidates ?? []));
    attemptEvidence.push(...(result.evidence ?? []));
    if (allCandidates.length > 0) break;
  }

  const candidates = dedupeCandidates(allCandidates);
  if (candidates.length === 0) {
    return {
      status: "no_match",
      matchMode: "dom_search",
      captureMode: "extension",
      errorMessage: `No visible chat matched any student code: ${attemptedCodes.join(", ")}.`,
      evidence: {
        attemptedSearchCodes: attemptedCodes,
        attemptEvidence,
      },
    };
  }

  const [first] = candidates;
  return {
    status: candidates.length > 1 ? "ambiguous" : "matched",
    lineChatUrl: first.lineChatUrl,
    chatTitle: first.chatTitle,
    candidates,
    matchMode: candidates.length > 1 ? "multi_candidate" : "dom_search",
    captureMode: "extension",
    evidence: {
      attemptedSearchCodes: attemptedCodes,
      attemptEvidence,
      beforeClickUrl: attemptEvidence[0]?.beforeClickUrl,
      afterClickUrl: attemptEvidence[0]?.afterClickUrl,
      clickedCandidateText: attemptEvidence[0]?.clickedCandidateText,
      clickChangedUrl: attemptEvidence[0]?.clickChangedUrl,
    },
  };
}

function repeatedSameChatCapture(row, result) {
  const lineUserId = lineUserIdFromUrl(result.lineChatUrl || result.candidates?.[0]?.lineChatUrl);
  if (!lineUserId) return false;
  const recent = [
    ...resolverState.recentCaptures,
    { lineUserId, studentKey: row.studentKey, searchCode: row.searchCode },
  ].slice(-3);
  resolverState.recentCaptures = recent;
  const distinctStudents = new Set(recent.map((capture) => capture.studentKey));
  return recent.length >= 3
    && distinctStudents.size >= 3
    && recent.every((capture) => capture.lineUserId === lineUserId);
}

async function runResolver() {
  resolverState.running = true;
  for (; resolverState.index < resolverState.rows.length; resolverState.index += 1) {
    if (!resolverState.running) break;
    const row = resolverState.rows[resolverState.index];
    try {
      persistResolverState();
      const result = await processRow(row);
      if (result.deferred) return;
      resolverState.lastResultHadCapture = Boolean(result.lineChatUrl || result.candidates?.length);
      if (resolverState.lastResultHadCapture && repeatedSameChatCapture(row, result)) {
        const lineUserId = lineUserIdFromUrl(result.lineChatUrl || result.candidates?.[0]?.lineChatUrl);
        resolverState.running = false;
        const overlay = ensureOverlay();
        overlay.innerHTML = `
          <div style="font-weight:700;margin-bottom:4px;">LINE OA Resolver paused</div>
          <div style="color:#636973;margin-bottom:8px;">The same LINE chat (${escapeHtml(lineUserId)}) was captured for several unrelated student codes. Search appears stuck in one chat.</div>
        `;
        await postRow(row, {
          status: "error",
          errorMessage: "Same LINE chat captured across unrelated student codes; resolver paused.",
          matchMode: "stuck_same_chat_guard",
          captureMode: "extension",
          evidence: result.evidence,
        });
        break;
      }
      await postRow(row, result);
    } catch (error) {
      await postRow(row, {
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        matchMode: "extension_error",
        captureMode: "extension",
      });
    }
    resolverState.processedRows += 1;
    if (resolverState.lastResultHadCapture) resolverState.capturedRows += 1;
    resolverState.lastResultHadCapture = false;
    if (resolverState.processedRows >= 10 && resolverState.capturedRows === 0) {
      resolverState.running = false;
      const overlay = ensureOverlay();
      overlay.innerHTML = `
        <div style="font-weight:700;margin-bottom:4px;">LINE OA Resolver paused</div>
        <div style="color:#636973;margin-bottom:8px;">Processed 10 rows without capturing any valid chat URL. Stop and check that LINE OA search is opening chat pages.</div>
      `;
      break;
    }
    resolverState.index += 1;
    persistResolverState();
    resolverState.index -= 1;
    await sleep(500);
  }
  resolverState.running = false;
  if (resolverState.index >= resolverState.rows.length) {
    hideOverlay();
  }
  clearResolverState();
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
    processedRows: 0,
    capturedRows: 0,
    lastResultHadCapture: false,
    recentCaptures: [],
  };
  persistResolverState();
  void runResolver();
  sendResponse({ ok: true });
  return false;
});

const restoredResolverState = restoreResolverState();
if (restoredResolverState) {
  resolverState = {
    ...resolverState,
    ...restoredResolverState,
    running: true,
    recentCaptures: Array.isArray(restoredResolverState.recentCaptures) ? restoredResolverState.recentCaptures : [],
  };
  window.setTimeout(() => {
    if (resolverState.running) void runResolver();
  }, 1200);
}
