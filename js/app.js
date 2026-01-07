// app.js
//
// Big Ten Completions by CIP2 (IPEDS) — Treemap + Institution Comparison Bar Chart
//
// Data columns expected in JSON rows:
// ['unitId', 'institution', 'year', 'majorNumber', 'cipCode', 'cipTitle',
//  'awardLevel', 'totalCompletions', 'indexCode', 'degreeGroup']
//
// ------------------------------------------------------------
// What this app does
// ------------------------------------------------------------
// 1) Treemap (single institution):
//    - Filters rows by selected Institution + Major + Degree Group + Award Level
//    - Aggregates to CIP2 and renders a Plotly treemap
//
// 2) Comparison bar chart (all institutions):
//    - Uses the selected CIP2 from "Compare CIP2 across institutions" dropdown
//    - Applies the same filters as treemap EXCEPT Institution (so all institutions included)
//    - For each institution:
//        numerator = completions for selected CIP2
//        denom     = completions across all CIP2 (in current filter context)
//        share     = numerator / denom
//    - Renders a horizontal bar chart sorted by share descending
//
// ------------------------------------------------------------
// 0) Config + in-memory state
// ------------------------------------------------------------
const DATA_URL = "./data/processed/ipeds/big10_cip2_2024_treemap.json";

let rawPayload = null; // parsed JSON response; { meta: {...}, data: [...] } OR { meta:null, data:[...] }
let rawRows = []; // array of row objects

// ------------------------------------------------------------
// 1) Color palette + deterministic CIP2->color mapping
// ------------------------------------------------------------
//
// Okabe-Ito + a few additional distinct hues (generally colorblind-friendly).
// We'll cycle if there are more CIP2 codes than colors.
const CIP_PALETTE = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // green
  "#D55E00", // vermillion
  "#CC79A7", // purple/pink
  "#56B4E9", // sky blue
  "#F0E442", // yellow
  "#332288", // indigo
  "#88CCEE", // light blue
  "#44AA99", // teal
  "#117733", // dark green
  "#999933", // olive
  "#DDCC77", // sand
  "#CC6677", // rose
  "#882255", // wine
  "#AA4499", // violet
  "#999999", // grey
];

let cipColorMap = new Map();

/**
 * Build a stable mapping from CIP2 code -> color.
 * Sorting ensures CIP2 codes always get the same color across sessions.
 */
function buildCipColorMap(rows) {
  const codes = [...new Set(rows.map((r) => r.cipCode).filter(Boolean))]
    .map(String)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const map = new Map();
  codes.forEach((code, i) => {
    map.set(code, CIP_PALETTE[i % CIP_PALETTE.length]);
  });
  return map;
}

// ------------------------------------------------------------
// 2) Generic helpers (errors, guards, HTML escaping, formatting)
// ------------------------------------------------------------

/**
 * Display user-friendly error text on the page (instead of silently failing).
 * Used for schema errors, missing DOM nodes, etc.
 */
function showError(message) {
  const el = document.getElementById("error");
  if (!el) {
    console.error("Error element #error missing. Message:", message);
    return;
  }
  el.textContent = message;
  el.style.display = "block";
}

/**
 * Clear the error display area.
 */
function clearError() {
  const el = document.getElementById("error");
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
}

/**
 * Guard: Ensure a required DOM element exists.
 * If it doesn't, show a helpful error directing you to index.html.
 */
function ensureElementExists(id, friendlyName) {
  const el = document.getElementById(id);
  if (!el) {
    showError(
      `Missing required page element: #${id} (${friendlyName}). ` +
        `Check index.html for an element with id="${id}".`
    );
    return false;
  }
  return true;
}

/**
 * Minimal HTML escaping so option labels/values don't break HTML.
 * Use this ONLY for inserting into innerHTML (e.g., <option> lists).
 */
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Shorten a title to a maximum length, adding ellipsis if needed.
 * Avoids ugly mid-word truncation most of the time, but guarantees a hard cap.
 */
function makeShortTitle(title, maxLen = 32) {
  if (!title) return "";
  const t = String(title).trim();
  if (t.length <= maxLen) return t;

  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.6)) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

/**
 * Numeric normalization for arithmetic:
 * - Returns 0 for null/undefined/NaN/non-finite
 * - Prevents NaN from poisoning sums and shares
 */
function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * User-facing label format for CIP2 dropdown.
 * Example: "52 — BUSINESS, MANAGEMENT, MARKETING..."
 */
function cip2OptionLabel(code, title) {
  const c = String(code ?? "").trim();
  const t = String(title ?? "").trim();
  return t ? `${c} — ${t}` : c;
}

