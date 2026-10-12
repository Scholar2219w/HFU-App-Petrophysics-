# HFA — Hydraulic Flow Analysis Suite

**Integrated Hydraulic Flow Unit, Petrophysics & Reservoir Quality Analysis**

This build covers **sections 1–45** of the specification (`HFU App Prompt.txt`). Sections 1–20 were delivered in phase 1 and sections 21–45 in phase 2. Phase 3 adds the petrophysics improvements from `Improvements.docx`: conventional depth tracks, reservoir-interval scope, and a Techlog-style evaluation (VSH, PHIT_ND and Archie Sw from a Pickett plot). The exceptions are listed under *Known limitations*.

## How to run

| Option | What to do |
|---|---|
| **Just use it** | Double-click **`HFA.html`**. It's a single self-contained file with the Web Workers inlined. It works offline, including from `file://` in Chrome or Edge. |
| Develop | `npm install`, then `npm run dev` (Vite dev server). |
| Rebuild `HFA.html` | `npm run build`, then copy `dist/index.html` to `HFA.html`. |

Everything runs in the browser. **Nothing is uploaded, and there is no backend and no telemetry.** Projects are stored in the browser's IndexedDB. Raw LAS/DLIS files are never stored. Only the normalised arrays and the metadata are kept.

Quick test: **Project → Load Demo Data**. It is clearly labelled *DEMO DATA — NOT REAL RESERVOIR DATA*. Then follow the numbered workflow on the Overview page.

## Architecture (modular services, spec §44)

```
src/
  parsers/        LAS 1.2/2.0/3.0 (streaming), DLIS RP66v1 (selective frame/channel decode, array channels, TIF),
                  LIS-79 (physical/logical records, DFSR, repr 68/49/50/56/66/70/73/77/79), CSV/TXT/XLSX/XLS/JSON/Parquet
  data-engine/    canonical registry (Float64 depth + Float32 curves), IndexedDB store, ingestion/resampling, zones/tops helpers,
                  analysis scope (reservoir intervals → RES_FLAG)
  workers/        generic RPC worker (two instances: parse + analysis), transferable TypedArrays
  curves/         mnemonic → family alias table, auto-categorisation
  depth/          reversible depth operations (shift, stretch/squeeze, polynomial, tie points) + auto-correlation
  petrophysics/   unit detection/conversion, transparent formula engine (AST parser, no eval) + presets,
                  quanti.ts: bad hole · VSH · neutron-density porosity (+HC correction) · Archie/Pickett · cut-offs & summation
  hfu/            RQI/Φz/FZI engine (unit-checked), HFU identification methods A–E, transition statistics
  qc/             statistical QC flags (CRITICAL / WARNING / INFO), never auto-removing data
  clustering/     K-Means, GMM, Ward/agglomerative, DBSCAN, scaling, elbow/silhouette/CH/DB, Jenks, probability-plot breaks
  regression/     OLS/QR with SE/t/p/VIF, ridge/lasso/elastic-net, poly2, random forest, gradient-boosted trees,
                  feature selection (9 methods), validation schemes, dataset assembly with leakage checks
  visualization/  DepthPlot (conventional white depth tracks for every property-vs-depth figure), themes, canvas multi-track LogViewer (min/max envelope downsampling), generic XYPlot (lasso, hexbin, contours)
  project/        save/load/duplicate/export/import (.hfaproj), orphan-array purge on save
  store/          app state + history.ts (undo/redo checkpoints for metadata AND well/core arrays)
  export/         CSV / XLSX / LAS 2.0 writers, Canvas→SVG recorder, PNG/SVG/PDF figures, interpretation report (PDF/HTML)
  ui/             one module per workflow stage
  demo/           synthetic dataset
```

Pipeline: `File → Parser Worker → Normalized Well Model → Registry/IndexedDB → UI / Analysis Worker`. Each curve has one canonical TypedArray. Downsampling is used for display only, and every calculation uses full-resolution arrays.

## Phase 3 — petrophysics improvements

