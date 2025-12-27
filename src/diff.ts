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
    /** The new text blocks that need to be inserted */
    insertedTexts: string[];
    /** The old text blocks that are being removed (useful for analysis) */
    deletedTexts: string[];
}

/**
 * Engine responsible for calculating the difference between two states of blocks.
 * Pure logic, no side effects.
 */
export class DiffEngine {
    /**
     * Computes the difference between two arrays of block texts.
     * Uses a simple prefix/suffix matching algorithm optimized for sequential editing.
     * @param oldBlockTexts The list of texts from the previous render.
     * @param newBlockTexts The list of texts from the current document state.
     */
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

        // 3. Extract diff regions
        const insertedTexts = newBlockTexts.slice(start, newBlockTexts.length - end);
        const deletedTexts = oldBlockTexts.slice(start, oldBlockTexts.length - end);
        const deleteCount = oldBlockTexts.length - start - end;

        return {
            start,
            deleteCount,
            end,
            insertedTexts,
            deletedTexts
        };
    }
}