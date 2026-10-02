import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import type { RenderRule } from 'markdown-it/lib/renderer.mjs';
import mila from 'markdown-it-link-attributes';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

// 引入 highlight.js 的样式
import 'highlight.js/styles/github.css';

// 引入 KaTeX 与 texmath 的样式：
// katex.min.css 负责隐藏 MathML 兜底层并修正公式排版（缺它会出现「排版版 + 纯文本版」重复显示）
// texmath.css 负责 <eq> / <eqn> / section.eqno 的布局（行内、块级、行尾编号）
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';

export const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,

  // highlight 代码高亮
  highlight(code: string, lang: string) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        // Fall back to escaped source when the language parser rejects the code.
      }
    }
    return md.utils.escapeHtml(code);
  },
})
  .use(mila, { attrs: { target: '_blank', rel: 'noopener' } }) // 链接插件
  .use(texmath, {
    engine: katex,
    delimiters: ['dollars', 'brackets'], // 'dollars' 处理 $...$ / $$...$$，'brackets' 处理 \(...\) / \[...\]
    katexOptions: { macros: { '\\RR': '\\mathbb{R}' } }, // 可选：如果你需要自定义宏
  });

// rules.fence 是 markdown-it 渲染代码块的规则，重写
const renderFence: RenderRule = (tokens, idx, options) => {
  const token = tokens[idx];
  // 获取代码语言，例如 "python", "js"
  const info = token.info ? md.utils.escapeHtml(token.info).trim() : '';
  const langName = info ? info.split(/\s+/)[0] : '';

  // 获取高亮后的代码
  const highlightedCode = options.highlight
    ? options.highlight(token.content, langName, '') || md.utils.escapeHtml(token.content)
    : md.utils.escapeHtml(token.content);

  // 返回自定义的 HTML 结构
  // 1. code-block-wrapper:以此为界限
  // 2. code-header: 顶部栏（语言名 + 复制按钮）
  // 3. hljs: 代码内容
  return `
    <div class="code-block-wrapper">
      <div class="code-header">
        <span class="code-lang">${langName}</span>
        <button class="code-copy-btn" data-clipboard-text="${md.utils.escapeHtml(token.content)}">
          <svg
            xmlns="http://www.w3.org/2000/svg" 
            width="14" height="14" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            stroke-width="2" 
            stroke-linecap="round" 
            stroke-linejoin="round"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
          Copy
        </button>
      </div>
      <pre class="hljs"><code>${highlightedCode}</code></pre>
    </div>
  `;
};

md.renderer.rules.fence = renderFence;

// 表格本身保持原生 table 布局，滚动交给外层容器处理。
// 若直接把 table 改为 block，浏览器会生成一个按内容宽度布局的匿名表格，
// 从而出现表格边框已占满、单元格却只占左侧的留白。
md.renderer.rules.table_open = () => '<div class="table-scroll-wrapper"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
