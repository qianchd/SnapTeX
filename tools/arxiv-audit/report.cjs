const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] ?? 'tex_samplecode');
const input = JSON.parse(fs.readFileSync(path.join(root, 'audit-results.json'), 'utf8'));
const samples = input.samples;
const modes = ['legacy', 'ast'];
const modeLabel = { legacy: 'Legacy', ast: 'AST' };
const md = [];

const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
const count = (values, key = value => value) => {
    const frequencies = new Map();
    for (const value of values) {
        const name = key(value);
        frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
    }
    return [...frequencies].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
};
const paperFrequency = selector => count(samples.flatMap(sample => [...new Set(selector(sample))]));
const hasPipelineFailure = result => Boolean(result?.error || result?.renderFailures?.length);
const hasMathFailure = result => Boolean(result?.katexErrors || result?.mathErrors);
const issuePapers = predicate => samples.filter(sample => modes.some(mode => predicate(sample[mode])));
const total = selector => samples.reduce((sum, sample) => sum + modes.reduce((modeSum, mode) => modeSum + (selector(sample[mode]) || 0), 0), 0);
const topRows = (title, header, rows, limit = 20) => {
    md.push(`## ${title}`, '', header, header.replace(/[^|]/g, '-'));
    for (const row of rows.slice(0, limit)) {md.push(`| ${row.map(escapeCell).join(' | ')} |`);}
    if (rows.length === 0) {md.push('| None | |');}
    md.push('');
};

const sourceFrequency = field => paperFrequency(sample => sample.source?.[field] ?? []);
const issueFrequency = field => paperFrequency(sample => modes.flatMap(mode => sample[mode]?.[field] ?? []));
const diagnostics = samples.flatMap(sample => modes.flatMap(mode => sample[mode]?.diagnostics ?? []).map(message => ({sample, message})));
const missingResources = diagnostics.filter(({message}) => /(?:not found|cannot find|could not (?:read|find)|error reading|missing)/i.test(message));
const contentDivergence = samples
    .filter(sample => sample.legacy?.visibleChars > 0 && sample.ast?.visibleChars > 0)
    .map(sample => ({sample, ratio: sample.ast.visibleChars / sample.legacy.visibleChars}))
    .filter(({ratio}) => ratio < 0.85 || ratio > 1.15);

md.push(
    '# SnapTeX arXiv source compatibility audit', '',
    `Generated: ${new Date(input.generatedAt).toISOString()}`, '',
    `Corpus: **${samples.length}** source projects, stratified across mathematics and statistics categories. Each root document was rendered block-by-block through the same \`PreviewUpdateService\` used by the applications, once with Legacy and once with AST.`, '',
    'Counts below are paper-level frequencies unless explicitly marked as occurrences. Missing files in an arXiv source bundle are reported separately from renderer defects.', '',
    '## Executive summary', '',
    '| Signal | Papers | Occurrences |',
    '|---|---:|---:|',
    `| Pipeline/render exception | ${issuePapers(hasPipelineFailure).length} | ${total(result => result?.renderFailures?.length)} |`,
    `| KaTeX/math error | ${issuePapers(hasMathFailure).length} | ${total(result => (result?.katexErrors ?? 0) + (result?.mathErrors ?? 0))} |`,
    `| Raw LaTeX environment leaked | ${issuePapers(result => result?.rawEnvironments?.length).length} | - |`,
    `| Raw LaTeX command leaked | ${issuePapers(result => result?.rawCommands?.length).length} | - |`,
    `| Legacy/AST visible-content divergence (>15%) | ${contentDivergence.length} | - |`,
    `| Unresolved citation | ${issuePapers(result => result?.unresolvedCitations).length} | ${total(result => result?.unresolvedCitations)} |`,
    `| Missing source/resource diagnostic | ${new Set(missingResources.map(({sample}) => sample.id)).size} | ${missingResources.length} |`,
    '',
    '## Backend comparison', '',
    '| Backend | Pipeline failures | Papers with math errors | Papers with raw environments | Mean blocks | Mean parse ms | Mean render ms |',
    '|---|---:|---:|---:|---:|---:|---:|'
);
for (const mode of modes) {
    const valid = samples.map(sample => sample[mode]).filter(Boolean);
    const average = field => valid.length ? valid.reduce((sum, result) => sum + (result[field] ?? 0), 0) / valid.length : 0;
    md.push(`| ${modeLabel[mode]} | ${valid.filter(hasPipelineFailure).length} | ${valid.filter(hasMathFailure).length} | ${valid.filter(result => result.rawEnvironments?.length).length} | ${average('blocks').toFixed(1)} | ${average('parseMs').toFixed(1)} | ${average('renderMs').toFixed(1)} |`);
}
md.push('');
const comparisons = [
    ['Math errors', result => (result?.katexErrors ?? 0) + (result?.mathErrors ?? 0)],
    ['Leaked environments', result => result?.rawEnvironments?.length ?? 0],
    ['Leaked commands', result => result?.rawCommands?.length ?? 0]
];
md.push('| AST comparison | Better | Equal | Worse |', '|---|---:|---:|---:|');
for (const [label, metric] of comparisons) {
    const deltas = samples.map(sample => Math.sign(metric(sample.ast) - metric(sample.legacy)));
    md.push(`| ${label} | ${deltas.filter(delta => delta < 0).length} | ${deltas.filter(delta => delta === 0).length} | ${deltas.filter(delta => delta > 0).length} |`);
}
md.push('');

