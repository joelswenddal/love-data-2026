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
//    - Uses the selected CIP2 from dropdown OR treemap click (shared state)
//    - Applies the same filters as treemap EXCEPT Institution (all institutions included)
//    - For each institution:
//        numerator = completions for selected CIP2
//        denom     = completions across all CIP2 (in current filter context)
//        share     = numerator / denom
//    - Renders a horizontal bar chart sorted by share descending
//
// ------------------------------------------------------------
// Key interaction design
// ------------------------------------------------------------
// - Dropdown and treemap click are interchangeable for selecting CIP2.
// - Clicking a treemap tile should drill down (Plotly default behavior).
//   Therefore, treemap click handlers update ONLY the comparison chart
//   (they do NOT re-render the treemap, which would disrupt drilldown).
// - When the treemap is reset to root ("back" / root change / double-click),
//   the CIP2 selection clears, the dropdown resets, and the bar chart clears.
//
// ------------------------------------------------------------
// 0) Config + in-memory state
// ------------------------------------------------------------
const DATA_URL = "./data/processed/ipeds/big10_cip2_2024_treemap.json";

let rawPayload = null; // parsed JSON response; { meta: {...}, data: [...] } OR { meta:null, data:[...] }
let rawRows = []; // array of row objects

// ------------------------------------------------------------
// Shared state: selected CIP2 for institution comparison
// ------------------------------------------------------------
let selectedCip2 = ""; // "" means no selection

function setSelectedCip2(code) {
  selectedCip2 = code ? String(code) : "";

  // Keep the dropdown in sync (if present)
  const dd = document.getElementById("cip2CompareSelect");
  if (dd) dd.value = selectedCip2;
}

function clearSelectedCip2() {
  setSelectedCip2("");
}

// ------------------------------------------------------------
// 1) Color palette + deterministic CIP2->color mapping
// ------------------------------------------------------------

