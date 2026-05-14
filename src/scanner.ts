import { REGEX_STR } from './patterns';

export interface BlockNumbering {
    seq: number;
    counts: {
        eq: string[];
        fig: string[];
        tbl: string[];
        alg: string[];
        sec: string[];
        thm: string[];
    };
}

export interface ScanResult {
    blockNumbering: BlockNumbering[];
    labelMap: Record<string, string>;
}

export class LatexCounterScanner {
    private counters = {
        sec: 0, subsec: 0, subsubsec: 0,
        eq: 0, fig: 0, tbl: 0, alg: 0
    };

    // Use Record to allow dynamic keys for theorem-like environments (theorem, lemma, definition, etc.)
    private dynamicCounters: Record<string, number> = {};
    private labelMap: Record<string, string> = {};

    private getNextNumber(envName: string): string {
        const name = envName.toLowerCase();
        if (!this.dynamicCounters[name]) {
            this.dynamicCounters[name] = 0;
        }
        this.dynamicCounters[name]++;
        return String(this.dynamicCounters[name]);
    }

    public scan(blocks: string[]): ScanResult {
        this.reset();
        const results: BlockNumbering[] = [];

        const secRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\s*\\{`, 'g');
        const eqRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.MATH_ENVS})\\}(\\*?)`, 'g');
        const floatRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.FLOAT_ENVS})\\}`, 'g');
        const thmRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}`, 'g');

        blocks.forEach((text, index) => {
            const blockRes: BlockNumbering = {
                seq: index,
                counts: { eq: [], fig: [], tbl: [], alg: [], sec: [], thm: [] }
            };

            // 1. Sections
            secRegex.lastIndex = 0;
            let match;
            while ((match = secRegex.exec(text)) !== null) {
                if (match[2] === '*') {continue;}
                const type = match[1];
                if (type === 'section') {
                    this.counters.sec++; this.counters.subsec = 0; this.counters.subsubsec = 0;
                } else if (type === 'subsection') {
                    this.counters.subsec++; this.counters.subsubsec = 0;
                } else {
                    this.counters.subsubsec++;
                }
                const numStr = this.formatSec();
                blockRes.counts.sec.push(numStr);
                this.tryExtractLabel(text, match.index, numStr);
            }

            // 2. Equations
            eqRegex.lastIndex = 0;
            while ((match = eqRegex.exec(text)) !== null) {
                if (match[2] === '*') {continue;}
                this.counters.eq++;
                const numStr = String(this.counters.eq);
                blockRes.counts.eq.push(numStr);
                this.extractLabelInEnv(text, match.index, numStr, match[1]);
            }

            // 3. Floats (Figure, Table, Algorithm)
            floatRegex.lastIndex = 0;
            while ((match = floatRegex.exec(text)) !== null) {
                const type = match[1];
                let numStr = "";
                if (type === 'figure') { this.counters.fig++; numStr = String(this.counters.fig); blockRes.counts.fig.push(numStr); }
                else if (type === 'table') { this.counters.tbl++; numStr = String(this.counters.tbl); blockRes.counts.tbl.push(numStr); }
                else if (type === 'algorithm') { this.counters.alg++; numStr = String(this.counters.alg); blockRes.counts.alg.push(numStr); }

                this.extractLabelInEnv(text, match.index, numStr, type);
            }

            // 4. Theorems
            thmRegex.lastIndex = 0;
            while ((match = thmRegex.exec(text)) !== null) {
                const envName = match[1].toLowerCase();
                const numStr = this.getNextNumber(envName); // 每个环境名独立计数

                blockRes.counts.thm.push(numStr);
                this.extractLabelInEnv(text, match.index, numStr, match[1]);
            }

            results.push(blockRes);
        });

        return {
            blockNumbering: results,
            labelMap: this.labelMap
        };
    }

    private reset() {
        this.counters = { sec: 0, subsec: 0, subsubsec: 0, eq: 0, fig: 0, tbl: 0, alg: 0 };
        this.dynamicCounters = {};
        this.labelMap = {};
    }

    private formatSec() {
        let s = `${this.counters.sec}`;
        if (this.counters.subsec > 0) {s += `.${this.counters.subsec}`;}
        if (this.counters.subsubsec > 0) {s += `.${this.counters.subsubsec}`;}
        return s;
    }

    private tryExtractLabel(text: string, startIdx: number, val: string) {
        const sub = text.substring(startIdx, startIdx + 200);
        const m = sub.match(/\\label\{([^}]+)\}/);
        if (m) {this.labelMap[m[1]] = val;}
    }

    private extractLabelInEnv(text: string, startIdx: number, val: string, envName: string) {
        const sub = text.substring(startIdx);
        const endRegex = new RegExp(`\\\\end\\{${envName}\\*?\\}`);
        const endMatch = sub.match(endRegex);

        const limit = endMatch ? (endMatch.index! + endMatch[0].length) : sub.length;
        const block = sub.substring(0, limit);

        const m = block.match(/\\label\{([^}]+)\}/);
        if (m) {
            this.labelMap[m[1]] = val;
        }
    }
}