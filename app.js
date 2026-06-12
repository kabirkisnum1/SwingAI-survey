const DEFAULT_SWING_COUNT = 6;
let SWING_COUNT = DEFAULT_SWING_COUNT;
let APP_FAULTS = [];
let MEDIA = { videos: [] };

const STORAGE_KEY = "swingai_survey_responses";
const DEVICE_KEY = "swingai_survey_device_id";

const surveyMain = document.getElementById("surveyMain");
const videoPool = document.getElementById("videoPool");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");

let currentPage = 0;
let pages = [];
let pooledVideos = [];

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
    swing.faultRatings.push({ response: null, errorExplanation: "" });
  }
  swing.faultRatings.length = faultCount;

  swing.faultRatings.forEach((rating) => {
    if (rating.response) rating.response = normalizeFaultResponse(rating.response);
    if (rating.errorExplanation === undefined) rating.errorExplanation = "";
  });

  if (swing.additionalThoughts === undefined) {
    swing.additionalThoughts = swing.feedback || "";
  }
}

function ensureSwingData(swingIndex) {
  normalizeSwing(responses.swings[swingIndex], swingIndex);
}

function emptySwing(clipMeta = {}) {
  return {
    clipId: clipMeta.clipId || null,
    source: clipMeta.source || null,
    clipLabel: clipMeta.clipLabel || null,
    observedFaults: "",
    feedback: "",
    faultRatings: [],
    additionalThoughts: "",
  };
}

function loadResponses() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if (data.submittedAt === undefined) data.submittedAt = null;
      if (!data.sessionId) data.sessionId = null;
      if (!data.catalogVersion) data.catalogVersion = null;
      if (!Array.isArray(data.swings)) data.swings = [];
      return data;
    }
  } catch {
    // Ignore corrupt storage
  }
  return {
    startedAt: new Date().toISOString(),
    sessionId: null,
    catalogVersion: null,
    participant: { name: "", position: "" },
    swings: [],
    completedAt: null,
    submittedAt: null,
  };
}