// ------------------------------------------------------------
// 3) Load JSON via fetch (async/await)
// ------------------------------------------------------------

/**
 * Load the JSON file from DATA_URL.
 * Supports both payload shapes:
 *  A) bare array: [...]
 *  B) wrapped: { meta: {...}, data: [...] }
 */
async function loadData() {
  const response = await fetch(DATA_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to load JSON: ${response.status} ${response.statusText} (${DATA_URL})`
    );
  }

  const payload = await response.json();

  if (Array.isArray(payload)) {
    return { meta: null, data: payload };
  }

  if (payload && Array.isArray(payload.data)) {
    return payload;
  }

  throw new Error(
    "JSON format not recognized. Expected an array OR an object with a 'data' array."
  );
}

// ------------------------------------------------------------
// 4) Validate expected fields (schema check, not data-quality)
// ------------------------------------------------------------

/**
 * Schema validation: ensures the JSON rows contain the expected keys.
 * If you rename a column in the JSON and forget to update JS, this fails early
 * with a clear error message.
 */
function validateFields(rows) {
  if (!rows.length) throw new Error("No rows found in JSON.");

  const required = [
    "unitId",
    "institution",
    "year",
    "majorNumber",
    "degreeGroup",
    "awardLevel",
    "cipCode",
    "cipTitle",
    "totalCompletions",
  ];

  const sample = rows[0];
  const missing = required.filter((k) => !(k in sample));
  if (missing.length) {
    throw new Error("JSON is missing expected fields: " + missing.join(", "));
  }
}

// ------------------------------------------------------------
// 5) Populate dropdown controls from the data
// ------------------------------------------------------------

/**
 * Populate:
 * - Institution dropdown from unique institutions
 * - Award level dropdown from unique award levels
 * Sets default institution to UIUC if present, otherwise the first institution.
 */
function populateControls(rows) {
  if (!ensureElementExists("institutionSelect", "Institution dropdown")) return;
  if (!ensureElementExists("awardLevelSelect", "Award level dropdown")) return;

  const institutions = [
    ...new Set(rows.map((r) => r.institution).filter(Boolean)),
  ].sort();

  const instSelect = document.getElementById("institutionSelect");
  instSelect.innerHTML = institutions
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
    )
    .join("");

  const awardLevels = [
    ...new Set(rows.map((r) => r.awardLevel).filter(Boolean)),
  ].sort();

  const awardSelect = document.getElementById("awardLevelSelect");
  awardSelect.innerHTML =
    `<option value="All">All</option>` +
    awardLevels
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("");

  const uiuc = "University of Illinois Urbana-Champaign";
  instSelect.value = institutions.includes(uiuc) ? uiuc : institutions[0] || "";
}

/**
 * Populate CIP2 comparison dropdown (#cip2CompareSelect) from unique cipCode values in data.
 *
 * This dropdown controls the second visualization:
 * "What percent of completions are in CIP2 X, by institution?"
 */
function populateCip2CompareControl(rows) {
  if (!ensureElementExists("cip2CompareSelect", "CIP2 comparison dropdown")) {
    return;
  }

  const byCode = new Map(); // cipCode -> cipTitle
  for (const r of rows) {
    const code = r.cipCode;
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, r.cipTitle);
  }

  const options = [...byCode.entries()]
    .map(([code, title]) => ({ code: String(code), title: String(title ?? "") }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const sel = document.getElementById("cip2CompareSelect");
  sel.innerHTML =
    `<option value="">None selected — choose a CIP2 area to compare institutions</option>` +
    options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.code)}">${escapeHtml(
            cip2OptionLabel(o.code, o.title)
          )}</option>`
      )
      .join("");
}

// ------------------------------------------------------------
// 6) Read UI selections
// ------------------------------------------------------------

/**
 * Read current dropdown selections from the page and return as an object.
 */
function getSelections() {
  // Institution is required for treemap; other dropdowns are required for filtering logic.
  if (!ensureElementExists("institutionSelect", "Institution dropdown")) {
    return null;
  }
  if (!ensureElementExists("majorSelect", "Major dropdown")) return null;
  if (!ensureElementExists("degreeGroupSelect", "Degree group dropdown")) {
    return null;
  }
  if (!ensureElementExists("awardLevelSelect", "Award level dropdown")) {
    return null;
  }

  return {
    institution: document.getElementById("institutionSelect").value,
    major: document.getElementById("majorSelect").value, // "First major" | "Second major" | "All"
    degreeGroup: document.getElementById("degreeGroupSelect").value, // "All" or specific group
    awardLevel: document.getElementById("awardLevelSelect").value, // "All" or specific award level
  };
}

