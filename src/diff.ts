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

export interface HashComparable {
    hash: string;
}

/**
 * Engine responsible for calculating the difference between two states of blocks.
 * Pure logic, no side effects, zero array allocations.
 */
export class DiffEngine {
    public static compute(oldBlocks: readonly HashComparable[], newBlocks: readonly HashComparable[]): DiffResult {
        let start = 0;
        const minLen = Math.min(newBlocks.length, oldBlocks.length);

        // 1. Scan from start (Prefix Match)
        while (start < minLen && newBlocks[start].hash === oldBlocks[start].hash) {
            start++;
        }

        // 2. Scan from end (Suffix Match)
        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, newBlocks.length - start);

        while (end < maxEnd) {
            const oldTail = oldBlocks[oldBlocks.length - 1 - end];
            const newTail = newBlocks[newBlocks.length - 1 - end];
            if (oldTail.hash !== newTail.hash) {
                break;
            }
            end++;
        }

        // 3. Return only indices, avoid array slicing
        return {
            start,
            deleteCount: oldBlocks.length - start - end,
            end,
            insertCount: newBlocks.length - start - end
        };
    }
}
