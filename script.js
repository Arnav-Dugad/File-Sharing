const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const LOW_WATER_MARK = 512 * 1024;
const LOG_LIMIT = 260;
const RECONNECT_BASE_MS = 1200;
const RECONNECT_CAP_MS = 10000;
const PBKDF2_ROUNDS = 250000;
const HISTORY_KEY = "nebulaShareHistoryV1";
const LOG_KEY = "nebulaShareLogsV1";
const ADMIN_PASSCODE = "8574";
const ADMIN_AUTH_KEY = "nebulaAdminAuthUntil";

const ui = {
  selfPeerId: document.getElementById("selfPeerId"),
  remotePeerId: document.getElementById("remotePeerId"),
  connectionStatus: document.getElementById("connectionStatus"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  chooseFileBtn: document.getElementById("chooseFileBtn"),
  selectedFileName: document.getElementById("selectedFileName"),
  generateLinkBtn: document.getElementById("generateLinkBtn"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  shareLink: document.getElementById("shareLink"),
  progressText: document.getElementById("progressText"),
  speedText: document.getElementById("speedText"),
  transferredText: document.getElementById("transferredText"),
  progressBar: document.getElementById("progressBar"),
  batchProgressText: document.getElementById("batchProgressText"),
  integrityText: document.getElementById("integrityText"),
  peerVisual: document.getElementById("peerVisual"),
  peerTagA: document.getElementById("peerTagA"),
  peerTagB: document.getElementById("peerTagB"),
  logConsole: document.getElementById("logConsole"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  historyList: document.getElementById("historyList"),
  toast: document.getElementById("toast"),
  encryptionToggle: document.getElementById("encryptionToggle"),
  passphraseInput: document.getElementById("passphraseInput"),
  qrCode: document.getElementById("qrCode"),
  refreshQrBtn: document.getElementById("refreshQrBtn"),
  queueList: document.getElementById("queueList"),
  queueMeta: document.getElementById("queueMeta"),
  securityChip: document.getElementById("securityChip"),
  installAppBtn: document.getElementById("installAppBtn"),
  adminOpenBtn: document.getElementById("adminOpenBtn"),
  adminModal: document.getElementById("adminModal"),
  adminPasscodeInput: document.getElementById("adminPasscodeInput"),
  adminUnlockBtn: document.getElementById("adminUnlockBtn"),
  adminCancelBtn: document.getElementById("adminCancelBtn"),
  incomingPromptModal: document.getElementById("incomingPromptModal"),
  incomingPromptText: document.getElementById("incomingPromptText"),
  incomingAcceptBtn: document.getElementById("incomingAcceptBtn"),
  incomingDeclineBtn: document.getElementById("incomingDeclineBtn"),
};

const params = new URLSearchParams(window.location.search);
const hostPeerId = params.get("host");
const initialSessionParam = params.get("sid") || "";
const initialEncParam = params.get("enc") === "1";

const state = {
  role: hostPeerId ? "receiver" : "sender",
  peer: null,
  conn: null,
  selfId: "",
  remoteId: hostPeerId || "",
  reconnectTimer: null,
  reconnectAttempts: 0,
  activeSessionId: initialSessionParam,
  deferredInstallPrompt: null,
  sender: {
    inProgress: false,
    bytesSent: 0,
    totalBytes: 0,
    resumeBufferedPromise: null,
    resolveBufferedWait: null,
    autoStartTimer: null,
    transferToken: 0,
    queue: [],
    activeQueueId: "",
  },
  receiver: {
    sessions: {},
    activeDecryptKey: null,
    activeDecryptSalt: "",
    pendingSessionId: "",
  },
  metrics: {
    startTime: 0,
    lastTick: 0,
    lastBytes: 0,
    speedTimer: null,
    readBytes: () => 0,
  },
  history: loadHistory(),
  logs: loadLogs(),
};

init();

function init() {
  bindUI();
  initPeer();
  registerPwaFeatures();

  renderQrCode("");
  renderQueue();
  renderHistory();
  updateBatchProgress();
  updateSecurityChip();

  log("App initialized. WebRTC transport is DTLS-encrypted by default.", "success");
  log("Optional chunk-level AES-GCM encryption is available with a passphrase.", "success");

  if (state.role === "receiver") {
    ui.selectedFileName.textContent = "Receiver mode: waiting for sender";
    ui.dropZone.classList.add("disabled");
    ui.fileInput.disabled = true;
    ui.generateLinkBtn.disabled = true;
    ui.copyLinkBtn.disabled = true;
    ui.chooseFileBtn.disabled = true;

    if (initialEncParam) {
      ui.encryptionToggle.checked = true;
      ui.securityChip.textContent = "Awaiting encrypted stream passphrase";
    }
  }
}

function bindUI() {
  ui.fileInput.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }
    setSelectedFiles(files);
    ui.fileInput.value = "";
  });

  ui.chooseFileBtn.addEventListener("click", () => {
    if (state.role !== "sender") {
      return;
    }
    ui.fileInput.click();
  });

  ui.dropZone.addEventListener("click", (event) => {
    if (state.role !== "sender") {
      return;
    }
    if (event.target === ui.fileInput) {
      return;
    }
    ui.fileInput.click();
  });

  ui.dropZone.addEventListener("keydown", (event) => {
    if (state.role !== "sender") {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      ui.fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    ui.dropZone.addEventListener(eventName, (event) => {
      if (state.role !== "sender") {
        return;
      }
      event.preventDefault();
      ui.dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    ui.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      ui.dropZone.classList.remove("drag-over");
    });
  });

  ui.dropZone.addEventListener("drop", (event) => {
    if (state.role !== "sender") {
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      return;
    }
    setSelectedFiles(files);
  });

  ui.encryptionToggle.addEventListener("change", async () => {
    if (state.role === "sender") {
      await refreshQueueSecurityProfile();
      refreshShareLink(false);
      updateSendControls();
      renderQueue();
    }
    updateSecurityChip();
  });

  ui.passphraseInput.addEventListener("input", async () => {
    if (state.role === "sender") {
      await refreshQueueSecurityProfile();
      refreshShareLink(false);
      updateSendControls();
      renderQueue();
    }
    updateSecurityChip();
  });

  ui.generateLinkBtn.addEventListener("click", () => {
    refreshShareLink(true);
  });

  ui.copyLinkBtn.addEventListener("click", async () => {
    const url = ui.shareLink.value.trim();
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      showToast("Share link copied");
      log("Share link copied to clipboard.", "success");
    } catch (error) {
      log(`Clipboard copy failed: ${error.message}`, "error");
    }
  });

  ui.reconnectBtn.addEventListener("click", () => {
    forceReconnect();
  });

  ui.refreshQrBtn.addEventListener("click", () => {
    renderQrCode(ui.shareLink.value.trim());
  });

  ui.clearLogsBtn.addEventListener("click", () => {
    ui.logConsole.innerHTML = "";
  });

  ui.clearHistoryBtn.addEventListener("click", () => {
    state.history = [];
    persistHistory();
    renderHistory();
    showToast("History cleared");
  });

  ui.installAppBtn.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      showToast("Install prompt unavailable");
      return;
    }

    state.deferredInstallPrompt.prompt();
    const choice = await state.deferredInstallPrompt.userChoice;
    log(`PWA install choice: ${choice.outcome}`);
    state.deferredInstallPrompt = null;
    ui.installAppBtn.disabled = true;
  });

  ui.adminOpenBtn.addEventListener("click", () => {
    openAdminModal();
  });

  ui.adminCancelBtn.addEventListener("click", () => {
    closeAdminModal();
  });

  ui.adminUnlockBtn.addEventListener("click", () => {
    unlockAdmin();
  });

  ui.adminPasscodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      unlockAdmin();
    }
  });

  ui.adminModal.addEventListener("click", (event) => {
    if (event.target === ui.adminModal) {
      closeAdminModal();
    }
  });

  ui.incomingAcceptBtn.addEventListener("click", () => {
    acceptIncomingSession();
  });

  ui.incomingDeclineBtn.addEventListener("click", () => {
    declineIncomingSession();
  });

  ui.incomingPromptModal.addEventListener("click", (event) => {
    if (event.target === ui.incomingPromptModal) {
      declineIncomingSession();
    }
  });
}

