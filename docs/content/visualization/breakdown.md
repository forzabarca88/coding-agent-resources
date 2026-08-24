One row per model, **every** run — passed or failed — grouped under its
identifier. Each row carries two horizontal rails: **Context Used** and
**Turns**. A rail spans that model's smallest to largest value for the metric,
so its length is the model's range, and each of the model's runs sits as a mark
along it at its own value. The run marks encode three things at once:

- **Status** (fill): solid carbon = success (exit 0), solid red = failed.
- **Quant** (glyph): shapes carry the model's quantisation (Q4/Q8/Q3/Q1/K_XL…).
- **KV quant** (outline): a solid outline when a KV cache quant is set (or is
  not applicable, as with cloud provider runs that record no quantisation);
  dashed when a run instead notes `KV quant: None` — a run going without a KV
  quant thus stands out clearly.

The stacked bar in each row's label cell is the pass/fail split for that model
(blue = OK, red = failed). The **Source** and **Models** filters — including
the wildcard search — drive this chart exactly as they drive the scatter
above, so a failing run the scatter drops still appears here. The "Runs to
show" limit applies to the scatter only, since ranking by least context makes
no sense for a range view; the breakdown always shows every matching run.
Hover a mark for its full record, including every note.