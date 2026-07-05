import { escapeHtmlAttribute } from './utils';

export interface PreviewHtmlTemplateData {
    cspMeta: string;
    styleLinks: string[];
    bodyData: Record<string, string>;
    bridgeScript: string;
    scripts: string[];
}

function renderAttributes(attributes: Record<string, string>): string {
    const rendered = Object.entries(attributes)
        .map(([name, value]) => `${name}="${escapeHtmlAttribute(value)}"`)
        .join(' ');
    return rendered ? ` ${rendered}` : '';
}

function renderStylesheetLinks(hrefs: string[]): string {
    return hrefs
        .map(href => `    <link rel="stylesheet" href="${escapeHtmlAttribute(href)}">`)
        .join('\n');
}

function renderScriptTags(srcs: string[]): string {
    return srcs
        .map(src => `<script src="${escapeHtmlAttribute(src)}"></script>`)
        .join('\n');
}

export function fillPreviewHtmlTemplate(template: string, data: PreviewHtmlTemplateData): string {
    const replacements: Record<string, string> = {
        cspMeta: data.cspMeta,
        styleLinks: renderStylesheetLinks(data.styleLinks),
        bodyData: renderAttributes(data.bodyData),
        bridgeScript: data.bridgeScript,
        scripts: renderScriptTags(data.scripts)
    };

    const html = template.replace(/{{([a-zA-Z0-9_]+)}}/g, (placeholder, key) => {
        if (Object.prototype.hasOwnProperty.call(replacements, key)) {
            return replacements[key];
        }
        return placeholder;
    });

    const unreplaced = html.match(/{{[^}]+}}/);
    if (unreplaced) {
        throw new Error(`Unreplaced preview HTML placeholder: ${unreplaced[0]}`);
    }
    return html;
}