function registerPwaFeatures() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("sw.js")
      .then(() => {
        log("Service worker registered for offline shell.", "success");
      })
      .catch((error) => {
        log(`Service worker registration failed: ${error.message}`, "error");
      });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    ui.installAppBtn.disabled = false;
    log("PWA install prompt is ready.", "success");
  });

  window.addEventListener("appinstalled", () => {
    log("App installed successfully.", "success");
    showToast("App installed");
    ui.installAppBtn.disabled = true;
    state.deferredInstallPrompt = null;
  });
}

function initPeer() {
  if (!window.Peer) {
    setStatus("PeerJS failed to load", "error");
    log("PeerJS library not found. Check internet/CDN availability.", "error");
    return;
  }

  state.peer = new Peer();

  state.peer.on("open", (id) => {
    state.selfId = id;
    ui.selfPeerId.textContent = id;
    ui.peerTagA.textContent = shortId(id);

    setStatus(state.role === "receiver" ? "Ready (receiver)" : "Ready (sender)");
    log(`Your peer is ready: ${id}`, "success");

    if (state.role === "sender") {
      updateSendControls();
      refreshShareLink(false);
      pumpSenderQueue();
    }

    if (state.role === "receiver" && hostPeerId) {
      connectToHost(hostPeerId);
    }
  });

  state.peer.on("connection", (conn) => {
    if (state.role !== "sender") {
      log(`Incoming connection ignored in receiver mode from ${conn.peer}`);
      conn.close();
      return;
    }

    log(`Incoming connection from ${conn.peer}`);
    attachConnection(conn);
  });

  state.peer.on("error", (error) => {
    setStatus("Peer error", "error");
    log(`Peer error: ${error.type || "unknown"} ${error.message || ""}`, "error");
  });

  state.peer.on("disconnected", () => {
    setStatus("Signaling disconnected", "error");
    log("Peer disconnected from signaling server. Trying to reconnect...", "error");
    state.peer.reconnect();
  });
}

function forceReconnect() {
  if (state.role === "receiver" && hostPeerId) {
    log("Manual reconnect requested.");
    connectToHost(hostPeerId, true);
    return;
  }

  if (state.role === "sender") {
    showToast("Sender waits for receiver to connect");
    return;
  }

  showToast("No reconnect target right now");
}

function connectToHost(targetPeerId, manual = false) {
  if (!state.peer || !state.selfId || !targetPeerId) {
    return;
  }

  if (state.conn && state.conn.open && state.conn.peer === targetPeerId) {
    return;
  }

  if (state.conn && !state.conn.open) {
    try {
      state.conn.close();
    } catch (error) {
      log(`Previous connection close warning: ${error.message}`);
    }
  }

  clearReconnectTimer();
  setStatus(manual ? "Reconnecting..." : "Connecting...");
  state.remoteId = targetPeerId;
  ui.remotePeerId.textContent = targetPeerId;
  ui.peerTagB.textContent = shortId(targetPeerId);
  log(`Connecting to sender: ${targetPeerId}`);

  const conn = state.peer.connect(targetPeerId, {
    reliable: true,
    serialization: "binary",
  });

  attachConnection(conn);
}

