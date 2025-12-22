#!/usr/bin/env python3
"""
Build Big Ten IPEDS Completions "research" dataset (clean + joined + ready for viz).

Inputs (default relative to this script's location when run from /scripts or similar):
- data/raw/ipeds/C2024_A.csv        (IPEDS Completions, 2024 "Complete Data File" part A)
- data/raw/ipeds/HD2024.csv         (IPEDS Header / Directory, for institution names)
- data/raw/ipeds/CIPCode2020.csv    (NCES CIP 2020 taxonomy)

Output:
- data/processed/ipeds/research_bigten_completions_2024.csv

Notes:
- Keeps Major 1 only in downstream steps if desired, but this script writes the Big Ten base
  with CIP2 + CIP6 titles and award-level labels so you can aggregate as needed.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re

import numpy as np
import pandas as pd


# Big Ten flagship campuses (UNITID) — as used in this project.
BIGTEN_UNITIDS = [
    151351,  # Indiana University-Bloomington
    171100,  # Michigan State University
    147767,  # Northwestern University
    204796,  # Ohio State University-Main Campus
    214777,  # Pennsylvania State University-Main Campus
    243780,  # Purdue University-Main Campus
    186380,  # Rutgers University-New Brunswick
    110662,  # University of California-Los Angeles (UCLA)
    145637,  # University of Illinois Urbana-Champaign
    153658,  # University of Iowa
    163286,  # University of Maryland-College Park
    170976,  # University of Michigan-Ann Arbor
    174066,  # University of Minnesota-Twin Cities
    181464,  # University of Nebraska-Lincoln
    209551,  # University of Oregon
    123961,  # University of Southern California
    236948,  # University of Washington-Seattle Campus
    240444,  # University of Wisconsin-Madison
]


def load_bigten_unitids(path):
    """
    Load Big Ten UNITIDs from a CSV (preferred for reproducibility) if provided and exists.
    Expected columns: UNITID (or unitid). Falls back to the embedded BIGTEN_UNITIDS list.
    """
    if path is None:
        return BIGTEN_UNITIDS

    path = Path(path)
    if not path.exists():
        return BIGTEN_UNITIDS

    df_ids = pd.read_csv(path, low_memory=False)
    if "UNITID" in df_ids.columns:
        col = "UNITID"
    elif "unitid" in df_ids.columns:
        col = "unitid"
    else:
        raise ValueError(f"Big Ten UNITID file missing UNITID column: {df_ids.columns.tolist()}")

    unitids = pd.to_numeric(df_ids[col], errors="coerce").dropna().astype(int).tolist()
    return unitids if unitids else BIGTEN_UNITIDS


def format_cipcode(val):
    """
    Normalize CIPCODE to canonical CIP6-ish string form 'NN.NNNN'.
    Examples:
      3.0104  -> '03.0104'
      '03.0104' -> '03.0104'
    """
    if pd.isna(val):
        return None

    s = str(val).strip()
    if s == "" or s.lower() == "nan":
        return None

    # Try numeric formatting first (handles floats like 3.0104).
    try:
        f = float(s)
        s = f"{f:.4f}"
    except (ValueError, TypeError):
        pass

    left, *rest = s.split(".", 1)
    left = left.zfill(2)
    if rest:
        right = (rest[0] + "0000")[:4]
        return f"{left}.{right}"
    return left


def clean_excel_text_wrapper(series: pd.Series) -> pd.Series:
    """
    Remove publisher "Excel-safe" wrapper like =\"01.0101\" from CSV fields.
    """
    return (
        series.astype("string")
        .str.strip()
        .str.replace(r'^="?|"$', "", regex=True)
        .str.strip()
    )


def build(args: argparse.Namespace) -> Path:
    completions_path = args.completions_path
    hd_path = args.hd_path
    cip_path = args.cip_path
    out_path = args.out_path

    # --- Load raw data ---
    df = pd.read_csv(completions_path, low_memory=False)
    hd = pd.read_csv(hd_path, low_memory=False)
    cip_raw = pd.read_csv(cip_path, low_memory=False)

    # --- Bring institution names onto completions via UNITID ---
    # HD file contains UNITID + INSTNM (among many fields).
    hd_names = hd[["UNITID", "INSTNM"]].drop_duplicates()
    df_with_names = df.merge(hd_names, on="UNITID", how="left")

    # --- Filter to Big Ten ---
    bigten_unitids = load_bigten_unitids(args.bigten_unitids_path)
    df_bigten = df_with_names.loc[df_with_names["UNITID"].isin(bigten_unitids)].copy()

    # --- Select and rename to research schema ---
    research = (
        df_bigten.loc[:, ["UNITID", "INSTNM", "CIPCODE", "MAJORNUM", "AWLEVEL", "CTOTALT"]]
        .rename(
            columns={
                "UNITID": "unitid",
                "INSTNM": "institution",
                "CIPCODE": "cipcode",
                "MAJORNUM": "major_number",
                "AWLEVEL": "award_level_code",
                "CTOTALT": "award_count_total",
            }
        )
        .copy()
    )

    # --- Normalize dtypes ---
    research["institution"] = research["institution"].astype("string")
    for col in ["unitid", "major_number", "award_level_code"]:
        research[col] = pd.to_numeric(research[col], errors="coerce").astype("Int64")
    research["award_count_total"] = pd.to_numeric(research["award_count_total"], errors="coerce").astype("Int64")

    # CIPCODE as canonical string + derived CIP2
    research["cipcode"] = research["cipcode"].apply(format_cipcode).astype("string")
    research["cip2"] = research["cipcode"].str.split(".", n=1).str[0].str.zfill(2)

    # --- Build CIP lookups (CIP2 and CIP6) ---
    cip_lookup = cip_raw[["CIPCode", "CIPTitle", "CIPFamily"]].copy()
    cip_lookup["cipcode"] = clean_excel_text_wrapper(cip_lookup["CIPCode"])
    cip_lookup["cip_title"] = cip_lookup["CIPTitle"].astype("string").str.strip()
    cip_lookup["cip_family"] = cip_lookup["CIPFamily"].astype("string").str.strip()

    # CIP2 title: prefer the explicit family name
    cip_lookup["cip2"] = cip_lookup["cipcode"].str.split(".", n=1).str[0].str.zfill(2)
    cip2_lookup = (
        cip_lookup[["cip2", "cip_family"]]
        .dropna()
        .drop_duplicates()
        .rename(columns={"cip_family": "cip2_title"})
        .sort_values("cip2")
    )

    # CIP6 title: keep only true CIP6 codes NN.NNNN
    cip6_lookup = (
        cip_lookup[["cipcode", "cip_title"]]
        .dropna()
        .drop_duplicates()
        .rename(columns={"cip_title": "cip6_title"})
    )
    cip6_lookup = cip6_lookup[cip6_lookup["cipcode"].str.fullmatch(r"\d{2}\.\d{4}", na=False)].copy()

    # --- Join titles onto research ---
    research_final = (
        research.merge(cip2_lookup, on="cip2", how="left")
        .merge(cip6_lookup, on="cipcode", how="left")
    )

    # Explicitly label cip2=99 (not present in CIP taxonomy)
    research_final["cip2_title"] = research_final["cip2_title"].fillna("99 - Unclassified / Not in CIP taxonomy")

    # Award level labels + degree group
    award_level_labels = {
        5: "Bachelors",
        7: "Masters",
        17: "Doctoral (Research/Scholarship)",
    }
    research_final["award_level_name"] = (
        research_final["award_level_code"].map(award_level_labels).astype("string")
    )

    research_final["degree_group"] = pd.Series(pd.NA, index=research_final.index, dtype="string")
    research_final.loc[research_final["award_level_code"] == 5, "degree_group"] = "Bachelors"
    research_final.loc[research_final["award_level_code"].isin([7, 17]), "degree_group"] = "Graduate"

    # CIP6 validity flag + explicit fill for non-CIP6 titles
    research_final["is_cip6"] = research_final["cipcode"].str.fullmatch(r"\d{2}\.\d{4}", na=False)
    research_final["cip6_title"] = research_final["cip6_title"].fillna(
        "Not a CIP6 program (aggregate / unclassified)"
    )

    # --- Final column order ---
    final_cols = [
        "unitid",
        "institution",
        "cip2",
        "cip2_title",
        "cipcode",
        "cip6_title",
        "is_cip6",
        "major_number",
        "award_level_code",
        "award_level_name",
        "degree_group",
        "award_count_total",
    ]
    research_final = research_final[final_cols].copy()

    # --- Guardrails ---
    # (1) Expect 18 institutions
    n_inst = int(research_final["unitid"].nunique())
    if n_inst != 18:
        raise ValueError(f"Expected 18 Big Ten institutions, got {n_inst}")

    # (2) No missing CIP2 titles after explicit fill
    missing_cip2_titles = int(research_final["cip2_title"].isna().sum())
    if missing_cip2_titles != 0:
        raise ValueError(f"Unexpected missing cip2_title count: {missing_cip2_titles}")

    # (3) All true CIP6 rows should have a title
    missing_cip6_for_true = int(research_final.loc[research_final["is_cip6"], "cip6_title"].isna().sum())
    if missing_cip6_for_true != 0:
        raise ValueError(f"Missing cip6_title for true CIP6 codes: {missing_cip6_for_true}")

    # --- Write output ---
    out_path.parent.mkdir(parents=True, exist_ok=True)
    research_final.to_csv(out_path, index=False)

    return out_path


def parse_args() -> argparse.Namespace:
    default_root = Path("..")

    p = argparse.ArgumentParser(
        description="Build Big Ten IPEDS Completions research dataset (cleaned + joined)."
    )
    p.add_argument(
        "--completions-path",
        type=Path,
        default=default_root / "data" / "raw" / "ipeds" / "C2024_A.csv",
        help="Path to IPEDS Completions CSV (e.g., C2024_A.csv).",
    )
    p.add_argument(
        "--hd-path",
        type=Path,
        default=default_root / "data" / "raw" / "ipeds" / "HD2024.csv",
        help="Path to IPEDS Header/Directory CSV (e.g., HD2024.csv).",
    )
    p.add_argument(
        "--cip-path",
        type=Path,
        default=default_root / "data" / "raw" / "ipeds" / "CIPCode2020.csv",
        help="Path to CIP taxonomy CSV (e.g., CIPCode2020.csv).",
    )

    p.add_argument(
        "--bigten-unitids-path",
        type=Path,
        default=default_root / "data" / "processed" / "ipeds" / "bigten_unitids_named.csv",
        help="Optional CSV containing Big Ten UNITIDs (columns: UNITID). Falls back to embedded list if missing.",
    )
    p.add_argument(
        "--out-path",
        type=Path,
        default=default_root / "data" / "processed" / "ipeds" / "research_bigten_completions_2024.csv",
        help="Output path for the finalized research CSV.",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    out = build(args)
    print(f"Wrote: {out}")
