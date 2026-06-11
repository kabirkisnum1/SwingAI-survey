const API = (window.ADMIN_CONFIG && window.ADMIN_CONFIG.apiUrl) || "/api";

const responsesList = document.getElementById("responsesList");
const emptyState = document.getElementById("emptyState");
const loadingState = document.getElementById("loadingState");
const errorMessage = document.getElementById("errorMessage");
const statCount = document.getElementById("statCount");
const statLatest = document.getElementById("statLatest");
const statsRow = document.getElementById("statsRow");
const refreshBtn = document.getElementById("refreshBtn");
const exportAllBtn = document.getElementById("exportAllBtn");
const searchInput = document.getElementById("searchInput");
const advancedToggle = document.getElementById("advancedToggle");
const advancedPanel = document.getElementById("advancedPanel");

let responses = [];
let searchQuery = "";

refreshBtn.addEventListener("click", () => loadResponses(true));
exportAllBtn.addEventListener("click", downloadAllJson);
searchInput.addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderResponses();
});

advancedToggle.addEventListener("click", () => {
  const open = advancedPanel.hidden;
  advancedPanel.hidden = !open;
  advancedToggle.setAttribute("aria-expanded", String(open));
});

function downloadAllJson() {
  const blob = new Blob([JSON.stringify(responses, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `swing-survey-all-responses-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadOneJson(entry) {
  const name = (entry.participant?.name || "response").replace(/\s+/g, "-").toLowerCase();
  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `swing-survey-${name}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadResponses(manual = false) {
  loadingState.hidden = false;
  errorMessage.hidden = true;
  if (manual) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("is-loading");
  }

  try {
    const res = await fetch(`${API}/responses`);
    if (!res.ok) throw new Error("Could not load responses. Try again in a moment.");
    responses = await res.json();
    renderResponses();
  } catch (err) {
    errorMessage.textContent = err.message;
    errorMessage.hidden = false;
  } finally {
    loadingState.hidden = true;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove("is-loading");
  }
}

function formatDate(iso) {
  if (!iso) return "Unknown date";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function getFilteredResponses() {
  if (!searchQuery) return responses;
  return responses.filter((entry) => {
    const name = (entry.participant?.name || "").toLowerCase();
    const position = (entry.participant?.position || "").toLowerCase();
    return name.includes(searchQuery) || position.includes(searchQuery);
  });
}

const RATING_LABELS = {
  agree: "Agree",
  disagree: "Disagree",
  error: "Error in fault",
  yes: "Agree",
  no: "Disagree",
};

const RATING_CLASSES = {
  agree: "rating-badge-agree",
  disagree: "rating-badge-disagree",
  error: "rating-badge-error",
  yes: "rating-badge-agree",
  no: "rating-badge-disagree",
};

function renderFaultRatings(swing) {
  const ratings = swing.faultRatings || [];

  if (ratings.length === 0) {
    return '<p class="field-value muted">No app fault ratings recorded</p>';
  }

  return `
    <ul class="admin-fault-list">
      ${ratings
        .map((rating) => {
          const response = rating.response;
          const label = RATING_LABELS[response] || "Not rated";
          const badgeClass = RATING_CLASSES[response] || "rating-badge-none";
          const errorBlock =
            response === "error" && rating.errorExplanation?.trim()
              ? `<p class="admin-error-expl"><span class="admin-error-label">Fault definition issue:</span><span class="admin-error-text">${escapeHtml(rating.errorExplanation.trim())}</span></p>`
              : response === "error"
                ? '<p class="admin-error-expl muted"><span class="admin-error-text">No explanation provided</span></p>'
                : "";

          return `
            <li class="admin-fault-item">
              <div class="admin-fault-head">
                <span class="admin-fault-name">${escapeHtml(rating.name || "Fault")}</span>
                <span class="rating-badge ${badgeClass}">${escapeHtml(label)}</span>
              </div>
              ${errorBlock}
            </li>`;
        })
        .join("")}
    </ul>`;
}

function renderSwingBlock(swing, index) {
  const observed = swing.observedFaults?.trim() || "";
  const additional = (swing.additionalThoughts || swing.feedback || "").trim();

  return `
    <article class="swing-block">
      <h4 class="swing-title">Swing ${index + 1}${swing.clipId ? ` <span class="swing-source">(${escapeHtml(swing.source || "")}: ${escapeHtml(swing.clipLabel || swing.clipId)})</span>` : ""}</h4>
      <div class="field-block">
        <span class="field-label">Faults they observed</span>
        <p class="field-value">${observed ? escapeHtml(observed) : '<em class="muted">None listed</em>'}</p>
      </div>
      <div class="field-block">
        <span class="field-label">App-detected faults — their ratings</span>
        ${renderFaultRatings(swing)}
      </div>
      <div class="field-block">
        <span class="field-label">Additional thoughts</span>
        <p class="field-value">${additional ? escapeHtml(additional) : '<em class="muted">None provided</em>'}</p>
      </div>
    </article>
  `;
}

function renderResponses() {
  const filtered = getFilteredResponses();
  responsesList.innerHTML = "";

  const count = responses.length;
  statCount.textContent = String(count);
  statsRow.hidden = count === 0;

  if (count > 0) {
    const latest = [...responses].sort(
      (a, b) => new Date(b.submittedAt || b.receivedAt) - new Date(a.submittedAt || a.receivedAt)
    )[0];
    statLatest.textContent = formatDateShort(latest.submittedAt || latest.receivedAt);
  }

  const showEmpty = filtered.length === 0;
  emptyState.hidden = !showEmpty || (count > 0 && searchQuery);
  responsesList.hidden = showEmpty;

  if (count === 0) {
    emptyState.querySelector("h2").textContent = "No responses yet";
    emptyState.querySelector("p").textContent =
      "When a coach completes the survey, their answers will show up here. Share the survey link — not this page.";
    return;
  }

  if (searchQuery && filtered.length === 0) {
    emptyState.hidden = false;
    emptyState.querySelector("h2").textContent = "No matches";
    emptyState.querySelector("p").textContent = `No coach found matching “${escapeHtml(searchQuery)}”.`;
    return;
  }

  filtered.forEach((entry) => {
    const name = entry.participant?.name || "Anonymous";
    const position = entry.participant?.position || "";
    const submitted = entry.submittedAt || entry.receivedAt;
    const swingCount = entry.swings?.length || 0;
    const swingsHtml = (entry.swings || []).map(renderSwingBlock).join("");

    const card = document.createElement("article");
    card.className = "response-card";
    card.innerHTML = `
      <button type="button" class="response-toggle" aria-expanded="false">
        <div class="response-summary">
          <div class="response-avatar" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</div>
          <div class="response-summary-text">
            <strong class="response-name">${escapeHtml(name)}</strong>
            ${position ? `<span class="response-role">${escapeHtml(position)}</span>` : ""}
            <span class="response-meta">${formatDate(submitted)} · ${plural(swingCount, "swing")}</span>
          </div>
        </div>
        <span class="chevron chevron-lg" aria-hidden="true">›</span>
      </button>
      <div class="response-detail" hidden>
        <div class="response-detail-inner">
          <section class="detail-section">
            <h3>Coach details</h3>
            <dl class="detail-grid">
              <div><dt>Name</dt><dd>${escapeHtml(name)}</dd></div>
              <div><dt>Role / position</dt><dd>${position ? escapeHtml(position) : '<em class="muted">Not provided</em>'}</dd></div>
              <div><dt>Submitted</dt><dd>${formatDate(submitted)}</dd></div>
            </dl>
          </section>
          <section class="detail-section">
            <h3>Swing-by-swing feedback</h3>
            <div class="swings-grid">${swingsHtml}</div>
          </section>
          <div class="response-actions">
            <button type="button" class="btn btn-ghost btn-sm toggle-json-btn">Show raw data</button>
            <button type="button" class="btn btn-ghost btn-sm download-one-btn">Download this response (.json)</button>
          </div>
          <pre class="raw-json" hidden>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
        </div>
      </div>
    `;

    const toggle = card.querySelector(".response-toggle");
    const detail = card.querySelector(".response-detail");
    const jsonPre = card.querySelector(".raw-json");
    const toggleJsonBtn = card.querySelector(".toggle-json-btn");
    const downloadOneBtn = card.querySelector(".download-one-btn");

    toggle.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      card.classList.toggle("is-open", open);
    });

    toggleJsonBtn.addEventListener("click", () => {
      const show = jsonPre.hidden;
      jsonPre.hidden = !show;
      toggleJsonBtn.textContent = show ? "Hide raw data" : "Show raw data";
    });

    downloadOneBtn.addEventListener("click", () => downloadOneJson(entry));

    responsesList.appendChild(card);
  });
}

loadResponses();