function attachConnection(conn) {
  state.conn = conn;

  conn.on("open", async () => {
    state.remoteId = conn.peer;
    ui.remotePeerId.textContent = conn.peer;
    ui.peerTagB.textContent = shortId(conn.peer);

    clearReconnectTimer();
    state.reconnectAttempts = 0;
    setStatus("Connected", "success");
    ui.peerVisual.classList.add("connected");
    setupDataChannelBackpressure(conn);

    log(`Connection established with ${conn.peer}`, "success");

    if (state.role === "receiver") {
      sendResumeRequest();
      return;
    }

    announceCurrentMeta();
    scheduleAutoStartFallback();
  });

  conn.on("data", async (payload) => {
    await handleData(payload);
  });

  conn.on("close", () => {
    clearSenderStartTimer();
    setStatus("Connection closed");
    ui.peerVisual.classList.remove("connected");
    log("Peer connection closed.");
    stopSpeedTicker();

    if (state.role === "receiver" && !isReceiverAllDone()) {
      scheduleReceiverReconnect();
    }
  });

  conn.on("error", (error) => {
    setStatus("Connection error", "error");
    log(`Connection error: ${error.message || "unknown"}`, "error");

    if (state.role === "receiver" && !isReceiverAllDone()) {
      scheduleReceiverReconnect();
    }
  });
}

function setupDataChannelBackpressure(conn) {
  const dc = conn.dataChannel || conn._dc;
  if (!dc) {
    log("No direct data channel handle exposed by PeerJS.");
    return;
  }

  dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
  dc.onbufferedamountlow = () => {
    if (
      state.sender.resolveBufferedWait &&
      dc.bufferedAmount <= dc.bufferedAmountLowThreshold
    ) {
      state.sender.resolveBufferedWait();
      state.sender.resolveBufferedWait = null;
      state.sender.resumeBufferedPromise = null;
    }
  };

  log("Backpressure control enabled with onbufferedamountlow.", "success");
}

function scheduleReceiverReconnect() {
  if (state.role !== "receiver" || !hostPeerId) {
    return;
  }

  clearReconnectTimer();
  state.reconnectAttempts += 1;
  const delay = Math.min(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS * Math.max(1, state.reconnectAttempts)
  );

  log(`Reconnect scheduled in ${(delay / 1000).toFixed(1)}s...`);
  state.reconnectTimer = setTimeout(() => {
    connectToHost(hostPeerId);
  }, delay);
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

async function setSelectedFiles(files) {
  if (state.role !== "sender") {
    return;
  }

  const cleanFiles = files.filter((file) => file && file.size >= 0);
  if (!cleanFiles.length) {
    return;
  }

  const encrypted = Boolean(ui.encryptionToggle.checked);
  const passphrase = ui.passphraseInput.value.trim();
  if (encrypted && !passphrase) {
    showToast("Add passphrase first");
    log("Cannot queue encrypted files without passphrase.", "error");
    return;
  }

  for (const file of cleanFiles) {
    const signature = `${file.name}|${file.size}|${file.lastModified || 0}`;
    const exists = state.sender.queue.some((item) => item.fileSignature === signature);
    if (exists) {
      log(`Skipped duplicate queue item: ${file.name}`);
      continue;
    }

    const queueItem = await createQueueItem(file, encrypted, passphrase);
    state.sender.queue.push(queueItem);
    log(`Queued: ${file.name}`);
  }

  ui.selectedFileName.textContent = `${cleanFiles.length} file(s) added to queue`;
  refreshShareLink(false);
  updateSendControls();
  renderQueue();
  updateBatchProgress();

  if (state.conn && state.conn.open) {
    announceCurrentMeta();
    pumpSenderQueue();
  }
}

async function createQueueItem(file, encrypted, passphrase) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const queueId = `${Date.now().toString(36)}-${randomHex(4)}`;
  const sessionId = `${Date.now().toString(36)}-${randomHex(6)}`;
  const fileSignature = `${file.name}|${file.size}|${file.lastModified || 0}`;

  let saltBase64 = "";
  let cryptoKey = null;
  if (encrypted) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltBase64 = bytesToBase64(salt);
    cryptoKey = await deriveAesKey(passphrase, salt);
  }

  const item = {
    queueId,
    file,
    name: file.name,
    size: file.size,
    totalChunks,
    encrypted,
    saltBase64,
    cryptoKey,
    fileSignature,
    sessionId,
    hashHex: "",
    hashReady: false,
    status: "queued",
    bytesSent: 0,
    startedAt: 0,
    finishedAt: 0,
  };

  computeQueueItemHash(item);
  return item;
}

async function computeQueueItemHash(item) {
  try {
    item.status = item.status === "queued" ? "hashing" : item.status;
    renderQueue();
    const hashHex = await computeSha256File(item.file);
    item.hashHex = hashHex;
    item.hashReady = true;
    if (item.status === "hashing") {
      item.status = "queued";
    }
    renderQueue();
  } catch (error) {
    item.status = "error";
    log(`Hashing failed for ${item.name}: ${error.message}`, "error");
    renderQueue();
  }
}

async function refreshQueueSecurityProfile() {
  const encrypted = Boolean(ui.encryptionToggle.checked);
  const passphrase = ui.passphraseInput.value.trim();

  if (encrypted && !passphrase) {
    return;
  }

  for (const item of state.sender.queue) {
    if (item.status === "done") {
      continue;
    }

    item.encrypted = encrypted;
    if (encrypted) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      item.saltBase64 = bytesToBase64(salt);
      item.cryptoKey = await deriveAesKey(passphrase, salt);
    } else {
      item.saltBase64 = "";
      item.cryptoKey = null;
    }
  }
}

