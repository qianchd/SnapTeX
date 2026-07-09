# SnapTeX Performance Notes

SnapTeX optimizes long-document preview around block-level work, lazy rendering, and virtualized DOM.

## Current Production Levers

* Block spans and hashes avoid storing duplicate block strings long-term.
* Localized patches avoid full DOM replacement when edits are small.
* Deferred full HTML sends block metadata first and renders block HTML on demand.
* Virtual mode mounts only nearby blocks and retains shells for scrollbar stability.
* TikZ, PDF, and binary resources are loaded lazily by the preview runtime.

## AST Benchmark Utility

`src/ast/benchmark.ts` measures:

* legacy splitter duration and block count;
* AST splitter duration, refined/coarse block counts, and safety-split usage;
* estimated deferred first-payload size for virtual preview mode;
* AST artifact extraction duration over a sampled block set;
* AST experimental render duration over a sampled block set;
* heap usage before and after the benchmark when the host exposes `process.memoryUsage()`.

This utility is intentionally reusable rather than a fixed CLI. A future script can call it for short, medium, long, citation-heavy, figure-heavy, TikZ-heavy, and malformed fixtures.

## Default-Switch Requirement

AST components should not become default until benchmark results show acceptable parse time, update latency, sampled render time, memory behavior, and fallback reliability on representative long documents.

## Current AST Backend Observation

On 2026-07-08, using the local long-document validation fixture `src/localtestTeX/main_arxiv_v3.tex` (not committed), the AST-assisted backend benchmark was:

| Measure | Result |
| --- | ---: |
| source size | 306 KB |
| legacy split | 575 blocks, 46 ms |
| AST split | 1298 blocks, 212 coarse blocks, 944 ms |
| largest AST block | 2740 chars, 34 lines |
| safety split used | false |
| sampled AST artifact extraction | 30 blocks, 13 ms |
| sampled AST render | 30 blocks, 28 ms |
| estimated deferred payload | 75 KB |
| heap after benchmark, before GC | 61 MB |
| heap after forced GC | 12 MB |
| retained heap delta after forced GC | 4.8 MB |

The two-layer AST splitter keeps refined blocks bounded and avoids retaining full AST trees, but AST split remains much slower than the legacy splitter and creates a large temporary heap spike. After forced GC, retained memory is small, so the next optimization target is split-time and temporary allocation pressure rather than durable state size. Single-run heap readings are noisy and should be treated as a rough smoke signal rather than a release criterion.

The same fixture through `PreviewUpdateService.render(..., { backendMode: 'ast(experimental)', deferFullHtml: true })` produced a full metadata payload with 692 preview blocks in 943 ms. The serialized first payload was about 99 KB. Lazy rendering sampled the first, middle, last, and largest-line-count blocks successfully; forced-GC heap after the smoke run was about 17.6 MB. This validates the service-layer lazy contract but does not replace real VS Code webview peak-memory testing.

A follow-up AST lazy-render scan rendered all 692 blocks and stripped KaTeX annotations plus TikZ script bodies before checking visible HTML for common raw-LaTeX leaks. The scan found no visible `\begin{...}`, heading markdown, or common unrendered `\textbf`/citation/ref commands after fixing detached optional citation arguments and empty text-style commands.
