// ----- 1. "Data" (pretend this came from Python) -----
// Array of objects: {year, dept, headcount}
const data = [
  { year: 2019, dept: "MATH", headcount: 120 },
  { year: 2020, dept: "MATH", headcount: 135 },
  { year: 2021, dept: "MATH", headcount: 150 },
  { year: 2022, dept: "MATH", headcount: 142 },

  { year: 2019, dept: "ENG", headcount: 80 },
  { year: 2020, dept: "ENG", headcount: 95 },
  { year: 2021, dept: "ENG", headcount: 110 },
  { year: 2022, dept: "ENG", headcount: 105 },

  { year: 2019, dept: "BIO", headcount: 60 },
  { year: 2020, dept: "BIO", headcount: 70 },
  { year: 2021, dept: "BIO", headcount: 85 },
  { year: 2022, dept: "BIO", headcount: 90 }
];

// Utility: get unique list of departments
function getDepartments(data) {
  const depts = new Set(data.map(d => d.dept));
  return Array.from(depts).sort();
}

// ----- 2. DOM references -----
const deptSelect = document.getElementById("deptSelect");
const chartDiv = document.getElementById("chart");

// ----- 3. Populate the dropdown -----
function populateDeptOptions() {
  const depts = getDepartments(data);

  // Option for "All"
  const allOption = document.createElement("option");
  allOption.value = "ALL";
  allOption.textContent = "All Departments";
  deptSelect.appendChild(allOption);

  // One option per department
  depts.forEach(dept => {
    const opt = document.createElement("option");
    opt.value = dept;
    opt.textContent = dept;
    deptSelect.appendChild(opt);
  });

  // default selection
  deptSelect.value = "ALL";
}

// ----- 4. Build chart for a selected department -----
function makeChart(selectedDept) {
  // Filter data
  let filtered;
  if (selectedDept === "ALL") {
    filtered = data; // keep everything
  } else {
    filtered = data.filter(d => d.dept === selectedDept);
  }

  // Group by department (in case ALL)
  const deptGroups = {};
  filtered.forEach(d => {
    if (!deptGroups[d.dept]) {
      deptGroups[d.dept] = { x: [], y: [] };
    }
    deptGroups[d.dept].x.push(d.year);
    deptGroups[d.dept].y.push(d.headcount);
  });

  // Build traces for Plotly
  const traces = Object.keys(deptGroups).map(dept => ({
    x: deptGroups[dept].x,
    y: deptGroups[dept].y,
    type: "scatter",
    mode: "lines+markers",
    name: dept
  }));

  const layout = {
    title:
      selectedDept === "ALL"
        ? "Enrollment by Department"
        : `Enrollment: ${selectedDept}`,
    xaxis: { title: "Year" },
    yaxis: { title: "Headcount" }
  };

  Plotly.newPlot(chartDiv, traces, layout, { responsive: true });
}

// ----- 5. Wire up events -----
function init() {
  populateDeptOptions();
  makeChart("ALL");

  deptSelect.addEventListener("change", event => {
    const value = event.target.value;
    makeChart(value);
  });
}

// Run init when script is loaded
init();
