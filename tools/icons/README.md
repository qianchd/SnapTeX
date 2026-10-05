# Icon assets

Keep the source SVG and three black-on-transparent PNG exports in `media/`:

| Asset | Purpose |
| --- | --- |
| `icon.svg` | Source artwork; Web toolbar, welcome page, favicon, GitHub README, and docs |
| `icon-32.png` (32 × 32) | Small raster export; not shipped in Web or VSIX builds |
| `icon.png` (192 × 192) | Small raster export retained at the user's request; not shipped in Web or VSIX builds |
| `icon-512.png` (512 × 512) | VS Code extension icon and Marketplace README logo |

`icon.png` is the former `icon-192.png`, renamed rather than duplicated.
There is no ICO or 2152px export. Web builds generate `icon-pwa.svg` from
the source SVG with a fixed black logo on a white rounded-square background,
with no color-scheme media query. The original artwork is scaled to 80% of
the canvas to leave padding inside the white tile; its paths are unchanged.
The background has a corner radius of 192 in the 1024-unit viewBox. This
keeps the logo's contrast independent of the system background, even when
the installer rasterizes the SVG once. Do not edit the generated file;
it is ignored by Git and excluded from the VSIX.

Web builds ship both SVGs, precache them for offline use, and include a content
hash in their URLs so unchanged icons remain reusable from cache. The PWA
manifest selects `icon-pwa.svg` with `sizes: "any"`.

The toolbar and welcome logo use the SVG as a CSS mask, colored with the
page's `currentColor`, so they follow the selected Web theme rather than the
operating system's theme. The favicon follows the system color scheme.
An installed PWA's system icon is a snapshot chosen by the browser; changing
the Web theme cannot reliably recolor its Windows taskbar or Start Menu icon.

To regenerate the black-on-transparent PNG exports after editing the SVG,
install ImageMagick and run `node tools/icons/prepare-assets.mjs --png`.
This optional export command is not needed for normal builds.

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
