// app.js

// Columns: ['unitId', 'institution', 'year', 'majorNumber', 'cipCode', 'cipTitle', 'awardLevel', 'totalCompletions', 'indexCode', 'degreeGroup']

// js/app.js

// ------------------------------------------------------------
// 0) Config: JSON location relative to index.html (repo root)
// ------------------------------------------------------------
const DATA_URL = "./data/processed/ipeds/big10_cip2_2024_treemap.json";

// In-memory storage after load
let rawPayload = null; // the parsed JSON response; structure: { meta: {...}, data: [...] } OR { meta:null, data:[...] }
let rawRows = []; // array of row objects

// ------------------------------------------------------------
// Color palette + deterministic CIP2->color mapping
// ------------------------------------------------------------

// Okabe-Ito + a few additional distinct hues (generally colorblind-friendly)
// We'll cycle if you have more codes than colors.
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
 * Sorting ensures "11" always gets the same color across sessions.
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
// 1) Helpers: error display + HTML escaping
// ------------------------------------------------------------

// provide user-friendly errors on the page (instead of silently failing).
function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.style.display = "block";
}

function clearError() {
  const el = document.getElementById("error");
  el.textContent = "";
  el.style.display = "none";
}

// Minimal HTML escaping so option labels/values don't break HTML
//  prevents dropdown options from breaking HTML if a value contains quotes or special chars.
//  Why this matters: https://stackoverflow.com/a/6234804
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Shorten a title to a maximum length, adding ellipsis if needed.
// avoids ugly mid-word truncation most of the time, but still guarantees a hard cap.
function makeShortTitle(title, maxLen = 32) {
  if (!title) return "";
  const t = String(title).trim();

  // If it's already short, keep it
  if (t.length <= maxLen) return t;

  // Cut at a word boundary when possible
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.6)) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

