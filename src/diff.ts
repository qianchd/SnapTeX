/**
 * Result of the diff computation.
 */
export interface DiffResult {
    /** Index in the OLD array where divergence begins */
    start: number;
    /** Number of blocks to delete from the OLD array (starting at 'start') */
    deleteCount: number;
    /** Number of matching blocks at the end of both arrays */
    end: number;
    /** Number of new blocks to insert from the NEW array */
    insertCount: number;
}

/**
 * Engine responsible for calculating the difference between two states of blocks.
 * Pure logic, no side effects, zero array allocations.
 */
export class DiffEngine {
    public static compute(oldBlockTexts: string[], newBlockTexts: string[]): DiffResult {
        let start = 0;
        const minLen = Math.min(newBlockTexts.length, oldBlockTexts.length);

        // 1. Scan from start (Prefix Match)
        while (start < minLen && newBlockTexts[start] === oldBlockTexts[start]) {
            start++;
        }

        // 2. Scan from end (Suffix Match)
        let end = 0;
        const maxEnd = Math.min(oldBlockTexts.length - start, newBlockTexts.length - start);

        while (end < maxEnd) {
            const oldTail = oldBlockTexts[oldBlockTexts.length - 1 - end];
            const newTail = newBlockTexts[newBlockTexts.length - 1 - end];
            if (oldTail !== newTail) {
                break;
            }
            end++;
        }

        // 3. Return only indices, avoid array slicing
        return {
            start,
            deleteCount: oldBlockTexts.length - start - end,
            end,
            insertCount: newBlockTexts.length - start - end
        };
    }
}