// ------------------------------------------------------------
// 7) Filter rows
// ------------------------------------------------------------

/**
 * Filter rows for the treemap (single institution):
 * - institution must match
 * - optionally majorNumber must match (unless "All")
 * - optionally degreeGroup must match (unless "All")
 * - optionally awardLevel must match (unless "All")
 */
function filterRows(rows, sel) {
  return rows.filter((r) => {
    if (r.institution !== sel.institution) return false;

    if (sel.major !== "All") {
      if (r.majorNumber !== sel.major) return false;
    }

    if (sel.degreeGroup !== "All") {
      if (r.degreeGroup !== sel.degreeGroup) return false;
    }

    if (sel.awardLevel !== "All") {
      if (r.awardLevel !== sel.awardLevel) return false;
    }

    return true;
  });
}

/**
 * Filter rows across ALL institutions, applying the SAME non-institution filters.
 * Used for the comparison bar chart.
 *
 * Rationale: We want apples-to-apples comparisons by major/degreeGroup/awardLevel,
 * but we deliberately do NOT filter to one institution.
 */
function filterRowsAllInstitutions(rows, sel) {
  return rows.filter((r) => {
    if (sel.major !== "All") {
      if (r.majorNumber !== sel.major) return false;
    }

    if (sel.degreeGroup !== "All") {
      if (r.degreeGroup !== sel.degreeGroup) return false;
    }

    if (sel.awardLevel !== "All") {
      if (r.awardLevel !== sel.awardLevel) return false;
    }

    return true;
  });
}

// ------------------------------------------------------------
// 8) Aggregation / shaping
// ------------------------------------------------------------

/**
 * Aggregate to CIP2 tiles for the treemap.
 * Output: [{ cipCode, cipTitle, total }]
 *
 * This groups by cipCode and sums totalCompletions.
 */
function aggregateToCip2(rows) {
  const byCip = new Map();

  for (const r of rows) {
    const key = r.cipCode;
    const current = byCip.get(key) || {
      cipCode: r.cipCode,
      cipTitle: r.cipTitle,
      total: 0,
    };

    current.total += safeNumber(r.totalCompletions);
    byCip.set(key, current);
  }

  return [...byCip.values()].sort((a, b) => b.total - a.total);
}

/**
 * Build institution comparison rows for a selected CIP2 code.
 * Input: rows already filtered across all institutions (filterRowsAllInstitutions)
 * Output: one row per institution:
 *   {
 *     institution,
 *     unitId,
 *     denom,      // total completions for institution (in current filter context)
 *     numerator,  // completions for selected cip2
 *     share       // numerator / denom
 *   }
 */
function buildInstitutionComparison(rowsAllInst, selectedCip2) {
  const byInst = new Map(); // institution -> { institution, unitId, denom, numerator }

  for (const r of rowsAllInst) {
    const inst = r.institution || "(Unknown institution)";
    const unitId = r.unitId || "";

    if (!byInst.has(inst)) {
      byInst.set(inst, { institution: inst, unitId, denom: 0, numerator: 0 });
    }
    const rec = byInst.get(inst);

    const completions = safeNumber(r.totalCompletions);
    rec.denom += completions;

    if (String(r.cipCode) === String(selectedCip2)) {
      rec.numerator += completions;
    }
  }

  const out = [...byInst.values()].map((d) => ({
    ...d,
    share: d.denom > 0 ? d.numerator / d.denom : 0,
  }));

  // Sort institutions by share descending for quick “head-to-head” comparisons
  out.sort(
    (a, b) => (b.share - a.share) || a.institution.localeCompare(b.institution)
  );

  return out;
}

// ------------------------------------------------------------
// 9) Rendering (Plotly)
// ------------------------------------------------------------

/**
 * Render Plotly treemap:
 * - Root node is the institution
 * - Children are CIP2 categories sized by completions
 * - Tile labels are shortened; tooltip shows full title + value + share
 */
