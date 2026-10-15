# Caption fonts

Geist Bold, Geist Black and Geist Mono Bold, copied unchanged from the `geist` npm package (v1.7.2,
Vercel × basement.studio). Licence: SIL Open Font License 1.1 — see `OFL.txt`.

They are used by libass when exporting Shorts (`media_worker/jobs/render_short.py` copies them next to the
generated `captions.ass`). The app's editor preview uses the same family from the `geist` package, so the
preview and the exported video match (DECISIONS.md D-040). If you add a font, add it to
`CAPTION_FONTS` in `src/lib/shorts/caption-style.ts` with its metrics.
