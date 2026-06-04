export interface DiffResult {
    start: number;
    deleteCount: number;
    end: number;
    insertCount: number;
}

export interface HashComparable {
    hash: string;
}

/**
 * Computes the single changed window between old and new block-hash snapshots.
 */
export class DiffEngine {
    public static compute(oldBlocks: readonly HashComparable[], newBlocks: readonly HashComparable[]): DiffResult {
        let start = 0;
        const minLen = Math.min(newBlocks.length, oldBlocks.length);

        while (start < minLen && newBlocks[start].hash === oldBlocks[start].hash) {
            start++;
        }

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

        return {
            start,
            deleteCount: oldBlocks.length - start - end,
            end,
            insertCount: newBlocks.length - start - end
        };
    }
}
