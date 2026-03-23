const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const LOW_WATER_MARK = 512 * 1024;
const LOG_LIMIT = 220;

const ui = {
  selfPeerId: document.getElementById("selfPeerId"),
  remotePeerId: document.getElementById("remotePeerId"),
  connectionStatus: document.getElementById("connectionStatus"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  selectedFileName: document.getElementById("selectedFileName"),
  generateLinkBtn: document.getElementById("generateLinkBtn"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
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
};

const params = new URLSearchParams(window.location.search);
const hostPeerId = params.get("host");

const state = {
  role: hostPeerId ? "receiver" : "sender",
  peer: null,
  conn: null,
  selfId: "",
  remoteId: hostPeerId || "",
  selectedFile: null,
  sender: {
    inProgress: false,
    bytesSent: 0,
    totalBytes: 0,
    resumeBufferedPromise: null,
    resolveBufferedWait: null,
  },
  receiver: {
    meta: null,
    chunks: [],
    bytesReceived: 0,
  },
  metrics: {
    startTime: 0,
    lastTick: 0,
    lastBytes: 0,
    speedTimer: null,
    direction: "idle",
    totalBytes: 0,
  },
};

init();

function init() {
  bindUI();
  initPeer();
  log("App initialized. WebRTC transport is DTLS-encrypted by default.", "success");
  log("Optional payload encryption can be layered with Web Crypto AES-GCM.");

  if (state.role === "receiver") {
    ui.selectedFileName.textContent = "Receiver mode: waiting for sender";
    ui.dropZone.classList.add("disabled");
    ui.fileInput.disabled = true;
    ui.generateLinkBtn.disabled = true;
    ui.copyLinkBtn.disabled = true;
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
      refreshShareLink(false);
      updateSendControls();
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

    if (state.conn && state.conn.open) {
      log("Another peer attempted to connect while session is active.", "error");
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
    setStatus("Disconnected", "error");
    log("Peer disconnected from signaling server.", "error");
  });
}

function connectToHost(targetPeerId) {
  if (!state.peer || !state.selfId) {
    return;
  }

  setStatus("Connecting...");
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

  conn.on("open", () => {
    state.remoteId = conn.peer;
    ui.remotePeerId.textContent = conn.peer;
    ui.peerTagB.textContent = shortId(conn.peer);

    setStatus("Connected", "success");
    ui.peerVisual.classList.add("connected");
    setupDataChannelBackpressure(conn);

    log(`Connection established with ${conn.peer}`, "success");

    if (state.role === "sender" && state.selectedFile) {
      beginSendIfReady();
    }
  });

  conn.on("data", async (payload) => {
    await handleData(payload);
  });

  conn.on("close", () => {
    setStatus("Connection closed");
    ui.peerVisual.classList.remove("connected");
    log("Peer connection closed.");
    stopSpeedTicker();
  });

  conn.on("error", (error) => {
    setStatus("Connection error", "error");
    log(`Connection error: ${error.message || "unknown"}`, "error");
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

function setSelectedFile(file) {
  state.selectedFile = file;
  ui.selectedFileName.textContent = `${file.name} (${formatBytes(file.size)})`;

  log(`File selected: ${file.name}, ${formatBytes(file.size)}`);
  refreshShareLink(false);
  updateSendControls();

  if (state.conn && state.conn.open) {
    beginSendIfReady();
  }
}

function updateSendControls() {
  const canShare = Boolean(state.selfId && state.selectedFile);
  ui.generateLinkBtn.disabled = !canShare;
  ui.copyLinkBtn.disabled = !ui.shareLink.value;
}

function refreshShareLink(announce) {
  if (!state.selfId || !state.selectedFile || state.role !== "sender") {
    return;
  }

  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}?host=${encodeURIComponent(state.selfId)}`;
  ui.shareLink.value = url;
  ui.copyLinkBtn.disabled = false;

  if (announce) {
    showToast("New share link generated");
  }

  log("Share URL is ready. Send it to the receiver.", "success");
}

async function beginSendIfReady() {
  if (
    state.role !== "sender" ||
    !state.selectedFile ||
    !state.conn ||
    !state.conn.open ||
    state.sender.inProgress
  ) {
    return;
  }

  const file = state.selectedFile;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  state.sender.inProgress = true;
  state.sender.bytesSent = 0;
  state.sender.totalBytes = file.size;

  startSpeedTicker(file.size, "upload");
  log(`Starting transfer of ${file.name} in ${totalChunks} chunks.`);

  state.conn.send({
    type: "file-meta",
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    totalChunks,
    chunkSize: CHUNK_SIZE,
  });

  try {
    await sendChunks(file, totalChunks);
    state.conn.send({ type: "file-end" });
    setStatus("Transfer complete", "success");
    log("All chunks sent successfully.", "success");
  } catch (error) {
    setStatus("Transfer failed", "error");
    log(`Send failed: ${error.message}`, "error");
  } finally {
    state.sender.inProgress = false;
    stopSpeedTicker();
  }
}

async function sendChunks(file, totalChunks) {
  const dc = state.conn.dataChannel || state.conn._dc;

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const blobChunk = file.slice(start, end);
    const buffer = await readBlobAsArrayBuffer(blobChunk);

    if (dc) {
      while (dc.bufferedAmount > MAX_BUFFERED_BYTES) {
        await waitForBufferedLow(dc);
      }
    }

    state.conn.send({ type: "file-chunk", index, data: buffer });

    state.sender.bytesSent += buffer.byteLength;
    renderProgress(state.sender.bytesSent, file.size);

    if (index > 0 && index % 128 === 0) {
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

  if (payload.type === "file-meta") {
    state.receiver.meta = payload;
    state.receiver.chunks = new Array(payload.totalChunks);
    state.receiver.bytesReceived = 0;

    startSpeedTicker(payload.size, "download");
    setStatus(`Receiving ${payload.name}`);
    log(
      `Receiving file ${payload.name} (${formatBytes(payload.size)}) in ${payload.totalChunks} chunks.`
    );
    return;
  }

  if (payload.type === "file-chunk") {
    if (!state.receiver.meta) {
      return;
    }

    const normalized = await normalizeBuffer(payload.data);
    if (!normalized) {
      return;
    }

    if (!state.receiver.chunks[payload.index]) {
      state.receiver.chunks[payload.index] = normalized;
      state.receiver.bytesReceived += normalized.byteLength;
      renderProgress(state.receiver.bytesReceived, state.receiver.meta.size);
    }
    return;
  }

  if (payload.type === "file-end") {
    await finalizeDownload();
  }
}

async function finalizeDownload() {
  const meta = state.receiver.meta;
  if (!meta) {
    return;
  }

  const missing = state.receiver.chunks.some((chunk) => !chunk);
  if (missing) {
    setStatus("Chunk mismatch", "error");
    log("Transfer ended but some chunks are missing.", "error");
    stopSpeedTicker();
    return;
  }

  const blob = new Blob(state.receiver.chunks, { type: meta.mime });
  autoDownload(blob, meta.name);

  setStatus("Download ready", "success");
  log(`Download auto-triggered: ${meta.name}`, "success");

  stopSpeedTicker();
  state.receiver.meta = null;
  state.receiver.chunks = [];
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
  }, 1500);
}

function startSpeedTicker(totalBytes, direction) {
  stopSpeedTicker();

  state.metrics.totalBytes = totalBytes;
  state.metrics.direction = direction;
  state.metrics.startTime = performance.now();
  state.metrics.lastTick = state.metrics.startTime;
  state.metrics.lastBytes = 0;

  state.metrics.speedTimer = setInterval(() => {
    const currentBytes =
      direction === "upload" ? state.sender.bytesSent : state.receiver.bytesReceived;
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
  return (value / (1024 * 1024)).toFixed(2);
}

function shortId(id) {
  if (!id) {
    return "...";
  }
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
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
