/**
 * TeX Fast Preview 自定义配置文件
 * * 这里的规则会通过 renderer.registerPreprocessRule 动态加载。
 * 优先级 (priority) 参考：
 * - 10-40: 预处理与公式保护
 * - 50-80: 结构化环境转换
 * - 90-110: 文本样式与排版
 */

module.exports = {
    rules: [
        {
            name: 'test_rule',
            priority: 1,
            apply: (text) => text.replace(/test/g, 'SUCCESS')
        },
        // 示例 1: 支持 listings 宏包的代码块
        {
            name: 'user_listings',
            priority: 85, // 放在 floats (80) 之后
            apply: (text, renderer) => {
                const regex = /\\begin\{lstlisting\}(?:\[.*?\])?([\s\S]*?)\\end\{lstlisting\}/g;
                return text.replace(regex, (match, code) => {
                    // 使用 <pre> 标签保留代码格式
                    const safeCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `\n\n<pre class="latex-code-block"><code>${safeCode.trim()}</code></pre>\n\n`;
                });
            }
        },

        // 示例 2: 自定义 \note{...} 命令
        {
            name: 'user_note_command',
            priority: 105, // 放在 refs (100) 之后
            apply: (text, renderer) => {
                return text.replace(/\\note\{([\s\S]*?)\}/g, (match, content) => {
                    return `<span class="user-custom-note" title="Author Note">📝 ${content}</span>`;
                });
            }
        },

        // 示例 3: 保护特定的数学符号不被 Markdown 引擎干扰
        {
            name: 'user_math_protection',
            priority: 35, // 放在 display_math (30) 之后
            apply: (text, renderer) => {
                // 如果你有特殊的符号序列（如 \xcancel{...}）
                return text.replace(/\\xcancel\{([^}]+)\}/g, (match) => {
                    // 调用 renderer 提供的行内保护接口
                    return renderer.pushInlineProtected(match);
                });
            }
        }
    ]
};