function updateSendControls() {
  const hasQueue = state.sender.queue.length > 0;
  const needsPassphrase = ui.encryptionToggle.checked && !ui.passphraseInput.value.trim();
  const canShare = Boolean(state.selfId && hasQueue && !needsPassphrase);

  ui.generateLinkBtn.disabled = !canShare;
  ui.copyLinkBtn.disabled = !ui.shareLink.value;
}

function refreshShareLink(announce) {
  if (state.role !== "sender" || !state.selfId || !state.sender.queue.length) {
    ui.shareLink.value = "";
    ui.copyLinkBtn.disabled = true;
    renderQrCode("");
    return;
  }

  const active = getActiveOrNextQueueItem();
  if (!active) {
    ui.shareLink.value = "";
    ui.copyLinkBtn.disabled = true;
    renderQrCode("");
    return;
  }

  const base = `${window.location.origin}${window.location.pathname}`;
  const sid = encodeURIComponent(active.sessionId);
  const enc = active.encrypted ? "1" : "0";
  const url = `${base}?host=${encodeURIComponent(state.selfId)}&sid=${sid}&enc=${enc}`;

  ui.shareLink.value = url;
  ui.copyLinkBtn.disabled = false;
  renderQrCode(url);

  if (announce) {
    showToast("New share link generated");
  }

  log("Share URL is ready. Send it to the receiver.", "success");
}

