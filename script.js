const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const LOW_WATER_MARK = 512 * 1024;
const LOG_LIMIT = 260;
const RECONNECT_BASE_MS = 1200;
const RECONNECT_CAP_MS = 10000;
const PBKDF2_ROUNDS = 250000;

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
  peerVisual: document.getElementById("peerVisual"),
  peerTagA: document.getElementById("peerTagA"),
  peerTagB: document.getElementById("peerTagB"),
  logConsole: document.getElementById("logConsole"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
  toast: document.getElementById("toast"),
  encryptionToggle: document.getElementById("encryptionToggle"),
  passphraseInput: document.getElementById("passphraseInput"),
  qrCode: document.getElementById("qrCode"),
  refreshQrBtn: document.getElementById("refreshQrBtn"),
  securityChip: document.getElementById("securityChip"),
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
  selectedFile: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  activeSessionId: initialSessionParam,
  sender: {
    inProgress: false,
    bytesSent: 0,
    totalBytes: 0,
    resumeBufferedPromise: null,
    resolveBufferedWait: null,
    session: null,
    cryptoKey: null,
    autoStartTimer: null,
    transferToken: 0,
    completed: false,
  },
  receiver: {
    sessions: {},
    activeDecryptKey: null,
    activeDecryptSalt: "",
  },
  metrics: {
    startTime: 0,
    lastTick: 0,
    lastBytes: 0,
    speedTimer: null,
    direction: "idle",
    totalBytes: 0,
    readBytes: () => 0,
  },
};

init();

