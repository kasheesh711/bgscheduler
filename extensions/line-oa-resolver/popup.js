const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("token");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function schedulerBaseUrl() {
  return baseUrlInput.value.trim().replace(/\/+$/, "");
}

async function activeLineTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://chat.line.biz/")) {
    throw new Error("Open a https://chat.line.biz tab before starting.");
  }
  return tab;
}

async function fetchWorklist(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/line/contacts/oa-resolver/worklist`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load worklist");
  }
  return payload.worklist;
}

async function saveSettings() {
  await chrome.storage.local.set({
    schedulerBaseUrl: schedulerBaseUrl(),
    resolverToken: tokenInput.value.trim(),
  });
}

async function start() {
  startButton.disabled = true;
  try {
    const baseUrl = schedulerBaseUrl();
    const token = tokenInput.value.trim();
    if (!baseUrl || !token) throw new Error("Scheduler URL and token are required.");
    const tab = await activeLineTab();
    await saveSettings();
    setStatus("Loading Scheduler worklist...");
    const worklist = await fetchWorklist(baseUrl, token);
    setStatus(`Loaded ${worklist.rows.length} pending row(s).\nSending to LINE tab...`);
    await chrome.tabs.sendMessage(tab.id, {
      type: "line-oa-resolver:start",
      baseUrl,
      token,
      runId: worklist.runId,
      rows: worklist.rows,
    });
    setStatus(`Running ${worklist.rows.length} row(s). Keep this LINE OA tab open.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    startButton.disabled = false;
  }
}

async function stop() {
  try {
    const tab = await activeLineTab();
    await chrome.tabs.sendMessage(tab.id, { type: "line-oa-resolver:stop" });
    setStatus("Stop requested.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

chrome.storage.local.get(["schedulerBaseUrl", "resolverToken"], (values) => {
  baseUrlInput.value = values.schedulerBaseUrl || "https://bgscheduler.vercel.app";
  tokenInput.value = values.resolverToken || "";
});

startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
