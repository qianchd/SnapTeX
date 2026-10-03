# Icon assets

Keep three canonical assets in `media/`:

| Asset | Purpose |
| --- | --- |
| `icon.svg` | Web toolbar, welcome page, favicon, GitHub README, docs, and SVG-capable PWA installers |
| `icon.png` (192 × 192) | Small raster export retained at the user's request; not shipped in Web or VSIX builds |
| `icon-512.png` (512 × 512) | VS Code extension icon and Marketplace README logo |

`icon.png` is the former `icon-192.png`, renamed rather than duplicated.
There is no separate 32px PNG or ICO. The original 2152px source is unnecessary
for these distributions. Web builds ship only the SVG icon, declared with
`sizes: "any"` in the PWA manifest, and precache it for offline use. Its URL
includes a content hash, so unchanged icons remain reusable from cache.

The Web app targets browsers with SVG icon support. Chromium supports SVG
manifest icons; Safari 26 adds SVG favicons and Home Screen/Dock icons. Older
Safari/iOS versions may show a generic icon when installing the Web app.
Supporting those installation icons would require a raster fallback, which
is intentionally omitted from Web builds.

`prepare-assets.mjs --docs` copies the canonical SVG into VitePress's public
directory before development or production builds. That generated file is
ignored by Git; do not maintain a second SVG in `docs/public/`.

VS Code Marketplace disallows SVG extension icons and custom SVG images in
extension descriptions. `prepare-assets.mjs --vscode` generates
`dist/README.md` from the root README, replacing only the logo URL with
`media/icon-512.png`. The `vsce.readmePath` setting selects this generated
README automatically when packaging or publishing; the `vscode:prepublish`
build generates it. The extension includes only the 512px icon, while the
root README keeps the SVG for GitHub.

References: [VS Code publishing rules](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
[PWA manifest icons](https://web.dev/articles/add-manifest),
[Web App Manifest specification](https://www.w3.org/TR/appmanifest/), and
[Safari 26 SVG icon support](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/).

## SVG typography

`media/icon.svg` traces the original `TeX` lettering from `media/icon-512.png`,
preserving its proportions, spacing, and flat terminals. The icon contains
paths, not text elements, embedded fonts, or font requests.

The lettering was traced with Potrace after compositing the PNG on white and
upsampling it four times with Lanczos interpolation. Tracing uses a threshold
of 128, a speckle size of 2, and a curve optimization tolerance of 0.5 in the
upsampled coordinates. The paths are scaled back to the original 512-unit
coordinate system and optimized with SVGO at one decimal place. The SVG shifts
the origin to the center of the icon.

The lettering uses `evenodd` filling so that the traced counter inside `e`
stays open. Preserve the original letter shapes when making further edits.

The aperture defines one petal, combines three copies at 0, 120, and 240
degrees into a group, and reuses that group at 0, 30, 60, and 90 degrees.
This produces the same twelve petals while reducing repeated markup.
For compact encoding, the viewBox, coordinates, and stroke width are doubled
together, preserving the rendered size and aperture geometry. The lettering
and lightning are optimized with integer coordinates in that doubled system
(a half-unit grid in the original 512-unit system). This removes redundant
path segments while keeping the original lettering visually equivalent at
normal icon sizes. The petal path retains its original geometry exactly.
