# Big Ten Degree Completions – Research Dataset (IPEDS)

## Overview

This dataset contains **IPEDS Completions data for Big Ten institutions**, cleaned, standardized, and enriched for use in exploratory analysis and public-facing visualizations (e.g., Love Data Week submissions).

It is designed to support **discipline-level comparisons of degree production across institutions**, while remaining transparent, reproducible, and fully compliant with public data policies.

The file serves as the **authoritative, research-ready base table** from which visualization-specific or aggregated datasets may be derived.

---

## Data Source

- **Source**: Integrated Postsecondary Education Data System (IPEDS)
- **Survey**: Completions
- **CIP Taxonomy**: NCES CIP 2020
- **Access**: Publicly available (no restricted or sensitive data)

---

## Institutional Scope

- Includes **18 Big Ten institutions** (flagship campuses only).
- Institutions are identified using:
  - `unitid` (IPEDS institutional identifier)
  - `institution` (official institution name)
- All institutions are members of the Big Ten Conference during the reporting period.

---

## Academic Scope

- **Major Number**:
  - Includes **Major 1 only** (primary field of study).
- **Award Levels Included**:
  - Bachelor’s degrees
  - Graduate degrees (Master’s and Doctoral)

Award level codes are mapped to readable labels and grouped for analysis.

---

## CIP (Classification of Instructional Programs)

The dataset includes CIP information at **two hierarchical levels**.

### CIP2 – Discipline Level (Primary Analytical Dimension)

- `cip2` represents the **2-digit CIP family**, corresponding to broad academic disciplines.
- `cip2_title` provides the **official discipline name** from the NCES CIP 2020 taxonomy.
- All CIP2 values are explicitly labeled.
- CIP2 value `99` is retained and labeled as:

  **“99 – Unclassified / Not in CIP taxonomy”**

This ensures:

- No silent category loss
- Transparent handling of reporting or classification artifacts

CIP2 is the intended primary categorical dimension for visualizations such as treemaps.

---

### CIP6 – Program Level (Secondary / Descriptive)

- `cipcode` represents the full **6-digit CIP program code** (`NN.NNNN`).
- `cip6_title` is populated **only when the code corresponds to a true CIP6 instructional program**.
- Rows that do not correspond to a valid CIP6 program (e.g., aggregates, placeholders) are explicitly labeled as:

  **“Not a CIP6 program (aggregate / unclassified)”**

- `is_cip6` is a boolean flag indicating whether the row corresponds to a valid CIP6 program.

CIP6 data is retained for:

- Optional drill-downs
- Tooltips or descriptive context
- Future program-level analyses

CIP6 is **not required** for the primary visualization use case.

---

## Measures

- `award_count_total`
  - Total number of degrees awarded for the given institution, discipline/program, and award level.
  - Derived directly from IPEDS Completions data.
  - Non-negative integer values.

---

## Data Quality and Design Guarantees

At the time of export, this dataset guarantees:

- Exactly **18 Big Ten institutions**
- No missing institutional identifiers
- No unlabeled CIP2 disciplines
- Explicit handling of unclassified or aggregate categories
- Clear distinction between discipline-level and program-level data
- No personally identifiable information (PII)
- Fully public, shareable data suitable for unrestricted publication

---

## Intended Use

This dataset is intended as a **research-ready source table** for:

- Interactive visualizations (e.g., Plotly treemaps)
- Discipline-level degree distribution analysis
- Public-facing, no-login-required data projects

Visualization-specific or aggregated datasets may be derived from this file, but this file should be treated as the **canonical cleaned dataset** for the project.

---

## File

- `research_bigten_completions_2024.csv`