function init() {
  bindUI();
  initPeer();
  renderQrCode("");

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
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    setSelectedFile(file);
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
    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }
    setSelectedFile(file);
  });

  ui.encryptionToggle.addEventListener("change", async () => {
    await prepareSenderSession();
    refreshShareLink(false);
    updateSecurityChip();
  });

  ui.passphraseInput.addEventListener("input", async () => {
    if (state.role === "sender") {
      await prepareSenderSession();
      refreshShareLink(false);
      updateSendControls();
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
      updateSecurityChip();
      refreshShareLink(false);
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

  if (state.role === "sender" && state.conn && !state.conn.open) {
    log("Sender waiting for receiver to reconnect.");
    setStatus("Waiting for receiver...");
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

    await announceSenderSession();
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

    if (state.role === "receiver" && !isReceiverSessionComplete()) {
      scheduleReceiverReconnect();
    }
  });

  conn.on("error", (error) => {
    setStatus("Connection error", "error");
    log(`Connection error: ${error.message || "unknown"}`, "error");

    if (state.role === "receiver" && !isReceiverSessionComplete()) {
      scheduleReceiverReconnect();
    }
  });
}

function isReceiverSessionComplete() {
  if (!state.activeSessionId) {
    return false;
  }
  const session = state.receiver.sessions[state.activeSessionId];
  return Boolean(session && session.completed);
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

async function setSelectedFile(file) {
  state.selectedFile = file;
  state.sender.completed = false;
  ui.selectedFileName.textContent = `${file.name} (${formatBytes(file.size)})`;

  log(`File selected: ${file.name}, ${formatBytes(file.size)}`);
  await prepareSenderSession();
  refreshShareLink(false);
  updateSendControls();

  if (state.conn && state.conn.open && state.role === "sender") {
    await announceSenderSession();
    scheduleAutoStartFallback();
  }
}

async function prepareSenderSession() {
  if (state.role !== "sender" || !state.selectedFile) {
    return;
  }

  const file = state.selectedFile;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const encrypted = Boolean(ui.encryptionToggle.checked);
  const passphrase = ui.passphraseInput.value.trim();

  if (encrypted && !passphrase) {
    log("Encryption enabled: enter a passphrase before sharing.", "error");
    state.sender.session = null;
    state.sender.cryptoKey = null;
    return;
  }

  const randomPart = randomHex(6);
  const sessionId = `${Date.now().toString(36)}-${randomPart}`;
  const fileSignature = `${file.name}|${file.size}|${file.lastModified || 0}`;

  let saltBase64 = "";
  let cryptoKey = null;
  if (encrypted) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltBase64 = bytesToBase64(salt);
    cryptoKey = await deriveAesKey(passphrase, salt);
  }

  state.sender.session = {
    sessionId,
    fileSignature,
    totalChunks,
    encrypted,
    saltBase64,
  };
  state.sender.cryptoKey = cryptoKey;
  state.activeSessionId = sessionId;

  log(
    encrypted
      ? "Sender session prepared with AES-GCM encryption."
      : "Sender session prepared without payload encryption."
  );
}

function updateSendControls() {
  const hasFile = Boolean(state.selfId && state.selectedFile);
  const needsPassphrase = ui.encryptionToggle.checked && !ui.passphraseInput.value.trim();
  const canShare = hasFile && !needsPassphrase;

  ui.generateLinkBtn.disabled = !canShare;
  ui.copyLinkBtn.disabled = !ui.shareLink.value;
}

function refreshShareLink(announce) {
  if (state.role !== "sender" || !state.selfId || !state.selectedFile || !state.sender.session) {
    ui.shareLink.value = "";
    ui.copyLinkBtn.disabled = true;
    renderQrCode("");
    return;
  }

  const base = `${window.location.origin}${window.location.pathname}`;
  const sid = encodeURIComponent(state.sender.session.sessionId);
  const enc = state.sender.session.encrypted ? "1" : "0";
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
  if (!ui.qrCode) {
    return;
  }

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

async function announceSenderSession() {
  if (
    state.role !== "sender" ||
    !state.conn ||
    !state.conn.open ||
    !state.selectedFile ||
    !state.sender.session
  ) {
    return;
  }

  const file = state.selectedFile;
  const session = state.sender.session;

  safeSend({
    type: "file-meta",
    sessionId: session.sessionId,
    fileSignature: session.fileSignature,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    totalChunks: session.totalChunks,
    chunkSize: CHUNK_SIZE,
    encrypted: session.encrypted,
    saltBase64: session.saltBase64,
  });

  log(
    `Session announced: ${session.sessionId} (${session.totalChunks} chunks, ${session.encrypted ? "encrypted" : "plain"}).`
  );
}

function scheduleAutoStartFallback() {
  clearSenderStartTimer();

  state.sender.autoStartTimer = setTimeout(async () => {
    if (state.sender.inProgress || state.sender.completed) {
      return;
    }

    const session = state.sender.session;
    if (!session) {
      return;
    }

    log("No resume state received yet. Starting full transfer fallback.");
    const allMissing = createMissingIndices(session.totalChunks, null);
    await beginSendWithMissing(allMissing);
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

  const receivedRanges = session
    ? encodeReceivedRanges(session.receivedMap)
    : [];

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

async function beginSendWithMissing(missingIndices) {
  if (
    state.role !== "sender" ||
    !state.selectedFile ||
    !state.sender.session ||
    !state.conn ||
    !state.conn.open
  ) {
    return;
  }

  clearSenderStartTimer();

  const file = state.selectedFile;
  const session = state.sender.session;
  const missing = Array.isArray(missingIndices)
    ? missingIndices.filter((index) => index >= 0 && index < session.totalChunks)
    : createMissingIndices(session.totalChunks, null);

  if (!missing.length) {
    state.sender.completed = true;
    safeSend({ type: "file-end", sessionId: session.sessionId });
    setStatus("Transfer complete", "success");
    log("Receiver already had all chunks. Finalized instantly.", "success");
    return;
  }

  if (state.sender.inProgress) {
    state.sender.transferToken += 1;
    await microYield();
  }

  state.sender.inProgress = true;
  state.sender.bytesSent = file.size - estimateMissingBytes(file.size, session.totalChunks, missing);
  state.sender.totalBytes = file.size;
  state.sender.completed = false;

  startSpeedTicker(file.size, "upload", () => state.sender.bytesSent);
  setStatus("Sending...");
  log(`Sending ${missing.length}/${session.totalChunks} chunks.`);

  const token = ++state.sender.transferToken;

  try {
    await sendMissingChunks(file, missing, token);
    if (token !== state.sender.transferToken) {
      return;
    }

    safeSend({ type: "file-end", sessionId: session.sessionId });
    setStatus("Transfer complete", "success");
    state.sender.completed = true;
    log("All required chunks sent successfully.", "success");
  } catch (error) {
    setStatus("Transfer failed", "error");
    log(`Send failed: ${error.message}`, "error");
  } finally {
    if (token === state.sender.transferToken) {
      state.sender.inProgress = false;
      stopSpeedTicker();
    }
  }
}

async function sendMissingChunks(file, missingIndices, token) {
  const dc = state.conn.dataChannel || state.conn._dc;
  const session = state.sender.session;

  for (let i = 0; i < missingIndices.length; i += 1) {
    if (token !== state.sender.transferToken) {
      return;
    }

    const index = missingIndices[i];
    const start = index * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const blobChunk = file.slice(start, end);
    const plainBuffer = await readBlobAsArrayBuffer(blobChunk);

    if (dc) {
      while (dc.bufferedAmount > MAX_BUFFERED_BYTES) {
        await waitForBufferedLow(dc);
      }
    }

    if (session.encrypted) {
      if (!state.sender.cryptoKey) {
        throw new Error("Missing sender encryption key");
      }
      const encrypted = await encryptChunk(plainBuffer, state.sender.cryptoKey);
      safeSend({
        type: "file-chunk",
        sessionId: session.sessionId,
        index,
        data: encrypted.cipher,
        ivBase64: encrypted.ivBase64,
      });
    } else {
      safeSend({
        type: "file-chunk",
        sessionId: session.sessionId,
        index,
        data: plainBuffer,
      });
    }

    state.sender.bytesSent += plainBuffer.byteLength;
    renderProgress(state.sender.bytesSent, file.size);

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
  }
}

async function handleResumeRequest(payload) {
  if (state.role !== "sender" || !state.sender.session || !state.selectedFile) {
    return;
  }

  const session = state.sender.session;

  if (payload.sessionId && payload.sessionId !== session.sessionId) {
    log("Receiver asked for a different session. Announcing latest metadata.");
    await announceSenderSession();
    return;
  }

  clearSenderStartTimer();
  const receivedMap = decodeReceivedRanges(payload.receivedRanges, session.totalChunks);
  const missing = createMissingIndices(session.totalChunks, receivedMap);

  log(`Resume negotiation complete. Missing chunks: ${missing.length}.`, "success");
  await beginSendWithMissing(missing);
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
  };

  session.meta = payload;
  state.receiver.sessions[payload.sessionId] = session;

  startSpeedTicker(payload.size, "download", () => session.bytesReceived);
  setStatus(`Receiving ${payload.name}`);
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

  if (session.receivedCount !== session.meta.totalChunks) {
    const missing = session.meta.totalChunks - session.receivedCount;
    setStatus("Waiting for reconnect");
    log(`Transfer paused. Missing ${missing} chunks, will resume on reconnect.`);
    stopSpeedTicker();
    scheduleReceiverReconnect();
    return;
  }

  const blob = new Blob(session.chunks, { type: session.meta.mime });
  autoDownload(blob, session.meta.name);

  setStatus("Download ready", "success");
  log(`Download auto-triggered: ${session.meta.name}`, "success");

  stopSpeedTicker();
  session.completed = true;
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

function startSpeedTicker(totalBytes, direction, readBytes) {
  stopSpeedTicker();

  state.metrics.totalBytes = totalBytes;
  state.metrics.direction = direction;
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

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const normalized = base64 || "";
  const binary = atob(normalized);
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