| Improvement | What changed |
|---|---|
| **1 · Depth plots look like log tracks** | Every "property vs depth" figure uses a conventional log-track display: depth down the page, tall narrow tracks, a white background, a header showing each curve's name, scale and unit, plus zone and reservoir columns. This covers core plots, core–log depth matching, FZI/RQI and units vs depth, clusters vs depth, residuals vs depth, R35 and grain density. The Log Viewer defaults to white tracks, with a toggle for dark. There is also a *Petrophysical interpretation* template: caliper and bit size, bad-hole flags, GR with sand/shale baseline fill, AT10/30/90, neutron-density crossover, VSH, porosity with core, RES_FLAG, permeability with core, SW_AR, RQI/FZI and HFU. |
| **2 · Work on the reservoir, not the whole well** | New **Reservoir Intervals** module (Data). Intervals come from a step-flag file (e.g. `RES_FLAG.csv`, with ft→m detection), a formation, an interval dragged in the log viewer, a flag curve, or manual entry. It writes a `RES_FLAG` curve and sets the global **analysis scope** (chip in the top bar). Petrophysics, RQI/FZI, HFU identification, clustering, regression datasets, prediction (default *Reservoir intervals*), crossplots, QC, reservoir quality, transitions, multi-well, data table and CSV/XLSX export all follow the scope. Samples outside it are counted and reported, never deleted. |
| **3 · Zonation from the tops CSV** | Tops files such as `*_Gold_Zones.csv` are recognised automatically (wellName / MD / zone column). Well names are matched tolerantly (*Gorgonicthys-1* ↔ *GORGONICHTHYS-1*). Depth units are checked against the well, and feet are converted to metres with a warning. The Log Viewer has a **Zones** track. Petrophysics can be zoned by *reservoir intervals*, *formation tops* (optionally restricted to the reservoir) or *whole well*. |
| **Petrophysical Evaluation** (Analysis) | A Techlog-style workflow manager. Methods: 1 bad-hole flags (CALI−BS, \|DRHO\|) · 2 shale volume (linear / Larionov tertiary / Larionov older / Clavier / Steiber, with GR clean/shale = P5/P95 per zone) · 3 **porosity neutron-density** (PHID, PHIN, PHIT_ND, PHIT_ND_UNCL, PHIE_ND; shale point; neutron matrix shift; optional iterative hydrocarbon correction using the Techlog "Hydrocarbon parameters": HC density, mud salinity, temperature, HI gas / fluid, excavation, m, n, invasion factor) · 4 **Archie Sw from a Pickett plot** (drag Rw/m sliders, click a wet point, fit Rw or m+Rw on the lower envelope, Arps temperature correction, sensitivity table) · 5 cut-offs and summation (NET_RES, NET_PAY, gross, net, N/G, φ, Sw, VSH, HCPV). The parameter grid has one column per zone like Techlog, an *All zones* column, and CSV export/import. A **core calibration** view compares core φ with PHIT_ND: 1:1 line, bias, RMSE and r. |

**Other analyst pain points addressed:**

- Depth matching plots are drawn in real units instead of z-scores. Tie points can be picked by clicking the core point and then the log feature. There is an explicit warning when the chosen log has no data at the core depths (e.g. NPHI vs TNPH).
- Core plots open on the cored interval, and K vs RQI/FZI are hidden until RQI/FZI exist.
- Neutron in p.u. is detected and converted to v/v.
- Every run lists its formulas and zone parameters (audit trail).
- The interpretation report gains a *Reservoir intervals & petrophysical evaluation* section: parameter table, summation and depth panel.

## Coverage of sections 1–20

