export interface DiffResult {
    start: number;
    deleteCount: number;
    end: number;
    insertCount: number;
}

interface HashComparable {
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

    public static rebuildArray<T>(
        oldItems: readonly T[],
        newLength: number,
        diff: DiffResult,
        createChanged: (newIndex: number) => T,
        reuseUnchanged: (oldItem: T, newIndex: number) => T
    ): T[] {
        const next: T[] = new Array(newLength);
        const changedEnd = diff.start + diff.insertCount;
        const suffixOffset = diff.deleteCount - diff.insertCount;

        for (let index = 0; index < diff.start; index++) {
            next[index] = reuseUnchanged(oldItems[index], index);
        }

        for (let index = diff.start; index < changedEnd; index++) {
            next[index] = createChanged(index);
        }

        for (let index = changedEnd; index < newLength; index++) {
            next[index] = reuseUnchanged(oldItems[index + suffixOffset], index);
        }

        return next;
    }
}