function applySession(session) {
  SWING_COUNT = session.swingCount;
  APP_FAULTS = session.swings.map((s) =>
    s.faults.map((f) => ({ name: f.name, description: f.description }))
  );
  MEDIA = {
    videos: session.swings.map((s) => ({ src: s.videoUrl })),
  };

  const catalogVersion = session.catalogVersion || null;
  const versionChanged = catalogVersion && responses.catalogVersion !== catalogVersion;

  if (versionChanged) {
    responses.sessionId = session.sessionId;
    responses.catalogVersion = catalogVersion;
    responses.participant = { name: "", position: "" };
    responses.submittedAt = null;
    responses.completedAt = null;
    responses.swings = session.swings.map((clip) =>
      emptySwing({ clipId: clip.clipId, source: clip.source, clipLabel: clip.id })
    );
  } else {
    responses.sessionId = session.sessionId;
    responses.catalogVersion = catalogVersion;

    const merged = session.swings.map((clip, i) => {
      const prev =
        responses.swings.find((sw) => sw.clipId && sw.clipId === clip.clipId) ||
        responses.swings[i] ||
        emptySwing();
      return {
        ...emptySwing({
          clipId: clip.clipId,
          source: clip.source,
          clipLabel: clip.id,
        }),
        observedFaults: prev.observedFaults || "",
        feedback: prev.feedback || "",
        faultRatings: prev.faultRatings || [],
        additionalThoughts: prev.additionalThoughts || "",
      };
    });

    responses.swings = merged;
  }

  responses.swings.forEach((swing, i) => normalizeSwing(swing, i));
  saveResponses();
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function loadSurveySession() {
  const deviceId = getDeviceId();
  const params = new URLSearchParams({ deviceId });
  if (responses.sessionId) params.set("sessionId", responses.sessionId);

  const res = await fetch(`/api/session?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Could not load survey videos");
  }
  return res.json();
}

function saveResponses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(responses));
  queueServerProgressSave();
}

let progressSaveTimer = null;
function queueServerProgressSave() {
  if (!responses.sessionId || responses.submittedAt) return;
  if (progressSaveTimer) clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(async () => {
    try {
      await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(responses),
      });
    } catch {
      // Offline — localStorage still has progress
    }
  }, 400);
}

async function loadServerProgress(sessionId) {
  if (!sessionId) return null;
  try {
    const res = await fetch(`/api/progress?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function destroyVideoPool() {
  pooledVideos.forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  pooledVideos = [];
  if (videoPool) videoPool.innerHTML = "";
}

function buildVideoPool() {
  destroyVideoPool();
  if (!videoPool) return;

  MEDIA.videos.forEach((entry, index) => {
    const video = document.createElement("video");
    video.id = `survey-video-${index}`;
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.setAttribute("data-swing-index", String(index));
    video.src = entry.src;
    videoPool.appendChild(video);
    pooledVideos.push(video);
  });
}

function prefetchAllVideos(onProgress) {
  if (!pooledVideos.length) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let loaded = 0;
    const total = pooledVideos.length;

    const markLoaded = () => {
      loaded += 1;
      if (onProgress) onProgress(loaded, total);
      if (loaded >= total) resolve();
    };

    pooledVideos.forEach((video) => {
      if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        markLoaded();
        return;
      }

      const onReady = () => {
        video.removeEventListener("error", onError);
        markLoaded();
      };

      const onError = () => {
        video.removeEventListener("canplaythrough", onReady);
        reject(new Error("Could not load a survey video. Check your connection and try again."));
      };

      video.addEventListener("canplaythrough", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.load();
    });
  });
}

function parkAllSwingVideos() {
  if (!videoPool) return;

  pooledVideos.forEach((video) => {
    if (video.parentElement !== videoPool) {
      video.pause();
      video.controls = false;
      video.muted = true;
      videoPool.appendChild(video);
    }
  });
}

function mountSwingVideo(swingIndex) {
  const swingNum = swingIndex + 1;
  const mount = document.getElementById(`mediaMount-${swingNum}`);
  const video = pooledVideos[swingIndex];
  if (!mount || !video) return;

  parkAllSwingVideos();
  video.muted = false;
  video.controls = true;
  mount.appendChild(video);
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

      const showErrorExplain = ratings[fi]?.response === "error";
      const errorExpl = ratings[fi]?.errorExplanation || "";

      return `
        <li class="fault-card">
          <div class="fault-body">
            <div class="fault-top">
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
            </div>
            <div class="fault-error-explain" id="fault-error-wrap-${swingNum}-${fi}" ${showErrorExplain ? "" : "hidden"}>
              <label for="fault-error-expl-${swingNum}-${fi}">What's wrong with how we've defined this fault?</label>
              <textarea
                id="fault-error-expl-${swingNum}-${fi}"
                class="fault-error-input"
                placeholder="Explain why this fault description is incorrect, unclear, or not a real fault…"
              >${escapeHtml(errorExpl)}</textarea>
              <div class="error-message fault-error-required" id="fault-error-req-${swingNum}-${fi}">Please explain what's wrong with this fault definition.</div>
            </div>
          </div>
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

function setupFaultRatingListeners(swingIndex, swingNum) {
  const faults = APP_FAULTS[swingIndex] || [];
  faults.forEach((_, fi) => {
    document.querySelectorAll(`input[name="fault-${swingNum}-${fi}"]`).forEach((radio) => {
      radio.addEventListener("change", () => {
        const wrap = document.getElementById(`fault-error-wrap-${swingNum}-${fi}`);
        const isError = radio.value === "error" && radio.checked;
        if (wrap) wrap.hidden = !isError;
        collectAppFaultPage(swingIndex, swingNum);
      });
    });

    const errorInput = document.getElementById(`fault-error-expl-${swingNum}-${fi}`);
    if (errorInput) {
      errorInput.addEventListener("input", () => collectAppFaultPage(swingIndex, swingNum));
    }
  });
}

function collectAppFaultPage(swingIndex, swingNum) {
  const faults = APP_FAULTS[swingIndex] || [];
  ensureSwingData(swingIndex);

  faults.forEach((fault, fi) => {
    const selected = document.querySelector(`input[name="fault-${swingNum}-${fi}"]:checked`);
    const errorEl = document.getElementById(`fault-error-expl-${swingNum}-${fi}`);
    responses.swings[swingIndex].faultRatings[fi] = {
      name: fault.name,
      response: selected ? selected.value : null,
      errorExplanation:
        selected?.value === "error" && errorEl ? errorEl.value.trim() : "",
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
        <p class="page-subtitle">Thank you for taking the time to help us improve our swing analysis.</p>

        <div class="card overview-card">
          <h2 class="overview-heading">About the app</h2>
          <p>Our app takes a video of your golf swing and identifies the <strong>top 3 faults</strong> you can work on to improve. We're building toward a fuller coaching experience — including your <strong>strengths</strong>, more <strong>actionable feedback</strong>, and richer analysis over time.</p>
          <p>We're genuinely thankful for your expertise. Your input as a coach or player helps us make the product more accurate and more useful for real practice.</p>
        </div>

        <div class="card overview-card">
          <h2 class="overview-heading">How this survey works</h2>
          <p>For each of <strong>${SWING_COUNT} swing videos</strong>, you'll:</p>
          <ol class="overview-steps">
            <li><span class="step-text"><strong>Watch the swing</strong> and list the most important faults <em>you</em> see.</span></li>
            <li><span class="step-text"><strong>Review what our app detected</strong> and rate each fault using the options below.</span></li>
          </ol>
          <p class="overview-ratings-title"><strong>What each rating means</strong></p>
          <ul class="rating-legend">
            <li>
              <span class="legend-pill legend-agree">Agree</span>
              <span class="legend-desc">This fault was present in the swing and the app identified it correctly.</span>
            </li>
            <li>
              <span class="legend-pill legend-disagree">Disagree</span>
              <span class="legend-desc">This fault was <strong>not</strong> in the swing; the app flagged something that wasn't there.</span>
            </li>
            <li>
              <span class="legend-pill legend-error">Error in fault</span>
              <span class="legend-desc">The fault itself is poorly defined or isn't a real thing — the description or concept is wrong, not just the detection. You'll be asked to explain what's wrong with how we've defined it.</span>
            </li>
          </ul>
          <p class="form-hint"><span class="hint-text">Your answers save automatically as you go. At the end, press <strong>Submit responses</strong> to send them to us. The survey takes roughly 25–35 minutes.</span></p>
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

    // Page 1: Observed faults + video
    pages.push({
      id: `swing-${swingNum}-observed`,
      swingIndex: i,
      render: () => `
        <div class="page active" data-page="swing-${swingNum}-observed">
          <span class="swing-badge">Swing ${swingNum} of ${SWING_COUNT}</span>
          <h1 class="page-title">List the faults that you see in this swing</h1>
          <p class="page-subtitle">Ideally 2–3 faults. Be as specific as you can.</p>

          <div class="media-container" id="mediaMount-${swingNum}" aria-label="Swing ${swingNum} video"></div>

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
      onShow: () => mountSwingVideo(i),
    });

    // Page 2: App-detected faults + feedback
    pages.push({
      id: `swing-${swingNum}-app-faults`,
      swingIndex: i,
      render: () => `
        <div class="page active" data-page="swing-${swingNum}-app-faults">
          <span class="swing-badge">Swing ${swingNum} of ${SWING_COUNT}</span>
          <h1 class="page-title">The faults the app found were:</h1>
          <p class="page-subtitle">Rate each fault. Disagree if it wasn't in the swing; Error in fault if the definition itself is wrong.</p>

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
        let allAnswered = true;
        let allErrorsExplained = true;

        faults.forEach((_, fi) => {
          const selected = document.querySelector(`input[name="fault-${swingNum}-${fi}"]:checked`);
          const answered = selected && validValues.includes(selected.value);
          if (!answered) allAnswered = false;

          const reqEl = document.getElementById(`fault-error-req-${swingNum}-${fi}`);
          const errorEl = document.getElementById(`fault-error-expl-${swingNum}-${fi}`);
          const needsExplain = selected?.value === "error";
          const explained = !needsExplain || (errorEl && errorEl.value.trim());
          if (reqEl) reqEl.classList.toggle("visible", needsExplain && !explained);
          if (needsExplain && !explained) allErrorsExplained = false;
        });

        document.getElementById(`faultRatingError-${swingNum}`).classList.toggle("visible", !allAnswered);
        return allAnswered && allErrorsExplained;
      },
      collect: () => collectAppFaultPage(i, swingNum),
      onShow: () => setupFaultRatingListeners(i, swingNum),
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
            <div class="complete-icon">✓</div>
            <h2>Thank you!</h2>
            <p>You've finished all ${SWING_COUNT} swings — we really appreciate your time and expertise.</p>
            <p class="page-subtitle"><span class="hint-text">Tap <strong>Submit responses</strong> below when you're ready to send your feedback to us.</span></p>

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
  parkAllSwingVideos();
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

async function initSurvey() {
  surveyMain.innerHTML = `<div class="page active"><p class="page-subtitle">Loading your survey videos…</p></div>`;
  nextBtn.disabled = true;
  prevBtn.disabled = true;

  try {
    const session = await loadSurveySession();
    if (responses.sessionId === session.sessionId && !responses.submittedAt) {
      const serverProgress = await loadServerProgress(session.sessionId);
      if (serverProgress?.swings?.length) {
        responses.participant = serverProgress.participant || responses.participant;
        responses.swings = serverProgress.swings;
        responses.startedAt = serverProgress.startedAt || responses.startedAt;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(responses));
      }
    }
    applySession(session);
    buildVideoPool();
    await prefetchAllVideos((loaded, total) => {
      console.log(`[survey] cached videos ${loaded}/${total}`);
    });
    buildPages();
    renderPage(currentPage);
    nextBtn.disabled = false;
  } catch (err) {
    destroyVideoPool();
    surveyMain.innerHTML = `
      <div class="page active">
        <h2 class="page-title">Could not start survey</h2>
        <p class="page-subtitle">${escapeHtml(err.message)}</p>
        <button type="button" class="btn btn-primary" id="retrySurveyBtn">Try again</button>
      </div>`;
    document.getElementById("retrySurveyBtn").onclick = () => initSurvey();
  }
}

initSurvey();
