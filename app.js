const SWING_COUNT = 6;

// Update these paths when you upload media files.
// Place videos in assets/videos/  (e.g. swing-1.mp4, swing-2.mp4, ...)
// Place images in assets/images/  (e.g. swing-1-results.jpeg, swing-2-results.jpeg, ...)
const MEDIA = {
  videos: Array.from({ length: SWING_COUNT }, (_, i) => ({
    src: `assets/videos/swing-${i + 1}.mp4`,
  })),
  images: Array.from({ length: SWING_COUNT }, (_, i) => ({
    src: `assets/images/swing-${i + 1}-results.jpeg`,
    alt: `App-detected faults for swing ${i + 1}`,
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

function loadResponses() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      while (data.swings.length < SWING_COUNT) {
        data.swings.push({ observedFaults: "", feedback: "" });
      }
      if (data.submittedAt === undefined) data.submittedAt = null;
      return data;
    }
  } catch {
    // Ignore corrupt storage
  }
  return {
    startedAt: new Date().toISOString(),
    participant: { name: "", position: "" },
    swings: Array.from({ length: SWING_COUNT }, () => ({
      observedFaults: "",
      feedback: "",
    })),
    completedAt: null,
    submittedAt: null,
  };
}

function saveResponses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(responses));
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
        // Fresh run from welcome — allow a new server submission even if this device submitted before.
        responses.submittedAt = null;
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
    const image = MEDIA.images[i];

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

    // Page 2: App-detected faults + image + feedback
    pages.push({
      id: `swing-${swingNum}-app-faults`,
      swingIndex: i,
      render: () => `
        <div class="page active" data-page="swing-${swingNum}-app-faults">
          <span class="swing-badge">Swing ${swingNum} of ${SWING_COUNT}</span>
          <h1 class="page-title">The faults the app found were:</h1>
          <p class="page-subtitle">Review what our AI detected for this swing.</p>

          <div class="media-container">
            <img src="${image.src}" alt="${image.alt}" />
          </div>

          <div class="form-group">
            <label for="feedback-${swingNum}">Any feedback / critiques?</label>
            <textarea id="feedback-${swingNum}" placeholder="How accurate was the app's analysis? Anything it missed or got wrong?">${escapeHtml(responses.swings[i].feedback)}</textarea>
            <p class="form-hint">Optional — skip if you have nothing to add.</p>
          </div>
        </div>
      `,
      collect: () => {
        responses.swings[i].feedback = document.getElementById(`feedback-${swingNum}`).value.trim();
        saveResponses();
      },
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
            <h2>Almost done!</h2>
            <p class="page-subtitle">Review your details below, then tap <strong>Submit responses</strong> at the bottom of the screen to send your feedback to us.</p>

            <div class="card submit-summary">
              <p><strong>${escapeHtml(responses.participant.name || "Participant")}</strong></p>
              <p class="submit-meta">${escapeHtml(responses.participant.position || "")}</p>
              <p class="submit-meta">${SWING_COUNT} swings completed</p>
            </div>

            <button type="button" class="btn btn-secondary btn-link-style" id="downloadBtn">Download a copy for your records</button>
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
    },
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const isLast = index === pages.length - 1;
  const submitted = Boolean(responses.submittedAt);

  prevBtn.disabled = index === 0;
  prevBtn.style.display = isLast && submitted ? "none" : "inline-block";

  if (isLast && submitted) {
    nextBtn.style.display = "none";
    return;
  }

  if (isLast) {
    nextBtn.textContent = "Submit responses";
    nextBtn.style.display = "inline-block";
    nextBtn.disabled = false;
    return;
  }

  nextBtn.textContent = "Next";
  nextBtn.style.display = "inline-block";
  nextBtn.disabled = false;
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
  const submitBtn = nextBtn;
  const statusEl = document.getElementById("submitStatus");

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "status-message";
    statusEl.textContent = "Sending your responses…";
  }

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
    updateNavButtons(currentPage);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "status-message status-error";
      statusEl.textContent = err.message || "Could not submit. Check your connection and try again.";
    }
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit responses";
  }
}

prevBtn.addEventListener("click", () => {
  if (currentPage > 0) goToPage(currentPage - 1);
});

nextBtn.addEventListener("click", () => {
  const page = pages[currentPage];

  if (page.validate && !page.validate()) return;
  if (page.collect) page.collect();

  if (currentPage === pages.length - 1) {
    if (!responses.submittedAt) submitResponses();
    return;
  }

  if (currentPage < pages.length - 1) {
    goToPage(currentPage + 1);
  }
});

buildPages();
renderPage(currentPage);