function renderQrCode(text) {
  ui.qrCode.innerHTML = "";
  if (!text) {
    ui.qrCode.textContent = "QR appears after the share URL is generated.";
    return;
  }

  if (window.QRCode) {
    new QRCode(ui.qrCode, {
      text,
      width: 140,
      height: 140,
      colorDark: "#0a0a0c",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  } else {
    ui.qrCode.textContent = text;
  }
}

function renderQueue() {
  const queue = state.sender.queue;
  ui.queueMeta.textContent = `${queue.length} files queued`;

  if (!queue.length) {
    ui.queueList.innerHTML = "<div class=\"history-sub\">No files in queue.</div>";
    return;
  }

  ui.queueList.innerHTML = queue
    .map((item, index) => {
      const stateText = `${item.status}${item.hashReady ? " | hash ready" : ""}`;
      return `
        <div class="queue-item">
          <div class="queue-item-head">
            <div class="queue-item-name" title="${escapeHtml(item.name)}">${index + 1}. ${escapeHtml(
        item.name
      )}</div>
            <div class="queue-item-state">${escapeHtml(stateText)}</div>
          </div>
          <div class="history-sub">${formatBytes(item.size)} | ${item.encrypted ? "AES-GCM" : "Plain"}</div>
        </div>
      `;
    })
    .join("");
}

function updateBatchProgress() {
  const total = state.sender.queue.length;
  const done = state.sender.queue.filter((item) => item.status === "done").length;
  ui.batchProgressText.textContent = `${done} / ${total}`;
}

function getActiveOrNextQueueItem() {
  if (!state.sender.queue.length) {
    return null;
  }

  const active = state.sender.queue.find(
    (item) => item.queueId === state.sender.activeQueueId && item.status !== "done" && item.status !== "declined"
  );
  if (active) {
    return active;
  }

  return (
    state.sender.queue.find(
      (item) => item.status !== "done" && item.status !== "error" && item.status !== "declined"
    ) || null
  );
}

function announceCurrentMeta() {
  if (state.role !== "sender" || !state.conn || !state.conn.open) {
    return;
  }

  const item = getActiveOrNextQueueItem();
  if (!item) {
    return;
  }

  state.sender.activeQueueId = item.queueId;
  state.activeSessionId = item.sessionId;
  state.sender.bytesSent = item.bytesSent;
  state.sender.totalBytes = item.size;

  safeSend({
    type: "file-meta",
    sessionId: item.sessionId,
    fileSignature: item.fileSignature,
    name: item.name,
    size: item.size,
    mime: item.file.type || "application/octet-stream",
    totalChunks: item.totalChunks,
    chunkSize: CHUNK_SIZE,
    encrypted: item.encrypted,
    saltBase64: item.saltBase64,
    hashHex: item.hashHex,
    queueTotal: state.sender.queue.length,
    queueIndex: state.sender.queue.indexOf(item),
  });

  log(
    `Session announced: ${item.sessionId} (${item.totalChunks} chunks, ${item.encrypted ? "encrypted" : "plain"}).`
  );
}

function scheduleAutoStartFallback() {
  clearSenderStartTimer();

  state.sender.autoStartTimer = setTimeout(async () => {
    if (state.sender.inProgress) {
      return;
    }

    const item = getActiveOrNextQueueItem();
    if (!item) {
      return;
    }

    log("No resume state received yet. Starting full transfer fallback.");
    const allMissing = createMissingIndices(item.totalChunks, null);
    await beginSendWithMissing(item, allMissing);
  }, 1400);
}

function clearSenderStartTimer() {
  if (state.sender.autoStartTimer) {
    clearTimeout(state.sender.autoStartTimer);
    state.sender.autoStartTimer = null;
  }
}

function sendResumeRequest() {
  if (!state.conn || !state.conn.open) {
    return;
  }

  const preferredSession = state.activeSessionId || initialSessionParam;
  const session = preferredSession ? state.receiver.sessions[preferredSession] : null;
  const receivedRanges = session ? encodeReceivedRanges(session.receivedMap) : [];

  safeSend({
    type: "resume-request",
    sessionId: preferredSession,
    receivedRanges,
  });

  log(
    preferredSession
      ? `Resume request sent for session ${preferredSession}.`
      : "Resume request sent (no prior session yet)."
  );
}

async function pumpSenderQueue() {
  if (state.role !== "sender" || state.sender.inProgress || !state.conn || !state.conn.open) {
    return;
  }

  const item = getActiveOrNextQueueItem();
  if (!item) {
    return;
  }

  state.sender.activeQueueId = item.queueId;
  state.activeSessionId = item.sessionId;
  announceCurrentMeta();
  scheduleAutoStartFallback();
}

async function beginSendWithMissing(item, missingIndices) {
  if (
    state.role !== "sender" ||
    !item ||
    !item.file ||
    !state.conn ||
    !state.conn.open
  ) {
    return;
  }

  clearSenderStartTimer();

  const missing = Array.isArray(missingIndices)
    ? missingIndices.filter((index) => index >= 0 && index < item.totalChunks)
    : createMissingIndices(item.totalChunks, null);

  if (!missing.length) {
    safeSend({ type: "file-end", sessionId: item.sessionId });
    await markQueueItemDone(item, "resume-complete", 0);
    return;
  }

  if (state.sender.inProgress) {
    state.sender.transferToken += 1;
    await microYield();
  }

  state.sender.inProgress = true;
  item.status = "sending";
  item.startedAt = item.startedAt || Date.now();
  item.bytesSent = item.size - estimateMissingBytes(item.size, item.totalChunks, missing);
  state.sender.bytesSent = item.bytesSent;
  state.sender.totalBytes = item.size;

  startSpeedTicker(item.size, () => state.sender.bytesSent);
  setStatus(`Sending ${item.name}`);
  log(`Sending ${missing.length}/${item.totalChunks} chunks for ${item.name}.`);
  renderQueue();

  const token = ++state.sender.transferToken;

  try {
    await sendMissingChunks(item, missing, token);
    if (token !== state.sender.transferToken) {
      return;
    }

    safeSend({ type: "file-end", sessionId: item.sessionId });
    await markQueueItemDone(item, "completed", currentSpeedSnapshot());
    log("All required chunks sent successfully.", "success");
  } catch (error) {
    item.status = "error";
    setStatus("Transfer failed", "error");
    log(`Send failed: ${error.message}`, "error");
    renderQueue();
  } finally {
    if (token === state.sender.transferToken) {
      state.sender.inProgress = false;
      stopSpeedTicker();
      updateBatchProgress();
      renderQueue();
      refreshShareLink(false);
      pumpSenderQueue();
    }
  }
}

async function markQueueItemDone(item, mode, avgSpeed) {
  item.status = "done";
  item.finishedAt = Date.now();
  item.bytesSent = item.size;
  state.sender.bytesSent = item.size;
  renderProgress(item.size, item.size);
  setStatus("Transfer complete", "success");

  addHistoryEntry({
    direction: "sent",
    name: item.name,
    size: item.size,
    peerId: state.remoteId,
    speedMbps: avgSpeed,
    encrypted: item.encrypted,
    integrity: mode === "resume-complete" ? "N/A" : "SHA-256 sent",
    status: "success",
  });

  renderQueue();
  updateBatchProgress();
}

async function sendMissingChunks(item, missingIndices, token) {
  const dc = state.conn.dataChannel || state.conn._dc;

  for (let i = 0; i < missingIndices.length; i += 1) {
    if (token !== state.sender.transferToken) {
      return;
    }

    const index = missingIndices[i];
    const start = index * CHUNK_SIZE;
    const end = Math.min(item.size, start + CHUNK_SIZE);
    const blobChunk = item.file.slice(start, end);
    const plainBuffer = await readBlobAsArrayBuffer(blobChunk);

    if (dc) {
      while (dc.bufferedAmount > MAX_BUFFERED_BYTES) {
        await waitForBufferedLow(dc);
      }
    }

    if (item.encrypted) {
      if (!item.cryptoKey) {
        throw new Error("Missing sender encryption key");
      }

      const encrypted = await encryptChunk(plainBuffer, item.cryptoKey);
      safeSend({
        type: "file-chunk",
        sessionId: item.sessionId,
        index,
        data: encrypted.cipher,
        ivBase64: encrypted.ivBase64,
      });
    } else {
      safeSend({
        type: "file-chunk",
        sessionId: item.sessionId,
        index,
        data: plainBuffer,
      });
    }

    state.sender.bytesSent += plainBuffer.byteLength;
    item.bytesSent = state.sender.bytesSent;
    renderProgress(state.sender.bytesSent, item.size);

    if (i > 0 && i % 128 === 0) {
      await microYield();
    }
  }
}

function waitForBufferedLow(dc) {
  if (dc.bufferedAmount <= LOW_WATER_MARK) {
    return Promise.resolve();
  }

  if (!state.sender.resumeBufferedPromise) {
    state.sender.resumeBufferedPromise = new Promise((resolve) => {
      state.sender.resolveBufferedWait = resolve;
    });
  }

  return state.sender.resumeBufferedPromise;
}

async function handleData(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.type === "resume-request") {
    await handleResumeRequest(payload);
    return;
  }

  if (payload.type === "file-meta") {
    await handleFileMeta(payload);
    return;
  }

  if (payload.type === "file-chunk") {
    await handleFileChunk(payload);
    return;
  }

  if (payload.type === "file-end") {
    await finalizeDownload(payload.sessionId);
    return;
  }

  if (payload.type === "file-decline") {
    handleFileDecline(payload);
  }
}

async function handleResumeRequest(payload) {
  if (state.role !== "sender") {
    return;
  }

  const item =
    state.sender.queue.find((entry) => entry.sessionId === payload.sessionId) ||
    getActiveOrNextQueueItem();

  if (!item) {
    return;
  }

  if (item.status === "done" || item.status === "declined") {
    state.sender.activeQueueId = "";
    pumpSenderQueue();
    return;
  }

  if (payload.sessionId && payload.sessionId !== item.sessionId) {
    state.sender.activeQueueId = item.queueId;
    announceCurrentMeta();
    return;
  }

  clearSenderStartTimer();
  state.sender.activeQueueId = item.queueId;
  const receivedMap = decodeReceivedRanges(payload.receivedRanges, item.totalChunks);
  const missing = createMissingIndices(item.totalChunks, receivedMap);

  log(`Resume negotiation complete for ${item.name}. Missing chunks: ${missing.length}.`, "success");
  await beginSendWithMissing(item, missing);
}

async function handleFileMeta(payload) {
  state.activeSessionId = payload.sessionId || state.activeSessionId;

  if (payload.encrypted && !ui.encryptionToggle.checked) {
    ui.encryptionToggle.checked = true;
  }

  const existing = state.receiver.sessions[payload.sessionId];
  const session = existing || {
    meta: payload,
    chunks: new Array(payload.totalChunks),
    receivedMap: new Uint8Array(payload.totalChunks),
    receivedCount: 0,
    bytesReceived: 0,
    completed: false,
    finalizing: false,
    startedAt: Date.now(),
  };

  session.meta = payload;
  session.hashHex = payload.hashHex || "";
  session.accepted = session.accepted || false;
  session.declined = session.declined || false;
  state.receiver.sessions[payload.sessionId] = session;

  if (!session.accepted && !session.declined) {
    state.receiver.pendingSessionId = payload.sessionId;
    openIncomingPrompt(payload);
    return;
  }

  if (session.declined) {
    safeSend({ type: "file-decline", sessionId: payload.sessionId });
    return;
  }

  if (session.accepted) {
    startReceiverSession(payload, session);
  }
}

function startReceiverSession(payload, session) {
  startSpeedTicker(payload.size, () => session.bytesReceived);
  setStatus(`Receiving ${payload.name}`);
  updateBatchProgressReceiver(payload);
  log(
    `Receiving ${payload.name} (${formatBytes(payload.size)}) in ${payload.totalChunks} chunks${payload.encrypted ? ", encrypted" : ""}.`
  );

  sendResumeRequest();
}

async function handleFileChunk(payload) {
  const session = state.receiver.sessions[payload.sessionId || state.activeSessionId];
  if (!session || !session.meta) {
    return;
  }

  if (!session.accepted || session.declined) {
    return;
  }

  const index = payload.index;
  if (index < 0 || index >= session.meta.totalChunks) {
    return;
  }

  if (session.receivedMap[index]) {
    return;
  }

  let buffer = await normalizeBuffer(payload.data);
  if (!buffer) {
    return;
  }

  if (session.meta.encrypted) {
    const passphrase = ui.passphraseInput.value.trim();
    if (!passphrase) {
      setStatus("Passphrase required", "error");
      log("Encrypted chunk received but no passphrase was provided.", "error");
      return;
    }

    const key = await getReceiverDecryptKey(passphrase, session.meta.saltBase64);
    if (!payload.ivBase64) {
      log("Missing IV for encrypted chunk.", "error");
      return;
    }

    try {
      buffer = await decryptChunk(buffer, key, payload.ivBase64);
    } catch (error) {
      setStatus("Decrypt failed", "error");
      log("Failed to decrypt chunk. Check passphrase.", "error");
      return;
    }
  }

  session.chunks[index] = buffer;
  session.receivedMap[index] = 1;
  session.receivedCount += 1;
  session.bytesReceived += buffer.byteLength;

  renderProgress(session.bytesReceived, session.meta.size);
}

async function finalizeDownload(sessionId) {
  const key = sessionId || state.activeSessionId;
  const session = state.receiver.sessions[key];
  if (!session || !session.meta) {
    return;
  }

  if (session.completed || session.finalizing) {
    return;
  }

  if (session.receivedCount !== session.meta.totalChunks) {
    const missing = session.meta.totalChunks - session.receivedCount;
    setStatus("Waiting for reconnect");
    log(`Transfer paused. Missing ${missing} chunks, will resume on reconnect.`);
    stopSpeedTicker();
    scheduleReceiverReconnect();
    return;
  }

  session.finalizing = true;

  const blob = new Blob(session.chunks, { type: session.meta.mime });

  let integrityStatus = "N/A";
  if (session.hashHex) {
    const localHash = await computeSha256Blob(blob);
    const ok = localHash === session.hashHex;
    integrityStatus = ok ? "Verified" : "Mismatch";
    ui.integrityText.textContent = integrityStatus;

    if (!ok) {
      setStatus("Integrity failed", "error");
      log(`Hash mismatch for ${session.meta.name}. Transfer rejected.`, "error");
      addHistoryEntry({
        direction: "received",
        name: session.meta.name,
        size: session.meta.size,
        peerId: state.remoteId,
        speedMbps: currentSpeedSnapshot(),
        encrypted: session.meta.encrypted,
        integrity: "Mismatch",
        status: "error",
      });
      session.finalizing = false;
      return;
    }
  } else {
    ui.integrityText.textContent = "No hash";
  }

  autoDownload(blob, session.meta.name);

  setStatus("Download ready", "success");
  log(`Download auto-triggered: ${session.meta.name}`, "success");

  session.completed = true;
  session.finalizing = false;
  stopSpeedTicker();
  addHistoryEntry({
    direction: "received",
    name: session.meta.name,
    size: session.meta.size,
    peerId: state.remoteId,
    speedMbps: currentSpeedSnapshot(),
    encrypted: session.meta.encrypted,
    integrity: integrityStatus,
    status: "success",
  });
}

function openIncomingPrompt(payload) {
  ui.incomingPromptText.textContent = `Incoming file: ${payload.name} (${formatBytes(payload.size)}). Accept download?`;
  ui.incomingPromptModal.classList.add("show");
  ui.incomingPromptModal.setAttribute("aria-hidden", "false");
}

function closeIncomingPrompt() {
  ui.incomingPromptModal.classList.remove("show");
  ui.incomingPromptModal.setAttribute("aria-hidden", "true");
}

function acceptIncomingSession() {
  const sessionId = state.receiver.pendingSessionId;
  if (!sessionId) {
    closeIncomingPrompt();
    return;
  }

  const session = state.receiver.sessions[sessionId];
  if (!session) {
    closeIncomingPrompt();
    return;
  }

  session.accepted = true;
  session.declined = false;
  state.receiver.pendingSessionId = "";
  closeIncomingPrompt();
  startReceiverSession(session.meta, session);
}

function declineIncomingSession() {
  const sessionId = state.receiver.pendingSessionId;
  if (!sessionId) {
    closeIncomingPrompt();
    return;
  }

  const session = state.receiver.sessions[sessionId];
  if (session) {
    session.declined = true;
    session.accepted = false;
  }

  safeSend({ type: "file-decline", sessionId });
  log(`Receiver declined session ${sessionId}.`);
  state.receiver.pendingSessionId = "";
  closeIncomingPrompt();
}

function handleFileDecline(payload) {
  if (state.role !== "sender") {
    return;
  }

  const item = state.sender.queue.find((entry) => entry.sessionId === payload.sessionId);
  if (!item) {
    return;
  }

  item.status = "declined";
  log(`Receiver declined file: ${item.name}`, "error");
  addHistoryEntry({
    direction: "sent",
    name: item.name,
    size: item.size,
    peerId: state.remoteId,
    speedMbps: 0,
    encrypted: item.encrypted,
    integrity: "Declined",
    status: "declined",
  });

  state.sender.activeQueueId = "";
  renderQueue();
  updateBatchProgress();
  refreshShareLink(false);
  pumpSenderQueue();
}

function autoDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1800);
}

