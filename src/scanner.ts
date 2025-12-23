import { toRoman } from './utils';

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
        eq: 0, fig: 0, tbl: 0, alg: 0, thm: 0
    };
    private labelMap: Record<string, string> = {};

    public scan(blocks: string[]): ScanResult {
        this.reset();
        const results: BlockNumbering[] = [];

        blocks.forEach((text, index) => {
            const blockRes: BlockNumbering = {
                seq: index,
                counts: { eq: [], fig: [], tbl: [], alg: [], sec: [], thm: [] }
            };

            // 1. Sections
            const secRegex = /\\(section|subsection|subsubsection)(\*?)\s*\{/g;
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
            const eqRegex = /\\begin\{(equation|align|gather|multline|flalign)\}(\*?)/g;
            while ((match = eqRegex.exec(text)) !== null) {
                if (match[2] === '*') {continue;}
                this.counters.eq++;
                const numStr = String(this.counters.eq);
                blockRes.counts.eq.push(numStr);
                this.extractLabelInEnv(text, match.index, numStr);
            }

            // 3. Floats
            const floatRegex = /\\begin\{(figure|table|algorithm)\}/g;
            while ((match = floatRegex.exec(text)) !== null) {
                const type = match[1];
                let numStr = "";
                if (type === 'figure') { this.counters.fig++; numStr = String(this.counters.fig); blockRes.counts.fig.push(numStr); }
                else if (type === 'table') { this.counters.tbl++; numStr = String(this.counters.tbl); blockRes.counts.tbl.push(numStr); }
                else if (type === 'algorithm') { this.counters.alg++; numStr = String(this.counters.alg); blockRes.counts.alg.push(numStr); }

                this.extractLabelInEnv(text, match.index, numStr);
            }

            // 4. Theorems & Conditions (FIXED)
            // Added: condition, assumption, remark, example...
            const thmRegex = /\\begin\{(theorem|lemma|proposition|definition|corollary|condition|condbis|assumption|remark|example)\}/g;
            while ((match = thmRegex.exec(text)) !== null) {
                this.counters.thm++;
                const numStr = String(this.counters.thm);
                blockRes.counts.thm.push(numStr);
                this.extractLabelInEnv(text, match.index, numStr);
            }

            results.push(blockRes);
        });

        return { blockNumbering: results, labelMap: this.labelMap };
    }

    private reset() {
        this.counters = { sec: 0, subsec: 0, subsubsec: 0, eq: 0, fig: 0, tbl: 0, alg: 0, thm: 0 };
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

    private extractLabelInEnv(text: string, startIdx: number, val: string) {
        const sub = text.substring(startIdx);
        const endMatch = sub.match(/\\end\{[^}]+\}/);
        const limit = endMatch ? endMatch.index! : sub.length;
        const block = sub.substring(0, limit);
        const m = block.match(/\\label\{([^}]+)\}/);
        if (m) {this.labelMap[m[1]] = val;}
    }
}