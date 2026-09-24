# arXiv corpus audit

This developer tool builds a local, category-stratified corpus of arXiv TeX sources and renders every root document through both SnapTeX backends.

```bash
npm run audit:arxiv:fetch
npm run audit:arxiv
```

The first command downloads 10 usable projects from each configured mathematics/statistics category. The second command renders every block through `PreviewUpdateService` and writes `tex_samplecode/AUDIT_REPORT.md` plus machine-readable results. Pass `-- --resume` only to continue an interrupted audit without rerendering completed papers.

The downloader requires `curl` and `tar` on `PATH` (both are included with current Windows releases and common Unix environments). Completed papers and audit results are resumable.

`tex_samplecode/` is intentionally ignored by Git. Do not redistribute downloaded sources without checking each paper's license. The downloader is sequential and waits at least three seconds between arXiv requests; keep those limits when modifying it.