| § | Status | Notes |
|---|---|---|
| 1 Philosophy | ✅ | Local-first. Workers, TypedArrays, IndexedDB, lazy curve loading. Offline single-file build. |
| 2 File import | ✅ | LAS (incl. wrapped, LAS 3 log section), DLIS (logical file/frame/channel selection, depth-channel choice, 0.1 in → m), CSV/TXT (delimiter, decimal, header/unit rows, nulls, units), XLSX/XLS (sheet selection; fixes bad sheet ranges), JSON. LIS, Parquet, DLIS array channels and TIF wrapping were added in phase 2. |
| 3 Memory engine | ✅ | Metadata is kept separate from arrays. Merging onto a well grid uses interpolation and is logged. Very large CSVs are tokenised as text before conversion (acceptable up to a few million cells). |
| 4 Layout | ✅ | Top menus, Project Explorer, workspace, Properties/Statistics panel, status bar (well, depth, cursor, interval, selection, operation, busy, memory). |
| 5 Project system | ✅ | New / Save (Ctrl+S) / Open / Duplicate / Export / Import, plus project metadata. |
| 6 Curve manager | ✅ | All requested columns. Auto-categorisation, alias mapping (built-in + user), drag rows into log tracks. |
| 7 Log viewer | ✅ | Unlimited tracks, drag-and-drop curves, lin/log/reverse, min/max/auto, grid/minor grid, colour/width/dash, fill left/right, crossover fill, tops, core points, selection markers, interval shading, synchronised cursor panel. Annotations and markers (Alt+click). |
| 8 Depth manager | ✅ | Bulk shift, stretch/squeeze, polynomial, tie points, auto-correlation (auto-detects inverse relations), interval-specific ops, before/after preview, accept/reject, reversible op list, TVD/TVDSS (minimum curvature from a survey). |
| 9 Core data | ✅ | CSV/XLSX/manual import. QC table, duplicate/null filtering, outlier flagging (never silent), unit conversion columns, 5 core plots. Before/After/Removed log. |
| 10 Formula engine | ✅ | 12 presets plus custom expressions. Each curve stores formula, inputs, units, version and missing-data handling. |
| 11 HFU engine | ✅ | Configurable C. Calculation is **blocked until φ and k units are confirmed**. Shows input units, converted units and status. |
| 12 HFU identification | ✅ | Methods A–E (FZI) and F (K-Means, GMM, Ward, agglomerative, DBSCAN). Diagnostics: correlation matrix, distributions, outliers, missing %. Five normalisation options. |
| 13 Cluster number | ✅ | Elbow, silhouette, CH, DB (and GMM BIC) for K = 2–10. The user's K is never overwritten. Full cluster statistics table. |
| 14 Crossplot studio | ✅ | Any axes. Colour by HFU/cluster/facies/depth/Vsh/curve/well. Core/log/validation symbols. Five regression types with equation, R², RMSE, MAE, N and 95 % CI. Log axes, 1:1, moving average, hexbin, density contours, lasso synced to the log viewer. |
| 15 Regression studio | ✅ | Targets log(FZI), FZI, RQI, log(K), K, HFU class. MLR, log-linear, poly, ridge, lasso, elastic net, random forest, gradient-boosted trees. See note on XGBoost below. |
| 16 Feature selection | ✅ | Manual, correlation, VIF, forward (AIC), backward (p), RFE, LASSO, mutual information, RF importance, permutation importance. Coefficients, SE, t, p, R², adj R², RMSE, MAE, AIC, BIC, VIF and condition number. Side-by-side comparison with no "best model". |
| 17 Per-HFU regression | ✅ | Global, by HFU, or by cluster. Minimum-N threshold. Warns on low N, high missing data, multicollinearity, leakage and extrapolation. |
| 18 Validation | ✅ | Depth-blocked K-fold by default. Also random/block splits, random K-fold, leave-one-well-out, cluster-stratified, and an independent interval. Five diagnostic plots and all metrics. Back-transformed metrics for log targets. |
| 19 Predicted curves | ✅ | FZI_PRED, HFU_PRED, K_PRED and EXTRAP flag (plus RF spread). Scope: well, interval, formation or cluster. Full audit text is stored in the curve metadata. |
| 20 HFU depth track | ✅ | Categorical bands. Clicking an interval shows depth, HFU and status, mean φ/K/RQI/FZI, core samples, dominant facies, regression model and equation, and confidence (extrapolation, boundary margin, core agreement). |

XGBoost itself can't run in the browser. The app uses a built-in gradient-boosted-tree model instead and labels it as such.

**Scientific safeguards built in:** nothing is filtered silently (every filter logs Before/After/Removed/Reason); calculations are blocked when units are ambiguous; clusters stay "Statistical Cluster" until the analyst validates them as HFUs; random splits of depth-correlated data carry a warning; leakage is flagged for `_CORE`, `_PRED`, FZI/RQI or HFU-derived predictors; and there is no automatic "best model".

## Coverage of sections 21–45

