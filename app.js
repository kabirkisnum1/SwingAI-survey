const SWING_COUNT = 6;

// Place videos in assets/videos/  (e.g. swing-1.mp4, swing-2.mp4, ...)
// App-detected faults: edit faults.js (one list per swing)
const MEDIA = {
  videos: Array.from({ length: SWING_COUNT }, (_, i) => ({
    src: `assets/videos/swing-${i + 1}.mp4`,
  })),
};

const STORAGE_KEY = "swingai_survey_responses";

const surveyMain = document.getElementById("surveyMain");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");

let currentPage = 0;
let pages = [];

const responses = loadResponses();

const FAULT_RESPONSES = [
  { value: "agree", label: "Agree" },
  { value: "disagree", label: "Disagree" },
  { value: "error", label: "Error in fault" },
];

function normalizeFaultResponse(response) {
  if (response === "yes") return "agree";
  if (response === "no") return "disagree";
  return response;
}

function normalizeSwing(swing, swingIndex) {
  const faultCount = (APP_FAULTS[swingIndex] || []).length;

  if (!swing.faultRatings) swing.faultRatings = [];
  while (swing.faultRatings.length < faultCount) {
    swing.faultRatings.push({ response: null });
  }
  swing.faultRatings.length = faultCount;

  swing.faultRatings.forEach((rating) => {
    if (rating.response) rating.response = normalizeFaultResponse(rating.response);
  });

  if (swing.additionalThoughts === undefined) {
    swing.additionalThoughts = swing.feedback || "";
  }
}

function ensureSwingData(swingIndex) {
  normalizeSwing(responses.swings[swingIndex], swingIndex);
}

function loadResponses() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      while (data.swings.length < SWING_COUNT) {
        data.swings.push({ observedFaults: "", feedback: "", faultRatings: [], additionalThoughts: "" });
      }
      if (data.submittedAt === undefined) data.submittedAt = null;
      data.swings.forEach((swing, i) => normalizeSwing(swing, i));
      return data;
    }
  } catch {
    // Ignore corrupt storage
  }
  const data = {
    startedAt: new Date().toISOString(),
    participant: { name: "", position: "" },
    swings: Array.from({ length: SWING_COUNT }, () => ({
      observedFaults: "",
      feedback: "",
      faultRatings: [],
      additionalThoughts: "",
    })),
    completedAt: null,
    submittedAt: null,
  };
  data.swings.forEach((swing, i) => normalizeSwing(swing, i));
  return data;
}

function saveResponses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(responses));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAppFaults(swingIndex, swingNum) {
  const faults = APP_FAULTS[swingIndex] || [];
  ensureSwingData(swingIndex);
  const ratings = responses.swings[swingIndex].faultRatings;

  if (faults.length === 0) {
    return `<div class="faults-panel"><p class="faults-empty">No faults listed for this swing yet.</p></div>`;
  }

  const items = faults
    .map((fault, fi) => {
      const options = FAULT_RESPONSES.map(({ value, label }) => {
        const checked = ratings[fi]?.response === value ? "checked" : "";
        return `
          <label class="rating-pill rating-${value}">
            <input type="radio" name="fault-${swingNum}-${fi}" value="${value}" ${checked} />
            <span>${label}</span>
          </label>`;
      }).join("");

      return `
        <li class="fault-card">
          <div class="fault-main">
            <span class="fault-index">${fi + 1}</span>
            <div class="fault-content">
              <span class="fault-name">${escapeHtml(fault.name)}</span>
              <span class="fault-desc">${escapeHtml(fault.description)}</span>
            </div>
          </div>
          <fieldset class="fault-rating" aria-label="Rating for ${escapeHtml(fault.name)}">
            ${options}
          </fieldset>
        </li>`;
    })
    .join("");

  return `
    <div class="faults-panel">
      <div class="faults-header">
        <span class="faults-header-fault">Detected fault</span>
        <span class="faults-header-rating">Your rating</span>
      </div>
      <ul class="faults-list">${items}</ul>
    </div>`;
}

function collectAppFaultPage(swingIndex, swingNum) {
  const faults = APP_FAULTS[swingIndex] || [];
  ensureSwingData(swingIndex);

  faults.forEach((fault, fi) => {
    const selected = document.querySelector(`input[name="fault-${swingNum}-${fi}"]:checked`);
    responses.swings[swingIndex].faultRatings[fi] = {
      name: fault.name,
      response: selected ? selected.value : null,
    };
  });

  responses.swings[swingIndex].additionalThoughts =
    document.getElementById(`additionalThoughts-${swingNum}`).value.trim();
  saveResponses();
}

