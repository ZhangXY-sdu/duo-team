---
name: duo-research
description: >-
  Academic research, econometrics, data analysis, literature synthesis, and
  publication-grade document collaboration workflow using Gemini + Codex
  (Python, R, Stata, LaTeX, Word, PDF, PPT, Excel). Use when collaborating on
  papers, empirical studies, literature reviews, or deep research deliverables.
---

# Duo-Team Academic & Complex Research Playbook

Use this playbook alongside `duo-orchestrate` for academic research, empirical econometrics, and complex non-coding deliverables.

## 1. Environment Check First
Before delegating empirical or document compilation tasks, probe what tools are actually installed locally (`python3`, `Rscript`, `stata`, `latexmk`, `pdflatex`, `xelatex`, `pandoc`, `libreoffice`) so neither model writes scripts for missing software.

## 2. Standard Empirical Research Pipeline (Gemini + Codex)
1. **Research Design & Identification Debate**:
   - Run **Structured Debate** (`debate`) or **Blind Parallel Research** (`parallel_research`) on research hypotheses, identification strategy (DID / IV / RDD / Panel FE), sample filters, and potential confounders.
   - Lock the agreed specification, variable definitions, and sample criteria into `.duo-team/memory.md`.
2. **Data Cleaning & Independent Replication**:
   - Keep raw data read-only. Have Codex write reproducible cleaning and estimation scripts (`Python` / `R` / `Stata`) producing machine-readable summary tables (`.csv` / `.json` / `.tex`) + log files.
   - Set `verifyCommand` on the task (e.g., `python3 scripts/verify_tables.py`) to verify sample size `N`, non-empty outputs, and zero runtime errors.
   - Have the opposite model independently audit the code for merge bugs, look-ahead bias, clustering mistakes, or mismatched table numbers.
3. **Writing, Citations & Formatting (LaTeX / Word / PPT / Excel)**:
   - Maintain a verified citation & evidence table (source, year, exact quote/finding, page/table). Never fabricate references.
   - Cross-check every number in prose against the generated output tables before final compilation.
   - Verify compiled PDFs/DOCX/PPTX/XLSX actually build cleanly (`latexmk` / python validation) and inspect layout for truncation or missing glyphs.