topRows(
    'Visible-content divergence for browser review',
    '| arXiv | AST / Legacy visible characters | Title |',
    contentDivergence.sort((left, right) => Math.abs(1 - right.ratio) - Math.abs(1 - left.ratio))
        .map(({sample, ratio}) => [sample.id, ratio.toFixed(3), sample.title]),
    20
);

topRows(
    'Leaked environments',
    '| Environment | Affected papers | Source papers |',
    issueFrequency('rawEnvironments').map(([name, papers]) => [name, papers, new Map(sourceFrequency('environments')).get(name) ?? 0])
);
topRows(
    'Leaked commands',
    '| Command | Affected papers | Source papers |',
    issueFrequency('rawCommands').map(([name, papers]) => [name, papers, new Map(sourceFrequency('commands')).get(name) ?? 0])
);

const macroCandidates = count(samples.flatMap(sample => {
    const defined = new Set(sample.source?.macros ?? []);
    const failedCommands = modes.flatMap(mode => (sample[mode]?.katexErrorDetails ?? [])
        .flatMap(detail => [...detail.source.matchAll(/\\([A-Za-z@]+)/g)].map(match => match[1])));
    return [...new Set(failedCommands.filter(command => defined.has(command)))];
}));
topRows(
    'Custom macros present in failed formulae',
    '| Macro | Affected papers | Definition present in corpus |',
    macroCandidates.map(([name, papers]) => [name, papers, new Map(sourceFrequency('macros')).get(name) ?? 0])
);

topRows(
    'Common source structures',
    '| Environment | Papers |',
    sourceFrequency('environments').map(([name, papers]) => [name, papers]),
    30
);
topRows(
    'Common packages',
    '| Package | Papers |',
    sourceFrequency('packages').map(([name, papers]) => [name, papers]),
    30
);

md.push('## Recommended adaptation backlog', '');
const rawEnv = issueFrequency('rawEnvironments');
const rawCommand = issueFrequency('rawCommands');
const mathPapers = issuePapers(hasMathFailure).length;
const pipelinePapers = issuePapers(hasPipelineFailure).length;
const unresolvedPapers = issuePapers(result => result?.unresolvedCitations).length;
const missingBibliographyPapers = new Set(diagnostics
    .filter(({message}) => /bibliography file/i.test(message))
    .map(({sample}) => sample.id));