function buildPages() {
  pages = [];

  // Welcome / overview page
  pages.push({
    id: "welcome",
    render: () => `
      <div class="page active" data-page="welcome">
        <h1 class="page-title">Welcome to the Swing AI Survey</h1>
        <p class="page-subtitle">Help us evaluate how well our swing analysis performs.</p>

        <div class="card">
          <p><strong>What to expect</strong></p>
          <ul class="overview-list">
            <li>You will review <strong>${SWING_COUNT} golf swings</strong>, one at a time.</li>
            <li>For each swing, watch the video and list the faults you see (ideally 2–3).</li>
            <li>You'll then see the faults our app detected and can share feedback.</li>
            <li>Use <strong>Next</strong> and <strong>Back</strong> to move between questions.</li>
            <li>The survey takes roughly 15–20 minutes.</li>
          </ul>
        </div>

        <div class="form-group">
          <label for="participantName">Your name</label>
          <input type="text" id="participantName" placeholder="Enter your full name"
            value="${escapeHtml(responses.participant.name)}" />
          <div class="error-message" id="nameError">Please enter your name.</div>
        </div>

        <div class="form-group">
          <label for="participantPosition">Your position / role</label>
          <input type="text" id="participantPosition" placeholder="e.g. Golf coach, Player, Analyst"
            value="${escapeHtml(responses.participant.position)}" />
          <div class="error-message" id="positionError">Please enter your position.</div>
        </div>
      </div>
    `,
    validate: () => {
      const name = document.getElementById("participantName").value.trim();
      const position = document.getElementById("participantPosition").value.trim();
      let valid = true;

      document.getElementById("nameError").classList.toggle("visible", !name);
      document.getElementById("positionError").classList.toggle("visible", !position);

      if (!name || !position) valid = false;

      if (valid) {
        responses.participant.name = name;
        responses.participant.position = position;
        saveResponses();
      }
      return valid;
    },
    collect: () => {
      responses.participant.name = document.getElementById("participantName").value.trim();
      responses.participant.position = document.getElementById("participantPosition").value.trim();
      saveResponses();
    },
  });

  // Swing pages (2 pages per swing)
  for (let i = 0; i < SWING_COUNT; i++) {
    const swingNum = i + 1;
    const video = MEDIA.videos[i];

    // Page 1: Observed faults + video
    pages.push({
      id: `swing-${swingNum}-observed`,
      swingIndex: i,
      render: () => `
        <div class="page active" data-page="swing-${swingNum}-observed">
          <span class="swing-badge">Swing ${swingNum} of ${SWING_COUNT}</span>
          <h1 class="page-title">List the faults that you see in this swing</h1>
          <p class="page-subtitle">Ideally 2–3 faults. Be as specific as you can.</p>

          <div class="media-container">
            <video controls preload="metadata" playsinline src="${video.src}"></video>
          </div>

          <div class="form-group">
            <label for="observedFaults-${swingNum}">Faults you observed</label>
            <textarea id="observedFaults-${swingNum}" placeholder="e.g. Early extension, over-the-top, weak grip...">${escapeHtml(responses.swings[i].observedFaults)}</textarea>
            <div class="error-message" id="observedError-${swingNum}">Please list at least one fault.</div>
          </div>
        </div>
      `,
      validate: () => {
        const value = document.getElementById(`observedFaults-${swingNum}`).value.trim();
        const errorEl = document.getElementById(`observedError-${swingNum}`);
        errorEl.classList.toggle("visible", !value);
        if (!value) return false;
        responses.swings[i].observedFaults = value;
        saveResponses();
        return true;
      },
      collect: () => {
        responses.swings[i].observedFaults = document.getElementById(`observedFaults-${swingNum}`).value.trim();
        saveResponses();
      },
    });

    // Page 2: App-detected faults + feedback
    pages.push({
      id: `swing-${swingNum}-app-faults`,
      swingIndex: i,
      render: () => `
        <div class="page active" data-page="swing-${swingNum}-app-faults">
          <span class="swing-badge">Swing ${swingNum} of ${SWING_COUNT}</span>
          <h1 class="page-title">The faults the app found were:</h1>
          <p class="page-subtitle">Rate each fault the app detected for this swing.</p>

          ${renderAppFaults(i, swingNum)}

          <div class="form-group">
            <label for="additionalThoughts-${swingNum}">Additional thoughts</label>
            <textarea id="additionalThoughts-${swingNum}" class="additional-thoughts" placeholder="Anything else about this swing's analysis?">${escapeHtml(responses.swings[i].additionalThoughts || "")}</textarea>
            <p class="form-hint">Optional</p>
          </div>
          <div class="error-message" id="faultRatingError-${swingNum}">Please rate each fault (Agree, Disagree, or Error in fault).</div>
        </div>
      `,
      validate: () => {
        collectAppFaultPage(i, swingNum);
        const faults = APP_FAULTS[i] || [];
        const validValues = FAULT_RESPONSES.map((r) => r.value);
        const allAnswered = faults.every((_, fi) => {
          const selected = document.querySelector(`input[name="fault-${swingNum}-${fi}"]:checked`);
          return selected && validValues.includes(selected.value);
        });
        document.getElementById(`faultRatingError-${swingNum}`).classList.toggle("visible", !allAnswered);
        return allAnswered;
      },
      collect: () => collectAppFaultPage(i, swingNum),
    });
  }

  // Review & submit page
  pages.push({
    id: "complete",
    render: () => {
      if (responses.submittedAt) {
        return `
          <div class="page active" data-page="complete">
            <div class="complete-message">
              <div class="complete-icon">✓</div>
              <h2>Thank you!</h2>
              <p>Your responses were submitted successfully. We appreciate your time and feedback.</p>
            </div>
          </div>
        `;
      }

      return `
        <div class="page active" data-page="complete">
          <div class="complete-message">
            <h2>Review & submit</h2>
            <p class="page-subtitle">Your answers are saved on this device. When you're ready, submit them to send your responses.</p>

            <div class="card submit-summary">
              <p><strong>${escapeHtml(responses.participant.name || "Participant")}</strong></p>
              <p class="submit-meta">${escapeHtml(responses.participant.position || "")}</p>
              <p class="submit-meta">${SWING_COUNT} swings completed</p>
            </div>

            <div class="submit-actions">
              <button type="button" class="btn btn-primary" id="submitBtn">Submit responses</button>
              <button type="button" class="btn btn-secondary" id="downloadBtn">Download a copy (JSON)</button>
            </div>
            <p class="status-message" id="submitStatus" hidden></p>
          </div>
        </div>
      `;
    },
    onShow: () => {
      responses.completedAt = new Date().toISOString();
      saveResponses();

      if (responses.submittedAt) return;

      document.getElementById("downloadBtn").onclick = downloadResponses;
      document.getElementById("submitBtn").onclick = submitResponses;
    },
  });
}

