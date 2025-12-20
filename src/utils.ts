/**
 * 基础工具函数库：不依赖于任何业务状态
 */

export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * 增强型 LaTeX 命令查找工具
 * 支持：\command{...}, \command[...]{...}, 以及多行嵌套
 */
export function findCommand(text: string, tagName: string) {
    // 改进正则：支持可选参数 [\s\S]*? 以及命令与左括号间的空格
    const regex = new RegExp(`\\\\${tagName}(?:\\s*\\[[\\s\\S]*?\\])?\\s*\\{`, 'g');
    const match = regex.exec(text);

    if (match) {
        const startIdx = match.index;
        const contentStart = startIdx + match[0].length;
        let depth = 1;
        let i = contentStart;

        for (; i < text.length; i++) {
            const char = text[i];
            if (char === '{' || char === '}') {
                // 校验是否为转义括号 \{ 或 \}
                let bsCount = 0;
                let j = i - 1;
                while (j >= 0 && text[j] === '\\') { bsCount++; j--; }
                const isEscaped = bsCount % 2 !== 0;

                if (!isEscaped) {
                    if (char === '{') depth++;
                    else depth--;
                }
            }
            if (depth === 0) break;
        }

        if (depth === 0) {
            return {
                content: text.substring(contentStart, i).trim(),
                start: startIdx,
                end: i // 闭合花括号的位置
            };
        }
    }
    return undefined;
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