function startSpeedTicker(totalBytes, readBytes) {
  stopSpeedTicker();

  state.metrics.startTime = performance.now();
  state.metrics.lastTick = state.metrics.startTime;
  state.metrics.lastBytes = 0;
  state.metrics.readBytes = readBytes || (() => 0);

  state.metrics.speedTimer = setInterval(() => {
    const currentBytes = state.metrics.readBytes();
    const now = performance.now();
    const deltaTimeSec = (now - state.metrics.lastTick) / 1000;
    const deltaBytes = currentBytes - state.metrics.lastBytes;

    const speed = deltaTimeSec > 0 ? deltaBytes / (1024 * 1024) / deltaTimeSec : 0;
    ui.speedText.textContent = `${speed.toFixed(2)} MB/s`;

    state.metrics.lastTick = now;
    state.metrics.lastBytes = currentBytes;
  }, 350);
}

function stopSpeedTicker() {
  if (state.metrics.speedTimer) {
    clearInterval(state.metrics.speedTimer);
    state.metrics.speedTimer = null;
  }
}

function currentSpeedSnapshot() {
  const value = Number.parseFloat(ui.speedText.textContent);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function renderProgress(doneBytes, totalBytes) {
  const safeTotal = totalBytes || 1;
  const percentage = Math.min(100, (doneBytes / safeTotal) * 100);
  ui.progressBar.style.width = `${percentage.toFixed(2)}%`;
  ui.progressText.textContent = `${percentage.toFixed(2)}%`;
  ui.transferredText.textContent = `${formatMB(doneBytes)} / ${formatMB(totalBytes)} MB`;
}

function safeSend(payload) {
  if (!state.conn || !state.conn.open) {
    return;
  }
  state.conn.send(payload);
}

function readBlobAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("FileReader failed while reading chunk"));
    reader.readAsArrayBuffer(blob);
  });
}

