const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RESPONSES_FILE = path.join(__dirname, "..", "data", "responses.jsonl");
const PARTIALS_DIR = path.join(__dirname, "..", "data", "partials");
const SUPABASE_TABLE = "survey_responses";

function ensureDataDir() {
  const dir = path.dirname(RESPONSES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeResponseEntry(raw, extra = {}) {
  const sessionId = raw.sessionId || raw.id || null;
  const submittedAt = raw.submittedAt ?? null;
  const inProgress =
    extra.inProgress !== undefined ? Boolean(extra.inProgress) : Boolean(raw.inProgress);
  return {
    ...raw,
    id: sessionId || raw.id || crypto.randomUUID(),
    sessionId,
    receivedAt: raw.receivedAt || raw.savedAt || raw.startedAt || new Date().toISOString(),
    savedAt: raw.savedAt || null,
    submittedAt: inProgress ? null : submittedAt,
    inProgress,
  };
}

function mapSupabaseRow(row) {
  const payload =
    typeof row.payload === "string"
      ? (() => {
          try {
            return JSON.parse(row.payload);
          } catch {
            return {};
          }
        })()
      : row.payload || {};

  return normalizeResponseEntry(
    {
      ...payload,
      id: payload.id || payload.sessionId || row.id || null,
      receivedAt: payload.receivedAt || row.received_at || payload.startedAt || null,
      submittedAt: payload.submittedAt || row.submitted_at || null,
      inProgress: Boolean(payload.inProgress),
    },
    { inProgress: Boolean(payload.inProgress) }
  );
}

function supabaseRowFromEntry(normalized) {
  return {
    id: normalized.id,
    received_at: normalized.receivedAt,
    submitted_at: normalized.submittedAt || normalized.receivedAt,
    payload: normalized,
  };
}

function writePartialFileSafe(normalized) {
  if (!normalized.inProgress || !normalized.sessionId) return;
  try {
    fs.mkdirSync(PARTIALS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PARTIALS_DIR, `${normalized.sessionId}.json`),
      JSON.stringify(normalized, null, 2)
    );
  } catch (err) {
    console.warn("Partial file write skipped:", err.message);
  }
}

function deletePartialFileSafe(sessionId) {
  if (!sessionId) return;
  try {
    const partialPath = path.join(PARTIALS_DIR, `${sessionId}.json`);
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
  } catch (err) {
    console.warn("Partial file delete skipped:", err.message);
  }
}

function readAllPartialsLocal() {
  if (!fs.existsSync(PARTIALS_DIR)) return [];
  return fs
    .readdirSync(PARTIALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PARTIALS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((partial) => normalizeResponseEntry(partial, { inProgress: true }));
}

function mergeResponses(completed, partials) {
  const byKey = new Map();
  for (const entry of partials) {
    const key = entry.sessionId || entry.id;
    if (key) byKey.set(key, entry);
  }
  for (const entry of completed) {
    const key = entry.sessionId || entry.id;
    if (key) byKey.set(key, { ...entry, inProgress: false });
    else byKey.set(entry.id, { ...entry, inProgress: false });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      new Date(b.submittedAt || b.savedAt || b.receivedAt) -
      new Date(a.submittedAt || a.savedAt || a.receivedAt)
  );
}

function readAllResponsesLocal() {
  const completed = [];
  if (fs.existsSync(RESPONSES_FILE)) {
    for (const line of fs.readFileSync(RESPONSES_FILE, "utf8").split("\n")) {
      if (!line) continue;
      try {
        completed.push(normalizeResponseEntry(JSON.parse(line), { inProgress: false }));
      } catch {
        // skip bad lines
      }
    }
  }
  return mergeResponses(completed.reverse(), readAllPartialsLocal());
}

function logSupabaseError(label, error) {
  console.error(
    label,
    error.message,
    error.details || "",
    error.hint || "",
    error.code || ""
  );
}

async function supabaseSelectAll(supabase) {
  const attempts = [
    () => supabase.from(SUPABASE_TABLE).select("payload, submitted_at").order("submitted_at", { ascending: false }),
    () => supabase.from(SUPABASE_TABLE).select("payload").order("submitted_at", { ascending: false }),
    () => supabase.from(SUPABASE_TABLE).select("payload"),
  ];

  let lastError = null;
  for (const run of attempts) {
    const { data, error } = await run();
    if (!error) return data || [];
    lastError = error;
    logSupabaseError("Supabase read attempt failed:", error);
  }
  throw lastError;
}

async function supabaseWriteRow(supabase, normalized) {
  const fullRow = supabaseRowFromEntry(normalized);
  const minimalRow = {
    id: fullRow.id,
    submitted_at: fullRow.submitted_at,
    payload: fullRow.payload,
  };

  const attempts = [
    () => supabase.from(SUPABASE_TABLE).upsert(fullRow, { onConflict: "id" }),
    () => supabase.from(SUPABASE_TABLE).insert(fullRow),
    () => supabase.from(SUPABASE_TABLE).upsert(minimalRow, { onConflict: "id" }),
    () => supabase.from(SUPABASE_TABLE).insert(minimalRow),
  ];

  let lastError = null;
  for (const run of attempts) {
    const { error } = await run();
    if (!error) return;
    lastError = error;
    if (error.code === "23505") {
      const { id, ...updates } = fullRow;
      const updateAttempts = [
        () => supabase.from(SUPABASE_TABLE).update(updates).eq("id", id),
        () => {
          const { id: rowId, ...minimalUpdates } = minimalRow;
          return supabase.from(SUPABASE_TABLE).update(minimalUpdates).eq("id", rowId);
        },
      ];
      for (const updateRun of updateAttempts) {
        const updateResult = await updateRun();
        if (!updateResult.error) return;
        lastError = updateResult.error;
      }
    }
    logSupabaseError("Supabase write attempt failed:", error);
  }
  throw lastError;
}

function createResponseStore({ supabase } = {}) {
  const useSupabase = Boolean(supabase);

  return {
    normalizeResponseEntry,

    async verifyConnection() {
      if (!useSupabase) return true;
      const { error } = await supabase.from(SUPABASE_TABLE).select("id").limit(1);
      if (error) {
        logSupabaseError("Supabase startup check failed:", error);
        return false;
      }
      return true;
    },

    async readAll() {
      if (!useSupabase) return readAllResponsesLocal();
      try {
        const rows = await supabaseSelectAll(supabase);
        const remote = rows.map(mapSupabaseRow);
        const remoteCompleted = remote.filter((entry) => !entry.inProgress);
        const remotePartials = remote.filter((entry) => entry.inProgress);
        return mergeResponses(remoteCompleted, [...readAllPartialsLocal(), ...remotePartials]);
      } catch (err) {
        logSupabaseError("Supabase read failed, using local fallback:", err);
        return readAllResponsesLocal();
      }
    },

    async readProgress(sessionId) {
      const partialPath = path.join(PARTIALS_DIR, `${sessionId}.json`);
      if (fs.existsSync(partialPath)) {
        return JSON.parse(fs.readFileSync(partialPath, "utf8"));
      }
      if (!useSupabase) return null;

      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .select("payload")
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw error;
      if (data?.payload?.inProgress) return data.payload;
      return null;
    },

    async save(entry, { inProgress = false } = {}) {
      const normalized = normalizeResponseEntry(entry, { inProgress });
      writePartialFileSafe(normalized);

      if (!useSupabase) {
        if (normalized.inProgress) return normalized;
        ensureDataDir();
        fs.appendFileSync(RESPONSES_FILE, JSON.stringify(normalized) + "\n");
        deletePartialFileSafe(normalized.sessionId);
        return normalized;
      }

      try {
        await supabaseWriteRow(supabase, normalized);
      } catch (err) {
        logSupabaseError("Supabase write failed, using local fallback:", err);
        if (!normalized.inProgress) {
          ensureDataDir();
          fs.appendFileSync(RESPONSES_FILE, JSON.stringify(normalized) + "\n");
        }
      }

      if (!normalized.inProgress) deletePartialFileSafe(normalized.sessionId);
      return normalized;
    },
  };
}

module.exports = {
  createResponseStore,
  normalizeResponseEntry,
};
