const API = (window.ADMIN_CONFIG && window.ADMIN_CONFIG.apiUrl) || "/api";

const responsesList = document.getElementById("responsesList");
const emptyState = document.getElementById("emptyState");
const statsText = document.getElementById("statsText");
const refreshBtn = document.getElementById("refreshBtn");
const exportAllBtn = document.getElementById("exportAllBtn");

let responses = [];

refreshBtn.addEventListener("click", () => loadResponses());

exportAllBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(responses, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `swing-survey-all-responses-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

async function loadResponses() {
  try {
    const res = await fetch(`${API}/responses`);
    if (!res.ok) throw new Error("Could not load responses");
    responses = await res.json();
    renderResponses();
  } catch (err) {
    statsText.textContent = err.message;
  }
}

function formatDate(iso) {
  if (!iso) return "Unknown date";
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderResponses() {
  responsesList.innerHTML = "";
  statsText.textContent = `${responses.length} response${responses.length === 1 ? "" : "s"}`;
  emptyState.hidden = responses.length > 0;

  responses.forEach((entry) => {
    const name = entry.participant?.name || "Anonymous";
    const position = entry.participant?.position || "";
    const submitted = entry.submittedAt || entry.receivedAt;
    const swingCount = entry.swings?.length || 0;

    const card = document.createElement("article");
    card.className = "response-card";
    card.innerHTML = `
      <button type="button" class="response-toggle" aria-expanded="false">
        <div class="response-summary-row">
          <div>
            <strong>${escapeHtml(name)}</strong>
            <span class="response-meta">${escapeHtml(position)}</span>
          </div>
          <div class="response-meta">${formatDate(submitted)} · ${swingCount} swings</div>
        </div>
      </button>
      <div class="response-detail" hidden>
        <pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
      </div>
    `;

    const toggle = card.querySelector(".response-toggle");
    const detail = card.querySelector(".response-detail");
    toggle.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });

    responsesList.appendChild(card);
  });
}

loadResponses();