async function normalizeBuffer(data) {
  if (!data) {
    return null;
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (data instanceof Blob) {
    return data.arrayBuffer();
  }
  return null;
}

async function deriveAesKey(passphrase, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ROUNDS,
      hash: "SHA-256",
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptChunk(plainBuffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuffer);
  return {
    cipher,
    ivBase64: bytesToBase64(iv),
  };
}

async function decryptChunk(cipherBuffer, key, ivBase64) {
  const iv = base64ToBytes(ivBase64);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuffer);
}

async function getReceiverDecryptKey(passphrase, saltBase64) {
  if (state.receiver.activeDecryptKey && state.receiver.activeDecryptSalt === saltBase64) {
    return state.receiver.activeDecryptKey;
  }

  const salt = base64ToBytes(saltBase64 || "");
  const key = await deriveAesKey(passphrase, salt);
  state.receiver.activeDecryptKey = key;
  state.receiver.activeDecryptSalt = saltBase64 || "";
  return key;
}

async function computeSha256File(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

async function computeSha256Blob(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const normalized = base64 || "";
  const binary = atob(normalized || "");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function encodeReceivedRanges(receivedMap) {
  const ranges = [];
  if (!receivedMap || !receivedMap.length) {
    return ranges;
  }

  let start = -1;
  for (let i = 0; i < receivedMap.length; i += 1) {
    if (receivedMap[i] && start < 0) {
      start = i;
    }

    const isEnd = start >= 0 && (!receivedMap[i + 1] || i === receivedMap.length - 1);
    if (isEnd) {
      ranges.push([start, i]);
      start = -1;
    }
  }

  return ranges;
}

function decodeReceivedRanges(ranges, totalChunks) {
  const map = new Uint8Array(totalChunks);
  if (!Array.isArray(ranges)) {
    return map;
  }

  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      continue;
    }

    const start = Math.max(0, Number(pair[0]) || 0);
    const end = Math.min(totalChunks - 1, Number(pair[1]) || 0);
    for (let i = start; i <= end; i += 1) {
      map[i] = 1;
    }
  }

  return map;
}