function renderTreemap(aggRows, sel) {
  if (!ensureElementExists("chart", "Treemap container")) return;

  const root = sel.institution;

  const childLabels = aggRows.map((r) => {
    const shortTitle = makeShortTitle(r.cipTitle, 30);
    return `${r.cipCode} — ${shortTitle}`;
  });

  const labels = [root, ...childLabels];
  const parents = ["", ...aggRows.map(() => root)];
  const values = [0, ...aggRows.map((r) => r.total)];

  const childColors = aggRows.map(
    (r) => cipColorMap.get(String(r.cipCode)) || "#888888"
  );
  const colors = ["#FFFFFF", ...childColors];

  // Store full title in customdata for tooltips
  const customdata = [
    null,
    ...aggRows.map((r) => ({
      cipCode: r.cipCode,
      cipTitle: r.cipTitle,
    })),
  ];

  const trace = {
    type: "treemap",
    labels,
    parents,
    values,
    textinfo: "label+percent parent",
    textfont: { size: 14 },
    marker: { colors, line: { width: 2, color: "#FFFFFF" } },
    customdata,
    hovertemplate:
      "<b>%{customdata.cipTitle}</b><br>" +
      "CIP2: %{customdata.cipCode}<br>" +
      "Completions: %{value:,}<br>" +
      "Share of institution: %{percentParent:.1%}<extra></extra>",
  };

  const layout = {
    font: { size: 14 },
    uniformtext: { minsize: 14, mode: "hide" },
    margin: { t: 20, l: 10, r: 10, b: 10 },
  };

  Plotly.react("chart", [trace], layout, { responsive: true });
}

/**
 * Render institution comparison chart (horizontal bar):
 * - Y: institution
 * - X: share (%) of completions in selected CIP2 for that institution
 * - Hover shows numerator/denom and share
 *
 * Note: The comparisonChart div MUST exist and have a non-zero height in CSS,
 * otherwise Plotly will render into a collapsed container and appear “missing.”
 */
function renderInstitutionComparisonChart(compRows, selectedCip2Label) {
  const elId = "comparisonChart";
  if (!ensureElementExists(elId, "Institution comparison chart container")) {
    return;
  }

  if (!compRows || compRows.length === 0) {
    Plotly.purge(elId);
    return;
  }

  const y = compRows.map((d) => d.institution);
  const x = compRows.map((d) => d.share * 100);

  const customdata = compRows.map((d) => ({
    unitId: d.unitId,
    numerator: d.numerator,
    denom: d.denom,
  }));

  const trace = {
    type: "bar",
    orientation: "h",
    y,
    x,
    customdata,
    hovertemplate:
      "<b>%{y}</b><br>" +
      `CIP2: ${selectedCip2Label}<br>` +
      "CIP2 completions: %{customdata.numerator:,.0f}<br>" +
      "Total completions: %{customdata.denom:,.0f}<br>" +
      "Share: %{x:.2f}%<extra></extra>",
  };

  const layout = {
    title: { text: `CIP2 share by institution — ${selectedCip2Label}` },
    margin: { t: 50, l: 260, r: 30, b: 60 },
    xaxis: {
      title: "Percent of completions",
      ticksuffix: "%",
      rangemode: "tozero",
    },
    yaxis: { automargin: true, autorange: "reversed" },
    height: Math.max(450, 22 * compRows.length + 140),
  };

  Plotly.react(elId, [trace], layout, { responsive: true });
}

// ------------------------------------------------------------
// 10) Controller: selections -> filter -> aggregate -> render
// ------------------------------------------------------------

/**
 * updateViz is the main “controller” function called:
 *  - once on initial load
 *  - whenever a dropdown changes
 *
 * It renders:
 *  - the treemap (always)
 *  - the comparison bar chart (only when cip2CompareSelect has a value)
 */