// Softened, colorblind-conscious categorical palette
const CIP_PALETTE = [
  "#2C6DA4", // softened blue
  "#C9891A", // softened orange
  "#2A8C6B", // softened green
  "#B5533C", // softened vermillion
  "#B07AA1", // softened purple/pink
  "#6BAED6", // softened sky blue
  "#C9BE6B", // softened yellow/khaki
  "#3B3B8F", // softened indigo
  "#9CCFE3", // softened light blue
  "#4FA59A", // softened teal
  "#2B7A4B", // softened dark green
  "#8A8A3A", // softened olive
  "#D8C77A", // softened sand
  "#B97A89", // softened rose
  "#7B2A44", // softened wine
  "#8F4A9A", // softened violet
  "#9A9A9A", // neutral grey

  // --- NEW additions ---
  "#5C7F8A", // muted steel blue
  "#8B6D3A", // muted brown/gold
  "#6B8E5A", // muted moss green
  "#7A6F9B", // muted lavender-indigo
  "#A68C8A", // muted warm taupe
  "#5F5F5F", // dark neutral grey
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
function makeShortTitle(title, maxLen = 50) {
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
 * Populate CIP2 comparison dropdown (#cip2CompareSelect) from unique cipCode values.
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
 * Input: rows already filtered across all institutions
 * Output: one row per institution with numerator/denom/share.
 */
function buildInstitutionComparison(rowsAllInst, selectedCip2Code) {
  const byInst = new Map();

  for (const r of rowsAllInst) {
    const inst = r.institution || "(Unknown institution)";
    const unitId = r.unitId || "";

    if (!byInst.has(inst)) {
      byInst.set(inst, { institution: inst, unitId, denom: 0, numerator: 0 });
    }
    const rec = byInst.get(inst);

    const completions = safeNumber(r.totalCompletions);
    rec.denom += completions;

    if (String(r.cipCode) === String(selectedCip2Code)) {
      rec.numerator += completions;
    }
  }

  const out = [...byInst.values()].map((d) => ({
    ...d,
    share: d.denom > 0 ? d.numerator / d.denom : 0,
  }));

  out.sort(
    (a, b) => (b.share - a.share) || a.institution.localeCompare(b.institution)
  );

  return out;
}

// ------------------------------------------------------------
// 9) Rendering (Plotly)
// ------------------------------------------------------------

/**
 * Render the treemap in div#chart.
 * Input: aggregated rows [{ cipCode, cipTitle, total }], selections
 * Uses cipColorMap for stable colors.
 * Includes filter context in hover tooltip.
 * Uses customdata to store full cipTitle for tooltips and click handling.
 * Renders via Plotly.react for efficient updates.
 * Clears previous error messages on success.
  */

function renderTreemap(aggRows, sel) {
  if (!ensureElementExists("chart", "Treemap container")) return;

  const root = sel.institution;

  const childLabels = aggRows.map((r) => {
    const shortTitle = makeShortTitle(r.cipTitle, 30);
    return shortTitle;
  });

  const labels = [root, ...childLabels];
  const parents = ["", ...aggRows.map(() => root)];
  const values = [0, ...aggRows.map((r) => r.total)];

  const childColors = aggRows.map(
    (r) => cipColorMap.get(String(r.cipCode)) || "#888888"
  );
  const colors = ["#FFFFFF", ...childColors];

  // Store full title in customdata for tooltips and click handling
  const customdata = [
    null,
    ...aggRows.map((r) => ({
      cipCode: r.cipCode,
      cipTitle: r.cipTitle,
    })),
  ];

  // ------------------------------------------------------------
  // NEW: build filter context for hover tooltip
  // ------------------------------------------------------------

  function formatFilterLabel(label, value) {
    return value && value !== "All" ? `${label}: ${value}` : null;
  }

  const filterLines = [
    formatFilterLabel("Major", sel.major),
    formatFilterLabel("Degree group", sel.degreeGroup),
    formatFilterLabel("Award level", sel.awardLevel),
  ].filter(Boolean);

  const filterContextHtml =
  filterLines.length > 0
    ? "<br><br><span style='font-size:11px'>" +
        "<i>Filters:</i><br>" +
        filterLines.join("<br>") +
      "</span>"
    : "";


  // ------------------------------------------------------------
  // Treemap trace
  // ------------------------------------------------------------
  const trace = {
    type: "treemap",
    labels,
    parents,
    values,
    textinfo: "label+percent parent",
    textfont: { size: 12 },

    marker: { colors, line: { width: 2, color: "#FFFFFF" } },
    customdata,
    hovertemplate:
      "<b>%{customdata.cipTitle}</b><br>" +
      "CIP2 Code: %{customdata.cipCode}<br>" +
      "Completions: %{value:,}<br>" +
      "Share of institution: %{percentParent:.1%}" +
      filterContextHtml +
      "<extra></extra>",
  };

  const layout = {
    font: { size: 12 },
    uniformtext: { minsize: 12, mode: "hide" },
    margin: { t: 20, l: 10, r: 10, b: 10 },
  };

  Plotly.react("chart", [trace], layout, { responsive: true });

  // IMPORTANT: Plotly.react can drop listeners in some updates, so rebind after render.
  attachTreemapInteractionHandlers();

}

// ------------------------------------------------------------
// 9b) Rendering: Institution comparison bar chart (Plotly)
// ------------------------------------------------------------

/**
 * Render the institution comparison chart in div#comparisonChart.
 *
 * Inputs:
 *  - compRows: array of { institution, unitId, denom, numerator, share }
 *      share is 0–1; we display it as percent.
 *  - selectedCip2Label: user-facing label for the chosen CIP2 (e.g., "42 — PSYCHOLOGY")
 *
 * Behavior:
 *  - If compRows is empty, the chart is purged (cleared).
 *  - Chart is a horizontal bar chart, sorted by share descending (your build function already sorts).
 *  - Hover shows numerator, denominator, and percent share.
 *
 * Requirements:
 *  - index.html must contain <div id="comparisonChart"></div>
 *  - That div must have a non-zero height (CSS), otherwise it will appear “missing.”
 */
function renderInstitutionComparisonChart(compRows, selectedCip2Code, selectedCip2Label, sel) {
  const elId = "comparisonChart";

  if (!ensureElementExists(elId, "Institution comparison chart container")) {
    return;
  }

  // If no rows, clear the chart and exit
  if (!compRows || compRows.length === 0) {
    Plotly.purge(elId);
    return;
  }

  const barColor = cipColorMap.get(String(selectedCip2Code)) || "#1f77b4"; // Plotly default fallback

  const y = compRows.map((d) => d.institution);
  const x = compRows.map((d) => (safeNumber(d.share) * 100)); // percent

  const customdata = compRows.map((d) => ({
    unitId: d.unitId,
    numerator: safeNumber(d.numerator),
    denom: safeNumber(d.denom),
  }));

  function formatFilterLabel(label, value) {
    return value && value !== "All" ? `${label}: ${value}` : null;
  }

  const filterLines = [
    formatFilterLabel("Major", sel?.major),
    formatFilterLabel("Degree group", sel?.degreeGroup),
    formatFilterLabel("Award level", sel?.awardLevel),
  ].filter(Boolean);

  const filterContextHtml =
    filterLines.length > 0
      ? "<br><br><span style='font-size:11px;color:#666'>" +
          "<i>Filters:</i><br>" +
          filterLines.join("<br>") +
        "</span>"
      : "";


  const trace = {
    type: "bar",
    orientation: "h",
    y,
    x,
    customdata,
    marker: { color: barColor },

    // Bar color is set to match the selected CIP2 color in the treemap.
    
    hovertemplate:
      "<b>%{y}</b><br>" +
      `CIP2: ${selectedCip2Label}<br>` +
      "CIP2 completions: %{customdata.numerator:,.0f}<br>" +
      "Total completions: %{customdata.denom:,.0f}<br>" +
      "Share: %{x:.2f}%" +
      filterContextHtml +
      "<extra></extra>",
  };
  
  const layout = {
    title: { text: `CIP2 share by institution — ${selectedCip2Label}` },
    margin: { t: 50, l: 300, r: 30, b: 60 },
    xaxis: {
      title: "Percent of completions",
      ticksuffix: "%",
      rangemode: "tozero",
    },
    yaxis: {
      automargin: true,
      autorange: "reversed", // highest share at top
    },

    // Scale height to number of institutions (keeps labels readable)
    height: Math.max(450, 22 * compRows.length + 140),
  };

  Plotly.react(elId, [trace], layout, { responsive: true });
}




// ------------------------------------------------------------
// 10) Comparison-only controller
// ------------------------------------------------------------

/**
 * Update ONLY the comparison chart and dropdown synchronization.
 * This is used for treemap click/drill interactions to avoid breaking Plotly drilldown.
 */
function updateComparisonOnly() {
  const sel = getSelections();
  if (!sel) return;

  const cip2SelectEl = document.getElementById("cip2CompareSelect");
  const comparisonEl = document.getElementById("comparisonChart");
  if (!cip2SelectEl || !comparisonEl) return;

  const cip2Sel = selectedCip2 || cip2SelectEl.value || "";

  // Keep dropdown synced to shared state
  if (selectedCip2 && cip2SelectEl.value !== String(selectedCip2)) {
    cip2SelectEl.value = String(selectedCip2);
  }

  function setComparisonMessage(messageHtml) {
    Plotly.purge("comparisonChart");
    comparisonEl.innerHTML = messageHtml || "";
  }

  if (!cip2Sel) {
    setComparisonMessage(
      "<p class='note'>Select a CIP2 area above to display the institution comparison chart.</p>"
    );
    return;
  }

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

  // If currently in message mode, purge + clear before plotting.
  if (comparisonEl.querySelector(".note")) {
    Plotly.purge("comparisonChart");
    comparisonEl.innerHTML = "";
  }

  renderInstitutionComparisonChart(comp, cip2Sel, cip2Label, sel);

}

// ------------------------------------------------------------
// 11) Main controller: selections -> filter -> aggregate -> render
// ------------------------------------------------------------

/**
 * updateViz is the main controller used for standard filter changes.
 * It renders the treemap and then updates the comparison (if selected).
 */
function updateViz() {
  clearError();

  const sel = getSelections();
  if (!sel) return;

  // Treemap pipeline
  const filtered = filterRows(rawRows, sel);

  if (filtered.length === 0) {
    showError("No rows match these selections. Try loosening filters.");
    if (document.getElementById("chart")) Plotly.purge("chart");

    // Keep comparison area informative
    updateComparisonOnly();
    return;
  }

  const agg = aggregateToCip2(filtered);

  if (agg.length === 0) {
    showError("No CIP2 categories found after filtering.");
    if (document.getElementById("chart")) Plotly.purge("chart");

    updateComparisonOnly();
    return;
  }

  renderTreemap(agg, sel);

  // Comparison pipeline (uses shared state / dropdown)
  updateComparisonOnly();
}

// ------------------------------------------------------------
// 12) Wire UI change events
// ------------------------------------------------------------

/**
 * Attach change handlers to dropdowns so visuals update immediately.
 * Dropdown change updates shared state for CIP2.
 */
function attachEventHandlers() {
  const ids = [
    "institutionSelect",
    "majorSelect",
    "degreeGroupSelect",
    "awardLevelSelect",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", updateViz);
  }

  const cip2El = document.getElementById("cip2CompareSelect");
  if (cip2El) {
    cip2El.addEventListener("change", () => {
      setSelectedCip2(cip2El.value);
      updateViz();
    });
  }
}

// ------------------------------------------------------------
// 13) Treemap interaction handlers (click/drill/reset)
// ------------------------------------------------------------

/**
 * (Re)attach Plotly event handlers for the treemap (id="chart").
 *
 * Why "reattach"?
 * Plotly.react(...) can rebuild internal graph state, which may drop event listeners
 * in some update scenarios. Calling this after each treemap render ensures:
 *  - Treemap click always toggles CIP2 selection
 *  - Dropdown stays in sync
 *  - Comparison chart updates without interrupting Plotly drilldown
 *
 * Behavior:
 *  - plotly_click on CIP2 tile toggles selection and updates comparison only
 *  - plotly_treemaproot clears selection and updates comparison only
 *  - plotly_doubleclick clears selection and updates comparison only
 */
function attachTreemapInteractionHandlers() {
  const chartEl = document.getElementById("chart");
  if (!chartEl) return;

  // Remove existing listeners to prevent duplicate firing
  if (typeof chartEl.removeAllListeners === "function") {
    chartEl.removeAllListeners("plotly_click");
    chartEl.removeAllListeners("plotly_treemaproot");
    chartEl.removeAllListeners("plotly_doubleclick");
  }

  chartEl.on("plotly_click", (ev) => {
    const pt = ev?.points?.[0];
    const cip2 = pt?.customdata?.cipCode;

    // Ignore clicks that aren't CIP2 tiles (root has customdata = null)
    if (!cip2) return;

    // Always select (do NOT toggle off on same click)
    setSelectedCip2(String(cip2));

    // Update comparison only; preserve Plotly drilldown behavior
    updateComparisonOnly();
  });

/**
  chartEl.on("plotly_click", (ev) => {
    const pt = ev?.points?.[0];
    const cip2 = pt?.customdata?.cipCode;

    // Ignore clicks that aren't CIP2 tiles (root has customdata = null)
    if (!cip2) return;

    const clicked = String(cip2);
    const current = String(selectedCip2 || "");

    if (clicked === current) {
      clearSelectedCip2();
    } else {
      setSelectedCip2(clicked);
    }

    updateComparisonOnly();
  });
*/
  chartEl.on("plotly_treemaproot", () => {
    clearSelectedCip2();
    updateComparisonOnly();
  });

  chartEl.on("plotly_doubleclick", () => {
    clearSelectedCip2();
    updateComparisonOnly();
  });
}



// ------------------------------------------------------------
// 14) App entrypoint
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
    attachTreemapInteractionHandlers(); // wire treemap click/drill events
  } catch (err) {
    showError(err.message);
    console.error(err);
  }
}

main();