function renderPage(index) {
  surveyMain.innerHTML = pages[index].render();
  updateProgress(index);
  updateNavButtons(index);

  if (pages[index].onShow) pages[index].onShow();
}

function updateProgress(index) {
  const total = pages.length;
  const pct = ((index + 1) / total) * 100;
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `Step ${index + 1} of ${total}`;
}

function updateNavButtons(index) {
  prevBtn.disabled = index === 0;
  nextBtn.textContent = index === pages.length - 1 ? "Finish" : "Next";
  nextBtn.style.display = index === pages.length - 1 ? "none" : "inline-block";
}

function goToPage(index) {
  if (pages[currentPage].collect) pages[currentPage].collect();
  currentPage = index;
  renderPage(currentPage);
}

function downloadResponses() {
  const blob = new Blob([JSON.stringify(responses, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `swing-survey-${responses.participant.name.replace(/\s+/g, "-").toLowerCase() || "response"}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const SUBMIT_API = (window.SURVEY_CONFIG && window.SURVEY_CONFIG.apiUrl) || "/api/responses";

async function submitResponses() {
  const submitBtn = document.getElementById("submitBtn");
  const statusEl = document.getElementById("submitStatus");

  submitBtn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = "status-message";
  statusEl.textContent = "Submitting…";

  try {
    const res = await fetch(SUBMIT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responses),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Submission failed. Please try again.");
    }

    responses.submittedAt = new Date().toISOString();
    saveResponses();
    renderPage(currentPage);
  } catch (err) {
    statusEl.className = "status-message status-error";
    statusEl.textContent = err.message || "Could not submit. Check your connection and try again.";
    submitBtn.disabled = false;
  }
}

prevBtn.addEventListener("click", () => {
  if (currentPage > 0) goToPage(currentPage - 1);
});

nextBtn.addEventListener("click", () => {
  const page = pages[currentPage];

  if (page.validate && !page.validate()) return;
  if (page.collect) page.collect();

  if (currentPage < pages.length - 1) {
    goToPage(currentPage + 1);
  }
});

buildPages();
renderPage(currentPage);
