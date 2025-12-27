import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for file system operations.
 * Allows decoupling the core logic from Node.js 'fs' module.
 */
export interface IFileProvider {
    read(filePath: string): string;
    exists(filePath: string): boolean;
    resolve(base: string, relative: string): string;
    dir(filePath: string): string;
}

/**
 * Concrete implementation using Node.js 'fs'.
 */
export class NodeFileProvider implements IFileProvider {
    read(filePath: string): string {
        return fs.readFileSync(filePath, 'utf-8');
    }

    exists(filePath: string): boolean {
        return fs.existsSync(filePath);
    }

    resolve(base: string, relative: string): string {
        // If absolute, return as is
        if (path.isAbsolute(relative)) {
            return relative;
        }
        // Join and normalize
        let target = path.join(base, relative);
        // Default to .tex if no extension provided (standard LaTeX behavior)
        if (!path.extname(target)) {
            target += '.tex';
        }
        return target;
    }

    dir(filePath: string): string {
        return path.dirname(filePath);
    }
}