function updateViz() {
  clearError();

  const sel = getSelections();
  if (!sel) return;

  const cip2SelectEl = document.getElementById("cip2CompareSelect");
  const comparisonEl = document.getElementById("comparisonChart");
  const cip2Sel = cip2SelectEl ? cip2SelectEl.value : "";

  // Helper: show message in comparison area (and fully remove Plotly plot if any)
  function setComparisonMessage(messageHtml) {
    if (!comparisonEl) return;
    Plotly.purge("comparisonChart");
    comparisonEl.innerHTML = messageHtml || "";
  }

  // ----------------------------------------------------------
  // 1) Treemap pipeline (single institution)
  // ----------------------------------------------------------
  const filtered = filterRows(rawRows, sel);

  if (filtered.length === 0) {
    showError("No rows match these selections. Try loosening filters.");
    if (document.getElementById("chart")) Plotly.purge("chart");

    // Keep comparison area informative (do not leave blank)
    if (cip2SelectEl && comparisonEl) {
      if (!cip2Sel) {
        setComparisonMessage(
          "<p class='note'>Select a CIP2 area above to display the institution comparison chart.</p>"
        );
      } else {
        const label =
          cip2SelectEl.selectedOptions?.[0]?.textContent?.trim() || String(cip2Sel);

        setComparisonMessage(
          `<p class='note'>No data matches the current filters. <b>${label}</b> is still selected; loosen filters to update the comparison chart.</p>`
        );
      }
    }
    return;
  }

  const agg = aggregateToCip2(filtered);

  if (agg.length === 0) {
    showError("No CIP2 categories found after filtering.");
    if (document.getElementById("chart")) Plotly.purge("chart");

    if (cip2SelectEl && comparisonEl) {
      if (!cip2Sel) {
        setComparisonMessage(
          "<p class='note'>Select a CIP2 area above to display the institution comparison chart.</p>"
        );
      } else {
        const label =
          cip2SelectEl.selectedOptions?.[0]?.textContent?.trim() || String(cip2Sel);

        setComparisonMessage(
          `<p class='note'>No CIP2 categories exist under the current filters. <b>${label}</b> is still selected; loosen filters to update the comparison chart.</p>`
        );
      }
    }
    return;
  }

  renderTreemap(agg, sel);

  // ----------------------------------------------------------
  // 2) Comparison chart pipeline (optional; all institutions)
  // ----------------------------------------------------------
  // If compare UI not present, treemap still works.
  if (!cip2SelectEl || !comparisonEl) return;

  // No CIP2 selected: show the instructional message.
  if (!cip2Sel) {
    setComparisonMessage(
      "<p class='note'>Select a CIP2 area above to display the institution comparison chart.</p>"
    );
    return;
  }

  // IMPORTANT: Do NOT clear comparisonEl.innerHTML here.
  // If a Plotly chart already exists, clearing innerHTML deletes Plotly’s DOM and breaks updates.

  const rowsAllInst = filterRowsAllInstitutions(rawRows, sel);

  if (!rowsAllInst || rowsAllInst.length === 0) {
    const label =
      cip2SelectEl.selectedOptions?.[0]?.textContent?.trim() || String(cip2Sel);

    setComparisonMessage(
      `<p class='note'>No rows match the current Major/Degree group/Award level filters across institutions. <b>${label}</b> is still selected; loosen filters to see comparisons.</p>`
    );
    return;
  }

  const comp = buildInstitutionComparison(rowsAllInst, cip2Sel);

  if (!comp || comp.length === 0) {
    const label =
      cip2SelectEl.selectedOptions?.[0]?.textContent?.trim() || String(cip2Sel);

    setComparisonMessage(
      `<p class='note'>No comparison data for <b>${label}</b> under the current filters. The CIP2 selection is still active—try loosening Major/Degree group/Award level.</p>`
    );
    return;
  }

  const cip2Label =
    cip2SelectEl.selectedOptions?.[0]?.textContent?.trim() || String(cip2Sel);

  // If the comparison area currently contains a message (because we were in message mode),
  // purge + clear it before plotting. This is safe because we are explicitly transitioning
  // from message -> chart.
  if (comparisonEl.querySelector(".note")) {
    Plotly.purge("comparisonChart");
    comparisonEl.innerHTML = "";
  }

  renderInstitutionComparisonChart(comp, cip2Label);
}



// ------------------------------------------------------------
// 11) Wire UI change events
// ------------------------------------------------------------

/**
 * Attach change handlers to dropdowns so the visuals update immediately.
 * Includes #cip2CompareSelect if present.
 */
function attachEventHandlers() {
  const ids = [
    "institutionSelect",
    "majorSelect",
    "degreeGroupSelect",
    "awardLevelSelect",
    "cip2CompareSelect",
  ];

  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) {
      // Allow “optional” controls without breaking the app
      // (useful during incremental HTML edits).
      continue;
    }
    el.addEventListener("change", updateViz);
  }
}

// ------------------------------------------------------------
// 12) App entrypoint
// ------------------------------------------------------------

async function main() {
  try {
    rawPayload = await loadData();
    rawRows = rawPayload.data;

    console.log("Rows loaded:", rawRows.length);
    console.log("Sample row:", rawRows[0]);

    validateFields(rawRows);

    // Build stable color mapping
    cipColorMap = buildCipColorMap(rawRows);

    // Populate dropdowns
    populateControls(rawRows);
    populateCip2CompareControl(rawRows);

    // Wire events
    attachEventHandlers();

    // Debug: log CIP2->color mapping (useful for documentation)
    console.table(
      [...cipColorMap.entries()].map(([cipCode, color]) => ({ cipCode, color }))
    );

    // Methodology note (optional)
    const noteEl = document.getElementById("note");
    if (noteEl) {
      if (rawPayload.meta && rawPayload.meta.methodology_note) {
        noteEl.textContent = rawPayload.meta.methodology_note;
      } else {
        noteEl.textContent = "";
      }
    }

    updateViz(); // initial render
  } catch (err) {
    showError(err.message);
    console.error(err);
  }
}

main();