| § | Status | Notes |
|---|---|---|
| 21 HFU transitions | ✅ | Per-well transition matrix (counts and probabilities), interval thickness statistics, vertical continuity and persistence. Stacking-pattern plot. |
| 22 Reservoir quality | ✅ | Per-HFU PHI/K/RQI/FZI statistics (N, mean, median, geometric mean, P10/P50/P90, min, max). Units are ordered by **one explicitly chosen property**. This is a factual ordering, not an opaque "quality score". |
| 23 QC dashboard | ✅ | Per-well and per-curve completeness, ranges, spikes, flat lines, robust outliers, unit and depth-step issues, and core coverage. Flags are CRITICAL / WARNING / INFO. Nothing is removed automatically. |
| 24 Multi-well | ✅ | Well summary, distribution overlays (log and cumulative), HFU share per well, and formation-specific statistics across wells. |
| 25 Formations / zones | ✅ | Tops editor (CSV/XLSX tops, and LAS `~TOPS` / `~FORMATION` sections). Each zone runs from a top to the next top. A global zone filter applies to crossplots, regression datasets, the data table, reservoir quality and multi-well. |
| 26–27 Interval & formula builder | ✅ | Visual AND/OR condition builder plus free formula (e.g. `GR < 50 AND PHIE > 0.1`). Saved filters. Results can become a selection, an interval or a `SEL_` flag curve, and each shows Before/After/Removed. |
| 28 Data table | ✅ | Virtualised (only visible rows are rendered). Sort, filter expression, search, frozen columns, show/hide columns, zone filter. Export to CSV/XLSX. |
| 29 Performance | ✅ | Two worker pools. TypedArrays. Lazy curve loading from IndexedDB. Min/max envelope downsampling for display only. Memory read-out in the status bar. |
| 30 Export & report | ✅ | Curves as CSV, XLSX and LAS 2.0 (with a provenance section). HFU and regression results as XLSX/CSV. Every plot and the log panel as PNG, **vector SVG** or PDF. The interpretation report (PDF or HTML) has 15 selectable sections with embedded plots and log panels. |
| 31 Auditability | ✅ | Audit Trail module with a lineage tree for every derived curve (formula, inputs, model, training data, validation, date) and a full model card. |
| 32 History / undo-redo | ✅ | Every logged action is a checkpoint (60 max). Undo and redo restore metadata and the curve and core arrays. Undone steps are shown struck through. |
| 33–34 UI & shortcuts | ✅ | See the keyboard table below, also available from Settings → Keyboard shortcuts. |
| 35 Error handling | ✅ | Parser errors are reported per file. Notifications for blocked calculations. Nothing fails silently. |
| 36 Privacy | ✅ | Local-only, no telemetry, no network calls. Settings → Privacy explains what is stored and Settings → "Clear ALL local HFA data" removes everything. |
| 37–38 Architecture & pipeline | ✅ | See above. |
| 39 Default workflow guide | ✅ | A 16-step guide on the Overview page and in the top-bar toggle. It ticks steps off automatically and offers "Continue: step N". |
| 40 Scientific principles | ✅ | See the safeguards below. |
| 41 Advanced modules | ✅ / 🗺 | Permeability transforms (per-HFU φ–k power law), NMR Coates and SDR, Pc / Leverett-J saturation-height (SW_SH), facies–HFU contingency with Cramér's V, formation pressure gradients, and RCA summary. Seismic, well correlation, 3-D and geostatistics are shown as a **roadmap only**. |
| 42 Demo | ✅ | Two synthetic wells with core and tops, labelled *DEMO DATA — NOT REAL RESERVOIR DATA* everywhere, including exports and reports. |
| 43 Dashboard | ✅ | Overview KPIs, workflow guide, module cards and well table. |
| 44–45 Modular structure | ✅ | One service folder per concern and one UI module per workflow stage. |
| Phase-1 leftovers | ✅ | LIS parser, Parquet (via hyparquet), DLIS array channels (≤ 64 elements expanded to `NAME_1..n`), TIF-wrapped DLIS/LIS, and log-viewer annotations (Alt+click). |

### Keyboard shortcuts

| Key | Action |
|---|---|
| Ctrl+O | Open data (Import Manager) |
| Ctrl+S | Save project |
| Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) | Undo / redo |
| Ctrl+F | Find curve |
| Wheel / Shift+wheel | Depth zoom / track width |
| Drag / drag in depth track | Pan / select interval |
| Alt+click | Add annotation (start with "!" for a marker) |
| Double-click / Space / Esc | Full well / cursor read-out / cancel |

## Known limitations

- **Petrophysics**:
  - The ND lithology lines are straight-line approximations for limestone-unit neutron, not the vendor chart books.
  - The hydrocarbon correction is a documented iterative approximation. It is not Techlog's proprietary implementation, so expect small differences.
  - Archie assumes clean rock. Shaly-sand models (Simandoux, Indonesia, dual water) are not included yet.
- **Thickness** in summation is measured depth (no TVT/TST correction).

- **LIS**: tested only on synthetic round-trip files (continuation records, negative repr-68 values, absent value, depth mode 1). Please check it on a real vendor LIS file before relying on it.
- **XGBoost**: can't run in the browser. The built-in gradient-boosted-tree model is used instead and labelled as such.
- **Parquet**: read through `hyparquet`, which supports the common codecs (Snappy, Gzip, Zstd, Brotli, LZ4). Nested schemas are flattened or skipped.
- **PDF**: generated with jsPDF's standard fonts. Greek letters and symbols are transliterated (φ → phi, · → *). The HTML report keeps full Unicode.
- **DLIS array channels** with more than 64 elements (e.g. full waveforms) are listed but not imported.
- **Undo history** is kept per session (60 steps). It is not saved inside the project file.
- **Roadmap only**: seismic tie, well-to-well correlation panel, 3-D views and geostatistics (section 41).
- Bundle size is about 2.2 MB (a single offline file).
