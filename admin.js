const HISTORY_KEY = "nebulaShareHistoryV1";

const ui = {
  totalTransfers: document.getElementById("totalTransfers"),
  successRate: document.getElementById("successRate"),
  avgSpeed: document.getElementById("avgSpeed"),
  totalData: document.getElementById("totalData"),
  adminHistoryTable: document.getElementById("adminHistoryTable"),
  clearAdminHistoryBtn: document.getElementById("clearAdminHistoryBtn"),
};

init();

function init() {
  if (sessionStorage.getItem("nebulaAdminUnlocked") !== "1") {
    document.body.innerHTML =
      "<main class='shell'><section class='card'><h1>Access Denied</h1><p>Open admin from the main app and enter passcode.</p></section></main>";
    return;
  }

  ui.clearAdminHistoryBtn.addEventListener("click", () => {
    localStorage.removeItem(HISTORY_KEY);
    render();
  });

  render();
}

function render() {
  const history = loadHistory();
  const totalTransfers = history.length;
  const successCount = history.filter((item) => item.status === "success").length;
  const totalSpeed = history.reduce((sum, item) => sum + (Number(item.speedMbps) || 0), 0);
  const totalDataBytes = history.reduce((sum, item) => sum + (Number(item.size) || 0), 0);

  ui.totalTransfers.textContent = String(totalTransfers);
  ui.successRate.textContent = totalTransfers
    ? `${((successCount / totalTransfers) * 100).toFixed(1)}%`
    : "0%";
  ui.avgSpeed.textContent = totalTransfers
    ? `${(totalSpeed / totalTransfers).toFixed(2)} MB/s`
    : "0 MB/s";
  ui.totalData.textContent = `${(totalDataBytes / (1024 * 1024)).toFixed(2)} MB`;

  renderTable(history);
}

function renderTable(history) {
  if (!history.length) {
    ui.adminHistoryTable.innerHTML = "<div class=\"row\">No data yet.</div>";
    return;
  }

  const head = `
    <div class="row head">
      <div>Time / File</div>
      <div>Direction</div>
      <div>Size</div>
      <div>Speed</div>
      <div>Integrity</div>
      <div>Status</div>
    </div>
  `;

  const rows = history
    .map((item) => {
      return `
        <div class="row">
          <div>${escapeHtml(new Date(item.at).toLocaleString())}<br/>${escapeHtml(item.name || "unknown")}</div>
          <div>${escapeHtml(item.direction || "-")}</div>
          <div>${formatBytes(item.size || 0)}</div>
          <div>${(Number(item.speedMbps) || 0).toFixed(2)} MB/s</div>
          <div>${escapeHtml(item.integrity || "N/A")}</div>
          <div>${escapeHtml(item.status || "-")}</div>
        </div>
      `;
    })
    .join("");

  ui.adminHistoryTable.innerHTML = head + rows;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