// ------------------------------------------------------------
// 2) Load JSON via fetch (async/await) - retrieves JSON over HTTP
//
//   If fetch fails you’ll see:
//      - a network error in DevTools → Network
//      - and your page error message from showError(...)
// ------------------------------------------------------------
async function loadData() {
  const response = await fetch(DATA_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to load JSON: ${response.status} ${response.statusText} (${DATA_URL})`
    );
  }

  const payload = await response.json();

  // Support both:
  // A) bare array: [...]
  // B) wrapped: { meta: {...}, data: [...] }
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
// 3) Validate expected fields (schema check, not data-quality)
//    - If you rename a column in your JSON and forget to update JS,
//      this fails immediately with a clear error.
// ------------------------------------------------------------
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
// 4) Populate dropdown controls from the data
//  Builds the institution list and award levels from the actual data.
//    - Uses Set(...) to get uniques, then sorts them.
//    - Sets a default institution (UIUC if present).
// ------------------------------------------------------------
function populateControls(rows) {
  // Institution dropdown
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

  // Award level dropdown
  const awardLevels = [
    ...new Set(rows.map((r) => r.awardLevel).filter(Boolean)),
  ].sort();
  const awardSelect = document.getElementById("awardLevelSelect");
  awardSelect.innerHTML =
    `<option value="All">All</option>` +
    awardLevels
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("");

  // Default institution: UIUC if present, else first institution
  const uiuc = "University of Illinois Urbana-Champaign";
  instSelect.value = institutions.includes(uiuc) ? uiuc : institutions[0] || "";
}

// ------------------------------------------------------------
// 5) Read UI selections
//   Returns an object with the current selections
//   A small “adapter” that reads the current dropdown values
//   and returns them as an object.
// ------------------------------------------------------------
function getSelections() {
  return {
    institution: document.getElementById("institutionSelect").value,
    major: document.getElementById("majorSelect").value, // "First major" | "Second major" | "All"
    degreeGroup: document.getElementById("degreeGroupSelect").value, // "All" or specific group
    awardLevel: document.getElementById("awardLevelSelect").value, // "All" or specific award level
  };
}

// ------------------------------------------------------------
// 6) Filter rows based on selections
//  Returns filtered array of rows
//  This applies your current state:
//    - match institution
//    - optionally match majorNumber (unless “All”)
//    - optionally match degreeGroup and awardLevel

// ------------------------------------------------------------
function filterRows(rows, sel) {
  return rows.filter((r) => {
    if (r.institution !== sel.institution) return false;

    // Major filter
    if (sel.major !== "All") {
      if (r.majorNumber !== sel.major) return false;
    }

    // Degree group filter
    if (sel.degreeGroup !== "All") {
      if (r.degreeGroup !== sel.degreeGroup) return false;
    }

    // Award level filter
    if (sel.awardLevel !== "All") {
      if (r.awardLevel !== sel.awardLevel) return false;
    }

    return true;
  });
}

// ------------------------------------------------------------
// 7) Aggregate for treemap (CIP2 tiles)
//    Output: [{ cipCode, cipTitle, total }]
//    This groups by cipCode and sums totalCompletions.
// ------------------------------------------------------------
function aggregateToCip2(rows) {
  const byCip = new Map();

  for (const r of rows) {
    const key = r.cipCode; // CIP2 code
    const current = byCip.get(key) || {
      cipCode: r.cipCode,
      cipTitle: r.cipTitle,
      total: 0,
    };

    // Ensure numeric addition
    current.total += Number(r.totalCompletions) || 0;
    byCip.set(key, current);
  }

  return [...byCip.values()].sort((a, b) => b.total - a.total);
}

// ------------------------------------------------------------
// 8) Render Plotly treemap
//  Plotly expects:
//      labels: text shown on tiles
//      parents: hierarchy (we have a 1-level hierarchy: Institution → CIP2)
//      values: sizes
//  Then Plotly.react(...) draws or updates the chart
//  Why React instead of newPlot: it updates efficiently and feels more “app-like”.
// ------------------------------------------------------------

function renderTreemap(aggRows, sel) {
  const root = sel.institution;

  // --- 1) Labels (Code + Short Title in the tile)
  const childLabels = aggRows.map((r) => {
    const shortTitle = makeShortTitle(r.cipTitle, 30);
    return `${r.cipCode} — ${shortTitle}`;
  });

  const labels = [root, ...childLabels];
  const parents = ["", ...aggRows.map(() => root)];
  const values = [0, ...aggRows.map((r) => r.total)];

  // --- 2) Colors (stable by CIP2 code)
  const childColors = aggRows.map(
    (r) => cipColorMap.get(String(r.cipCode)) || "#888888"
  );
  const colors = ["#FFFFFF", ...childColors];

  // --- 3) Tooltip: show FULL title no matter what is in the label
  // We store full title in customdata so hover is clean and consistent.
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

    // Show text in tiles when there’s room; layout.uniformtext will hide when too small
    textinfo: "label+percent parent",
    textfont: { size: 14 },

    marker: {
      colors,
      line: { width: 2, color: "#FFFFFF" },
    },

    customdata,

    hovertemplate:
      "<b>%{customdata.cipTitle}</b><br>" +
      "CIP2: %{customdata.cipCode}<br>" +
      "Completions: %{value:,}<br>" +
      "Share of institution: %{percentParent:.1%}<extra></extra>",
  };

  const layout = {
    font: { size: 14 }, // global default for chart text
    uniformtext: { minsize: 14, mode: "hide" },
    margin: { t: 20, l: 10, r: 10, b: 10 },
  };

  Plotly.react("chart", [trace], layout, { responsive: true });
}

// ------------------------------------------------------------
// 9) Update pipeline: selections -> filter -> aggregate -> render
//  This is the “controller” function:
//    1. read UI selections
//    2. filter rows
//    3. aggregate
//    4. render
//  It’s called:
//    1. once on initial load
//    2. whenever a dropdown changes
// ------------------------------------------------------------
function updateViz() {
  clearError();

  const sel = getSelections();
  const filtered = filterRows(rawRows, sel);

  if (filtered.length === 0) {
    showError("No rows match these selections. Try loosening filters.");
    Plotly.purge("chart");
    return;
  }

  const agg = aggregateToCip2(filtered);

  if (agg.length === 0) {
    showError("No CIP2 categories found after filtering.");
    Plotly.purge("chart");
    return;
  }

  renderTreemap(agg, sel);
}

// ------------------------------------------------------------
// 10) Wire UI change events
//  Whenever a dropdown changes, re-run updateViz()
//  Adds "change" listeners to the dropdowns so that the moment you change a selection, it re-renders.
// ------------------------------------------------------------
function attachEventHandlers() {
  const ids = [
    "institutionSelect",
    "majorSelect",
    "degreeGroupSelect",
    "awardLevelSelect",
  ];
  for (const id of ids) {
    document.getElementById(id).addEventListener("change", updateViz);
  }
}

// ------------------------------------------------------------
// 11) App entrypoint
// ------------------------------------------------------------
async function main() {
  try {
    rawPayload = await loadData();
    rawRows = rawPayload.data;

    console.log("Rows loaded:", rawRows.length);
    console.log("Sample row:", rawRows[0]);

    validateFields(rawRows);
    cipColorMap = buildCipColorMap(rawRows);
    populateControls(rawRows);
    attachEventHandlers();

    // Debug: log CIP2->color mapping
    //  to view the explicit mapping (for documentation)
    console.table(
      [...cipColorMap.entries()].map(([cipCode, color]) => ({ cipCode, color }))
    );

    // Add methodology note if present in meta
    const noteEl = document.getElementById("note");
    if (rawPayload.meta && rawPayload.meta.methodology_note) {
      noteEl.textContent = rawPayload.meta.methodology_note;
    } else {
      noteEl.textContent = "";
    }

    updateViz(); // initial render
  } catch (err) {
    showError(err.message);
    console.error(err);
  }
}

main();
