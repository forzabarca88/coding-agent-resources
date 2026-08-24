Every run — passed or failed — grouped under its Model identifier into one
row per model. Choose a metric with the **Context Used / Turns** toggle; the
row spans that model's smallest to largest value on a shared scale, so its
length is the model's range, and each of its runs sits as a mark at its own
value. The chosen scale stays pinned above the rows as they scroll, so it
never scrolls out of view; hover or focus any mark for the full record in a
tooltip (same style as the scatter).

Each mark reads its run in three ways at once:

- **Status** (fill): solid carbon = success (exit 0), red = failed.
- **Quant** (shape): the glyph carries the run's weight quantisation
  (Q4_K_XL, Q8_0, Q3_K_S…).
- **KV quant** (stroke): the outline colour is the run's *actual* KV cache
  quantisation — Q4_0, Q8_0, None (dashed), or a faint ring when the run
  records no KV quant (the provider runs).

The legend above the chart decodes every symbol that actually appears, and the
pass/fail split per model is shown in each row's label column (`ok / total`).
The **Source** and **Models** filters — including the wildcard search — drive
this chart exactly as they drive the scatter, so a failing run the scatter
drops still appears here. The "Runs to show" limit applies to the scatter
only, since ranking by least context makes no sense for a range view; the
breakdown always shows every matching run.