function createMissingIndices(totalChunks, receivedMap) {
  const missing = [];
  for (let i = 0; i < totalChunks; i += 1) {
    if (!receivedMap || !receivedMap[i]) {
      missing.push(i);
    }
  }
  return missing;
}

function estimateMissingBytes(fileSize, totalChunks, missingIndices) {
  if (!missingIndices.length) {
    return 0;
  }

  let bytes = 0;
  for (const index of missingIndices) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(fileSize, start + CHUNK_SIZE);
    bytes += Math.max(0, end - start);
  }
  return bytes;
}

function updateSecurityChip() {
  if (ui.encryptionToggle.checked) {
    if (ui.passphraseInput.value.trim()) {
      ui.securityChip.textContent = "WebRTC DTLS + AES-GCM payload encryption";
    } else {
      ui.securityChip.textContent = "Encryption enabled, passphrase required";
    }
  } else {
    ui.securityChip.textContent = "WebRTC DTLS encryption active";
  }
}

function updateBatchProgressReceiver(meta) {
  if (!meta) {
    return;
  }
  ui.batchProgressText.textContent = `${(meta.queueIndex || 0) + 1} / ${meta.queueTotal || 1}`;
}

function isReceiverAllDone() {
  const sessions = Object.values(state.receiver.sessions);
  if (!sessions.length) {
    return false;
  }
  return sessions.every((session) => session.completed);
}

function addHistoryEntry(entry) {
  const row = {
    at: new Date().toISOString(),
    ...entry,
  };

  state.history.unshift(row);
  state.history = state.history.slice(0, 200);
  persistHistory();
  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    ui.historyList.innerHTML = "<div class=\"history-sub\">No transfers yet.</div>";
    return;
  }

  ui.historyList.innerHTML = state.history
    .map((item) => {
      const time = new Date(item.at).toLocaleString();
      return `
        <div class="history-item">
          <div>
            <div class="history-title">${escapeHtml(item.direction.toUpperCase())}: ${escapeHtml(item.name)}</div>
            <div class="history-sub">${time} | ${formatBytes(item.size)} | ${item.speedMbps.toFixed(
        2
      )} MB/s | ${item.encrypted ? "AES-GCM" : "Plain"}</div>
            <div class="history-sub">Peer: ${escapeHtml(item.peerId || "unknown")} | Integrity: ${escapeHtml(
        item.integrity || "N/A"
      )}</div>
          </div>
          <div class="history-tag">${escapeHtml(item.status)}</div>
        </div>
      `;
    })
    .join("");
}

function persistHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch (error) {
    return [];
  }
}

function openAdminModal() {
  ui.adminModal.classList.add("show");
  ui.adminModal.setAttribute("aria-hidden", "false");
  ui.adminPasscodeInput.value = "";
  setTimeout(() => {
    ui.adminPasscodeInput.focus();
  }, 20);
}

function closeAdminModal() {
  ui.adminModal.classList.remove("show");
  ui.adminModal.setAttribute("aria-hidden", "true");
}

function unlockAdmin() {
  const passcode = ui.adminPasscodeInput.value.trim();
  if (passcode !== ADMIN_PASSCODE) {
    showToast("Invalid passcode");
    return;
  }

  localStorage.setItem(ADMIN_AUTH_KEY, String(Date.now() + 10 * 60 * 1000));
  closeAdminModal();
  window.location.href = "admin.html";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value) {
  const mb = value / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  if (mb >= 1) {
    return `${mb.toFixed(2)} MB`;
  }
  return `${(value / 1024).toFixed(2)} KB`;
}

function formatMB(value) {
  return ((value || 0) / (1024 * 1024)).toFixed(2);
}

function shortId(id) {
  if (!id) {
    return "...";
  }
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function setStatus(text, type = "") {
  ui.connectionStatus.textContent = text;

  if (type === "success") {
    ui.connectionStatus.style.color = "#98ffd9";
    return;
  }

  if (type === "error") {
    ui.connectionStatus.style.color = "#ff9c9c";
    return;
  }

  ui.connectionStatus.style.color = "";
}

function log(message, type = "") {
  const row = document.createElement("div");
  row.className = `log-row ${type}`.trim();
  row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

  ui.logConsole.appendChild(row);

  while (ui.logConsole.children.length > LOG_LIMIT) {
    ui.logConsole.firstChild.remove();
  }

  ui.logConsole.scrollTop = ui.logConsole.scrollHeight;

  state.logs.unshift({
    at: new Date().toISOString(),
    type,
    message,
  });
  state.logs = state.logs.slice(0, 300);
  persistLogs();
}

function persistLogs() {
  localStorage.setItem(LOG_KEY, JSON.stringify(state.logs));
}

function loadLogs() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

let toastTimer = null;
function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.classList.remove("show");
  }, 1600);
}

function microYield() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
