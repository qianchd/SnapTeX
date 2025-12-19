/**
 * 基础工具函数库：不依赖于任何业务状态
 */

export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * 将数字转换为罗马数字
 * @param num 需要转换的阿拉伯数字
 * @param uppercase 是否返回大写形式
 */
export function toRoman(num: number, uppercase: boolean = false): string {
    const lookup: [string, number][] = [
        ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
        ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
        ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
    ];
    let roman = '';
    let tempNum = num;
    for (const [letter, value] of lookup) {
        while (tempNum >= value) {
            roman += letter;
            tempNum -= value;
        }
    }
    return uppercase ? roman : roman.toLowerCase();
}

export function applyStyleToTexList(startTag: string, endTag: string, content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.some(line => /^\s*([-*+]|\d+\.)\s/.test(line))) {
        return lines.map(line => {
            const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
            if (listMatch) {
                const [_, indent, bullet, innerText] = listMatch;
                return `${indent}${bullet} ${startTag}${innerText}${endTag}`;
            } else {
                return line.trim().length > 0 ? `${startTag}${line}${endTag}` : line;
            }
        }).join('\n');
    }
    return `${startTag}${content}${endTag}`;
}

// 以后还可以放：时间格式化、颜色转换、复杂的字符串清洗等