const citationCandidates = samples.filter(sample => modes.some(mode => sample[mode]?.unresolvedCitations)
    && !missingBibliographyPapers.has(sample.id)).length;
const recommendations = [
    ['P0', 'Pipeline stability', pipelinePapers, 'Eliminate block-level exceptions before adding syntax coverage; these can blank an otherwise valid preview region.'],
    ['P1', 'Formula and package compatibility', mathPapers, `Inspect invalid source syntax and unsupported package commands in each failed formula. Custom definitions found in the same formula (${macroCandidates.slice(0, 8).map(([name]) => `\\${name}`).join(', ') || 'none'}) are correlation signals, not automatically the cause.`],
    ['P1', 'Common leaked environments', rawEnv[0]?.[1] ?? 0, `Add or refine structural renderers for ${rawEnv.slice(0, 8).map(([name]) => name).join(', ') || 'none observed'}. Rank by affected-paper count, not raw occurrence count.`],
    ['P1', 'Backend content divergence', contentDivergence.length, 'Browser-check large Legacy/AST visible-text differences for dropped content before treating shorter AST output as an improvement.'],
    ['P2', 'Citation/reference resolution', citationCandidates, `${unresolvedPapers - citationCandidates} other papers have missing bibliography files; investigate these candidates first, where the source bundle does not report a missing bibliography.`],
    ['P2', 'Common leaked commands', rawCommand[0]?.[1] ?? 0, `Address visible command leakage headed by ${rawCommand.slice(0, 8).map(([name]) => `\\${name}`).join(', ') || 'none observed'}, preferring generic command-family handling over paper-specific replacements.`],
    ['P3', 'Template-only declarations', issuePapers(result => result?.rawCommands?.some(command => ['if', 'fi', 'renewcommand', 'def'].includes(command))).length, 'Hide or interpret top-level template switches and declarations only when they leak into visible content; do not emulate a complete TeX engine.']
].filter(([, , papers]) => papers > 0);
md.push('| Priority | Area | Affected papers | Action |', '|---|---|---:|---|');
for (const row of recommendations) {md.push(`| ${row.map(escapeCell).join(' | ')} |`);}
md.push('');

md.push('## Per-paper results', '', '| arXiv | Category | Title | Root | Legacy | AST | Notes |', '|---|---|---|---|---:|---:|---|');
for (const sample of samples) {
    const compact = result => result?.error ? 'fatal' : `${result?.katexErrors ?? 0} math, ${result?.rawEnvironments?.length ?? 0} env, ${result?.unresolvedCitations ?? 0} cite`;
    const notes = [
        sample.legacy?.renderFailures?.length ? `${sample.legacy.renderFailures.length} legacy block failures` : '',
        sample.ast?.renderFailures?.length ? `${sample.ast.renderFailures.length} AST block failures` : '',
        sample.legacy?.diagnostics?.length || sample.ast?.diagnostics?.length ? 'diagnostics present' : ''
    ].filter(Boolean).join('; ');
    md.push(`| ${escapeCell(sample.id)} | ${escapeCell(sample.sampledFrom)} | ${escapeCell(sample.title)} | ${escapeCell(sample.root)} | ${escapeCell(compact(sample.legacy))} | ${escapeCell(compact(sample.ast))} | ${escapeCell(notes)} |`);
}
md.push('', '## Interpretation limits', '',
    '- This audit verifies SnapTeX conversion and rendered HTML, not full TeX compilation fidelity.',
    '- Source archives can omit bibliography, class, image, or generated files. Those are resource diagnostics, not automatically renderer bugs.',
    '- Browser verification is applied to the highest-frequency/highest-severity findings to confirm that static HTML signals correspond to visible DOM failures.',
    '- The corpus is a deterministic recent, category-stratified sample; it estimates practical frequency but is not a statistical census of arXiv.', '');

fs.writeFileSync(path.join(root, 'AUDIT_REPORT.md'), `${md.join('\n')}\n`);
console.log(`Report written to ${path.join(root, 'AUDIT_REPORT.md')}`);
