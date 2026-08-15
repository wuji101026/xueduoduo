
/* ==================== 主程序 ==================== */

        const {
            useState,
            useEffect,
            useLayoutEffect,
            useRef,
            useContext,
            createContext,
            createRef,
            useMemo,
            useCallback
        } = React;

        // ============================================================
        // 1. LaTeX 渲染辅助组件（使用 KaTeX.renderToString，离线/动态内容均可靠）
        // ============================================================
        const escapeHtml = (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        /**
         * 将包含 LaTeX 分隔符的文本转为带 KaTeX 渲染结果的 HTML 字符串。
         * 支持：$$...$$（块级）、\[...\]（块级）、\(...\)（行内）、$...$（行内）。
         */
        // 渲染底层优化：按输入字符串缓存 KaTeX 渲染结果，避免列表（错题/收藏/题库）中重复文本反复 renderToString
        const _latexCache = new Map();
        const latexToHtml = (text) => {
            if (typeof text !== 'string') return escapeHtml(text);
            if (_latexCache.has(text)) return _latexCache.get(text);
            const katex = window.katex;
            if (!katex || typeof katex.renderToString !== 'function') {
                return escapeHtml(text); // KaTeX 未加载时降级为纯文本
            }
            const regex = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\$\n]+?)\$/g;
            let result = '';
            let last = 0;
            let m;
            while ((m = regex.exec(text)) !== null) {
                result += escapeHtml(text.slice(last, m.index));
                let tex, display;
                if (m[1] !== undefined) { tex = m[1]; display = true; }
                else if (m[2] !== undefined) { tex = m[2]; display = true; }
                else if (m[3] !== undefined) { tex = m[3]; display = false; }
                else { tex = m[4]; display = false; }
                try {
                    result += katex.renderToString(tex, {
                        displayMode: display,
                        throwOnError: false,
                        errorColor: '#ff4b4b',
                    });
                } catch (e) {
                    result += escapeHtml((display ? '$$' : '$') + tex + (display ? '$$' : '$'));
                }
                last = regex.lastIndex;
            }
            result += escapeHtml(text.slice(last));
            if (_latexCache.size > 2000) { let _n = 0; for (const _k of _latexCache.keys()) { _latexCache.delete(_k); if (++_n >= 400) break; } } // LRU：超限时仅淘汰最旧 400 条，避免整清空触发全量重渲染
            _latexCache.set(text, result);
            return result;
        };

        // ============================================================
        // Markdown + 表格渲染管线（在 latexToHtml 之上叠加 GFM 解析）
        // 支持：GFM 表格(含对齐) / 标题 / 有序·无序列表(二级) / 引用 /
        //       围栏代码 / 行内代码 / 粗体·斜体·删除线 / 链接 / 公式(KaTeX)。
        // 同时兼容 AI 直接吐出的原始 HTML <table> 块（已做轻量净化）。
        // ============================================================
        const _mdCache = new Map();
        function mdToHtml(input) {
            if (input == null) return '';
            const key = String(input);
            if (key.trim() === '') return '';
            if (_mdCache.has(key)) return _mdCache.get(key);
            const Z = '\u0001'; // 占位符分隔符（私有区控制字符，不会出现在正常文本中）
            let src = key;
            const esc = escapeHtml;

            // 1) 抽取原始 HTML <table> 块（清理事件属性与危险协议，避免 XSS）
            const htmlTables = [];
            src = src.replace(/<table[\s\S]*?<\/table>/gi, (m) => {
                const s = m
                    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
                    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
                    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
                    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
                htmlTables.push(s);
                return Z + 'T' + (htmlTables.length - 1) + Z;
            });

            // 2) 抽取围栏代码块 ``` ```
            const codeBlocks = [];
            src = src.replace(/```(?:[a-zA-Z0-9_+\-]*\n)?([\s\S]*?)```/g, (m, code) => {
                codeBlocks.push(String(code).replace(/^\n/, '').replace(/\n$/, ''));
                return Z + 'C' + (codeBlocks.length - 1) + Z;
            });

            // 3) 抽取公式（必须在转义前，保留原始 $...$）
            const maths = [];
            src = src.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\$\n]+?)\$/g,
                (full) => { maths.push(full); return Z + 'M' + (maths.length - 1) + Z; });

            // 4) 转义其余 HTML（防止普通文本里的 < > & 破坏结构）
            src = esc(src);

            // 5) 抽取行内代码 `code`
            const inlines = [];
            src = src.replace(/`([^`\n]+)`/g, (m, c) => { inlines.push(c); return Z + 'I' + (inlines.length - 1) + Z; });

            // 行内格式化：链接 / 粗体 / 斜体 / 删除线（占位符不受影响）
            const inline = (t) => {
                if (t == null) return '';
                t = String(t);
                t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
                    (m, txt, url) => '<a class="md-a" href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>');
                t = t.replace(/(?<![\w*])\*\*([^*\n]+?)\*\*(?![\w*])/g, '<strong>$1</strong>');
                t = t.replace(/(?<![\w])__([^_\n]+?)__(?![\w])/g, '<strong>$1</strong>');
                t = t.replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, '<em>$1</em>');
                t = t.replace(/(?<![\w])_([^_\n]+?)_(?![\w])/g, '<em>$1</em>');
                t = t.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
                return t;
            };

            const isTableSep = (s) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.indexOf('-') >= 0;
            const splitRow = (s) => {
                s = s.trim();
                if (s.startsWith('|')) s = s.slice(1);
                if (s.endsWith('|')) s = s.slice(0, -1);
                return s.split('|').map((c) => c.trim());
            };
            const ZT = new RegExp('^' + Z + 'T\\d+' + Z + '$');
            const ZC = new RegExp('^' + Z + 'C\\d+' + Z + '$');
            const ZCT = new RegExp('^' + Z + '[CT]\\d+' + Z + '$');

            const lines = src.split(/\r?\n/);
            const out = [];
            let i = 0;
            while (i < lines.length) {
                const line = lines[i];
                const trimmed = line.trim();

                if (ZT.test(trimmed) || ZC.test(trimmed)) { out.push(trimmed); i++; continue; }
                if (trimmed === '') { i++; continue; }

                const hm = /^(#{1,6})\s+(.*)$/.exec(trimmed);
                if (hm) { const lvl = hm[1].length; out.push('<h' + lvl + ' class="md-h">' + inline(hm[2]) + '</h' + lvl + '>'); i++; continue; }

                if (/^\s*([-*_])\1{2,}\s*$/.test(trimmed)) { out.push('<hr class="md-hr">'); i++; continue; }

                // GFM 表格：当前行含 | 且下一行是分隔行
                if (trimmed.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
                    const headers = splitRow(trimmed);
                    const aligns = splitRow(lines[i + 1].trim()).map((c) => {
                        const l = c.startsWith(':'), r = c.endsWith(':');
                        return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
                    });
                    i += 2;
                    let body = '';
                    while (i < lines.length && lines[i].trim().indexOf('|') >= 0 && lines[i].trim() !== '') {
                        const cells = splitRow(lines[i].trim());
                        body += '<tr>' + cells.map((c, ci) =>
                            '<td' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inline(c) + '</td>').join('') + '</tr>';
                        i++;
                    }
                    const thead = '<thead><tr>' + headers.map((c, ci) =>
                        '<th' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inline(c) + '</th>').join('') + '</tr></thead>';
                    out.push('<table class="md-table">' + thead + '<tbody>' + body + '</tbody></table>');
                    continue;
                }

                if (/^\s*&gt;\s?/.test(trimmed)) {
                    const buf = [];
                    while (i < lines.length && /^\s*&gt;\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^\s*&gt;\s?/, '')); i++; }
                    out.push('<blockquote class="md-quote">' + inline(buf.join('<br>')) + '</blockquote>');
                    continue;
                }

                if (/^\s*([-*+]|\d+\.)\s+/.test(trimmed)) {
                    const ordered = /^\s*\d+\.\s+/.test(trimmed);
                    const items = [];
                    while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i].trim())) {
                        let item = lines[i].trim().replace(/^\s*([-*+]|\d+\.)\s+/, '');
                        const sub = [];
                        i++;
                        while (i < lines.length && /^\s{2,}([-*+]|\d+\.)\s+/.test(lines[i])) {
                            sub.push(lines[i].trim().replace(/^\s*([-*+]|\d+\.)\s+/, ''));
                            i++;
                        }
                        let li = inline(item);
                        if (sub.length) li += '<ul class="md-ul">' + sub.map((s) => '<li>' + inline(s) + '</li>').join('') + '</ul>';
                        items.push('<li>' + li + '</li>');
                    }
                    out.push((ordered ? '<ol class="md-ol">' : '<ul class="md-ul">') + items.join('') + (ordered ? '</ol>' : '</ul>'));
                    continue;
                }

                // 段落：合并连续行（保留换行），直到遇到块级起始
                const para = [];
                while (i < lines.length && lines[i].trim() !== '' &&
                    !/^\s*>\s?/.test(lines[i].trim()) &&
                    !/^\s*([-*+]|\d+\.)\s+/.test(lines[i].trim()) &&
                    !/^(#{1,6})\s+/.test(lines[i].trim()) &&
                    !ZCT.test(lines[i].trim()) &&
                    !(lines[i].trim().indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) &&
                    !/^\s*([-*_])\1{2,}\s*$/.test(lines[i].trim())) {
                    para.push(lines[i].trim());
                    i++;
                }
                if (para.length) out.push('<p class="md-p">' + para.map(inline).join('<br>') + '</p>');
            }

            let html = out.join('\n');
            html = html.replace(new RegExp(Z + 'C(\\d+)' + Z, 'g'), (m, n) => '<pre class="md-pre"><code>' + esc(codeBlocks[+n]) + '</code></pre>');
            html = html.replace(new RegExp(Z + 'I(\\d+)' + Z, 'g'), (m, n) => '<code class="md-code">' + inlines[+n] + '</code>');
            html = html.replace(new RegExp(Z + 'M(\\d+)' + Z, 'g'), (m, n) => latexToHtml(maths[+n]));
            html = html.replace(new RegExp(Z + 'T(\\d+)' + Z, 'g'), (m, n) => htmlTables[+n]);

            if (_mdCache.size > 600) { let _n = 0; for (const _k of _mdCache.keys()) { _mdCache.delete(_k); if (++_n >= 120) break; } } // LRU：超限时仅淘汰最旧 120 条
            _mdCache.set(key, html);
            return html;
        }

        /**
         * RichSpan - 渲染可能包含 Markdown / 表格 / LaTeX 公式的自由文本
         * 用于 AI 解答、AI 评语、题目解析等富文本场景（块级，自带 .md-content 容器）。
         */
        const RichSpan = React.memo(({ children, className, style }) => {
            let text = children;
            if (Array.isArray(children)) text = children.filter((c) => typeof c === 'string' || typeof c === 'number').join('');
            else if (typeof children !== 'string' && typeof children !== 'number') text = '';
            return React.createElement('div', {
                className: 'md-content' + (className ? ' ' + className : ''),
                style,
                dangerouslySetInnerHTML: { __html: mdToHtml(text) },
            });
        });

        /**
         * LatexSpan - 渲染可能包含 LaTeX 公式的文本
         * 用法：<LatexSpan>{text}</LatexSpan> 或 <LatexSpan>{[a, b, c]}</LatexSpan>
         * 采用 katex.renderToString 直接产出 HTML，避免 auto-render 修改 DOM 与 React 重渲染冲突。
         */
        const LatexSpan = React.memo(({ children, className, style, as: Tag = 'span' }) => {
            const renderNodes = (child, keyPrefix) => {
                if (child == null || child === false || child === true) return null;
                if (typeof child === 'string') {
                    return React.createElement('span', {
                        key: keyPrefix,
                        dangerouslySetInnerHTML: { __html: latexToHtml(child) },
                    });
                }
                if (typeof child === 'number') {
                    return React.createElement('span', {
                        key: keyPrefix,
                        dangerouslySetInnerHTML: { __html: latexToHtml(String(child)) },
                    });
                }
                if (Array.isArray(child)) {
                    return child.map((c, i) => renderNodes(c, keyPrefix + '-' + i));
                }
                return child; // 已是 React 元素，原样返回
            };
            return React.createElement(Tag, { className, style }, renderNodes(children, 'lx'));
        });

        /**
         * LatexAnswerPreview - 用户作答时的 LaTeX 实时预览（边写边渲染）。
         * 仅在内容非空时渲染，复用上面的 latexToHtml。
         */
        const LatexAnswerPreview = React.memo(({ value }) => {
            const [, forceUpdate] = useState(0);
            useEffect(() => {
                if (window.katex) return;
                // KaTeX 可能尚未就绪，短暂轮询直到可用或超时（兜底，避免首次渲染空白）
                let n = 0;
                const timer = setInterval(() => {
                    n += 1;
                    if (window.katex || n >= 25) {
                        clearInterval(timer);
                        forceUpdate(v => v + 1);
                    }
                }, 100);
                return () => clearInterval(timer);
            }, []);
            if (value == null || !String(value).trim()) return null;
            return React.createElement("div", {
                className: "latex-answer-preview",
                dangerouslySetInnerHTML: { __html: latexToHtml(String(value)) },
            });
        });

        // ============================================================
        // 1.1 LaTeX 代码高亮
        // ============================================================
        // 把 LaTeX 源码按语法着色：\命令 / 花括号 / 数学定界符 $ / 数字 / 上下标 / 注释
        const _escapeHtmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const highlightLatex = (src) => {
            if (src == null || src === '') return '';
            const text = String(src);
            const n = text.length;
            let out = '';
            let i = 0;
            while (i < n) {
                const ch = text[i];
                // 注释：% 到行尾
                if (ch === '%') {
                    let j = i;
                    while (j < n && text[j] !== '\n') j++;
                    out += '<span class="lx-comment">' + _escapeHtmlText(text.slice(i, j)) + '</span>';
                    i = j;
                    continue;
                }
                // 数学定界符：$$  \[  \]  \(  \)  $
                if (ch === '$') {
                    if (text[i + 1] === '$') { out += '<span class="lx-delim">$$</span>'; i += 2; continue; }
                    out += '<span class="lx-delim">$</span>'; i += 1; continue;
                }
                if (ch === '\\' && (text[i + 1] === '[' || text[i + 1] === ']' || text[i + 1] === '(' || text[i + 1] === ')')) {
                    out += '<span class="lx-delim">\\' + text[i + 1] + '</span>'; i += 2; continue;
                }
                // 命令：\ + 字母序列
                if (ch === '\\') {
                    let j = i + 1;
                    while (j < n && /[A-Za-z]/.test(text[j])) j++;
                    out += '<span class="lx-cmd">\\' + _escapeHtmlText(text.slice(i + 1, j)) + '</span>';
                    i = j;
                    continue;
                }
                // 花括号 / 方括号（定界符高亮）
                if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
                    out += '<span class="lx-brace">' + ch + '</span>'; i += 1; continue;
                }
                // 上 / 下标
                if (ch === '^' || ch === '_') { out += '<span class="lx-sup">' + ch + '</span>'; i += 1; continue; }
                // 数字（含小数）
                if (ch >= '0' && ch <= '9') {
                    let j = i;
                    while (j < n && ((text[j] >= '0' && text[j] <= '9') || text[j] === '.')) j++;
                    out += '<span class="lx-num">' + _escapeHtmlText(text.slice(i, j)) + '</span>';
                    i = j;
                    continue;
                }
                out += _escapeHtmlText(ch);
                i += 1;
            }
            // 末尾换行时补一个空格，避免最后一行在 overlay 中少显示一行
            if (text.charAt(n - 1) === '\n') out += ' ';
            return out;
        };

        // 编辑器内联高亮输入框：透明文字的 input/textarea + 背后同款排版的彩色 token 层
        const LatexField = React.memo(({ tag = 'textarea', rows, placeholder, className, value, onChange, disabled, ...rest }) => {
            const inputRef = useRef(null);
            const hlRef = useRef(null);
            const syncScroll = useCallback(() => {
                const inp = inputRef.current, hl = hlRef.current;
                if (!inp || !hl) return;
                hl.scrollTop = inp.scrollTop;
                hl.scrollLeft = inp.scrollLeft;
            }, []);
            useEffect(() => { syncScroll(); });
            const safeValue = value == null ? '' : String(value);
            const html = highlightLatex(safeValue);
            const Tag = tag === 'input' ? 'input' : 'textarea';
            const inputProps = {
                ref: inputRef,
                className: 'input-field latex-input' + (className ? ' ' + className : ''),
                'data-latex': '1',
                value: safeValue,
                onChange: onChange || undefined,
                placeholder: placeholder,
                disabled: disabled || undefined,
                onScroll: syncScroll,
                spellCheck: false,
            };
            if (tag === 'textarea' && rows != null) inputProps.rows = rows;
            if (tag === 'input' && !rest.type) rest.type = 'text';
            Object.keys(rest).forEach(k => { if (rest[k] !== undefined) inputProps[k] = rest[k]; });
            return React.createElement('div', { className: 'latex-field' },
                React.createElement('div', {
                    className: 'latex-highlight ' + (tag === 'input' ? 'latex-hl-pre' : 'latex-hl-wrap'),
                    ref: hlRef,
                    'aria-hidden': 'true',
                    dangerouslySetInnerHTML: { __html: html },
                }),
                React.createElement(Tag, inputProps)
            );
        });

        // ============================================================
        // 2. 主题管理 (不变)
        // ============================================================
        const ThemeContext = createContext();
        const ThemeProvider = ({ children }) => {
            const [isDark, setIsDark] = useState(() => {
                const saved = localStorage.getItem('theme');
                if (saved) return saved === 'dark';
                return true;
            });
            useEffect(() => {
                document.documentElement.classList.toggle('dark', isDark);
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
            }, [isDark]);
            const toggleTheme = useCallback(() => setIsDark(prev => !prev), []);
            const themeValue = useMemo(() => ({ isDark, toggleTheme }), [isDark, toggleTheme]);
            return React.createElement(ThemeContext.Provider, { value: themeValue }, children);
        };
        const useTheme = () => useContext(ThemeContext);

        // ============================================================
        // 3. 工具函数 (不变)
        // ============================================================
        const generateId = () => Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const loadData = (key, def) => {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : def;
            } catch { return def; }
        };
        const saveData = (key, val) => {
            try { localStorage.setItem(key, JSON.stringify(val)); } catch (err) { console.warn('保存失败：', key, err && err
                    .message); }
        };
        // 节流持久化：高频变化的状态（如学习计时每秒递增）合并落盘，避免每秒同步写 localStorage 造成卡顿/耗电
        const _saveBucket = {};   // key -> 最新序列化字符串
        const _saveTimer = {};    // key -> setTimeout id
        let _suspendSave = false; // 恢复出厂设置时置 true：暂停一切落盘，防止旧数据被写回 localStorage
        const _SAVE_THROTTLE_MS = 10000;
        const throttledSave = (key, val) => {
            if (_suspendSave) return;
            try { _saveBucket[key] = JSON.stringify(val); } catch (e) { return; }
            if (_saveTimer[key]) return;
            _saveTimer[key] = setTimeout(() => {
                if (_suspendSave) { _saveTimer[key] = null; return; }
                _saveTimer[key] = null;
                try {
                    if (_saveBucket[key] != null) {
                        localStorage.setItem(key, _saveBucket[key]);
                        _saveBucket[key] = null;
                    }
                } catch (e) {}
            }, _SAVE_THROTTLE_MS);
        };
        const flushSave = (key) => {
            if (_suspendSave) return;
            if (_saveTimer[key]) { clearTimeout(_saveTimer[key]); _saveTimer[key] = null; }
            if (_saveBucket[key] != null) {
                try { localStorage.setItem(key, _saveBucket[key]); } catch (e) {}
                _saveBucket[key] = null;
            }
        };
        // 把当前所有「节流中」的改动立即落盘，供导出备份前调用，避免拿到过期数据
        // （如 duo_stats 的等级/🔥 滞后最多 10s，导致恢复后等级、连胜天数没回来）
        const flushAllSaves = () => {
            Object.keys(_saveBucket).forEach(k => { if (_saveBucket[k] != null) flushSave(k); });
        };

        const readFileText = file => new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(r.error);
            r.readAsText(file);
        });

        // ============================================================
        // 3.1 导出 / 导入加密备份（密码派生 ChaCha20 密钥，覆盖全部本地数据）
        // ============================================================
        const BACKUP_KEY_RE = /^(duo_|api_|deepseek_key|theme|ai_temperature|xdd_music_|xdd_loud_|xdd_countdown_)/;


        // 由密码 + 盐派生 32 字节 ChaCha20 密钥（PBKDF2 风格多轮拉伸，rounds 可随版本演进）

        // 音乐本地音频（IndexedDB）辅助：播放器与备份共用
        const openMusicDB = () => new Promise((resolve, reject) => {
            const req = indexedDB.open('xdd_music', 1);
            req.onupgradeneeded = () => { try { req.result.createObjectStore('files', { keyPath: 'id' }); } catch (e) {} };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const idbPut = async (rec) => {
            try { const db = await openMusicDB(); await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(rec); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); } catch (e) {}
        };
        const idbGetAll = async () => {
            try { const db = await openMusicDB(); return await new Promise((res, rej) => { const tx = db.transaction('files', 'readonly'); const r = tx.objectStore('files').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(tx.error); }); } catch (e) { return []; }
        };
        const idbDelete = async (id) => {
            try { const db = await openMusicDB(); await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); } catch (e) {}
        };
        const idbClearMusic = async () => {
            try { const db = await openMusicDB(); await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); } catch (e) {}
        };
        const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
        const dataUrlToBlob = async (dataUrl) => { const r = await fetch(dataUrl); return await r.blob(); };
        // ===== 拖拽导入通用工具：把 dataTransfer 里的「文件 / 文件夹」递归展开为扁平 File 列表 =====
        // 浏览器拖入文件夹时 dt.files 为空，必须走 webkitGetAsEntry / mozGetAsEntry 遍历目录条目
        const isAudioFile = (f) => !!(f && f.name && ((f.type && f.type.startsWith('audio')) || /\.(mp3|wav|ogg|m4a|flac|aac|opus|webm|mp4|m4p)$/i.test(f.name)));
        const isJsonFile = (f) => !!(f && f.name && (/\.json$/i.test(f.name) || ((f.type || '').indexOf('json') >= 0)));

        // ===== 音频元数据解析：从文件字节读取 ID3 标签（歌手/标题/专辑） =====
        // 浏览器原生 <audio> 不暴露 ID3 文本帧，必须自行解析；文件管理器（Windows 资源管理器）能看到歌手名正是因为读了这些标签。
        const decodeLatin1 = (bytes) => {
            let s = '';
            for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
            return s.replace(/\0+$/, '').trim();
        };
        const decodeId3Text = (bytes, enc) => {
            if (!bytes || !bytes.length) return '';
            let end = bytes.length;
            while (end > 0 && bytes[end - 1] === 0) end--;   // 去掉结尾空字节
            const arr = bytes.subarray(0, end);
            if (!arr.length) return '';
            try {
                if (enc === 3) return new TextDecoder('utf-8').decode(arr);   // UTF-8
                if (enc === 1 || enc === 2) {                                  // UTF-16（带 BOM）/ UTF-16BE
                    let b = arr, le = (enc === 1 ? false : false);
                    if (b.length >= 2) {
                        if (b[0] === 0xFE && b[1] === 0xFF) { le = false; b = b.subarray(2); }       // BE BOM
                        else if (b[0] === 0xFF && b[1] === 0xFE) { le = true; b = b.subarray(2); }   // LE BOM
                    }
                    if (enc === 2) le = false;                                 // UTF-16BE 无 BOM
                    if (b.length % 2) b = b.subarray(0, b.length - 1);
                    const units = [];
                    for (let i = 0; i + 1 < b.length; i += 2) {
                        const lo = b[i], hi = b[i + 1];
                        // BE：高字节在前 => (lo<<8)|hi；LE：低字节在前 => (hi<<8)|lo
                        units.push(le ? ((hi << 8) | lo) : ((lo << 8) | hi));
                    }
                    return String.fromCharCode.apply(null, units);
                }
                return decodeLatin1(arr);                                       // enc 0：ISO-8859-1
            } catch (e) { return decodeLatin1(arr); }
        };
        const parseAudioMeta = (file) => new Promise((resolve) => {
            if (!file || typeof file.slice !== 'function') return resolve({ artist: '', title: '' });
            const HEAD = 256 * 1024;                                          // 前 256KB 足够覆盖 ID3v2 头部与文本帧
            const reads = [file.slice(0, Math.min(HEAD, file.size))];
            reads.push(file.size > 128 ? file.slice(Math.max(0, file.size - 128), file.size) : file.slice(0, 0)); // 末尾 128B（ID3v1 兜底）
            Promise.all(reads.map(b => new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.onerror = () => rej(fr.error);
                fr.readAsArrayBuffer(b);
            }))).then((bufs) => {
                try {
                    const head = new Uint8Array(bufs[0]);
                    let artist = '', title = '';
                    // ---- ID3v2 ----
                    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // "ID3"
                        const ver = head[3];
                        let size = 0;
                        for (let i = 6; i <= 9; i++) size = (size << 7) | (head[i] & 0x7f);  // 同步安全整数
                        const start = 10, end = Math.min(start + size, head.length);
                        let p = start;
                        while (p + 6 <= end) {
                            let id, frameSize, headerLen;
                            if (ver === 2) {
                                id = '';
                                for (let i = 0; i < 3; i++) id += String.fromCharCode(head[p + i]);
                                if (!/^[A-Z0-9]{3}$/.test(id)) break;
                                frameSize = (head[p + 3] << 16) | (head[p + 4] << 8) | head[p + 5];
                                headerLen = 6;
                            } else {
                                id = '';
                                for (let i = 0; i < 4; i++) id += String.fromCharCode(head[p + i]);
                                if (!/^[A-Za-z0-9]{3,4}$/.test(id)) break;
                                if (ver === 4) {
                                    frameSize = 0;
                                    for (let i = 0; i < 4; i++) frameSize = (frameSize << 7) | (head[p + 4 + i] & 0x7f);
                                } else {
                                    frameSize = (head[p + 4] << 24) | (head[p + 5] << 16) | (head[p + 6] << 8) | head[p + 7];
                                }
                                headerLen = 10;
                            }
                            if (frameSize <= 0 || p + headerLen + frameSize > end) break;
                            const bodyStart = p + headerLen;
                            if (id === 'TPE1' || id === 'TPE2' || id === 'TOPE' || id === 'TIT2' || id === 'TALB') {
                                const txt = decodeId3Text(head.subarray(bodyStart + 1, bodyStart + frameSize), head[bodyStart]);
                                if ((id === 'TPE1' || id === 'TPE2' || id === 'TOPE') && !artist) artist = txt;
                                else if (id === 'TIT2' && !title) title = txt;
                            }
                            p = bodyStart + frameSize;
                        }
                    }
                    // ---- ID3v1 兜底 ----
                    if ((!artist || !title) && bufs[1]) {
                        const tail = new Uint8Array(bufs[1]);
                        if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) { // "TAG"
                            const t = decodeLatin1(tail.subarray(3, 33));
                            const a = decodeLatin1(tail.subarray(33, 63));
                            if (!title) title = t;
                            if (!artist) artist = a;
                        }
                    }
                    resolve({ artist: (artist || '').trim(), title: (title || '').trim() });
                } catch (e) { resolve({ artist: '', title: '' }); }
            }).catch(() => resolve({ artist: '', title: '' }));
        });
        const getEntryFromItem = (it) => {
            if (!it) return null;
            try { if (it.webkitGetAsEntry) return it.webkitGetAsEntry(); } catch (e) {}
            try { if (it.getAsEntry) return it.getAsEntry(); } catch (e) {}
            try { if (it.mozGetAsEntry) return it.mozGetAsEntry(); } catch (e) {}
            return null;
        };
        const collectEntries = (entries) => new Promise(resolve => {
            const out = [];
            let pending = 0, done = false;
            const settle = () => { if (!done && pending === 0) { done = true; resolve(out); } };
            const visitFile = (entry) => { pending++; entry.file(file => { out.push(file); pending--; settle(); }, () => { pending--; settle(); }); };
            const visitDir = (dir) => {
                pending++;
                const reader = dir.createReader();
                const readBatch = () => reader.readEntries(batch => {
                    if (!batch.length) { pending--; settle(); return; }
                    for (const ent of batch) { if (ent.isFile) visitFile(ent); else if (ent.isDirectory) visitDir(ent); }
                    readBatch();
                }, () => { pending--; settle(); });
                readBatch();
            };
            for (const ent of entries) {
                if (ent instanceof File) out.push(ent);
                else if (typeof ent.isFile === 'boolean' && typeof ent.isDirectory === 'boolean') {
                    if (ent.isFile) visitFile(ent);
                    else if (ent.isDirectory) visitDir(ent);
                }
            }
            settle();
        });
                const gatherDroppedFiles = async (dt) => {
            if (!dt) return [];
            const out = [];
            const seen = new Set();
            const push = (f) => { if (!f) return; const k = (f.name || '') + ':' + (f.size || 0) + ':' + (f.webkitRelativePath || ''); if (!seen.has(k)) { seen.add(k); out.push(f); } };
            // 先用原生 dt.files（单/多文件拖入最可靠；历史上"优先 entry API"曾导致单文件 .json 拖入失败，故保持 dt.files 优先）
            if (dt.files && dt.files.length) { for (const f of Array.from(dt.files)) push(f); }
            // 再补：把 drag items 里的「文件夹 / 文件」条目经 entry API 递归展开。
            // dt.files 优先已收录普通文件（保留历史上单文件 .json 拖入的可靠性）；此处只需额外处理
            // dt.files 拿不到的内容（被拖入的「文件夹」目录，或某些浏览器 dt.files 为空但 items 为文件的情况）。
            // 不支持 entry API 的浏览器（如 Firefox 拖文件夹）拿不到目录内容，会由上层给出明确提示。
            const hasEntryApi = dt.items && dt.items.length && (dt.items[0].webkitGetAsEntry || dt.items[0].mozGetAsEntry);
            if (hasEntryApi) {
                const ents = [];
                for (let i = 0; i < dt.items.length; i++) {
                    const it = dt.items[i];
                    const entry = getEntryFromItem(it);
                    // 目录与文件条目都收集：目录递归展开，文件条目（dt.files 为空时）经 entry.file 取回；
                    // 已通过 dt.files 收录的会用 seen 去重，不会重复。
                    if (entry) ents.push(entry);
                    else if (!entry && it.kind === 'file' && it.getAsFile) { const f = it.getAsFile(); if (f) push(f); }
                }
                if (ents.length) { try { const files = await collectEntries(ents); files.forEach(push); } catch (e) {} }
            }
            return out;
        };

        const collectBackupData = async () => {
            if (!window.XDD_CRYPTO) throw new Error('加密模块不可用');
            flushAllSaves(); // 先把节流中（最多滞后 10s）的 duo_stats 等落盘，避免备份拿到过期的等级/🔥
            const out = { __meta: { app: 'xueduoduo', exportedAt: new Date().toISOString(), version: (window.XDD_BACKUP ? window.XDD_BACKUP.BACKUP_VERSION : 1) } };
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (BACKUP_KEY_RE.test(k)) out[k] = localStorage.getItem(k);
            }
            // 纳入 IndexedDB 中的本地音频文件（blob 转 base64 存入备份，换机/刷新后可恢复）
            try {
                const rows = await idbGetAll();
                const files = [];
                for (const r of (rows || [])) {
                    if (r && r.blob) {
                        try { const dataUrl = await blobToDataUrl(r.blob); files.push({ id: r.id, title: r.title, artist: r.artist, dataUrl }); } catch (e) {}
                    }
                }
                if (files.length) out.__musicFiles = files;
            } catch (e) {}
            return out;
        };



        const applyBackupData = async (data) => {
            // 先收集受管旧键，再统一清除（避免遍历中删除导致索引偏移漏删），然后全量恢复（覆盖式）
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (BACKUP_KEY_RE.test(k)) toRemove.push(k);
            }
            toRemove.forEach(k => localStorage.removeItem(k));
            Object.keys(data).forEach(k => {
                if (k === '__meta' || k === '__musicFiles') return;
                const v = data[k];
                if (v === null || v === undefined) return;
                localStorage.setItem(k, v);
            });
            // 恢复本地音频文件到 IndexedDB（覆盖式：仅当备份含 __musicFiles 时清空再写入，避免误删当前本地歌曲）
            if (Array.isArray(data.__musicFiles)) {
                await idbClearMusic();
                for (const item of data.__musicFiles) {
                    try { const blob = await dataUrlToBlob(item.dataUrl); await idbPut({ id: item.id, blob, title: item.title, artist: item.artist }); } catch (e) {}
                }
            }
        };

        const generateUniqueName = (baseName, existingDecks) => {
            const names = existingDecks.map(d => d.name);
            if (!names.includes(baseName)) return baseName;
            let i = 1;
            while (names.includes(`${baseName} (${i})`)) i++;
            return `${baseName} (${i})`;
        };

        const getXpToNextLevel = level => level * 100;
        const calcXP = (isCorrect, diff) => isCorrect ? 10 + (diff - 1) * 5 : 0;
        // 记录"今日已登录/学习"——幂等（按是否已记录今天判断，避免旧数据 lastStudyDate 与 loginDates 不一致时漏记）
        const ensureLoginToday = (stats) => {
            const now = new Date();
            const today = now.toISOString().split('T')[0]; // UTC 日期，与 loginDates 存储口径一致
            const loginSet = new Set(stats.loginDates || []);
            const s = { ...stats };
            const isNewDay = !loginSet.has(today);
            if (isNewDay) {
                loginSet.add(today);
                s.lastStudyDate = today;
                // “本月进度”按自然月统计：从 loginDates 中属于当前年月的天数重新计算，
                // 修复跨月后 monthlyProgress 持续累加、永远不归零的 bug。
                const ym = today.slice(0, 7); // 'YYYY-MM'
                s.monthlyProgress = [...loginSet].filter(d => d.startsWith(ym)).length;
            }
            // 重新计算「当前连续天数」：以 loginDates 为唯一真相源，从今天往前逐日倒推连续登录天数。
            // 修复旧逻辑 `today === 昨天日期` 恒为假、导致连续天数永远停在第 1 天的 bug；
            // 同时可在当天就纠正历史被污染的 streak（如已连续 2 天却显示 1）。
            let streak = 0;
            let cursor = today;
            while (loginSet.has(cursor)) {
                streak++;
                const p = cursor.split('-');
                const dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
                dt.setUTCDate(dt.getUTCDate() - 1);
                cursor = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
            }
            s.streak = streak;
            s.loginDates = Array.from(loginSet).sort();
            const ach = [...(s.achievements || [])];
            if (s.streak >= 7 && !ach.includes('week_streak')) ach.push('week_streak');
            if (s.streak >= 30 && !ach.includes('month_streak')) ach.push('month_streak');
            if (s.level >= 5 && !ach.includes('level_5')) ach.push('level_5');
            s.achievements = ach;
            return s;
        };

        const updateUserStats = (stats, isCorrect, diff) => {
            let s = ensureLoginToday(stats);
            s.xp += calcXP(isCorrect, diff);
            while (s.xp >= getXpToNextLevel(s.level)) {
                s.xp -= getXpToNextLevel(s.level);
                s.level += 1;
            }
            return s;
        };

        // ============================================================
        // 4. API 配置 & 归一化 (不变)
        // ============================================================
        const getApiConfig = () => ({
            baseUrl: localStorage.getItem('api_base_url') || 'https://api.deepseek.com/v1',
            model: localStorage.getItem('api_model') || 'deepseek-chat',
            apiKey: localStorage.getItem('deepseek_key') || ''
        });

        const API_PRESETS = {
            deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', label: 'DeepSeek' },
            zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', label: '智谱 GLM' },
            qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo', label: '通义千问' },
            ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3', label: 'Ollama (本地)' }
        };

        const TYPE_LABELS = {
            multiple_choice: '选择题',
            multiple_select: '多选题',
            true_false: '判断题',
            fill_blank: '填空题',
            essay: '解答题'
        };

        const cleanOption = text => {
            if (typeof text !== 'string') return text;
            return text.replace(/^[\(（]?[A-Za-z][\)）\.、]\s*/, '').trim();
        };

        const resolveMultiAnswers = (raw, cleanOpts) => {
            let tokens;
            if (Array.isArray(raw)) {
                tokens = raw.map(x => String(x).trim()).filter(Boolean);
            } else if (typeof raw === 'string') {
                const s = raw.trim();
                if (s.includes(',') || s.includes('，') || s.includes('、') || s.includes(' ')) {
                    tokens = s.split(/[,\s，、]+/).map(x => x.trim()).filter(Boolean);
                } else if (s.length > 0) {
                    tokens = s.split('').map(x => x.trim()).filter(Boolean);
                } else {
                    tokens = [];
                }
            } else {
                tokens = [];
            }
            const result = [];
            tokens.forEach(token => {
                token = cleanOption(token);
                let idx = cleanOpts.findIndex(o => o === token);
                if (idx < 0) idx = cleanOpts.findIndex(o => o.toLowerCase() === token.toLowerCase());
                if (idx < 0) {
                    const m = token.match(/^[A-Za-z]$/);
                    if (m) {
                        const li = token.toUpperCase().charCodeAt(0) - 65;
                        if (li >= 0 && li < cleanOpts.length) idx = li;
                    }
                }
                if (idx >= 0 && !result.includes(cleanOpts[idx])) result.push(cleanOpts[idx]);
            });
            return result;
        };

        const formatCorrectAnswer = q => {
            if (q && q.type === 'multiple_select' && Array.isArray(q.correctAnswer)) return q.correctAnswer.join('、');
            return q && q.correctAnswer;
        };

        // 已知标准题型；归一化/消费时对未知题型做兜底映射，避免脏题型导致"暂不支持此题型"
        const KNOWN_TYPES = ['multiple_choice', 'multiple_select', 'true_false', 'fill_blank', 'essay'];
        // 各题型默认分值（AI 未给 score 或题目无 score 时回退使用）
        const DEFAULT_SCORE = t => ({ multiple_choice: 3, multiple_select: 4, true_false: 2, fill_blank: 4,
            essay: 8 }[t] || 5);
        const normScore = q => (typeof q.score === 'number' && q.score > 0) ? q.score : DEFAULT_SCORE(q.type);
        const normalizeQuestionType = (type, hasOptions) => {
            if (KNOWN_TYPES.includes(type)) return type;
            // 未知题型：有选项按单选，无选项按填空（自由文本作答），保证所有题都能练习
            return hasOptions ? 'multiple_choice' : 'fill_blank';
        };

        const normalizeQuestions = questions => {
            if (!Array.isArray(questions)) return questions;
            return questions.map(q => {
                if (q && Array.isArray(q.options) && q.options.length) {
                    const cleanOpts = q.options.map(o => cleanOption(o));
                    const ca = q.correctAnswer;
                    const letterCount = typeof ca === 'string' ? (ca.match(/[A-Za-z]/g) || []).length : 0;
                    const looksMulti = q.type === 'multiple_select' || Array.isArray(ca) || typeof ca === 'string' &&
                        letterCount >= 2 && /^([A-Za-z]\s*[，,、\s])*[A-Za-z]$/.test(ca.trim());
                    let correct, finalType;
                    if (looksMulti) {
                        correct = resolveMultiAnswers(ca, cleanOpts);
                        finalType = 'multiple_select';
                    } else {
                        correct = ca;
                        if (typeof correct === 'string') {
                            const c = correct.trim();
                            const idxByRaw = q.options.findIndex(o => o && o.trim() === c);
                            if (idxByRaw >= 0) {
                                correct = cleanOpts[idxByRaw];
                            } else {
                                const letterMatch = c.match(/^[A-Za-z]$/);
                                if (letterMatch) {
                                    const li = c.toUpperCase().charCodeAt(0) - 65;
                                    if (li >= 0 && li < cleanOpts.length) correct = cleanOpts[li];
                                }
                            }
                        }
                        finalType = q.type || 'multiple_choice';
                    }
                        return { ...q, type: finalType, options: cleanOpts, correctAnswer: correct, score: normScore(q) };
                    }
                    // 无选项题（填空/简答/或其他非标准题型）：规范 type，避免脏题型导致"暂不支持此题型"
                    let t = q.type;
                    if (!KNOWN_TYPES.includes(t)) t = 'fill_blank';
                    return { ...q, type: t, score: normScore(q) };
                });
        };

        // 单题规范化（新增/修改共用）：以 raw 为准、base 兜底，产出干净一致的对象。
        // 用于 addQuestion / updateQuestion，保证无论来源（弹窗/导入/局部 patch）写入的题目都合法。
        const normalizeQuestion = (raw, base) => {
            const r = raw || {};
            const b = base || {};
            const type = normalizeQuestionType(r.type, Array.isArray(r.options) && r.options.length > 0);
            let options = [];
            let correctAnswer = r.correctAnswer;
            if (type === 'multiple_choice' || type === 'multiple_select') {
                options = (Array.isArray(r.options) ? r.options : []).map(o => String(o).trim()).filter(Boolean);
                if (type === 'multiple_select') {
                    correctAnswer = Array.isArray(r.correctAnswer)
                        ? r.correctAnswer.map(String).filter(c => options.includes(c))
                        : [];
                } else {
                    correctAnswer = String(r.correctAnswer != null ? r.correctAnswer : '').trim();
                    if (!options.includes(correctAnswer)) correctAnswer = options.length ? options[0] : '';
                }
            } else if (type === 'true_false') {
                options = ['正确', '错误'];
                correctAnswer = (r.correctAnswer === '错误') ? '错误' : '正确';
            } else {
                options = [];
                correctAnswer = String(r.correctAnswer != null ? r.correctAnswer : '').trim();
            }
            const difficulty = (typeof r.difficulty === 'number' && r.difficulty >= 1 && r.difficulty <= 3)
                ? r.difficulty : (typeof b.difficulty === 'number' ? b.difficulty : 1);
            const score = (typeof r.score === 'number' && r.score > 0) ? Math.round(r.score) : DEFAULT_SCORE(type);
            // figure / images 以 raw 为准（raw 显式为空即删除，不回退 base，避免误恢复已删内容）
            const figure = (r.figure && r.figure.items && r.figure.items.length) ? r.figure : undefined;
            const images = (Array.isArray(r.images) && r.images.length) ? r.images : undefined;
            return {
                id: b.id || r.id || generateId(),
                type,
                question: String(r.question != null ? r.question : '').trim(),
                options,
                correctAnswer,
                explanation: String(r.explanation != null ? r.explanation : '').trim(),
                difficulty,
                score,
                ...(figure ? { figure } : {}),
                ...(images ? { images } : {})
            };
        };

        // 深拷贝题目（剥离 timeSpent 等运行时字段），用于把题目传入编辑弹窗前的安全克隆
        const cloneQuestion = q => {
            if (!q || typeof q !== 'object') return q;
            let c;
            try { c = JSON.parse(JSON.stringify(q)); } catch (_) { c = { ...q }; }
            delete c.timeSpent;
            return c;
        };

        // ============================================================
        // 5. AI 生成 (修改 prompt 以支持 LaTeX)
        // ============================================================
        // 宽松 JSON 解析：处理代码块围栏、字符串内裸换行、尾随逗号等常见瑕疵
        const fixJsonStringEscapes = (str) => {
            const BS = String.fromCharCode(92);   // 反斜杠
            const DQ = String.fromCharCode(34);   // 双引号
            const NL = String.fromCharCode(10);
            const CR = String.fromCharCode(13);
            const TAB = String.fromCharCode(9);
            let out = '', inStr = false, escaped = false;
            for (let i = 0; i < str.length; i++) {
                const c = str[i];
                if (escaped) { out += c; escaped = false; continue; }
                if (c === BS) { out += c; escaped = true; continue; }
                if (c === DQ) { out += c; inStr = !inStr; continue; }
                if (inStr) {
                    if (c === NL) { out += BS + 'n'; continue; }
                    if (c === CR) { out += BS + 'r'; continue; }
                    if (c === TAB) { out += BS + 't'; continue; }
                }
                out += c;
            }
            return out;
        };
        const removeTrailingCommas = (str) => {
            const NL = String.fromCharCode(10), CR = String.fromCharCode(13), TAB = String.fromCharCode(9);
            const ws = (c) => c === ' ' || c === NL || c === CR || c === TAB;
            let out = '';
            for (let i = 0; i < str.length; i++) {
                const c = str[i];
                if (c === ',') {
                    let j = i + 1;
                    while (j < str.length && ws(str[j])) j++;
                    if (str[j] === '}' || str[j] === ']') continue;
                }
                out += c;
            }
            return out;
        };
        const safeJsonParse = (raw) => {
            const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
            let s = String(raw || '').trim();
            if (s.slice(0, 3) === FENCE) {
                const NL = String.fromCharCode(10);
                let start = s.indexOf(NL);
                start = start !== -1 ? start + 1 : 3;
                const end = s.lastIndexOf(FENCE);
                if (end > start) s = s.slice(start, end).trim();
                else s = s.slice(start).trim();
            }
            const first = s.indexOf('{');
            const last = s.lastIndexOf('}');
            if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
            const candidates = [
                s,
                removeTrailingCommas(fixJsonStringEscapes(s)),
                removeTrailingCommas(s)
            ];
            for (const cand of candidates) {
                try { return JSON.parse(cand); } catch (e) {}
            }
            throw new Error('AI 返回内容不是合法 JSON，请重试或降低题目数量/文本长度');
        };

        const generateQuestionsFromContent = async (content, count = 5, temperature = 0.7) => {
            const { baseUrl, model, apiKey } = getApiConfig();
            if (!apiKey) throw new Error('请配置 API Key');
            const url = `${baseUrl}/chat/completions`;
            const prompt = `
        你是一位教育专家 + LaTeX 公式排版专家。根据以下文本内容生成 ${count} 道练习题（题型混合：单选题、多选题、判断题、填空题、解答题）。

        ⚠️ 硬性要求：最终必须恰好输出 ${count} 道题，questions 数组的长度必须严格等于 ${count}，不要多生成也不要少生成。下面的示例仅用于说明字段格式，不代表题数。

        文本内容：
        """
        ${content}
        """

        ⚠️ **重要：数学公式必须使用 LaTeX 格式！**
        - 行内公式用 $...$，例如 $E=mc^2$
        - 块级公式用 $$...$$，例如 $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$
        - 分数用 \\frac{}{}，上下标用 _ 和 ^，根号用 \\sqrt{}
        - 所有公式均用 LaTeX 语法书写，确保可被 KaTeX 渲染。

        ⚠️ **需要配图时，给题目附加可选字段 "figure"（极简 JSON 几何/函数图规范），前端会自动渲染坐标系+网格+图形。仅在题目确实涉及几何图形或函数图像时添加，不要无谓添加。**
        ⚠️ **关于真实照片 / 插图 / 地图 / 国旗 / 徽标 / 实验装置图等配图（images 字段）：语言模型无法验证外部图片链接是否真实存在，擅自填写极易产生死链，导致用户做题时图片加载失败（空白）。因此【严禁】在生成的题目中输出 images 字段。如需真实照片配图，请由用户在编题时自行通过「📁 上传本地图片」（自动压缩内嵌、离线可用）或「🔍 联网搜图」（检索 Wikimedia Commons 真实可访问的图片）添加。几何 / 函数图形一律用 figure，不要与 images 混用。**
        - 顶层结构：{ v:[xmin,xmax,ymin,ymax] (视口范围,可选,省略则自动适配), g:网格(通常省略,应用按图形类型自动决定:几何图默认隐藏,含 fn 函数图像默认显示;确需强制可写 g:0 或 g:1), ax:坐标轴(同理:几何图默认隐藏,含 fn 函数图像默认显示;强制可写 ax:0/ax:1), items:[...元素数组] }
        - 🔗 **对象相互引用的约定（强烈推荐用依赖对象表达几何关系）**：
          · 点用大写字母 A–Z 作 l 标签，线段/直线/射线/圆用小写字母 a–z 作 l 标签（前端会为无标签的线/圆自动编号）。
          · 后续元素的 a / b / o 字段**可以直接写该标签字符串**（如 "A"、"a"）来引用其坐标；被引用的对象移动时，引用它的对象会实时联动重算。
          · 用下面的依赖类型（mid/inter/onseg/perp/para）来表达"中点/交点/共线/垂直/平行"等几何约束，比手写坐标更精确、绝不会错位（见下方"几何约束精确性"）。
        - 元素 t 取值（坐标均为数据坐标，非像素；a/b/o 可填 [x,y] 或标签字符串）：
          · pt 点     {t:"pt",p:[x,y],l:"A",c:"#e74c3c"}            (l=标签,c=颜色,可选)
          · seg 线段  {t:"seg",a:[x1,y1],b:[x2,y2],c,w,dash:1,l:"a"}
          · ray 射线  {t:"ray",a:[x,y],b:[x,y],l:"a"}                从 a 过 b 单向延伸
          · ln 直线   {t:"ln",a:[x,y],b:[x,y],l:"a"}                 过 a,b 的无限直线
          · cir 圆    {t:"cir",o:[x,y],r:3,fill:"#eee",c,w,l:"a"}    fill 可省略(不填充)
          · arc 圆弧  {t:"arc",o:[x,y],r:3,a0:0,a1:90,c}             a0/a1 为角度(度)
          · pol 多边形 {t:"pol",p:[[x,y],...],fill:"",close:1}       close=0 表示折线(不闭合)
          · fn 函数   {t:"fn",e:"x^2",c,w,x0,x1}                     e 为 y=f(x) 表达式
          · pf 参数   {t:"pf",x:"cos t",y:"sin t",t:[0,6.28],c}
          · po 极坐标 {t:"po",e:"1+cos a",a:[0,6.28],c}
          · ang 角    {t:"ang",a:[x,y],b:[x,y],c:[x,y],l:"α",r:24}   b 为顶点,a/c 为两边端点
          · vec 向量  {t:"vec",a:[x,y],b:[x,y],l,c}                  带箭头(指向 b)
          · txt 文字  {t:"txt",p:[x,y],s:"说明",size,rot}            rot 为旋转角度
          · mid 中点   {t:"mid",l:"M",a:"A",b:"B"}                   取 A、B 标签两点的中点（a/b 为点标签）
          · inter 交点 {t:"inter",l:"P",a:"a",b:"b"}                 取两条线/圆的第一个交点（a/b 为线/圆标签）
          · onseg 线(段)上点 {t:"onseg",l:"E",line:"d",u:0.5}        在直线/线段 label="d" 上，u∈[0,1] 为参数（0=端点1,1=端点2,0.5=中点）；用 u 精确表达"E 在 AD 上且 AE:ED=m:n"→ u=n/(m+n)
          · onln 直线上点   {t:"onln",l:"E",line:"d",u:0.5}          同 onseg，但允许 u 超出 [0,1] 取到延长线上
          · perp 垂线  {t:"perp",l:"k",p:"A",line:"d"}               过标签点 A 且垂直于标签线 d 的直线
          · para 平行线 {t:"para",l:"k",p:"A",line:"d"}              过标签点 A 且平行于标签线 d 的直线
        - 立体几何（伪 3D / 2.5D 风格）：三维图形**不要**用 "dim":3 或任何三维元素，请直接用上面的 2D 元素（pt/seg/pol/cir）在平面上"画出立体感"（轴测/斜二测错觉）。前端底层是 2D 渲染，靠以下约定营造体积：
          · 用 pol 画出各个可见面，并用 fill 填浅色（如 "#eaf2ff"）表示受光面；背向/被遮挡的棱用 seg 并加 "dash":1（虚线）表示。
          · 隐藏在体后的顶点仍用 pt 画出，标签用 "A'"/"B'" 或 "A1"/"B1" 这类记号（直接写作字符串，如 l:"A'" 或 l:"A1"）。
          · figure 不要写 "dim" 字段（默认即 2D）。
          · 示例（棱长 2 的正方体，斜二测错觉：前方面 ABCD，后面 A'B'C'D' 向右上偏移）：{ "figure": { "g":1, "items":[ {"t":"pol","p":[[-1,-1],[1,-1],[1,1],[-1,1]],"fill":"#eaf2ff"}, {"t":"pol","p":[[-1,1],[1,1],[3,2],[1,2]],"fill":"#dbe9ff"}, {"t":"pol","p":[[1,-1],[1,1],[3,2],[3,0]],"fill":"#cfe0ff"}, {"t":"seg","a":[-1,-1],"b":[1,0]}, {"t":"seg","a":[1,-1],"b":[3,0]}, {"t":"seg","a":[1,1],"b":[3,2]}, {"t":"seg","a":[-1,1],"b":[1,2]}, {"t":"seg","a":[1,0],"b":[3,0],"dash":1}, {"t":"seg","a":[3,0],"b":[3,2],"dash":1}, {"t":"seg","a":[3,2],"b":[1,2],"dash":1}, {"t":"seg","a":[1,2],"b":[1,0],"dash":1}, {"t":"pt","p":[-1,-1],"l":"A"}, {"t":"pt","p":[1,-1],"l":"B"}, {"t":"pt","p":[1,1],"l":"C"}, {"t":"pt","p":[-1,1],"l":"D"}, {"t":"pt","p":[1,0],"l":"A'"}, {"t":"pt","p":[3,0],"l":"B'"}, {"t":"pt","p":[3,2],"l":"C'"}, {"t":"pt","p":[1,2],"l":"D'"} ] } }（可见棱用实线+填充面，体后棱用虚线）
        - 表达式支持 + - * / ^ 及 sin cos tan exp log sqrt abs pi e 等；变量用 x / t / a；c/w 为可选颜色/线宽（颜色用 CSS 颜色或十六进制）。
        - ⚠️ **几何约束精确性**：如果题干说明某点在某线段、直线、圆或其他图形上，figure 中该点坐标必须精确满足该几何关系，不能目测估算。最稳妥、最推荐的方式是**用依赖对象**而非手写坐标：
          · "E 在 AD 上" 且 AE:ED = m:n：先用 {t:"seg",a:[...A],b:[...D],l:"d"} 建线段并打标签 "d"，再用 {t:"onseg",l:"E",line:"d",u:"n/(m+n)"} 让 E 精确落在 AD 上（u=n/(m+n) 即 AE:ED=m:n）。
          · "M 为 BC 中点"：{t:"mid",l:"M",a:"B",b:"C"}。
          · "两直线交于 P"：分别给两条线打标签 "a"、"b"，再用 {t:"inter",l:"P",a:"a",b:"b"}。
          · "过 A 作 BC 的垂线/平行线"：{t:"perp",l:"k",p:"A",line:"d"} / {t:"para",l:"k",p:"A",line:"d"}（d 为 BC 的标签）。
          · 若必须手写坐标（如自由点），则须按插值公式精确计算，例如 E = [ (n*A.x + m*D.x)/(m+n), (n*A.y + m*D.y)/(m+n) ]；"点 P 在圆 O 上" 须满足 P 到 O 的距离严格等于半径 r。
          · 所有标注点、线段端点必须两两对齐，确保渲染出的图形与文字描述一致。
        - 配图示例（几何图，演示依赖对象写法）：{ "type":"multiple_choice", "question":"如图，$\\triangle ABC$ 中 $AB=AC$，$D$ 为 $BC$ 中点，$E$ 在 $AD$ 上，求证 $\\triangle BDE \\sim \\triangle ABC$。", "options":["一定能","不一定","不能","无法确定"], "correctAnswer":"一定能", "explanation":"...", "figure":{ "v":[-1,5,-1,4], "g":1, "items":[ {"t":"pt","p":[0,1],"l":"B"}, {"t":"pt","p":[4,1],"l":"C"}, {"t":"pt","p":[2,3.2],"l":"A"}, {"t":"seg","a":"B","b":"C","l":"f"}, {"t":"mid","l":"D","a":"B","b":"C"}, {"t":"seg","a":"A","b":"D","l":"d"}, {"t":"onseg","l":"E","line":"d","u":0.5}, {"t":"seg","a":"B","b":"A"}, {"t":"seg","a":"C","b":"A"}, {"t":"seg","a":"B","b":"D"}, {"t":"seg","a":"D","b":"E"} ] } }

        要求：
        - 每道题包含: type, question, options(仅选择题), correctAnswer, explanation, difficulty(1-3), score(本题分值，正整数)
        - score 为本题分值（正整数），请按题型合理设置：选择题 3 分、多选题 4 分、判断题 2 分、填空题 4 分、解答题 8 分；整卷分值应尽量规整（如凑成 100 分或其整数倍）。
        - 对于单选（type:"multiple_choice"）与多选（type:"multiple_select"），options 为选项文本数组，correctAnswer 必须与选项中的文本**完全一致**。
        - 多选题（type:"multiple_select"）的 correctAnswer 必须是**正确答案文本的数组**（例如 ["北京","上海"]），可包含 2 个或多个正确选项。
        - 只要某道题有「多个正确选项」，就必须使用 type:"multiple_select" 且 correctAnswer 为正确答案文本的数组。
        - 对于解答题（type: "essay"），correctAnswer 为参考答案（字符串），explanation 为解题思路或评分要点。
        - 输出格式必须是一个JSON对象，包含两个字段：
          {
            "title": "简洁的标题（不超过20字）",
            "questions": [
              { "type": "multiple_choice", "question": "...", "options": ["A","B","C","D"], "correctAnswer": "A", "explanation": "...", "difficulty": 1, "score": 3 },
              { "type": "multiple_select", "question": "...（多选）", "options": ["A","B","C","D"], "correctAnswer": ["A","C"], "explanation": "...", "difficulty": 2, "score": 4 },
              { "type": "true_false", "question": "...", "correctAnswer": "正确", "explanation": "...", "difficulty": 2, "score": 2 },
              { "type": "fill_blank", "question": "...", "correctAnswer": "标准答案", "explanation": "...", "difficulty": 3, "score": 4 },
              { "type": "essay", "question": "...", "correctAnswer": "参考答案", "explanation": "评分要点", "difficulty": 2, "score": 8 },
              { "type": "multiple_choice", "question": "...（含几何图）", "options": ["A","B","C","D"], "correctAnswer": "B", "explanation": "...", "difficulty": 2, "score": 3, "figure": { "v":[-5,5,-3,3], "g":1, "items":[ {"t":"fn","e":"x^2"}, {"t":"pt","p":[2,4],"l":"P"} ] } }
            ]
          }
        - 示例中包含 LaTeX 公式：例如 "已知 $x^2 + y^2 = 1$，求 $x+y$ 的最大值"。
        - 必须只返回 JSON 对象，且 questions 数组长度严格等于 ${count}，不要其他文字。
        - 严禁在 JSON 字符串值内部使用真实换行或末转义的双引号；所有文本必须压缩成单行，确保可被标准 JSON 解析器直接解析。
          `;
            // 超时与 token 随题目数量动态放大：题目越多，请求越慢、所需输出越长，避免一次生成较多题目时误报超时/截断
            const genTimeoutMs = Math.min(600000, Math.max(150000, count * 20000));
            const genMaxTokens = Math.min(8000, Math.max(2000, count * 800));
            const callOnce = async (promptText, attempt = 0) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), genTimeoutMs);
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [
                                { role: 'system', content: '你是专业教育内容生成助手，擅长使用 LaTeX 排版数学公式。' },
                                { role: 'user', content: promptText }
                            ],
                            temperature: temperature,
                            max_tokens: genMaxTokens
                        }),
                        signal: controller.signal
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        throw new Error(`API 错误 (${resp.status}): ${errText}`);
                    }
                    const data = await resp.json();
                    const raw = data.choices?.[0]?.message?.content || '';
                    let parsed;
                    try { parsed = safeJsonParse(raw); } catch (e) { return null; }
                    let qs = null;
                    if (Array.isArray(parsed)) qs = parsed;
                    else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.questions)) qs = parsed.questions;
                    if (!qs || qs.length === 0) return null;
                    const title = (parsed.title && parsed.title.trim()) ? parsed.title.trim() : 'AI生成题库';
                    return { title, questions: qs };
                } catch (e) {
                    if (e && e.name === 'AbortError') {
                        // 超时不直接报错：自动重试最多 3 次（间隔 2 秒），避免生成题目较多时误报错误
                        const MAX_RETRY = 3;
                        if (attempt < MAX_RETRY) {
                            clearTimeout(timer);
                            await new Promise(r => setTimeout(r, 2000));
                            return callOnce(promptText, attempt + 1);
                        }
                        return null; // 重试耗尽仍超时：返回 null 由上层兜底，不再抛出超时错误
                    }
                    throw e; // 非超时错误（如 API 错误）仍向上抛出
                } finally {
                    clearTimeout(timer);
                }
            };
            const res = await callOnce(prompt);
            if (!res) throw new Error('AI 未返回有效题目，请重试或检查 API');
            const finalQuestions = res.questions.slice(0, count);
            return { title: res.title, questions: finalQuestions };
        };

        // ============================================================
        // 6. AI 判题 & 追问 (不变)
        // ============================================================
        // 统一 AI 聊天请求封装：含超时控制（避免 API 无响应时永久挂起）+ 统一错误处理；供判题/追问复用
        // AI 调用并发去重 + 可选结果缓存：相同请求并发时复用同一 Promise（防连点重复发请求）；
        // 仅当 cache:true 时按内容哈希缓存结果（默认 5 分钟，TTL 可配），判题类不设 cache 以保证实时。
        const _postChatInflight = new Map();
        const _postChatCache = new Map();
        const _postChatKey = (sys, usr) => {
            let h = 0; const s = sys + ' ' + usr;
            for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
            return (h >>> 0).toString(36);
        };
        const postChat = async (systemRole, userContent, { temperature = 0.3, maxTokens = 200, timeoutMs = 60000, cache = false, cacheTtl = 5 * 60 * 1000 } = {}) => {
            const k = _postChatKey(systemRole, userContent);
            if (cache) {
                const c = _postChatCache.get(k);
                if (c && c.exp > Date.now()) return c.val;
            }
            if (_postChatInflight.has(k)) return _postChatInflight.get(k);
            const run = async () => {
                const { baseUrl, model, apiKey } = getApiConfig();
                if (!apiKey) throw new Error('请配置 API Key');
                const url = `${baseUrl}/chat/completions`;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'system', content: systemRole }, { role: 'user', content: userContent }],
                            temperature, max_tokens: maxTokens
                        }),
                        signal: controller.signal
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        throw new Error(`API 错误 (${resp.status}): ${errText}`);
                    }
                    const data = await resp.json();
                    const result = data.choices?.[0]?.message?.content || '';
                    if (cache) _postChatCache.set(k, { val: result, exp: Date.now() + cacheTtl });
                    return result;
                } catch (e) {
                    if (e && e.name === 'AbortError') {
                        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）：AI 服务未及时响应，请稍后重试`);
                    }
                    throw e;
                } finally {
                    clearTimeout(timer);
                }
            };
            const p = run();
            _postChatInflight.set(k, p);
            try { return await p; } finally { _postChatInflight.delete(k); }
        };

        // 合并题库时生成名称：优先用 AI（根据多个题库名称/简介/示例题命名），无 API 或失败时回退为「A + B + …」
        const generateMergeDeckName = async (decksArr) => {
            const { apiKey } = getApiConfig();
            const fallback = (decksArr || []).map(d => d.name).join(' + ') || '合并题库';
            if (!apiKey || !decksArr || decksArr.length === 0) return fallback;
            try {
                const sample = q => (q && q.question ? String(q.question).replace(/\$/g, '').slice(0, 40) : '');
                const parts = decksArr.map((d, i) => {
                    const s = (d.questions || []).slice(0, 2).map(sample).join('；');
                    return `题库${i + 1}名称：${d.name}\n题库${i + 1}简介：${d.description || '无'}\n题库${i + 1}示例：${s}`;
                }).join('\n');
                const name = await postChat(
                    '你是题库命名助手。请根据多个题库的名称与示例题目，生成一个简洁、准确、能概括这些题库共同主题的中文合并题库名称。要求：不超过 20 个字，不要带书名号或引号，只输出名称本身，不要任何解释或标点后缀。',
                    parts,
                    { temperature: 0.5, maxTokens: 40, timeoutMs: 30000 }
                );
                const clean = (name || '').trim().replace(/^[《「『"'\s]+|[》」』"'\s]+$/g, '').trim();
                return clean || fallback;
            } catch (e) {
                return fallback;
            }
        };

        // 本地填空题宽松匹配：去掉口语前缀/中文，提取核心答案再比对（AI 不可用时的兜底）
        const lenientFillBlankMatch = (userAnswer, standardAnswer) => {
            const su = String(userAnswer || '').trim().toLowerCase();
            const sa = String(standardAnswer || '').trim().toLowerCase();
            if (!su || !sa) return false;
            const stripWs = s => s.replace(/\s+/g, '');
            if (stripWs(su) === stripWs(sa)) return true;
            // 去掉中文（含中文/全角标点）后比较，处理「我觉得是8」这类口语
            const cu = su.replace(/[㐀-鿿　-〿＀-￯]/g, '');
            if (cu && stripWs(cu) === stripWs(sa)) return true;
            // 标准答案为纯数字时，提取学生答案中的首个数字比较
            if (/^-?\d+(\.\d+)?$/.test(sa)) {
                const m = su.match(/-?\d+(\.\d+)?/);
                if (m && m[0] === sa) return true;
            }
            // 宽松：标准答案出现在学生答案中
            if (stripWs(sa).length && stripWs(su).includes(stripWs(sa))) return true;
            return false;
        };

        const judgeFillBlank = async (question, userAnswer, standardAnswer) => {
            const prompt = `
        你是一位严格的老师，擅长判断各种学科填空题答案的正确性。请判断学生的填空题答案是否正确。

        题目：${question}
        标准答案：${standardAnswer}
        学生答案：${userAnswer}

        注意：学生答案可能包含口语或解释性文字（例如「我觉得是8」「答案是 8」「应该是8吧」），请先忽略这些引导语、提取其中的「最终答案」，再与标准答案比较；只要最终答案与标准答案等价（数值、表达式一致或同义），即判为正确。
        输出格式为 JSON 对象，包含两个字段：
        {
          "isCorrect": true/false,
          "explanation": "一句简短的评语，解释为什么正确或错误，并给出建议。"
        }
        只输出 JSON，不要其他文字。
            `;
            const raw = await postChat('你是一位严格的老师，擅长判断各种学科填空题答案的正确性。', prompt,
                { temperature: 0.3, maxTokens: 200, timeoutMs: 60000 });
            return safeJsonParse(raw);
        };

        const judgeEssay = async (question, userAnswer, standardAnswer) => {
            const prompt = `
        你是一位严格的老师，擅长判断各种学科解答题答案的正确性。请判断学生的解答题答案是否正确。

        题目：${question}
        参考答案：${standardAnswer}
        学生答案：${userAnswer}

        请判断学生答案的核心观点和关键信息是否与参考答案一致（允许不同表述，但必须抓住要点）。注意：学生答案可能夹带口语或过程性文字，请抓住其核心结论再判断。
        输出格式为 JSON 对象，包含两个字段：
        {
          "isCorrect": true/false,
          "explanation": "一句简短的评语，解释为什么正确或错误，并给出改进建议。"
        }
        只输出 JSON，不要其他文字。
            `;
            const raw = await postChat('你是一位严格的老师，擅长判断各种学科解答题答案的正确性。', prompt,
                { temperature: 0.3, maxTokens: 200, timeoutMs: 60000 });
            return safeJsonParse(raw);
        };

        const askAIForExplanation = async (questionText, userAnswer, correctAnswer, explanation, userQuestion) => {
            const prompt = `
        你是老师。学生刚做错一题，想听你简要讲解。

        题目：${questionText}
        学生答案：${userAnswer}
        正确答案：${correctAnswer}
        已有解析：${explanation || '暂无'}
        学生的问题：${userQuestion}

        要求：用 2-4 句话简要回答，直击要点，不要展开长文、不要列编号大纲。先一句话点明对错原因，再一句补充关键知识点即可。
            `;
            try {
                return await postChat('你是老师，回答简练、切中要害，节省 tokens。', prompt,
                    { temperature: 0.4, maxTokens: 300, timeoutMs: 60000, cache: true });
            } catch (e) {
                return '抱歉，我暂时无法回答（AI 服务不可用或超时），请稍后重试。';
            }
        };

        // ============================================================
        // 7. App Context (不变)
        // ============================================================
        // 渲染底层优化：将单一巨型 value 拆分为多个独立 Context，避免任一状态变化触发全树重渲染。
        // 拆分维度：Stats(等级/经验/🔥) / Data(题库/文件夹/错题/收藏/剪贴板) / Ui(页面mode) /
        // Session(答题/练习会话) / Actions(40+ 操作函数，引用稳定)。
        const StatsContext = createContext({ stats: { level: 1, xp: 0, streak: 0, lastStudyDate: '',
            monthlyProgress: 0, loginDates: [], achievements: [] } });
        const DataContext = createContext({});
        const UiContext = createContext({ mode: 'home', setMode: () => {} });
        const SessionContext = createContext({ session: null, practiceSession: null, setSession: () => {},
            setPracticeSession: () => {} });
        const ActionsContext = createContext({});
        const AppProvider = ({ children }) => {
            const [stats, setStats] = useState(() => loadData('duo_stats', { level: 1, xp: 0, streak: 0,
                lastStudyDate: '', monthlyProgress: 0, loginDates: [], achievements: [] }));
            const [decks, setDecks] = useState(() => loadData('duo_decks', []));
            const [session, setSession] = useState(null);
            const [mode, setMode] = useState('home');
            const [learnResult, setLearnResult] = useState(null);
            const [practiceResult, setPracticeResult] = useState(null);
            const [wrongQuestions, setWrongQuestions] = useState(() => {
                const data = loadData('duo_wrong', []);
                return data.map(w => ({ ...w, practiceCount: w.practiceCount || 0, correctCount: w.correctCount ||
                    0, score: (typeof w.score === 'number' && w.score > 0) ? w.score : DEFAULT_SCORE(w.type) }));
            });
            const [practiceSession, setPracticeSession] = useState(null);
            const [favorites, setFavorites] = useState(() => loadData('duo_favorites', []).map(f => ({ ...f,
                score: (typeof f.score === 'number' && f.score > 0) ? f.score : DEFAULT_SCORE(f.type) })));
            const [folders, setFolders] = useState(() => loadData('duo_folders', []));
            const [currentFolderId, setCurrentFolderId] = useState(null);
            const [clipboard, setClipboard] = useState(() => loadData('duo_clipboard', null));
            // 错题本/收藏夹「未读」标记：记录上次查看时间，侧边栏徽标显示自那时起新增的数量（微信未读消息式）
            const [wrongLastSeen, setWrongLastSeen] = useState(() => loadData('duo_wrong_seen', null));
            const [favLastSeen, setFavLastSeen] = useState(() => loadData('duo_fav_seen', null));

            useEffect(() => throttledSave('duo_stats', stats), [stats]);
            // 页面卸载/切后台时强制落盘所有节流中的数据，避免丢失最近改动
            useEffect(() => {
                const flush = () => { flushAllSaves(); };
                const onVis = () => { if (document.hidden) { flushAllSaves(); } };
                window.addEventListener('beforeunload', flush);
                window.addEventListener('pagehide', flush);
                document.addEventListener('visibilitychange', onVis);
                return () => {
                    window.removeEventListener('beforeunload', flush);
                    window.removeEventListener('pagehide', flush);
                    document.removeEventListener('visibilitychange', onVis);
                };
            }, []);
            useEffect(() => throttledSave('duo_decks', decks), [decks]);
            useEffect(() => throttledSave('duo_wrong', wrongQuestions), [wrongQuestions]);
            useEffect(() => saveData('duo_favorites', favorites), [favorites]);
            useEffect(() => saveData('duo_folders', folders), [folders]);
            useEffect(() => saveData('duo_clipboard', clipboard), [clipboard]);
            useEffect(() => saveData('duo_wrong_seen', wrongLastSeen), [wrongLastSeen]);
            useEffect(() => saveData('duo_fav_seen', favLastSeen), [favLastSeen]);

            // 迁移修复 (不变)
            useEffect(() => {
                if (localStorage.getItem('duo_migrated_v1')) return;
                // 直接幂等 normalize：normalizeQuestions 对已是新格式的数据无副作用，无需再 JSON.stringify 全量比较，
                // 避免首启时对大量题目做 O(n) 序列化比较，明显加快首次迁移。
                setDecks(prev => prev.map(d => (d && Array.isArray(d.questions)) ? { ...d, questions: normalizeQuestions(d.questions) } : d));
                setFavorites(prev => prev.map(f => (f && Array.isArray(f.options) && (f.type === 'multiple_choice' || f.type === 'multiple_select')) ? normalizeQuestions([f])[0] : f));
                setWrongQuestions(prev => prev.map(w => (w && Array.isArray(w.options) && (w.type === 'multiple_choice' || w.type === 'multiple_select')) ? normalizeQuestions([w])[0] : w));
                try { localStorage.setItem('duo_migrated_v1', '1'); } catch (_) {}
            }, []);

            const handleAnswer = (isCorrect, diff) => setStats(prev => updateUserStats(prev, isCorrect, diff));

            // 打开应用即记录今日登录（与答题共用 ensureLoginToday，幂等）
            useEffect(() => {
                if (sessionStorage.getItem('duo_just_reset')) {
                    sessionStorage.removeItem('duo_just_reset');
                    return; // 刚恢复出厂：本次刷新不自动记登录，日历真正清空
                }
                setStats(prev => ensureLoginToday(prev));
            }, []);

            const startLearning = (deckId, shuffle = true) => {
                const deck = decks.find(d => d.id === deckId);
                if (!deck || deck.questions.length === 0) return alert('该题库暂无题目');
                const questions = shuffle ? [...deck.questions].sort(() => Math.random() - 0.5) : deck.questions;
                setSession({ deckId, questionIndex: 0, questions, results: {}, startedAt: Date.now(), startLevel: stats ? stats.level : 1 });
                setLearnResult(null);
                setMode('learn');
            };

            // 记录某题作答结果（correct + 该题分值）；按题号去重，同一题以最后一次判定为准
            const recordAnswer = useCallback((idx, correct, score) => {
                setSession(prev => {
                    if (!prev) return prev;
                    const results = { ...(prev.results || {}) };
                    results[idx] = { correct: !!correct, score: typeof score === 'number' ? score : 0 };
                    return { ...prev, results };
                });
            }, []);

            const nextQuestion = () => {
                if (!session) return;
                if (session.questionIndex + 1 < session.questions.length) {
                    setSession({ ...session, questionIndex: session.questionIndex + 1 });
                } else {
                    // 完成后结算：得分 = 答对题分值之和，总分 = 全部题分值之和
                    const results = session.results || {};
                    const qs = session.questions || [];
                    const total = qs.reduce((s, q) => s + (typeof q.score === 'number' ? q.score : 0), 0);
                    const earned = Object.keys(results).reduce((s, k) => s + (results[k].correct ? results[k].score : 0), 0);
                    // 本次用时 & 获得经验（经验按 calcXP 逐题累加，与 handleAnswer 实时发放口径一致）
                    const timeSpent = session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0;
                    const xpGained = Object.keys(results).reduce((s, k) => s + (results[k].correct ? calcXP(true, (qs[k] && qs[k].difficulty) || 1) : 0), 0);
                    const correctCount = Object.keys(results).filter(k => results[k].correct).length;
                    const leveledUp = (stats ? stats.level : 1) > (session.startLevel != null ? session.startLevel : 1);
                    const newLevel = stats ? stats.level : 1;
                    setLearnResult({ deckId: session.deckId, earned, total, count: qs.length, timeSpent, xpGained, correctCount, leveledUp, newLevel });
                    // 保留 session（供「再来一次」使用），仅切换为结算页；不重置 mode，由 ResultPanel 控制返回
                }
            };

            const addDeck = (name, desc, questions, folderId) => {
                const uniqueName = generateUniqueName(name, decks);
                const newDeck = {
                    id: generateId(),
                    name: uniqueName,
                    description: desc || '',
                    folderId: folderId != null ? folderId : currentFolderId || null,
                    questions: questions.map(q => ({ ...q, id: generateId() }))
                };
                setDecks(prev => [...prev, newDeck]);
                return newDeck;
            };

            const deleteDeck = (deckId, skipConfirm = false) => {
                if (!skipConfirm && !confirm('删除此题库？与该题库相关的错题和收藏也会一并删除。')) return;
                setDecks(prev => prev.filter(d => d.id !== deckId));
                setFavorites(prev => prev.filter(f => f.sourceDeckId !== deckId));
                setWrongQuestions(prev => prev.filter(w => w.sourceDeckId !== deckId));
                if (session?.deckId === deckId) { setSession(null);
                    setMode('home'); }
            };

            const exportDeck = deck => {
                // 导出时剥离时间字段：timeSpent 仅本地统计，不应随题库文件传播
                const cleanQuestions = deck.questions.map(q => { const { timeSpent, ...rest } = q; return rest; });
                const json = JSON.stringify(cleanQuestions, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${deck.name}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };

            // 导出题库为 PDF：构建 A4 排版文档（含 KaTeX 公式），经隐藏 iframe 调用浏览器打印「另存为 PDF」
            const exportDeckPdf = async (deck, withAnswers) => {
                if (!deck || !Array.isArray(deck.questions) || deck.questions.length === 0) {
                    alert('该题库暂无题目，无法导出 PDF');
                    return;
                }
                const katex = window.katex;
                if (!katex || typeof katex.renderToString !== 'function') {
                    alert('公式库（KaTeX）尚未加载完成，请稍候再试。');
                    return;
                }
                // 未显式指定时询问：确定=含答案与解析，取消=仅题目
                if (withAnswers === undefined) {
                    withAnswers = confirm('导出 PDF 时是否包含答案与解析？\n\n确定 = 包含答案与解析\n取消 = 仅题目');
                }
                // 将几何 figure（内置画板图形）渲染为自包含 SVG 字符串，内联进 PDF
                const renderFigureSvg = (spec) => new Promise((resolve) => {
                    let done = false;
                    const cleanup = (root, div) => {
                        try { if (root && root.unmount) root.unmount(); } catch (_) {}
                        if (div && div.parentNode) div.parentNode.removeChild(div);
                    };
                    try {
                        if (!spec || !spec.items || !spec.items.length) { resolve(''); return; }
                        const div = document.createElement('div');
                        div.style.position = 'fixed';
                        div.style.left = '-99999px';
                        div.style.top = '0';
                        div.style.width = '440px';
                        div.style.pointerEvents = 'none';
                        document.body.appendChild(div);
                        const root = ReactDOM.createRoot(div);
                        root.render(React.createElement(GeomBoard, { spec, compact: true }));
                        // GeomBoard 首帧 view 为 null（useEffect 中 setView 后才有内容），且 React 18 渲染为异步，
                        // 故轮询等待 svg 真正包含图形，避免序列化到空 SVG；超过 2s 兜底放弃。
                        const deadline = Date.now() + 2000;
                        const wait = () => {
                            if (done) return;
                            const svg = div.querySelector('svg');
                            if (svg && svg.childNodes && svg.childNodes.length) {
                                try {
                                    // 补全固有尺寸，确保打印/导出 PDF 时 SVG 高度不塌陷（viewBox + height:auto 在分页场景下会算成 0）
                                    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                                    svg.setAttribute('width', '676');
                                    svg.setAttribute('height', '436');
                                    const str = new XMLSerializer().serializeToString(svg);
                                    done = true;
                                    cleanup(root, div);
                                    resolve(str);
                                } catch (e) {
                                    done = true; cleanup(root, div); resolve('');
                                }
                                return;
                            }
                            if (Date.now() > deadline) { done = true; cleanup(root, div); resolve(''); return; }
                            setTimeout(wait, 60);
                        };
                        setTimeout(wait, 60);
                    } catch (e) { resolve(''); }
                });
                // 并发预渲染所有带图的题目，收集 index -> SVG
                const figSvgs = {};
                const figTasks = deck.questions.map((q, i) => {
                    if (q && q.figure && q.figure.items && q.figure.items.length) {
                        return renderFigureSvg(q.figure).then(svg => { if (svg) figSvgs[i] = svg; });
                    }
                    return Promise.resolve();
                });
                await Promise.all(figTasks);
                const esc = s => escapeHtml(s == null ? '' : String(s));
                // 复用全局 latexToHtml：解析 $...$ / $$...$$ / \(...\) / \[...\] 分隔符并渲染 KaTeX，确保 PDF 内公式正确显示
                const rt = (text) => latexToHtml(text);
                // 选项文本 -> 正确选项字母（A/B/C…）；多选返回字母数组
                const answerLetters = (options, ca) => {
                    if (!Array.isArray(options) || options.length === 0) return null;
                    const cleanOpts = options.map(cleanOption);
                    const findIdx = ans => {
                        const a = cleanOption(ans);
                        let idx = cleanOpts.findIndex(o => o === a);
                        if (idx < 0) idx = options.findIndex(o => o === ans);
                        return idx;
                    };
                    if (Array.isArray(ca)) {
                        return ca.map(findIdx).filter(i => i >= 0).map(i => String.fromCharCode(65 + i));
                    }
                    const idx = findIdx(ca);
                    return idx >= 0 ? [String.fromCharCode(65 + idx)] : null;
                };
                // —— 试卷化排版：按题型分大题、卷头信息栏、答题横线、分页页码 ——
                const TYPE_ORDER = [
                    ['multiple_choice', '选择题'],
                    ['multiple_select', '多选题'],
                    ['true_false', '判断题'],
                    ['fill_blank', '填空题'],
                    ['essay', '解答题'],
                ];
                // 中文数字（大题序号 一、二、三……）
                const cnNum = n => {
                    const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
                    if (n <= 10) return d[n];
                    if (n < 20) return '十' + (n === 10 ? '' : d[n - 10]);
                    if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return d[t] + '十' + (o ? d[o] : ''); }
                    return String(n);
                };
                // 按题型分组（既定顺序优先，其余类型归到「其他题」）
                const byType = {};
                deck.questions.forEach((q, i) => { const t = q.type || 'other'; (byType[t] = byType[t] || []).push(i); });
                const groups = [];
                TYPE_ORDER.forEach(([t, label]) => { if (byType[t] && byType[t].length) groups.push({ type: t, label, idxs: byType[t] }); });
                Object.keys(byType).filter(t => !TYPE_ORDER.some(x => x[0] === t))
                    .forEach(t => groups.push({ type: t, label: TYPE_LABELS[t] || t, idxs: byType[t] }));
                const hasScore = deck.questions.some(q => typeof q.score === 'number' && q.score > 0);
                // 全局连续题号
                let qNo = 0;
                let flow = '';
                groups.forEach((g, gi) => {
                    const cnt = g.idxs.length;
                    let secHead = cnNum(gi + 1) + '、' + g.label;
                    if (hasScore) {
                        let total = 0; g.idxs.forEach(i => { const s = deck.questions[i].score; if (typeof s === 'number') total += s; });
                        secHead += '（本大题共 ' + cnt + ' 小题，共 ' + total + ' 分）';
                    } else {
                        secHead += '（本大题共 ' + cnt + ' 小题）';
                    }
                    flow += '<div class="section-head">' + secHead + '</div>';
                    g.idxs.forEach(i => {
                        qNo++;
                        const q = deck.questions[i];
                        let inner = '<div class="q-stem"><span class="q-no">' + qNo + '.</span> ' +
                            '<span class="q-text">' + rt(q.question) + '</span></div>';
                        if (figSvgs[i]) inner += '<div class="q-fig"><div class="geom-board">' + figSvgs[i] + '</div></div>';
                        if (Array.isArray(q.images) && q.images.length) {
                            inner += '<div class="q-images">' + q.images.map(src => '<img class="q-img" src="' + esc(src) + '" alt="" referrerpolicy="no-referrer" />').join('') + '</div>';
                        }
                        if (Array.isArray(q.options) && q.options.length) {
                            // 仅「含答案与解析」模式下才标记正确选项（✔）；「仅题目」模式不泄露答案
                            const letters = withAnswers ? answerLetters(q.options, q.correctAnswer) : null;
                            let opts = '';
                            q.options.forEach((opt, oi) => {
                                const letter = String.fromCharCode(65 + oi);
                                const isCorrect = letters && letters.includes(letter);
                                opts += '<div class="q-opt' + (isCorrect ? ' correct' : '') + '">' + letter + '. ' + rt(opt) + '</div>';
                            });
                            inner += '<div class="q-opts">' + opts + '</div>';
                        }
                        if (!withAnswers) {
                            // 仅题目：给填空/判断/解答题预留答题横线
                            if (q.type === 'essay') inner += '<div class="q-space">' + '<div class="ln"></div>'.repeat(5) + '</div>';
                            else if (q.type === 'fill_blank') inner += '<div class="q-space"><div class="ln"></div><div class="ln"></div></div>';
                            else if (q.type === 'true_false') inner += '<div class="q-space"><div class="ln"></div></div>';
                        }
                        if (withAnswers) {
                            let ansStr;
                            if (Array.isArray(q.options) && q.options.length) {
                                const letters = answerLetters(q.options, q.correctAnswer);
                                ansStr = (letters && letters.length) ? letters.join('、') :
                                    (Array.isArray(q.correctAnswer) ? q.correctAnswer.join('、') : esc(q.correctAnswer));
                                ansStr = '答案：' + ansStr;
                            } else {
                                const ca = Array.isArray(q.correctAnswer) ? q.correctAnswer.join('、') : q.correctAnswer;
                                ansStr = '答案：' + rt(ca);
                            }
                            if (typeof q.score === 'number' && q.score > 0) ansStr += '（' + q.score + ' 分）';
                            let sol = '<div class="q-ans">' + ansStr + '</div>';
                            if (q.explanation && String(q.explanation).trim()) {
                                sol += '<div class="q-exp"><span class="exp-label">解析　</span><div class="md-content">' + mdToHtml(q.explanation) + '</div></div>';
                            }
                            inner += '<div class="sol">' + sol + '</div>';
                        }
                        flow += '<div class="question">' + inner + '</div>';
                    });
                });
                const safeName = (deck.name || '题库').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
                const dateStr = new Date().toLocaleDateString('zh-CN');
                // 把主文档内联的 KaTeX CSS（含 base64 字体）复制到打印 iframe，否则公式无样式会渲染错乱
                const katexStyleEl = Array.from(document.querySelectorAll('style'))
                    .find(s => s.textContent.indexOf('KaTeX_AMS') >= 0) || null;
                const katexCss = katexStyleEl ? katexStyleEl.textContent : '';
                // 分页参数（px，约 A4 内容区 269mm ≈ 1016px @96dpi）
                const PAGE_H = 1010;
                const FOOT_H = 26;
                const HEAD_FIRST = 116;
                const headHtml = '<div class="paper-head">' +
                    '<div class="paper-title">' + esc(deck.name) + '</div>' +
                    '<div class="paper-rule"></div>' +
                    '<div class="paper-info">姓　名：<span class="blank"></span>　　班　级：<span class="blank"></span>　　学　号：<span class="blank"></span>　　成　绩：<span class="blank"></span></div>' +
                    '<div class="paper-sub">共 ' + deck.questions.length + ' 道题　·　' + (withAnswers ? '含答案与解析' : '仅题目') + '</div>' +
                    '</div>';
                const flowDoc = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(deck.name)}</title>
<style>${katexCss}</style>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#1f2329; font-size:12.5pt; line-height:1.62; margin:0; }
.flow { width:688px; margin:0 auto; }
.paper-head { text-align:center; margin-bottom:14px; }
.paper-title { font-size:22pt; font-weight:800; letter-spacing:2px; color:#111; }
.paper-rule { height:0; border-top:3px double #2b2f36; margin:8px 0 10px; }
.paper-info { font-size:11pt; color:#333; text-align:center; }
.paper-info .blank { display:inline-block; width:74px; border-bottom:1px solid #444; }
.paper-sub { font-size:9.5pt; color:#777; margin-top:8px; }
.section-head { font-weight:700; font-size:13.5pt; color:#111; margin:15px 0 7px; padding-bottom:3px; border-bottom:1px solid #cfd4dc; }
.question { margin:0 0 11px; page-break-inside:avoid; break-inside:avoid; }
.q-stem { margin-bottom:5px; }
.q-no { font-weight:700; margin-right:6px; color:#111; }
.q-fig { text-align:center; margin:8px 0 12px; page-break-inside:avoid; }
.q-images { text-align:center; margin:8px 0 12px; page-break-inside:avoid; }
.q-images .q-img { max-width:420px; width:100%; height:auto; margin:4px; border:1px solid #e3e3e3; border-radius:6px; }
.q-opts { display:grid; grid-template-columns:1fr 1fr; column-gap:26px; row-gap:2px; margin:3px 0 2px 4px; }
.q-opt { margin:1px 0; break-inside:avoid; }
.q-opt.correct { font-weight:700; color:#0f7a32; }
.q-opt.correct::before { content:"✔ "; color:#0f7a32; font-weight:700; }
.q-space { margin:6px 0 4px 4px; }
.q-space .ln { height:25px; border-bottom:1px solid #b9c0cc; }
.sol { margin-top:6px; border-left:3px solid #0f7a32; background:#f3faf4; padding:5px 10px; border-radius:0 5px 5px 0; }
.q-ans { font-weight:700; color:#0f5a26; }
.q-exp { margin-top:3px; color:#333; }
.exp-label { color:#0f7a32; font-weight:700; }
.geom-board { --border:#d0d4dc; --border-strong:#9aa3b2; --text-muted:#5b6472; --card-bg:#ffffff; --text:#1a1a1a; --hl:#1a7f37; }
.geom-board .fig-grid { stroke: var(--border); stroke-width:1; }
.geom-board .fig-axis { stroke: var(--border-strong); stroke-width:1.6; }
.geom-board .fig-axis-arrow { fill: var(--border-strong); }
.geom-board .fig-tick { stroke: var(--border-strong); stroke-width:1; }
.geom-board .fig-label { fill: var(--text-muted); font-size:11px; paint-order:stroke; stroke: var(--card-bg); stroke-width:2.6px; stroke-linejoin:round; }
.geom-board svg { display:block; margin:6px auto; max-width:420px; width:100%; height:auto; aspect-ratio: 676 / 436; }
.page { width:688px; height:${PAGE_H}px; margin:0 auto; display:flex; flex-direction:column; page-break-after:always; }
.page:last-child { page-break-after:auto; }
.page-body { flex:1 1 auto; }
.page-foot { text-align:center; color:#9aa0aa; font-size:9pt; padding-top:5px; margin-top:6px; border-top:1px solid #e6e6e6; }
.md-content { line-height:1.5; word-break:break-word; }
.md-content > :first-child { margin-top:0; } .md-content > :last-child { margin-bottom:0; }
.md-content p.md-p { margin:0 0 5px; }
.md-content h1,.md-content h2,.md-content h3 { margin:8px 0 4px; font-weight:700; }
.md-content h1{font-size:1.2em} .md-content h2{font-size:1.1em} .md-content h3{font-size:1em}
.md-content ul.md-ul,.md-content ol.md-ol { margin:4px 0 5px; padding-left:1.3em; }
.md-content li { margin:1px 0; }
.md-content blockquote.md-quote { border-left:3px solid #9aa3b2; padding:3px 8px; color:#444; margin:5px 0; background:#f4f6f9; }
.md-content code.md-code { background:#eef0f3; padding:0 3px; border-radius:3px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.9em; }
.md-content pre.md-pre { background:#f3f5f8; padding:6px 8px; border-radius:5px; overflow:auto; margin:5px 0; }
.md-content hr.md-hr { border:none; border-top:1px solid #cfd4dc; margin:8px 0; }
.md-content a.md-a { color:#2563eb; text-decoration:underline; }
.md-content table { border-collapse:collapse; width:100%; margin:6px 0; font-size:10pt; }
.md-content th,.md-content td { border:1px solid #b9c0cc; padding:4px 7px; text-align:left; vertical-align:top; }
.md-content thead th { background:#eef2f7; font-weight:700; }
.md-content tbody tr:nth-child(even) { background:#f7f9fc; }
</style></head>
<body>
<div class="flow">${headHtml}${flow}</div>
</body></html>`;
                // 隐藏 iframe 承载打印文档，避免弹出窗口被浏览器拦截
                const iframe = document.createElement('iframe');
                iframe.setAttribute('style', 'position:fixed;left:-10000px;top:0;width:720px;height:1100px;border:0;');
                document.body.appendChild(iframe);
                const idoc = iframe.contentWindow.document;
                idoc.open();
                idoc.write(flowDoc);
                idoc.close();
                // 排版完成后按题高分页，首页让出卷头高度，并补页码页脚；失败则退化为连续排版
                const finalize = () => {
                    try {
                        const flowEl = idoc.querySelector('.flow');
                        // 将卷头(section-head)与其后的题目聚合成「大题块」，分页时标题须与首题同页、不孤行
                        const nodes = Array.from(flowEl.children);
                        const blocks = [];
                        let cur = null;
                        nodes.forEach(n => {
                            const h = n.offsetHeight + 12;
                            const html = n.outerHTML;
                            if (n.classList.contains('section-head')) { cur = { head: html, headH: h, items: [] }; blocks.push(cur); }
                            else if (n.classList.contains('question')) { if (!cur) { cur = { head: null, headH: 0, items: [] }; blocks.push(cur); } cur.items.push({ html, h }); }
                        });
                        const pages = [], flush = () => { if (curArr.length) { pages.push(curArr); curArr = []; curH = 0; avail = PAGE_H - FOOT_H; } };
                        let curArr = [], curH = 0, avail = PAGE_H - FOOT_H - HEAD_FIRST;
                        blocks.forEach(b => {
                            if (!b.items.length) return;
                            const first = b.items[0];
                            // 标题 + 首题需落在同一页，放不下则整块（标题+首题）移到下一页
                            if (curArr.length && curH + b.headH + first.h > avail) flush();
                            if (b.head) { curArr.push({ html: b.head, h: b.headH }); curH += b.headH; }
                            curArr.push(first); curH += first.h;
                            for (let k = 1; k < b.items.length; k++) {
                                const it = b.items[k];
                                if (curArr.length && curH + it.h > avail) flush();
                                curArr.push(it); curH += it.h;
                            }
                        });
                        flush();
                        const total = pages.length;
                        let out = '';
                        pages.forEach((p, pi) => {
                            const head = pi === 0 ? headHtml : '';
                            out += '<div class="page"><div class="page-body">' + head + p.map(x => x.html).join('') +
                                '</div><div class="page-foot">第 ' + (pi + 1) + ' 页 / 共 ' + total + ' 页　·　' + esc(deck.name) + '</div></div>';
                        });
                        idoc.body.innerHTML = '<div class="flow">' + out + '</div>';
                    } catch (e) {
                        try { idoc.body.innerHTML = '<div class="flow">' + headHtml + flow + '</div>'; } catch (_) {}
                    }
                    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {}
                    setTimeout(() => { try { document.body.removeChild(iframe); } catch (_) {} }, 2500);
                };
                // 等待 KaTeX CSS 与图形布局完成后再分页打印；兜底计时器防止 onload 未触发
                iframe.onload = () => setTimeout(finalize, 500);
                setTimeout(finalize, 1800);
            };

            const exportFolder = (folderId, folderName) => {
                const buildNode = (fid, name) => {
                    const node = { kind: 'folder', name, children: [] };
                    getChildDecks(fid).forEach(d => {
                        node.children.push({ kind: 'deck', name: d.name, questions: d.questions });
                    });
                    getChildFolders(fid).forEach(f => {
                        node.children.push(buildNode(f.id, f.name));
                    });
                    return node;
                };
                const rootNode = buildNode(folderId, folderName || '根目录');
                const payload = { type: 'duo_folder_export', version: 1, name: folderName || '根目录',
                    children: rootNode.children };
                const json = JSON.stringify(payload, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${payload.name}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };

            const importFolderStructure = (tree, targetFolderId) => {
                let decksAdded = 0,
                    questionsAdded = 0,
                    foldersAdded = 0;
                const usedFolderNames = {};
                const usedDeckNames = {};
                const keyOf = pid => (pid || null) === null ? 'root' : pid;
                folders.forEach(f => {
                    const k = keyOf(f.parentId);
                    (usedFolderNames[k] = usedFolderNames[k] || new Set()).add(f.name);
                });
                decks.forEach(d => {
                    const k = keyOf(d.folderId);
                    (usedDeckNames[k] = usedDeckNames[k] || new Set()).add(d.name);
                });
                const makeFolderName = (base, k) => {
                    const set = usedFolderNames[k] = usedFolderNames[k] || new Set();
                    let name = (base || '').trim() || '新建文件夹';
                    if (!set.has(name)) { set.add(name); return name; }
                    let i = 2;
                    while (set.has(`${name} (${i})`)) i++;
                    const finalName = `${name} (${i})`;
                    set.add(finalName);
                    return finalName;
                };
                const makeDeckName = (base, k) => {
                    const set = usedDeckNames[k] = usedDeckNames[k] || new Set();
                    let name = (base || '').trim() || '未命名题库';
                    if (!set.has(name)) { set.add(name); return name; }
                    let i = 2;
                    while (set.has(`${name} (${i})`)) i++;
                    const finalName = `${name} (${i})`;
                    set.add(finalName);
                    return finalName;
                };
                const newFolders = [];
                const newDecks = [];
                const process = (node, parentId) => {
                    const k = keyOf(parentId);
                    (node.children || []).forEach(child => {
                        if (child.kind === 'deck') {
                            const name = makeDeckName(child.name, k);
                            const q = normalizeQuestions(Array.isArray(child.questions) ? child.questions :
                            []);
                            newDecks.push({
                                id: generateId(),
                                name,
                                description: '从文件夹导入',
                                questions: q.map(x => ({ ...x, id: generateId() })),
                                folderId: parentId || null
                            });
                            decksAdded += 1;
                            questionsAdded += q.length;
                        } else if (child.kind === 'folder') {
                            const name = makeFolderName(child.name, k);
                            const fid = generateId();
                            newFolders.push({ id: fid, name, parentId: parentId || null });
                            foldersAdded += 1;
                            process(child, fid);
                        }
                    });
                };
                process(tree, targetFolderId);
                if (newFolders.length) setFolders(prev => [...prev, ...newFolders]);
                if (newDecks.length) setDecks(prev => [...prev, ...newDecks]);
                return { decksAdded, questionsAdded, foldersAdded };
            };

            const renameDeck = (deckId, newName) => {
                if (!newName || newName.trim() === '') return;
                const trimmed = newName.trim();
                const existingNames = decks.filter(d => d.id !== deckId).map(d => d.name);
                let finalName = trimmed;
                if (existingNames.includes(trimmed)) {
                    let i = 1;
                    while (existingNames.includes(`${trimmed} (${i})`)) i++;
                    finalName = `${trimmed} (${i})`;
                }
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, name: finalName } : d));
            };

            const updateDeck = (deckId, patch) => {
                const oldDeck = decks.find(d => d.id === deckId);
                const oldQuestions = oldDeck ? oldDeck.questions : [];
                const newQuestions = patch.questions !== undefined ? normalizeQuestions(patch.questions) :
                oldQuestions;
                const oldIds = new Set(oldQuestions.map(q => q.id));
                const newIds = new Set(newQuestions.map(q => q.id));
                const removedIds = oldQuestions.filter(q => !newIds.has(q.id)).map(q => q.id);
                const keptIds = newQuestions.filter(q => oldIds.has(q.id)).map(q => q.id);
                const newQMap = {};
                newQuestions.forEach(q => { newQMap[q.id] = q; });
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, ...patch } : d));
                if (removedIds.length) {
                    setFavorites(prev => prev.filter(f => !(f.sourceDeckId === deckId && removedIds.includes(f
                        .questionId))));
                    setWrongQuestions(prev => prev.filter(w => !(w.sourceDeckId === deckId && removedIds.includes(w
                        .questionId))));
                }
                if (keptIds.length) {
                    setFavorites(prev => prev.map(f => {
                        if (f.sourceDeckId === deckId && keptIds.includes(f.questionId)) {
                            const q = newQMap[f.questionId];
                            if (!q) return f;
                            return { ...f, question: q.question, type: q.type, options: q.options,
                                correctAnswer: q.correctAnswer, explanation: q.explanation || '',
                                difficulty: q.difficulty || 1 };
                        }
                        return f;
                    }));
                    setWrongQuestions(prev => prev.map(w => {
                        if (w.sourceDeckId === deckId && keptIds.includes(w.questionId)) {
                            const q = newQMap[w.questionId];
                            if (!q) return w;
                            return { ...w, question: q.question, type: q.type, options: q.options || undefined,
                                correctAnswer: q.correctAnswer, explanation: q.explanation || '',
                                difficulty: q.difficulty || 1 };
                        }
                        return w;
                    }));
                }
            };

            // ============================================================
            // 细粒度题目级操作（重构：不再每次重写整道题数组，按 id 精确更新并精确同步侧表）
            // ============================================================
            // 同步 favorites / wrongQuestions 两张侧表（仅当 patch 含展示字段时）
            const _syncSideTablesForQuestion = (deckId, qId, patch) => {
                const need = patch && (patch.question !== undefined || patch.type !== undefined ||
                    patch.options !== undefined || patch.correctAnswer !== undefined ||
                    patch.explanation !== undefined || patch.difficulty !== undefined);
                if (!need) return;
                setFavorites(prev => prev.map(f => (f.sourceDeckId === deckId && f.questionId === qId) ? {
                    ...f,
                    question: patch.question !== undefined ? patch.question : f.question,
                    type: patch.type !== undefined ? patch.type : f.type,
                    options: patch.options !== undefined ? patch.options : f.options,
                    correctAnswer: patch.correctAnswer !== undefined ? patch.correctAnswer : f.correctAnswer,
                    explanation: patch.explanation !== undefined ? (patch.explanation || '') : f.explanation,
                    difficulty: patch.difficulty !== undefined ? (patch.difficulty || 1) : f.difficulty
                } : f));
                setWrongQuestions(prev => prev.map(w => (w.sourceDeckId === deckId && w.questionId === qId) ? {
                    ...w,
                    question: patch.question !== undefined ? patch.question : w.question,
                    type: patch.type !== undefined ? patch.type : w.type,
                    options: patch.options !== undefined ? patch.options : (w.options || undefined),
                    correctAnswer: patch.correctAnswer !== undefined ? patch.correctAnswer : w.correctAnswer,
                    explanation: patch.explanation !== undefined ? (patch.explanation || '') : w.explanation,
                    difficulty: patch.difficulty !== undefined ? (patch.difficulty || 1) : w.difficulty
                } : w));
            };

            // 新增一题（规范化 + 自动分配 id）；返回新建的题目对象
            const addQuestion = (deckId, q) => {
                const nq = normalizeQuestion(q);
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, questions: [...(d.questions || []), nq] } : d));
                return nq;
            };

            // 修改某题：raw 可为完整对象（弹窗保存）或局部 patch（如 {score} / {difficulty}）。
            // 先与现有题（基于最新 prev）合并再规范化，保证类型/答案/分值等始终合法，并同步侧表。
            const updateQuestion = (deckId, qId, raw) => {
                let norm = null;
                setDecks(prev => {
                    const deck = prev.find(d => d.id === deckId);
                    const base = deck && deck.questions.find(q => q.id === qId);
                    if (!base) return prev;
                    norm = normalizeQuestion({ ...base, ...raw }, base);
                    return prev.map(d => d.id === deckId ? {
                        ...d, questions: d.questions.map(q => q.id === qId ? norm : q)
                    } : d);
                });
                if (norm) _syncSideTablesForQuestion(deckId, qId, norm);
            };

            // 复制某题（插到原题紧后，新 id）
            const duplicateQuestion = (deckId, qId) => {
                const deck = decks.find(d => d.id === deckId);
                if (!deck) return null;
                const idx = deck.questions.findIndex(q => q.id === qId);
                if (idx < 0) return null;
                const copy = { ...deck.questions[idx] };
                copy.id = generateId();
                setDecks(prev => prev.map(d => d.id === deckId ? {
                    ...d, questions: [...d.questions.slice(0, idx + 1), copy, ...d.questions.slice(idx + 1)]
                } : d));
                return copy;
            };

            // 删除单题（同步清理侧表）
            const deleteQuestion = (deckId, qId) => {
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, questions: d.questions.filter(q => q.id !== qId) } : d));
                setFavorites(prev => prev.filter(f => !(f.sourceDeckId === deckId && f.questionId === qId)));
                setWrongQuestions(prev => prev.filter(w => !(w.sourceDeckId === deckId && w.questionId === qId)));
            };

            // 批量删除（右键菜单「删除选中」）
            const deleteQuestions = (deckId, qIds) => {
                const idSet = qIds instanceof Set ? qIds : new Set(qIds);
                if (!idSet.size) return;
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, questions: d.questions.filter(q => !idSet.has(q.id)) } : d));
                setFavorites(prev => prev.filter(f => !(f.sourceDeckId === deckId && idSet.has(f.questionId))));
                setWrongQuestions(prev => prev.filter(w => !(w.sourceDeckId === deckId && idSet.has(w.questionId))));
            };

            // 拖拽排序：把 qIds 这组题移动到 targetQid 之前(after=false)/之后(after=true)；targetQid=null 表示移到末尾
            const moveQuestionsToIndex = (deckId, qIds, targetQid, after) => {
                const deck = decks.find(d => d.id === deckId);
                if (!deck) return;
                const idSet = qIds instanceof Set ? qIds : new Set(qIds);
                if (!idSet.size) return;
                const qs = deck.questions;
                const moving = qs.filter(q => idSet.has(q.id));
                const rest = qs.filter(q => !idSet.has(q.id));
                let pos = targetQid != null ? rest.findIndex(q => q.id === targetQid) : rest.length;
                if (pos < 0) pos = rest.length;
                if (after) pos = pos + 1;
                pos = Math.max(0, Math.min(pos, rest.length));
                const newQs = [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, questions: newQs } : d));
            };

            // 把题目移动/复制到其他题库（保留/重建 id，侧表随之迁移或保留）
            const moveQuestionsToDeck = (srcDeckId, qIds, dstDeckId) => {
                if (srcDeckId === dstDeckId) return;
                const idSet = qIds instanceof Set ? qIds : new Set(qIds);
                if (!idSet.size) return;
                const srcDeck = decks.find(d => d.id === srcDeckId);
                if (!srcDeck) return;
                const moving = srcDeck.questions.filter(q => idSet.has(q.id)).map(q => ({ ...q })); // 保留原 id，侧表可跟随
                setDecks(prev => prev.map(d => {
                    if (d.id === srcDeckId) return { ...d, questions: d.questions.filter(q => !idSet.has(q.id)) };
                    if (d.id === dstDeckId) return { ...d, questions: [...d.questions, ...moving] };
                    return d;
                }));
                setFavorites(prev => prev.map(f => (f.sourceDeckId === srcDeckId && idSet.has(f.questionId)) ? { ...f, sourceDeckId: dstDeckId } : f));
                setWrongQuestions(prev => prev.map(w => (w.sourceDeckId === srcDeckId && idSet.has(w.questionId)) ? { ...w, sourceDeckId: dstDeckId } : w));
            };

            const copyQuestionsToDeck = (srcDeckId, qIds, dstDeckId) => {
                if (srcDeckId === dstDeckId) return;
                const idSet = qIds instanceof Set ? qIds : new Set(qIds);
                if (!idSet.size) return;
                const srcDeck = decks.find(d => d.id === srcDeckId);
                if (!srcDeck) return;
                const copies = srcDeck.questions.filter(q => idSet.has(q.id)).map(q => ({ ...q, id: generateId() }));
                setDecks(prev => prev.map(d => d.id === dstDeckId ? { ...d, questions: [...d.questions, ...copies] } : d));
            };

            // 文件夹操作 (不变)
            const getChildFolders = folderId => folders.filter(f => (f.parentId || null) === (folderId || null));
            const getChildDecks = folderId => decks.filter(d => (d.folderId || null) === (folderId || null));

            const getFolderPath = folderId => {
                const path = [];
                let cur = folders.find(f => f.id === folderId);
                const guard = new Set();
                while (cur && !guard.has(cur.id)) {
                    guard.add(cur.id);
                    path.unshift({ id: cur.id, name: cur.name });
                    cur = cur.parentId ? folders.find(f => f.id === cur.parentId) : null;
                }
                return path;
            };

            const isAncestor = (ancestorId, nodeId) => {
                let cur = folders.find(f => f.id === nodeId);
                const guard = new Set();
                while (cur && !guard.has(cur.id)) {
                    if (cur.id === ancestorId) return true;
                    guard.add(cur.id);
                    cur = cur.parentId ? folders.find(f => f.id === cur.parentId) : null;
                }
                return false;
            };

            const uniqueFolderName = (base, parentId) => {
                const siblings = getChildFolders(parentId).map(f => f.name);
                let name = base.trim() || '新建文件夹';
                if (!siblings.includes(name)) return name;
                let i = 2;
                while (siblings.includes(`${name} (${i})`)) i++;
                return `${name} (${i})`;
            };

            const uniqueDeckNameInFolder = (base, targetFolderId, excludeId) => {
                const names = getChildDecks(targetFolderId).filter(d => d.id !== excludeId).map(d => d.name);
                let name = base.trim() || '未命名题库';
                if (!names.includes(name)) return name;
                let i = 2;
                while (names.includes(`${name} (${i})`)) i++;
                return `${name} (${i})`;
            };

            const createFolder = (name, parentId = null) => {
                const newFolder = { id: generateId(), name: uniqueFolderName(name || '新建文件夹', parentId),
                    parentId: parentId || null };
                setFolders(prev => [...prev, newFolder]);
                return newFolder;
            };

            const renameFolder = (id, newName) => {
                if (!newName || !newName.trim()) return;
                const folder = folders.find(f => f.id === id);
                if (!folder) return;
                const finalName = uniqueFolderName(newName.trim(), folder.parentId);
                setFolders(prev => prev.map(f => f.id === id ? { ...f, name: finalName } : f));
            };

            const collectFolderSubtree = folderId => {
                const result = [folderId];
                const stack = [folderId];
                while (stack.length) {
                    const cur = stack.pop();
                    folders.filter(f => f.parentId === cur).forEach(child => {
                        result.push(child.id);
                        stack.push(child.id);
                    });
                }
                return result;
            };

            const deleteFolder = id => {
                const subtree = collectFolderSubtree(id);
                const delDecks = decks.filter(d => subtree.includes(d.folderId || null));
                const delDeckIds = new Set(delDecks.map(d => d.id));
                setFolders(prev => prev.filter(f => !subtree.includes(f.id)));
                setDecks(prev => prev.filter(d => !delDeckIds.has(d.id)));
                setFavorites(prev => prev.filter(f => !delDeckIds.has(f.sourceDeckId)));
                setWrongQuestions(prev => prev.filter(w => !delDeckIds.has(w.sourceDeckId)));
                setClipboard(prev => prev && prev.items ? { ...prev, items: prev.items.filter(it => !(it.kind ===
                        'deck' && delDeckIds.has(it.id)) && !(it.kind === 'folder' && subtree.includes(it.id))) } :
                    prev);
                if (currentFolderId && subtree.includes(currentFolderId)) setCurrentFolderId(null);
            };

            const moveDeckToFolder = (deckId, folderId) => {
                setDecks(prev => prev.map(d => d.id === deckId ? { ...d, folderId: folderId || null } : d));
            };

            const moveFolderToFolder = (folderId, newParentId) => {
                if (folderId === newParentId) return;
                if (newParentId && isAncestor(folderId, newParentId)) return;
                setFolders(prev => prev.map(f => f.id === folderId ? { ...f, parentId: newParentId || null } : f));
            };

            const cloneDeck = (deck, targetFolderId) => ({
                ...deck,
                id: generateId(),
                name: uniqueDeckNameInFolder(deck.name + ' (副本)', targetFolderId),
                folderId: targetFolderId || null,
                questions: (deck.questions || []).map(q => ({ ...q, id: generateId() }))
            });

            const copyDeckToFolder = (deckId, targetFolderId) => {
                const deck = decks.find(d => d.id === deckId);
                if (!deck) return;
                setDecks(prev => [...prev, cloneDeck(deck, targetFolderId)]);
            };

            const copyFolderToFolder = (folderId, targetFolderId) => {
                const newFolders = [];
                const newDecks = [];
                const idMap = {};
                const src = folders.find(f => f.id === folderId);
                if (!src) return;
                const cloneTree = (fid, parentId) => {
                    const s = folders.find(f => f.id === fid);
                    if (!s) return;
                    const nid = generateId();
                    idMap[fid] = nid;
                    newFolders.push({ id: nid, name: uniqueFolderName(s.name + ' (副本)', parentId), parentId });
                    decks.filter(d => (d.folderId || null) === fid).forEach(d => newDecks.push(cloneDeck(d, nid)));
                    folders.filter(f => f.parentId === fid).forEach(c => cloneTree(c.id, nid));
                };
                cloneTree(folderId, targetFolderId || null);
                setFolders(prev => [...prev, ...newFolders]);
                setDecks(prev => [...prev, ...newDecks]);
            };

            const copyToClipboard = items => setClipboard({ action: 'copy', items });
            const cutToClipboard = items => setClipboard({ action: 'cut', items });
            const clearClipboard = () => setClipboard(null);

            const pasteToFolder = targetFolderId => {
                if (!clipboard || !clipboard.items || !clipboard.items.length) return;
                const { action, items } = clipboard;
                items.forEach(it => {
                    if (it.kind === 'deck') {
                        if (action === 'copy') copyDeckToFolder(it.id, targetFolderId);
                        else moveDeckToFolder(it.id, targetFolderId);
                    } else {
                        if (action === 'copy') copyFolderToFolder(it.id, targetFolderId);
                        else moveFolderToFolder(it.id, targetFolderId);
                    }
                });
                if (action === 'cut') setClipboard(null);
            };

            // 错题本操作 (不变)
            const addWrongQuestion = (question, userAnswer, correctAnswer, explanation, aiAnswer, sourceDeckId,
            qaHistory) => {
                const base = {
                    question: question.question,
                    userAnswer: userAnswer,
                    correctAnswer: correctAnswer,
                    explanation: explanation || '',
                    aiAnswer: aiAnswer || '',
                    qaHistory: qaHistory || [],
                    type: question.type,
                    options: question.options || undefined,
                    difficulty: question.difficulty || 1,
                    sourceDeckId: sourceDeckId || 'unknown',
                    questionId: question.id,
                    figure: question.figure || undefined,
                    images: question.images || undefined
                };
                let updatedId;
                // 同样的题目（按 questionId）不重复加入：已存在则更新该条记录
                if (question.id != null) {
                    const existingIndex = wrongQuestions.findIndex(w => w.questionId === question.id);
                    if (existingIndex !== -1) {
                        const ex = wrongQuestions[existingIndex];
                        updatedId = ex.id;   // 同步取 id，避免 setState 回调异步导致返回 undefined
                        setWrongQuestions(prev => {
                            const updated = [...prev];
                            const cur = updated[existingIndex];
                            const wrongAnswers = [...(cur.wrongAnswers || []), userAnswer];  // 追加本次答错答案
                            updated[existingIndex] = {
                                ...cur,
                                ...base,
                                id: ex.id,                          // 保留原 id，不重新生成
                                wrongAnswers,                        // 累积所有答错答案
                                practiceCount: ex.practiceCount || 0,  // 保留练习进度
                                correctCount: ex.correctCount || 0,
                                timestamp: Date.now()
                            };
                            return updated;
                        });
                        return updatedId;
                    }
                }
                const newItem = {
                    id: generateId(),
                    ...base,
                    wrongAnswers: [userAnswer],   // 首次答错答案
                    timestamp: Date.now(),
                    practiceCount: 0,
                    correctCount: 0
                };
                setWrongQuestions(prev => {
                    const newList = [newItem, ...prev];
                    updatedId = newList[0].id;
                    return newList;
                });
                return updatedId;
            };

            const updateWrongAiAnswer = (wrongId, aiAnswer, qaHistory) => {
                setWrongQuestions(prev => prev.map(w => w.id === wrongId ? { ...w, aiAnswer, qaHistory: qaHistory !==
                        undefined ? qaHistory : w.qaHistory } : w));
            };

            const updateFavoriteAiAnswer = (favId, aiAnswer, qaHistory) => {
                setFavorites(prev => prev.map(f => f.id === favId ? { ...f, aiAnswer, qaHistory: qaHistory !==
                        undefined ? qaHistory : f.qaHistory } : f));
            };

            const updateWrongPractice = (wrongId, correct) => {
                setWrongQuestions(prev => prev.map(w => {
                    if (w.id === wrongId) {
                        const newPracticeCount = (w.practiceCount || 0) + 1;
                        const newCorrectCount = (w.correctCount || 0) + (correct ? 1 : 0);
                        return { ...w, practiceCount: newPracticeCount, correctCount: newCorrectCount };
                    }
                    return w;
                }));
            };

            // 练习时再次答错：累加本次答错答案到 wrongAnswers，并更新最新的 userAnswer
            const appendWrongAnswer = (wrongId, answer) => {
                setWrongQuestions(prev => prev.map(w => w.id === wrongId ? {
                    ...w,
                    userAnswer: answer,
                    wrongAnswers: [...(w.wrongAnswers || []), answer]
                } : w));
            };

            const removeWrongQuestion = id => {
                setWrongQuestions(prev => prev.filter(w => w.id !== id));
            };

            const clearWrongQuestions = () => {
                if (confirm('确定要清空所有错题吗？')) setWrongQuestions([]);
            };

            const startPractice = wrongItems => {
                if (!wrongItems || wrongItems.length === 0) { alert('没有可练习的错题'); return; }
                const shuffled = [...wrongItems].sort(() => Math.random() - 0.5);
                setPracticeSession({ items: shuffled, currentIndex: 0, kind: 'wrong', results: {}, startedAt: Date.now() });
                setPracticeResult(null);
                setMode('practice');
            };

            const startFavPractice = favItems => {
                if (!favItems || favItems.length === 0) { alert('收藏夹为空，无法复习'); return; }
                const shuffled = [...favItems].sort(() => Math.random() - 0.5);
                setPracticeSession({ items: shuffled, currentIndex: 0, kind: 'favorite', results: {}, startedAt: Date.now() });
                setPracticeResult(null);
                setMode('practice');
            };

            // 练习模式记录作答结果（与答题模式同理）
            const recordPracticeAnswer = useCallback((idx, correct, score) => {
                setPracticeSession(prev => {
                    if (!prev) return prev;
                    const results = { ...(prev.results || {}) };
                    results[idx] = { correct: !!correct, score: typeof score === 'number' ? score : 0 };
                    return { ...prev, results };
                });
            }, []);

            const getFavKey = question => question.id || question.question;
            const isFavorited = question => {
                const key = getFavKey(question);
                return favorites.some(f => (f.questionId || f.question) === key);
            };

            const addFavorite = (question, sourceDeckId) => {
                const key = getFavKey(question);
                if (favorites.some(f => (f.questionId || f.question) === key)) return;
                const item = {
                    id: generateId(),
                    questionId: key,
                    question: question.question,
                    type: question.type,
                    options: question.options || undefined,
                    correctAnswer: question.correctAnswer,
                    explanation: question.explanation || '',
                    difficulty: question.difficulty || 1,
                    sourceDeckId: sourceDeckId || 'unknown',
                    figure: question.figure || undefined,
                    images: question.images || undefined,
                    timestamp: Date.now()
                };
                setFavorites(prev => [item, ...prev]);
            };

            const removeFavorite = id => {
                setFavorites(prev => prev.filter(f => f.id !== id));
            };

            const toggleFavorite = (question, sourceDeckId) => {
                const key = getFavKey(question);
                if (favorites.some(f => (f.questionId || f.question) === key)) {
                    setFavorites(prev => prev.filter(f => (f.questionId || f.question) !== key));
                } else {
                    addFavorite(question, sourceDeckId);
                }
            };

            const clearFavorites = () => {
                if (confirm('确定要清空收藏夹吗？')) setFavorites([]);
            };

            const nextPractice = () => {
                if (!practiceSession) return;
                const { items, currentIndex } = practiceSession;
                if (currentIndex + 1 < items.length) {
                    setPracticeSession({ ...practiceSession, currentIndex: currentIndex + 1 });
                } else {
                    const results = practiceSession.results || {};
                    const total = items.reduce((s, q) => s + (typeof q.score === 'number' ? q.score : 0), 0);
                    const earned = Object.keys(results).reduce((s, k) => s + (results[k].correct ? results[k].score : 0), 0);
                    // 本次用时 & 获得经验；练习模式此前未实时发放经验，这里统一补发并检测是否升级
                    const timeSpent = practiceSession.startedAt ? Math.max(0, Date.now() - practiceSession.startedAt) : 0;
                    const xpGained = Object.keys(results).reduce((s, k) => s + (results[k].correct ? calcXP(true, (items[k] && items[k].difficulty) || 1) : 0), 0);
                    const correctCount = Object.keys(results).filter(k => results[k].correct).length;
                    let projected = stats;
                    Object.keys(results).forEach(k => { if (results[k].correct) projected = updateUserStats(projected, true, (items[k] && items[k].difficulty) || 1); });
                    const leveledUp = projected.level > (stats ? stats.level : 1);
                    setStats(projected);
                    setPracticeResult({ kind: practiceSession.kind, earned, total, count: items.length, timeSpent, xpGained, correctCount, leveledUp, newLevel: projected.level });
                    // 保留 practiceSession 供「再来一次」；由 ResultPanel 控制返回
                }
            };

            // 标记某栏目「已读」：把上次查看时间更新为现在，侧边栏徽标（未读新增数）随即清零
            const markSeen = (key) => {
                const t = Date.now();
                if (key === 'wrong') setWrongLastSeen(t);
                else if (key === 'favorites') setFavLastSeen(t);
            };

            // ---- 渲染底层优化：拆分为多个独立 Context，避免单一巨型 value 导致的全树重渲染 ----
            // 仅在高相关 context 变化时，对应消费者才重渲染（如切题只影响 Session 消费者，不影响侧边栏/资料卡）。
            const _actions = {
                startLearning, nextQuestion, handleAnswer, recordAnswer, addDeck, deleteDeck, exportDeck, exportDeckPdf, renameDeck,
                updateDeck, addWrongQuestion, removeWrongQuestion, clearWrongQuestions, updateWrongAiAnswer,
                appendWrongAnswer, updateWrongPractice, updateFavoriteAiAnswer, addFavorite, removeFavorite,
                toggleFavorite, isFavorited, clearFavorites, startPractice, startFavPractice, nextPractice, markSeen,
                getChildFolders, getChildDecks, getFolderPath, createFolder, renameFolder, deleteFolder,
                moveDeckToFolder, moveFolderToFolder, copyDeckToFolder, copyFolderToFolder, copyToClipboard,
                cutToClipboard, clearClipboard, pasteToFolder, exportFolder, importFolderStructure,
                addQuestion, updateQuestion, deleteQuestion, deleteQuestions, duplicateQuestion,
                moveQuestionsToIndex, moveQuestionsToDeck, copyQuestionsToDeck
            };
            // 稳定委托：actions 引用永远不变，调用时委托到当前渲染的最新闭包，杜绝陈旧闭包与函数标识抖动
            const _actionsRef = useRef(_actions);
            _actionsRef.current = _actions;
            const actions = useMemo(() => {
                const out = {};
                Object.keys(_actions).forEach(k => { out[k] = (...a) => _actionsRef.current[k](...a); });
                return out;
            }, []);

            const statsValue = useMemo(() => ({ stats }), [stats]);
            const dataValue = useMemo(() => ({
                decks, folders, wrongQuestions, favorites, clipboard, currentFolderId, setCurrentFolderId, setDecks,
                wrongLastSeen, favLastSeen
            }), [decks, folders, wrongQuestions, favorites, clipboard, currentFolderId, setDecks, wrongLastSeen, favLastSeen]);
            const uiValue = useMemo(() => ({ mode, setMode }), [mode]);
            const sessionValue = useMemo(() => ({
                session, practiceSession, setSession, setPracticeSession,
                learnResult, practiceResult, setLearnResult, setPracticeResult
            }), [session, practiceSession, learnResult, practiceResult]);

            return React.createElement(StatsContext.Provider, { value: statsValue },
                React.createElement(DataContext.Provider, { value: dataValue },
                    React.createElement(UiContext.Provider, { value: uiValue },
                        React.createElement(SessionContext.Provider, { value: sessionValue },
                            React.createElement(ActionsContext.Provider, { value: actions }, children)
                        )
                    )
                )
            );
        };

        const useStats = () => useContext(StatsContext);
        const useData = () => useContext(DataContext);
        const useUi = () => useContext(UiContext);
        const useSession = () => useContext(SessionContext);
        const useActions = () => useContext(ActionsContext);
        // 向后兼容：合并所有子 context，已有 useApp() 消费点无需改动
        const useApp = () => ({ ...useStats(), ...useData(), ...useUi(), ...useSession(), ...useActions() });

        // ============================================================
        // 8. ApiSettingsModal (不变)
        // ============================================================
        const ApiSettingsModal = ({ onClose }) => {
            const presets = API_PRESETS;
            const [apiKey, setApiKey] = useState(() => localStorage.getItem('deepseek_key') || '');
            const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('api_base_url') ||
            'https://api.deepseek.com/v1');
            const [model, setModel] = useState(() => localStorage.getItem('api_model') || 'deepseek-chat');
            const [provider, setProvider] = useState(() => {
                const saved = localStorage.getItem('api_provider') || 'deepseek';
                const currentBase = localStorage.getItem('api_base_url') || 'https://api.deepseek.com/v1';
                const currentModel = localStorage.getItem('api_model') || 'deepseek-chat';
                for (const [key, val] of Object.entries(presets)) {
                    if (val.baseUrl === currentBase && val.model === currentModel) return key;
                }
                return 'custom';
            });
            useEffect(() => {
                if (provider !== 'custom' && presets[provider]) {
                    const preset = presets[provider];
                    setBaseUrl(preset.baseUrl);
                    setModel(preset.model);
                    localStorage.setItem('api_base_url', preset.baseUrl);
                    localStorage.setItem('api_model', preset.model);
                    localStorage.setItem('api_provider', provider);
                } else if (provider === 'custom') {
                    localStorage.setItem('api_provider', 'custom');
                }
            }, [provider]);

            const handleBaseUrlChange = val => {
                setBaseUrl(val);
                localStorage.setItem('api_base_url', val);
                let matched = false;
                for (const [key, p] of Object.entries(presets)) {
                    if (p.baseUrl === val && p.model === model) { matched = true; if (provider !== key) setProvider(
                            key); break; }
                }
                if (!matched && provider !== 'custom') setProvider('custom');
            };

            const handleModelChange = val => {
                setModel(val);
                localStorage.setItem('api_model', val);
                let matched = false;
                for (const [key, p] of Object.entries(presets)) {
                    if (p.baseUrl === baseUrl && p.model === val) { matched = true; if (provider !== key) setProvider(
                            key); break; }
                }
                if (!matched && provider !== 'custom') setProvider('custom');
            };

            const handleApiKeyChange = val => {
                setApiKey(val);
                localStorage.setItem('deepseek_key', val);
            };

            // 手写识别相关设置已移除（识别逻辑已删除，画板改为可导出图片 / 交由 AI 批改）。


            return ReactDOM.createPortal(
                React.createElement("div", { className: "modal-overlay", onClick: onClose },
                    React.createElement("div", { className: "modal", onClick: e => e.stopPropagation() },
                        React.createElement("h3", null, "🔧 模型 / API 设置"),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "🧩 服务商"),
                            React.createElement("select", { className: "input-field", value: provider, onChange: e =>
                                    setProvider(e.target.value) },
                                React.createElement("option", { value: "deepseek" }, "DeepSeek"),
                                React.createElement("option", { value: "zhipu" }, "智谱 GLM"),
                                React.createElement("option", { value: "qwen" }, "通义千问"),
                                React.createElement("option", { value: "ollama" }, "Ollama (本地)"),
                                React.createElement("option", { value: "custom" }, "自定义")
                            )
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "🌐 API 地址 (Base URL)"),
                            React.createElement("input", { type: "text", className: "input-field", value: baseUrl,
                                onChange: e => handleBaseUrlChange(e.target.value) })
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "🧠 模型名称"),
                            React.createElement("input", { type: "text", className: "input-field", value: model,
                                onChange: e => handleModelChange(e.target.value) })
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "🔑 API Key"),
                            React.createElement("input", { type: "password", className: "input-field",
                                placeholder: "留空则使用本地模式", value: apiKey, onChange: e =>
                                    handleApiKeyChange(e.target.value) })
                        ),

                        React.createElement("p", { className: "text-muted", style: { fontSize: '0.8rem',
                                marginBottom: 14 } }, "修改即时保存到本地，无需额外点击保存。关闭后顶部状态会自动更新。"),
                        React.createElement("div", { className: "modal-actions" },
                            React.createElement("button", { className: "btn btn-primary", onClick: () => { if (typeof onSaved === 'function') onSaved(); onClose(); } },
                                "完成")
                        )
                    )
                ), document.body);
        };

        // ============================================================
        // 8.5 登录日历弹窗 (StreakCalendarModal)
        // ============================================================
        const StreakCalendarModal = ({ onClose, loginDates, streak }) => {
            const dates = Array.isArray(loginDates) ? loginDates.slice() : [];
            const loginSet = new Set(dates);
            const today = new Date().toISOString().split('T')[0];

            // 计算最长连续
            let longest = 0, cur = 0, prev = null;
            for (const d of dates) {
                if (prev) {
                    const pd = new Date(d + 'T00:00:00Z');
                    const pp = new Date(prev + 'T00:00:00Z');
                    const diff = Math.round((pd - pp) / 86400000);
                    cur = diff === 1 ? cur + 1 : 1;
                } else {
                    cur = 1;
                }
                if (cur > longest) longest = cur;
                prev = d;
            }

            const t = new Date();
            const [initYear, initMonth] = [t.getUTCFullYear(), t.getUTCMonth()];
            const [view, setView] = useState({ year: initYear, month: initMonth });
            const prevMonth = () => setView(v => v.month === 0 ? { year: v.year - 1, month: 11 } :
                { ...v, month: v.month - 1 });
            const nextMonth = () => setView(v => v.month === 11 ? { year: v.year + 1, month: 0 } :
                { ...v, month: v.month + 1 });

            const { year, month } = view;
            const startWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
            const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
            const cells = [];
            for (let i = 0; i < startWeekday; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) {
                cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
            }
            const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

            return ReactDOM.createPortal(
                React.createElement("div", { className: "modal-overlay", onClick: onClose },
                    React.createElement("div", { className: "modal streak-modal", onClick: e => e.stopPropagation() },
                        React.createElement("div", { className: "modal-header" },
                            React.createElement("h3", null, "🔥 登录日历")
                        ),
                        React.createElement("div", { className: "streak-summary" },
                            React.createElement("div", { className: "streak-stat" },
                                React.createElement("strong", null, streak),
                                React.createElement("span", null, "连续天数")),
                            React.createElement("div", { className: "streak-stat" },
                                React.createElement("strong", null, dates.length),
                                React.createElement("span", null, "累计登录")),
                            React.createElement("div", { className: "streak-stat" },
                                React.createElement("strong", null, longest),
                                React.createElement("span", null, "最长连续"))
                        ),
                        React.createElement("div", { className: "calendar-nav" },
                            React.createElement("button", { className: "cal-btn", onClick: prevMonth }, "‹"),
                            React.createElement("div", { className: "cal-title" }, year, "年", month + 1, "月"),
                            React.createElement("button", { className: "cal-btn", onClick: nextMonth }, "›")
                        ),
                        React.createElement("div", { className: "calendar-grid" },
                            ...weekdays.map(w => React.createElement("div", { className: "cal-weekday" }, w)),
                            ...cells.map(ds => {
                                if (ds === null) return React.createElement("div", { className: "cal-cell empty" });
                                const isLogin = loginSet.has(ds);
                                const isToday = ds === today;
                                const cls = "cal-cell" + (isLogin ? " login" : "") + (isToday ? " today" : "");
                                return React.createElement("div", { className: cls, title: isLogin ? "已登录" : "未登录" },
                                    React.createElement("span", { className: "cal-num" }, ds.split('-')[2]),
                                    isLogin && React.createElement("span", { className: "cal-dot" }, "🔥")
                                );
                            })
                        ),
                        React.createElement("div", { className: "calendar-legend" },
                            React.createElement("span", { className: "legend-item" },
                                React.createElement("span", { className: "legend-swatch login-sw" }), "已登录"),
                            React.createElement("span", { className: "legend-item" },
                                React.createElement("span", { className: "legend-swatch today-sw" }), "今天")
                        ),
                        React.createElement("div", { className: "modal-actions" },
                            React.createElement("button", { className: "btn btn-primary", onClick: onClose }, "关闭")
                        )
                    )
                ), document.body);
        };

        // ============================================================
        // 9. Sidebar（重构：左侧常驻导航，取代原顶部 Header）
        // ============================================================
        const factoryReset = async () => {
            // 先挂起落盘并清空节流桶/定时器：否则 removeItem 之后，页面卸载时的 beforeunload/pagehide
            // 会触发 flushSave 把内存里尚未落盘的旧经验(等级/🔥)又写回，导致出厂设置清不掉经验
            _suspendSave = true;
            Object.keys(_saveTimer).forEach(k => { try { clearTimeout(_saveTimer[k]); } catch (e) {} });
            Object.keys(_saveBucket).forEach(k => { delete _saveBucket[k]; });
            ['duo_decks', 'duo_wrong', 'duo_favorites', 'duo_stats', 'duo_session', 'duo_folders',
                'duo_clipboard', 'deepseek_key', 'api_base_url', 'api_model', 'api_provider', 'theme',
                'duo_learner_name', 'duo_learn_seconds', 'ai_temperature', 'duo_migrated_v1',
                'xdd_vol_v1', 'xdd_vol_muted_v1', 'xdd_vol_balance_v1',
                'xdd_music_tracks_v1', 'xdd_loud_v1'
            ].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
            // 清空音乐：播放列表 + 本地音频文件（IndexedDB）+ 响度缓存
            try { await idbClearMusic(); } catch (e) {}
            sessionStorage.setItem('duo_just_reset', '1');
            alert('✅ 已恢复出厂设置，页面即将刷新。');
            location.reload();
        };

        // 恢复出厂设置控件（侧边栏底部，自带三步确认弹窗）
        const FactoryResetControl = () => {
            const [step, setStep] = useState(0);
            const [confirmText, setConfirmText] = useState('');
            const close = () => { setStep(0); setConfirmText(''); };
            const CONFIRM_PHRASE = '恢复出厂设置';
            const matched = confirmText === CONFIRM_PHRASE;
            return React.createElement(React.Fragment, null,
                React.createElement("button", { className: "sidebar-danger", onClick: () => setStep(1),
                    title: "清除全部本地数据（题库、错题本、收藏夹、进度、API 配置与音乐列表）" },
                    "🗑 恢复出厂设置"),
                step > 0 && ReactDOM.createPortal(
                    React.createElement("div", { className: "modal-overlay", onClick: close },
                        React.createElement("div", { className: "modal danger-modal", onClick: e => e.stopPropagation() },
                            step === 1 &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "modal-header" },
                                    React.createElement("h3", null, "⚠️ 恢复出厂设置")
                                ),
                                React.createElement("p", { className: "danger-desc" },
                                    "将清除全部本地数据（题库、错题本、收藏夹、学习进度、API 配置与音乐列表），且无法撤销。"),
                                React.createElement("div", { className: "modal-actions" },
                                    React.createElement("button", { className: "btn btn-outline", onClick: close }, "取消"),
                                    React.createElement("button", { className: "btn-factory", onClick: () => setStep(2) },
                                        "确定，继续")
                                )
                            ),
                            step === 2 &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "modal-header" },
                                    React.createElement("h3", null, "⚠️ 再次确认")
                                ),
                                React.createElement("p", { className: "danger-desc" },
                                    "所有数据将被永久删除，无法恢复！"),
                                React.createElement("div", { className: "modal-actions" },
                                    React.createElement("button", { className: "btn btn-outline", onClick: close }, "取消"),
                                    React.createElement("button", { className: "btn-factory", onClick: () => setStep(3) },
                                        "确认删除")
                                )
                            ),
                            step === 3 &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "modal-header" },
                                    React.createElement("h3", null, "⚠️ 最后确认 · 输入验证")
                                ),
                                React.createElement("p", { className: "danger-desc" },
                                    "为防止误触，请手动输入下方文字以解锁最终删除："),
                                React.createElement("div", { className: "factory-confirm-box" },
                                    React.createElement("code", { className: "factory-confirm-phrase" }, CONFIRM_PHRASE),
                                    React.createElement("input", {
                                        className: "factory-confirm-input",
                                        type: "text",
                                        value: confirmText,
                                        autoFocus: true,
                                        placeholder: CONFIRM_PHRASE,
                                        spellCheck: false,
                                        onChange: e => setConfirmText(e.target.value)
                                    })
                                ),
                                React.createElement("div", { className: "modal-actions" },
                                    React.createElement("button", { className: "btn btn-outline", onClick: close }, "取消"),
                                    React.createElement("button", {
                                        className: "btn-factory", disabled: !matched,
                                        onClick: () => { if (matched) { close(); factoryReset(); } } },
                                        matched ? "永久删除" : "请输入验证文字")
                                )
                            )
                        )
                    ), document.body)
            );
        };

        // 个人资料面板：桌面侧边栏底部与移动端「我的」弹窗共用
        const ProfilePanel = React.memo(() => {
            const { stats } = useStats();
            const { isDark, toggleTheme } = useTheme();
            const [showApiModal, setShowApiModal] = useState(false);
            const [showStreakModal, setShowStreakModal] = useState(false);
            const { level, xp, streak, achievements, loginDates } = stats;
            const pct = Math.min(100, xp / getXpToNextLevel(level) * 100);
            const [apiKey, setApiKey] = useState(() => localStorage.getItem('deepseek_key') || '');
            const hasApi = apiKey.trim().length > 0;
            const [learnerName, setLearnerName] = useState(() => localStorage.getItem('duo_learner_name') || '学习者');
            const [editingName, setEditingName] = useState(false);
            const nameInputRef = useRef(null);
            const commitName = () => {
                const v = (nameInputRef.current && nameInputRef.current.value || '').trim();
                const finalName = v || '学习者';
                setLearnerName(finalName);
                localStorage.setItem('duo_learner_name', finalName);
                setEditingName(false);
            };
            return React.createElement(React.Fragment, null,
                React.createElement("div", { className: "profile" },
                    React.createElement("div", { className: "avatar" }, "L" + level),
                    React.createElement("div", { className: "meta" },
                        editingName
                            ? React.createElement("input", {
                                ref: nameInputRef,
                                className: "name-input",
                                defaultValue: learnerName,
                                maxLength: 16,
                                autoFocus: true,
                                onBlur: commitName,
                                onKeyDown: e => {
                                    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
                                    else if (e.key === 'Escape') { setEditingName(false); }
                                }
                            })
                            : React.createElement("div", {
                                className: "name name-editable",
                                title: "点击修改昵称",
                                onClick: () => setEditingName(true)
                            }, learnerName, React.createElement("span", { className: "name-edit-hint" }, "✎")),
                        React.createElement("div", { className: "sub" }, "Lv." + level + " · 🔥 " + streak)
                    )
                ),
                React.createElement("div", { className: "xp-bar" },
                    React.createElement("div", { className: "xp-bar-fill", style: { width: pct + '%' } })
                ),
                React.createElement("div", { className: "footer-row" },
                    React.createElement("button", { className: "util-btn", onClick: () => setShowApiModal(true),
                        title: "点击切换模型 / API" }, hasApi ? '🔑 已连接' : '🔒 本地'),
                    React.createElement("button", { className: "util-btn", onClick: () => setShowStreakModal(true),
                        title: "点击查看登录日历" }, "🔥 ", streak),
                    React.createElement("button", { className: "util-btn", onClick: toggleTheme,
                        title: "切换主题" }, isDark ? '☀️' : '🌙')
                ),
                achievements.length > 0 && React.createElement("div", { className: "ach-row" },
                    achievements.map((a, i) => React.createElement("span", { className: "ach-chip", key: i }, "🏅"))
                ),
                showApiModal && React.createElement(ApiSettingsModal, { onClose: () => setShowApiModal(false), onSaved: () => setApiKey(localStorage.getItem('deepseek_key') || '') }),
                showStreakModal && React.createElement(StreakCalendarModal, { onClose: () => setShowStreakModal(false),
                    loginDates: loginDates, streak: streak })
            );
        });

        // 导出 / 导入加密备份：密码加密后落地为 .xddbackup 文件，导入时解密并覆盖恢复
        const BackupPanel = () => {
            const [modal, setModal] = useState(null);   // null | 'export' | 'import'
            const [password, setPassword] = useState('');
            const [confirm, setConfirm] = useState('');
            const [error, setError] = useState('');
            const [busy, setBusy] = useState(false);
            const [fileName, setFileName] = useState('');
            const [dragOver, setDragOver] = useState(false);
            const pendingFile = useRef(null);
            const dropZoneRef = useRef(null);
            const fileInputRef = useRef(null);

            const close = () => {
                setModal(null); setPassword(''); setConfirm(''); setError(''); setBusy(false);
                setFileName(''); pendingFile.current = null;
            };

            const doExport = async () => {
                if (!window.XDD_CRYPTO) return setError('加密模块不可用，无法导出备份。');
                if (password.length < 8) return setError('密码至少 8 位，用于加密备份文件。');
                if (password !== confirm) return setError('两次输入的密码不一致。');
                setBusy(true);
                try {
                    const data = await collectBackupData();
                    const text = window.XDD_BACKUP.encryptBackup(data, password);
                    const blob = new Blob([text], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const d = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
                    a.href = url;
                    a.download = `学多多备份_${stamp}.xddbackup`;
                    a.click();
                    URL.revokeObjectURL(url);
                    close();
                    alert('✅ 加密备份已导出。请务必记住密码——没有密码无法恢复，且密码无法找回。');
                } catch (e) {
                    setError('导出失败：' + (e && e.message ? e.message : e));
                    setBusy(false);
                }
            };

            const handlePickedFile = f => {
                if (!f) return;
                if (!/\.(xddbackup|json)$/i.test(f.name)) {
                    setError('请拖入 .xddbackup 备份文件');
                    return;
                }
                // 同步到原生文件输入框，让其也显示文件名（避免 native 仍显示"未选择文件"）
                try {
                    const dt = new DataTransfer();
                    dt.items.add(f);
                    if (fileInputRef.current) fileInputRef.current.files = dt.files;
                } catch (e) {}
                setFileName(f.name);
                pendingFile.current = f;
                setError('');
            };
            const onFile = e => {
                handlePickedFile(e.target.files && e.target.files[0]);
            };

            // 用原生 DOM 监听处理拖入（React 合成事件在 portal 到 body 时对 onDrop 可能漏捕获）
            useEffect(() => {
                if (modal !== 'import') return;
                const el = dropZoneRef.current;
                if (!el) return;
                const onOver = e => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                    setDragOver(true);
                };
                const onLeave = e => {
                    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
                    setDragOver(false);
                };
                const onDrop = e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(false);
                    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                    handlePickedFile(f);
                };
                el.addEventListener('dragover', onOver);
                el.addEventListener('dragleave', onLeave);
                el.addEventListener('drop', onDrop);
                return () => {
                    el.removeEventListener('dragover', onOver);
                    el.removeEventListener('dragleave', onLeave);
                    el.removeEventListener('drop', onDrop);
                };
            }, [modal]);

            const doImport = () => {
                if (!pendingFile.current) return setError('请先选择备份文件。');
                if (!password) return setError('请输入备份时设置的密码。');
                setBusy(true);
                readFileText(pendingFile.current).then(async (text) => {
                    try {
                        const data = window.XDD_BACKUP.decryptBackup(text, password);
                        await applyBackupData(data);
                        alert('✅ 备份已恢复，页面即将重新加载以应用全部数据。');
                        location.reload();
                    } catch (e) {
                        setError('恢复失败：' + (e && e.message ? e.message : e));
                        setBusy(false);
                    }
                }).catch(e => {
                    setError('读取文件失败：' + (e && e.message ? e.message : e));
                    setBusy(false);
                });
            };

            const labelStyle = { display: 'block', marginTop: 12, marginBottom: 4, fontSize: 13, color: 'var(--text-muted)' };

            return React.createElement(React.Fragment, null,
                React.createElement("div", { style: { display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' } },
                    React.createElement("button", { className: "btn btn-outline", onClick: () => { setModal('export'); setError(''); } },
                        "💾 导出加密备份"),
                    React.createElement("button", { className: "btn btn-outline", onClick: () => { setModal('import'); setError(''); } },
                        "📥 导入加密备份")
                ),
                modal && ReactDOM.createPortal(
                    React.createElement("div", { className: "modal-overlay", onClick: close,
                        onDragOver: e => e.preventDefault(), onDrop: e => e.preventDefault() },
                        React.createElement("div", { className: "modal", onClick: e => e.stopPropagation() },
                            React.createElement("div", { className: "modal-header" },
                                React.createElement("h3", null, modal === 'export' ? '💾 导出加密备份' : '📥 导入加密备份')
                            ),
                            modal === 'export'
                                ? React.createElement(React.Fragment, null,
                                    React.createElement("p", { className: "danger-desc" },
                                        "备份包含全部题库、错题本、收藏夹、文件夹、学习进度、API 配置、个人信息与音乐（含本地歌曲），将以你设置的密码用 ChaCha20 加密保存。"),
                                    React.createElement("label", { style: labelStyle }, "设置密码（至少 8 位）"),
                                    React.createElement("input", { type: "password", className: "themed-input", value: password,
                                        autoFocus: true, onChange: e => setPassword(e.target.value), placeholder: "用于加密备份文件" }),
                                    React.createElement("label", { style: labelStyle }, "确认密码"),
                                    React.createElement("input", { type: "password", className: "themed-input", value: confirm,
                                        onChange: e => setConfirm(e.target.value) })
                                )
                                : React.createElement(React.Fragment, null,
                                    React.createElement("p", { className: "danger-desc" },
                                        "选择此前导出的 .xddbackup 文件（也可直接将文件拖入下方区域），并输入当时的密码。恢复将覆盖当前全部本地数据，且无法撤销。"),
                                    React.createElement("div", {
                                        ref: dropZoneRef,
                                        className: "backup-drop" + (dragOver ? " drag-over" : "")
                                    },
                                        React.createElement("input", { ref: fileInputRef, type: "file", accept: ".xddbackup,application/json",
                                            className: "themed-input", onChange: onFile, style: { margin: 0, maxWidth: '100%' } }),
                                        dragOver ? React.createElement("div", { className: "drop-hint" }, "松开以导入备份") : null
                                    ),
                                    fileName ? React.createElement("div", { className: "sub", style: { marginBottom: 8 } },
                                        "已选文件：", fileName) : null,
                                    React.createElement("label", { style: labelStyle }, "备份密码"),
                                    React.createElement("input", { type: "password", className: "themed-input", value: password,
                                        autoFocus: true, onChange: e => setPassword(e.target.value), placeholder: "导出时设置的密码" })
                                ),
                            error ? React.createElement("div", { style: { color: '#e5484d', marginTop: 8, fontSize: 13 } }, error) : null,
                            React.createElement("div", { className: "modal-actions" },
                                React.createElement("button", { className: "btn btn-outline", onClick: close }, "取消"),
                                React.createElement("button", { className: "btn btn-primary", disabled: busy,
                                    onClick: modal === 'export' ? doExport : doImport }, busy ? '处理中…' : (modal === 'export' ? '导出' : '恢复'))
                            )
                        )
                    ), document.body)
            );
        };

        // 「我的」独立页面：复用 ProfilePanel（头像/昵称/等级/🔥/API/主题）+ 备份 + 恢复出厂设置
        const MePage = () => {
            return React.createElement("div", { className: "me-page" },
                React.createElement("div", { className: "me-card" },
                    React.createElement("h2", { className: "me-title" }, "👤 我的"),
                    React.createElement(ProfilePanel, null),
                    React.createElement(BackupPanel, null),
                    React.createElement(FactoryResetControl, null)
                )
            );
        };

        const Sidebar = React.memo(() => {
            const { mode, setMode } = useUi();
            const { wrongQuestions, favorites, wrongLastSeen, favLastSeen } = useData();
            const actions = useActions();
            const { setSession, setPracticeSession } = useSession();
            const active = (mode === 'learn' || mode === 'practice') ? 'home' : mode;
            // 徽标 = 自上次查看以来「新增」的错题/收藏数量（微信未读消息式）；从未查看过则显示总数
            const wrongUnread = wrongLastSeen == null
                ? wrongQuestions.length
                : wrongQuestions.filter(w => (w.timestamp || 0) > wrongLastSeen).length;
            const favUnread = favLastSeen == null
                ? favorites.length
                : favorites.filter(f => (f.timestamp || 0) > favLastSeen).length;
            const navItems = [
                { key: 'home', icon: '📚', label: '我的题库' },
                { key: 'generate', icon: '🤖', label: 'AI 智能拆题(生题)' },
                { key: 'wrong', icon: '📕', label: '错题本', badge: wrongUnread },
                { key: 'favorites', icon: '⭐', label: '收藏夹', badge: favUnread }
            ];
            return React.createElement("aside", { className: "sidebar" },
                React.createElement("div", { className: "brand" },
                    React.createElement("span", { className: "logo" }, "📚"),
                    React.createElement("span", { className: "title" }, "学多多")
                ),
                React.createElement(ClockWidget, null),
                React.createElement("nav", { className: "nav" },
                    React.createElement("div", { className: "nav-label" }, "学习"),
                    navItems.map(it => React.createElement("button", {
                        key: it.key,
                        className: "nav-item"
                            + (active === it.key ? " active" : ""),
                        onClick: () => {
                            // 从做题态切到其它栏目时丢弃进度，避免退出后会话残留
                            if (mode === 'learn') setSession(null);
                            if (mode === 'practice') setPracticeSession(null);
                            // 点开错题本/收藏夹即标记「已读」，徽标清零（点击一次就没了）
                            if (it.key === 'wrong' || it.key === 'favorites') actions.markSeen(it.key);
                            setMode(it.key);
                        }
                    },
                        React.createElement("span", { className: "ico" }, it.icon),
                        React.createElement("span", { className: "label" }, it.label),
                        it.badge ? React.createElement("span", { className: "badge" }, it.badge) : null
                    ))
                ),
                React.createElement("div", { className: "sidebar-footer" },
                    React.createElement(ProfilePanel, null),
                    React.createElement(BackupPanel, null),
                    React.createElement(FactoryResetControl, null)
                )
            );
        });

        // 全屏切换图标（内联 SVG，避免 ⛶/🗗 等字符在无字形字体下不显示）
        function FullscreenIcon(active) {
            const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
            const d = active
                ? 'M9 3v4a2 2 0 0 1-2 2H3 M21 9V5a2 2 0 0 0-2-2h-4 M9 21v-4a2 2 0 0 0-2-2H3 M21 15v4a2 2 0 0 1-2 2h-4'
                : 'M3 9V5a2 2 0 0 1 2-2h4 M21 9V5a2 2 0 0 0-2-2h-4 M3 15v4a2 2 0 0 0 2 2h4 M21 15v4a2 2 0 0 1-2 2h-4';
            return React.createElement('svg', common, React.createElement('path', { d: d }));
        }

        // 坐标轴图标：两条带箭头的垂直/水平轴（当前坐标方向）
        function AxisIcon() {
            const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
            return React.createElement('svg', common,
                React.createElement('path', { d: 'M4 20H20' }),
                React.createElement('path', { d: 'M20 20l-3 -3 M20 20l-3 3' }),
                React.createElement('path', { d: 'M4 20V4' }),
                React.createElement('path', { d: 'M4 4l-3 3 M4 4l3 3' })
            );
        }

        // 网格图标：2×2 小网格
        function GridIcon() {
            const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
            return React.createElement('svg', common,
                React.createElement('path', { d: 'M4 4h16v16H4z' }),
                React.createElement('path', { d: 'M4 10h16 M4 16h16 M10 4v16 M16 4v16' })
            );
        }

        // 题目外部图片渲染：images 为字符串数组（在线链接 http(s):// 或本地内嵌 data URI）
        const QuestionImages = ({ images }) => {
            const [failed, setFailed] = React.useState({});
            React.useEffect(() => { setFailed({}); }, [images]);
            if (!images || !images.length) return null;
            return React.createElement("div", { className: "q-images" },
                images.map((src, i) => failed[i]
                    ? React.createElement("div", {
                        key: i,
                        className: "q-img q-img-broken",
                        title: src
                    }, "⚠️ 图片加载失败（链接失效或需联网）")
                    : React.createElement("img", {
                        key: i,
                        src: src,
                        className: "q-img",
                        alt: "题目图片 " + (i + 1),
                        loading: "lazy",
                        referrerPolicy: "no-referrer",
                        onError: () => setFailed(f => ({ ...f, [i]: true }))
                    })
                )
            );
        };

        // 本地图片文件 → 等比压缩后转 data URI（限制最长边，避免 localStorage 配额爆炸）
        const fileToImageDataUri = (file) => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const img = new Image();
                img.onload = () => {
                    const maxDim = 1280;
                    let { width, height } = img;
                    if (width > maxDim || height > maxDim) {
                        const scale = Math.min(maxDim / width, maxDim / height);
                        width = Math.round(width * scale);
                        height = Math.round(height * scale);
                    }
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = width; canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        resolve(canvas.toDataURL('image/jpeg', 0.85));
                    } catch (e) { resolve(dataUrl); }
                };
                img.onerror = () => resolve(dataUrl);
                img.src = dataUrl;
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });

        // ============================================================
        // 10. QuestionEditModal (不变)
        // ============================================================
        const QuestionEditModal = ({ initial, isNew, onCancel, onSave }) => {
            const [type, setType] = useState(initial.type || 'multiple_choice');
            const [question, setQuestion] = useState(initial.question || '');
            const [options, setOptions] = useState(Array.isArray(initial.options) && initial.options.length ? initial
                .options : initial.type === 'true_false' ? ['正确', '错误'] : ['', '']);
            const [explanation, setExplanation] = useState(initial.explanation || '');
            const [correctAnswer, setCorrectAnswer] = useState(initial.type === 'multiple_select' ? Array.isArray(initial
                .correctAnswer) ? initial.correctAnswer : [] : initial.correctAnswer || '');
            const [difficulty, setDifficulty] = useState(initial.difficulty || 1);
            const [score, setScore] = useState(typeof initial.score === 'number' ? initial.score : DEFAULT_SCORE(initial.type || 'multiple_choice'));
            const [hasFigure, setHasFigure] = useState(!!(initial.figure && initial.figure.items && initial.figure.items.length));
            const [figure, setFigure] = useState((initial.figure && initial.figure.items) ? initial.figure : { items: [] });
            const [importMsg, setImportMsg] = useState('');
            const [importErr, setImportErr] = useState('');
            const [dragOver, setDragOver] = useState(false);
            const ggbFileRef = React.useRef(null);
            const [images, setImages] = useState(Array.isArray(initial.images) ? initial.images : []);
            const [imgSearching, setImgSearching] = useState(false);
            const [pvFullscreen, setPvFullscreen] = useState(false);
            const imageUrlRef = React.useRef(null);
            const imageFileRef = React.useRef(null);
            const addImageUrl = () => {
                const v = (imageUrlRef.current && imageUrlRef.current.value || '').trim();
                if (!v) return;
                if (!/^https?:\/\//i.test(v)) { alert('请输入以 http(s):// 开头的图片链接'); return; }
                setImages(prev => prev.includes(v) ? prev : [...prev, v]);
                imageUrlRef.current.value = '';
            };
            const handleImageFile = async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                if (!/^image\//.test(file.type)) { alert('请选择图片文件'); e.target.value = ''; return; }
                const dataUri = await fileToImageDataUri(file);
                if (dataUri) setImages(prev => [...prev, dataUri]);
                e.target.value = '';
            };
            const searchImage = async () => {
                const q = question.trim();
                if (!q) return alert('请先填写题目内容，便于检索配图');
                setImgSearching(true);
                try {
                    // 1) 用 AI 提炼检索词（若有 key），提高相关性；否则直接用题面原文
                    let query = q;
                    const { apiKey } = getApiConfig();
                    if (apiKey) {
                        try {
                            const prompt = '请为下面这道题目提炼一个用于图片检索的简短关键词/短语（中文或英文均可，越具体越好，不要解释、不要标点，直接输出检索词本身）：\n' + q;
                            const raw = await postChat('你是检索词提炼助手。', prompt, { temperature: 0.2, maxTokens: 60, timeoutMs: 20000 });
                            const t = (raw || '').replace(/[""'‘’「」【】\s]/g, '').trim();
                            if (t) query = t;
                        } catch (_) { /* 提炼失败则用题面原文 */ }
                    }
                    // 2) 真实检索（支持 CORS、匿名可访问），返回真实存在的图片直链
                    const searchCommons = async (kw) => {
                        const url = 'https://commons.wikimedia.org/w/api.php?action=query'
                            + '&generator=search&gsrsearch=' + encodeURIComponent(kw)
                            + '&gsrnamespace=6&gsrlimit=15'
                            + '&prop=imageinfo&iiprop=url%7Cmime%7Csize&iiurlwidth=900&format=json&origin=*';
                        const r = await fetch(url);
                        if (!r.ok) return [];
                        const d = await r.json();
                        const ps = (d && d.query && d.query.pages) ? Object.values(d.query.pages) : [];
                        return ps.map(p => (p.imageinfo && p.imageinfo[0]) || null).filter(Boolean)
                            .filter(info => /^image\/(jpeg|png|gif|webp|svg\+xml)$/i.test(info.mime || ''))
                            .filter(info => {
                                const w = info.thumbwidth || info.width || 0;
                                const h = info.thumbheight || info.height || 0;
                                return w >= 80 && h >= 80 && w <= 2600 && h <= 2600;
                            });
                    };
                    const searchWiki = async (base, kw) => {
                        const url = base + '?action=query&generator=search&gsrsearch=' + encodeURIComponent(kw)
                            + '&gsrnamespace=0&gsrlimit=10&prop=pageimages&piprop=thumbnail&pithumbsize=900&format=json&origin=*';
                        const r = await fetch(url);
                        if (!r.ok) return [];
                        const d = await r.json();
                        const ps = (d && d.query && d.query.pages) ? Object.values(d.query.pages) : [];
                        return ps.map(p => p.thumbnail && p.thumbnail.source ? { thumburl: p.thumbnail.source } : null).filter(Boolean);
                    };
                    let cands = await searchCommons(query);
                    if (!cands.length) cands = (await searchWiki('https://zh.wikipedia.org/w/api.php', query)).concat(await searchWiki('https://en.wikipedia.org/w/api.php', query));
                    if (!cands.length) throw new Error('未找到合适的图片（可换关键词，或改用上传本地图片）');
                    const pick = cands.find(info => info.thumburl) || cands[0];
                    const finalUrl = pick.thumburl || pick.url;
                    setImages(prev => prev.includes(finalUrl) ? prev : [...prev, finalUrl]);
                } catch (err) {
                    alert('搜图失败：' + (err && err.message ? err.message : err) + '\n（需联网访问 Wikimedia；或改用「📁 上传本地图片」离线内嵌）');
                } finally {
                    setImgSearching(false);
                }
            };
            const doImport = async (f) => {
                if (!f) return;
                setImportErr(''); setImportMsg('正在解析 ' + f.name + ' …');
                try {
                    const res = await readGeogebraFile(f);
                    if (!res.figure.items.length) { setImportErr('该文件未解析出可显示的几何图形'); setImportMsg(''); return; }
                    setFigure(res.figure);
                    let msg = '已成功导入 GeoGebra 图形';
                    if (res.unsupported.length) msg += '（跳过不支持：' + res.unsupported.join('、') + '）';
                    setImportMsg(msg);
                } catch (err) { setImportErr('导入失败：' + (err && err.message ? err.message : err)); setImportMsg(''); }
            };
            const handleGgbFile = async (e) => {
                const f = e.target.files && e.target.files[0];
                await doImport(f);
                e.target.value = '';
            };
            const handleDrop = async (e) => {
                e.preventDefault(); setDragOver(false);
                const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                await doImport(f);
            };

            const handleTypeChange = t => {
                setType(t);
                if (t === 'true_false') { setOptions(['正确', '错误']);
                    setCorrectAnswer('正确'); } else if (t === 'multiple_choice') { if (!options || options.length <
                        2) setOptions(['', '']);
                    setCorrectAnswer(''); } else if (t === 'multiple_select') { if (!options || options.length < 2)
                        setOptions(['', '', '', '']);
                    setCorrectAnswer([]); } else { setOptions([]);
                    setCorrectAnswer(''); }
            };

            const updateOption = (i, val) => {
                const oldVal = options[i];
                const newOpts = options.map((o, idx) => idx === i ? val : o);
                setOptions(newOpts);
                if (Array.isArray(correctAnswer)) {
                    if (correctAnswer.includes(oldVal)) setCorrectAnswer(correctAnswer.map(x => x === oldVal ? val :
                        x));
                } else if (correctAnswer === oldVal) {
                    setCorrectAnswer(val);
                }
            };

            const addOption = () => setOptions([...options, '']);
            const removeOption = i => {
                const removed = options[i];
                const newOpts = options.filter((_, idx) => idx !== i);
                setOptions(newOpts);
                if (Array.isArray(correctAnswer)) {
                    setCorrectAnswer(correctAnswer.filter(x => x !== removed));
                } else if (correctAnswer === removed) {
                    setCorrectAnswer('');
                }
            };

            const toggleCorrect = o => {
                if (!Array.isArray(correctAnswer)) setCorrectAnswer([o]);
                else if (correctAnswer.includes(o)) setCorrectAnswer(correctAnswer.filter(x => x !== o));
                else setCorrectAnswer([...correctAnswer, o]);
            };

            const handleSave = () => {
                if (!question.trim()) { alert('请输入题目内容'); return; }
                const figOut = (hasFigure && figure && figure.items && figure.items.length) ? figure : undefined;
                const imagesOut = images.length ? images : undefined;
                if (type === 'multiple_choice') {
                    const filled = options.map(o => o.trim()).filter(Boolean);
                    if (filled.length < 2) { alert('选择题至少需要 2 个非空选项'); return; }
                    if (!correctAnswer.trim() || !filled.includes(correctAnswer.trim())) { alert('请选择正确答案（须为选项之一）');
                        return; }
                    onSave({ type, question: question.trim(), options: filled, correctAnswer: correctAnswer.trim(),
                        explanation: explanation.trim(), difficulty: Number(difficulty), score: Number(score) > 0 ? Number(score) : DEFAULT_SCORE(type), figure: figOut, images: imagesOut });
                } else if (type === 'multiple_select') {
                    const filled = options.map(o => o.trim()).filter(Boolean);
                    if (filled.length < 2) { alert('选择题至少需要 2 个非空选项'); return; }
                    const validCorrect = (Array.isArray(correctAnswer) ? correctAnswer : []).filter(c => filled
                    .includes(c));
                    if (validCorrect.length < 1) { alert('多选题请至少勾选一个正确答案（须为选项之一）'); return; }
                    if (validCorrect.length === filled.length) { alert('多选题不能勾选全部选项为正确答案，请至少保留一个错误项'); return; }
                    onSave({ type, question: question.trim(), options: filled, correctAnswer: validCorrect,
                        explanation: explanation.trim(), difficulty: Number(difficulty), score: Number(score) > 0 ? Number(score) : DEFAULT_SCORE(type), figure: figOut, images: imagesOut });
                } else if (type === 'true_false') {
                    onSave({ type, question: question.trim(), options: ['正确', '错误'], correctAnswer,
                        explanation: explanation.trim(), difficulty: Number(difficulty), score: Number(score) > 0 ? Number(score) : DEFAULT_SCORE(type), figure: figOut, images: imagesOut });
                } else {
                    if (!correctAnswer.trim()) { alert('请填写正确答案'); return; }
                    onSave({ type, question: question.trim(), options: [], correctAnswer: correctAnswer.trim(),
                        explanation: explanation.trim(), difficulty: Number(difficulty), score: Number(score) > 0 ? Number(score) : DEFAULT_SCORE(type), figure: figOut, images: imagesOut });
                }
            };

            // 快捷键：Esc 取消、Ctrl/Cmd+Enter 保存
            React.useEffect(() => {
                const onKey = e => {
                    if (e.key === 'Escape') {
                        if (pvFullscreen) { e.preventDefault(); setPvFullscreen(false); }
                        else { e.preventDefault(); onCancel(); }
                    }
                    else if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter')) { e.preventDefault(); handleSave(); }
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            });

            // 实时预览：随表单状态即时渲染题目样貌
            const buildPreview = () => React.createElement(React.Fragment, null,
                React.createElement("div", { className: "qedit-pv-label" }, "题目"),
                React.createElement(LatexAnswerPreview, { value: question || '（未填写题目）' }),
                (type === 'multiple_choice' || type === 'multiple_select' || type === 'true_false') &&
                    React.createElement("div", { className: "qedit-pv-opts" },
                        options.map((o, i) => {
                            const isCorrect = type === 'multiple_select'
                                ? (Array.isArray(correctAnswer) && correctAnswer.includes(o))
                                : correctAnswer === o;
                            return React.createElement("div", { key: i, className: "qedit-pv-opt" + (isCorrect ? " correct" : "") },
                                React.createElement("span", { className: "qedit-pv-mark" }, type === 'multiple_select' ? (isCorrect ? '☑' : '☐') : (isCorrect ? '●' : '○')),
                                React.createElement(LatexSpan, { className: "qedit-pv-opt-txt" }, o || '（空）')
                            );
                        })
                    ),
                (type === 'fill_blank' || type === 'essay') &&
                    React.createElement("div", { className: "qedit-pv-ans" },
                        React.createElement("span", { className: "qedit-pv-label" }, "参考答案"),
                        React.createElement(LatexAnswerPreview, { value: correctAnswer || '（未填写）' })
                    ),
                explanation && React.createElement("div", { className: "qedit-pv-exp" },
                    React.createElement("span", { className: "qedit-pv-label" }, "解析"),
                    React.createElement(LatexAnswerPreview, { value: explanation })
                ),
                React.createElement("div", { className: "qedit-pv-meta" },
                    (TYPE_LABELS[type] || type), ' · ', score, ' 分 · 难度 ', difficulty
                ),
                (figure && figure.items && figure.items.length) ? React.createElement(GeomBoard, { spec: figure, compact: true }) : null,
                (images && images.length) ? React.createElement("div", { className: "qedit-pv-imgs" },
                    images.map((src, i) => React.createElement("img", { key: i, src: src, className: "img-thumb",
                        referrerPolicy: "no-referrer", onError: e => { e.target.style.visibility = 'hidden'; } }))
                ) : null
            );

            return React.createElement(React.Fragment, null,
                ReactDOM.createPortal(
                React.createElement("div", { className: "modal-overlay", onClick: onCancel },
                    React.createElement("div", { className: "modal qedit-modal", onClick: e => e.stopPropagation() },
                        React.createElement("div", { className: "qedit-head" },
                            React.createElement("h3", null, isNew ? '➕ 添加题目' : '✏️ 修改题目'),
                            React.createElement("button", { type: "button", className: "qedit-close", title: "关闭 (Esc)", onClick: onCancel }, "✕")
                        ),
                        React.createElement("div", { className: "qedit-grid" },
                            React.createElement("div", { className: "qedit-form" },
                            React.createElement("div", { className: "qedit-section-title" }, "① 基本信息"),
                            React.createElement("div", { className: "field" },
                                React.createElement("label", null, "题型"),
                            React.createElement("select", { className: "input-field", value: type, onChange: e =>
                                    handleTypeChange(e.target.value) },
                                React.createElement("option", { value: "multiple_choice" }, "选择题"),
                                React.createElement("option", { value: "multiple_select" }, "多选题"),
                                React.createElement("option", { value: "true_false" }, "判断题"),
                                React.createElement("option", { value: "fill_blank" }, "填空题"),
                                React.createElement("option", { value: "essay" }, "解答题")
                            )
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "题目内容"),
                            React.createElement(LatexField, { tag: "textarea", rows: 3, className: "input-field", value: question,
                                onChange: e => setQuestion(e.target.value), placeholder: "输入题目..." }),
                            React.createElement(LatexAnswerPreview, { value: question })
                        ),
                        (type === 'multiple_choice' || type === 'multiple_select') && React.createElement(React.Fragment, null,
                            React.createElement("div", { className: "qedit-section-title" }, "② 选项与答案"),
                            React.createElement("div", { className: "field" },
                                React.createElement("label", null, "选项（", type === 'multiple_select' ?
                                '勾选所有正确答案（可多选）' : '选中圆圈设为正确答案', "）"),
                            options.map((o, i) =>
                                React.createElement(React.Fragment, { key: i },
                                    React.createElement("div", { className: "option-edit-row" },
                                        type === 'multiple_select' ?
                                        React.createElement("input", { type: "checkbox", checked: Array.isArray(
                                                correctAnswer) && correctAnswer.includes(o), onChange: () =>
                                                toggleCorrect(o), title: "勾选为正确答案" }) :
                                        React.createElement("input", { type: "radio", name: "correct", checked: correctAnswer ===
                                                o, onChange: () => setCorrectAnswer(o), title: "设为正确答案" }),
                                        React.createElement(LatexField, { tag: "input", type: "text", className: "input-field",
                                            value: o, onChange: e => updateOption(i, e.target.value),
                                            placeholder: `选项 ${i + 1}` }),
                                        React.createElement("button", { type: "button", className: "btn btn-outline btn-sm",
                                            onClick: () => removeOption(i), disabled: options.length <= 2 }, "✕")
                                    ),
                                    React.createElement(LatexAnswerPreview, { value: o })
                                )
                            ),
                            React.createElement("button", { type: "button", className: "btn btn-outline btn-sm",
                                onClick: addOption, style: { marginTop: 6 } }, "+ 添加选项")
                            )),
                        type === 'true_false' && React.createElement("div", { className: "field" },
                            React.createElement("label", null, "正确答案"),
                            React.createElement("select", { className: "input-field", value: correctAnswer,
                                onChange: e => setCorrectAnswer(e.target.value) },
                                React.createElement("option", { value: "正确" }, "正确"),
                                React.createElement("option", { value: "错误" }, "错误")
                            )
                        ),
                        (type === 'fill_blank' || type === 'essay') && React.createElement("div", { className: "field" },
                            React.createElement("label", null, "正确答案"),
                            React.createElement(LatexField, { tag: "input", type: "text", className: "input-field", value: correctAnswer,
                                onChange: e => setCorrectAnswer(e.target.value), placeholder: "输入正确答案" }),
                            React.createElement(LatexAnswerPreview, { value: correctAnswer })
                        ),
                        React.createElement("div", { className: "qedit-section-title" }, "③ 解析与评分"),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "解析（可选）"),
                            React.createElement(LatexField, { tag: "textarea", rows: 2, className: "input-field", value: explanation,
                                onChange: e => setExplanation(e.target.value), placeholder: "输入解析..." }),
                            React.createElement(LatexAnswerPreview, { value: explanation })
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "难度"),
                            React.createElement("select", { className: "input-field", value: difficulty, onChange: e =>
                                    setDifficulty(Number(e.target.value)) },
                                React.createElement("option", { value: 1 }, "1（简单）"),
                                React.createElement("option", { value: 2 }, "2（中等）"),
                                React.createElement("option", { value: 3 }, "3（困难）")
                            )
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "分值（本题得分）"),
                            React.createElement("div", { className: "score-input", style: { maxWidth: 160 } },
                                React.createElement("input", { type: "number", min: "0", step: "1",
                                    value: score, onChange: e => setScore(e.target.value),
                                    placeholder: "正整数" }),
                                React.createElement("span", { className: "unit" }, "分")
                            )
                        ),
                        React.createElement("div", { className: "qedit-section-title" }, "④ 几何图 / 图片"),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
                                React.createElement("input", { type: "checkbox", checked: hasFigure, onChange: e => {
                                    const on = e.target.checked;
                                    setHasFigure(on);
                                    if (on && (!figure || !figure.items || !figure.items.length)) setFigure({ items: [] });
                                } }),
                                "添加 AI 生成的几何图（支持导入 GeoGebra 文件 .ggb / .geogebra）"
                            ),
                            hasFigure && React.createElement("div", { style: { marginTop: 8 } },
                                React.createElement("div", {
                                    className: 'ggb-dropzone' + (dragOver ? ' over' : ''),
                                    onDragOver: e => { e.preventDefault(); setDragOver(true); },
                                    onDragLeave: e => { e.preventDefault(); setDragOver(false); },
                                    onDrop: handleDrop
                                },
                                    React.createElement("input", { type: 'file', accept: '.ggb,.geogebra,application/zip,application/xml,text/xml', ref: ggbFileRef, style: { display: 'none' }, onChange: handleGgbFile }),
                                    React.createElement("button", { type: 'button', className: 'btn btn-outline', onClick: () => ggbFileRef.current && ggbFileRef.current.click() }, '导入 GeoGebra 文件'),
                                    React.createElement("span", { className: 'ggb-hint' }, '或将 .ggb / .geogebra 文件拖拽到此处'),
                                    (figure && figure.items && figure.items.length) ? React.createElement("button", { type: 'button', className: 'btn btn-ghost', onClick: () => { setFigure({ items: [] }); setImportMsg(''); setImportErr(''); } }, '清除图形') : null
                                ),
                                importMsg && React.createElement("div", { className: 'ggb-msg' }, importMsg),
                                importErr && React.createElement("div", { className: 'ggb-err' }, importErr),
                                (figure && figure.items && figure.items.length) ? React.createElement(GeomBoard, { spec: figure, compact: true }) : null
                            )
                        ),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", null, "图片（可选）— 在线链接或本地文件，支持多张"),
                            React.createElement("div", { className: "img-list" },
                                images.map((src, i) => React.createElement("div", { key: i, className: "img-item" },
                                    React.createElement("img", { src: src, className: "img-thumb", alt: "图片" + (i + 1),
                                        referrerPolicy: "no-referrer",
                                        onError: e => { e.target.style.visibility = 'hidden'; } }),
                                    React.createElement("button", { type: 'button', className: 'btn btn-ghost btn-sm',
                                        onClick: () => setImages(prev => prev.filter((_, j) => j !== i)) }, "移除")
                                ))
                            ),
                            React.createElement("div", { className: "img-add-row" },
                                React.createElement("input", { type: 'text', ref: imageUrlRef, className: 'input-field',
                                    placeholder: '粘贴图片链接 http(s)://...', style: { flex: 1 } }),
                                React.createElement("button", { type: 'button', className: 'btn btn-outline btn-sm',
                                    onClick: addImageUrl }, "添加链接")
                            ),
                            React.createElement("div", { className: "img-add-row", style: { marginTop: 6 } },
                                React.createElement("input", { type: 'file', accept: 'image/*', ref: imageFileRef,
                                    style: { display: 'none' }, onChange: handleImageFile }),
                                React.createElement("button", { type: 'button', className: 'btn btn-outline btn-sm',
                                    onClick: () => imageFileRef.current && imageFileRef.current.click() }, "📁 上传本地图片"),
                                React.createElement("button", { type: 'button', className: 'btn btn-outline btn-sm',
                                    onClick: searchImage, disabled: imgSearching }, imgSearching ? '⏳ 检索中...' : '🤖 AI 搜图')
                            ),
                            React.createElement("p", { className: "text-muted", style: { fontSize: '0.8rem', marginTop: 6 } },
                                "本地图片自动压缩后内嵌保存（离线可用）；「🤖 AI 搜图」现会检索 Wikimedia Commons 真实存在的图片直链（需联网）；手动链接同样需联网加载，死链会标注「加载失败」。")
                        ),
                        ),
                        ),
                        React.createElement("div", { className: "qedit-preview" },
                            React.createElement("div", { className: "qedit-pv-title qedit-pv-title-row" },
                                React.createElement("span", null, "实时预览"),
                                React.createElement("button", { type: "button", className: "qedit-pv-fs", title: "全屏预览 (Esc 退出)", onClick: () => setPvFullscreen(true) }, "⛶ 全屏")
                            ),
                            buildPreview()
                        ),
                        React.createElement("div", { className: "modal-actions" },
                            React.createElement("button", { className: "btn btn-outline", onClick: onCancel },
                                "取消"),
                        React.createElement("button", { className: "btn btn-primary", onClick: handleSave },
                            "保存")
                        )
                    )
                ), document.body
            ),
            pvFullscreen && ReactDOM.createPortal(
                React.createElement("div", { className: "pv-fullscreen-overlay", onClick: () => setPvFullscreen(false) },
                    React.createElement("div", { className: "pv-fullscreen-box", onClick: e => e.stopPropagation() },
                        React.createElement("div", { className: "pv-fullscreen-head" },
                            React.createElement("span", { className: "pv-fullscreen-title" }, "题目预览（全屏）"),
                            React.createElement("button", { type: "button", className: "qedit-close", title: "退出全屏 (Esc)", onClick: () => setPvFullscreen(false) }, "✕")
                        ),
                        React.createElement("div", { className: "pv-fullscreen-body" }, buildPreview())
                    )
                ), document.body
            )
        );
        };

        // ============================================================
        // 11. DeckEditor（重构：单栏增强 + 细粒度题目操作）
        // ============================================================
        // 题库题目行：独立 memo 组件；支持选中高亮 / 拖拽手柄 / 右键菜单
        const DeckQuestionRow = React.memo(({ q, index, selected, onEdit, onDelete, onScoreChange, onDifficultyChange, onSelect, onContextMenu, onGripDragStart, onRowDragOver, onRowDrop, onRowDragEnd, dropIndicator }) => {
            return React.createElement("div", {
                className: "wrong-item deck-q-row" + (selected ? " selected" : "") + (dropIndicator ? " " + dropIndicator : ""),
                "data-qid": q.id,
                onClick: e => onSelect(e, q.id),
                onContextMenu: e => onContextMenu(e, q.id),
                onDragOver: e => onRowDragOver(e, q.id),
                onDrop: e => onRowDrop(e, q.id),
                onDragEnd: onRowDragEnd
            },
                React.createElement("span", {
                    className: "drag-grip", title: "拖拽排序", draggable: true,
                    onDragStart: e => onGripDragStart(e, q.id)
                }, "⠿"),
                React.createElement("div", { className: "deck-q-body" },
                    React.createElement("div", { className: "wrong-item-header" },
                        React.createElement(LatexSpan, { className: "wrong-item-title" }, index + 1, ". ", q.question),
                        React.createElement("span", { className: "wrong-item-meta" }, (TYPE_LABELS[q.type] || q.type), typeof q.score === 'number' ? ' · ' + q.score + '分' : '')
                    ),
                    React.createElement("div", { className: "wrong-actions", style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        React.createElement("label", { style: { fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 } },
                            "分值",
                            React.createElement("div", { className: "score-input", onClick: e => e.stopPropagation() },
                                React.createElement("input", { type: "number", min: "0", step: "1",
                                    value: (typeof q.score === 'number' ? q.score : ''),
                                    onClick: e => e.stopPropagation(),
                                    onChange: e => onScoreChange(q.id, e.target.value) }),
                                React.createElement("span", { className: "unit" }, "分")
                            )
                        ),
                        React.createElement("label", { style: { fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 } },
                            "难度",
                            React.createElement("select", { className: "input-field qedit-difficulty", value: (typeof q.difficulty === 'number' ? q.difficulty : 1),
                                onClick: e => e.stopPropagation(),
                                onChange: e => onDifficultyChange(q.id, e.target.value) },
                                React.createElement("option", { value: 1 }, "简单"),
                                React.createElement("option", { value: 2 }, "中等"),
                                React.createElement("option", { value: 3 }, "困难")
                            )
                        ),
                        React.createElement("button", { className: "btn btn-practice btn-sm", onClick: e => { e.stopPropagation(); onEdit(q.id); } }, "✏️ 修改"),
                        React.createElement("button", { className: "btn btn-danger btn-sm", onClick: e => { e.stopPropagation(); onDelete(q.id); } }, "🗑️ 删除")
                    )
                )
            );
        });

        // 移动/复制题目到其它题库：选择目标题库
        const MoveQuestionsModal = ({ decks, folders, currentDeckId, mode, onCancel, onPick }) => {
            const getPath = folderId => {
                const parts = [];
                let cur = folders.find(f => f.id === folderId);
                const guard = new Set();
                while (cur && !guard.has(cur.id)) { guard.add(cur.id); parts.unshift(cur.name); cur = cur.parentId ? folders.find(f => f.id === cur.parentId) : null; }
                return parts.join(' / ');
            };
            const others = decks.filter(d => d.id !== currentDeckId);
            return ReactDOM.createPortal(
                React.createElement("div", { className: "modal-overlay", onClick: onCancel },
                    React.createElement("div", { className: "modal", onClick: e => e.stopPropagation(), style: { maxWidth: 460 } },
                        React.createElement("h3", null, mode === 'move' ? '移动到其他题库' : '复制到题库'),
                        React.createElement("p", { className: "text-muted", style: { fontSize: '0.85rem', marginTop: -6 } },
                            others.length ? ('选择目标题库，题目将' + (mode === 'move' ? '移动' : '复制') + '到该题库末尾。') : '当前没有其他题库。'),
                        React.createElement("div", { className: "move-deck-list" },
                            others.length ? others.map(d => React.createElement("button", {
                                key: d.id, className: "move-deck-item", onClick: () => onPick(d.id)
                            },
                                React.createElement("span", { className: "move-deck-name" }, d.name),
                                React.createElement("span", { className: "move-deck-sub" }, d.questions.length + " 题" + (d.folderId ? " · " + getPath(d.folderId) : ""))
                            )) : React.createElement("p", { className: "text-muted text-center", style: { padding: '16px 0' } }, "（无其它题库）")
                        ),
                        React.createElement("div", { className: "modal-actions" },
                            React.createElement("button", { className: "btn btn-outline", onClick: onCancel }, "取消")
                        )
                    )
                ), document.body
            );
        };

        const DeckEditor = ({ deckId, onBack }) => {
            const { decks, folders } = useData();
            const { updateQuestion, deleteQuestion, deleteQuestions, addQuestion, exportDeckPdf,
                duplicateQuestion, moveQuestionsToIndex, moveQuestionsToDeck, copyQuestionsToDeck } = useActions();
            const deck = decks.find(d => d.id === deckId);
            const [editing, setEditing] = useState(null);
            const [pageCap, setPageCap] = useState(20);
            const [search, setSearch] = useState('');
            const [typeFilter, setTypeFilter] = useState('all');
            const [selected, setSelected] = useState(() => new Set());
            const [lastAnchor, setLastAnchor] = useState(null);
            const [menu, setMenu] = useState(null);          // { x, y, qid }；qid 为 null 表示空白处菜单
            const [moveModal, setMoveModal] = useState(null); // { mode, qIds }
            const [dropTarget, setDropTarget] = useState(null); // { qid, after }
            const selectedRef = useRef(selected);
            const lastAnchorRef = useRef(lastAnchor);
            const dragQidRef = useRef(null);
            const menuRef = useRef(null);
            useEffect(() => { selectedRef.current = selected; }, [selected]);
            useEffect(() => { lastAnchorRef.current = lastAnchor; }, [lastAnchor]);
            useEffect(() => { setPageCap(20); }, [search, typeFilter]);
            useEffect(() => { setSelected(new Set()); setLastAnchor(null); }, [deckId]);

            useEffect(() => {
                if (!menu) return;
                const onDown = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null); };
                const onKey = e => { if (e.key === 'Escape') setMenu(null); };
                window.addEventListener('mousedown', onDown);
                window.addEventListener('keydown', onKey);
                return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
            }, [menu]);
            // 点卡片外页面留白（含左右两侧空白）→ 作废多选；卡片内/菜单/弹窗不在此处清空
            useEffect(() => {
                const onDocClick = e => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    if (t.closest('.deck-editor') || t.closest('.qctx-menu') || t.closest('.modal-overlay') ||
                        t.closest('.modal') || t.closest('.modal-box')) return;
                    if (selectedRef.current.size > 0) { setSelected(new Set()); setLastAnchor(null); }
                };
                document.addEventListener('click', onDocClick);
                return () => document.removeEventListener('click', onDocClick);
            }, []);

            if (!deck) {
                return React.createElement("div", { className: "card" },
                    React.createElement("div", { className: "card-header" },
                        React.createElement("h2", { style: { color: 'var(--text)' } }, "题库不存在"),
                        React.createElement("button", { className: "btn btn-outline", onClick: onBack }, "返回")
                    ),
                    React.createElement("p", { className: "text-muted text-center", style: { padding: '30px 0' } },
                        "该题库可能已被删除。")
                );
            }

            const blankQuestion = () => ({ type: 'multiple_choice', question: '', options: ['', ''],
                correctAnswer: '', explanation: '', difficulty: 1, score: 3 });

            const idxMap = useMemo(() => { const m = new Map(); deck.questions.forEach((q, i) => m.set(q.id, i)); return m; }, [deck.questions]);

            const filtered = useMemo(() => {
                const kw = search.trim().toLowerCase();
                return deck.questions.filter(q => {
                    if (typeFilter !== 'all' && (q.type || 'other') !== typeFilter) return false;
                    if (kw && !String(q.question || '').toLowerCase().includes(kw)) return false;
                    return true;
                });
            }, [deck.questions, search, typeFilter]);
            const shown = filtered.slice(0, pageCap);
            const remaining = filtered.length - shown.length;

            const handleDelete = useCallback(qid => {
                if (!confirm('确定删除这道题吗？此操作不可撤销。')) return;
                deleteQuestion(deckId, qid);
                setSelected(prev => { const n = new Set(prev); n.delete(qid); return n; });
            }, [deckId, deleteQuestion]);

            const handleScoreChange = useCallback((qid, val) => {
                let n = parseFloat(val); if (isNaN(n) || n < 0) n = 0; n = Math.round(n);
                updateQuestion(deckId, qid, { score: n });
            }, [deckId, updateQuestion]);

            const handleDifficultyChange = useCallback((qid, val) => {
                let n = Number(val); if (!(n >= 1 && n <= 3)) n = 1;
                updateQuestion(deckId, qid, { difficulty: n });
            }, [deckId, updateQuestion]);

            const openEdit = useCallback((qid) => {
                const idx = idxMap.get(qid);
                if (idx == null) return;
                // 深拷贝并剥离运行时字段，避免弹窗持有题目引用
                setEditing({ index: idx, qid, question: cloneQuestion(deck.questions[idx]) });
            }, [idxMap, deck]);
            const openAdd = () => setEditing({ index: -1, qid: null, question: blankQuestion() });

            const handleSave = q => {
                if (editing.index === -1) addQuestion(deckId, q);
                else if (editing.qid) updateQuestion(deckId, editing.qid, q);
                setEditing(null);
            };

            // —— 多选（仿文件管理器：Ctrl/⌘ 点选、Shift 连选）——
            const onSelect = (e, qid) => {
                if (e.metaKey || e.ctrlKey) {
                    setSelected(prev => { const n = new Set(prev); n.has(qid) ? n.delete(qid) : n.add(qid); return n; });
                    setLastAnchor(qid);
                } else if (e.shiftKey && lastAnchorRef.current) {
                    const ids = deck.questions.map(q => q.id);
                    const a = ids.indexOf(lastAnchorRef.current), b = ids.indexOf(qid);
                    if (a >= 0 && b >= 0) {
                        const [lo, hi] = a < b ? [a, b] : [b, a];
                        setSelected(prev => new Set([...prev, ...ids.slice(lo, hi + 1)]));
                    } else { setSelected(new Set([qid])); setLastAnchor(qid); }
                } else { setSelected(new Set([qid])); setLastAnchor(qid); }
            };

            const onContextMenu = (e, qid) => {
                e.preventDefault(); e.stopPropagation();
                if (!selectedRef.current.has(qid)) { setSelected(new Set([qid])); setLastAnchor(qid); }
                setMenu({ x: e.clientX, y: e.clientY, qid });
            };

            // —— 拖拽排序（原生 DnD，手柄发起）——
            const onGripDragStart = (e, qid) => {
                dragQidRef.current = qid;
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', qid); } catch (_) {}
                const rowEl = e.currentTarget.parentElement;
                if (rowEl) { try { e.dataTransfer.setDragImage(rowEl, 24, 18); } catch (_) {} }
            };
            const onRowDragOver = (e, qid) => {
                if (!dragQidRef.current || dragQidRef.current === qid) return;
                e.preventDefault(); e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const after = (e.clientY - rect.top) > rect.height / 2;
                setDropTarget({ qid, after });
            };
            const onRowDrop = (e, qid) => {
                if (!dragQidRef.current) return;
                e.preventDefault();
                const src = dragQidRef.current; dragQidRef.current = null;
                const rect = e.currentTarget.getBoundingClientRect();
                const after = (e.clientY - rect.top) > rect.height / 2;
                const ids = selectedRef.current.has(src) ? Array.from(selectedRef.current) : [src];
                moveQuestionsToIndex(deckId, ids, qid, after);
                setDropTarget(null);
            };
            const onRowDragEnd = () => { dragQidRef.current = null; setDropTarget(null); };

            // —— 右键菜单动作（读取 latest selected）——
            const selIds = () => Array.from(selectedRef.current);
            const actEdit = () => { if (menu && menu.qid) openEdit(menu.qid); setMenu(null); };
            const actDuplicate = () => { if (menu && menu.qid) duplicateQuestion(deckId, menu.qid); setMenu(null); };
            const actMove = () => { const ids = selIds(); if (ids.length) setMoveModal({ mode: 'move', qIds: ids }); setMenu(null); };
            const actCopy = () => { const ids = selIds(); if (ids.length) setMoveModal({ mode: 'copy', qIds: ids }); setMenu(null); };
            const actDelete = () => {
                const ids = selIds(); if (!ids.length) { setMenu(null); return; }
                const label = ids.length > 1 ? ('这 ' + ids.length + ' 道题') : '这道题';
                if (!confirm('确定删除' + label + '吗？此操作不可撤销。')) { setMenu(null); return; }
                deleteQuestions(deckId, ids); setSelected(new Set()); setMenu(null);
            };
            const actExport = () => {
                const ids = selIds(); if (!ids.length) { setMenu(null); return; }
                const idSet = new Set(ids);
                const qs = deck.questions.filter(q => idSet.has(q.id)).map(q => { const { timeSpent, ...rest } = q; return rest; });
                const blob = new Blob([JSON.stringify(qs, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `${deck.name}_题目.json`; a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMenu(null);
            };
            const actSelectAll = () => { setSelected(new Set(deck.questions.map(q => q.id))); setMenu(null); };
            const actClearSel = () => { setSelected(new Set()); setMenu(null); };

            const selNote = selected.size > 1 ? `（${selected.size}）` : '';

            return React.createElement("div", { className: "card deck-editor",
                onClick: e => {
                    // 编辑题库卡片内空白（标题栏/工具栏/列表外）→ 作废多选
                    if (e.target.closest('.wrong-item') || e.target.closest('.qctx-menu') ||
                        e.target.closest('.modal-overlay') || e.target.closest('.modal') ||
                        e.target.closest('.modal-box')) return;
                    if (e.target.closest('button') || e.target.closest('input') ||
                        e.target.closest('select') || e.target.closest('textarea') ||
                        e.target.closest('label') || e.target.closest('a')) return;
                    setSelected(new Set()); setLastAnchor(null);
                } },
                React.createElement("div", { className: "card-header" },
                    React.createElement("h2", { style: { color: 'var(--text)' } }, "✏️ 编辑题库"),
                    React.createElement("div", { className: "actions" },
                        React.createElement("button", { className: "btn btn-outline", onClick: onBack }, "返回")
                    )
                ),
                React.createElement("div", { className: "deck-edit-bar" },
                    React.createElement("div", null,
                        React.createElement("div", { className: "deck-name" }, deck.name),
                        React.createElement("div", { className: "deck-count" }, deck.questions.length, " 道题")
                    ),
                    selected.size > 0 &&
                        React.createElement("span", { className: "deck-selinfo" },
                            "已选 " + selected.size + " 题",
                            React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setSelected(new Set()) }, "清空")
                        ),
                    React.createElement("button", { className: "btn btn-primary", onClick: openAdd }, "➕ 添加题目"),
                    React.createElement("button", { className: "btn btn-outline", onClick: () => exportDeckPdf(deck) }, "📄 导出 PDF")
                ),
                React.createElement("div", { className: "deck-toolbar" },
                    React.createElement("input", { className: "input-field", type: "search", placeholder: "🔍 搜索题目…", value: search,
                        onChange: e => setSearch(e.target.value), style: { flex: '1 1 200px', minWidth: 160 } }),
                    React.createElement("select", { className: "input-field", value: typeFilter, onChange: e => setTypeFilter(e.target.value), style: { flex: '0 0 auto' } },
                        React.createElement("option", { value: "all" }, "全部题型"),
                        React.createElement("option", { value: "multiple_choice" }, "选择题"),
                        React.createElement("option", { value: "multiple_select" }, "多选题"),
                        React.createElement("option", { value: "true_false" }, "判断题"),
                        React.createElement("option", { value: "fill_blank" }, "填空题"),
                        React.createElement("option", { value: "essay" }, "解答题")
                    )
                ),
                React.createElement("div", { className: "deck-questions", onClick: e => {
                        // 点击列表空白处（非题目行）→ 作废全部多选
                        if (e.target === e.currentTarget) { setSelected(new Set()); setLastAnchor(null); }
                    }, onContextMenu: e => {
                        if (e.target.closest('.wrong-item')) return;
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, qid: null });
                    } },
                    deck.questions.length === 0 ?
                    React.createElement("p", { className: "text-muted text-center", style: { padding: '24px 0' } },
                        "该题库还没有题目，点击上方「➕ 添加题目」新增。"
                    ) :
                    filtered.length === 0 ?
                    React.createElement("p", { className: "text-muted text-center", style: { padding: '24px 0' } },
                        "没有匹配的题目。"
                    ) :
                    React.createElement(React.Fragment, null,
                        shown.map(q =>
                            React.createElement(DeckQuestionRow, {
                                key: q.id, q, index: (idxMap.get(q.id) || 0) + 1,
                                selected: selected.has(q.id),
                                onEdit: openEdit, onDelete: handleDelete, onScoreChange: handleScoreChange,
                                onDifficultyChange: handleDifficultyChange,
                                onSelect, onContextMenu,
                                onGripDragStart, onRowDragOver, onRowDrop, onRowDragEnd,
                                dropIndicator: dropTarget && dropTarget.qid === q.id ? (dropTarget.after ? 'drop-after' : 'drop-before') : null
                            })
                        ),
                        remaining > 0 &&
                            React.createElement("div", { style: { textAlign: 'center', padding: '12px 0' } },
                                React.createElement("button", { className: "btn btn-outline", onClick: () => setPageCap(v => v + 20) },
                                    "加载更多 (", remaining, " 题)")
                            )
                    )
                ),
                editing && React.createElement(QuestionEditModal, {
                    key: editing.qid || 'new',
                    initial: editing.question, isNew: editing.index === -1,
                    onCancel: () => setEditing(null), onSave: handleSave
                }),
                menu && React.createElement("div", { ref: menuRef, className: "qctx-menu", style: { left: menu.x, top: menu.y } },
                    menu.qid && React.createElement("button", { onClick: actEdit }, "✏️ 修改"),
                    menu.qid && React.createElement("button", { onClick: actDuplicate }, "📄 复制此题"),
                    selected.size > 0 && React.createElement("div", { className: "sep" }),
                    selected.size > 0 && React.createElement("button", { onClick: actMove }, "➡️ 移动到其他题库" + selNote),
                    selected.size > 0 && React.createElement("button", { onClick: actCopy }, "📋 复制到题库" + selNote),
                    selected.size > 0 && React.createElement("button", { className: "danger", onClick: actDelete }, "🗑️ 删除" + selNote),
                    selected.size > 0 && React.createElement("button", { onClick: actExport }, "📤 导出选中题目" + selNote),
                    React.createElement("div", { className: "sep" }),
                    React.createElement("button", { onClick: actSelectAll }, "✅ 全选"),
                    React.createElement("button", { onClick: actClearSel }, "❌ 取消全选")
                ),
                moveModal && React.createElement(MoveQuestionsModal, {
                    decks, folders, currentDeckId: deckId, mode: moveModal.mode,
                    onCancel: () => setMoveModal(null),
                    onPick: dstId => {
                        if (moveModal.mode === 'move') moveQuestionsToDeck(deckId, moveModal.qIds, dstId);
                        else copyQuestionsToDeck(deckId, moveModal.qIds, dstId);
                        setSelected(new Set()); setMoveModal(null);
                    }
                })
            );
        };

        // ============================================================
        // 12. Home (含 LaTeX 渲染)
        // ============================================================
        const Home = () => {
            const { decks, wrongQuestions, favorites, folders, currentFolderId, setCurrentFolderId, setDecks, clipboard } = useData();
            const { setMode } = useUi();
            const { setSession } = useSession();
            const {
                startLearning,
                deleteDeck,
                exportDeck,
                exportDeckPdf,
                renameDeck,
                addDeck,
                getChildFolders,
                getChildDecks,
                getFolderPath,
                createFolder,
                renameFolder,
                deleteFolder,
                moveDeckToFolder,
                moveFolderToFolder,
                copyDeckToFolder,
                copyFolderToFolder,
                copyToClipboard,
                cutToClipboard,
                clearClipboard,
                pasteToFolder,
                exportFolder,
                importFolderStructure
            } = useActions();

            const fileInputRef = createRef();
            const [showHelp, setShowHelp] = useState(false);
            const [deckSearch, setDeckSearch] = useState('');
            const [deckVisible, setDeckVisible] = useState(10);
            const [editingDeckId, setEditingDeckId] = useState(null);
            const [showNewFolder, setShowNewFolder] = useState(false);
            const [newFolderName, setNewFolderName] = useState('');
            const [menu, setMenu] = useState(null);
            const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
            const menuRef = useRef(null);
            const [moveTarget, setMoveTarget] = useState(null);
            const [moveDest, setMoveDest] = useState(null);
            const [dragOverFolder, setDragOverFolder] = useState(null);
            const [dragOverDeckId, setDragOverDeckId] = useState(null);
            const [dragInsertIdx, setDragInsertIdx] = useState(-1);
            const [showFileDrop, setShowFileDrop] = useState(false);
            const [showRandomModal, setShowRandomModal] = useState(false);
            const [randomDeckIds, setRandomDeckIds] = useState([]);
            const [randomFolderIds, setRandomFolderIds] = useState([]);
            const [randomCount, setRandomCount] = useState('');
            const fileDragDepth = useRef(0);
            const internalDragRef = useRef(false);
            // 自实现指针拖拽（替代原生 HTML5 DnD）所需引用
            const pendingDragRef = useRef(null);     // 指针按下、未越过阈值的候选拖拽
            const dragStateRef = useRef(null);        // 已开始拖拽：{ kind, id, ids }
            const ghostRef = useRef(null);            // 跟随光标的浮动拖拽幽灵
            const customDragCleanupRef = useRef(null); // 移除 window 指针监听
            const dragOverDeckIdRef = useRef(null);   // 避免悬停 setState 重复触发
            const dragInsertIdxRef = useRef(-1);       // 重排插入位置（间隙索引，-1=无）
            const dragOverFolderRef = useRef(null);
            const musicHoverRef = useRef(false);   // 内部拖拽是否悬停在「音乐」面板上
            const foldersRef = useRef(folders);
            const currentFolderIdRef = useRef(currentFolderId);
            const decksRef = useRef(decks);
            // 拖拽题库时列表自动滚动（靠近顶/底边缘时上下滑动）
            const folderListRef = useRef(null);
            const autoScrollRAF = useRef(null);
            const autoScrollSpeed = useRef(0);
            // 多选状态（仿 Windows 文件管理器：Ctrl 点选 / Shift 连选）
            const [selected, setSelected] = useState(() => new Set());
            const [lastAnchor, setLastAnchor] = useState(null);
            const selectedRef = useRef(selected);
            useEffect(() => { selectedRef.current = selected; }, [selected]);

            // 「格式说明」导出用 Markdown 文本（与帮助框内容对应）
            const FORMAT_HELP_MD = [
                '# 学多多 · JSON 题库格式说明',
                '',
                '导入文件可以是 **题目数组**，也可以是 AI 导出的 **{ title, questions }** 对象（两者都支持）。每道题是一个对象，包含以下字段：',
                '',
                '- `type`（必填）— 题型：`"multiple_choice"`（单选）、`"multiple_select"`（多选）、`"true_false"`、`"fill_blank"` 或 `"essay"`',
                '- `question`（必填）— 题目内容（字符串）',
                '- `options`（选择题必填）— 选项数组，例如 `["北京","上海","广州","深圳"]`',
                '- `correctAnswer`（必填）— 正确答案：单选/判断为选项文本字符串；**多选（multiple_select）为正确答案文本的数组**，例如 `["北京","上海"]`，须与选项文本完全一致',
                '- `explanation`（可选）— 解析说明',
                '- `difficulty`（可选）— 难度等级 1~3，默认为 1',
                '- `score`（可选）— 本题分值（正整数）。未填时按题型取默认值：单选 3、多选 4、判断 2、填空 4、解答 8；其他题型 5。可在编辑界面逐题修改，用于练习结算与导出试卷计分。',
                '- `figure`（可选）— 几何 / 函数图像，见下方「figure 字段」',
                '- `images`（可选）— 外部图片（在线链接或本地文件），见下方「images 字段」',
                '',
                '## 各题型 correctAnswer 写法',
                '- 单选 / 判断：选项文本字符串，须与选项 **完全一致**（如 `"焦耳"` 或 `"正确"`）。也兼容单字母（`"A"`→第 1 个选项）写法。',
                '- 多选（multiple_select）：**正确答案文本的数组**，如 `["北京","上海"]`。也兼容 `"AB"` 等连写字母写法（自动转为多选）。',
                '- 填空：标准答案字符串（可含 LaTeX，如 `$$\\\\frac{1}{2}$$`）',
                '- 解答：参考答案字符串（可含 LaTeX / 多行要点）',
                '',
                '## figure 字段（几何 / 函数图像，可选）',
                '顶层结构 `{ v:[xmin,xmax,ymin,ymax], g:网格(通常省略,应用按图形类型自动决定:几何图默认隐藏,含 fn 函数图像默认显示;确需强制可写 g:0 或 g:1), ax:坐标轴(同理:几何图默认隐藏,含 fn 函数图像默认显示;强制可写 ax:0/ax:1), items:[...] }`，items 元素用 `t` 区分类型：',
                '- `pt` 点 {t:"pt",p:[x,y],l:"A",c:"#e74c3c"}',
                '- `seg` 线段 {t:"seg",a:[x1,y1],b:[x2,y2],l:"a"}',
                '- `ln` 直线 {t:"ln",a:[x,y],b:[x,y]}',
                '- `cir` 圆 {t:"cir",o:[x,y],r:3,fill:"#eee"}',
                '- `arc` 圆弧 {t:"arc",o:[x,y],r:3,a0:0,a1:90}',
                '- `pol` 多边形 {t:"pol",p:[[x,y],...],close:1}',
                '- `fn` 函数 {t:"fn",e:"x^2",x0,x1}（y=f(x)）',
                '- `ang` 角 {t:"ang",a:[x,y],b:[x,y],c:[x,y]}',
                '- `vec` 向量 {t:"vec",a:[x,y],b:[x,y]}',
                '- `txt` 文字 {t:"txt",p:[x,y],s:"说明"}',
                '- 依赖对象：`mid`（中点）/ `inter`（交点）/ `onseg`（线上点）/ `perp`（垂线）/ `para`（平行线）—— 引用其他元素标签，几何关系自动联动。更多类型：ray 射线、pf 参数曲线、po 极坐标。',
                '',
                '## images 字段（外部图片，可选）',
                '`images` 为字符串数组，每个元素是一张图片的地址，两种形式均可：',
                '- **在线链接**：以 `http://` / `https://` 开头的图片直链，做题时需联网加载；',
                '- **本地文件（内嵌）**：以 `data:image/...;base64,...` 开头的 Data URI，随题库保存、离线可用（编题上传本地图片会自动压缩转为此格式）。',
                '- 可放 1~N 张，按数组顺序展示；死链或无法加载的图片在界面上自动隐藏，不影响做题。',
                '',
                '## 文件夹导出 / 嵌套导入',
                '- 点「📤 导出文件夹」可把**当前文件夹（或根目录）及其所有子文件夹、题库**整体导出为一个 JSON。',
                '- 「📂 导入题库」支持导入该导出文件：非「根目录」导出会重建同名顶层文件夹并还原内部结构；若导出名为「根目录」则直接落入当前文件夹。',
                '',
                '## LaTeX 支持',
                'AI 生成的题目会自动使用 $...$ 和 $$...$$ 渲染数学公式。',
                '',
                '## 示例（含几何图与图片；注意 LaTeX 反斜杠在 JSON 中需写成 \\\\\\）',
                '```json',
                '[',
                '  {',
                '    "type": "multiple_choice",',
                '    "question": "已知 $E=mc^2$，$c$ 为光速，则 $E$ 的单位是？",',
                '    "options": ["焦耳", "牛顿", "瓦特", "帕斯卡"],',
                '    "correctAnswer": "焦耳",',
                '    "explanation": "$E$ 的单位为焦耳（J）。",',
                '    "difficulty": 1,',
                '    "score": 3',
                '  },',
                '  {',
                '    "type": "multiple_select",',
                '    "question": "下列属于直辖市的是？（多选）",',
                '    "options": ["北京", "上海", "广州", "天津"],',
                '    "correctAnswer": ["北京", "上海", "天津"],',
                '    "difficulty": 1,',
                '    "score": 4',
                '  },',
                '  {',
                '    "question": "$\\\\int_0^\\\\infty e^{-x^2} dx = \\\\frac{\\\\sqrt{\\\\pi}}{2}$，该积分值为 ____。",',
                '    "correctAnswer": "$\\\\frac{\\\\sqrt{\\\\pi}}{2}$",',
                '    "explanation": "高斯积分，结果为 $\\\\frac{\\\\sqrt{\\\\pi}}{2}$。",',
                '    "difficulty": 2,',
                '    "score": 4',
                '  },',
                '  {',
                '    "question": "如图，$\\\\triangle ABC$ 中 $D$ 为 $BC$ 中点，则 $AD$ 是？",',
                '    "options": ["中线", "高", "角平分线", "中位线"],',
                '    "correctAnswer": "中线",',
                '    "difficulty": 1,',
                '    "score": 3,',
                '    "figure": {',
                '      "v": [-1, 5, -1, 4],',
                '      "items": [',
                '        {"t":"pt","p":[0,1],"l":"B"},',
                '        {"t":"pt","p":[4,1],"l":"C"},',
                '        {"t":"pt","p":[2,3.2],"l":"A"},',
                '        {"t":"seg","a":"B","b":"C","l":"f"},',
                '        {"t":"mid","l":"D","a":"B","b":"C"},',
                '        {"t":"seg","a":"A","b":"D"}',
                '      ]',
                '    }',
                '  },',
                '  {',
                '    "type": "multiple_choice",',
                '    "question": "如图，这是哪个国家的国旗？",',
                '    "options": ["中国", "日本", "法国", "德国"],',
                '    "correctAnswer": "法国",',
                '    "difficulty": 1,',
                '    "images": ["https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Flag_of_France.svg/320px-Flag_of_France.svg.png"]',
                '  }',
                ']',
                '```',
                '',
                '> 💡 提示：AI 生成的题目也遵循相同格式（外层带 title），可导出后复用。'
            ].join('\n');

            const exportFormatHelp = () => {
                const blob = new Blob([FORMAT_HELP_MD], { type: 'text/markdown;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '学多多_格式说明.md';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            };

            useEffect(() => { decksRef.current = decks; }, [decks]);
            useEffect(() => { foldersRef.current = folders; }, [folders]);
            useEffect(() => { currentFolderIdRef.current = currentFolderId; }, [currentFolderId]);

            // 按当前时间显示问候与提醒（如提醒睡觉），每分钟刷新一次
            const [nowTick, setNowTick] = useState(() => Date.now());
            useEffect(() => {
                const id = setInterval(() => setNowTick(Date.now()), 60 * 1000);
                return () => clearInterval(id);
            }, []);
            const timeBanner = (() => {
                const d = new Date(nowTick);
                const h = d.getHours();
                if (h >= 0 && h < 5) return { emoji: '🌙', title: '夜深了', text: '已经很晚了，该休息啦，别熬坏了身体，睡个好觉明天更有精神～' };
                if (h < 8) return { emoji: '🌅', title: '清晨好', text: '早安！新的一天开始了，元气满满地开启学习吧～' };
                if (h < 11) return { emoji: '☀️', title: '上午好', text: '上午是专注学习的黄金时间，保持节奏，加油！' };
                if (h < 13) return { emoji: '🍱', title: '午间好', text: '到饭点啦，记得吃午饭并稍作休息，劳逸结合效率更高哦～' };
                if (h < 17) return { emoji: '📖', title: '下午好', text: '下午继续保持节奏，做几道题巩固一下，也记得起来活动活动～' };
                if (h < 19) return { emoji: '🌇', title: '傍晚好', text: '傍晚时分，适当运动放松一下，给大脑充充电吧～' };
                if (h < 22) return { emoji: '🌆', title: '晚上好', text: '晚上适合复习巩固今天的内容，效率高又不累～' };
                return { emoji: '🌙', title: '该睡了', text: '快到休息时间啦，准备洗漱、早点睡觉，身体和学习都重要哦～' };
            })();

            const isFileDrag = e => {
                const t = e.dataTransfer && e.dataTransfer.types;
                return !!t && Array.from(t).includes('Files');
            };

            useEffect(() => {
                // 拖到右侧音乐面板时，由音乐播放器自行处理，不要触发题库的导入浮层
                const inMusic = e => e.target && e.target.closest && e.target.closest('.music-panel');
                const onDragEnter = e => {
                    if (document.querySelector('.modal-overlay')) return;
                    if (internalDragRef.current || !isFileDrag(e)) return;
                    if (inMusic(e)) { setShowFileDrop(false); return; }
                    e.preventDefault();
                    fileDragDepth.current += 1;
                    setShowFileDrop(true);
                };
                const onDragOver = e => {
                    if (document.querySelector('.modal-overlay')) return;
                    if (internalDragRef.current || !isFileDrag(e)) return;
                    // 落在音乐面板：同样兜底 preventDefault + 设 dropEffect，确保 drop 必然触发
                    // （音乐面板的 React 合成 onDragOver 在层级 / 事件委托边缘情况下可能未 prevent，
                    //  这里在 window 级兜底，避免“拖到音乐面板却拖不进”）
                    if (inMusic(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; return; }
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                };
                const onDragLeave = e => {
                    if (document.querySelector('.modal-overlay')) return;
                    if (internalDragRef.current || !isFileDrag(e)) return;
                    if (inMusic(e)) return;
                    fileDragDepth.current -= 1;
                    if (fileDragDepth.current <= 0) { fileDragDepth.current = 0;
                        setShowFileDrop(false); }
                };
                                const onDrop = async e => {
                    if (document.querySelector('.modal-overlay')) return;
                    if (internalDragRef.current || !isFileDrag(e)) return;
                    if (inMusic(e)) {
                        e.preventDefault();
                        fileDragDepth.current = 0; setShowFileDrop(false);
                        // 音乐导入统一在此（window 级）处理，经 xdd:add-music 派发给音乐面板，
                        // 不再依赖音乐面板的 React 合成 onDrop，规避事件委托边缘导致的“拖不进”
                        const files = await gatherDroppedFiles(e.dataTransfer);
                        if (!files || !files.length) {
                            alert('⚠️ 未能读取拖入的内容（拖放 API 没有取到文件）。\n\n如果是「文件夹」：请用右侧音乐面板的「📁 文件夹」按钮来选择文件夹导入——该方式不依赖拖放，最可靠；也可以把 mp3 文件直接拖进来。\n\n（若连「📁 文件夹」按钮也选不到内容，说明该文件夹路径浏览器无权访问，请先把它复制到本地磁盘的普通目录再试。）');
                            return;
                        }
                        const audio = files.filter(isAudioFile);
                        if (!audio.length) {
                            // 拖进来的内容没识别到音频。注意：下面这条提示并非真的在“检测浏览器”，
                            // 而是“文件夹内容没被拖放 API 读到”的兜底——在 Chromium 版 Edge 上理论上应可读到。
                            // 无论哪种情况，最可靠的做法都是用右侧「📁 文件夹」按钮（webkitdirectory 选文件夹）。
                            alert('🎵 拖进来的内容里没有识别到音频文件。\n\n支持格式：mp3 / wav / ogg / m4a / flac / aac / opus / webm / mp4 等。\n\n如果拖的是「文件夹」却读不到：部分 Edge 配置 / 旧版 Edge 对“拖文件夹”支持不稳定，请改用右侧音乐面板的「📁 文件夹」按钮来选择文件夹导入（该方式不依赖拖放，最可靠）；也可以把 mp3 文件直接拖进来。');
                            return;
                        }
                        window.dispatchEvent(new CustomEvent('xdd:add-music', { detail: { files } }));
                        return;
                    }
                    e.preventDefault();
                    fileDragDepth.current = 0;
                    setShowFileDrop(false);
                    const files = await gatherDroppedFiles(e.dataTransfer);
                    if (!files.length) {
                        alert('⚠️ 未检测到文件。\n\n如果您是从压缩包 / 网盘 / 聊天软件里直接拖出的，请先把文件保存到本地磁盘，再从文件资源管理器拖入本页面。\n\n若拖入的是「文件夹」：Edge / Chrome 支持直接把文件夹拖进来；Firefox 不支持拖文件夹，请改用右侧音乐面板的「📁 文件夹」按钮。');
                        return;
                    }
                    const json = files.filter(isJsonFile);
                    const audio = files.filter(isAudioFile);
                    // 含音频就在任意位置直接进音乐面板（不再要求精确命中右侧窄面板，避免“拖不进音乐”）
                    if (audio.length) {
                        window.dispatchEvent(new CustomEvent('xdd:add-music', { detail: { files } }));
                    }
                    if (json.length) {
                        await importFilesToFolder(json, currentFolderId);
                    }
                    if (!json.length && !audio.length) {
                        const names = files.map(f => (f.name || '(无文件名)')).slice(0, 3).join('、');
                        alert('⚠️ 未识别到 .json 题库或音频文件（收到：' + names + (files.length > 3 ? ' 等 ' + files.length + ' 个文件' : '') + '）。\n题库需 .json；音乐请拖 mp3 / wav / flac 等音频，或点右侧「📁 文件夹」按钮。');
                    }
                };
                window.addEventListener('dragenter', onDragEnter);
                window.addEventListener('dragover', onDragOver);
                window.addEventListener('dragleave', onDragLeave);
                window.addEventListener('drop', onDrop);
                return () => {
                    window.removeEventListener('dragenter', onDragEnter);
                    window.removeEventListener('dragover', onDragOver);
                    window.removeEventListener('dragleave', onDragLeave);
                    window.removeEventListener('drop', onDrop);
                };
            }, []);

            // 拖拽题库/文件夹过程中，右键点击即取消本次拖拽：用捕获阶段监听 window，
            // 确保早于 React 的 onContextMenu（onItemContextMenu），直接取消并抑制右键菜单。
            useEffect(() => {
                const onContextMenuCapture = e => {
                    if (!dragStateRef.current && !pendingDragRef.current) return;
                    e.preventDefault();
                    e.stopPropagation();
                    endDrag(e, false); // 取消，不执行合并/移动
                };
                window.addEventListener('contextmenu', onContextMenuCapture, true);
                return () => window.removeEventListener('contextmenu', onContextMenuCapture, true);
            }, []);

            useEffect(() => {
                if (currentFolderId && !folders.find(f => f.id === currentFolderId)) setCurrentFolderId(null);
            }, [currentFolderId, folders]);

            const currentFolder = useMemo(() => folders.find(f => f.id === currentFolderId) || null, [folders, currentFolderId]);
            const folderPath = useMemo(() => getFolderPath(currentFolderId), [getFolderPath, currentFolderId, folders]);
            const childFolders = useMemo(() => getChildFolders(currentFolderId), [getChildFolders, currentFolderId, folders]);
            const childDecksAll = useMemo(() => getChildDecks(currentFolderId), [getChildDecks, currentFolderId, decks]);

            // 缓存：仅当 decks / getChildFolders 变化时才重算，避免随机出题弹窗每次渲染都遍历全部题库
            const collectFolderQuestions = useCallback(folderId => {
                let result = [];
                const stack = [folderId || null];
                while (stack.length) {
                    const fid = stack.pop();
                    result = result.concat(decks.filter(d => (d.folderId || null) === (fid || null)).flatMap(d => d
                        .questions));
                    getChildFolders(fid).forEach(f => stack.push(f.id));
                }
                return result;
            }, [decks, getChildFolders]);

            const openMenu = (e, target) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, target });
                // 先按点击位置放置，避免初次渲染时出现在 (0,0) 再跳动的闪烁
                setMenuPos({ top: e.clientY, left: e.clientX });
            };

            const closeMenu = () => setMenu(null);

            // 右键卡片：若点在已选中的项上 → 对整组选中项弹菜单；否则按 Windows 习惯只选中该项再弹其菜单
            const onItemContextMenu = (e, kind, id, name) => {
                e.preventDefault();
                e.stopPropagation();
                if (selected.has(keyOf(kind, id))) {
                    setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'multi', items: selectedItems, name: `${selected.size} 项` } });
                } else {
                    clearSelection();
                    setSelected(new Set([keyOf(kind, id)]));
                    setMenu({ x: e.clientX, y: e.clientY, target: { kind, id, name } });
                }
                setMenuPos({ top: e.clientY, left: e.clientX });
            };

            // 菜单渲染后实测尺寸，若超出视口则自动翻转（向上 / 向左）或夹紧，保证完全可见、不被遮挡
            useLayoutEffect(() => {
                if (!menu) return;
                const el = menuRef.current;
                if (!el) return;
                const margin = 8;
                const vh = window.innerHeight;
                const vw = window.innerWidth;
                const rect = el.getBoundingClientRect();
                let top = menu.y;
                let left = menu.x;
                // 垂直：下方放不下时优先向上展开，仍放不下则贴底夹紧
                if (top + rect.height > vh - margin) {
                    const above = top - rect.height;
                    top = above >= margin ? above : Math.max(margin, vh - rect.height - margin);
                }
                // 水平：右侧放不下时优先向左展开，仍放不下则贴右夹紧
                if (left + rect.width > vw - margin) {
                    const shift = left - rect.width;
                    left = shift >= margin ? shift : Math.max(margin, vw - rect.width - margin);
                }
                setMenuPos({ top, left });
            }, [menu]);

            const handleNewFolder = () => {
                if (!newFolderName.trim()) return;
                createFolder(newFolderName.trim(), currentFolderId);
                setNewFolderName('');
                setShowNewFolder(false);
            };

            // ====== 自实现指针拖拽（替代原生 HTML5 DnD，使拖拽途中右键可干净取消）======
            const onItemPointerDown = (e, kind, id, reorder = false) => {
                if (e.button !== 0) return; // 仅左键发起拖拽
                // 若拖动的是多选集合内的题库且选中了 >1 个题库，则把全部选中题库一起带上
                let ids = null;
                if (kind === 'deck' && selected.size > 1 && selected.has(keyOf('deck', id))) {
                    const arr = [];
                    selected.forEach(k => { if (k.indexOf('deck:') === 0) arr.push(k.slice(5)); });
                    if (arr.length > 1) ids = arr;
                }
                pendingDragRef.current = { kind, id, ids, startX: e.clientX, startY: e.clientY, started: false, reorder: !!reorder };
                document.body.style.userSelect = 'none';
                const move = (ev) => {
                    const p = pendingDragRef.current;
                    if (!p) return;
                    if (!p.started) {
                        if (Math.hypot(ev.clientX - p.startX, ev.clientY - p.startY) < 6) return;
                        p.started = true;
                        startCustomDrag(p, ev);
                    }
                    updateCustomDrag(ev);
                };
                const up = (ev) => {
                    if (customDragCleanupRef.current) customDragCleanupRef.current();
                    const p = pendingDragRef.current;
                    if (p && p.started) endDrag(ev, true);
                    else document.body.style.userSelect = '';
                    pendingDragRef.current = null;
                };
                customDragCleanupRef.current = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                    window.removeEventListener('pointercancel', up);
                    customDragCleanupRef.current = null;
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
                window.addEventListener('pointercancel', up);
            };

            const startCustomDrag = (p, ev) => {
                dragStateRef.current = p;
                internalDragRef.current = true;
                const label = p.kind === 'deck'
                    ? ((decksRef.current.find(d => d.id === p.id) || {}).name || '题库')
                    : ((foldersRef.current.find(f => f.id === p.id) || {}).name || '文件夹');
                const g = document.createElement('div');
                g.className = 'drag-ghost';
                g.textContent = label;
                g.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;opacity:.9;padding:6px 10px;background:var(--accent,#3b82f6);color:#fff;border-radius:8px;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.35);transform:translate(-12px,-12px);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
                document.body.appendChild(g);
                ghostRef.current = g;
                updateCustomDrag(ev);
            };

            // 计算拖拽落点：落在某题库中央带 → 合并该题库；落在间隙（含题库上/下边缘）→ 返回插入间隙索引
            // 像 Windows 文件夹那样，拖动时在间隙显示插入线，拖到条目正中才执行「合并」
            const computeReorderDrop = (ev, sourceIds) => {
                const list = folderListRef.current;
                const def = { mergeId: null, insertIdx: -1, folderId: null };
                if (!list) return def;
                const deckEls = Array.from(list.querySelectorAll('[data-deck-id]'));
                const srcSet = new Set(sourceIds || []);
                let mergeId = null;
                let insertIdx = deckEls.length;
                for (let i = 0; i < deckEls.length; i++) {
                    const el = deckEls[i];
                    const id = el.getAttribute('data-deck-id');
                    const r = el.getBoundingClientRect();
                    if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
                        const band = r.height * 0.35; // 中央 30% 高区域判定为「合并」
                        if (ev.clientY >= r.top + band && ev.clientY <= r.bottom - band) { mergeId = id; insertIdx = -1; }
                        else if (ev.clientY < r.top + r.height / 2) insertIdx = i;
                        else insertIdx = i + 1;
                        break;
                    }
                }
                if (mergeId === null) {
                    // 落在间隙（或列表上/下方空白处）：取最近间隙
                    for (let i = 0; i < deckEls.length; i++) {
                        const r = deckEls[i].getBoundingClientRect();
                        if (ev.clientY < r.top + r.height / 2) { insertIdx = i; break; }
                        insertIdx = i + 1;
                    }
                }
                if (mergeId && srcSet.has(mergeId)) mergeId = null; // 拖到自己身上不算合并
                if (mergeId === null) {
                    // 悬停在文件夹上（拖到文件夹 = 移动进该文件夹）
                    const folderEls = Array.from(list.querySelectorAll('[data-folder-id]'));
                    for (const fel of folderEls) {
                        const r = fel.getBoundingClientRect();
                        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
                            return { mergeId: null, insertIdx: -1, folderId: fel.getAttribute('data-folder-id') };
                        }
                    }
                }
                return { mergeId, insertIdx, folderId: null };
            };

            const updateCustomDrag = (ev) => {
                const g = ghostRef.current;
                if (g) { g.style.left = ev.clientX + 'px'; g.style.top = ev.clientY + 'px'; }
                // 检测是否悬停在「音乐」面板：面板只接收音频文件，内部拖拽（题库/文件夹）落上去时要给实时反馈并拦截
                const _overEl = document.elementFromPoint(ev.clientX, ev.clientY);
                const _overMusic = !!(_overEl && _overEl.closest && _overEl.closest('.music-panel'));
                if (_overMusic !== musicHoverRef.current) {
                    musicHoverRef.current = _overMusic;
                    window.dispatchEvent(new CustomEvent('xdd:music-hover', { detail: { over: _overMusic } }));
                }
                const state = dragStateRef.current;
                // 题库重排拖拽：实时算落点，区分「合并 / 移动到文件夹 / 插入间隙」
                if (state && state.reorder && state.kind === 'deck') {
                    const ids = (state.ids && state.ids.length ? state.ids : [state.id]).filter(x => x);
                    const drop = computeReorderDrop(ev, ids);
                    if (drop.folderId) {
                        if (dragOverFolderRef.current !== drop.folderId) { dragOverFolderRef.current = drop.folderId; setDragOverFolder(drop.folderId); }
                        if (dragOverDeckIdRef.current !== null) { dragOverDeckIdRef.current = null; setDragOverDeckId(null); }
                        if (dragInsertIdxRef.current !== -1) { dragInsertIdxRef.current = -1; setDragInsertIdx(-1); }
                    } else {
                        if (dragOverDeckIdRef.current !== drop.mergeId) { dragOverDeckIdRef.current = drop.mergeId; setDragOverDeckId(drop.mergeId); }
                        if (dragInsertIdxRef.current !== drop.insertIdx) { dragInsertIdxRef.current = drop.insertIdx; setDragInsertIdx(drop.insertIdx); }
                        if (dragOverFolderRef.current !== null) { dragOverFolderRef.current = null; setDragOverFolder(null); }
                    }
                    autoScrollOnDrag(ev);
                    return;
                }
                const el = document.elementFromPoint(ev.clientX, ev.clientY);
                const deckEl = el && el.closest && el.closest('[data-deck-id]');
                const folderEl = el && el.closest && el.closest('[data-folder-id]');
                const newDeckId = deckEl ? deckEl.getAttribute('data-deck-id') : null;
                const newFolderId = folderEl ? folderEl.getAttribute('data-folder-id') : null;
                if (dragOverDeckIdRef.current !== newDeckId) { dragOverDeckIdRef.current = newDeckId; setDragOverDeckId(newDeckId); }
                if (dragOverFolderRef.current !== newFolderId) { dragOverFolderRef.current = newFolderId; setDragOverFolder(newFolderId); }
                autoScrollOnDrag(ev);
            };

            const endDrag = (ev, doDrop) => {
                const g = ghostRef.current;
                if (g) { g.remove(); ghostRef.current = null; }
                document.body.style.userSelect = '';
                internalDragRef.current = false;
                dragOverDeckIdRef.current = null; setDragOverDeckId(null);
                dragInsertIdxRef.current = -1; setDragInsertIdx(-1);
                dragOverFolderRef.current = null; setDragOverFolder(null);
                stopAutoScroll();
                if (customDragCleanupRef.current) customDragCleanupRef.current();
                const state = dragStateRef.current;
                dragStateRef.current = null;
                pendingDragRef.current = null;
                if (doDrop && state) {
                    // 内部拖拽（题库/文件夹）落到「音乐」面板：面板只接收音频文件，不处理数据拖拽，
                    // 给出明确提示且不改动任何数据（避免无声地把文件夹移动到当前目录，造成“什么都没发生”的错觉）
                    const _dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
                    if (_dropEl && _dropEl.closest && _dropEl.closest('.music-panel')) {
                        if (musicHoverRef.current) { musicHoverRef.current = false; window.dispatchEvent(new CustomEvent('xdd:music-hover', { detail: { over: false } })); }
                        alert('🎵 音乐面板只接收音频文件（.mp3 / .wav / .ogg / .m4a / .flac 等）。\n\n题库和文件夹请拖到左侧题库列表里操作～');
                        return;
                    }
                    // 题库重排拖拽：按落点决定合并 / 移动进文件夹 / 排序（像 Windows 文件夹）
                    if (state.kind === 'deck' && state.reorder) {
                        // 本次拖拽涉及的全部题库（含被抓取项；多选时包含整组选中项）。
                        // 预览（computeReorderDrop）与最终提交（reorder/merge/移动到文件夹）必须使用同一份集合，
                        // 否则会导致被抓取项在最终落点时被漏掉。
                        const sourceIds = (state.ids && state.ids.length ? state.ids : [state.id]).filter(x => x);
                        const drop = computeReorderDrop(ev, sourceIds);
                        if (drop.folderId) {
                            // 拖到文件夹 = 整组移动进该文件夹（保留相对顺序）
                            sourceIds.forEach(id => moveDeckToFolder(id, drop.folderId));
                        } else if (drop.mergeId) {
                            mergeDecks(sourceIds, drop.mergeId);
                        } else {
                            reorderDecks(sourceIds, drop.insertIdx);
                        }
                        clearSelection();
                        return;
                    }
                    const el = document.elementFromPoint(ev.clientX, ev.clientY);
                    const deckEl = el && el.closest && el.closest('[data-deck-id]');
                    const folderEl = el && el.closest && el.closest('[data-folder-id]');
                    if (deckEl) performDrop('deck', deckEl.getAttribute('data-deck-id'), state);
                    else if (folderEl) performDrop('folder', folderEl.getAttribute('data-folder-id'), state);
                    else performDrop('background', null, state);
                }
            };

            const performDrop = (targetKind, targetId, state) => {
                const { kind, id, ids } = state;
                if (targetId != null && targetId === id) return; // 拖到自身，忽略
                if (targetKind === 'deck' && kind === 'deck') {
                    const sourceIds = (ids && ids.length ? ids : [id]).filter(x => x && x !== targetId);
                    if (sourceIds.length >= 1) { mergeDecks(sourceIds, targetId); clearSelection(); return; }
                }
                if (targetKind === 'folder') {
                    if (kind === 'deck') moveDeckToFolder(id, targetId);
                    else if (kind === 'folder') moveFolderToFolder(id, targetId);
                    return;
                }
                if (targetKind === 'deck' && kind === 'folder') {
                    // 文件夹落到题库上：把文件夹移动到该题库所在目录
                    const tdeck = decksRef.current.find(d => d.id === targetId);
                    const fId = tdeck && (tdeck.folderId != null ? tdeck.folderId : currentFolderIdRef.current);
                    moveFolderToFolder(id, fId);
                    return;
                }
                // 落在空白处：移动到当前目录
                if (kind === 'deck') moveDeckToFolder(id, currentFolderIdRef.current);
                else if (kind === 'folder') moveFolderToFolder(id, currentFolderIdRef.current);
            };

            // 拖拽题库时，若指针靠近列表顶/底边缘，自动上下滚动，便于拖到不可见的题库
            const stopAutoScroll = () => {
                if (autoScrollRAF.current) {
                    cancelAnimationFrame(autoScrollRAF.current);
                    autoScrollRAF.current = null;
                }
                autoScrollSpeed.current = 0;
            };

            const autoScrollOnDrag = (e) => {
                const el = folderListRef.current;
                if (!el) return;
                const EDGE = 72;
                const rect = el.getBoundingClientRect();
                const y = e.clientY;
                let speed = 0;
                if (y < rect.top + EDGE) speed = -Math.max(3, (rect.top + EDGE - y) / 3);
                else if (y > rect.bottom - EDGE) speed = Math.max(3, (y - (rect.bottom - EDGE)) / 3);
                autoScrollSpeed.current = speed;
                if (speed !== 0) {
                    if (!autoScrollRAF.current) {
                        const step = () => {
                            el.scrollTop += autoScrollSpeed.current;
                            autoScrollRAF.current = requestAnimationFrame(step);
                        };
                        autoScrollRAF.current = requestAnimationFrame(step);
                    }
                } else {
                    stopAutoScroll();
                }
            };

            // 合并多个题库：新建一个合并题库（题目去重），原题库均保留
            const mergeDecks = async (sourceIds, targetId) => {
                const target = decksRef.current.find(d => d.id === targetId);
                if (!target) return;
                const sources = sourceIds
                    .map(id => decksRef.current.find(d => d.id === id))
                    .filter(d => d && d.id !== target.id);
                if (sources.length === 0) return;
                const combined = [
                    ...(target.questions || []),
                    ...sources.flatMap(s => s.questions || [])
                ];
                const seen = new Set();
                const deduped = [];
                for (const q of combined) {
                    const key = JSON.stringify([q.type, q.question, q.options, q.correctAnswer]);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    deduped.push(q);
                }
                const merged = normalizeQuestions(deduped);
                const name = await generateMergeDeckName([target, ...sources]);
                const uniqueName = generateUniqueName(name, decksRef.current);
                const sourceNames = sources.map(s => `「${s.name}」`).join('、');
                const newDeck = {
                    id: generateId(),
                    name: uniqueName,
                    description: `由「${target.name}」与${sourceNames}合并而成`,
                    folderId: target.folderId != null ? target.folderId : currentFolderIdRef.current || null,
                    questions: merged.map(q => ({ ...q, id: generateId() }))
                };
                setDecks(prev => [...prev, newDeck]);
                alert(`✅ 已合并为「${uniqueName}」（共 ${merged.length} 道题，已自动去重）。\n原题库「${target.name}」${sourceNames}均已保留。`);
            };

            // 拖动题库排序：把 sourceIds 插入到 insertIdx 指定的「间隙」处（insertIdx 为可见题库列表的间隙索引）。
            // 同目录内纯排序；跨目录时改为移动到目标所在目录并贴近参考题库。
            // 顺序即 decks 数组顺序，已随 duo_decks 持久化（含加密备份），刷新/恢复不会重置。
            const reorderDecks = (sourceIds, insertIdx) => {
                const sourceSet = new Set(sourceIds.filter(x => x));
                if (sourceSet.size === 0) return;
                setDecks(prev => {
                    const srcs = prev.filter(d => sourceSet.has(d.id)); // 保持原有相对顺序
                    if (srcs.length === 0) return prev;
                    const remaining = prev.filter(d => !sourceSet.has(d.id));
                    if (insertIdx == null || insertIdx < 0) return [...remaining, ...srcs];
                    // 落点语义：插入线显示在 shownDecks[insertIdx] 之前（insertIdx===len 表示末尾）。
                    // shownDecks 含被拖动项，参考项可能就是源项本身，需跳过连续源项，
                    // 以「插入线之后第一个非源题库」为锚点，避免索引错位导致落点与插入线不符。
                    const list = shownDecksRef.current;
                    let anchorId = null;
                    for (let k = insertIdx; k < list.length; k++) {
                        if (!sourceSet.has(list[k].id)) { anchorId = list[k].id; break; }
                    }
                    const refFull = anchorId != null
                        ? prev.find(d => d.id === anchorId)
                        : (list.length ? prev.find(d => d.id === list[list.length - 1].id) : null);
                    const tgtFolder = refFull ? (refFull.folderId != null ? refFull.folderId : currentFolderIdRef.current || null) : (currentFolderIdRef.current || null);
                    const sameFolder = srcs.every(d => (d.folderId || null) === (refFull ? refFull.folderId || null : tgtFolder));
                    const payload = sameFolder ? srcs : srcs.map(d => ({ ...d, folderId: tgtFolder }));
                    const tIdx = anchorId != null ? remaining.findIndex(d => d.id === anchorId) : remaining.length;
                    if (tIdx < 0) return [...remaining, ...payload];
                    remaining.splice(tIdx, 0, ...payload);
                    return remaining;
                });
            };

            const importFilesToFolder = async (files, targetFolderId) => {
                const jsonFiles = Array.from(files || []).filter(f => /\.json$/i.test(f.name) || (f.type || '')
                    .indexOf('json') >= 0);
                if (jsonFiles.length === 0) {
                    alert('⚠️ 请拖入 .json 题库文件后再松开');
                    return;
                }
                let decksAdded = 0,
                    foldersAdded = 0,
                    questionsAdded = 0,
                    skipped = 0;
                const skipReasons = [];
                const used = new Set(decksRef.current.map(d => d.name));
                const resolveName = base => {
                    let n = base;
                    let i = 2;
                    while (used.has(n)) { n = `${base} (${i})`;
                        i += 1; }
                    used.add(n);
                    return n;
                };
                for (const file of jsonFiles) {
                    try {
                        const content = await readFileText(file);
                        const parsed = JSON.parse(content);
                        const baseName = (file.name.replace(/\.json$/i, '') || '').trim() || '未命名题库';
                        const node = parseDeckContent(parsed, baseName);
                        if (node.kind === 'folder') {
                            const { label, res } = importExportedFolder({ name: node.name, children: node.children,
                                targetParentId: targetFolderId });
                            foldersAdded += res.foldersAdded;
                            decksAdded += res.decksAdded;
                            questionsAdded += res.questionsAdded;
                        } else {
                            const uniqueName = resolveName(node.name);
                            const deck = addDeck(uniqueName, '从JSON导入', normalizeQuestions(node.questions),
                                targetFolderId);
                            decksAdded += 1;
                            questionsAdded += deck.questions.length;
                        }
                    } catch (err) {
                        skipped += 1;
                        skipReasons.push(`${file.name}：${err.message}`);
                    }
                }
                let msg =
                    `✅ 成功导入 ${decksAdded} 个题库${foldersAdded ? `、${foldersAdded} 个文件夹` : ''}，共 ${questionsAdded} 题`;
                if (skipped > 0) msg += `\n⚠️ 跳过 ${skipped} 个文件：\n` + skipReasons.join('\n');
                alert(msg);
            };

            const renderFolderTree = (parentId, depth) => {
                const movingFolderIds = moveTarget && moveTarget.items
                    ? new Set(moveTarget.items.filter(it => it.kind === 'folder').map(it => it.id))
                    : new Set();
                const list = getChildFolders(parentId).filter(f => !movingFolderIds.has(f.id));
                return list.flatMap(f => [
                    React.createElement("div", { key: f.id, onClick: () => setMoveDest(f.id),
                        className: "folder-tree-row", style: { paddingLeft: 12 + depth * 18, background: moveDest ===
                                f.id ? 'var(--accent-soft)' : 'transparent' } }, "📁 ", f.name),
                    ...renderFolderTree(f.id, depth + 1)
                ]);
            };

            const importExportedFolder = payload => {
                const parentId = payload.targetParentId != null ? payload.targetParentId : currentFolderId;
                let targetId = parentId;
                let label = '';
                if (payload.name && payload.name !== '根目录') {
                    const existingNames = getChildFolders(parentId).map(f => f.name);
                    let fname = (payload.name || '').trim() || '导入的文件夹';
                    if (existingNames.includes(fname)) {
                        let i = 2;
                        while (existingNames.includes(`${fname} (${i})`)) i++;
                        fname = `${fname} (${i})`;
                    }
                    const top = createFolder(fname, parentId);
                    targetId = top.id;
                    label = `文件夹「${top.name}」`;
                } else {
                    label = parentId ? '当前文件夹' : '根目录';
                }
                const res = importFolderStructure({ children: payload.children || [] }, targetId);
                return { label, res };
            };

            const handleImport = async event => {
                const file = event.target.files[0];
                if (!file) return;
                try {
                    const content = await readFileText(file);
                    const parsed = JSON.parse(content);
                    const baseName = (file.name.replace(/\.json$/i, '') || '').trim() || '未命名题库';
                    const node = parseDeckContent(parsed, baseName);
                    if (node.kind === 'folder') {
                        const { label, res } = importExportedFolder({ name: node.name, children: node.children });
                        alert(
                            `✅ 已导入到${label}：${res.decksAdded} 个题库、${res.foldersAdded} 个文件夹，共 ${res.questionsAdded} 题`
                            );
                        return;
                    }
                    const uniqueName = generateUniqueName(node.name, decks);
                    const deck = addDeck(uniqueName, '从JSON导入', normalizeQuestions(node.questions));
                    alert(`✅ 成功导入题库「${deck.name}」，共 ${deck.questions.length} 题`);
                } catch (err) {
                    alert('解析JSON失败：' + err.message);
                }
                event.target.value = '';
            };

            const parseDeckContent = (parsed, fallbackName) => {
                if (!parsed || typeof parsed !== 'object') throw new Error('JSON 不是有效对象');
                if (parsed.type === 'duo_folder_export') {
                    return { kind: 'folder', name: parsed.name || fallbackName || '导入的文件夹', children: parsed
                            .children || [] };
                }
                let questions = null;
                if (Array.isArray(parsed)) {
                    questions = parsed;
                } else if (Array.isArray(parsed.questions)) {
                    questions = parsed.questions;
                } else if (parsed.type && parsed.question) {
                    questions = [parsed];
                }
                if (!questions) throw new Error('未找到题目数组（期望顶层为数组、含 questions 字段，或文件夹导出文件）');
                if (questions.length === 0) throw new Error('题库为空（0 题）');
                const valid = questions.every(q => q && q.type && q.question && (Array.isArray(q.correctAnswer) ? q
                    .correctAnswer.length > 0 : q.correctAnswer));
                if (!valid) throw new Error('题目缺少必要字段（type, question, correctAnswer）');
                const name = (Array.isArray(parsed) ? '' : parsed.name || '') || fallbackName || '未命名题库';
                return { kind: 'deck', name: (name || '').trim() || '未命名题库', questions };
            };

            const handleNewDeck = () => {
                const name = prompt('请输入新题库名称：', '新建题库');
                if (name === null) return;
                if (name.trim() === '') { alert('名称不能为空'); return; }
                const deck = addDeck(name.trim(), '手动创建的空题库', [], currentFolderId || null);
                setEditingDeckId(deck.id);
            };

            const handleRename = deck => {
                const newName = prompt('修改题库名称：', deck.name);
                if (newName === null) return;
                if (newName.trim() === '') { alert('名称不能为空'); return; }
                renameDeck(deck.id, newName.trim());
            };

            const handleRandomStart = () => {
                const totalAll = decks.reduce((s, d) => s + d.questions.length, 0);
                if (totalAll === 0) { alert('还没有题目，请先创建或导入题库'); return; }
                if (currentFolderId && collectFolderQuestions(currentFolderId).length > 0) {
                    setRandomFolderIds([currentFolderId]);
                    setRandomDeckIds([]);
                    setRandomCount(String(collectFolderQuestions(currentFolderId).length));
                } else {
                    setRandomDeckIds(decks.map(d => d.id));
                    setRandomFolderIds([]);
                    setRandomCount(String(totalAll));
                }
                setShowRandomModal(true);
            };

            // 缓存：仅当题库/文件夹/勾选状态变化时重算，避免随机出题弹窗每次渲染都 O(总题数) 展开并标注来源
            const randomPool = useMemo(() => {
                const deckInSelectedFolder = d => {
                    let cur = d.folderId || null;
                    const guard = new Set();
                    while (cur && !guard.has(cur)) {
                        guard.add(cur);
                        if (randomFolderIds.includes(cur)) return true;
                        const f = folders.find(x => x.id === cur);
                        cur = f ? f.parentId : null;
                    }
                    return false;
                };
                const result = [];
                decks.forEach(d => {
                    if (randomDeckIds.includes(d.id) || deckInSelectedFolder(d)) {
                        // 给随机抽出的每道题标注来源题库，便于按题库累计学习时长
                        result.push(...d.questions.map(q => ({ ...q, sourceDeckId: d.id })));
                    }
                });
                return result;
            }, [decks, folders, randomDeckIds, randomFolderIds]);

            const confirmRandomStart = () => {
                const pool = randomPool;
                if (pool.length === 0) { alert('请至少勾选一个题库或文件夹'); return; }
                const total = pool.length;
                let count = parseInt(randomCount, 10);
                if (isNaN(count) || count < 1) count = total;
                if (count > total) count = total;
                const shuffled = [...pool].sort(() => Math.random() - 0.5);
                const selected = shuffled.slice(0, count);
                const selCount = randomDeckIds.length + randomFolderIds.length;
                setSession({ deckId: 'random', questionIndex: 0, questions: selected, scopeLabel: '已选 ' +
                        selCount + ' 项', startedAt: Date.now(), startLevel: stats ? stats.level : 1 });
                setShowRandomModal(false);
                setMode('learn');
            };

            const visibleDecks = useMemo(() => childDecksAll.filter(d => d.name.toLowerCase().includes(deckSearch.trim().toLowerCase())), [childDecksAll, deckSearch]);
            const shownDecks = useMemo(() => visibleDecks.slice(0, deckVisible), [visibleDecks, deckVisible]);
            // 拖拽过程中 endDrag 闭包可能捕获到 pointerdown 时刻的列表，用 ref 始终持有最新可见题库列表
            const shownDecksRef = useRef(shownDecks);
            useEffect(() => { shownDecksRef.current = shownDecks; }, [shownDecks]);

            // ===== 多选（Ctrl 点选 / Shift 连选，仿 Windows 文件管理器）=====
            const keyOf = (kind, id) => `${kind}:${id}`;
            const orderedItems = useMemo(() => [
                ...childFolders.map(f => ({ kind: 'folder', id: f.id, name: f.name })),
                ...shownDecks.map(d => ({ kind: 'deck', id: d.id, name: d.name }))
            ], [childFolders, shownDecks]);
            const clearSelection = () => { setSelected(new Set()); setLastAnchor(null); };
            const selectAll = () => setSelected(new Set(orderedItems.map(it => keyOf(it.kind, it.id))));
            const isSelected = (kind, id) => selected.has(keyOf(kind, id));
            // 处理卡片点击：返回 true 表示已作为多选处理（调用方不应再触发打开等默认动作）
            const handleSelectClick = (kind, id, e) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault(); e.stopPropagation();
                    const k = keyOf(kind, id);
                    setSelected(prev => {
                        const n = new Set(prev);
                        if (n.has(k)) n.delete(k); else n.add(k);
                        return n;
                    });
                    setLastAnchor({ kind, id });
                    return true;
                }
                if (e.shiftKey && lastAnchor) {
                    e.preventDefault(); e.stopPropagation();
                    const idxA = orderedItems.findIndex(it => it.kind === lastAnchor.kind && it.id === lastAnchor.id);
                    const idxB = orderedItems.findIndex(it => it.kind === kind && it.id === id);
                    if (idxA !== -1 && idxB !== -1) {
                        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
                        setSelected(new Set(orderedItems.slice(lo, hi + 1).map(it => keyOf(it.kind, it.id))));
                    }
                    return true;
                }
                clearSelection();
                return false;
            };
            const selectedItems = useMemo(() => {
                const arr = [];
                selected.forEach(k => { const [kind, id] = k.split(':'); arr.push({ kind, id }); });
                return arr;
            }, [selected]);
            const batchExportItems = items => {
                items.forEach(it => {
                    if (it.kind === 'deck') { const d = decks.find(x => x.id === it.id); if (d) exportDeck(d); }
                    else { const f = folders.find(x => x.id === it.id); if (f) exportFolder(it.id, f.name); }
                });
                clearSelection();
            };
            const batchExport = () => batchExportItems(selectedItems);
            const batchDeleteItems = items => {
                if (!items || items.length === 0) return;
                if (!confirm(`确认删除选中的 ${items.length} 项？该操作不可撤销，相关错题与收藏也会一并删除。`)) return;
                items.forEach(it => {
                    if (it.kind === 'deck') deleteDeck(it.id, true);
                    else deleteFolder(it.id, true);
                });
                clearSelection();
            };
            const batchDelete = () => batchDeleteItems(selectedItems);
            useEffect(() => {
                const onKey = e => { if (e.key === 'Escape') clearSelection(); };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [clearSelection]);
            // 仿 Windows 的键盘操作：Delete 删除、Ctrl+C/X 复制剪切、Ctrl+V 粘贴到当前目录、Ctrl+A 全选
            useEffect(() => {
                const onKey = e => {
                    const t = e.target;
                    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
                    if (typing) return;
                    if (e.key === 'Delete' && selected.size > 0) { e.preventDefault(); batchDelete(); return; }
                    if (e.ctrlKey || e.metaKey) {
                        const k = e.key.toLowerCase();
                        if (k === 'a') { e.preventDefault(); selectAll(); }
                        else                         if (k === 'c' && selected.size > 0) { e.preventDefault(); copyToClipboard(selectedItems); clearSelection(); }
                        else if (k === 'x' && selected.size > 0) { e.preventDefault(); cutToClipboard(selectedItems); clearSelection(); }
                        else if (k === 'v') { e.preventDefault(); pasteToFolder(currentFolderId); }
                    }
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [selected, selectedItems, currentFolderId, clearSelection, selectAll, batchDelete, copyToClipboard, cutToClipboard, pasteToFolder]);
            // 点卡片外的页面留白（含左右两侧空白）→ 作废多选；卡片内/菜单/弹窗/帮助框不在此处清空
            useEffect(() => {
                const onDocClick = e => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    if (t.closest('.home-card') || t.closest('.ctx-menu') || t.closest('.modal-overlay') ||
                        t.closest('.modal') || t.closest('.modal-box') || t.closest('.help-box')) return;
                    if (selectedRef.current.size > 0) clearSelection();
                };
                document.addEventListener('click', onDocClick);
                return () => document.removeEventListener('click', onDocClick);
            }, [clearSelection]);

            if (editingDeckId) {
                return React.createElement(DeckEditor, { deckId: editingDeckId, onBack: () => setEditingDeckId(
                    null) });
            }

            return React.createElement(React.Fragment, null,
                React.createElement("div", { className: "card home-card",
                    onClick: e => {
                        // 题库区点空白处（非卡片/弹窗/交互控件）→ 作废多选
                        if (e.target.closest('.deck-item') || e.target.closest('.modal-overlay') ||
                            e.target.closest('.modal') || e.target.closest('.modal-box') ||
                            e.target.closest('.help-box')) return;
                        if (e.target.closest('button') || e.target.closest('input') ||
                            e.target.closest('select') || e.target.closest('textarea') ||
                            e.target.closest('label') || e.target.closest('a')) return;
                        clearSelection();
                    } },
                    showFileDrop && React.createElement("div", { className: "drop-overlay" },
                        React.createElement("div", { className: "drop-overlay-box" },
                            React.createElement("span", null, "📥"),
                            "松开以导入题库（.json）"
                        )
                    ),
                    showRandomModal && React.createElement("div", { className: "modal-overlay", onClick: e => { if (e
                                .target === e.currentTarget) setShowRandomModal(false); } },
                        React.createElement("div", { className: "modal", onClick: e => e.stopPropagation() },
                            React.createElement("h3", null, "🎲 随机出题"),
                            React.createElement("div", { className: "scope-quick" },
                                React.createElement("button", { className: "btn btn-outline btn-sm", onClick: () => {
                                        setRandomDeckIds(decks.map(d => d.id));
                                        setRandomFolderIds(folders.map(f => f.id)); } }, "全选"),
                                React.createElement("button", { className: "btn btn-outline btn-sm", onClick: () => {
                                        setRandomDeckIds([]);
                                        setRandomFolderIds([]); } }, "清空"),
                                React.createElement("span", { className: "scope-hint" }, "（可多选题库和文件夹）")
                            ),
                            React.createElement("div", { className: "field" },
                                React.createElement("label", null, "题库（", randomDeckIds.length, "/", decks
                                    .length, " 已选）"),
                                React.createElement("div", { className: "scope-list" },
                                    decks.length === 0 ?
                                    React.createElement("div", { className: "scope-empty" }, "暂无题库") :
                                    decks.map(d =>
                                        React.createElement("label", { key: d.id, className: "check-row" + (
                                                randomDeckIds.includes(d.id) ? " checked" : "") },
                                            React.createElement("input", { type: "checkbox", checked: randomDeckIds
                                                    .includes(d.id), onChange: () => {
                                                    const set = new Set(randomDeckIds);
                                                    if (set.has(d.id)) set.delete(d.id);
                                                    else set.add(d.id);
                                                    setRandomDeckIds([...set]); } }),
                                            React.createElement("span", { className: "check-label" },
                                                d.name + "（" + d.questions.length + " 题）" + (d.folderId ?
                                                    " · " + getFolderPath(d.folderId).map(p => p.name)
                                                    .join("/") : "")
                                            )
                                        )
                                    )
                                )
                            ),
                            React.createElement("div", { className: "field" },
                                React.createElement("label", null, "文件夹（", randomFolderIds.length, "/",
                                    folders.length, " 已选）"),
                                React.createElement("div", { className: "scope-list" },
                                    folders.length === 0 ?
                                    React.createElement("div", { className: "scope-empty" }, "暂无文件夹") :
                                    folders.map(f =>
                                        React.createElement("label", { key: f.id, className: "check-row" + (
                                                randomFolderIds.includes(f.id) ? " checked" : "") },
                                            React.createElement("input", { type: "checkbox", checked: randomFolderIds
                                                    .includes(f.id), onChange: () => {
                                                    const set = new Set(randomFolderIds);
                                                    if (set.has(f.id)) set.delete(f.id);
                                                    else set.add(f.id);
                                                    setRandomFolderIds([...set]); } }),
                                            React.createElement("span", { className: "check-label" },
                                                getFolderPath(f.id).map(p => p.name).join("/") + "（" +
                                                collectFolderQuestions(f.id).length + " 题）"
                                            )
                                        )
                                    )
                                )
                            ),
                            React.createElement("div", { className: "field" },
                                React.createElement("label", null, "出题数量（最多 ", randomPool.length,
                                    " 题）"),
                                React.createElement("input", { className: "input-field", type: "number", min: "1",
                                    max: String(randomPool.length || 1), value: randomCount, onChange: e =>
                                        setRandomCount(e.target.value), placeholder: String(randomPool
                                        .length) })
                            ),
                            React.createElement("div", { className: "modal-actions" },
                                React.createElement("button", { className: "btn btn-outline", onClick: () =>
                                        setShowRandomModal(false) }, "取消"),
                                React.createElement("button", { className: "btn btn-primary", onClick: confirmRandomStart },
                                    "开始出题")
                            )
                        )
                    ),
                    React.createElement("div", { className: "time-banner" },
                        React.createElement("span", { className: "time-banner-emoji" }, timeBanner.emoji),
                        React.createElement("div", { className: "time-banner-body" },
                            React.createElement("div", { className: "time-banner-title" }, timeBanner.title, " · ",
                                new Date(nowTick).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
                            React.createElement("div", { className: "time-banner-text" }, timeBanner.text)
                        )
                    ),
                    React.createElement("div", { className: "card-header" },
                        React.createElement("h2", { style: { fontSize: '1.6rem', color: 'var(--text)' } },
                            "📚 我的题库"),
                        React.createElement("div", { className: "toolbar" },
                            React.createElement("button", { className: "btn btn-secondary", onClick: () => fileInputRef
                                    .current.click() }, "📂 导入题库"),
                            React.createElement("button", { className: "btn btn-primary", onClick: handleNewDeck },
                                "📝 新建题库"),
                            React.createElement("button", { className: "btn btn-outline", onClick: () => exportFolder(
                                    currentFolderId, currentFolder ? currentFolder.name : '根目录') },
                                "📤 导出文件夹"),
                            React.createElement("button", { className: "btn-help", onClick: () => setShowHelp(!showHelp) },
                                showHelp ? '✕ 收起格式' : '📖 格式说明'),
                            React.createElement("button", { className: "btn btn-random", onClick: handleRandomStart },
                                "🎲 随机出题")
                        ),
                        React.createElement("input", { type: "file", ref: fileInputRef, accept: ".json",
                            className: "file-input-hidden", onChange: handleImport })
                    ),
                    showHelp && React.createElement("div", { className: "help-box" },
                        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                            React.createElement("h4", { style: { color: 'var(--text)', margin: 0 } },
                                "📌 JSON 题库格式要求"),
                            React.createElement("button", { className: "btn btn-outline btn-sm", onClick: exportFormatHelp },
                                "📥 导出说明")
                        ),
                        React.createElement("p", { style: { fontSize: '0.95rem', marginBottom: 8, color: 'var(--text)' } },
                            "导入文件可以是 ", React.createElement("strong", null, "题目数组"),
                            "，也可以是 AI 导出的 ", React.createElement("strong", null, "{ title, questions }"),
                            " 对象（两者都支持）。每道题是一个对象，包含以下字段："),
                        React.createElement("ul", { style: { marginLeft: 20, marginBottom: 12, lineHeight: 1.6,
                                color: 'var(--text)' } },
                            React.createElement("li", null, React.createElement("code", null, "type"),
                                " (必填) — 题型：", React.createElement("code", null,
                                    "\"multiple_choice\""), "（单选）、", React.createElement("code", null,
                                    "\"multiple_select\""), "（多选）、", React.createElement("code", null,
                                    "\"true_false\""), "、", React.createElement("code", null,
                                    "\"fill_blank\""), " 或 ", React.createElement("code", null,
                                    "\"essay\"")),
                            React.createElement("li", null, React.createElement("code", null, "question"),
                                " (必填) — 题目内容（字符串）"),
                            React.createElement("li", null, React.createElement("code", null, "options"),
                                " (选择题必填) — 选项数组，例如 ", React.createElement("code", null,
                                    "[\"北京\",\"上海\",\"广州\",\"深圳\"]")),
                            React.createElement("li", null, React.createElement("code", null,
                                "correctAnswer"), " (必填) — 正确答案：单选/判断为选项文本字符串；",
                                React.createElement("b", null, "多选（multiple_select）为正确答案文本的数组"),
                                "，例如 ", React.createElement("code", null, "[\"北京\",\"上海\"]"),
                                "，须与选项文本完全一致"),
                            React.createElement("li", null, React.createElement("code", null,
                                "explanation"), " (可选) — 解析说明"),
                            React.createElement("li", null, React.createElement("code", null,
                                "difficulty"), " (可选) — 难度等级 1~3，默认为 1"),
                            React.createElement("li", null, React.createElement("code", null,
                                "score"), " (可选) — 本题分值（正整数）。未填时按题型取默认值：单选 3、多选 4、判断 2、填空 4、解答 8；其他题型 5。可在编辑界面逐题修改，用于练习结算与导出试卷计分。"),
                            React.createElement("li", null, React.createElement("code", null, "figure"),
                                " (可选) — 几何 / 函数图像，见下方「🖼️ figure 字段」"),
                            React.createElement("li", null, React.createElement("code", null, "images"),
                                " (可选) — 外部图片：在线链接 http(s):// 或本地内嵌 data URI，支持多张")
                        ),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "✅ 各题型 correctAnswer 写法："),
                        React.createElement("ul", { style: { marginLeft: 20, marginBottom: 12, lineHeight: 1.6, color: 'var(--text)' } },
                            React.createElement("li", null, "单选 / 判断：选项文本字符串，须与选项 ",
                                React.createElement("b", null, "完全一致"), "（如 ", React.createElement("code", null, "\"焦耳\""),
                                " 或 ", React.createElement("code", null, "\"正确\""), "）。也兼容单字母写法（如 ", React.createElement("code", null, "\"A\""), "→第 1 个选项）"),
                            React.createElement("li", null, "多选（multiple_select）：",
                                React.createElement("b", null, "正确答案文本的数组"), "，如 ",
                                React.createElement("code", null, "[\"北京\",\"上海\"]"), "。也兼容 ", React.createElement("code", null, "\"AB\""), " 等连写字母（自动转为多选）"),
                            React.createElement("li", null, "填空：标准答案字符串（可含 LaTeX，如 ",
                                React.createElement("code", null, "$$\\frac{1}{2}$$"), "）"),
                            React.createElement("li", null, "解答：参考答案字符串（可含 LaTeX / 多行要点）")
                        ),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "🖼️ figure 字段（几何 / 函数图像，可选）："),
                        React.createElement("p", { style: { fontSize: '0.92rem', marginBottom: 6, color: 'var(--text)' } },
                            "顶层结构 ", React.createElement("code", null, "{ v:[xmin,xmax,ymin,ymax], g:网格(通常省略,应用按图形类型自动决定:几何图默认隐藏,含 fn 函数图像默认显示;确需强制可写 g:0 或 g:1), ax:坐标轴(同理:几何图默认隐藏,含 fn 函数图像默认显示;强制可写 ax:0/ax:1), items:[...] }"),
                            "，items 元素用 ", React.createElement("code", null, "t"), " 区分类型："),
                        React.createElement("ul", { style: { marginLeft: 20, marginBottom: 12, lineHeight: 1.6, color: 'var(--text)' } },
                            React.createElement("li", null, React.createElement("code", null, "pt"), " 点 {t:\"pt\",p:[x,y],l:\"A\",c:\"#e74c3c\"}"),
                            React.createElement("li", null, React.createElement("code", null, "seg"), " 线段 {t:\"seg\",a:[x1,y1],b:[x2,y2],l:\"a\"}"),
                            React.createElement("li", null, React.createElement("code", null, "ln"), " 直线 {t:\"ln\",a:[x,y],b:[x,y]}"),
                            React.createElement("li", null, React.createElement("code", null, "cir"), " 圆 {t:\"cir\",o:[x,y],r:3,fill:\"#eee\"}"),
                            React.createElement("li", null, React.createElement("code", null, "arc"), " 圆弧 {t:\"arc\",o:[x,y],r:3,a0:0,a1:90}"),
                            React.createElement("li", null, React.createElement("code", null, "pol"), " 多边形 {t:\"pol\",p:[[x,y],...],close:1}"),
                            React.createElement("li", null, React.createElement("code", null, "fn"), " 函数 {t:\"fn\",e:\"x^2\",x0,x1}（y=f(x)）"),
                            React.createElement("li", null, React.createElement("code", null, "ang"), " 角 {t:\"ang\",a:[x,y],b:[x,y],c:[x,y]}"),
                            React.createElement("li", null, React.createElement("code", null, "vec"), " 向量 {t:\"vec\",a:[x,y],b:[x,y]}"),
                            React.createElement("li", null, React.createElement("code", null, "txt"), " 文字 {t:\"txt\",p:[x,y],s:\"说明\"}"),
                            React.createElement("li", null, "依赖对象：", React.createElement("code", null, "mid"), "（中点）/ ",
                                React.createElement("code", null, "inter"), "（交点）/ ", React.createElement("code", null, "onseg"),
                                "（线上点）/ ", React.createElement("code", null, "perp"), "（垂线）/ ",
                                React.createElement("code", null, "para"), "（平行线）—— 引用其他元素标签，几何关系自动联动。更多类型：ray 射线、pf 参数曲线、po 极坐标。")
                        ),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "🖼️ images 字段（外部图片，可选）："),
                        React.createElement("ul", { style: { marginLeft: 20, marginBottom: 12, lineHeight: 1.6, color: 'var(--text)' } },
                            React.createElement("li", null, "字符串数组，每个元素是一张图片的地址，两种形式："),
                            React.createElement("li", null, React.createElement("b", null, "在线链接"), "：以 http:// 或 https:// 开头的图片直链，做题时需联网加载"),
                            React.createElement("li", null, React.createElement("b", null, "本地文件（内嵌）"), "：以 data:image/...;base64,... 开头的 Data URI，随题库保存、离线可用（编题上传本地图片自动压缩转为此格式）"),
                            React.createElement("li", null, "可放 1~N 张，按数组顺序展示；死链或无法加载的图片在界面上自动隐藏")
                        ),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "📁 文件夹导出 / 嵌套导入："),
                        React.createElement("ul", { style: { marginLeft: 20, marginBottom: 12, lineHeight: 1.6,
                                color: 'var(--text)' } },
                            React.createElement("li", null, "点「📤 导出文件夹」可把",
                                React.createElement("strong", null, "当前文件夹（或根目录）及其所有子文件夹、题库"),
                                "整体导出为一个 JSON。"),
                            React.createElement("li", null,
                                "「📂 导入题库」支持导入该导出文件：非「根目录」导出会重建同名顶层文件夹并还原内部结构；若导出名为「根目录」则直接落入当前文件夹。"
                                )
                        ),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "💡 LaTeX 支持：AI 生成的题目会自动使用 $...$ 和 $$...$$ 渲染数学公式。"),
                        React.createElement("p", { style: { fontWeight: 600, marginBottom: 4, color: 'var(--text)' } },
                            "示例（含几何图与图片；注意 LaTeX 反斜杠在 JSON 中需写成 \\\\）："),
                        React.createElement("pre", null,
`[
  {
    "type": "multiple_choice",
    "question": "已知 $E=mc^2$，$c$ 为光速，则 $E$ 的单位是？",
    "options": ["焦耳", "牛顿", "瓦特", "帕斯卡"],
    "correctAnswer": "焦耳",
    "explanation": "$E$ 的单位为焦耳（J）。",
    "difficulty": 1,
    "score": 3
  },
  {
    "type": "multiple_select",
    "question": "下列属于直辖市的是？（多选）",
    "options": ["北京", "上海", "广州", "天津"],
    "correctAnswer": ["北京", "上海", "天津"],
    "difficulty": 1,
    "score": 4
  },
  {
    "question": "$\\\\int_0^\\\\infty e^{-x^2} dx = \\\\frac{\\\\sqrt{\\\\pi}}{2}$，该积分值为 ____。",
    "correctAnswer": "$\\\\frac{\\\\sqrt{\\\\pi}}{2}$",
    "explanation": "高斯积分，结果为 $\\\\frac{\\\\sqrt{\\\\pi}}{2}$。",
    "difficulty": 2,
    "score": 4
  },
  {
    "question": "如图，$\\\\triangle ABC$ 中 $D$ 为 $BC$ 中点，则 $AD$ 是？",
    "options": ["中线", "高", "角平分线", "中位线"],
    "correctAnswer": "中线",
    "difficulty": 1,
    "score": 3,
    "figure": {
      "v": [-1, 5, -1, 4],
      "items": [
        {"t":"pt","p":[0,1],"l":"B"},
        {"t":"pt","p":[4,1],"l":"C"},
        {"t":"pt","p":[2,3.2],"l":"A"},
        {"t":"seg","a":"B","b":"C","l":"f"},
        {"t":"mid","l":"D","a":"B","b":"C"},
        {"t":"seg","a":"A","b":"D"}
      ]
    }
  },
  {
    "question": "如图，这是哪个国家的国旗？",
    "options": ["中国", "日本", "法国", "德国"],
    "correctAnswer": "法国",
    "difficulty": 1,
    "images": ["https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Flag_of_France.svg/320px-Flag_of_France.svg.png"]
  }
  ]`
                        ),
                        React.createElement("p", { className: "text-muted", style: { fontSize: '0.85rem',
                                marginTop: 8 } },
                            "💡 提示：AI 生成的题目也遵循相同格式（外层带 title），可导出后复用。"
                        )
                    ),
                    React.createElement("div", { className: "folder-nav" },
                        React.createElement("div", { className: "breadcrumb" },
                            React.createElement("span", { className: `crumb ${!currentFolderId ? 'crumb-active' :
                                    ''}`, onClick: () => setCurrentFolderId(null) }, "📂 根目录"),
                            folderPath.map((p, i) =>
                                React.createElement("span", { key: p.id },
                                    React.createElement("span", { className: "crumb-sep" }, "›"),
                                    React.createElement("span", { className: `crumb ${i === folderPath.length -
                                            1 ? 'crumb-active' : ''}`, onClick: () => setCurrentFolderId(p
                                            .id) }, p.name)
                                )
                            )
                        ),
                        React.createElement("div", { className: "actions", style: { flexWrap: 'wrap' } },
                            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: () =>
                                    setShowNewFolder(v => !v) }, "📁 新建文件夹"),
                            clipboard && clipboard.items && clipboard.items.length > 0 &&
                            React.createElement("button", { className: "btn btn-outline btn-sm", onClick: () =>
                                    pasteToFolder(currentFolderId) }, "📋 粘贴", clipboard.action === 'cut' ?
                                '(剪切)' : '(复制)')
                        )
                    ),
                    showNewFolder && React.createElement("div", { className: "new-folder-row" },
                        React.createElement("input", { className: "input-field", autoFocus: true,
                            placeholder: "输入文件夹名称", value: newFolderName, onChange: e => setNewFolderName(e
                                .target.value), onKeyDown: e => { if (e.key === 'Enter') handleNewFolder(); if (
                                    e.key === 'Escape') { setShowNewFolder(false);
                                    setNewFolderName(''); } } }),
                        React.createElement("button", { className: "btn btn-primary btn-sm", onClick: handleNewFolder },
                            "确定"),
                        React.createElement("button", { className: "btn btn-outline btn-sm", onClick: () => {
                                setShowNewFolder(false);
                                setNewFolderName(''); } }, "取消")
                    ),
                    React.createElement("div", { className: "deck-search-wrap",
                        style: { margin: '10px 0 8px', flex: '0 0 auto' } },
                        React.createElement("input", { className: "input-field", type: "text",
                            placeholder: "🔍 搜索当前目录题库名称...", value: deckSearch, onChange: e => {
                                setDeckSearch(e.target.value);
                                setDeckVisible(10); } })
                    ),
                    React.createElement("div", { ref: folderListRef, className: "folder-list",
                            onClick: e => { if (e.target === e.currentTarget) clearSelection(); },
                            onContextMenu: e => openMenu(e, { kind: 'background' }) },
                        childFolders.length === 0 && childDecksAll.length === 0 ?
                        React.createElement("p", { className: "empty-hint" },
                            currentFolderId ? '此文件夹为空。可点「📝 新建题库」手动建库，或新建子文件夹、导入/生成题库到此目录。' :
                            '还没有题库或文件夹，点「📝 新建题库」手动建库、导入本地JSON、点击「AI 拆题」生成，或新建文件夹归类吧！'
                        ) :
                        React.createElement(React.Fragment, null,
                            childFolders.map(folder => {
                                const cnt = getChildFolders(folder.id).length + getChildDecks(
                                folder.id).length;
                                const isOver = dragOverFolder === folder.id;
                                return React.createElement("div", {
                                        key: folder.id,
                                        'data-folder-id': folder.id,
                                        className: `deck-item folder-item ${isOver ? 'drag-over' : ''} ${isSelected('folder', folder.id) ? 'selected' : ''}`,
                                        onClick: e => handleSelectClick('folder', folder.id, e),
                                        onPointerDown: e => onItemPointerDown(e, 'folder', folder.id),
                                        onContextMenu: e => onItemContextMenu(e, 'folder', folder
                                                .id, folder.name)
                                    },
                                    React.createElement("span", { className: "sel-badge" }, "✓"),
                                    React.createElement("div", null,
                                        React.createElement("div", { className: "deck-name" }, "📁 ",
                                            folder.name),
                                        React.createElement("div", { className: "deck-count" }, cnt,
                                            " 项")
                                    ),
                                    React.createElement("div", { className: "actions" },
                                        React.createElement("button", { className: "btn btn-secondary btn-sm",
                                            onClick: () => setCurrentFolderId(folder.id) }, "📂 打开"),
                                        React.createElement("button", { className: "btn btn-outline btn-sm",
                                            onClick: e => { e.stopPropagation();
                                                onItemContextMenu(e, 'folder', folder.id,
                                                    folder.name); } }, "⋯")
                                    )
                                );
                            }),
                            childFolders.length > 0 && childDecksAll.length > 0 &&
                            React.createElement("div", { className: "folder-divider" }),
                            visibleDecks.length === 0 && childDecksAll.length > 0 ?
                            React.createElement("p", { className: "empty-hint" }, "未找到匹配「",
                                deckSearch, "」的题库") :
                            shownDecks.map((deck, i) =>
                                React.createElement(React.Fragment, { key: deck.id },
                                    (dragInsertIdx === i) ?
                                        React.createElement("div", { className: "deck-insert-line" }) : null,
                                    React.createElement("div", {
                                            'data-deck-id': deck.id,
                                            className: `deck-item ${dragOverDeckId === deck.id ? 'merge-target' : ''} ${isSelected('deck', deck.id) ? 'selected' : ''}`,
                                            onClick: e => { if (handleSelectClick('deck', deck.id, e)) return; setEditingDeckId(deck.id); },
                                            onPointerDown: e => onItemPointerDown(e, 'deck', deck.id, true),
                                            onContextMenu: e => onItemContextMenu(e, 'deck', deck
                                                    .id, deck.name)
                                        },
                                        React.createElement("span", { className: "sel-badge" }, "✓"),
                                        React.createElement("div", null,
                                            React.createElement("div", { className: "deck-name" }, deck
                                                .name),
                                            React.createElement("div", { className: "deck-count" },
                                                deck.questions.length, " 道题"),
                                            deck.timeSpent > 0 && React.createElement("div", { className:
                                                "deck-time" }, "⏱ ", formatLearnTime(deck.timeSpent))
                                        ),
                                        React.createElement("div", { className: "actions" },
                                            React.createElement("button", { className: "btn btn-success btn-sm",
                                                onClick: e => { e.stopPropagation(); startLearning(deck.id); } }, "开始学习"),
                                            React.createElement("button", { className: "btn btn-primary btn-sm",
                                                onClick: e => { e.stopPropagation(); setEditingDeckId(deck.id); } }, "✏️ 编辑题目"),
                                            React.createElement("button", { className: "btn btn-outline btn-sm",
                                                onClick: e => { e.stopPropagation(); exportDeck(deck); } }, "📤 导出"),
                                            React.createElement("button", { className: "btn btn-outline btn-sm",
                                                onClick: e => { e.stopPropagation(); exportDeckPdf(deck); } }, "📄 PDF"),
                                            React.createElement("button", { className: "btn btn-outline btn-sm",
                                                onClick: e => { e.stopPropagation();
                                                    openMenu(e, { kind: 'deck', id: deck.id,
                                                        name: deck.name }); } }, "⋯")
                                        )
                                    )
                                )
                            ),
                            (dragInsertIdx === shownDecks.length) ?
                                React.createElement("div", { className: "deck-insert-line" }) : null,
                            visibleDecks.length > deckVisible &&
                            React.createElement("div", { className: "text-center mt-4" },
                                React.createElement("button", { className: "btn btn-outline", onClick: () =>
                                        setDeckVisible(c => c + 10) }, "加载更多（剩余 ", visibleDecks
                                    .length - deckVisible, " 个）")
                            )
                        )
                    ),
                ),
                menu && ReactDOM.createPortal(
                    React.createElement(React.Fragment, null,
                        React.createElement("div", { style: { position: 'fixed', inset: 0, zIndex: 9998 },
                            onClick: closeMenu, onContextMenu: e => { e.preventDefault();
                                closeMenu(); } }),
                        React.createElement("div", { ref: menuRef, className: "ctx-menu", style: { position:
                                    'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 } },
                            menu.target.kind === 'deck' && (() => {
                                const dk = decks.find(d => d.id === menu.target.id);
                                return React.createElement(React.Fragment, null,
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            startLearning(menu.target.id);
                                            closeMenu(); } }, "▶️ 开始学习"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            startLearning(menu.target.id, false);
                                            closeMenu(); } }, "📋 默认顺序做题"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            setEditingDeckId(menu.target.id);
                                            closeMenu(); } }, "✏️ 编辑题目"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            if (dk) exportDeck(dk);
                                            closeMenu(); } }, "📤 导出"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            if (dk) exportDeckPdf(dk, true);
                                            closeMenu(); } }, "📄 导出 PDF（含答案）"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            if (dk) exportDeckPdf(dk, false);
                                            closeMenu(); } }, "📄 导出 PDF（仅题目）"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            if (dk) handleRename(dk);
                                            closeMenu(); } }, "🏷️ 重命名"),
                                    React.createElement("div", { className: "ctx-sep" }),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            copyToClipboard([{ kind: 'deck', id: menu.target
                                                .id }]);
                                            clearSelection(); closeMenu(); } }, "📋 复制"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            cutToClipboard([{ kind: 'deck', id: menu.target.id }]);
                                            clearSelection(); closeMenu(); } }, "✂️ 剪切"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                            setMoveTarget({ items: [{ kind: 'deck', id: menu.target.id,
                                                name: menu.target.name }] });
                                            setMoveDest(currentFolderId);
                                            closeMenu(); } }, "📦 移动到…"),
                                    React.createElement("div", { className: "ctx-sep" }),
                                    React.createElement("div", { className: "ctx-item ctx-danger",
                                        onClick: () => { deleteDeck(menu.target.id);
                                            clearSelection(); closeMenu(); } }, "🗑️ 删除")
                                );
                            })(),
                            menu.target.kind === 'folder' &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        setCurrentFolderId(menu.target.id);
                                        closeMenu(); } }, "📂 打开"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        exportFolder(menu.target.id, menu.target.name);
                                        closeMenu(); } }, "📤 导出文件夹"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        const n = prompt('重命名文件夹：', menu.target.name);
                                        if (n != null) renameFolder(menu.target.id, n);
                                        closeMenu(); } }, "🏷️ 重命名"),
                                React.createElement("div", { className: "ctx-sep" }),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        copyToClipboard([{ kind: 'folder', id: menu.target
                                            .id }]);
                                        clearSelection(); closeMenu(); } }, "📋 复制"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        cutToClipboard([{ kind: 'folder', id: menu.target.id }]);
                                        clearSelection(); closeMenu(); } }, "✂️ 剪切"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        setMoveTarget({ items: [{ kind: 'folder', id: menu.target.id,
                                            name: menu.target.name }] });
                                        setMoveDest(currentFolderId);
                                        closeMenu(); } }, "📦 移动到…"),
                                React.createElement("div", { className: "ctx-sep" }),
                                React.createElement("div", { className: "ctx-item ctx-danger",
                                    onClick: () => { if (confirm(
                                            '删除此文件夹及其所有子文件夹和题库？相关错题与收藏也会一并删除。'
                                            )) deleteFolder(menu.target.id);
                                        clearSelection(); closeMenu(); } }, "🗑️ 删除")
                            ),
                            menu.target.kind === 'background' &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        setShowNewFolder(v => !v);
                                        closeMenu(); } }, "📁 新建文件夹"),
                                clipboard && clipboard.items && clipboard.items.length > 0 &&
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        pasteToFolder(currentFolderId);
                                        closeMenu(); } }, "📋 粘贴到此处"),
                                selected.size > 0 &&
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        clearSelection(); closeMenu(); } }, "✖️ 取消选择")
                            ),
                            menu.target.kind === 'multi' &&
                            React.createElement(React.Fragment, null,
                                React.createElement("div", { className: "ctx-item", style: { fontWeight: 700,
                                        cursor: 'default', opacity: 0.7 } }, `已选 ${menu.target.items.length} 项`),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        copyToClipboard(menu.target.items); clearSelection(); closeMenu(); } }, "📋 复制"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        cutToClipboard(menu.target.items); clearSelection(); closeMenu(); } }, "✂️ 剪切"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        setMoveTarget({ items: menu.target.items }); setMoveDest(currentFolderId); closeMenu(); } }, "📦 移动到…"),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        batchExportItems(menu.target.items); closeMenu(); } }, "📤 导出"),
                                menu.target.items.every(it => it.kind === 'deck') &&
                                React.createElement(React.Fragment, null,
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                        menu.target.items.forEach(it => { const d = decks.find(x => x.id === it.id); if (d) exportDeckPdf(d, true); });
                                        clearSelection(); closeMenu(); } }, "📄 导出 PDF（含答案）"),
                                    React.createElement("div", { className: "ctx-item", onClick: () => {
                                        menu.target.items.forEach(it => { const d = decks.find(x => x.id === it.id); if (d) exportDeckPdf(d, false); });
                                        clearSelection(); closeMenu(); } }, "📄 导出 PDF（仅题目）")
                                ),
                                React.createElement("div", { className: "ctx-sep" }),
                                React.createElement("div", { className: "ctx-item ctx-danger", onClick: () => {
                                    batchDeleteItems(menu.target.items); closeMenu(); } }, "🗑️ 删除"),
                                React.createElement("div", { className: "ctx-sep" }),
                                React.createElement("div", { className: "ctx-item", onClick: () => {
                                        clearSelection(); closeMenu(); } }, "✖️ 取消选择")
                            )
                        )
                    ), document.body),
                moveTarget && ReactDOM.createPortal(
                    React.createElement("div", { className: "modal-overlay", onClick: () => setMoveTarget(null) },
                        React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                            React.createElement("h3", { style: { marginBottom: 8 } }, "移动到…"),
                            React.createElement("p", { className: "text-muted", style: { fontSize: '0.9rem',
                                    marginBottom: 10 } },
                                "为「", moveTarget.items.length > 1 ? `${moveTarget.items.length} 项` :
                                    moveTarget.items[0].name, "」选择目标文件夹（根目录 = 最外层）："
                            ),
                            React.createElement("div", { className: "folder-tree" },
                                React.createElement("div", { className: `folder-tree-row ${moveDest === null ?
                                        'selected' : ''}`, onClick: () => setMoveDest(null) }, "📂 根目录"),
                                renderFolderTree(null, 0)
                            ),
                            React.createElement("div", { className: "modal-actions" },
                                React.createElement("button", { className: "btn btn-outline", onClick: () =>
                                        setMoveTarget(null) }, "取消"),
                                React.createElement("button", { className: "btn btn-primary", onClick: () => {
                                        moveTarget.items.forEach(it => {
                                            if (it.kind === 'deck') moveDeckToFolder(it.id, moveDest);
                                            else moveFolderToFolder(it.id, moveDest);
                                        });
                                        clearSelection();
                                        setMoveTarget(null); } }, "确定移动")
                            )
                        )
                    ), document.body)
            );
        };

        // ============================================================
        // 13. WrongList (带 LaTeX 渲染)
        // ============================================================
        const WrongList = () => {
            const { wrongQuestions } = useData();
            const { setMode } = useUi();
            const {
                removeWrongQuestion,
                clearWrongQuestions,
                startPractice,
                updateWrongAiAnswer
            } = useActions();
            const [expandedId, setExpandedId] = useState(null);
            const [askStates, setAskStates] = useState({});
            const [wrongSearch, setWrongSearch] = useState('');
            const [wrongVisible, setWrongVisible] = useState(10);

            const filteredWrong = useMemo(() => wrongQuestions.filter(w => (w.question || '').toLowerCase().includes(wrongSearch.trim()
                .toLowerCase())), [wrongQuestions, wrongSearch]);
            const shownWrong = useMemo(() => filteredWrong.slice(0, wrongVisible), [filteredWrong, wrongVisible]);

            const toggleExpand = id => setExpandedId(expandedId === id ? null : id);
            const formatTime = ts => {
                const d = (ts == null) ? null : new Date(ts);
                if (!d || isNaN(d.getTime())) return '时间未知';
                return d.toLocaleString('zh-CN', { hour12: false });
            };

            const handlePracticeAll = () => {
                if (wrongQuestions.length === 0) { alert('错题本为空，无法练习'); return; }
                const total = wrongQuestions.length;
                const input = prompt(`请输入要练习的错题数量（共 ${total} 道）：`, String(total));
                if (input === null) return;
                let count = parseInt(input);
                if (isNaN(count) || count < 1) { alert('请输入有效的正整数'); return; }
                if (count > total) { alert(`数量不能超过 ${total}，将使用全部 ${total} 题`);
                    count = total; }
                const shuffled = [...wrongQuestions].sort(() => Math.random() - 0.5);
                const selected = shuffled.slice(0, count);
                startPractice(selected);
            };

            const handlePracticeSingle = (wrongItem, e) => {
                e.stopPropagation();
                startPractice([wrongItem]);
            };

            const toggleAsk = id => {
                setAskStates(prev => ({ ...prev, [id]: { ...prev[id], showAsk: !(prev[id]?.showAsk || false),
                        askQuestion: '', aiAnswer: '', asking: false, followUpQuestion: '', followingUp: false } }));
            };

            const setAskQuestion = (id, value) => {
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), askQuestion: value } }));
            };

            const setFollowUpQuestion = (id, value) => {
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followUpQuestion: value } }));
            };

            const handleAskAI = async (id, wrongItem) => {
                const state = askStates[id] || {};
                const q = state.askQuestion?.trim();
                if (!q) { alert('请输入你要问的问题'); return; }
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), asking: true } }));
                try {
                    const response = await askAIForExplanation(wrongItem.question, wrongItem.userAnswer, wrongItem
                        .correctAnswer, wrongItem.explanation || '', q);
                    const history = [...(wrongItem.qaHistory || []), { q, a: response }];
                    updateWrongAiAnswer(id, response, history);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), askQuestion: '', asking: false,
                            showAsk: false, aiAnswer: response, qaHistory: history } }));
                } catch (err) {
                    alert('追问失败：' + err.message);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), asking: false } }));
                }
            };

            const handleFollowUp = async (id, wrongItem) => {
                const state = askStates[id] || {};
                const q = state.followUpQuestion?.trim();
                if (!q) { alert('请输入你要继续追问的问题'); return; }
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followingUp: true } }));
                try {
                    const base = state.qaHistory || wrongItem.qaHistory || [];
                    const lastA = base.length ? base[base.length - 1].a : wrongItem.aiAnswer || '无';
                    const prompt =
                        `你是老师。学生之前问了问题，你已简要回答。现在学生继续追问。\n\n之前的回答：${lastA}\n\n学生的新问题：${q}\n\n要求：用 2-4 句话简要回答，直击要点，与上一条衔接，不要展开长文。`;
                    const answer = (await postChat('你是老师，回答简练、切中要害，节省 tokens。', prompt,
                        { temperature: 0.4, maxTokens: 300, timeoutMs: 60000 })) || '抱歉，我无法回答这个问题。';
                    const history = [...base, { q, a: answer }];
                    updateWrongAiAnswer(id, answer, history);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followUpQuestion: '',
                            followingUp: false, aiAnswer: answer, qaHistory: history } }));
                } catch (err) {
                    alert('继续追问失败：' + err.message);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followingUp: false } }));
                }
            };

            return React.createElement("div", { className: "card wf-card" },
                React.createElement("div", { className: "card-header" },
                    React.createElement("h2", { style: { fontSize: '1.6rem', color: 'var(--text)' } }, "📕 错题本"),
                    React.createElement("div", { className: "actions" },
                        React.createElement("button", { className: "btn btn-outline", onClick: () => setMode('home') },
                            "返回"),
                        wrongQuestions.length > 0 &&
                        React.createElement(React.Fragment, null,
                            React.createElement("button", { className: "btn btn-practice", onClick: handlePracticeAll },
                                "📝 错题练习"),
                            React.createElement("button", { className: "btn btn-danger", onClick: clearWrongQuestions },
                                "清空全部")
                        )
                    )
                ),
                wrongQuestions.length === 0 ?
                React.createElement("p", { className: "text-muted text-center", style: { padding: '30px 0' } },
                    "还没有错题，继续加油吧！💪"
                ) :
                React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "wf-scroll" },
                        React.createElement("div", { className: "wf-toolbar", style: { marginBottom: 14 } },
                            React.createElement("input", { type: "text", className: "input-field",
                                placeholder: "🔍 搜索错题内容...", value: wrongSearch, onChange: e => {
                                    setWrongSearch(e.target.value);
                                    setWrongVisible(10); } })
                        ),
                filteredWrong.length === 0 ?
                    React.createElement("p", { className: "text-muted text-center", style: { padding: '20px 0' } },
                        "未找到匹配「", wrongSearch, "」的错题"
                    ) :
                    shownWrong.map(w => {
                        const state = askStates[w.id] || {};
                        const showAsk = state.showAsk || false;
                        const asking = state.asking || false;
                        const followingUp = state.followingUp || false;
                        return React.createElement("div", { key: w.id, className: "wrong-item", onClick: () =>
                                toggleExpand(w.id) },
                            React.createElement("div", { className: "wrong-item-header" },
                                React.createElement(LatexSpan, { className: "wrong-item-title" }, w
                                    .question),
                                React.createElement("span", { className: "wrong-item-meta" },
                                    TYPE_LABELS[w.type] || w.type, " · 练习 ", w.practiceCount || 0,
                                    " 次 · 正确 ", w.correctCount || 0, " 次")
                            ),
                            expandedId === w.id &&
                            React.createElement("div", { className: "wrong-detail" },
                                React.createElement(QuestionImages, { images: w.images }),
                                w.figure && React.createElement(GeomBoard, { spec: w.figure, compact: true }),
                                React.createElement("p", null, React.createElement("strong", null,
                                        "你的答案："), React.createElement(LatexSpan, null, w
                                        .userAnswer)),
                                (w.wrongAnswers && w.wrongAnswers.length > 1) &&
                                React.createElement("div", { style: { marginTop: 4 } },
                                    React.createElement("strong", null, "历次答错记录："),
                                    w.wrongAnswers.map((ans, i) =>
                                        React.createElement("div", { key: i, style: { marginTop: 2,
                                                fontSize: '0.9rem', color: 'var(--text-muted)' } },
                                            React.createElement("span", null, (i + 1) + ". "),
                                            React.createElement(LatexSpan, null, ans)
                                        )
                                    )
                                ),
                                React.createElement("p", null, React.createElement("strong", null,
                                        "正确答案："), React.createElement(LatexSpan, null,
                                        formatCorrectAnswer(w))),
                                w.explanation && React.createElement("div", null,
                                    React.createElement("strong", null, "解析："),
                                    React.createElement(RichSpan, null, w.explanation)
                                ),
                                (() => {
                                    const thread = w.qaHistory && w.qaHistory.length ? w.qaHistory :
                                        w.aiAnswer ? [{ q: '', a: w.aiAnswer }] : [];
                                    if (!thread.length) return null;
                                    return React.createElement("div", { style: { marginTop: 4 } },
                                        React.createElement("p", null, React.createElement(
                                            "strong", null, "🤖 AI 解答：")),
                                        thread.map((pair, i) =>
                                            React.createElement("div", { key: i,
                                                    style: { marginTop: 4 } },
                                                pair.q ? React.createElement("p", { style: {
                                                        fontWeight: 600,
                                                        fontSize: '0.9rem' } },
                                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                                        "❓ 我："), pair.q
                                                ) : null,
                                                React.createElement("div", { style: { marginTop: 2,
                                                        fontSize: '0.9rem' } },
                                                    React.createElement("span", { style: { color: '#f39c12' } },
                                                        "🤖 AI："), React.createElement(RichSpan,
                                                        null, pair.a)
                                                )
                                            )
                                        )
                                    );
                                })(),
                                React.createElement("div", { className: "wrong-actions" },
                                    React.createElement("button", { className: "btn btn-practice btn-sm",
                                        onClick: e => handlePracticeSingle(w, e) }, "📝 单独练习"),
                                    !showAsk && React.createElement("button", { className: "btn btn-ask btn-sm",
                                        onClick: e => { e.stopPropagation();
                                            toggleAsk(w.id); } }, "🤔 追问"),
                                    React.createElement("button", { className: "btn btn-danger btn-sm",
                                        onClick: e => { e.stopPropagation();
                                            removeWrongQuestion(w.id); } }, "删除")
                                ),
                                showAsk && React.createElement("div", { className: "ask-box", onClick: e =>
                                        e.stopPropagation() },
                                    React.createElement("div", { className: "flex-between" },
                                        React.createElement("input", { type: "text", className: "input-field",
                                            placeholder: "输入你想追问的问题...", value: state
                                                .askQuestion || '', onChange: e => setAskQuestion(w
                                                .id, e.target.value), disabled: asking,
                                            style: { flex: 1, marginRight: 8 } }),
                                        React.createElement("button", { className: "btn btn-primary",
                                            onClick: () => handleAskAI(w.id, w), disabled: asking ||
                                                !state.askQuestion?.trim() }, asking ? '⏳' :
                                            '发送')
                                    ),
                                    asking && React.createElement("div", { className: "text-center mt-4",
                                            style: { padding: '10px' } },
                                        React.createElement("div", { className: "spinner",
                                            style: { margin: '0 auto' } }),
                                        React.createElement("p", { className: "text-muted" },
                                            "AI 正在回答...")
                                    ),
                                    (state.qaHistory || w.qaHistory || (state.aiAnswer ? [{ q: '',
                                        a: state.aiAnswer }] : [])).length > 0 &&
                                    React.createElement("div", { className: "explanation-box",
                                            style: { marginTop: 12, borderLeftColor: '#f39c12' } },
                                        React.createElement("strong", null, "🤖 AI 解答"),
                                        (state.qaHistory || w.qaHistory || (state.aiAnswer ? [{ q: '',
                                            a: state.aiAnswer }] : [])).map((pair, i) =>
                                            React.createElement("div", { key: i,
                                                    style: { marginTop: 10 } },
                                                pair.q ? React.createElement("p", { style: {
                                                        fontWeight: 600 } },
                                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                                        "❓ 我："), pair.q
                                                ) : null,
                                                React.createElement("div", { style: { marginTop: 4 } },
                                                    React.createElement("span", { style: { color: '#f39c12' } },
                                                        "🤖 AI："), React.createElement(RichSpan,
                                                        null, pair.a)
                                                )
                                            )
                                        ),
                                        React.createElement("div", { className: "mt-4" },
                                            React.createElement("input", { type: "text",
                                                className: "input-field",
                                                placeholder: "继续追问...", value: state
                                                    .followUpQuestion || '', onChange: e =>
                                                    setFollowUpQuestion(w.id, e.target
                                                    .value), disabled: followingUp,
                                                style: { marginBottom: 8 } }),
                                            React.createElement("button", { className: "btn btn-ask",
                                                onClick: () => handleFollowUp(w.id, w),
                                                disabled: followingUp || !state.followUpQuestion
                                                    ?.trim() }, followingUp ? '⏳ 追问中...' :
                                                '继续追问')
                                        )
                                    ),
                                    React.createElement("div", { className: "mt-4" },
                                        React.createElement("button", { className: "btn btn-outline btn-sm",
                                            onClick: e => { e.stopPropagation();
                                                toggleAsk(w.id); } }, "收起")
                                    )
                                )
                            )
                        );
                    }),
                    filteredWrong.length > wrongVisible &&
                    React.createElement("div", { className: "text-center mt-4" },
                        React.createElement("button", { className: "btn btn-outline", onClick: () => setWrongVisible(
                                c => c + 10) }, "加载更多（剩余 ", filteredWrong.length - wrongVisible,
                            " 个）")
                    ),
                    React.createElement("div", { className: "text-muted text-center mt-4",
                            style: { fontSize: '0.85rem' } },
                    "点击条目展开详情，可单独练习或追问 AI"
                )
                )
                )
            );
        };

        // ============================================================
        // 14. FavoritesList (带 LaTeX 渲染)
        // ============================================================
        const FavoritesList = () => {
            const { favorites } = useData();
            const { setMode } = useUi();
            const {
                removeFavorite,
                clearFavorites,
                startFavPractice,
                updateFavoriteAiAnswer
            } = useActions();
            const [expandedId, setExpandedId] = useState(null);
            const [askStates, setAskStates] = useState({});
            const [favSearch, setFavSearch] = useState('');
            const [favVisible, setFavVisible] = useState(10);

            const filteredFav = useMemo(() => favorites.filter(f => (f.question || '').toLowerCase().includes(favSearch.trim()
            .toLowerCase())), [favorites, favSearch]);
            const shownFav = useMemo(() => filteredFav.slice(0, favVisible), [filteredFav, favVisible]);

            const toggleExpand = id => setExpandedId(expandedId === id ? null : id);
            const formatTime = ts => {
                const d = (ts == null) ? null : new Date(ts);
                if (!d || isNaN(d.getTime())) return '时间未知';
                return d.toLocaleString('zh-CN', { hour12: false });
            };

            const handlePracticeSingle = (fav, e) => {
                e.stopPropagation();
                startFavPractice([fav]);
            };

            const toggleAsk = id => {
                setAskStates(prev => ({ ...prev, [id]: { ...prev[id], showAsk: !(prev[id]?.showAsk || false),
                        askQuestion: '', aiAnswer: '', asking: false, followUpQuestion: '', followingUp: false } }));
            };

            const setAskQuestion = (id, value) => {
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), askQuestion: value } }));
            };

            const setFollowUpQuestion = (id, value) => {
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followUpQuestion: value } }));
            };

            const handleAskAI = async (id, fav) => {
                const state = askStates[id] || {};
                const q = state.askQuestion?.trim();
                if (!q) { alert('请输入你要问的问题'); return; }
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), asking: true } }));
                try {
                    const response = await askAIForExplanation(fav.question, '', fav.correctAnswer, fav.explanation ||
                        '', q);
                    const history = [...(fav.qaHistory || []), { q, a: response }];
                    updateFavoriteAiAnswer(id, response, history);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), askQuestion: '', asking: false,
                            showAsk: false, aiAnswer: response, qaHistory: history } }));
                } catch (err) {
                    alert('追问失败：' + err.message);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), asking: false } }));
                }
            };

            const handleFollowUp = async (id, fav) => {
                const state = askStates[id] || {};
                const q = state.followUpQuestion?.trim();
                if (!q) { alert('请输入你要继续追问的问题'); return; }
                setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followingUp: true } }));
                try {
                    const base = state.qaHistory || fav.qaHistory || [];
                    const lastA = base.length ? base[base.length - 1].a : fav.aiAnswer || '无';
                    const prompt =
                        `你是老师。学生之前问了问题，你已简要回答。现在学生继续追问。\n\n之前的回答：${lastA}\n\n学生的新问题：${q}\n\n要求：用 2-4 句话简要回答，直击要点，与上一条衔接，不要展开长文。`;
                    const answer = (await postChat('你是老师，回答简练、切中要害，节省 tokens。', prompt,
                        { temperature: 0.4, maxTokens: 300, timeoutMs: 60000 })) || '抱歉，我无法回答这个问题。';
                    const history = [...base, { q, a: answer }];
                    updateFavoriteAiAnswer(id, answer, history);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followUpQuestion: '',
                            followingUp: false, aiAnswer: answer, qaHistory: history } }));
                } catch (err) {
                    alert('继续追问失败：' + err.message);
                    setAskStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), followingUp: false } }));
                }
            };

            return React.createElement("div", { className: "card wf-card" },
                React.createElement("div", { className: "card-header" },
                    React.createElement("h2", { style: { fontSize: '1.6rem', color: 'var(--text)' } }, "⭐ 收藏夹"),
                    React.createElement("div", { className: "actions" },
                        React.createElement("button", { className: "btn btn-outline", onClick: () => setMode('home') },
                            "返回"),
                        favorites.length > 0 &&
                        React.createElement(React.Fragment, null,
                            React.createElement("button", { className: "btn btn-practice", onClick: () =>
                                    startFavPractice(favorites) }, "🎲 随机出题"),
                            React.createElement("button", { className: "btn btn-danger", onClick: clearFavorites },
                                "清空")
                        )
                    )
                ),
                favorites.length === 0 ?
                React.createElement("p", { className: "text-muted text-center", style: { padding: '30px 0' } },
                    "还没有收藏的题目，做题时点击「☆ 收藏」即可加入收藏夹。⭐"
                ) :
                React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "wf-scroll" },
                        React.createElement("div", { className: "wf-toolbar", style: { marginBottom: 14 } },
                            React.createElement("input", { type: "text", className: "input-field",
                                placeholder: "🔍 搜索收藏内容...", value: favSearch, onChange: e => {
                                    setFavSearch(e.target.value);
                                    setFavVisible(10); } })
                        ),
                    filteredFav.length === 0 ?
                    React.createElement("p", { className: "text-muted text-center", style: { padding: '20px 0' } },
                        "未找到匹配「", favSearch, "」的收藏"
                    ) :
                    shownFav.map(f => {
                        const state = askStates[f.id] || {};
                        const showAsk = state.showAsk || false;
                        const asking = state.asking || false;
                        const followingUp = state.followingUp || false;
                        return React.createElement("div", { key: f.id, className: "wrong-item", onClick: () =>
                                toggleExpand(f.id) },
                            React.createElement("div", { className: "wrong-item-header" },
                                React.createElement(LatexSpan, { className: "wrong-item-title" }, f
                                    .question),
                                React.createElement("span", { className: "wrong-item-meta" },
                                    TYPE_LABELS[f.type] || f.type, " · ", formatTime(f.timestamp))
                            ),
                            expandedId === f.id &&
                            React.createElement("div", { className: "wrong-detail" },
                                React.createElement("p", null, React.createElement("strong", null,
                                        "题型："), TYPE_LABELS[f.type] || f.type),
                                React.createElement("p", null, React.createElement("strong", null,
                                        "题目："), React.createElement(LatexSpan, null, f
                                        .question)),
                                React.createElement(QuestionImages, { images: f.images }),
                                f.figure && React.createElement(GeomBoard, { spec: f.figure, compact: true }),
                                f.options && Array.isArray(f.options) &&
                                React.createElement("div", { style: { marginTop: 6 } },
                                    React.createElement("strong", null, "选项："),
                                    React.createElement("ul", { style: { marginLeft: 20 } },
                                        f.options.map((o, i) =>
                                            React.createElement("li", { key: i, style: (f
                                                    .type === 'multiple_select' && Array
                                                    .isArray(f.correctAnswer) ? f
                                                    .correctAnswer.includes(o) : o === f
                                                    .correctAnswer) ? { fontWeight: 700,
                                                    color: '#58cc02' } : {} },
                                                String.fromCharCode(65 + i), ". ",
                                                React.createElement(LatexSpan, null,
                                                    cleanOption(o))
                                            )
                                        )
                                    )
                                ),
                                React.createElement("p", null, React.createElement("strong", null,
                                        "正确答案："), React.createElement(LatexSpan, null,
                                        formatCorrectAnswer(f))),
                                f.explanation && React.createElement("div", null,
                                    React.createElement("strong", null, "解析："),
                                    React.createElement(RichSpan, null, f.explanation)
                                ),
                                (() => {
                                    const thread = f.qaHistory && f.qaHistory.length ? f
                                        .qaHistory : f.aiAnswer ? [{ q: '', a: f
                                            .aiAnswer }] : [];
                                    if (!thread.length) return null;
                                    return React.createElement("div", { style: { marginTop: 4 } },
                                        React.createElement("p", null, React.createElement(
                                            "strong", null, "🤖 AI 解答：")),
                                        thread.map((pair, i) =>
                                            React.createElement("div", { key: i,
                                                    style: { marginTop: 4 } },
                                                pair.q ? React.createElement("p", { style: {
                                                        fontWeight: 600,
                                                        fontSize: '0.9rem' } },
                                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                                        "❓ 我："), pair.q
                                                ) : null,
                                                React.createElement("div", { style: { marginTop: 2,
                                                        fontSize: '0.9rem' } },
                                                    React.createElement("span", { style: { color: '#f39c12' } },
                                                        "🤖 AI："), React.createElement(RichSpan,
                                                        null, pair.a)
                                                )
                                            )
                                        )
                                    );
                                })(),
                                React.createElement("div", { className: "wrong-actions" },
                                    React.createElement("button", { className: "btn btn-practice btn-sm",
                                        onClick: e => handlePracticeSingle(f, e) }, "📝 单独练习"),
                                    !showAsk && React.createElement("button", { className: "btn btn-ask btn-sm",
                                        onClick: e => { e.stopPropagation();
                                            toggleAsk(f.id); } }, "🤔 追问"),
                                    React.createElement("button", { className: "btn btn-danger btn-sm",
                                        onClick: e => { e.stopPropagation();
                                            removeFavorite(f.id); } }, "取消收藏")
                                ),
                                showAsk && React.createElement("div", { className: "ask-box", onClick: e =>
                                        e.stopPropagation() },
                                    React.createElement("div", { className: "flex-between" },
                                        React.createElement("input", { type: "text", className: "input-field",
                                            placeholder: "输入你想追问的问题...", value: state
                                                .askQuestion || '', onChange: e => setAskQuestion(f
                                                .id, e.target.value), disabled: asking,
                                            style: { flex: 1, marginRight: 8 } }),
                                        React.createElement("button", { className: "btn btn-primary",
                                            onClick: () => handleAskAI(f.id, f), disabled: asking ||
                                                !state.askQuestion?.trim() }, asking ? '⏳' :
                                            '发送')
                                    ),
                                    asking && React.createElement("div", { className: "text-center mt-4",
                                            style: { padding: '10px' } },
                                        React.createElement("div", { className: "spinner",
                                            style: { margin: '0 auto' } }),
                                        React.createElement("p", { className: "text-muted" },
                                            "AI 正在回答...")
                                    ),
                                    (state.qaHistory || f.qaHistory || (state.aiAnswer ? [{ q: '',
                                        a: state.aiAnswer }] : [])).length > 0 &&
                                    React.createElement("div", { className: "explanation-box",
                                            style: { marginTop: 12, borderLeftColor: '#f39c12' } },
                                        React.createElement("strong", null, "🤖 AI 解答"),
                                        (state.qaHistory || f.qaHistory || (state.aiAnswer ? [{ q: '',
                                            a: state.aiAnswer }] : [])).map((pair, i) =>
                                            React.createElement("div", { key: i,
                                                    style: { marginTop: 10 } },
                                                pair.q ? React.createElement("p", { style: {
                                                        fontWeight: 600 } },
                                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                                        "❓ 我："), pair.q
                                                ) : null,
                                                React.createElement("div", { style: { marginTop: 4 } },
                                                    React.createElement("span", { style: { color: '#f39c12' } },
                                                        "🤖 AI："), React.createElement(RichSpan,
                                                        null, pair.a)
                                                )
                                            )
                                        ),
                                        React.createElement("div", { className: "mt-4" },
                                            React.createElement("input", { type: "text",
                                                className: "input-field",
                                                placeholder: "继续追问...", value: state
                                                    .followUpQuestion || '', onChange: e =>
                                                    setFollowUpQuestion(f.id, e.target
                                                    .value), disabled: followingUp,
                                                style: { marginBottom: 8 } }),
                                            React.createElement("button", { className: "btn btn-ask",
                                                onClick: () => handleFollowUp(f.id, f),
                                                disabled: followingUp || !state.followUpQuestion
                                                    ?.trim() }, followingUp ? '⏳ 追问中...' :
                                                '继续追问')
                                        )
                                    ),
                                    React.createElement("div", { className: "mt-4" },
                                        React.createElement("button", { className: "btn btn-outline btn-sm",
                                            onClick: e => { e.stopPropagation();
                                                toggleAsk(f.id); } }, "收起")
                                    )
                                )
                            )
                        );
                    }),
                    filteredFav.length > favVisible &&
                    React.createElement("div", { className: "text-center mt-4" },
                        React.createElement("button", { className: "btn btn-outline", onClick: () => setFavVisible(
                                c => c + 10) }, "加载更多（剩余 ", filteredFav.length - favVisible,
                            " 个）")
                    ),
                    React.createElement("div", { className: "text-muted text-center mt-4",
                            style: { fontSize: '0.85rem' } },
                        "点击条目展开详情，可单独练习、随机出题或追问 AI"
                    )
                    )
                )
            );
        };

        // ============================================================
        // 15. AIGenerator (不变)
        // ============================================================
        const AIGenerator = () => {
            const { decks } = useData();
            const { setMode } = useUi();
            const { addDeck } = useActions();
            const presets = API_PRESETS;
            const [apiKey, setApiKey] = useState(() => localStorage.getItem('deepseek_key') || '');
            const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('api_base_url') ||
            'https://api.deepseek.com/v1');
            const [model, setModel] = useState(() => localStorage.getItem('api_model') || 'deepseek-chat');
            const [provider, setProvider] = useState(() => {
                const saved = localStorage.getItem('api_provider') || 'deepseek';
                const currentBase = localStorage.getItem('api_base_url') || 'https://api.deepseek.com/v1';
                const currentModel = localStorage.getItem('api_model') || 'deepseek-chat';
                for (const [key, val] of Object.entries(presets)) {
                    if (val.baseUrl === currentBase && val.model === currentModel) return key;
                }
                return 'custom';
            });
            const [content, setContent] = useState('');
            const [count, setCount] = useState(5);
            const [temperature, setTemperature] = useState(() => {
                const saved = localStorage.getItem('ai_temperature');
                const n = saved !== null ? Number(saved) : 0.7;
                if (isNaN(n)) return 0.7;
                return Math.min(2, Math.max(0, n));
            });
            const [loading, setLoading] = useState(false);
            const [generatedData, setGeneratedData] = useState(null);
            // 已生成题目的预览分页：避免一次生成几十题时全量建 DOM 卡顿（与题库编辑/错题本一致）
            const [genVisible, setGenVisible] = useState(30);

            useEffect(() => {
                if (provider !== 'custom' && presets[provider]) {
                    const preset = presets[provider];
                    setBaseUrl(preset.baseUrl);
                    setModel(preset.model);
                    localStorage.setItem('api_base_url', preset.baseUrl);
                    localStorage.setItem('api_model', preset.model);
                    localStorage.setItem('api_provider', provider);
                } else if (provider === 'custom') {
                    localStorage.setItem('api_provider', 'custom');
                }
            }, [provider]);

            const handleBaseUrlChange = val => {
                setBaseUrl(val);
                localStorage.setItem('api_base_url', val);
                let matched = false;
                for (const [key, p] of Object.entries(presets)) {
                    if (p.baseUrl === val && p.model === model) { matched = true; if (provider !== key) setProvider(
                            key); break; }
                }
                if (!matched && provider !== 'custom') setProvider('custom');
            };

            const handleModelChange = val => {
                setModel(val);
                localStorage.setItem('api_model', val);
                let matched = false;
                for (const [key, p] of Object.entries(presets)) {
                    if (p.baseUrl === baseUrl && p.model === val) { matched = true; if (provider !== key) setProvider(
                            key); break; }
                }
                if (!matched && provider !== 'custom') setProvider('custom');
            };

            const handleApiKeyChange = val => {
                setApiKey(val);
                localStorage.setItem('deepseek_key', val);
            };

            const handleGenerate = async () => {
                if (!apiKey) return alert('请输入 API Key');
                if (!content.trim()) return alert('请输入文本内容');
                localStorage.setItem('api_base_url', baseUrl);
                localStorage.setItem('api_model', model);
                setLoading(true);
                try {
                    const safeTemp = Math.min(2, Math.max(0, Number(temperature) || 0.7));
                    const result = await generateQuestionsFromContent(content, count, safeTemp);
                    setGeneratedData({ ...result, questions: normalizeQuestions(result.questions), requestedCount: count });
                } catch (err) {
                    alert('生成失败：' + err.message);
                } finally {
                    setLoading(false);
                }
            };

            const handleSaveDeck = () => {
                if (!generatedData || !generatedData.questions || generatedData.questions.length === 0) return;
                let baseName = generatedData.title && generatedData.title.trim() ? generatedData.title.trim() :
                    'AI生成题库';
                if (baseName.length > 30) baseName = baseName.slice(0, 27) + '...';
                const uniqueName = generateUniqueName(baseName, decks);
                const deck = addDeck(uniqueName, '由 AI 自动生成', normalizeQuestions(generatedData.questions));
                alert(`✅ 已保存题库「${deck.name}」，共 ${deck.questions.length} 题`);
                setGeneratedData(null);
                setContent('');
                setMode('home');
            };

            return React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-header" },
                    React.createElement("h2", { style: { color: 'var(--text)' } }, "🤖 AI 智能拆题(生题)"),
                    React.createElement("button", { className: "btn btn-outline", onClick: () => { setMode('home');
                            setGeneratedData(null); } }, "返回")
                ),
                React.createElement("div", { className: "mb-4" },
                    React.createElement("label", { className: "label" }, "🔑 API Key"),
                    React.createElement("input", { type: "password", className: "input-field", placeholder: "sk-...",
                        value: apiKey, onChange: e => handleApiKeyChange(e.target.value) })
                ),
                React.createElement("div", { className: "mb-4" },
                    React.createElement("label", { className: "label" }, "📡 API 提供商"),
                    React.createElement("select", { className: "input-field", value: provider, onChange: e =>
                            setProvider(e.target.value) },
                        React.createElement("option", { value: "deepseek" }, "DeepSeek"),
                        React.createElement("option", { value: "zhipu" }, "智谱 GLM"),
                        React.createElement("option", { value: "qwen" }, "通义千问"),
                        React.createElement("option", { value: "ollama" }, "Ollama (本地)"),
                        React.createElement("option", { value: "custom" }, "✏️ 自定义")
                    )
                ),
                React.createElement("div", { className: "mb-4" },
                    React.createElement("label", { className: "label" }, "🌐 API Base URL"),
                    React.createElement("input", { type: "text", className: "input-field",
                        placeholder: "https://api.deepseek.com/v1", value: baseUrl, onChange: e =>
                            handleBaseUrlChange(e.target.value) })
                ),
                React.createElement("div", { className: "mb-4" },
                    React.createElement("label", { className: "label" }, "🧠 模型名称"),
                    React.createElement("input", { type: "text", className: "input-field",
                        placeholder: "deepseek-chat", value: model, onChange: e => handleModelChange(e
                            .target.value) })
                ),
                React.createElement("div", { className: "mb-4" },
                    React.createElement("label", { className: "label" }, "📄 文本内容"),
                    React.createElement(LatexField, { tag: "textarea", rows: 8, placeholder: "粘贴文章、笔记、教材段落……（支持 LaTeX 公式，如 $E=mc^2$、$$\\int_0^\\infty e^{-x^2}dx=\\frac{\\sqrt{\\pi}}{2}$$）",
                        value: content, onChange: e => setContent(e.target.value) }),
                    React.createElement(LatexAnswerPreview, { value: content })
                ),
                React.createElement("div", { className: "flex-between mb-4", style: { gap: 16, flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("label", { className: "label" }, "题目数量"),
                        React.createElement("input", { type: "number", className: "input-field", style: { width: '80px' },
                            min: "1", max: "10", value: count, onChange: e => setCount(Math.min(10, Math
                                .max(1, Number(e.target.value) || 1))) })
                    ),
                    React.createElement("div", { style: { flex: '1 1 220px', minWidth: 200 } },
                        React.createElement("label", { className: "label", style: { display: 'flex',
                                justifyContent: 'space-between', gap: 8 } },
                            "🎲 随机性 (temperature)",
                            React.createElement("span", { className: "text-muted" }, temperature.toFixed(2))),
                        React.createElement("input", { type: "range", min: "0", max: "2", step: "0.05", value: temperature,
                            onChange: e => { const v = Number(e.target.value); setTemperature(v); localStorage
                                .setItem('ai_temperature', String(v)); }, style: { width: '100%' } }),
                        React.createElement("div", { className: "text-muted", style: { fontSize: '0.75rem', marginTop: 2 } },
                            "值越低输出越稳定，越高越发散多变")
                    )
                ),
                React.createElement("div", { className: "flex-between mb-4" },
                    React.createElement("div", null),
                    React.createElement("button", { className: "btn btn-primary", onClick: handleGenerate,
                        disabled: loading }, loading ? React.createElement("span", { style: { display: 'inline-flex',
                            alignItems: 'center', gap: 8 } }, React.createElement("div", { className: "spinner",
                            style: { width: '16px', height: '16px', borderWidth: '2px', borderTopColor: '#fff',
                                borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' } }), "生成中...") :
                        '🚀 生成题目')
                ),
                loading && React.createElement("div", { style: { marginTop: 16, textAlign: 'center', padding: '28px 12px',
                        borderRadius: 12, background: 'var(--bg-alt, rgba(28,176,246,0.06))' } },
                    React.createElement("div", { className: "spinner", style: { margin: '0 auto 12px', width: '36px',
                            height: '36px', borderWidth: '4px' } }),
                    React.createElement("div", { className: "text-muted", style: { fontSize: '0.95rem' } },
                        "🤖 AI 正在生成题目，请稍候…")
                ),
                generatedData && React.createElement("div", { className: "mt-4", style: { borderTop: '1px solid var(--border)',
                        paddingTop: 16 } },
                    React.createElement("div", { className: "flex-between" },
                        React.createElement("div", null,
                            React.createElement("span", { style: { fontWeight: 600, color: generatedData.questions.length < (generatedData.requestedCount || 0) ? '#5b9bd5' : 'var(--text)' } },
                                generatedData.questions.length < (generatedData.requestedCount || 0)
                                    ? "ℹ️ 本次生成 " + generatedData.questions.length + " 道（你设置 " + generatedData.requestedCount + " 道，AI 可能不严格遵循数量，不影响使用）"
                                    : "✅ 已生成 " + generatedData.questions.length + " 道题"),
                            React.createElement("div", { className: "text-muted", style: { fontSize: '0.9rem',
                                    marginTop: 4 } }, "📝 AI 标题：", React.createElement("strong", null,
                                    generatedData.title || 'AI生成题库'))
                        ),
                        React.createElement("div", { className: "actions" },
                            React.createElement("button", { className: "btn btn-success", onClick: handleSaveDeck },
                                "💾 保存题库"),
                            React.createElement("button", { className: "btn btn-outline", onClick: () =>
                                    setGeneratedData(null) }, "重新生成")
                        )
                    ),
                    React.createElement("div", { style: { maxHeight: '300px', overflowY: 'auto', marginTop: 12 } },
                        generatedData.questions.slice(0, genVisible).map((q, i) =>
                            React.createElement("div", { key: i, style: { padding: '8px 0', borderBottom: '1px solid var(--border)',
                                    fontSize: '0.9rem', color: 'var(--text)' } },
                                React.createElement("strong", null, i + 1, "."), " ",
                                React.createElement(LatexSpan, null, q.question), " ",
                                React.createElement("span", { className: "text-muted" }, "(",
                                    TYPE_LABELS[q.type] || q.type, ")")
                            )
                        ),
                        generatedData.questions.length > genVisible &&
                        React.createElement("div", { style: { textAlign: 'center', marginTop: 8 } },
                            React.createElement("button", { className: "btn btn-outline btn-sm", onClick: () => setGenVisible(v => v + 30) },
                                "加载更多（剩余 ", generatedData.questions.length - genVisible, " 题）")
                        )
                    )
                )
            );
        };

        // 16. QuestionCard (答题卡片, 带 LaTeX 渲染)
        // ============================================================
        const QuestionCard = () => {
            const { session, setSession } = useSession();
            const { setMode } = useUi();
            const {
                nextQuestion,
                handleAnswer,
                recordAnswer,
                addWrongQuestion,
                updateWrongAiAnswer,
                toggleFavorite,
                isFavorited
            } = useActions();

            const [selected, setSelected] = useState(null);
            const [submitted, setSubmitted] = useState(false);
            const [isCorrect, setIsCorrect] = useState(false);
            const [judging, setJudging] = useState(false);
            const [aiExplanation, setAiExplanation] = useState(null);
            const [selfJudged, setSelfJudged] = useState(false);
            const [selfCorrect, setSelfCorrect] = useState(false);
            const [currentWrongId, setCurrentWrongId] = useState(null);
            const [showAsk, setShowAsk] = useState(false);
            const [askQuestion, setAskQuestion] = useState('');
            const [aiAnswer, setAiAnswer] = useState('');
            const [asking, setAsking] = useState(false);
            const [followUpQuestion, setFollowUpQuestion] = useState('');
            const [followingUp, setFollowingUp] = useState(false);
            const [qaHistory, setQaHistory] = useState([]);
            const [aiVerdict, setAiVerdict] = useState(null);
            const [aiVerdictReason, setAiVerdictReason] = useState('');
            const [verdictDecided, setVerdictDecided] = useState(false);
            const [hasApi] = useState(() => { const k = localStorage.getItem('deepseek_key') || ''; return k.trim().length > 0; });

            // 提前计算 question 引用（避免 early return 违反 hooks 顺序）
            const question = session ? session.questions[session.questionIndex] : null;
            const shuffledOptions = useMemo(() => {
                if (!question) return null;
                if ((question.type === 'multiple_choice' || question.type === 'multiple_select') && question
                    .options) {
                    const opts = [...question.options];
                    for (let i = opts.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [opts[i], opts[j]] = [opts[j], opts[i]];
                    }
                    return opts;
                }
                return null;
            }, [question]);

            if (!session) return null;
            const { questions, questionIndex, deckId } = session;
            if (!question) return React.createElement("div", { style: { color: 'var(--text)' } }, "题目加载失败");
            const qScore = typeof question.score === 'number' ? question.score : 0;
            // 兜底：脏题型（导入题库等非标准 type）规范为可渲染题型，避免"暂不支持此题型"
            if (question && !KNOWN_TYPES.includes(question.type)) {
                question.type = normalizeQuestionType(question.type, Array.isArray(question.options) && question.options.length > 0);
            }

            const saveWrong = (userAns, correctAns, explanation, aiAnswerText = '', qa = []) => {
                const id = addWrongQuestion(question, userAns, correctAns, explanation || '', aiAnswerText, deckId ||
                    'random', qa);
                setCurrentWrongId(id);
                return id;
            };

            const handleSubmit = async () => {
                if (question.type === 'multiple_select') {
                    const sel = Array.isArray(selected) ? selected : [];
                    if (sel.length === 0) return;
                    const correctSet = Array.isArray(question.correctAnswer) ? question.correctAnswer : [];
                    const correct = correctSet.length === sel.length && correctSet.every(a => sel.includes(a));
                    setIsCorrect(correct);
                    setSubmitted(true);
                    handleAnswer(correct, question.difficulty || 1);
                    recordAnswer(questionIndex, correct, qScore);
                    if (!correct) { saveWrong(sel.join('、'), correctSet.join('、'), question.explanation || ''); }
                    return;
                }
                if (selected === null || selected === undefined) return;
                const userAns = String(selected).trim();
                const correctAns = String(question.correctAnswer).trim();

                if (question.type === 'multiple_choice' || question.type === 'true_false') {
                    const correct = userAns === correctAns;
                    setIsCorrect(correct);
                    setSubmitted(true);
                    handleAnswer(correct, question.difficulty || 1);
                    recordAnswer(questionIndex, correct, qScore);
                    if (!correct) { saveWrong(userAns, correctAns, question.explanation || ''); }
                    return;
                }

                if (question.type === 'fill_blank') {
                    const localCorrect = lenientFillBlankMatch(userAns, correctAns);
                    if (localCorrect) {
                        setIsCorrect(true);
                        setAiExplanation('回答正确！');
                        setSubmitted(true);
                        handleAnswer(true, question.difficulty || 1);
                        recordAnswer(questionIndex, true, qScore);
                        return;
                    }
                    if (!hasApi) {
                        setIsCorrect(false);
                        setAiExplanation('回答有误，请查看解析。');
                        setSubmitted(true);
                        handleAnswer(false, question.difficulty || 1);
                        recordAnswer(questionIndex, false, qScore);
                        saveWrong(userAns, correctAns, question.explanation || '');
                        return;
                    }
                    setJudging(true);
                    try {
                        const result = await judgeFillBlank(question.question, userAns, correctAns);
                        const correct = result.isCorrect;
                        setAiVerdict(correct);
                        setAiVerdictReason(result.explanation || (correct ? '回答正确！' :
                        '回答有误，请查看解析。'));
                        setSubmitted(true);
                        handleAnswer(correct, question.difficulty || 1);
                        recordAnswer(questionIndex, correct, qScore);
                        if (!correct) { saveWrong(userAns, correctAns, result.explanation || question.explanation || ''); }
                    } catch (err) {
                        // AI 判题失败：回退到本地判题，避免把正确答案误判为错误（不再弹"失败"报错）
                        const localCorrect = lenientFillBlankMatch(userAns, correctAns);
                        setIsCorrect(localCorrect);
                        setAiExplanation(localCorrect ? '回答正确！' : 'AI 判题暂不可用，已按本地规则判定：回答有误，请查看解析。');
                        setAiVerdict(null);
                        setSubmitted(true);
                        handleAnswer(localCorrect, question.difficulty || 1);
                        recordAnswer(questionIndex, localCorrect, qScore);
                        if (!localCorrect) { saveWrong(userAns, correctAns, question.explanation || ''); }
                    } finally {
                        setJudging(false);
                    }
                    return;
                }

                if (question.type === 'essay') {
                    if (!hasApi) { setSubmitted(true); return; }
                    setJudging(true);
                    try {
                        const result = await judgeEssay(question.question, userAns, correctAns);
                        const correct = result.isCorrect;
                        setAiVerdict(correct);
                        setAiVerdictReason(result.explanation || (correct ? '回答正确！' :
                        '回答有误，请查看解析。'));
                        setSubmitted(true);
                        handleAnswer(correct, question.difficulty || 1);
                        recordAnswer(questionIndex, correct, qScore);
                        if (!correct) { saveWrong(userAns, correctAns, result.explanation || question.explanation || ''); }
                    } catch (err) {
                        // AI 判题失败：不弹报错，改用「手动判题」入口，由用户自行定夺
                        setAiVerdict(null);
                        setSubmitted(true);
                    } finally {
                        setJudging(false);
                    }
                    return;
                }
                alert('暂不支持此题型');
            };

            const handleUserDecide = correct => {
                setIsCorrect(correct);
                setAiExplanation(aiVerdictReason || (correct ? '回答正确！' : '回答有误，请查看解析。'));
                setVerdictDecided(true);
                handleAnswer(correct, question.difficulty || 1);
                recordAnswer(questionIndex, correct, qScore);
                if (!correct) {
                    const userAns = String(selected).trim();
                    const correctAns = String(question.correctAnswer).trim();
                    saveWrong(userAns, correctAns, aiVerdictReason || question.explanation || '');
                }
            };

            const handleSelfJudge = correct => {
                setSelfCorrect(correct);
                setSelfJudged(true);
                setSubmitted(true);
                handleAnswer(correct, question.difficulty || 1);
                recordAnswer(questionIndex, correct, qScore);
                if (!correct) {
                    const userAns = String(selected).trim();
                    const correctAns = String(question.correctAnswer).trim();
                    saveWrong(userAns, correctAns, question.explanation || '');
                }
            };

            const handleAskAI = async questionText => {
                const q = questionText.trim();
                if (!q) { alert('请输入你要问的问题'); return; }
                setAsking(true);
                try {
                    const userAns = String(selected).trim();
                    const correctAns = String(question.correctAnswer).trim();
                    const explanation = displayExplanation() || question.explanation || '';
                    const response = await askAIForExplanation(question.question, userAns, correctAns, explanation, q);
                    const history = [...qaHistory, { q, a: response }];
                    setQaHistory(history);
                    setAiAnswer(response);
                    setAskQuestion('');
                    if (currentWrongId) {
                        updateWrongAiAnswer(currentWrongId, response, history);
                    } else {
                        const id = saveWrong(userAns, correctAns, explanation, response, history);
                        setCurrentWrongId(id);
                    }
                } catch (err) {
                    alert('追问失败：' + err.message);
                } finally {
                    setAsking(false);
                }
            };

            const handleFollowUp = async () => {
                if (!followUpQuestion.trim()) { alert('请输入你要继续追问的问题'); return; }
                setFollowingUp(true);
                try {
                    const userAns = String(selected).trim();
                    const correctAns = String(question.correctAnswer).trim();
                    const explanation = displayExplanation() || question.explanation || '';
                    const prevQa = [...qaHistory];
                    const lastA = prevQa.length ? prevQa[prevQa.length - 1].a : aiAnswer || '无';
                    const prompt =
                        `你是老师。学生之前问了问题，你已简要回答。现在学生继续追问。\n\n之前的回答：${lastA}\n\n学生的新问题：${followUpQuestion.trim()}\n\n要求：用 2-4 句话简要回答，直击要点，与上一条衔接，不要展开长文。`;
                    const answer = (await postChat('你是老师，回答简练、切中要害，节省 tokens。', prompt,
                        { temperature: 0.4, maxTokens: 300, timeoutMs: 60000 })) || '抱歉，我无法回答这个问题。';
                    const history = [...prevQa, { q: followUpQuestion.trim(), a: answer }];
                    setQaHistory(history);
                    setAiAnswer(answer);
                    setFollowUpQuestion('');
                    if (currentWrongId) {
                        updateWrongAiAnswer(currentWrongId, answer, history);
                    } else {
                        const id = saveWrong(userAns, correctAns, explanation, answer, history);
                        setCurrentWrongId(id);
                    }
                } catch (err) {
                    alert('继续追问失败：' + err.message);
                } finally {
                    setFollowingUp(false);
                }
            };

            const handleNext = () => {
                setSelected(question.type === 'multiple_select' ? [] : null);
                setSubmitted(false);
                setAiExplanation(null);
                setSelfJudged(false);
                setSelfCorrect(false);
                setJudging(false);
                setShowAsk(false);
                setAskQuestion('');
                setAiAnswer('');
                setAsking(false);
                setFollowUpQuestion('');
                setFollowingUp(false);
                setCurrentWrongId(null);
                setQaHistory([]);
                setAiVerdict(null);
                setAiVerdictReason('');
                setVerdictDecided(false);
                nextQuestion();
            };

            const displayExplanation = () => {
                if (question.type === 'essay' && aiExplanation !== null) return aiExplanation;
                if (question.type === 'fill_blank' && aiExplanation !== null) return aiExplanation;
                return question.explanation;
            };

            const showVerdictConfirm = () => submitted && aiVerdict !== null && !verdictDecided;
            const showManualJudge = () => question.type === 'essay' && submitted && !selfJudged && !verdictDecided &&
                aiVerdict === null;
            const showReferenceAfter = () => (question.type === 'essay' || question.type === 'fill_blank') && submitted &&
                verdictDecided && !isCorrect;
            const showAskEntry = () => {
                if (!submitted || isCorrect || !hasApi || judging || showAsk || selfJudged) return false;
                if ((question.type === 'essay' || question.type === 'fill_blank') && aiVerdict !== null && !
                    verdictDecided) return false;
                return true;
            };

            const renderOptions = () => {
                if ((question.type === 'multiple_choice' || question.type === 'multiple_select') && shuffledOptions) {
                    const isMulti = question.type === 'multiple_select';
                    const sel = isMulti && Array.isArray(selected) ? selected : [];
                    const correctSet = isMulti && Array.isArray(question.correctAnswer) ? question.correctAnswer :
                        [];
                    return shuffledOptions.map((opt, idx) => {
                        const isSel = isMulti ? sel.includes(opt) : selected === opt;
                        const isCorrectOpt = isMulti ? correctSet.includes(opt) : opt === question.correctAnswer;
                        let cls = 'option-btn';
                        if (submitted) {
                            if (isCorrectOpt) cls += ' correct';
                            else if (isSel) cls += ' wrong';
                        } else if (isSel) cls += ' selected';
                        return React.createElement("button", { key: idx, type: "button", className: cls,
                            onClick: () => {
                                if (submitted || judging) return;
                                if (isMulti) { setSelected(isSel ? sel.filter(x => x !== opt) : [...
                                        sel, opt
                                    ]); } else { setSelected(opt); }
                            }, disabled: submitted || judging },
                            React.createElement("span", { style: { fontWeight: 600 } }, String.fromCharCode(
                                65 + idx), "."), " ",
                            React.createElement(LatexSpan, null, cleanOption(opt))
                        );
                    });
                } else if (question.type === 'true_false') {
                    const tf = ['正确', '错误'];
                    return tf.map(opt => {
                        let cls = 'option-btn';
                        if (submitted) {
                            if (opt === question.correctAnswer) cls += ' correct';
                            if (selected === opt && opt !== question.correctAnswer) cls += ' wrong';
                        } else if (selected === opt) cls += ' selected';
                        return React.createElement("button", { key: opt, className: cls, onClick: () => !submitted &&
                                !judging && setSelected(opt), disabled: submitted || judging },
                            React.createElement(LatexSpan, null, opt)
                        );
                    });
                } else if (question.type === 'fill_blank') {
                    return React.createElement("div", { className: "answer-input-wrap" },
                        React.createElement(LatexField, { tag: "input", className: "input-field", placeholder: "输入答案...",
                            value: selected || '', onChange: e => !submitted && !judging && setSelected(e.target
                                .value), disabled: submitted || judging }),
                        React.createElement(LatexAnswerPreview, { value: selected }));
                } else if (question.type === 'essay') {
                    return React.createElement("div", { className: "answer-input-wrap" },
                        React.createElement(LatexField, { tag: "textarea", rows: "5", className: "input-field", placeholder: "请输入你的解答...",
                            value: selected || '', onChange: e => !submitted && !judging && setSelected(e
                                .target.value), disabled: submitted || judging }),
                        React.createElement(LatexAnswerPreview, { value: selected }));
                }
                return React.createElement("div", { className: "text-muted" }, "暂不支持此题型");
            };

            return React.createElement("div", { className: "card" },
                React.createElement("div", { className: "flex-between mb-4" },
                    React.createElement("span", { className: "text-muted" }, "第 ", questionIndex + 1, " / ",
                        questions.length, " 题"),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 12,
                            flexWrap: 'wrap' } },
                        React.createElement("span", { className: "text-muted" }, "难度: ", '⭐'.repeat(question
                            .difficulty || 1)),
                        qScore > 0 && React.createElement("span", { style: { background: '#e8f5ec', color: '#0f7a32',
                            fontSize: '0.8rem', fontWeight: 700, padding: '3px 10px', borderRadius: '20px' } },
                            "本题 " + qScore + " 分"),
                        question.type === 'multiple_select' &&
                        React.createElement("span", { style: { background: '#9b59b6', color: '#fff',
                                fontSize: '0.8rem', fontWeight: 700, padding: '3px 10px',
                                borderRadius: '20px' } }, "📝 多选题（可多选）"),
                        React.createElement("button", { className: `btn btn-sm ${isFavorited(question) ?
                                'btn-secondary' : 'btn-outline'}`, onClick: () => toggleFavorite(question,
                                deckId || 'random'), title: isFavorited(question) ? '取消收藏' :
                                '收藏此题' }, isFavorited(question) ? '★ 已收藏' : '☆ 收藏')
                    )
                ),
                React.createElement("h3", { className: "q-title" },
                    React.createElement(LatexSpan, null, question.question)
                ),
                React.createElement(QuestionImages, { images: question.images }),
                question.figure && React.createElement(GeomBoard, { spec: question.figure }),
                renderOptions(),
                judging && React.createElement("div", { className: "text-center mt-4", style: { padding: '10px' } },
                    React.createElement("div", { className: "spinner", style: { margin: '0 auto' } }),
                    React.createElement("p", { className: "text-muted" }, "AI 正在批改...")
                ),
                showVerdictConfirm() && React.createElement("div", { className: "verdict-box" },
                    React.createElement("strong", null, "🤔 请确认判题结果"),
                    React.createElement("p", { style: { marginTop: 8 } }, "AI 建议：",
                        React.createElement("b", null, aiVerdict ? '✅ 正确' : '❌ 错误')),
                    aiVerdictReason && React.createElement("div", { className: "md-content", style: { marginTop: 4, color: 'var(--text-muted)' } },
                        "AI 评语：", React.createElement(RichSpan, null, aiVerdictReason)),
                    React.createElement("p", { style: { marginTop: 6 } }, "你的答案：",
                        React.createElement("b", null, Array.isArray(selected) ? selected.join('、') : String(
                            selected).trim())),
                    React.createElement("p", { style: { marginTop: 4 } }, "参考答案：",
                        React.createElement("b", null, React.createElement(LatexSpan, null, formatCorrectAnswer(
                            question)))),
                    React.createElement("p", { style: { marginTop: 6, fontSize: '0.85rem',
                            color: 'var(--text-muted)' } }, "AI 仅供参考，最终由你定夺。"),
                    React.createElement("div", { className: "flex-between mt-4 q-footer" },
                        React.createElement("button", { className: "btn btn-success", onClick: () =>
                                handleUserDecide(true) }, "✅ 我判正确"),
                        React.createElement("button", { className: "btn btn-danger", onClick: () =>
                                handleUserDecide(false) }, "❌ 我判错误")
                    )
                ),
                submitted && displayExplanation() && !(aiVerdict !== null && !verdictDecided) &&
                React.createElement("div", { className: `explanation-box ${isCorrect ? 'correct' : 'wrong'}` },
                    React.createElement("strong", null, isCorrect ? '✅ 正确！' : '❌ 再想想'),
                    React.createElement("div", { className: "md-content", style: { marginTop: 6 } },
                        React.createElement(RichSpan, null, displayExplanation())
                    ),
                    !isCorrect && !showAsk && !showAskEntry && !selfJudged &&
                    React.createElement("div", { className: "text-muted", style: { marginTop: 8,
                            fontSize: '0.85rem' } }, "💡 已自动保存到错题本，可追问 AI 获取详细解释。")
                ),
                showReferenceAfter() && React.createElement("div", { className: "reference-box" },
                    React.createElement("strong", null, "📖 参考答案："), " ",
                    React.createElement(LatexSpan, null, formatCorrectAnswer(question)),
                    question.explanation && React.createElement("div", { className: "md-content", style: { marginTop: 6,
                            color: 'var(--text-muted)' } }, "💡 ",
                        React.createElement(RichSpan, null, question.explanation))
                ),
                showManualJudge() && React.createElement("div", { className: "explanation-box", style: { borderLeftColor: '#ffb800' } },
                    React.createElement("strong", null, "📖 参考答案"),
                    React.createElement("p", { style: { marginTop: 6 } },
                        React.createElement(LatexSpan, null, formatCorrectAnswer(question))
                    ),
                    question.explanation && React.createElement("div", { className: "md-content", style: { marginTop: 6,
                            color: 'var(--text-muted)' } }, "💡 ",
                        React.createElement(RichSpan, null, question.explanation)),
                    React.createElement("p", { style: { marginTop: 8, fontSize: '0.85rem',
                            color: 'var(--text-muted)' } }, "AI 未参与判题，请自行判断："),
                    React.createElement("div", { className: "flex-between mt-4 q-footer" },
                        React.createElement("button", { className: "btn btn-success", onClick: () =>
                                handleSelfJudge(true) }, "✅ 我认为正确"),
                        React.createElement("button", { className: "btn btn-danger", onClick: () =>
                                handleSelfJudge(false) }, "❌ 我认为错误")
                    )
                ),
                showAskEntry() && React.createElement("div", { className: "mt-4" },
                    React.createElement("button", { className: "btn btn-ask", onClick: () => setShowAsk(true) },
                        "🤔 追问 AI（更新错题本）")
                ),
                showAsk && !selfJudged && React.createElement("div", { className: "ask-box" },
                    React.createElement("div", { className: "flex-between" },
                        React.createElement("input", { type: "text", className: "input-field",
                            placeholder: "请输入你想追问的问题...", value: askQuestion, onChange: e =>
                                setAskQuestion(e.target.value), disabled: asking, style: { flex: 1,
                                marginRight: 8 } }),
                        React.createElement("button", { className: "btn btn-primary", onClick: () =>
                                handleAskAI(askQuestion), disabled: asking || !askQuestion.trim() },
                            asking ? '⏳' : '发送')
                    ),
                    asking && React.createElement("div", { className: "text-center mt-4", style: { padding: '10px' } },
                        React.createElement("div", { className: "spinner", style: { margin: '0 auto' } }),
                        React.createElement("p", { className: "text-muted" }, "AI 正在回答...")
                    ),
                    (qaHistory.length > 0 || aiAnswer) &&
                    React.createElement("div", { className: "explanation-box", style: { marginTop: 12,
                            borderLeftColor: '#f39c12' } },
                        React.createElement("strong", null, "🧠 AI 解答"),
                        (qaHistory.length > 0 ? qaHistory : [{ q: '', a: aiAnswer }]).map((pair, i) =>
                            React.createElement("div", { key: i, style: { marginTop: 10 } },
                                pair.q ? React.createElement("p", { style: { fontWeight: 600 } },
                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                        "❓ 我："), pair.q
                                ) : null,
                                React.createElement("p", { style: { marginTop: 4,
                                        whiteSpace: 'pre-wrap' } },
                                    React.createElement("span", { style: { color: '#f39c12' } },
                                        "🤖 AI："), React.createElement(RichSpan, null, pair.a)
                                )
                            )
                        ),
                        React.createElement("div", { className: "mt-4" },
                            React.createElement("input", { type: "text", className: "input-field",
                                placeholder: "继续追问...", value: followUpQuestion, onChange: e =>
                                    setFollowUpQuestion(e.target.value), disabled: followingUp,
                                style: { marginBottom: 8 } }),
                            React.createElement("button", { className: "btn btn-ask", onClick: handleFollowUp,
                                disabled: followingUp || !followUpQuestion.trim() }, followingUp ?
                                '⏳ 追问中...' : '继续追问')
                        )
                    )
                ),
                React.createElement("div", { className: "flex-between mt-6 q-footer" },
                    React.createElement("button", { className: "btn btn-outline", onClick: () => { if (confirm(
                                '退出将丢失当前进度，确定吗？')) { setSession(null); setMode('home'); } } }, "🏠 退出"),
                    !submitted ?
                    React.createElement("button", { className: "btn btn-primary", onClick: handleSubmit,
                        disabled: (question.type === 'multiple_select' ? !(Array.isArray(selected) &&
                            selected.length) : selected === null || selected === '') || judging },
                        judging ? '判题中...' : '提交答案'
                    ) :
                    (showVerdictConfirm() || showManualJudge()) ? null :
                    React.createElement("button", { className: "btn btn-success", onClick: handleNext },
                        questionIndex + 1 < questions.length ? '下一题 →' : '🎉 完成')
                )
            );
        };

        // ============================================================
        // 17. PracticeCard (带 LaTeX 渲染)
        // ============================================================
        const PracticeCard = () => {
            const { wrongQuestions, decks } = useData();
            const { setMode } = useUi();
            const { practiceSession, setPracticeSession } = useSession();
            const {
                nextPractice,
                updateWrongPractice,
                appendWrongAnswer,
                updateWrongAiAnswer,
                removeWrongQuestion
            } = useActions();

            const [selected, setSelected] = useState(null);
            const [submitted, setSubmitted] = useState(false);
            const [isCorrect, setIsCorrect] = useState(false);
            const [judging, setJudging] = useState(false);
            const [aiVerdictReason, setAiVerdictReason] = useState('');
            const [shuffledOptions, setShuffledOptions] = useState(null);

            // 追问 AI 相关状态（错题练习时把追问内容追加到错题本）
            const [showAsk, setShowAsk] = useState(false);
            const [askQuestion, setAskQuestion] = useState('');
            const [aiAnswer, setAiAnswer] = useState('');
            const [asking, setAsking] = useState(false);
            const [qaHistory, setQaHistory] = useState([]);
            const [followUpQuestion, setFollowUpQuestion] = useState('');
            const [followingUp, setFollowingUp] = useState(false);
            const [hasApi] = useState(() => !!(localStorage.getItem('deepseek_key') || '').trim());

            if (!practiceSession) return null;
            const { items, currentIndex } = practiceSession;
            const currentWrong = items[currentIndex];
            if (!currentWrong) return React.createElement("div", { style: { color: 'var(--text)' } }, "题目加载失败");

            // 若错题记录缺 options（早期版本漏存），尝试从源题库恢复，保证选择题可正常作答
            const recoveredOptions = currentWrong.options || (() => {
                if (currentWrong.sourceDeckId && currentWrong.questionId && Array.isArray(decks)) {
                    const dk = decks.find(d => d.id === currentWrong.sourceDeckId);
                    const q = dk && Array.isArray(dk.questions) ? dk.questions.find(x => x.id === currentWrong.questionId) : null;
                    return q ? (q.options || undefined) : undefined;
                }
                return undefined;
            })();
            const normType = normalizeQuestionType(currentWrong.type, Array.isArray(recoveredOptions) && recoveredOptions.length > 0);
            const question = {
                type: normType,
                question: currentWrong.question,
                options: normType === 'multiple_choice' || normType === 'multiple_select' ?
                    recoveredOptions : undefined,
                correctAnswer: currentWrong.correctAnswer,
                explanation: currentWrong.explanation,
                difficulty: currentWrong.difficulty || 1,
                score: typeof currentWrong.score === 'number' ? currentWrong.score : undefined,
                figure: currentWrong.figure || undefined,
                images: currentWrong.images || undefined,
                id: currentWrong.id
            };
            const qScore = typeof question.score === 'number' ? question.score : 0;

            useMemo(() => {
                if ((question.type === 'multiple_choice' || question.type === 'multiple_select') && question
                    .options) {
                    const opts = [...question.options];
                    for (let i = opts.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [opts[i], opts[j]] = [opts[j], opts[i]];
                    }
                    setShuffledOptions(opts);
                } else {
                    setShuffledOptions(null);
                }
            }, [currentWrong.id]);

            // 切换到另一道错题时，重置/载入该题已有的追问记录
            useEffect(() => {
                setShowAsk(false);
                setAskQuestion('');
                setFollowUpQuestion('');
                setAiAnswer(currentWrong.aiAnswer || '');
                setQaHistory(currentWrong.qaHistory || []);
                setAsking(false);
                setFollowingUp(false);
                setJudging(false);
                setAiVerdictReason('');
                setIsCorrect(false);
                setSubmitted(false);
            }, [currentWrong.id]);

            const handleSubmit = async () => {
                const isWrongKind = (practiceSession.kind || 'wrong') === 'wrong';
                let correct = false;
                let userAnswerText = '';
                if (question.type === 'multiple_select') {
                    const sel = Array.isArray(selected) ? selected : [];
                    if (sel.length === 0) return;
                    userAnswerText = sel.join('、');
                    const correctSet = Array.isArray(question.correctAnswer) ? question.correctAnswer : [];
                    correct = correctSet.length === sel.length && correctSet.every(a => sel.includes(a));
                } else {
                    if (selected === null || selected === undefined || selected === '') return;
                    userAnswerText = String(selected).trim();
                    const correctAns = String(question.correctAnswer).trim();
                    if (question.type === 'multiple_choice' || question.type === 'true_false') {
                        correct = userAnswerText === correctAns;
                    } else if (question.type === 'fill_blank' || question.type === 'essay') {
                        // 填空题 / 解答题：优先用 AI 判题（与答题模式一致）
                        if (hasApi) {
                            setJudging(true);
                            try {
                                const judge = question.type === 'fill_blank' ? judgeFillBlank : judgeEssay;
                                const result = await judge(question.question, userAnswerText, correctAns);
                                correct = !!result.isCorrect;
                                setAiVerdictReason(result.explanation || (correct ? '回答正确！' : '回答有误，请查看解析。'));
                                setIsCorrect(correct);
                                setSubmitted(true);
                                recordPracticeAnswer(currentIndex, correct, qScore);
                                if (isWrongKind) {
                                    updateWrongPractice(currentWrong.id, correct);
                                    if (!correct) appendWrongAnswer(currentWrong.id, userAnswerText);
                                }
                                return;
                            } catch (err) {
                                // AI 判题失败：回退到本地兜底判题，避免卡死
                                correct = question.type === 'fill_blank'
                                    ? lenientFillBlankMatch(userAnswerText, correctAns)
                                    : (userAnswerText.toLowerCase().includes(correctAns.toLowerCase()) ||
                                        correctAns.toLowerCase().includes(userAnswerText.toLowerCase()));
                                setAiVerdictReason('⚠️ AI 判题暂不可用（' + (err && err.message ? err.message : '网络/配置') +
                                    '），已按本地规则判定。');
                            } finally {
                                setJudging(false);
                            }
                        } else {
                            // 未配置 API：直接本地兜底判题（支持口语化答案，如「我觉得是8」）
                            correct = question.type === 'fill_blank'
                                ? lenientFillBlankMatch(userAnswerText, correctAns)
                                : (userAnswerText.toLowerCase().includes(correctAns.toLowerCase()) ||
                                    correctAns.toLowerCase().includes(userAnswerText.toLowerCase()));
                            setAiVerdictReason('（未配置 API Key，已按本地规则判定；配置后可启用 AI 判题）');
                        }
                    } else {
                        correct = userAnswerText === correctAns;
                    }
                }
                setIsCorrect(correct);
                setSubmitted(true);
                recordPracticeAnswer(currentIndex, correct, qScore);
                if (isWrongKind) {
                    updateWrongPractice(currentWrong.id, correct);
                    if (!correct) appendWrongAnswer(currentWrong.id, userAnswerText);  // 记录本次答错答案
                }
            };

            const handleAskAI = async (q) => {
                if (!q || !q.trim()) { alert('请输入你想追问的问题'); return; }
                setAsking(true);
                try {
                    const userAns = String(selected != null ? selected : '').trim();
                    const correctAns = String(question.correctAnswer).trim();
                    const explanation = question.explanation || '';
                    const response = await askAIForExplanation(question.question, userAns, correctAns, explanation,
                        q.trim());
                    const history = [...qaHistory, { q: q.trim(), a: response }];
                    setQaHistory(history);
                    setAiAnswer(response);
                    setAskQuestion('');
                    // 错题练习一定有当前错题 id，直接把追问追加到错题本
                    updateWrongAiAnswer(currentWrong.id, response, history);
                } catch (err) {
                    alert('追问失败：' + err.message);
                } finally {
                    setAsking(false);
                }
            };

            const handleFollowUp = async () => {
                if (!followUpQuestion.trim()) { alert('请输入你要继续追问的问题'); return; }
                setFollowingUp(true);
                try {
                    const userAns = String(selected != null ? selected : '').trim();
                    const correctAns = String(question.correctAnswer).trim();
                    const explanation = question.explanation || '';
                    const prevQa = [...qaHistory];
                    const lastA = prevQa.length ? prevQa[prevQa.length - 1].a : aiAnswer || '无';
                    const prompt =
                        `你是老师。学生之前问了问题，你已简要回答。现在学生继续追问。\n\n之前的回答：${lastA}\n\n学生的新问题：${followUpQuestion.trim()}\n\n要求：用 2-4 句话简要回答，直击要点，与上一条衔接，不要展开长文。`;
                    const answer = (await postChat('你是老师，回答简练、切中要害，节省 tokens。', prompt,
                        { temperature: 0.4, maxTokens: 300, timeoutMs: 60000 })) || '抱歉，我无法回答这个问题。';
                    const history = [...prevQa, { q: followUpQuestion.trim(), a: answer }];
                    setQaHistory(history);
                    setAiAnswer(answer);
                    setFollowUpQuestion('');
                    updateWrongAiAnswer(currentWrong.id, answer, history);
                } catch (err) {
                    alert('继续追问失败：' + err.message);
                } finally {
                    setFollowingUp(false);
                }
            };

            const handleNext = () => {
                if ((practiceSession.kind || 'wrong') === 'wrong') {
                    const updatedItem = wrongQuestions.find(w => w.id === currentWrong.id);
                    if (updatedItem && updatedItem.correctCount >= 3) {
                        if (confirm(`🎉 你已累计正确回答此题 3 次，是否从错题本中移除？`)) {
                            removeWrongQuestion(currentWrong.id);
                            alert('已从错题本移除！');
                        }
                    }
                }
                nextPractice();
            };

            const renderOptions = () => {
                if ((question.type === 'multiple_choice' || question.type === 'multiple_select') && shuffledOptions) {
                    const isMulti = question.type === 'multiple_select';
                    const sel = isMulti && Array.isArray(selected) ? selected : [];
                    const correctSet = isMulti && Array.isArray(question.correctAnswer) ? question.correctAnswer :
                        [];
                    return shuffledOptions.map((opt, idx) => {
                        const isSel = isMulti ? sel.includes(opt) : selected === opt;
                        const isCorrectOpt = isMulti ? correctSet.includes(opt) : opt === question.correctAnswer;
                        let cls = 'option-btn';
                        if (submitted) {
                            if (isCorrectOpt) cls += ' correct';
                            else if (isSel) cls += ' wrong';
                        } else if (isSel) cls += ' selected';
                        return React.createElement("button", { key: idx, type: "button", className: cls,
                            onClick: () => {
                                if (submitted) return;
                                if (isMulti) { setSelected(isSel ? sel.filter(x => x !== opt) : [...
                                        sel, opt
                                    ]); } else { setSelected(opt); }
                            }, disabled: submitted },
                            React.createElement("span", { style: { fontWeight: 600 } }, String.fromCharCode(
                                65 + idx), "."), " ",
                            React.createElement(LatexSpan, null, cleanOption(opt))
                        );
                    });
                } else if (question.type === 'true_false') {
                    const tf = ['正确', '错误'];
                    return tf.map(opt => {
                        let cls = 'option-btn';
                        if (submitted) {
                            if (opt === question.correctAnswer) cls += ' correct';
                            if (selected === opt && opt !== question.correctAnswer) cls += ' wrong';
                        } else if (selected === opt) cls += ' selected';
                        return React.createElement("button", { key: opt, className: cls, onClick: () => !submitted &&
                                setSelected(opt), disabled: submitted },
                            React.createElement(LatexSpan, null, opt)
                        );
                    });
                } else if (question.type === 'fill_blank') {
                    return React.createElement("div", { className: "answer-input-wrap" },
                        React.createElement(LatexField, { tag: "input", className: "input-field", placeholder: "输入答案...",
                            value: selected || '', onChange: e => !submitted && setSelected(e.target.value),
                            disabled: submitted }),
                        React.createElement(LatexAnswerPreview, { value: selected }));
                } else if (question.type === 'essay') {
                    return React.createElement("div", { className: "answer-input-wrap" },
                        React.createElement(LatexField, { tag: "textarea", rows: "5", className: "input-field", placeholder: "请输入你的解答...",
                            value: selected || '', onChange: e => !submitted && setSelected(e.target
                                .value), disabled: submitted }),
                        React.createElement(LatexAnswerPreview, { value: selected }));
                }
                return React.createElement("div", { className: "text-muted" }, "暂不支持此题型");
            };

            return React.createElement("div", { className: "card" },
                React.createElement("div", { className: "flex-between mb-4" },
                    React.createElement("span", { className: "text-muted" }, "错题练习 ", currentIndex + 1, " / ",
                        items.length),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 10,
                            flexWrap: 'wrap' } },
                        question.type === 'multiple_select' &&
                        React.createElement("span", { style: { background: '#9b59b6', color: '#fff',
                                fontSize: '0.8rem', fontWeight: 700, padding: '3px 10px',
                                borderRadius: '20px' } }, "📝 多选题（可多选）"),
                        React.createElement("span", { className: "text-muted" }, "难度: ", '⭐'.repeat(question
                            .difficulty || 1)),
                        qScore > 0 && React.createElement("span", { style: { background: '#e8f5ec', color: '#0f7a32',
                            fontSize: '0.8rem', fontWeight: 700, padding: '3px 10px', borderRadius: '20px' } },
                            "本题 " + qScore + " 分")
                    )
                ),
                React.createElement("h3", { className: "q-title" },
                    React.createElement(LatexSpan, null, question.question)
                ),
                React.createElement(QuestionImages, { images: question.images }),
                question.figure && React.createElement(GeomBoard, { spec: question.figure }),
                renderOptions(),
                judging && React.createElement("div", { className: "text-center mt-4", style: { padding: '10px' } },
                    React.createElement("div", { className: "spinner", style: { margin: '0 auto' } }),
                    React.createElement("p", { className: "text-muted" }, "AI 正在批改...")
                ),
                submitted && React.createElement("div", { className: `explanation-box ${isCorrect ? 'correct' :
                        'wrong'}` },
                    React.createElement("strong", null, isCorrect ? '✅ 正确！' : '❌ 错误'),
                    React.createElement("div", { className: "md-content", style: { marginTop: 6 } },
                        isCorrect ? '继续加油！' : "正确答案：",
                        React.createElement(LatexSpan, null, formatCorrectAnswer(question)),
                        question.explanation && React.createElement("div", { className: "md-content", style: { marginTop: 6 } }, "💡 ",
                            React.createElement(RichSpan, null, question.explanation)
                        )
                    ),
                    aiVerdictReason && React.createElement("div", { className: "md-content", style: { marginTop: 8, color: 'var(--text-muted)' } },
                        "🤖 AI 评语：", React.createElement(RichSpan, null, aiVerdictReason))
                ),
                (!submitted || isCorrect) ? null : hasApi && !showAsk &&
                React.createElement("div", { className: "mt-4" },
                    React.createElement("button", { className: "btn btn-ask", onClick: () => setShowAsk(true) },
                        "🤔 追问 AI（更新错题本）")
                ),
                showAsk && React.createElement("div", { className: "ask-box" },
                    React.createElement("div", { className: "flex-between" },
                        React.createElement("input", { type: "text", className: "input-field",
                            placeholder: "请输入你想追问的问题...", value: askQuestion, onChange: e =>
                                setAskQuestion(e.target.value), disabled: asking, style: { flex: 1,
                                marginRight: 8 } }),
                        React.createElement("button", { className: "btn btn-primary", onClick: () =>
                                handleAskAI(askQuestion), disabled: asking || !askQuestion.trim() },
                            asking ? '⏳' : '发送')
                    ),
                    asking && React.createElement("div", { className: "text-center mt-4", style: { padding: '10px' } },
                        React.createElement("div", { className: "spinner", style: { margin: '0 auto' } }),
                        React.createElement("p", { className: "text-muted" }, "AI 正在回答...")
                    ),
                    (qaHistory.length > 0 || aiAnswer) &&
                    React.createElement("div", { className: "explanation-box", style: { marginTop: 12,
                            borderLeftColor: '#f39c12' } },
                        React.createElement("strong", null, "🧠 AI 解答"),
                        (qaHistory.length > 0 ? qaHistory : [{ q: '', a: aiAnswer }]).map((pair, i) =>
                            React.createElement("div", { key: i, style: { marginTop: 10 } },
                                pair.q ? React.createElement("p", { style: { fontWeight: 600 } },
                                    React.createElement("span", { style: { color: '#3b82f6' } },
                                        "❓ 我："), pair.q
                                ) : null,
                                React.createElement("p", { style: { marginTop: 4,
                                        whiteSpace: 'pre-wrap' } },
                                    React.createElement("span", { style: { color: '#f39c12' } },
                                        "🤖 AI："), React.createElement(RichSpan, null, pair.a)
                                )
                            )
                        ),
                        React.createElement("div", { className: "mt-4" },
                            React.createElement("input", { type: "text", className: "input-field",
                                placeholder: "继续追问...", value: followUpQuestion, onChange: e =>
                                    setFollowUpQuestion(e.target.value), disabled: followingUp,
                                style: { marginBottom: 8 } }),
                            React.createElement("button", { className: "btn btn-ask", onClick: handleFollowUp,
                                disabled: followingUp || !followUpQuestion.trim() }, followingUp ?
                                '⏳ 追问中...' : '继续追问')
                        )
                    )
                ),
                React.createElement("div", { className: "flex-between mt-6 q-footer" },
                    React.createElement("button", { className: "btn btn-outline", onClick: () => { if (confirm(
                                '退出练习，确定吗？')) { setPracticeSession(null);
                            setMode(practiceSession.kind === 'favorite' ? 'favorites' : 'wrong'); } } },
                        "🏠 退出"),
                    !submitted ?
                    React.createElement("button", { className: "btn btn-primary", onClick: handleSubmit,
                        disabled: judging || (question.type === 'multiple_select' ? !(Array.isArray(selected) &&
                            selected.length) : selected === null || selected === '') }, judging ? '判题中...' :
                            '提交答案') :
                    React.createElement("button", { className: "btn btn-success", onClick: handleNext },
                        currentIndex + 1 < items.length ? '下一题 →' : '🎉 完成')
                )
            );
        };

        // ============================================================
        // 18. App 主组件
        // ============================================================
        // Steam 风格：不足 1 小时显示「分钟」，≥1 小时显示「X.X 小时」；内部仍以秒存储
        const formatLearnTime = (sec) => {
            sec = Math.floor(sec || 0);
            if (sec >= 3600) return (sec / 3600).toFixed(1) + ' 小时';
            const m = Math.floor(sec / 60);
            if (m > 0) return m + ' 分钟';
            return sec + ' 秒';
        };

        // 累计学习时间：独立上下文，避免每秒递增触发全局（stats）重渲染
        // 仅 TopBar 消费此上下文，故每秒只重渲染计时器本身，不影响侧边栏/题库列表等
        // 修复「凭空多出几十分钟」：
        //   1) active 必须同时有真实会话(session/practiceSession)，否则退出练习后 mode 仍为
        //      'practice' 但 practiceSession 已为 null，App 回退渲染首页却仍在计时。
        //   2) 仅当页面可见且窗口聚焦时才计时，切后台/其他窗口/最小化时暂停，
        //      避免把停留时间算成学习时长。
        const LearnTimeContext = createContext(0);
        // 按题库(deck)分别计时：每道正在做的题，其耗时累加到它所属题库的 timeSpent 上。
        //   - 单题库学习：session.deckId 即归属题库
        //   - 随机出题(learn 'random')：归属当前题的 sourceDeckId（getRandomPool 已给每题打标签）
        //   - 错题本/收藏夹练习：归属当前记录的 sourceDeckId
        // 总时间 = 所有 deck.timeSpent 之和；删除题库后自动从总和中移除。
        const LearnTimeProvider = ({ session, practiceSession, decks, setDecks, mode, children }) => {
            const [tick, setTick] = useState(0);
            const pendingRef = useRef({ deckId: null, sec: 0 });
            const prevDeckRef = useRef(null);
            const [engaged, setEngaged] = useState(() => !document.hidden && document.hasFocus());

            // 当前正在做的题所属题库（计时归属）
            const currentDeckId = useMemo(() => {
                if (session && session.deckId && session.deckId !== 'random') return session.deckId;
                let q = null;
                if (practiceSession) {
                    q = practiceSession.items[practiceSession.currentIndex];
                } else if (session && session.deckId === 'random') {
                    q = session.questions[session.questionIndex];
                }
                return (q && q.sourceDeckId) || null;
            }, [session, practiceSession]);

            // 计时仅在“当前可见的做题界面”运行时才进行：切到其它栏目(mode 不再是 learn/practice)立即暂停，
            // 不再依赖 session/practiceSession 是否被及时清空，杜绝切到错题本/收藏夹后计时仍在后台累加。
            const active = (mode === 'learn' && session && session.deckId) || (mode === 'practice' && practiceSession);

            // 把 pendingRef 中累计的秒提交到对应题库（找不到该题库则丢弃，避免无主时间凭空增加）
            const commit = useCallback(() => {
                const { deckId, sec } = pendingRef.current;
                if (sec > 0 && deckId) {
                    setDecks(prev => prev.map(d => d.id === deckId ? { ...d, timeSpent: (d.timeSpent || 0) + sec } : d));
                    pendingRef.current.sec = 0;
                }
                // 无归属（来源题库未知，如 AI 生成的收藏题）时：保留 pendingRef.sec，使其继续计入 total，
                // 待下一个有归属的提交时一并计入对应题库，避免凭空丢弃造成总时长偏少。
            }, [setDecks]);

            // 归属变化时：先把上一段累计秒提交到旧归属题库，再切换到新归属
            useEffect(() => {
                if (prevDeckRef.current !== currentDeckId) {
                    commit();
                    pendingRef.current.deckId = currentDeckId;
                    prevDeckRef.current = currentDeckId;
                }
            }, [currentDeckId, commit]);

            useEffect(() => {
                const sync = () => setEngaged(!document.hidden && document.hasFocus());
                document.addEventListener('visibilitychange', sync);
                window.addEventListener('focus', sync);
                window.addEventListener('blur', sync);
                return () => {
                    document.removeEventListener('visibilitychange', sync);
                    window.removeEventListener('focus', sync);
                    window.removeEventListener('blur', sync);
                };
            }, []);

            // 每秒累加（仅 pendingRef，不触发重渲染），并用 tick 驱动 TopBar 实时显示
            useEffect(() => {
                if (!active || !engaged) return;
                const t = setInterval(() => { pendingRef.current.sec += 1; setTick(x => x + 1); }, 1000);
                return () => { clearInterval(t); commit(); };
            }, [active, engaged, commit]);

            // 每 5 秒把累计秒落盘到对应题库（节流，避免每秒写 deck 触发列表重渲染）
            useEffect(() => {
                if (!active || !engaged) return;
                const f = setInterval(() => commit(), 5000);
                return () => clearInterval(f);
            }, [active, engaged, commit]);

            const decksTotal = useMemo(() => decks.reduce((s, d) => s + (d.timeSpent || 0), 0), [decks]);
            const total = decksTotal + (pendingRef.current.sec || 0);
            return React.createElement(LearnTimeContext.Provider, { value: total }, children);
        };

        // 顶部栏：右上角展示累计学习时间
        const TopBar = ({ onImmersive }) => {
            const sec = useContext(LearnTimeContext);
            return React.createElement("div", { className: "topbar" },
                React.createElement("div", { className: "topbar-right" },
                    onImmersive ? React.createElement("button", {
                        className: "immersive-btn",
                        title: "沉浸模式 · 点击全屏专注（Esc 退出）",
                        onClick: onImmersive
                    },
                        FullscreenIcon(false),
                        React.createElement("span", null, "沉浸")
                    ) : null,
                    React.createElement("span", { className: "header-item time-item", title: "累计学习时间" },
                        React.createElement("svg", { className: "time-icon", viewBox: "0 0 24 24", width: "14",
                            height: "14", fill: "none", stroke: "currentColor", strokeWidth: "2",
                            strokeLinecap: "round", strokeLinejoin: "round" },
                            React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
                            React.createElement("path", { d: "M12 7v5l3 2" })
                        ),
                        " ", formatLearnTime(sec))
                )
            );
        };


        // ============================================================
        // 19. 草稿纸（ScratchPad）：与几何画板「草稿笔」共用同一底层渲染引擎
        //     —— SVG 渲染 + view{scale,yscale,xZero,yZero} + geomZoomAt/geomPanFrom
        //        + buildFigureEls 自适应网格 + non-scaling-stroke 笔迹。
        //     笔画以「数据坐标」存储（与几何图同一套坐标系），随平移/缩放一起对齐；
        //     支持鼠标涂画与数位板(压感)；首页与「我的」不显示。
        //     模块级草稿纸数据：跨组件卸载/重挂保留，刷新页面才清空。
        let __scratchStrokes = [];
        let __scratchView = null;     // {scale,yscale,xZero,yZero} | null（首次打开用 fit）

        const ScratchPad = React.memo(() => {
            const { mode } = useUi();
            const showScratch = mode === 'learn' || mode === 'practice';

            // 与几何画板一致的「空白画布」默认视图：原点居中，1 数据单位 = 1 SVG 单位
            const fit = React.useMemo(() => ({ scale: 1, yscale: 1, xZero: FIG_VBW / 2, yZero: FIG_VBH / 2 }), []);

            const [open, setOpen] = React.useState(false);
            const [fs, setFs] = React.useState(false);
            const fsRef = React.useRef(false); fsRef.current = fs;
            const panelRef = React.useRef(null);
            const [tool, setTool] = React.useState('pen');        // 'pen' | 'eraser' | 'hand'
            const [color, setColor] = React.useState('#ffd54f');
            const [width, setWidth] = React.useState(4);
            const [device, setDevice] = React.useState('');
            const [strokes, setStrokes] = React.useState(__scratchStrokes.slice());
            const [draftStroke, setDraftStroke] = React.useState(null);
            const [view, setView] = React.useState(__scratchView || fit);
            const [grabbing, setGrabbing] = React.useState(false);

            // 草稿笔画持久化到模块级变量（跨模式切换保留，刷新页面清空）
            React.useEffect(() => { __scratchStrokes = strokes; }, [strokes]);
            React.useEffect(() => { __scratchView = view; }, [view]);

            const svgRef = React.useRef(null);
            const dragRef = React.useRef(null);
            const pointersRef = React.useRef(new Map());
            const spaceRef = React.useRef(false);
            const colorRef = React.useRef(color); const widthRef = React.useRef(width); const toolRef = React.useRef(tool);
            colorRef.current = color; widthRef.current = width; toolRef.current = tool;

            const E = React.createElement;

            // 屏幕坐标 → SVG 用户坐标（与几何画板一致：getScreenCTM 逆变换）
            const toUser = (e) => {
                const svg = svgRef.current; if (!svg) return null;
                const ctm = svg.getScreenCTM(); if (!ctm) return null;
                const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
                const u = pt.matrixTransform(ctm.inverse());
                return { x: u.x, y: u.y, thr: 9 / (ctm.a || 1) };
            };
            // SVG 用户坐标 → 数据坐标（与几何画板草稿笔同一套坐标系）
            const toData = (u) => ({ x: (u.x - view.xZero) / view.scale, y: (view.yZero - u.y) / view.scale });
            const distToSeg2D = (px, py, a, b) => {
                const vx = b[0] - a[0], vy = b[1] - a[1];
                const L2 = vx * vx + vy * vy;
                if (L2 < 1e-12) return Math.hypot(px - a[0], py - a[1]);
                let t = ((px - a[0]) * vx + (py - a[1]) * vy) / L2; t = Math.max(0, Math.min(1, t));
                return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
            };
            // 压感笔宽：数位笔按真实 pressure 变化（与几何画板草稿笔一致）；鼠标/触摸取基准值
            const penWidthAt = (e) => {
                const p = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
                return Math.max(0.5, widthRef.current * (0.45 + p * 1.1));
            };
            // 橡皮：就近整条删除命中的草稿笔迹（与几何画板一致）
            const eraseAt = (dx, dy) => {
                const thr = 12 / view.scale;
                let bestI = -1, bestD = thr;
                for (let i = 0; i < strokes.length; i++) {
                    const pts = strokes[i].pts;
                    for (let j = 1; j < pts.length; j++) {
                        const d = distToSeg2D(dx, dy, pts[j - 1], pts[j]);
                        if (d < bestD) { bestD = d; bestI = i; }
                    }
                }
                if (bestI >= 0) { setStrokes(prev => prev.filter((_, i) => i !== bestI)); return true; }
                return false;
            };

            const startDrag = (e) => {
                if (e.button != null && e.button !== 0 && e.button !== 1) return; // 仅主键 / 中键
                e.preventDefault();
                const pm = pointersRef.current;
                pm.set(e.pointerId, { x: e.clientX, y: e.clientY });
                try { svgRef.current.setPointerCapture(e.pointerId); } catch (_) {}
                const isPan = toolRef.current === 'hand' || e.button === 1 || (e.button === 0 && spaceRef.current);
                if (isPan) {
                    dragRef.current = { mode: 'pan', x: e.clientX, y: e.clientY, v: view, sx: e.clientX, sy: e.clientY };
                    setGrabbing(true);
                    return;
                }
                if (e.pointerType === 'pen') setDevice('数位笔');
                else if (e.pointerType === 'touch') setDevice('触摸');
                else setDevice('鼠标');
                const u = toUser(e); if (!u) return;
                const d = toData(u);
                if (toolRef.current === 'eraser') {
                    eraseAt(d.x, d.y);
                    dragRef.current = { mode: 'erase' };
                    setGrabbing(true);
                    return;
                }
                const w0 = penWidthAt(e);
                dragRef.current = { mode: 'pen', pts: [[d.x, d.y, w0]], moved: false, sx: e.clientX, sy: e.clientY };
                setDraftStroke({ pts: [[d.x, d.y, w0]], color: colorRef.current, width: widthRef.current });
                setGrabbing(true);
            };
            const moveDrag = (e) => {
                const d = dragRef.current; const pm = pointersRef.current;
                if (pm.has(e.pointerId)) pm.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (!d) return;
                if (d.mode === 'pen') {
                    e.preventDefault();
                    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e]; // 合并高频采样，避免断笔
                    for (let k = 0; k < evs.length; k++) {
                        const ce = evs[k];
                        const u = toUser(ce); if (!u) continue;
                        const p = toData(u);
                        d.pts.push([p.x, p.y, penWidthAt(ce)]);
                        if (Math.abs(ce.clientX - d.sx) + Math.abs(ce.clientY - d.sy) > 3) d.moved = true;
                    }
                    if (evs.length) setDraftStroke({ pts: d.pts.slice(), color: colorRef.current, width: widthRef.current });
                    return;
                }
                if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
                if (d.mode === 'erase') {
                    e.preventDefault();
                    const u = toUser(e); if (!u) return;
                    const p = toData(u);
                    eraseAt(p.x, p.y);
                    return;
                }
                if (d.mode === 'pan') {
                    e.preventDefault();
                    const rect = svgRef.current.getBoundingClientRect();
                    setView(geomPanFrom(d.v, e.clientX - d.x, e.clientY - d.y, rect.width, rect.height));
                    return;
                }
            };
            const endDrag = (e) => {
                const pm = pointersRef.current; pm.delete(e.pointerId);
                try { svgRef.current.releasePointerCapture(e.pointerId); } catch (_) {}
                const d = dragRef.current;
                if (d && d.mode === 'pen') {
                    // 提交：移动过或含多个采样点才保留；纯点击(未移动)不落点，避免误画
                    const keep = d.moved || d.pts.length >= 2;
                    if (keep) setStrokes(prev => [...prev, { pts: d.pts.slice(), color: colorRef.current, width: widthRef.current }]);
                    setDraftStroke(null);
                }
                if (pm.size === 0) { dragRef.current = null; setGrabbing(false); }
            };

            const zoomAt = (f) => setView(v => geomZoomAt(v, fit, 0.5, 0.5, f));
            const resetView = () => setView(fit);
            // 适应内容：计算所有笔画包围盒并缩放居中（产出与几何画板同构的 view）
            const fitStrokes = () => {
                if (!strokes.length) { setView(fit); return; }
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const s of strokes) for (const p of s.pts) {
                    if (p[0] < minX) minX = p[0]; if (p[1] < minY) minY = p[1];
                    if (p[0] > maxX) maxX = p[0]; if (p[1] > maxY) maxY = p[1];
                }
                const pad = 40;
                const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
                let scale = Math.min((FIG_VBW - 2 * pad) / bw, (FIG_VBH - 2 * pad) / bh);
                scale = Math.max(fit.scale * 0.08, Math.min(fit.scale * 60, scale));
                const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
                setView({ scale, yscale: scale, xZero: FIG_VBW / 2 - cx * scale, yZero: FIG_VBH / 2 + cy * scale });
            };
            const clearBoard = () => { setStrokes([]); setDraftStroke(null); };

            // 全屏切换（与原草稿纸一致：优先原生全屏，否则 CSS 铺满）
            const toggleFs = () => {
                if (fsRef.current) {
                    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
                    else setFs(false);
                } else {
                    const el = panelRef.current;
                    let native = false;
                    if (el && el.requestFullscreen) {
                        try {
                            const p = el.requestFullscreen();
                            if (p && p.then) { p.then(() => {}).catch(() => setFs(true)); native = true; }
                        } catch (_) {}
                    }
                    if (!native) setFs(true);
                }
            };

            // 打开时挂载滚轮缩放 / 空格平移 / 键盘；SVG 自适应，无需尺寸重适配
            React.useEffect(() => {
                if (!open) return;
                const svg = svgRef.current; if (!svg) return;
                const onWheel = (e) => {
                    e.preventDefault();
                    const rect = svg.getBoundingClientRect();
                    const rx = (e.clientX - rect.left) / rect.width;
                    const ry = (e.clientY - rect.top) / rect.height;
                    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; // 直觉：滚轮上 = 放大
                    setView(v => geomZoomAt(v, fit, rx, ry, f));
                };
                svg.addEventListener('wheel', onWheel, { passive: false });
                const onKeyDown = (e) => {
                    if (e.code === 'Space' && !/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) {
                        spaceRef.current = true;
                        if (svg) svg.style.cursor = 'grab';
                        e.preventDefault();
                    }
                };
                const onKeyUp = (e) => {
                    if (e.code === 'Space') {
                        spaceRef.current = false;
                        if (svg) svg.style.cursor = toolRef.current === 'hand' ? 'grab' : (toolRef.current === 'eraser' ? 'cell' : 'crosshair');
                    }
                };
                window.addEventListener('keydown', onKeyDown);
                window.addEventListener('keyup', onKeyUp);
                return () => {
                    svg.removeEventListener('wheel', onWheel);
                    window.removeEventListener('keydown', onKeyDown);
                    window.removeEventListener('keyup', onKeyUp);
                };
            }, [open, fit]);

            // 全屏状态与浏览器原生全屏事件同步
            React.useEffect(() => {
                const onFsChange = () => setFs(!!document.fullscreenElement);
                document.addEventListener('fullscreenchange', onFsChange);
                return () => document.removeEventListener('fullscreenchange', onFsChange);
            }, []);

            if (!showScratch) return null;

            // —— 渲染：自适应网格（复用几何画板 buildFigureEls）+ 草稿笔迹（non-scaling-stroke） ——
            const gridEls = buildFigureEls({ items: [] }, view, -1, false, true)
                .map((el, i) => React.cloneElement(el, { key: 'g' + i }));
            const strokeEls = [];
            const buildPathD = (pts) => {
                if (!pts || !pts.length) return '';
                let dd = '';
                for (let i = 0; i < pts.length; i++) {
                    const sx = view.xZero + pts[i][0] * view.scale;
                    const sy = view.yZero - pts[i][1] * view.scale;
                    dd += (i === 0 ? 'M' : 'L') + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' ';
                }
                return dd.trim();
            };
            const pushStroke = (S) => {
                if (!S || !S.pts || !S.pts.length) return;
                const hasW = S.pts[0] && S.pts[0].length >= 3;
                if (S.pts.length === 1) {
                    const sx = view.xZero + S.pts[0][0] * view.scale;
                    const sy = view.yZero - S.pts[0][1] * view.scale;
                    const r = Math.max(0.5, (hasW ? S.pts[0][2] : S.width) / 2);
                    strokeEls.push(E('circle', { cx: sx, cy: sy, r, fill: S.color, className: 'fig-aux', pointerEvents: 'none' }));
                    return;
                }
                if (!hasW) {
                    strokeEls.push(E('path', { d: buildPathD(S.pts), stroke: S.color, strokeWidth: S.width, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke', className: 'fig-aux', pointerEvents: 'none' }));
                    return;
                }
                // 压感：逐段渲染，宽度取相邻两点均值，圆头叠加保证连续（与几何画板草稿笔一致）
                for (let i = 1; i < S.pts.length; i++) {
                    const a = S.pts[i - 1], b = S.pts[i];
                    const ax = view.xZero + a[0] * view.scale, ay = view.yZero - a[1] * view.scale;
                    const bx = view.xZero + b[0] * view.scale, by = view.yZero - b[1] * view.scale;
                    const w = Math.max(0.5, ((a[2] != null ? a[2] : S.width) + (b[2] != null ? b[2] : S.width)) / 2);
                    strokeEls.push(E('path', { d: 'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) + ' L' + bx.toFixed(2) + ' ' + by.toFixed(2), stroke: S.color, strokeWidth: w, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke', className: 'fig-aux', pointerEvents: 'none' }));
                }
            };
            strokes.forEach(pushStroke);
            if (draftStroke) pushStroke(draftStroke);

            const pct = Math.round(fit.scale / view.scale * 100);
            const cursor = grabbing ? 'grabbing'
                : tool === 'pen' ? 'crosshair'
                : tool === 'eraser' ? 'cell' : 'grab';

            return E('div', { className: 'scratch-root' + (fs ? ' scratch-full' : '') },
                !open && E('button', {
                    className: 'scratch-fab', title: '草稿纸（无限画布 · 支持鼠标 / 数位板）',
                    onClick: () => setOpen(true)
                }, '📝 草稿纸'),
                open && E('div', { ref: panelRef, className: 'scratch-panel' },
                    E('div', { className: 'scratch-head' },
                        E('span', { className: 'scratch-title' }, '📝 草稿纸'),
                        E('span', { className: 'scratch-device' }, (device ? '✎ ' + device : '✎ 待落笔') + ' · ' + pct + '%'),
                        E('button', { className: 'scratch-fullscreen', title: fs ? '退出全屏 (Esc)' : '全屏',
                            onClick: toggleFs }, fs ? '🗗' : '⛶'),
                        E('button', { className: 'scratch-close', title: '收起（保留涂画）',
                            onClick: () => setOpen(false) }, '▾')
                    ),
                    E('div', { className: 'scratch-tools' },
                        E('button', { className: 'sp-tool' + (tool === 'pen' ? ' active' : ''), onClick: () => setTool('pen') }, '✏️ 笔'),
                        E('button', { className: 'sp-tool' + (tool === 'eraser' ? ' active' : ''), onClick: () => setTool('eraser') }, '🧽 橡皮'),
                        E('button', { className: 'sp-tool' + (tool === 'hand' ? ' active' : ''), onClick: () => setTool('hand') }, '✋ 平移'),
                        E('div', { className: 'sp-colors' },
                            ['#ffd54f', '#ff6b6b', '#5ad1a5', '#6d8bff', '#ffffff', '#1f2733']
                                .map(c => E('button', {
                                    key: c,
                                    className: 'sp-color' + (tool !== 'eraser' && color === c ? ' active' : ''),
                                    style: { background: c }, title: c,
                                    onClick: () => { setColor(c); setTool('pen'); }
                                }))
                        ),
                        E('div', { className: 'sp-size' },
                            E('span', null, '粗细'),
                            E('input', { type: 'range', min: '1', max: '28', value: String(width),
                                onChange: e => setWidth(Number(e.target.value)) }),
                            E('span', { className: 'sp-size-val' }, String(width))
                        ),
                        E('div', { className: 'sp-zoom' },
                            E('button', { className: 'sp-zoombtn', title: '缩小', onClick: () => zoomAt(1 / 1.2) }, '−'),
                            E('button', { className: 'sp-zoombtn', title: '重置视图 (100%)', onClick: resetView }, String(pct) + '%'),
                            E('button', { className: 'sp-zoombtn', title: '放大', onClick: () => zoomAt(1.2) }, '+'),
                            E('button', { className: 'sp-zoombtn', title: '适应内容', onClick: fitStrokes }, '⤢')
                        ),
                        E('button', { className: 'sp-clear', onClick: clearBoard }, '🗑 清空')
                    ),
                    E('svg', {
                        ref: svgRef,
                        viewBox: '-18 -18 ' + (FIG_VBW + 36) + ' ' + (FIG_VBH + 36),
                        preserveAspectRatio: 'xMidYMid meet',
                        className: 'scratch-canvas',
                        style: { cursor },
                        onPointerDown: startDrag,
                        onPointerMove: moveDrag,
                        onPointerUp: endDrag,
                        onPointerCancel: endDrag,
                        onPointerLeave: endDrag,
                        onDoubleClick: (e) => { e.preventDefault(); setView(fit); }
                    }, gridEls.concat(strokeEls))
                )
            );
        });

        // ============================================================
        // 20. AI 生成的几何图 GeomBoard：根据极简 JSON 规范渲染函数图 / 平面几何图（纯 2D，立体几何以伪 3D 方式绘制）
        //     该规范同时作为「AI 出题接口」注入 AIGenerator（见下方 prompt）。
        // ============================================================
        const FIG_VBW = 640, FIG_VBH = 400;   // SVG 虚拟像素空间（固定 1.6 纵横比，保证圆形不被压扁）

        // —— 安全数学表达式求值（递归下降，不用 new Function，杜绝注入）——
        const FIG_FUNCS = {
            sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
            atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
            sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, log: Math.log, ln: Math.log,
            log10: Math.log10, log2: Math.log2, abs: Math.abs, sign: Math.sign, floor: Math.floor,
            ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => a % b
        };
        const FIG_CONST = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
        function figMathEval(expr, vars) {
            vars = vars || {};
            const s = String(expr);
            let i = 0;
            const isDig = c => c >= '0' && c <= '9';
            const isAl = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
            function tokenize() {
                const out = [];
                while (i < s.length) {
                    const c = s[i];
                    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
                    if (isDig(c) || (c === '.' && isDig(s[i + 1]))) {
                        let j = i + 1;
                        while (j < s.length && (isDig(s[j]) || s[j] === '.')) j++;
                        out.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
                    }
                    if (isAl(c)) {
                        let j = i + 1;
                        while (j < s.length && (isAl(s[j]) || isDig(s[j]))) j++;
                        out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
                    }
                    if ('+-*/^(),'.indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
                    i++;
                }
                return out;
            }
            const tk = tokenize();
            let p = 0;
            const peek = () => tk[p];
            const nxt = () => tk[p++];
            function exprP() {
                let l = termP();
                while (peek() && (peek().t === '+' || peek().t === '-')) {
                    const op = nxt().t; const r = termP();
                    l = op === '+' ? l + r : l - r;
                }
                return l;
            }
            function termP() {
                let l = factorP();
                for (;;) {
                    const q = peek();
                    if (!q) break;
                    if (q.t === '*' || q.t === '/') {
                        nxt(); const r = factorP();
                        l = q.t === '*' ? l * r : l / r;
                    } else if (q.t === 'num' || q.t === 'id' || q.t === '(') {
                        const r = factorP(); l = l * r;   // 隐式乘法：2x、2(x+1)、3sin(x)
                    } else break;
                }
                return l;
            }
            function factorP() {
                let b = unaryP();
                if (peek() && peek().t === '^') { nxt(); const e = factorP(); b = Math.pow(b, e); }
                return b;
            }
            function unaryP() {
                const q = peek();
                if (q && q.t === '+') { nxt(); return unaryP(); }
                if (q && q.t === '-') { nxt(); return -unaryP(); }
                return primaryP();
            }
            function primaryP() {
                const q = nxt();
                if (!q) return 0;
                if (q.t === 'num') return q.v;
                if (q.t === '(') {
                    const v = exprP();
                    if (peek() && peek().t === ')') nxt();
                    return v;
                }
                if (q.t === 'id') {
                    const name = q.v;
                    const fn = FIG_FUNCS[name];
                    if (fn) {
                        if (peek() && peek().t === '(') {
                            nxt();
                            const args = [];
                            if (peek() && peek().t !== ')') {
                                args.push(exprP());
                                while (peek() && peek().t === ',') { nxt(); args.push(exprP()); }
                            }
                            if (peek() && peek().t === ')') nxt();
                            if (args.length === 1) return fn(args[0]);
                            if (name === 'atan2' || name === 'mod' || name === 'pow') return fn(args[0], args[1]);
                            return fn.apply(null, args);
                        }
                        // 无括号函数调用（自然数学记法）：sin x / cos a / sqrt 2 等
                        const arg = unaryP();
                        return fn(arg);
                    }
                    if (name in FIG_CONST) return FIG_CONST[name];
                    const vv = vars[name];
                    return (typeof vv === 'number' && isFinite(vv)) ? vv : 0;
                }
                return 0;
            }
            try {
                const r = exprP();
                return (typeof r === 'number' && isFinite(r)) ? r : NaN;
            } catch (e) { return NaN; }
        }

        function figNiceStep(range, target) {
            const raw = range / target;
            const exp = Math.floor(Math.log10(raw));
            const base = Math.pow(10, exp);
            for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= raw) return m * base;
            return 10 * base;
        }

        // GeoGebra 式视图：scale = 每数据单位的像素数（x、y 同值，圆不变形）；xZero/yZero = 数据原点在 640×400 虚拟空间中的像素位置。
        // screenX = xZero + dataX*scale ；screenY = yZero - dataY*scale
        // GeoGebra 式视图：scale = 每数据单位的像素数（x、y 默认同值，圆不变形）；xZero/yZero = 数据原点在虚拟空间中的像素位置。
        // screenX = xZero + dataX*scale ；screenY = yZero - dataY*yscale （yscale 仅在不等比例时与 scale 不同）
        // 若 spec.view 显式给出（来自 .ggb 的 euclidianView），直接采用 GeoGebra 的精确视口，并按本画布比例统一缩放，保持圆不变形、比例一致。
        function geomFit(spec) {
            const cx0 = FIG_VBW / 2, cy0 = FIG_VBH / 2;
            if (spec.view && isFinite(spec.view.scale) && spec.view.scale > 0) {
                const v = spec.view;
                const gw = v.gw || FIG_VBW, gh = v.gh || FIG_VBH;
                const k = Math.min(FIG_VBW / gw, FIG_VBH / gh);
                const yscale = (v.yscale && isFinite(v.yscale) && v.yscale > 0) ? v.yscale : v.scale;
                return { scale: v.scale * k, yscale: yscale * k, xZero: v.xZero * k, yZero: v.yZero * k };
            }
            if (spec.v && spec.v.length === 4) {
                let [x0, x1, y0, y1] = spec.v;
                if (!(x1 > x0)) x1 = x0 + 1;
                if (!(y1 > y0)) y1 = y0 + 1;
                // 单一 scale 保证圆不畸变；取 x、y 两方向可容纳的最小值，使整个视口都可见（居中包围盒）。
                const scale = Math.min(FIG_VBW / (x1 - x0), FIG_VBH / (y1 - y0));
                const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
                return { scale, yscale: scale, xZero: cx0 - cx * scale, yZero: cy0 + cy * scale };
            }
            const pts = [];
            const add = p => { if (Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])) pts.push(p); };
            for (const it of (spec.items || [])) {
                if (it.t === 'pt' || it.t === 'txt') add(it.p);
                else if (it.t === 'seg' || it.t === 'ray' || it.t === 'ln' || it.t === 'vec') { add(it.a); add(it.b); }
                else if (it.t === 'pol') (it.p || []).forEach(add);
                else if (it.t === 'cir' || it.t === 'arc') { const r = Math.abs(it.r || 0); add([it.o[0] - r, it.o[1] - r]); add([it.o[0] + r, it.o[1] + r]); }
                else if (it.t === 'ang') { add(it.a); add(it.b); add(it.c); }
                else if (it.t === 'mid' || it.t === 'inter' || it.t === 'onseg' || it.t === 'onln') { if (it.p) add(it.p); }
            }
            if (!pts.length) return { scale: 40, yscale: 40, xZero: cx0, yZero: cy0 }; // 原点居中，约 ±8 范围
            let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
            for (const q of pts) { if (q[0] < xmin) xmin = q[0]; if (q[0] > xmax) xmax = q[0]; if (q[1] < ymin) ymin = q[1]; if (q[1] > ymax) ymax = q[1]; }
            const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
            const R = Math.max((xmax - xmin) / 2, (ymax - ymin) / 2, 1);
            const scale = Math.min(FIG_VBW, FIG_VBH) * 0.42 / (R * 1.18);
            // 若原点(0,0)落在内容包围盒内（含边界），则把视图中心对准原点，呈 GeoGebra 式「原点居中」；
            // 否则居中内容包围盒，保证完整性。
            let ocx = cx, ocy = cy;
            const inX = (0 >= xmin - 1e-9 && 0 <= xmax + 1e-9), inY = (0 >= ymin - 1e-9 && 0 <= ymax + 1e-9);
            if (inX && inY) { ocx = 0; ocy = 0; }
            else if (inX) { ocx = 0; }
            else if (inY) { ocy = 0; }
            return { scale, yscale: scale, xZero: cx0 - ocx * scale, yZero: cy0 + ocy * scale };
        }
        function geomResolve(s) {
            const items = s.items || [];
            const pts = new Map(), byLabel = new Map();
            const coordOf = r => (typeof r === 'string') ? pts.get(r) : (Array.isArray(r) ? r : null);
            const linePts = it => { const A = coordOf(it.a), B = coordOf(it.b); return (A && B) ? [A, B] : null; };
            for (const it of items) {
                if (it.l) byLabel.set(it.l, it);
                if (it.t === 'pt' && it.l && Array.isArray(it.p)) pts.set(it.l, [it.p[0], it.p[1]]);
            }
            const inter = (L1, L2) => {
                if (!L1 || !L2) return null;
                const isLine = it => it && (it.t === 'seg' || it.t === 'ln' || it.t === 'ray');
                const lineOf = it => { const p = linePts(it); return p ? { A: p[0], B: p[1] } : null; };
                const cirOf = it => { const O = coordOf(it.o); const r = Math.abs(it.r || 0); return (O && isFinite(r)) ? { O, r } : null; };
                let a = null, b = null;
                if (isLine(L1)) a = lineOf(L1); else if (L1.t === 'cir' || L1.t === 'arc') a = cirOf(L1); else return null;
                if (isLine(L2)) b = lineOf(L2); else if (L2.t === 'cir' || L2.t === 'arc') b = cirOf(L2); else return null;
                if (a.A && b.A) { // 线-线
                    const A = a.A, B = a.B, C = b.A, D = b.B;
                    const dx = B[0] - A[0], dy = B[1] - A[1], ex = D[0] - C[0], ey = D[1] - C[1];
                    const den = dx * ey - dy * ex; if (Math.abs(den) < 1e-12) return null;
                    const t = ((C[0] - A[0]) * ey - (C[1] - A[1]) * ex) / den;
                    return [[A[0] + t * dx, A[1] + t * dy]];
                }
                let line = null, cir = null;
                if (a.A && b.r !== undefined) { line = a; cir = b; }
                else if (b.A && a.r !== undefined) { line = b; cir = a; }
                if (line && cir) { // 线-圆
                    const A = line.A, B = line.B, O = cir.O, r = cir.r;
                    const dx = B[0] - A[0], dy = B[1] - A[1]; const len = Math.hypot(dx, dy) || 1;
                    const fx = dx / len, fy = dy / len;
                    const t = (O[0] - A[0]) * fx + (O[1] - A[1]) * fy;
                    const h2 = r * r - ((O[0] - A[0]) * (O[0] - A[0]) + (O[1] - A[1]) * (O[1] - A[1]) - t * t);
                    if (h2 < 0) return null; const h = Math.sqrt(h2);
                    return [[A[0] + (t - h) * fx, A[1] + (t - h) * fy], [A[0] + (t + h) * fx, A[1] + (t + h) * fy]];
                }
                if (a.r !== undefined && b.r !== undefined) { // 圆-圆
                    const O1 = a.O, O2 = b.O, r1 = a.r, r2 = b.r;
                    const d = Math.hypot(O2[0] - O1[0], O2[1] - O1[1]);
                    if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return null;
                    const x = (d * d - r2 * r2 + r1 * r1) / (2 * d); const y = Math.sqrt(Math.max(0, r1 * r1 - x * x));
                    const ux = (O2[0] - O1[0]) / d, uy = (O2[1] - O1[1]) / d;
                    const bx = O1[0] + x * ux, by = O1[1] + x * uy;
                    return [[bx - uy * y, by + ux * y], [bx + uy * y, by - ux * y]];
                }
                return null;
            };
            let guard = 0, prog = true;
            while (prog && guard++ < 80) {
                prog = false;
                for (const it of items) {
                    if (it.t === 'mid' && it.l && !pts.has(it.l)) {
                        const a = pts.get(it.a), b = pts.get(it.b);
                        if (a && b) { pts.set(it.l, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); prog = true; }
                    } else if ((it.t === 'onseg' || it.t === 'onln') && it.l && !pts.has(it.l)) {
                        const line = byLabel.get(it.line);
                        if (line) { const pp = linePts(line); if (pp) { const u = (it.u != null) ? (typeof it.u === 'string' ? figMathEval(it.u) : it.u) : 0.5; pts.set(it.l, [pp[0][0] + u * (pp[1][0] - pp[0][0]), pp[0][1] + u * (pp[1][1] - pp[0][1])]); prog = true; } }
                    } else if (it.t === 'inter' && it.l && !pts.has(it.l)) {
                        const r = inter(byLabel.get(it.a), byLabel.get(it.b));
                        if (r && r[0]) { pts.set(it.l, r[0]); prog = true; }
                    }
                }
            }
            return { pts, byLabel, coordOf, linePts };
        }

        // 以屏幕比例 (rx,ry)∈[0,1] 为中心缩放（保持圆不变形：x、y 同比例）
        // 以屏幕比例 (rx,ry)∈[0,1] 为中心缩放（x、y 同比例，保持圆不变形）
        function geomZoomAt(v, fit, rx, ry, f) {
            if (!v) return v;
            const fitS = fit ? fit.scale : 40;
            const newS = Math.max(fitS * 0.08, Math.min(fitS * 60, v.scale * f));
            const k = newS / v.scale;
            const newYS = (v.yscale || v.scale) * k;
            const px = rx * FIG_VBW, py = ry * FIG_VBH;
            const dataX = (px - v.xZero) / v.scale;
            const dataY = (v.yZero - py) / (v.yscale || v.scale);
            return { scale: newS, yscale: newYS, xZero: px - dataX * newS, yZero: py + dataY * newYS };
        }
        // 按像素位移平移（x、y 同比例位移，不改变缩放）
        function geomPanFrom(v, dxPix, dyPix, rectW, rectH) {
            if (!v || !rectW || !rectH) return v;
            const ux = dxPix * (FIG_VBW / rectW), uy = dyPix * (FIG_VBH / rectH);
            return { scale: v.scale, yscale: v.yscale || v.scale, xZero: v.xZero + ux, yZero: v.yZero + uy };
        }
                // ===== GeoGebra 文件支持：.ggb(=ZIP 内含 geogebra.xml) / .geogebra(=XML) → figure =====
        // 解析策略：优先用 <command> 的依赖输入拿到端点/圆心/顶点（最可靠），
        // 点坐标取 <element type="point"><coords x y z/></element>（z 为齐次，用 x/z,y/z）。
        // 纯 JS 的 raw-DEFLATE 解压（RFC 1951），用于不支持 DecompressionStream 的浏览器/环境解压 .ggb
        function inflateRaw(input) {
            const bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input);
            const out = [];
            let ip = 0, bitBuf = 0, bitCnt = 0;
            function readBits(n) {
                while (bitCnt < n) { bitBuf |= (bytes[ip++] << bitCnt); bitCnt += 8; }
                const v = bitBuf & ((1 << n) - 1);
                bitBuf >>>= n; bitCnt -= n;
                return v;
            }
            const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
            const LEN_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
            const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
            const DIST_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
            function buildHuff(lengths) {
                let maxLen = 0; const n = lengths.length;
                for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
                const count = new Array(maxLen + 1).fill(0);
                for (let i = 0; i < n; i++) if (lengths[i]) count[lengths[i]]++;
                const perLen = [];
                for (let len = 1; len <= maxLen; len++) perLen[len] = [];
                for (let i = 0; i < n; i++) if (lengths[i]) perLen[lengths[i]].push(i);
                const symbols = [];
                for (let len = 1; len <= maxLen; len++) for (const s of perLen[len]) symbols.push(s);
                return { count, symbols, maxLen };
            }
            function decode(tbl) {
                let code = 0, first = 0, index = 0;
                const { count, symbols, maxLen } = tbl;
                for (let len = 1; len <= maxLen; len++) {
                    code = (code << 1) | readBits(1);
                    const c = count[len] || 0;
                    if (code - first < c) return symbols[index + (code - first)];
                    index += c; first += c; first <<= 1;
                }
                return -1;
            }
            for (;;) {
                const final = readBits(1);
                const type = readBits(2);
                if (type === 0) {
                    bitCnt = 0; bitBuf = 0; // 对齐到字节边界
                    const len = bytes[ip] | (bytes[ip + 1] << 8); ip += 4;
                    for (let i = 0; i < len; i++) out.push(bytes[ip++]);
                } else {
                    let litTbl, distTbl;
                    if (type === 1) {
                        const l = new Array(288);
                        for (let i = 0; i < 144; i++) l[i] = 8;
                        for (let i = 144; i < 256; i++) l[i] = 9;
                        for (let i = 256; i < 280; i++) l[i] = 7;
                        for (let i = 280; i < 288; i++) l[i] = 8;
                        litTbl = buildHuff(l);
                        distTbl = buildHuff(new Array(32).fill(5));
                    } else {
                        const hlit = readBits(5) + 257;
                        const hdist = readBits(5) + 1;
                        const hclen = readBits(4) + 4;
                        const clOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
                        const clLens = new Array(19).fill(0);
                        for (let i = 0; i < hclen; i++) clLens[clOrder[i]] = readBits(3);
                        const clTbl = buildHuff(clLens);
                        const lens = [];
                        while (lens.length < hlit + hdist) {
                            const sym = decode(clTbl);
                            if (sym < 16) lens.push(sym);
                            else if (sym === 16) { const rep = readBits(2) + 3; const prev = lens[lens.length - 1]; for (let i = 0; i < rep; i++) lens.push(prev); }
                            else if (sym === 17) { const rep = readBits(3) + 3; for (let i = 0; i < rep; i++) lens.push(0); }
                            else if (sym === 18) { const rep = readBits(7) + 11; for (let i = 0; i < rep; i++) lens.push(0); }
                        }
                        litTbl = buildHuff(lens.slice(0, hlit));
                        distTbl = buildHuff(lens.slice(hlit, hlit + hdist));
                    }
                    for (;;) {
                        const sym = decode(litTbl);
                        if (sym === 256) break;
                        if (sym < 256) { out.push(sym); continue; }
                        const li = sym - 257;
                        const len = LEN_BASE[li] + readBits(LEN_EXT[li]);
                        const ds = decode(distTbl);
                        const dist = DIST_BASE[ds] + readBits(DIST_EXT[ds]);
                        for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
                    }
                }
                if (final) break;
            }
            return new Uint8Array(out);
        }
        async function unzipGgb(buf) {
            const u8 = new Uint8Array(buf);
            let eocd = -1;
            for (let i = u8.length - 22; i >= 0; i--) {
                if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
            }
            if (eocd < 0) throw new Error('不是有效的 .ggb 文件（找不到 ZIP 结束符）');
            const dv = new DataView(buf);
            const cdCount = dv.getUint16(eocd + 10, true);
            const cdOff = dv.getUint32(eocd + 16, true);
            let p = cdOff, xml = null;
            for (let n = 0; n < cdCount; n++) {
                if (dv.getUint32(p, true) !== 0x02014b50) break;
                const method = dv.getUint16(p + 10, true);
                const compSize = dv.getUint32(p + 20, true);
                const nameLen = dv.getUint16(p + 28, true);
                const extraLen = dv.getUint16(p + 30, true);
                const commLen = dv.getUint16(p + 32, true);
                const lho = dv.getUint32(p + 42, true);
                let name = '';
                for (let k = 0; k < nameLen; k++) name += String.fromCharCode(u8[p + 46 + k]);
                if (name === 'geogebra.xml') {
                    const lm = dv.getUint32(lho, true);
                    if (lm !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
                    const lNameLen = dv.getUint16(lho + 26, true);
                    const lExtraLen = dv.getUint16(lho + 28, true);
                    const dataStart = lho + 30 + lNameLen + lExtraLen;
                    const comp = u8.subarray(dataStart, dataStart + compSize);
                    if (method === 0) {
                        xml = new TextDecoder().decode(comp);
                    } else if (method === 8) {
                        if (typeof DecompressionStream !== 'undefined') {
                            try {
                                const ds = new DecompressionStream('deflate-raw');
                                const stream = new Blob([comp]).stream().pipeThrough(ds);
                                const out = new Uint8Array(await new Response(stream).arrayBuffer());
                                xml = new TextDecoder().decode(out);
                            } catch (e) { xml = null; }
                        }
                        if (xml == null) {
                            // 回退：纯 JS 解压，兼容不支持 DecompressionStream 的环境（旧浏览器/部分 WebView）
                            const out = inflateRaw(comp);
                            xml = new TextDecoder().decode(out);
                        }
                    } else {
                        throw new Error('不支持的 ZIP 压缩方式：' + method);
                    }
                    break;
                }
                p += 46 + nameLen + extraLen + commLen;
            }
            if (xml == null) throw new Error('.ggb 中找不到 geogebra.xml');
            return xml;
        }

        function ggbDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

        // ============================================================
        // GeoGebra 文件解析：.ggb(=ZIP 内含 geogebra.xml) / .geogebra(=XML) → figure
        // 设计要点：
        //   1) 命名空间安全：统一用 getElementsByTagName('*') + localName 取节点，规避真实 .ggb 带默认命名空间时
        //      querySelector(':scope > element') 静默漏元素的问题（即之前 ElementTree.{*} 通配符那个坑的 JS 版）。
        //   2) 精确还原 euclidianView 视口（scale/xZero/yZero/yscale），让导入图形与 GeoGebra 中看到的一致。
        //   3) 完整读取 GeoGebra 样式：objColor(含 alpha)、lineThickness、lineStyle、filling(填充透明度)、
        //      pointSize、pointStyle、labelOffset、caption、show(object/label)。
        // ============================================================
        function parseGeogebraXml(xmlText) {
            const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('GeoGebra XML 解析失败');
            const root = doc.documentElement;
            // 命名空间安全取子节点
            const childrenOf = (el, name) => el ? Array.from(el.getElementsByTagName('*')).filter(n => n.localName === name) : [];
            const childOf = (el, name) => { const a = childrenOf(el, name); return a.length ? a[0] : null; };
            const construction = childOf(root, 'construction') || root;

            // ---- 元素（点/线/圆/...）----
            const elements = {};
            for (const el of childrenOf(construction, 'element')) {
                const label = el.getAttribute('label');
                const type = el.getAttribute('type');
                if (label) elements[label] = { type, el };
            }
            // ---- 表达式（函数 f(x)=...）----
            const exprOf = {};
            for (const el of childrenOf(root, 'expression')) {
                const label = el.getAttribute('label');
                const exp = el.getAttribute('exp') || '';
                const m = exp.match(/^\s*([A-Za-z_]\w*)\s*\(\s*[xX]\s*\)\s*=\s*(.+)$/);
                if (label && m) exprOf[label] = m[2].trim();
            }
            // ---- 命令（依赖关系）----
            const commands = [];
            for (const el of childrenOf(construction, 'command')) {
                const name = (el.getAttribute('name') || '').toLowerCase();
                const inp = childOf(el, 'input'), out = childOf(el, 'output');
                const inputs = [], outputs = [];
                if (inp) for (let i = 0; i < inp.attributes.length; i++) inputs.push(inp.attributes[i].value);
                if (out) for (let i = 0; i < out.attributes.length; i++) outputs.push(out.attributes[i].value);
                commands.push({ name, inputs, outputs, el });
            }

            // ---- 坐标解析 ----
            const coordsCache = {};
            function ptCoords(label) {
                if (label == null) return null;
                if (coordsCache[label]) return coordsCache[label];
                const e = elements[label];
                if (!e) return null;
                const c = childOf(e.el, 'coords');
                if (c) {
                    const x = parseFloat(c.getAttribute('x')), y = parseFloat(c.getAttribute('y')), z = parseFloat(c.getAttribute('z'));
                    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || z === 0) return null;
                    return (coordsCache[label] = [x / z, y / z]);
                }
                return null;
            }
            function coordsOf(el) {
                if (!el) return null;
                const c = childOf(el, 'coords');
                if (c) {
                    const x = parseFloat(c.getAttribute('x')), y = parseFloat(c.getAttribute('y')), z = parseFloat(c.getAttribute('z'));
                    if (isFinite(x) && isFinite(y) && isFinite(z) && z !== 0) return [x / z, y / z];
                }
                const ref = childOf(el, 'ref');
                if (ref) { const lp = ptCoords(ref.getAttribute('label')); if (lp) return lp; }
                return null;
            }

            // ---- 样式解析 ----
            function visibleOf(el) {
                const sh = childOf(el, 'show');
                if (sh && sh.getAttribute('object') === 'false') return false;
                return true;
            }
            function showLabelOf(el) {
                const sh = childOf(el, 'show');
                return sh ? (sh.getAttribute('label') !== 'false') : true;
            }
            function styleOf(el) {
                const s = { c: '#1a1a1a', w: 2, ls: 0, ps: 8, pst: 1, fa: 0, fill: '#1a1a1a', lo: null, hideL: false };
                const oc = childOf(el, 'objColor');
                if (oc) {
                    const r = +oc.getAttribute('r') || 0, g = +oc.getAttribute('g') || 0, b = +oc.getAttribute('b') || 0;
                    const a = oc.getAttribute('a');
                    const alpha = (a == null || a === '') ? 1 : (parseFloat(a) > 1 ? parseFloat(a) / 255 : parseFloat(a));
                    s.c = 'rgb(' + r + ',' + g + ',' + b + ')';
                    s.fill = s.c;
                    s._oa = (isFinite(alpha) ? alpha : 1);
                }
                const lt = childOf(el, 'lineThickness');
                if (lt) { const t = parseInt(lt.getAttribute('value'), 10); if (isFinite(t)) s.w = Math.max(1, t * 0.6 + 0.4); }
                const ls = childOf(el, 'lineStyle');
                if (ls) { const v = parseInt(ls.getAttribute('value'), 10); if (isFinite(v)) s.ls = v; }
                const fl = childOf(el, 'filling');
                if (fl) { const fv = parseFloat(fl.getAttribute('value')); if (isFinite(fv)) s.fa = Math.max(0, Math.min(1, fv)); }
                const fc = childOf(el, 'fillingColor');
                if (fc) { const r = +fc.getAttribute('r') || 0, g = +fc.getAttribute('g') || 0, b = +fc.getAttribute('b') || 0; s.fill = 'rgb(' + r + ',' + g + ',' + b + ')'; }
                if (s.fa > 0 && s._oa != null) s.fa = s.fa * s._oa;
                const psz = childOf(el, 'pointSize');
                if (psz) { const t = parseInt(psz.getAttribute('value'), 10); if (isFinite(t)) s.ps = Math.max(2, t * 1.0 + 1); }
                const pst = childOf(el, 'pointStyle');
                if (pst) { const t = parseInt(pst.getAttribute('value'), 10); if (isFinite(t)) s.pst = t; }
                const cap = childOf(el, 'caption');
                if (cap && cap.textContent != null && cap.textContent.trim() !== '') s.cap = cap.textContent.trim();
                const lm = childOf(el, 'labelMode');
                if (lm) { const m = parseInt(lm.getAttribute('value'), 10); if (m === 3 && s.cap) s.useCap = true; }
                const lo = childOf(el, 'labelOffset');
                if (lo) { const x = parseFloat(lo.getAttribute('x')), y = parseFloat(lo.getAttribute('y')); if (isFinite(x) && isFinite(y)) s.lo = [x, y]; }
                if (!showLabelOf(el)) s.hideL = true;
                return s;
            }

            const unsupported = new Set();
            const items = [], added = {};
            function findItemByLabel(lbl) { for (const it of items) if (it.l === lbl) return it; return null; }
            function circleByLabel(lbl) {
                const f = findItemByLabel(lbl);
                if (f && f.t === 'cir') return f;
                for (const c of commands) if (c.outputs[0] === lbl && c.name === 'circle') {
                    const o = ptCoords(c.inputs[0]); if (!o) return null;
                    let r = NaN;
                    if (c.inputs[1] != null && isFinite(parseFloat(c.inputs[1]))) r = parseFloat(c.inputs[1]);
                    else { const pp = ptCoords(c.inputs[1]); if (pp) r = ggbDist(o, pp); }
                    if (isFinite(r) && r > 0) return { o: o, r: r };
                }
                return null;
            }

            // 圆锥曲线采样：GeoGebra 约定 A0 x² + A1 y² + A2 x y + A3 x + A4 y + A5 = 0
            // 返回若干折线（椭圆→闭合单环；双曲线/抛物线→若干开环），失败返回 null
            function sampleConic(A0, A1, A2, A3, A4, A5) {
                const q = Math.abs(A0) + Math.abs(A1) + Math.abs(A2);
                if (q < 1e-12) return null;
                const det = 4 * A0 * A1 - A2 * A2;
                let cx = 0, cy = 0;
                if (Math.abs(det) > 1e-9) { cx = (A2 * A4 - 2 * A1 * A3) / det; cy = (A2 * A3 - 2 * A0 * A4) / det; }
                else { cx = (Math.abs(A0) > 1e-9) ? -A3 / (2 * A0) : 0; cy = (Math.abs(A1) > 1e-9) ? -A4 / (2 * A1) : 0; if (!isFinite(cx)) cx = 0; if (!isFinite(cy)) cy = 0; }
                const N = 360; const pts = [];
                for (let i = 0; i < N; i++) {
                    const phi = i / N * 2 * Math.PI, cp = Math.cos(phi), sp = Math.sin(phi);
                    const Aq = A0 * cp * cp + A2 * cp * sp + A1 * sp * sp;
                    const Bq = 2 * A0 * cx * cp + A2 * (cx * sp + cy * cp) + 2 * A1 * cy * sp + A3 * cp + A4 * sp;
                    const Cq = A0 * cx * cx + A2 * cx * cy + A1 * cy * cy + A3 * cx + A4 * cy + A5;
                    if (Math.abs(Aq) < 1e-12) { if (Math.abs(Bq) < 1e-12) continue; const t = -Cq / Bq; if (t > 1e-9) pts.push([cx + t * cp, cy + t * sp]); continue; }
                    const disc = Bq * Bq - 4 * Aq * Cq;
                    if (disc < 0) continue;
                    const sq = Math.sqrt(disc);
                    const t1 = (-Bq + sq) / (2 * Aq), t2 = (-Bq - sq) / (2 * Aq);
                    if (t1 > 1e-9) pts.push([cx + t1 * cp, cy + t1 * sp]);
                    if (t2 > 1e-9) pts.push([cx + t2 * cp, cy + t2 * sp]);
                }
                if (pts.length < 4) return null;
                // 按角度排序后，按相邻间距断成若干连续折线（分离双曲线两支/抛物线分支）
                pts.sort((u, w) => Math.atan2(u[1] - cy, u[0] - cx) - Math.atan2(w[1] - cy, w[0] - cx));
                const dlen = [];
                for (let i = 1; i < pts.length; i++) dlen.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
                const med = dlen.slice().sort((a, b) => a - b)[Math.floor(dlen.length / 2)] || 1;
                const loops = []; let cur = [pts[0]];
                for (let i = 1; i < pts.length; i++) {
                    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
                    if (d > med * 4.5 && cur.length >= 2) { loops.push(cur); cur = [pts[i]]; }
                    else cur.push(pts[i]);
                }
                if (cur.length >= 2) loops.push(cur);
                if (!loops.length) return null;
                const closed = loops.length === 1 && loops[0].length >= N * 0.7 &&
                    Math.hypot(loops[0][0][0] - loops[0][loops[0].length - 1][0], loops[0][0][1] - loops[0][loops[0].length - 1][1]) < med * 3;
                return { loops, closed };
            }

            // 1) 点（显式 element，最可靠）
            for (const label in elements) {
                const o = elements[label];
                if (o.type !== 'point') continue;
                if (!visibleOf(o.el)) { added[label] = 1; continue; }
                const p = coordsOf(o.el);
                if (!p) { unsupported.add('point(无坐标)'); continue; }
                const st = styleOf(o.el);
                const item = { t: 'pt', p: p, c: st.c, w: st.w, ps: st.ps, pst: st.pst };
                if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : label;
                if (st.lo) item.lo = st.lo;
                items.push(item); added[label] = 1;
            }

            // 2) 命令（依赖关系，最可靠地拿到端点/圆心/顶点）
            for (const cmd of commands) {
                const out0 = cmd.outputs[0];
                if (added[out0]) continue;
                const stOf = (lbl) => { const e = elements[lbl]; return e ? styleOf(e.el) : null; };
                const applyStyle = (item, lbl) => {
                    const st = stOf(lbl);
                    if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.ps = st.ps; item.pst = st.pst; item.hideL = st.hideL; if (st.fa > 0) { item.fill = st.fill; item.fa = st.fa; } if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : lbl; }
                    else if (!elements[out0] || showLabelOf(elements[out0].el)) item.l = out0;
                    return item;
                };
                if (cmd.name === 'segment' || cmd.name === 'line' || cmd.name === 'ray') {
                    const a = ptCoords(cmd.inputs[0]), b = ptCoords(cmd.inputs[1]);
                    if (a && b && out0) items.push(applyStyle({ t: cmd.name === 'line' ? 'ln' : cmd.name === 'segment' ? 'seg' : 'ray', a: a, b: b }, out0)), added[out0] = 1;
                } else if (cmd.name === 'vector') {
                    const a = ptCoords(cmd.inputs[0]), b = ptCoords(cmd.inputs[1]);
                    if (a && b && out0) items.push(applyStyle({ t: 'vec', a: a, b: b }, out0)), added[out0] = 1;
                } else if (cmd.name === 'circle') {
                    const center = ptCoords(cmd.inputs[0]);
                    if (center && out0) {
                        let r = NaN;
                        if (cmd.inputs[1] != null && isFinite(parseFloat(cmd.inputs[1]))) r = parseFloat(cmd.inputs[1]);
                        else { const pp = ptCoords(cmd.inputs[1]); if (pp) r = ggbDist(center, pp); }
                        if (isFinite(r) && r > 0) items.push(applyStyle({ t: 'cir', o: center, r: r }, out0)), added[out0] = 1;
                    }
                } else if (cmd.name === 'polygon') {
                    const verts = cmd.inputs.map(ptCoords).filter(Boolean);
                    if (verts.length >= 3 && out0) items.push(applyStyle({ t: 'pol', p: verts, close: 1 }, out0)), added[out0] = 1;
                } else if (cmd.name === 'polyline') {
                    const verts = cmd.inputs.map(ptCoords).filter(Boolean);
                    if (verts.length >= 2 && out0 && !added[out0]) {
                        for (let k = 0; k < verts.length - 1; k++) {
                            const item = { t: 'seg', a: verts[k], b: verts[k + 1] };
                            const st = stOf(out0); if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL; if (k === 0 && !st.hideL) item.l = (st.useCap && st.cap) ? st.cap : out0; }
                            items.push(item);
                        }
                        added[out0] = 1;
                    }
                } else if (cmd.name === 'angle') {
                    const A = ptCoords(cmd.inputs[0]), B = ptCoords(cmd.inputs[1]), C = ptCoords(cmd.inputs[2]);
                    if (A && B && C && out0) items.push(applyStyle({ t: 'ang', a: A, b: B, c: C }, out0)), added[out0] = 1;
                } else if (cmd.name === 'midpoint' || cmd.name === 'midpointtool') {
                    const a = ptCoords(cmd.inputs[0]), b = ptCoords(cmd.inputs[1]);
                    if (a && b && out0 && !added[out0]) {
                        const item = { t: 'mid', l: (stOf(out0) && stOf(out0).useCap && stOf(out0).cap) ? stOf(out0).cap : out0, a: cmd.inputs[0], b: cmd.inputs[1] };
                        const st = stOf(out0); if (st) { item.c = st.c; item.w = st.w; item.ps = st.ps; item.pst = st.pst; item.hideL = st.hideL; }
                        items.push(item); added[out0] = 1;
                    }
                } else if (cmd.name === 'intersect' || cmd.name === 'intersectpath') {
                    if (out0 && !added[out0] && cmd.inputs.length >= 2) {
                        const st = stOf(out0);
                        const item = { t: 'inter', l: (st && st.useCap && st.cap) ? st.cap : out0, a: cmd.inputs[0], b: cmd.inputs[1] };
                        if (st) { item.c = st.c; item.w = st.w; item.ps = st.ps; item.pst = st.pst; item.hideL = st.hideL; }
                        items.push(item); added[out0] = 1;
                    }
                } else if (cmd.name === 'semicircle') {
                    const a = ptCoords(cmd.inputs[0]), b = ptCoords(cmd.inputs[1]);
                    if (a && b && out0 && !added[out0]) {
                        const o = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const r = ggbDist(a, b) / 2;
                        let a0 = Math.atan2(a[1] - o[1], a[0] - o[0]) * 180 / Math.PI;
                        let a1 = Math.atan2(b[1] - o[1], b[0] - o[0]) * 180 / Math.PI;
                        while (a1 <= a0) a1 += 360;
                        const item = { t: 'arc', o: o, r: r, a0: a0, a1: a1 };
                        const st = stOf(out0); if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL; if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : out0; }
                        items.push(item); added[out0] = 1;
                    }
                } else if (cmd.name === 'arc' || cmd.name === 'circulararc' || cmd.name === 'circumcirculararc' || cmd.name === 'sector' || cmd.name === 'circularsector' || cmd.name === 'circumcircularsector') {
                    if (out0 && !added[out0] && cmd.inputs.length >= 3) {
                        const P = ptCoords(cmd.inputs[1]), Q = ptCoords(cmd.inputs[2]);
                        const circ = circleByLabel(cmd.inputs[0]);
                        if (circ && P && Q && isFinite(circ.r) && circ.r > 0) {
                            let a0 = Math.atan2(P[1] - circ.o[1], P[0] - circ.o[0]) * 180 / Math.PI;
                            let a1 = Math.atan2(Q[1] - circ.o[1], Q[0] - circ.o[0]) * 180 / Math.PI;
                            while (a1 <= a0) a1 += 360;
                            if (a1 - a0 > 180) a1 -= 360;
                            const isSector = (cmd.name === 'sector' || cmd.name === 'circularsector' || cmd.name === 'circumcircularsector');
                            const item = { t: 'arc', o: circ.o, r: circ.r, a0: a0, a1: a1 };
                            const st = stOf(out0); if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL; if (isSector && st.fa > 0) { item.fill = st.fill; item.fa = st.fa; } if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : out0; }
                            items.push(item); added[out0] = 1;
                            if (isSector) {
                                items.push({ t: 'seg', a: circ.o, b: P, c: item.c, w: item.w });
                                items.push({ t: 'seg', a: circ.o, b: Q, c: item.c, w: item.w });
                            }
                        }
                    }
                } else if (cmd.name === 'orthogonalline' || cmd.name === 'perpendicularline' || cmd.name === 'perpendicularbisector') {
                    if (out0 && !added[out0]) {
                        if (cmd.name === 'perpendicularbisector') {
                            const el = elements[out0];
                            if (el) {
                                const sp = coordsOf(childOf(el.el, 'startPoint')), ep = coordsOf(childOf(el.el, 'endPoint'));
                                if (sp && ep) {
                                    const mid = [(sp[0] + ep[0]) / 2, (sp[1] + ep[1]) / 2];
                                    const st = styleOf(el.el);
                                    const item = { t: 'perp', p: mid, _dx: -(ep[1] - sp[1]), _dy: (ep[0] - sp[0]), l: st.useCap && st.cap ? st.cap : out0 };
                                    item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL;
                                    items.push(item); added[out0] = 1; continue;
                                }
                            }
                            unsupported.add('perpendicularbisector');
                        } else {
                            const ptL = cmd.inputs[0], lineL = cmd.inputs[1];
                            if (ptL && lineL) {
                                const st = stOf(out0);
                                const item = { t: 'perp', p: ptL, line: lineL, l: st && st.useCap && st.cap ? st.cap : out0 };
                                if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL; }
                                items.push(item); added[out0] = 1;
                            }
                        }
                    }
                } else if (cmd.name === 'parallelline') {
                    if (out0 && !added[out0] && cmd.inputs.length >= 2) {
                        const st = stOf(out0);
                        const item = { t: 'para', p: cmd.inputs[0], line: cmd.inputs[1], l: st && st.useCap && st.cap ? st.cap : out0 };
                        if (st) { item.c = st.c; item.w = st.w; item.ls = st.ls; item.hideL = st.hideL; }
                        items.push(item); added[out0] = 1;
                    }
                }
                // tangent / locus / reflect / rotate / translate / dilate 等命令：交由下方 element 兜底或标记不支持
            }

            // 3) element 兜底（未由命令覆盖的类型）
            for (const label in elements) {
                if (added[label]) continue;
                const o = elements[label];
                if (!visibleOf(o.el)) { added[label] = 1; continue; }
                const st = styleOf(o.el);
                if (o.type === 'segment' || o.type === 'line' || o.type === 'ray') {
                    const a = coordsOf(childOf(o.el, 'startPoint')), b = coordsOf(childOf(o.el, 'endPoint'));
                    if (a && b) {
                        const item = { t: o.type === 'line' ? 'ln' : o.type === 'segment' ? 'seg' : 'ray', a: a, b: b, c: st.c, w: st.w, ls: st.ls };
                        if (o.type !== 'line' && st.fa > 0) { item.fill = st.fill; item.fa = st.fa; }
                        if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : label;
                        items.push(item); added[label] = 1;
                    } else unsupported.add(o.type);
                } else if (o.type === 'vector') {
                    const a = coordsOf(childOf(o.el, 'startPoint')), b = coordsOf(childOf(o.el, 'endPoint'));
                    if (a && b) { const item = { t: 'vec', a: a, b: b, c: st.c, w: st.w, ls: st.ls }; if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : label; items.push(item); added[label] = 1; }
                    else unsupported.add('vector');
                } else if (o.type === 'conic') {
                    const m = childOf(o.el, 'matrix');
                    if (m) {
                        const A0 = +m.getAttribute('A0'), A1 = +m.getAttribute('A1'), A2 = +m.getAttribute('A2') || 0,
                              A3 = +m.getAttribute('A3'), A4 = +m.getAttribute('A4'), A5 = +m.getAttribute('A5');
                        const r = sampleConic(A0, A1, A2, A3, A4, A5);
                        if (r && r.loops.length) {
                            for (const loop of r.loops) {
                                const item = { t: 'pol', p: loop, close: (r.closed ? 1 : 0), c: st.c, w: st.w, ls: st.ls };
                                if (st.fa > 0) { item.fill = st.fill; item.fa = st.fa; item.close = 1; }
                                if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : label;
                                items.push(item);
                            }
                            added[label] = 1;
                        } else unsupported.add('conic(无法采样)');
                    } else unsupported.add('conic(无matrix)');
                } else if (o.type === 'function' || o.type === 'functionnvar') {
                    if (exprOf[label] != null) {
                        const item = { t: 'fn', e: exprOf[label], c: st.c, w: st.w, ls: st.ls };
                        if (!st.hideL) item.l = (st.useCap && st.cap) ? st.cap : label;
                        items.push(item); added[label] = 1;
                    } else unsupported.add('function(无表达式)');
                } else if (o.type === 'text') {
                    const t = childOf(o.el, 'value') || childOf(o.el, 'text');
                    const str = t ? (t.textContent || t.getAttribute('value') || '') : '';
                    const start = coordsOf(childOf(o.el, 'startPoint')) || coordsOf(childOf(o.el, 'location'));
                    if (start && str) {
                        const item = { t: 'txt', p: start, s: str, c: st.c };
                        if (st.ps) item.size = st.ps * 2;
                        items.push(item); added[label] = 1;
                    } else unsupported.add('text');
                } else if (o.type !== 'point') {
                    unsupported.add(o.type);
                }
            }

            // 4) 视口（精确还原 GeoGebra 的 euclidianView）
            let v = undefined, g = 0, ax = 0;
            const ev = childOf(root, 'euclidianView');
            if (ev) {
                const cs = childOf(ev, 'coordSystem'), sz = childOf(ev, 'size');
                const showAx = childOf(ev, 'axes'), showGrid = childOf(ev, 'grid');
                if (cs && sz) {
                    let scale = parseFloat(cs.getAttribute('scale')) || 40;
                    let yscale = parseFloat(cs.getAttribute('yscale')) || scale;
                    let xZero = parseFloat(cs.getAttribute('xZero'));
                    let yZero = parseFloat(cs.getAttribute('yZero'));
                    const W = parseFloat(sz.getAttribute('width')) || 640;
                    const H = parseFloat(sz.getAttribute('height')) || 400;
                    // 兼容旧版 GeoGebra：以 xmin/xmax/ymin/ymax 描述视口
                    if ((isNaN(xZero) || isNaN(yZero) || !(scale > 0))) {
                        const xmin = parseFloat(cs.getAttribute('xmin')), xmax = parseFloat(cs.getAttribute('xmax'));
                        const ymin = parseFloat(cs.getAttribute('ymin')), ymax = parseFloat(cs.getAttribute('ymax'));
                        if (isFinite(xmin) && isFinite(xmax) && isFinite(ymin) && isFinite(ymax) && (xmax - xmin) > 0 && (ymax - ymin) > 0) {
                            scale = Math.min(W / (xmax - xmin), H / (ymax - ymin)) || 40;
                            yscale = scale; xZero = -xmin * scale; yZero = H + ymin * scale;
                        }
                    }
                    if (isFinite(scale) && scale > 0 && isFinite(xZero) && isFinite(yZero)) {
                        v = { scale: scale, yscale: yscale, xZero: xZero, yZero: yZero, gw: W, gh: H };
                    }
                }
                if (showAx) ax = showAx.getAttribute('show') === 'false' ? 0 : 1;
                if (showGrid) g = showGrid.getAttribute('show') === 'false' ? 0 : 1;
            }
            return { figure: { dim: 2, view: v, g: g, ax: ax, items: items }, unsupported: Array.from(unsupported), count: items.length, is3D: false };
        }
        async function readGeogebraFile(file) {
            const buf = await file.arrayBuffer();
            const head = new Uint8Array(buf.slice(0, 2));
            const xml = (head[0] === 0x50 && head[1] === 0x4b) ? await unzipGgb(buf) : new TextDecoder().decode(buf);
            return parseGeogebraXml(xml);
        }

        // 共享：根据规范构建图形 SVG 元素数组（GeomBoard 渲染用）
        // selectedIndex>=0 时高亮该元素（编辑器选中态）；labels 置顶渲染；每个元素包一层 g[data-gidx] 便于点击选中。
        // 共享：根据规范构建图形 SVG 元素（GeomBoard 渲染用）。
        // V={scale,xZero,yZero} 为 GeoGebra 式视图；selectedIndex>=0 高亮该元素。
        // ============================================================
        // 共享：根据规范构建图形 SVG 元素（GeomBoard 渲染用）。
        // V={scale,yscale,xZero,yZero} 为 GeoGebra 式视图；selectedIndex>=0 高亮该元素。
        // 渲染逻辑模仿 GeoGebra：精确视口、坐标轴(两端箭头+数字刻度)、自适应网格、
        // 点按 pointStyle/size 绘制、线宽↔GeoGebra lineThickness、线型↔lineStyle、
        // 多边形/圆/扇形的填充透明度、角度弧+直角标记、圆锥曲线折线、函数曲线、标签偏移。
        // ============================================================
        function buildFigureEls(s, V, selectedIndex, showAxes, showGrid) {
            const E = React.createElement;
            const scale = V.scale, yscale = (V.yscale && isFinite(V.yscale) && V.yscale > 0) ? V.yscale : V.scale;
            const xZero = V.xZero, yZero = V.yZero;
            const X = x => xZero + x * scale;
            const Y = y => yZero - y * yscale;
            const HL = '#ff8a00';
            const els = [], labelEls = [];
            const dashOf = ls => (ls === 10 ? '8 5' : ls === 15 ? '1.6 4' : ls === 20 ? '9 4 1.6 4' : (ls > 0 ? '8 5' : undefined));
            const toRGBA = (col, a) => {
                const m = /rgba?\(([^)]+)\)/.exec(col || '');
                if (m) { const p = m[1].split(',').map(x => x.trim()); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
                return col || '#1a1a1a';
            };
            // 自适应网格（GeoGebra 式：网格间距 = 坐标轴刻度间距）
            // 默认按图形类型：含 fn 函数图像显示网格，纯几何隐藏；showGrid 参数（UI 开关）可强制覆盖。
            const showGridOn = (showGrid === undefined || showGrid === null) ? hasFn : !!showGrid;
            const step = figNiceStep(FIG_VBW / scale, 16);
            if (showGridOn) {
                for (let x = Math.ceil((0 - xZero) / scale / step) * step; x <= (FIG_VBW - xZero) / scale + 1e-9; x += step)
                    els.push(E('line', { x1: X(x), y1: 0, x2: X(x), y2: FIG_VBH, className: 'fig-grid' }));
                for (let y = Math.ceil((yZero - FIG_VBH) / scale / step) * step; y <= yZero / scale + 1e-9; y += step)
                    els.push(E('line', { x1: 0, y1: Y(y), x2: FIG_VBW, y2: Y(y), className: 'fig-grid' }));
            }
            // 坐标轴（过原点，两端带箭头）+ 数字刻度
            // 默认按图形类型：含 fn 函数图像显示坐标轴，纯几何隐藏；showAxes 参数（UI 开关）可强制覆盖。
            const hasFn = !!(s.items && s.items.some(it => it.t === 'fn'));
            const showAxis = (showAxes === undefined || showAxes === null) ? hasFn : !!showAxes;
            if (showAxis) {
                const xAxisY = (yZero >= 0 && yZero <= FIG_VBH) ? yZero : (yZero < 0 ? FIG_VBH - 1 : 1);
                const yAxisX = (xZero >= 0 && xZero <= FIG_VBW) ? xZero : (xZero < 0 ? 1 : FIG_VBW - 1);
                els.push(E('line', { x1: 0, y1: xAxisY, x2: FIG_VBW, y2: xAxisY, className: 'fig-axis' }));
                els.push(E('line', { x1: yAxisX, y1: 0, x2: yAxisX, y2: FIG_VBH, className: 'fig-axis' }));
                // 两端箭头
                els.push(E('polygon', { points: `${FIG_VBW},${xAxisY} ${FIG_VBW - 9},${xAxisY - 4} ${FIG_VBW - 9},${xAxisY + 4}`, className: 'fig-axis-arrow' }));
                els.push(E('polygon', { points: `0,${xAxisY} 9,${xAxisY - 4} 9,${xAxisY + 4}`, className: 'fig-axis-arrow' }));
                els.push(E('polygon', { points: `${yAxisX},0 ${yAxisX - 4},9 ${yAxisX + 4},9`, className: 'fig-axis-arrow' }));
                els.push(E('polygon', { points: `${yAxisX},${FIG_VBH} ${yAxisX - 4},${FIG_VBH - 9} ${yAxisX + 4},${FIG_VBH - 9}`, className: 'fig-axis-arrow' }));
                const fmt = n => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
                for (let x = Math.ceil((0 - xZero) / scale / step) * step; x <= (FIG_VBW - xZero) / scale + 1e-9; x += step) {
                    if (Math.abs(x) < 1e-9) continue; const px = X(x);
                    els.push(E('line', { x1: px, y1: xAxisY - 3, x2: px, y2: xAxisY + 3, className: 'fig-tick' }));
                    labelEls.push(E('text', { x: px, y: xAxisY + 14, className: 'fig-label', textAnchor: 'middle' }, fmt(x)));
                }
                for (let y = Math.ceil((yZero - FIG_VBH) / scale / step) * step; y <= yZero / scale + 1e-9; y += step) {
                    if (Math.abs(y) < 1e-9) continue; const py = Y(y);
                    els.push(E('line', { x1: yAxisX - 3, y1: py, x2: yAxisX + 3, y2: py, className: 'fig-tick' }));
                    labelEls.push(E('text', { x: yAxisX - 5, y: py + 4, className: 'fig-label', textAnchor: 'end' }, fmt(y)));
                }
            }
            const R = geomResolve(s);
            const coordOf = R.coordOf, linePts = R.linePts, ptsMap = R.pts;
            // 智能避让：所有图形锚点的质心
            const _anc = [];
            const _addP = p => { if (Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])) _anc.push(p); };
            for (const it of s.items) {
                if (it.t === 'pt' || it.t === 'txt') _addP(coordOf(it.p) || it.p);
                else if (it.t === 'seg' || it.t === 'ray' || it.t === 'ln' || it.t === 'vec') { _addP(coordOf(it.a)); _addP(coordOf(it.b)); }
                else if (it.t === 'pol') (it.p || []).forEach(_addP);
                else if (it.t === 'cir' || it.t === 'arc') _addP(coordOf(it.o));
                else if (it.t === 'ang') { _addP(coordOf(it.a)); _addP(coordOf(it.b)); _addP(coordOf(it.c)); }
                else if (it.t === 'mid' || it.t === 'inter' || it.t === 'onseg' || it.t === 'onln') _addP(ptsMap.get(it.l));
            }
            let cenX = 0, cenY = 0;
            if (_anc.length) { let sx2 = 0, sy2 = 0; for (const q of _anc) { sx2 += q[0]; sy2 += q[1]; } cenX = sx2 / _anc.length; cenY = sy2 / _anc.length; }
            const pushLabel = (text, x, y, anchor, ox, oy) => {
                if (!text) return;
                const a = anchor || 'middle'; const dx = ox || 0, dy = oy || 0;
                labelEls.push(E('text', { x: x + dx, y: y + dy, className: 'fig-label', textAnchor: a, dominantBaseline: 'middle' }, text));
            };
            const pushPointLabel = (label, P, cx, cy, isDep) => {
                if (!label || !P) return;
                const r = (isDep ? 3.5 : 4);
                const Px = P[0], Py = P[1];
                let ndx = null, ndy = null;
                for (const seg of s.items) {
                    if (seg.t !== 'seg' && seg.t !== 'ray' && seg.t !== 'ln') continue;
                    const A = coordOf(seg.a), B = coordOf(seg.b); if (!A || !B) continue;
                    const vx = B[0] - A[0], vy = B[1] - A[1];
                    const wx = Px - A[0], wy = Py - A[1];
                    const segLen2 = vx * vx + vy * vy; if (segLen2 < 1e-12) continue;
                    if (Math.abs(vx * wy - vy * wx) / Math.sqrt(segLen2) > 1e-6) continue;
                    let pxv = -vy, pyv = vx;
                    if (pxv * (Px - cenX) + pyv * (Py - cenY) < 0) { pxv = -pxv; pyv = -pyv; }
                    const pl = Math.hypot(pxv, pyv) || 1; ndx = pxv / pl; ndy = pyv / pl; break;
                }
                let uxs, uys;
                if (ndx !== null) { uxs = ndx; uys = -ndy; }
                else { let dx = Px - cenX, dy = Py - cenY; let len = Math.hypot(dx, dy); if (len < 1e-9) { dx = 1; dy = -1; len = Math.SQRT2; } uxs = dx / len; uys = -dy / len; }
                const off = r + 7;
                labelEls.push(E('text', { x: cx + uxs * off, y: cy + uys * off, className: 'fig-label', textAnchor: uxs >= 0 ? 'start' : 'end', dominantBaseline: 'middle' }, label));
            };
            const drawPoint = (cx, cy, it, isDep) => {
                const sel = (it.__sel);
                const r = ((it.ps || (isDep ? 7 : 8)) / 2);
                const pst = (it.pst != null) ? it.pst : (isDep ? 2 : 1);
                const col = it.c || '#1a1a1a';
                const fill = sel ? HL : col;
                if (pst === 1) return E('circle', { cx, cy, r, fill: fill, stroke: 'none', className: 'fig-pt' });
                if (pst === 2) return E('circle', { cx, cy, r, fill: sel ? HL : '#ffffff', stroke: col, strokeWidth: 1.5, className: 'fig-pt' });
                if (pst === 0 || pst === 3) {
                    const d = r * 0.95;
                    return E('g', { className: 'fig-pt' },
                        E('line', { x1: cx - d, y1: cy, x2: cx + d, y2: cy, stroke: fill, strokeWidth: 1.5 }),
                        E('line', { x1: cx, y1: cy - d, x2: cx, y2: cy + d, stroke: fill, strokeWidth: 1.5 }));
                }
                const diamond = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
                const square = `${cx - r},${cy - r} ${cx + r},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}`;
                if (pst === 4 || pst === 6) return E('polygon', { points: pst === 4 ? diamond : square, fill: fill, stroke: col, strokeWidth: 1, className: 'fig-pt' });
                if (pst === 5 || pst === 7) return E('polygon', { points: pst === 5 ? diamond : square, fill: '#ffffff', stroke: col, strokeWidth: 1.5, className: 'fig-pt' });
                return E('circle', { cx, cy, r, fill: fill, stroke: 'none', className: 'fig-pt' });
            };
            const strokeOf = it => {
                const sel = (it.__sel);
                const col = sel ? HL : (it.c || '#1a1a1a');
                const w = sel ? (it.w || 2) + 1.5 : (it.w || 2);
                const dash = it.dash ? '8 5' : dashOf(it.ls);
                return { stroke: col, strokeWidth: w, strokeDasharray: dash, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' };
            };
            const x0d = (0 - xZero) / scale, x1d = (FIG_VBW - xZero) / scale;
            for (let idx = 0; idx < s.items.length; idx++) {
                const it = s.items[idx];
                it.__sel = (idx === selectedIndex);
                const sel = it.__sel;
                const col = it.c || '#1a1a1a';
                const wpx = it.w || 2;
                const dash = it.dash ? '8 5' : dashOf(it.ls);
                const st = { stroke: sel ? HL : col, strokeWidth: sel ? (wpx + 1.5) : wpx, strokeDasharray: dash, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' };
                const ie = [];
                if (it.t === 'pt') {
                    const P = (Array.isArray(it.p) ? it.p : coordOf(it.p)); if (!P) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const cx = X(P[0]), cy = Y(P[1]);
                    ie.push(drawPoint(cx, cy, it, false));
                    if (it.l && !it.hideL) { if (it.lo) pushLabel(it.l, cx + it.lo[0], cy + it.lo[1], 'start'); else pushPointLabel(it.l, P, cx, cy, false); }
                } else if (it.t === 'mid' || it.t === 'inter' || it.t === 'onseg' || it.t === 'onln') {
                    const P = ptsMap.get(it.l); if (!P) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const cx = X(P[0]), cy = Y(P[1]);
                    ie.push(drawPoint(cx, cy, it, true));
                    if (it.l && !it.hideL) { if (it.lo) pushLabel(it.l, cx + it.lo[0], cy + it.lo[1], 'start'); else pushPointLabel(it.l, P, cx, cy, true); }
                } else if (it.t === 'seg') {
                    const A = coordOf(it.a), B = coordOf(it.b); if (!A || !B) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    ie.push(E('line', Object.assign({ x1: X(A[0]), y1: Y(A[1]), x2: X(B[0]), y2: Y(B[1]) }, strokeOf(it))));
                    if (it.l && !it.hideL) { const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2; pushLabel(it.l, X(mx), Y(my) - 6, 'middle'); }
                } else if (it.t === 'ray' || it.t === 'ln' || it.t === 'perp' || it.t === 'para') {
                    let dir = null, P0 = null;
                    if (it.t === 'perp' || it.t === 'para') {
                        P0 = (typeof it.p === 'string') ? ptsMap.get(it.p) : it.p;
                        if (it._dx != null) { const len = Math.hypot(it._dx, it._dy) || 1; dir = [it._dx / len, it._dy / len]; }
                        else {
                            const line = R.byLabel.get(it.line); const lp = line ? linePts(line) : null;
                            if (P0 && lp) { const dx = lp[1][0] - lp[0][0], dy = lp[1][1] - lp[0][1]; const len = Math.hypot(dx, dy) || 1; let ux = dx / len, uy = dy / len; if (it.t === 'perp') { const tx = ux; ux = -uy; uy = tx; } dir = [ux, uy]; }
                        }
                    } else {
                        const A = coordOf(it.a), B = coordOf(it.b); if (!A || !B) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                        const dx = B[0] - A[0], dy = B[1] - A[1]; const len = Math.hypot(dx, dy) || 1; dir = [dx / len, dy / len]; P0 = (it.t === 'ray') ? A : [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
                    }
                    if (!dir || !P0) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const p1 = (it.t === 'ray' || it.t === 'perp' || it.t === 'para') ? P0 : [P0[0] - dir[0] * 4000, P0[1] - dir[1] * 4000];
                    const p2 = [P0[0] + dir[0] * 4000, P0[1] + dir[1] * 4000];
                    ie.push(E('line', Object.assign({ x1: X(p1[0]), y1: Y(p1[1]), x2: X(p2[0]), y2: Y(p2[1]) }, strokeOf(it))));
                    if (it.l && !it.hideL) { const off = 22 / scale; pushLabel(it.l, X(P0[0] + dir[0] * off), Y(P0[1] + dir[1] * off), 'middle'); }
                } else if (it.t === 'cir' || it.t === 'arc') {
                    const O = coordOf(it.o); if (!O) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const cx = X(O[0]), cy = Y(O[1]), rx = Math.abs(it.r || 0) * scale, ry = Math.abs(it.r || 0) * yscale;
                    if (it.t === 'cir') {
                        const fill = (it.fa > 0) ? toRGBA(it.c || '#1a1a1a', it.fa) : 'none';
                        ie.push(E('ellipse', Object.assign({ cx, cy, rx, ry }, strokeOf(it), { fill })));
                        if (it.l && !it.hideL) pushLabel(it.l, cx + rx * 0.707 + 5, cy - ry * 0.707, 'start');
                    } else {
                        const a0 = (it.a0 || 0) * Math.PI / 180, a1 = (it.a1 || 0) * Math.PI / 180;
                        const p0x = cx + rx * Math.cos(a0), p0y = cy - ry * Math.sin(a0);
                        const p1x = cx + rx * Math.cos(a1), p1y = cy - ry * Math.sin(a1);
                        const ccw = (it.a1 || 0) > (it.a0 || 0);
                        const large = (Math.abs((it.a1 || 0) - (it.a0 || 0)) % 360) > 180 ? 1 : 0;
                        const sweep = ccw ? 0 : 1;
                        const fill = (it.fa > 0) ? toRGBA(it.c || '#1a1a1a', it.fa) : 'none';
                        ie.push(E('path', Object.assign({ d: 'M ' + p0x + ' ' + p0y + ' A ' + rx + ' ' + ry + ' 0 ' + large + ' ' + sweep + ' ' + p1x + ' ' + p1y }, strokeOf(it), { fill })));
                    }
                } else if (it.t === 'pol') {
                    const pts = (it.p || []).map(q => X(q[0]) + ' ' + Y(q[1])).join(' ');
                    const fill = (it.fa > 0) ? toRGBA(it.c || '#1a1a1a', it.fa) : 'none';
                    ie.push(E('polygon', Object.assign({ points: pts }, strokeOf(it), { fill })));
                    if (it.l && !it.hideL) { const v0 = it.p[0]; pushLabel(it.l, X(v0[0]) - 6, Y(v0[1]) - 6, 'end'); }
                } else if (it.t === 'fn') {
                    const N = 300; let cur = null; const paths = [];
                    for (let k = 0; k <= N; k++) {
                        const x = x0d + (x1d - x0d) * k / N;
                        const y = figMathEval(it.e, { x });
                        if (!isFinite(y) || Math.abs(y) > 1e6) { if (cur) { paths.push(cur); cur = null; } continue; }
                        const px = X(x), py = Y(y);
                        cur = cur ? cur + ' L ' + px + ' ' + py : 'M ' + px + ' ' + py;
                    }
                    if (cur) paths.push(cur);
                    for (const d of paths) ie.push(E('path', Object.assign({ d }, strokeOf(it))));
                    if (it.l && !it.hideL) { const xr = x1d - 0.3; const yr = figMathEval(it.e, { x: xr }); if (isFinite(yr)) pushLabel(it.l, X(xr), Y(yr) - 6, 'end'); }
                } else if (it.t === 'ang') {
                    const A = coordOf(it.a), B = coordOf(it.b), C = coordOf(it.c); if (!A || !B || !C) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const bx = X(B[0]), by = Y(B[1]);
                    const va = Math.atan2(A[1] - B[1], A[0] - B[0]), vc = Math.atan2(C[1] - B[1], C[0] - B[0]);
                    let span = (vc - va) * 180 / Math.PI; while (span <= -180) span += 360; while (span > 180) span -= 360;
                    const rdeg = it.r || 22; const r = rdeg;
                    const p0x = bx + r * Math.cos(va), p0y = by - r * Math.sin(va);
                    const p1x = bx + r * Math.cos(vc), p1y = by - r * Math.sin(vc);
                    const ccw = span > 0; const large = Math.abs(span) > 180 ? 1 : 0; const sweep = ccw ? 0 : 1;
                    ie.push(E('path', Object.assign({ d: 'M ' + p0x + ' ' + p0y + ' A ' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + p1x + ' ' + p1y }, strokeOf(it))));
                    if (Math.abs(Math.abs(span) - 90) < 0.5) {
                        const s2 = r * 0.5;
                        const ax2 = bx + s2 * Math.cos(va), ay2 = by - s2 * Math.sin(va);
                        const cx2 = bx + s2 * Math.cos(vc), cy2 = by - s2 * Math.sin(vc);
                        const ix = ax2 + (cx2 - ax2), iy = ay2 + (cy2 - ay2);
                        ie.push(E('polyline', { points: `${ax2},${ay2} ${ix},${iy} ${cx2},${cy2}`, fill: 'none', stroke: sel ? HL : col, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }));
                    }
                    if (it.l && !it.hideL) { const mid = (va + vc) / 2; const lx = bx + (r + 8) * Math.cos(mid), ly = by - (r + 8) * Math.sin(mid); pushLabel(it.l, lx, ly, 'middle'); }
                } else if (it.t === 'vec') {
                    const A = coordOf(it.a), B = coordOf(it.b); if (!A || !B) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    ie.push(E('line', Object.assign({ x1: X(A[0]), y1: Y(A[1]), x2: X(B[0]), y2: Y(B[1]) }, strokeOf(it))));
                    const dx = X(B[0]) - X(A[0]), dy = Y(B[1]) - Y(A[1]); const len = Math.hypot(dx, dy) || 1; const ux = dx / len, uy = dy / len; const pxn = -uy, pyn = ux;
                    const b1 = [X(B[0]) - ux * 10 + pxn * 4, Y(B[1]) - uy * 10 + pyn * 4];
                    const b2 = [X(B[0]) - ux * 10 - pxn * 4, Y(B[1]) - uy * 10 - pyn * 4];
                    ie.push(E('polygon', { points: X(B[0]) + ',' + Y(B[1]) + ' ' + b1[0] + ',' + b1[1] + ' ' + b2[0] + ',' + b2[1], fill: sel ? HL : col, stroke: 'none' }));
                    if (it.l && !it.hideL) pushLabel(it.l, X(B[0]) + ux * 13 + 4, Y(B[1]) + uy * 13 - 4, 'middle');
                } else if (it.t === 'txt') {
                    const P = (Array.isArray(it.p) ? it.p : coordOf(it.p)); if (!P) { els.push(E('g', { 'data-gidx': idx }, ...ie)); continue; }
                    const attrs = { x: X(P[0]), y: Y(P[1]), className: 'fig-label', fill: sel ? HL : (it.c || '#1a1a1a'), textAnchor: 'middle' };
                    if (it.size) attrs.fontSize = it.size;
                    if (it.rot) attrs.transform = 'rotate(' + it.rot + ' ' + X(P[0]) + ' ' + Y(P[1]) + ')';
                    ie.push(E('text', attrs, it.s || ''));
                }
                els.push(E('g', { 'data-gidx': idx, className: sel ? 'geom-sel-g' : '' }, ...ie));
            }
            for (const le of labelEls) els.push(le);
            return els;
        }
        const GeomBoard = React.memo(({ spec, compact }) => {
            const E = React.createElement;
            const specKey = typeof spec === 'string' ? spec : (spec ? JSON.stringify(spec) : '');
            const PARSE = React.useMemo(() => {
                let s = spec;
                if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
                return (!s || !Array.isArray(s.items)) ? null : s;
            }, [specKey]);
            const fit = React.useMemo(() => PARSE ? geomFit(PARSE) : null, [PARSE]);
            const [view, setView] = React.useState(null);
            React.useEffect(() => { setView(fit); }, [fit]);
            // 几何图采用纯 2D 渲染（平面几何 / 函数图 / 伪 3D 立体几何均在此 2D 画布上绘制）。
            const svgRef = React.useRef(null);
            const dragRef = React.useRef(null);
            const pointersRef = React.useRef(new Map());
            const [grabbing, setGrabbing] = React.useState(false);
            const wrapRef = React.useRef(null);
            // 默认显示规则：几何图形（不含 fn）默认隐藏坐标轴+网格；函数图像(含 fn)默认显示两者。
            // 该默认完全由图形类型决定，figure 里的 ax/g 不再参与默认判定（避免 AI 给几何图误加网格/坐标轴）；
            // 用户可用工具栏开关随时覆盖。
            const specHasFn = !!(spec && Array.isArray(spec.items) && spec.items.some(it => it.t === 'fn'));
            const [showAxes, setShowAxes] = React.useState(() => specHasFn);
            const [showGrid, setShowGrid] = React.useState(() => specHasFn);
            const [fs, setFs] = React.useState(false);
            React.useEffect(() => {
                const onFs = () => setFs(!!document.fullscreenElement);
                document.addEventListener('fullscreenchange', onFs);
                return () => document.removeEventListener('fullscreenchange', onFs);
            }, []);
            // —— 可交互构造：非破坏性编辑 ——
            // overrides: 标签(或 '@'+下标) -> [x,y]，仅在基础点(pt)上生效；依赖对象(mid/inter/onseg)由 geomResolve 自动重算。
            const [overrides, setOverrides] = React.useState({});
            const [selIndex, setSelIndex] = React.useState(-1);
            // 辅助线：仅 2D 几何图可用；以「数据坐标」存储（与图形点同一套坐标系），随平移/缩放一起对齐
            const [tool, setTool] = React.useState('pan');       // 'pan' | 'aux' | 'pen' | 'eraser'
            const [auxLines, setAuxLines] = React.useState([]);  // [{a:[x,y], b:[x,y]}]（数据坐标）
            const [draftAux, setDraftAux] = React.useState(null);// 绘制中的辅助线草稿
            // 草稿笔迹：与图形同一套数据坐标存储，随平移/缩放一起对齐；每条笔画含颜色与基础笔宽(px)
            const [penColor, setPenColor] = React.useState('#ff3b6b');
            const [penWidth, setPenWidth] = React.useState(3);
            const [strokes, setStrokes] = React.useState([]);     // [{pts:[[x,y]...], color, width}]
            const [draftStroke, setDraftStroke] = React.useState(null); // 绘制中的笔迹
            React.useEffect(() => { setOverrides({}); setSelIndex(-1); setAuxLines([]); setDraftAux(null); setStrokes([]); setDraftStroke(null); }, [PARSE]);
            const keyOf = (it, i) => (it.l != null ? it.l : ('@' + i));
            const s2 = React.useMemo(() => {
                if (!PARSE) return null;
                if (!Object.keys(overrides).length) return PARSE;
                const items = PARSE.items.map((it, i) => (it.t === 'pt' && overrides[keyOf(it, i)]) ? Object.assign({}, it, { p: overrides[keyOf(it, i)].slice() }) : it);
                return Object.assign({}, PARSE, { items });
            }, [PARSE, overrides]);
            const R = React.useMemo(() => s2 ? geomResolve(s2) : null, [s2]);
            const is3 = false;
            const dragPts = React.useMemo(() => {
                const arr = [];
                if (!R || is3) return arr;
                for (let i = 0; i < s2.items.length; i++) {
                    const it = s2.items[i];
                    if (it.t === 'pt') { const p = overrides[keyOf(it, i)] || it.p; if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) arr.push({ label: keyOf(it, i), idx: i, p }); }
                }
                return arr;
            }, [R, s2, overrides, is3]);

            const toUser = (e) => {
                const svg = svgRef.current; if (!svg) return null;
                const ctm = svg.getScreenCTM(); if (!ctm) return null;
                const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
                const u = pt.matrixTransform(ctm.inverse());
                return { x: u.x, y: u.y, thr: 9 / (ctm.a || 1) };
            };
            const hitPoint = (ux, uy, thr) => {
                let best = null, bd = thr;
                for (const d of dragPts) { const dx = ux - (view.xZero + d.p[0] * view.scale), dy = uy - (view.yZero - d.p[1] * view.scale); const dist = Math.hypot(dx, dy); if (dist < bd) { bd = dist; best = d; } }
                return best;
            };
            const hitSegment = (ux, uy, thr) => {
                if (!R) return null;
                for (let i = 0; i < s2.items.length; i++) {
                    const it = s2.items[i];
                    if (it.t !== 'seg' && it.t !== 'vec') continue;
                    const A = R.coordOf(it.a), B = R.coordOf(it.b); if (!A || !B) continue;
                    const ax = view.xZero + A[0] * view.scale, ay = view.yZero - A[1] * view.scale;
                    const bx = view.xZero + B[0] * view.scale, by = view.yZero - B[1] * view.scale;
                    const vx = bx - ax, vy = by - ay, wx = ux - ax, wy = uy - ay;
                    const L2 = vx * vx + vy * vy; if (L2 < 1e-9) continue;
                    let t = (wx * vx + wy * vy) / L2; t = Math.max(0, Math.min(1, t));
                    const cx = ax + t * vx, cy = ay + t * vy; const dist = Math.hypot(ux - cx, uy - cy);
                    if (dist < thr) return { idx: i };
                }
                return null;
            };
            const hitAngle = (ux, uy, thr) => {
                if (!R) return null;
                for (let i = 0; i < s2.items.length; i++) {
                    const it = s2.items[i];
                    if (it.t !== 'ang') continue;
                    const B = R.coordOf(it.b); if (!B) continue;
                    const bx = view.xZero + B[0] * view.scale, by = view.yZero - B[1] * view.scale;
                    if (Math.hypot(ux - bx, uy - by) < thr * 1.6) return { idx: i };
                }
                return null;
            };

            // 屏幕坐标 → 数据坐标（与图形点同一坐标系，缩放/平移均依赖 view）
            const toData = (u) => ({ x: (u.x - view.xZero) / view.scale, y: (view.yZero - u.y) / view.scale });
            const distToSeg2D = (px, py, a, b) => {
                const vx = b[0] - a[0], vy = b[1] - a[1];
                const L2 = vx * vx + vy * vy;
                if (L2 < 1e-12) return Math.hypot(px - a[0], py - a[1]);
                let t = ((px - a[0]) * vx + (py - a[1]) * vy) / L2; t = Math.max(0, Math.min(1, t));
                return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
            };
            const hitAuxLine = (dx, dy, thrSvg) => {
                const thr = thrSvg / view.scale;
                for (let i = 0; i < auxLines.length; i++) { if (distToSeg2D(dx, dy, auxLines[i].a, auxLines[i].b) <= thr) return i; }
                return -1;
            };

            // 橡皮：单击 / 拖拽删除命中的草稿笔迹或辅助线（就近整条删除，而非整页清空）
            const eraseAt = (dx, dy) => {
                const thr = 12 / view.scale; // 命中阈值（约 12 SVG px，换算到数据坐标）
                let bestI = -1, bestD = thr;
                for (let i = 0; i < strokes.length; i++) {
                    const pts = strokes[i].pts;
                    for (let j = 1; j < pts.length; j++) {
                        const d = distToSeg2D(dx, dy, pts[j - 1], pts[j]);
                        if (d < bestD) { bestD = d; bestI = i; }
                    }
                }
                if (bestI >= 0) { setStrokes(prev => prev.filter((_, i) => i !== bestI)); return true; }
                const hi = hitAuxLine(dx, dy, 12); // 辅助线命中阈值 12 SVG px
                if (hi >= 0) { setAuxLines(prev => prev.filter((_, i) => i !== hi)); return true; }
                return false;
            };

            const toggleFs = () => {
                const el = wrapRef.current; if (!el) return;
                try {
                    if (document.fullscreenElement) document.exitFullscreen();
                    else el.requestFullscreen();
                } catch (_) {}
            };
            React.useEffect(() => {
                const svg = svgRef.current; if (!svg) return;
                const onWheel = (e) => {
                    e.preventDefault();
                    const rect = svg.getBoundingClientRect();
                    const rx = (e.clientX - rect.left) / rect.width;
                    const ry = (e.clientY - rect.top) / rect.height;
                    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15;
                    setView(v => geomZoomAt(v, fit, rx, ry, f));
                };
                svg.addEventListener('wheel', onWheel, { passive: false });
                return () => svg.removeEventListener('wheel', onWheel);
            }, [fit]);
            const is3start = false;
            // 压感笔宽：数位笔按真实 e.pressure 变化（与草稿纸一致）；鼠标/触摸取基准值
            const penWidthAt = (e) => {
                const p = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
                return Math.max(0.5, penWidth * (0.45 + p * 1.1));
            };
            const startDrag = (e) => {
                if (e.button != null && e.button !== 0) return; // 仅主键触发：鼠标左键 / 数位笔笔尖 / 触摸；忽略右键、中键、橡皮擦端
                e.preventDefault();
                const pm = pointersRef.current;
                pm.set(e.pointerId, { x: e.clientX, y: e.clientY });
                try { svgRef.current.setPointerCapture(e.pointerId); } catch (_) {}
                // 草稿笔迹模式（仅 2D）：拖拽自由涂画，笔迹存数据坐标随图形对齐
                if (tool === 'pen' && !is3start) {
                    const u = toUser(e); if (!u) return;
                    const d = toData(u);
                    const w0 = penWidthAt(e);
                    dragRef.current = { mode: 'pen', pts: [[d.x, d.y, w0]], moved: false, sx: e.clientX, sy: e.clientY };
                    setDraftStroke({ pts: [[d.x, d.y, w0]], color: penColor, width: penWidth });
                    setGrabbing(true);
                    return;
                }
                // 辅助线绘制模式（仅 2D）：拖拽画虚线，单击已有辅助线则删除
                if (tool === 'aux' && !is3start) {
                    const u = toUser(e); if (!u) return;
                    const d = toData(u);
                    const hit = hitAuxLine(d.x, d.y, 10);
                    dragRef.current = { mode: 'aux', a: [d.x, d.y], b: [d.x, d.y], moved: false, hitIdx: hit, sx: e.clientX, sy: e.clientY };
                    if (hit < 0) setDraftAux({ a: [d.x, d.y], b: [d.x, d.y] });
                    setGrabbing(true);
                    return;
                }
                // 橡皮模式（仅 2D）：拖拽 / 单击删除命中的草稿笔迹或辅助线
                if (tool === 'eraser' && !is3start) {
                    const u = toUser(e); if (!u) return;
                    const d = toData(u);
                    eraseAt(d.x, d.y);
                    dragRef.current = { mode: 'erase' };
                    setGrabbing(true);
                    return;
                }
                const u = toUser(e); if (!u) return;
                const hp = !is3start ? hitPoint(u.x, u.y, u.thr) : null;
                if (hp) { dragRef.current = { mode: 'point', label: hp.label, idx: hp.idx, moved: false, sx: e.clientX, sy: e.clientY }; setSelIndex(hp.idx); }
                else { dragRef.current = { mode: 'pan', x: e.clientX, y: e.clientY, v: view, moved: false, sx: e.clientX, sy: e.clientY }; }
                setGrabbing(true);
            };
            const moveDrag = (e) => {
                const d = dragRef.current; const pm = pointersRef.current;
                if (pm.has(e.pointerId)) pm.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (!d) return;
                if (d.mode === 'pen') {
                    e.preventDefault();
                    // 合并事件：数位笔高频采样，避免快速运笔丢点导致折线/断笔
                    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
                    for (let k = 0; k < evs.length; k++) {
                        const ce = evs[k];
                        const u = toUser(ce); if (!u) continue;
                        const p = toData(u);
                        d.pts.push([p.x, p.y, penWidthAt(ce)]);
                        if (Math.abs(ce.clientX - d.sx) + Math.abs(ce.clientY - d.sy) > 3) d.moved = true;
                    }
                    if (evs.length) setDraftStroke({ pts: d.pts.slice(), color: penColor, width: penWidth });
                    return;
                }
                if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
                if (d.mode === 'aux') {
                    const u = toUser(e); if (!u) return;
                    const p = toData(u);
                    let bx = p.x, by = p.y;
                    if (e.shiftKey && d.a) { // 约束为 水平 / 垂直 / 45°
                        const dx = bx - d.a[0], dy = by - d.a[1];
                        const ang = (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) ? 0 : Math.atan2(dy, dx);
                        const step = Math.PI / 4;
                        const snapped = Math.round(ang / step) * step;
                        const len = Math.hypot(dx, dy);
                        bx = d.a[0] + Math.cos(snapped) * len;
                        by = d.a[1] + Math.sin(snapped) * len;
                    }
                    d.b = [bx, by];
                    if (d.hitIdx < 0) setDraftAux({ a: d.a, b: [bx, by] });
                    return;
                }
                if (d.mode === 'erase') {
                    e.preventDefault();
                    const u = toUser(e); if (!u) return;
                    const p = toData(u);
                    eraseAt(p.x, p.y);
                    return;
                }
                if (d.mode === 'point') {
                    const u = toUser(e); if (!u) return;
                    const dx = (u.x - view.xZero) / view.scale, dy = (view.yZero - u.y) / view.scale;
                    setOverrides(prev => Object.assign({}, prev, { [d.label]: [dx, dy] }));
                    return;
                }
                const rect = svgRef.current.getBoundingClientRect();
                setView(geomPanFrom(d.v, e.clientX - d.x, e.clientY - d.y, rect.width, rect.height));
            };
            const endDrag = (e) => {
                const pm = pointersRef.current; pm.delete(e.pointerId);
                try { svgRef.current.releasePointerCapture(e.pointerId); } catch (_) {}
                const d = dragRef.current;
                // 辅助线：拖拽结束提交为实线；单击已有线则删除
                if (d && d.mode === 'aux') {
                    if (d.hitIdx >= 0 && !d.moved) {
                        setAuxLines(prev => prev.filter((_, i) => i !== d.hitIdx));
                    } else if (d.moved && d.hitIdx < 0 && draftAux) {
                        const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
                        if (len > 0.02) setAuxLines(prev => [...prev, { a: d.a, b: d.b }]);
                    }
                    setDraftAux(null);
                } else if (d && d.mode === 'pen') {
                    // 提交：移动过或含多个采样点才保留；纯点击(未移动)不落点，避免误画
                    const keep = d.moved || d.pts.length >= 2;
                if (keep) setStrokes(prev => [...prev, { pts: d.pts.slice(), color: penColor, width: penWidth }]);
                setDraftStroke(null);
            } else if (d && d.mode === 'erase') {
                // 橡皮已在按下 / 移动时逐条删除命中元素，无需额外处理
            } else if (d && !d.moved) {
                    const u = toUser(e);
                    if (u && !is3start) {
                        const hp = hitPoint(u.x, u.y, u.thr);
                        if (hp) { setSelIndex(hp.idx); }
                        else { const hs = hitSegment(u.x, u.y, u.thr); if (hs) setSelIndex(hs.idx); else { const ha = hitAngle(u.x, u.y, u.thr); setSelIndex(ha ? ha.idx : -1); } }
                    }
                }
                if (pm.size === 0) { dragRef.current = null; setGrabbing(false); }
            };
            const zoomBtn = (f) => setView(v => geomZoomAt(v, fit, 0.5, 0.5, f));
            const resetView = () => { setView(fit); };
            const resetEdit = () => { setOverrides({}); setSelIndex(-1); setView(fit); };

            // 测量读数（选中点/线段/向量/角时显示）
            let measure = null;
            if (!is3start && R && selIndex >= 0 && s2.items[selIndex]) {
                const it = s2.items[selIndex];
                if (it.t === 'pt') { const p = overrides[keyOf(it, selIndex)] || it.p; if (Array.isArray(p)) measure = '点 ' + (it.l || 'P') + '  (' + p[0].toFixed(2) + ', ' + p[1].toFixed(2) + ')'; }
                else if (it.t === 'seg' || it.t === 'vec') { const A = R.coordOf(it.a), B = R.coordOf(it.b); if (A && B) { const len = Math.hypot(B[0] - A[0], B[1] - A[1]); measure = (it.t === 'vec' ? '向量 ' : '线段 ') + (it.l || '') + '  长度 ' + len.toFixed(2); } }
                else if (it.t === 'ang') { const A = R.coordOf(it.a), B = R.coordOf(it.b), C = R.coordOf(it.c); if (A && B && C) { const a1 = Math.atan2(A[1] - B[1], A[0] - B[0]), a2 = Math.atan2(C[1] - B[1], C[0] - B[0]); let deg = Math.abs(a1 - a2) * 180 / Math.PI; if (deg > 180) deg = 360 - deg; measure = '角 ' + (it.l || '') + '  = ' + deg.toFixed(1) + '°'; } }
            }

            // 导出 / 复制
            const downloadBlob = (blob, name) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
            const exportSvg = () => { const svg = svgRef.current; if (!svg) return; const clone = svg.cloneNode(true); clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); const data = new XMLSerializer().serializeToString(clone); downloadBlob(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }), 'geometry.svg'); };
            const exportPng = () => {
                const svg = svgRef.current; if (!svg) return;
                const clone = svg.cloneNode(true); clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                const data = new XMLSerializer().serializeToString(clone);
                const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
                const img = new Image();
                img.onload = () => {
                    const sc = 2, w = (FIG_VBW + 36) * sc, h = (FIG_VBH + 36) * sc;
                    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                    const ctx = cv.getContext('2d');
                    const wrapEl = svgRef.current && svgRef.current.closest('.geom-board-wrap'); const bg = ((wrapEl && getComputedStyle(wrapEl).getPropertyValue('--card-bg')) || '#ffffff').trim() || '#ffffff';
                    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    cv.toBlob(b => { if (b) downloadBlob(b, 'geometry.png'); URL.revokeObjectURL(url); }, 'image/png');
                };
                img.onerror = () => URL.revokeObjectURL(url);
                img.src = url;
            };
            const copyJson = () => { const txt = JSON.stringify(s2, null, 2); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {}); else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); } };

            const rawEls = React.useMemo(() => {
                if (!s2 || !view) return [];
                return buildFigureEls(s2, view, selIndex, showAxes, showGrid);
            }, [s2, view, selIndex, showAxes, showGrid]);

            if (!PARSE || !fit || !view) return null;
            const els = rawEls.map((e, i) => React.cloneElement(e, { key: 'el' + i }));
            // 辅助线（数据坐标 → SVG 坐标，随图形平移/缩放一起对齐；红色虚线，端点小圆点）
            const auxEls = [];
            const AUX_COLOR = '#ff3b6b';
            const pushAux = (L) => {
                if (!L || !L.a || !L.b) return;
                const ax = view.xZero + L.a[0] * view.scale, ay = view.yZero - L.a[1] * view.scale;
                const bx = view.xZero + L.b[0] * view.scale, by = view.yZero - L.b[1] * view.scale;
                auxEls.push(E('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: AUX_COLOR, strokeWidth: 2.2, strokeDasharray: '7 5', strokeLinecap: 'round', fill: 'none', vectorEffect: 'non-scaling-stroke', className: 'fig-aux', pointerEvents: 'none' }));
                auxEls.push(E('circle', { cx: ax, cy: ay, r: 2.6, fill: AUX_COLOR, stroke: 'none', className: 'fig-aux', pointerEvents: 'none' }));
                auxEls.push(E('circle', { cx: bx, cy: by, r: 2.6, fill: AUX_COLOR, stroke: 'none', className: 'fig-aux', pointerEvents: 'none' }));
            };
            auxLines.forEach(pushAux);
            if (draftAux) pushAux(draftAux);
            // 草稿笔迹（数据坐标 → SVG 坐标，随图形平移/缩放一起对齐；non-scaling-stroke 保证笔宽恒定）
            const strokeEls = [];
            const buildPathD = (pts) => {
                if (!pts || !pts.length) return '';
                let dd = '';
                for (let i = 0; i < pts.length; i++) {
                    const sx = view.xZero + pts[i][0] * view.scale;
                    const sy = view.yZero - pts[i][1] * view.scale;
                    dd += (i === 0 ? 'M' : 'L') + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' ';
                }
                return dd.trim();
            };
            const pushStroke = (S) => {
                if (!S || !S.pts || !S.pts.length) return;
                const hasW = S.pts[0] && S.pts[0].length >= 3; // 含压感宽度 [x,y,w]
                if (S.pts.length === 1) {
                    const sx = view.xZero + S.pts[0][0] * view.scale;
                    const sy = view.yZero - S.pts[0][1] * view.scale;
                    const r = Math.max(0.5, (hasW ? S.pts[0][2] : S.width) / 2);
                    strokeEls.push(E('circle', { cx: sx, cy: sy, r, fill: S.color, className: 'fig-aux', pointerEvents: 'none' }));
                    return;
                }
                if (!hasW) { // 旧数据/无压感：单条定宽路径
                    strokeEls.push(E('path', { d: buildPathD(S.pts), stroke: S.color, strokeWidth: S.width, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke', className: 'fig-aux', pointerEvents: 'none' }));
                    return;
                }
                // 压感：逐段渲染，宽度取相邻两点均值，圆头叠加保证连续
                for (let i = 1; i < S.pts.length; i++) {
                    const a = S.pts[i - 1], b = S.pts[i];
                    const ax = view.xZero + a[0] * view.scale, ay = view.yZero - a[1] * view.scale;
                    const bx = view.xZero + b[0] * view.scale, by = view.yZero - b[1] * view.scale;
                    const w = Math.max(0.5, ((a[2] != null ? a[2] : S.width) + (b[2] != null ? b[2] : S.width)) / 2);
                    strokeEls.push(E('path', { d: 'M' + ax.toFixed(2) + ' ' + ay.toFixed(2) + ' L' + bx.toFixed(2) + ' ' + by.toFixed(2), stroke: S.color, strokeWidth: w, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke', className: 'fig-aux', pointerEvents: 'none' }));
                }
            };
            strokes.forEach(pushStroke);
            if (draftStroke) pushStroke(draftStroke);
            const pct = fit ? Math.round(fit.scale / view.scale * 100) : 100;
            const hasEdit = Object.keys(overrides).length > 0;
            const cursor = grabbing ? 'grabbing' : (tool === 'pen' || tool === 'aux') ? 'crosshair' : (tool === 'eraser' ? 'cell' : 'grab');
            return E('div', { ref: wrapRef, className: 'geom-board-wrap' + (compact ? ' compact' : '') },
                E('div', { className: 'geom-board' + (grabbing ? ' grabbing' : '') },
                    E('div', { className: 'geom-board-title' }, '几何画板'),
                    E('svg', {
                        ref: svgRef,
                        viewBox: '-18 -18 ' + (FIG_VBW + 36) + ' ' + (FIG_VBH + 36),
                        preserveAspectRatio: 'xMidYMid meet',
                        role: 'img',
                        className: 'geom-board-svg',
                        onPointerDown: startDrag,
                        onPointerMove: moveDrag,
                        onPointerUp: endDrag,
                        onPointerCancel: endDrag,
                        onPointerLeave: endDrag,
                        onDoubleClick: (e) => { e.preventDefault(); resetView(); },
                        style: { cursor }
                    }, els.concat(auxEls, strokeEls)),
                    measure ? E('div', { className: 'geom-info', title: '测量' }, measure) : null,
                    E('div', { className: 'geom-tools' },
                        E('button', { type: 'button', title: showAxes ? '隐藏坐标轴' : '显示坐标轴', className: 'geom-tbtn' + (showAxes ? ' active' : ''), onPointerDown: e => e.stopPropagation(), onClick: () => setShowAxes(v => !v) },
                            AxisIcon()),
                        E('button', { type: 'button', title: showGrid ? '隐藏网格' : '显示网格', className: 'geom-tbtn' + (showGrid ? ' active' : ''), onPointerDown: e => e.stopPropagation(), onClick: () => setShowGrid(v => !v) },
                            GridIcon()),
                        !is3start ? E('button', { type: 'button', title: tool === 'aux' ? '退出辅助线（拖拽画虚线 · 单击线删除）' : '画辅助线（虚线）', className: 'geom-tbtn' + (tool === 'aux' ? ' active' : ''), onPointerDown: e => e.stopPropagation(), onClick: () => setTool(tool === 'aux' ? 'pan' : 'aux') }, '📐') : null,
                        !is3start ? E('button', { type: 'button', title: tool === 'pen' ? '退出草稿（拖拽自由涂画）' : '画草稿（自由涂画）', className: 'geom-tbtn' + (tool === 'pen' ? ' active' : ''), onPointerDown: e => e.stopPropagation(), onClick: () => setTool(tool === 'pen' ? 'pan' : 'pen') }, '✏️') : null,
                        !is3start ? E('button', { type: 'button', title: tool === 'eraser' ? '退出橡皮（单击/拖拽删除草稿笔迹与辅助线）' : '橡皮（删除草稿笔迹/辅助线）', className: 'geom-tbtn' + (tool === 'eraser' ? ' active' : ''), onPointerDown: e => e.stopPropagation(), onClick: () => setTool(tool === 'eraser' ? 'pan' : 'eraser') }, '🧽') : null,
                        !is3start && auxLines.length ? E('button', { type: 'button', title: '清除辅助线', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: () => { setAuxLines([]); setDraftAux(null); setTool('pan'); } }, '清除') : null,
                        !is3start && strokes.length ? E('button', { type: 'button', title: '清除草稿笔迹', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: () => { setStrokes([]); setDraftStroke(null); } }, '清草') : null,
                        E('button', { type: 'button', title: '放大', className: 'geom-tbtn', onPointerDown: e => e.stopPropagation(), onClick: () => zoomBtn(1 / 1.3) }, '＋'),
                        E('button', { type: 'button', title: '缩小', className: 'geom-tbtn', onPointerDown: e => e.stopPropagation(), onClick: () => zoomBtn(1.3) }, '－'),
                        E('button', { type: 'button', title: '复位视图', className: 'geom-tbtn', onPointerDown: e => e.stopPropagation(), onClick: resetView }, '⤢'),
                        E('button', { type: 'button', title: fs ? '退出全屏 (Esc)' : '全屏', className: 'geom-tbtn', onPointerDown: e => e.stopPropagation(), onClick: toggleFs },
                            FullscreenIcon(fs)),
                        E('span', { className: 'geom-zoom' }, pct + '%')
                    ),
                    E('div', { className: 'geom-tools2' },
                        E('button', { type: 'button', title: '导出 SVG', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: exportSvg }, 'SVG'),
                        E('button', { type: 'button', title: '导出 PNG', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: exportPng }, 'PNG'),
                        E('button', { type: 'button', title: '复制 JSON', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: copyJson }, '⧉'),
                        hasEdit ? E('button', { type: 'button', title: '还原（撤销拖动/测量）', className: 'geom-tbtn geom-tbtn-sm', onPointerDown: e => e.stopPropagation(), onClick: resetEdit }, '↺') : null
                    ),
                    !is3start && tool === 'pen' ? E('div', { className: 'geom-penbar' },
                        E('div', { className: 'geom-pen-colors' },
                            ['#ff3b6b', '#ffd54f', '#5ad1a5', '#6d8bff', '#1f2733', '#ffffff'].map(c =>
                                E('button', { key: c, type: 'button', title: c, className: 'geom-pen-sw' + (penColor === c ? ' active' : ''), style: { background: c }, onPointerDown: e => e.stopPropagation(), onClick: () => setPenColor(c) })
                            )
                        ),
                        E('div', { className: 'geom-pen-w' },
                            E('span', null, '粗细'),
                            E('input', { type: 'range', min: '1', max: '24', value: String(penWidth), onPointerDown: e => e.stopPropagation(), onChange: e => setPenWidth(Number(e.target.value)) }),
                            E('span', { className: 'geom-pen-wval' }, String(penWidth))
                        ),
                        E('button', { type: 'button', title: '清除草稿笔迹', className: 'geom-pen-clear', onPointerDown: e => e.stopPropagation(), onClick: () => { setStrokes([]); setDraftStroke(null); } }, '清空')
                    ) : null,
                    E('div', { className: 'geom-hint' }, is3start ? '滚轮/双指缩放 · 拖拽平移 · 双击复位' : (tool === 'pen' ? '草稿模式：拖拽自由涂画 · 滚轮缩放 · 双击复位' : (tool === 'aux' ? '辅助线模式：拖拽画虚线 · 单击已有线删除 · 按住 Shift 约束 水平/垂直/45°' : (tool === 'eraser' ? '橡皮模式：单击或拖拽删除草稿笔迹 / 辅助线' : '滚轮/双指缩放 · 拖拽平移 · 拖动圆点构造 · 单击测量 · 双击复位'))))
                )
            );
        });


        // ============================================================
        // 左侧时钟组件：当前时间 + 计时（秒表）+ 倒计时
        // ============================================================
        const playClockBeep = () => {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.type = 'sine';
                o.frequency.value = 880;
                g.gain.setValueAtTime(0.001, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
                o.start();
                o.stop(ctx.currentTime + 0.72);
                o.onended = () => { try { ctx.close(); } catch (e) {} };
            } catch (e) {}
        };

        // 倒计时结束后的持续报警音（双音“滴-滴”蜂鸣，比单声更醒目）
        const playAlarmBeep = () => {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const blip = (freq, start, dur) => {
                    const o = ctx.createOscillator();
                    const g = ctx.createGain();
                    o.connect(g); g.connect(ctx.destination);
                    o.type = 'square';
                    o.frequency.value = freq;
                    g.gain.setValueAtTime(0.001, ctx.currentTime + start);
                    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + start + 0.01);
                    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
                    o.start(ctx.currentTime + start);
                    o.stop(ctx.currentTime + start + dur + 0.02);
                };
                blip(988, 0, 0.14);
                blip(740, 0.18, 0.14);
                setTimeout(() => { try { ctx.close(); } catch (e) {} }, 500);
            } catch (e) {}
        };

        const ClockWidget = () => {
            const el = React.createElement;
            const [tab, setTab] = useState('stopwatch');

            // 当前时间
            const [now, setNow] = useState(() => new Date());
            useEffect(() => {
                const id = setInterval(() => setNow(new Date()), 1000);
                return () => clearInterval(id);
            }, []);

            // ---------- 计时（秒表） ----------
            const [swMs, setSwMs] = useState(0);
            const [swOn, setSwOn] = useState(false);
            const swRef = useRef({ id: null, start: 0, base: 0 });
            const swTick = () => {
                setSwMs(swRef.current.base + (performance.now() - swRef.current.start));
                // 用 rAF 自调度下一帧，与渲染对齐；标签页不可见时浏览器自动降频/暂停，比 20ms 定时器更省电
                swRef.current.id = requestAnimationFrame(swTick);
            };
            const swStart = () => {
                // 基于 rAF id 防重入，而非 swOn state：swOn 为异步更新，同帧重复触发“开始”
                // 时仍可能为 false，从而启动第二个 rAF 循环，导致暂停后旧循环继续计时。
                if (swRef.current.id) return;
                swRef.current.start = performance.now();
                swRef.current.id = requestAnimationFrame(swTick);
                setSwOn(true);
            };
            const swPause = () => {
                if (swRef.current.id) cancelAnimationFrame(swRef.current.id);
                swRef.current.base += performance.now() - swRef.current.start;
                swRef.current.id = null;
                setSwOn(false);
            };
            const swReset = () => {
                if (swRef.current.id) cancelAnimationFrame(swRef.current.id);
                swRef.current = { id: null, start: 0, base: 0 };
                setSwOn(false);
                setSwMs(0);
            };
            useEffect(() => () => { if (swRef.current.id) cancelAnimationFrame(swRef.current.id); }, []);

            // ---------- 倒计时 ----------
            const CD_KEY = 'xdd_countdown_v1';
            const loadCdCfg = () => {
                try {
                    const o = JSON.parse(localStorage.getItem(CD_KEY) || 'null');
                    if (o && typeof o === 'object') {
                        return {
                            h: Math.max(0, Math.min(99, o.h | 0)),
                            m: Math.max(0, Math.min(99, o.m | 0)),
                            s: Math.max(0, Math.min(99, o.s | 0))
                        };
                    }
                } catch (e) {}
                return null;
            };
            const cdCfg0 = loadCdCfg();
            const [cd, setCd] = useState(0);
            const [cdOn, setCdOn] = useState(false);
            const [cdDone, setCdDone] = useState(false);
            const [cdPaused, setCdPaused] = useState(false);
            const [cdAlarm, setCdAlarm] = useState(false);
            const [setH, setSetH] = useState(cdCfg0 ? cdCfg0.h : 0);
            const [setM, setSetM] = useState(cdCfg0 ? cdCfg0.m : 5);
            const [setS, setSetS] = useState(cdCfg0 ? cdCfg0.s : 0);
            const cdRef = useRef({ id: null, end: 0 });
            const cdAlarmRef = useRef(null);
            const origTitleRef = useRef(typeof document !== 'undefined' ? document.title : '');
            const cdApply = () => {
                const ms = (setH * 3600 + setM * 60 + setS) * 1000;
                setCd(ms);
                return ms;
            };
            const cdStart = () => {
                if (cdOn) return;
                const total = cd > 0 ? cd : cdApply();
                if (total <= 0) return;
                setCdDone(false);
                cdRef.current.end = Date.now() + total;
                cdRef.current.id = setInterval(() => {
                    const left = cdRef.current.end - Date.now();
                    if (left <= 0) {
                        clearInterval(cdRef.current.id);
                        cdRef.current.id = null;
                        setCd(0);
                        setCdOn(false);
                        setCdDone(true);
                        startAlarm();
                    } else {
                        setCd(left);
                    }
                }, 50);
                setCdPaused(false);
                setCdOn(true);
            };
            const cdPause = () => {
                if (cdRef.current.id) clearInterval(cdRef.current.id);
                cdRef.current.id = null;
                setCdPaused(true);
                setCdOn(false);
            };
            const cdReset = () => {
                if (cdRef.current.id) clearInterval(cdRef.current.id);
                cdRef.current.id = null;
                stopAlarm();
                setCdOn(false);
                setCdDone(false);
                setCdPaused(false);
                cdApply();
            };
            const stopAlarm = () => {
                if (cdAlarmRef.current) { clearInterval(cdAlarmRef.current); cdAlarmRef.current = null; }
                setCdAlarm(false);
                try { document.title = origTitleRef.current; } catch (e) {}
            };
            const startAlarm = () => {
                stopAlarm();
                setCdAlarm(true);
                setTab('countdown');
                playAlarmBeep();
                cdAlarmRef.current = setInterval(() => {
                    playAlarmBeep();
                    try {
                        document.title = (document.title.indexOf('⏰') >= 0) ? origTitleRef.current : '⏰ 时间到！点击停止';
                    } catch (e) {}
                }, 1100);
            };
            useEffect(() => () => {
                if (cdRef.current.id) clearInterval(cdRef.current.id);
                if (cdAlarmRef.current) clearInterval(cdAlarmRef.current);
            }, []);
            useEffect(() => {
                try { localStorage.setItem(CD_KEY, JSON.stringify({ h: setH, m: setM, s: setS })); } catch (e) {}
            }, [setH, setM, setS]);

            // ---------- 格式化 ----------
            const fmt = (ms, tenth) => {
                const t = Math.max(0, ms);
                const h = Math.floor(t / 3600000);
                const m = Math.floor((t % 3600000) / 60000);
                const s = Math.floor((t % 60000) / 1000);
                const p = n => String(n).padStart(2, '0');
                if (tenth) {
                    const d = Math.floor((t % 1000) / 10);
                    return p(h) + ':' + p(m) + ':' + p(s) + '.' + p(d);
                }
                return p(h) + ':' + p(m) + ':' + p(s);
            };
            const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
            const dateStr = (now.getMonth() + 1) + '月' + now.getDate() + '日 周' + week;

            const numInput = (unit, val, set) => {
                const cur = { h: setH, m: setM, s: setS };
                const apply = (raw) => {
                    let v = parseInt(raw, 10);
                    if (isNaN(v) || v < 0) v = 0;
                    if (v > 99) v = 99;
                    set(v);
                    if (!cdOn) {
                        setCdDone(false);
                        setCdPaused(false);
                        const n = { h: cur.h, m: cur.m, s: cur.s };
                        n[unit] = v;
                        setCd((n.h * 3600 + n.m * 60 + n.s) * 1000);
                    }
                };
                return el('div', { className: 'clock-stepper' },
                    el('button', {
                        type: 'button', className: 'step-btn', 'aria-label': '减少', disabled: cdOn,
                        onClick: () => apply(val - 1)
                    }, '−'),
                    el('input', {
                        type: 'text', inputMode: 'numeric', className: 'step-val', value: val, disabled: cdOn,
                        onChange: (e) => apply(e.target.value)
                    }),
                    el('button', {
                        type: 'button', className: 'step-btn', 'aria-label': '增加', disabled: cdOn,
                        onClick: () => apply(val + 1)
                    }, '+')
                );
            };

            const cfgMs = (setH * 3600 + setM * 60 + setS) * 1000;

            return el('div', { className: 'clock-widget' },
                el('div', { className: 'clock-time' },
                    el('div', { className: 'clock-now' }, now.toLocaleTimeString('zh-CN', { hour12: false })),
                    el('div', { className: 'clock-date' }, dateStr)
                ),
                el('div', { className: 'clock-tabs' },
                    el('button', {
                        className: 'clock-tab' + (tab === 'stopwatch' ? ' active' : ''),
                        onClick: () => setTab('stopwatch')
                    }, '⏱ 计时'),
                    el('button', {
                        className: 'clock-tab' + (tab === 'countdown' ? ' active' : ''),
                        onClick: () => setTab('countdown')
                    }, '⏳ 倒计时')
                ),
                tab === 'stopwatch'
                    ? el('div', null,
                        el('div', { className: 'clock-display' }, fmt(swMs, true)),
                        el('div', { className: 'clock-btns' },
                            el('button', { className: 'primary', onClick: () => swOn ? swPause() : swStart() }, swOn ? '暂停' : '开始'),
                            el('button', { className: 'ghost', onClick: swReset }, '重置')
                        )
                    )
                    : el('div', null,
                        el('div', { className: 'clock-inputs' },
                            numInput('h', setH, setSetH),
                            el('span', { className: 'sep' }, ':'),
                            numInput('m', setM, setSetM),
                            el('span', { className: 'sep' }, ':'),
                            numInput('s', setS, setSetS)
                        ),
                        el('div', { className: 'clock-display' + (cdDone ? ' warn' : '') + (cdAlarm ? ' alarm' : '') + (cdPaused && !cdDone ? ' paused' : '') },
                            cdDone ? (cdAlarm ? '⏰ 时间到！点击停止' : '⏰ 时间到！')
                                   : (cdPaused ? ('⏸ ' + fmt(cd > 0 ? cd : cfgMs, true) + ' 已暂停') : fmt(cd > 0 ? cd : cfgMs, true))),
                        el('div', { className: 'clock-btns' },
                            cdAlarm
                                ? el('button', { className: 'danger pulse', onClick: () => { stopAlarm(); setCdDone(false); } }, '⏹ 停止报警')
                                : el('button', { className: 'primary', disabled: cdOn, onClick: () => cdStart() },
                                    cdPaused ? '继续' : '开始'),
                            cdAlarm
                                ? null
                                : el('button', { className: 'ghost', disabled: !cdOn, onClick: cdPause }, '暂停'),
                            el('button', { className: 'ghost', onClick: () => { stopAlarm(); cdReset(); } }, '重置')
                        )
                    )
            );
        };

        // ============================================================
        // 19. 右侧音乐播放窗口（本地文件 / 在线链接，播放列表持久化）
        // ============================================================
        // 本地音频文件（blob URL 刷新即失效）改用 IndexedDB 持久化，刷新后重建 URL
        // （IndexedDB 辅助函数 openMusicDB/idbPut/idbGetAll/idbDelete 已提到备份区共享作用域）

        const MusicPlayer = React.memo(() => {
            const h = React.createElement;
            const STORE_KEY = 'xdd_music_tracks_v1';
            const isPersistable = (url) => url.startsWith('http') || url.startsWith('data:');

            const [tracks, setTracks] = useState(() => {
                try {
                    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
                    return Array.isArray(raw) ? raw.filter(t => t && isPersistable(t.url)) : [];
                } catch (e) { return []; }
            });
            const [current, setCurrent] = useState(-1);
            const [playing, setPlaying] = useState(false);
            const [progress, setProgress] = useState(0);   // 0..1
            const [duration, setDuration] = useState(0);
            const [cur, setCur] = useState(0);
            // 音量/静音持久化到独立 key（前缀 xdd_vol_，避开 xdd_music_ 以免进入加密备份）；无记录则用默认 0.8/非静音
            const [volume, setVolume] = useState(() => {
                try { const s = parseFloat(localStorage.getItem('xdd_vol_v1')); return isNaN(s) ? 0.8 : Math.min(1, Math.max(0, s)); } catch (e) { return 0.8; }
            });
            const [muted, setMuted] = useState(() => {
                try { return localStorage.getItem('xdd_vol_muted_v1') === '1'; } catch (e) { return false; }
            });
            // 平衡音量（响度归一化）开关：默认开启，让同音量下的不同曲目听起来一样响
            const [balanceOn, setBalanceOn] = useState(() => {
                try { return localStorage.getItem('xdd_vol_balance_v1') !== '0'; } catch (e) { return true; }
            });
            const [analyzing, setAnalyzing] = useState(false);
            const [repeat, setRepeat] = useState('off');   // off | all | one
            const [shuffle, setShuffle] = useState(false);

            const audioRef = useRef(null);
            const fileRef = useRef(null);
            const folderRef = useRef(null);
            const tracksRef = useRef(tracks); tracksRef.current = tracks;
            const currentRef = useRef(current); currentRef.current = current;
            const repeatRef = useRef(repeat); repeatRef.current = repeat;
            const shuffleRef = useRef(shuffle); shuffleRef.current = shuffle;
            // 随机播放队列：随机排序后的播放顺序；一轮播完会重新洗牌继续无限随机播放所有音乐
            const shuffleQueueRef = useRef([]);   // 随机播放顺序（曲目索引数组）
            const shufflePosRef = useRef(-1);     // 当前曲目在队列中的位置
            // 平衡音量所需的 Web Audio 图（MediaElementSource -> GainNode -> 输出）与每曲目增益缓存
            const graphRef = useRef(null);          // { ctx, src, gain }
            const decodeCtxRef = useRef(null);      // 复用的离线解码上下文
            const gainMapRef = useRef(null);        // { [trackId]: 归一化增益 }
            const pendingRef = useRef(null);        // 正在分析的曲目 id 集合
            if (gainMapRef.current === null) {
                try { gainMapRef.current = JSON.parse(localStorage.getItem('xdd_loud_v1') || '{}') || {}; } catch (e) { gainMapRef.current = {}; }
            }
            if (pendingRef.current === null) pendingRef.current = new Set();

            // 频谱可视化：用 AnalyserNode 读取实时频率数据，驱动「播放中」的均衡器条高度
            const eqWrapRef = useRef(null);     // 均衡器容器（.eq）DOM
            const rafRef = useRef(0);           // requestAnimationFrame 句柄
            const vizActiveRef = useRef(false); // 是否正在以频谱驱动动画
            const freqDataRef = useRef(null);   // 频域数据缓冲 Uint8Array
            // 组件卸载时停掉 rAF，避免内存泄漏
            useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

            // 持久化（仅可跨会话保存的 http/data 链接；本地文件 blob 走 IndexedDB）
            useEffect(() => {
                try {
                    localStorage.setItem(STORE_KEY, JSON.stringify(tracks.filter(t => isPersistable(t.url))));
                } catch (e) { /* ignore */ }
            }, [tracks]);

            // 启动时从 IndexedDB 恢复本地音频文件（blob 不进 localStorage，刷新即失效）
            useEffect(() => {
                let alive = true;
                idbGetAll().then(rows => {
                    if (!alive) return;
                    const restored = (rows || []).filter(r => r && r.blob).map(r => ({
                        id: r.id, title: r.title || '本地音频', artist: (r.artist && r.artist !== '本地文件') ? r.artist : '',
                        url: URL.createObjectURL(r.blob)
                    }));
                    if (restored.length) setTracks(prev => {
                        const have = new Set(prev.map(t => t.id));
                        const add = restored.filter(t => !have.has(t.id));
                        return add.length ? prev.concat(add) : prev;
                    });
                    // 回填：本地音频若缺失歌手/标题，从 ID3 标签补全（让旧导入的歌曲也能显示歌手名）
                    (rows || []).forEach(r => {
                        if (!r || !r.blob) return;
                        const hasArtist = r.artist && r.artist !== '本地文件';
                        const hasTitle = r.title && r.title !== '本地音频';
                        if (hasArtist && hasTitle) return;
                        parseAudioMeta(r.blob).then(meta => {
                            const artist = (meta.artist || '').trim();
                            const title = (meta.title || '').trim();
                            if (!artist && !title) return;
                            const newArtist = artist || r.artist || '';
                            const newTitle = title || r.title || '本地音频';
                            idbPut({ id: r.id, blob: r.blob, title: newTitle, artist: newArtist });
                            setTracks(ts => ts.map(t => t.id === r.id ? { ...t, artist: newArtist || t.artist, title: newTitle || t.title } : t));
                        }).catch(() => {});
                    });
                });
                return () => { alive = false; };
            }, []);

            // 音量同步：经增益节点应用主音量，并叠加当前曲目的平衡增益
            useEffect(() => {
                applyGain();
            }, [volume, muted, balanceOn, current]);

            // 音量/静音/平衡开关落地到 localStorage（独立 key，不进加密备份）
            useEffect(() => {
                try {
                    localStorage.setItem('xdd_vol_v1', String(volume));
                    localStorage.setItem('xdd_vol_muted_v1', muted ? '1' : '0');
                    localStorage.setItem('xdd_vol_balance_v1', balanceOn ? '1' : '0');
                } catch (e) { /* 隐私模式等忽略 */ }
            }, [volume, muted, balanceOn]);

            // 文件夹批量导入：webkitdirectory 需以属性方式设置（React 不识别该 prop）
            useEffect(() => {
                if (folderRef.current) folderRef.current.setAttribute('webkitdirectory', '');
            }, []);

            // ---------- 平衡音量（响度归一化）----------
            // 思路：不同曲目即使设置了相同“音量”，因母带响度不同，听感差异很大。
            // 这里对每首曲目做一次离线分析，得到其平均响度（RMS）与峰值，
            // 计算一个归一化增益，使所有曲目在“同一音量”下听感一致，同时钳制增益避免削波。
            const getDecodeCtx = () => {
                if (!decodeCtxRef.current) {
                    const C = window.AudioContext || window.webkitAudioContext;
                    if (!C) return null;
                    try { decodeCtxRef.current = new C(); } catch (e) { return null; }
                }
                return decodeCtxRef.current;
            };

            // 懒初始化 Web Audio 图：<audio> -> MediaElementSource -> GainNode -> 输出
            const ensureGraph = () => {
                if (graphRef.current) {
                    if (graphRef.current.ctx.state === 'suspended') graphRef.current.ctx.resume().catch(() => {});
                    return graphRef.current;
                }
                try {
                    const C = window.AudioContext || window.webkitAudioContext;
                    if (!C) return null;
                    const a = audioRef.current;
                    if (!a) return null;
                    const ctx = new C();
                    const src = ctx.createMediaElementSource(a);
                    const gain = ctx.createGain();
                    gain.gain.value = 1;
                    // 频谱分析节点：串在 gain 之后、输出之前（gain -> analyser -> destination）
                    const analyser = ctx.createAnalyser();
                    analyser.fftSize = 64;                 // frequencyBinCount = 32
                    analyser.smoothingTimeConstant = 0.8;  // 平滑，避免抖动过猛
                    src.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
                    graphRef.current = { ctx, src, gain, analyser };
                    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                    applyGain();
                    return graphRef.current;
                } catch (e) { return null; }
            };

            // 由解码后的 AudioBuffer 计算归一化增益
            const computeLoudnessGain = (ab) => {
                const ch = ab.numberOfChannels, len = ab.length;
                if (!len || !ch) return 1;
                const mono = new Float32Array(len);
                for (let c = 0; c < ch; c++) {
                    const data = ab.getChannelData(c), w = 1 / ch;
                    for (let i = 0; i < len; i++) mono[i] += data[i] * w;
                }
                let sumSq = 0, peak = 0;
                for (let i = 0; i < len; i++) {
                    const s = mono[i];
                    sumSq += s * s;
                    const a = s < 0 ? -s : s;
                    if (a > peak) peak = a;
                }
                const rms = Math.sqrt(sumSq / len);
                if (rms < 1e-4 || peak < 1e-4) return 1;
                const targetRMS = 0.2;                 // 目标平均响度（归一化振幅）
                let gain = targetRMS / rms;            // 使其达到目标响度
                const maxGain = 0.99 / peak;           // 钳制，避免削波
                if (gain > maxGain) gain = maxGain;
                if (gain > 4) gain = 4;                // 安静曲目也别过度放大噪声
                if (gain < 0.25) gain = 0.25;
                return gain;
            };

            // 离线分析一首曲目并缓存其增益（本地 blob / data 可分析；跨域在线音频分析失败时退化为不增益）
            const analyzeTrack = (track) => {
                if (!track) return;
                if (gainMapRef.current[track.id] != null) { applyGain(); return; }
                if (pendingRef.current.has(track.id)) return;
                pendingRef.current.add(track.id);
                const finish = (g) => {
                    gainMapRef.current[track.id] = g;
                    try { localStorage.setItem('xdd_loud_v1', JSON.stringify(gainMapRef.current)); } catch (e) {}
                    pendingRef.current.delete(track.id);
                    applyGain();
                };
                (async () => {
                    try {
                        setAnalyzing(true);
                        const resp = await fetch(track.url);
                        if (!resp.ok) throw new Error('fetch ' + resp.status);
                        const buf = await resp.arrayBuffer();
                        const dctx = getDecodeCtx();
                        if (!dctx) throw new Error('no decode ctx');
                        const ab = await dctx.decodeAudioData(buf);
                        finish(computeLoudnessGain(ab));
                    } catch (e) {
                        finish(1); // 无法分析（如跨域限制）时退化为原始响度
                    } finally {
                        setAnalyzing(false);
                    }
                })();
            };

            // 将主音量与当前曲目的平衡增益应用到输出
            const applyGain = () => {
                const master = muted ? 0 : volume;
                const t = current >= 0 ? tracksRef.current[current] : null;
                const g = (balanceOn && t && gainMapRef.current[t.id] != null) ? gainMapRef.current[t.id] : 1;
                const eff = master * g;
                const gr = graphRef.current;
                if (gr && gr.ctx.state === 'running') {
                    gr.gain.gain.setTargetAtTime(Math.max(0, Math.min(4, eff)), gr.ctx.currentTime, 0.02);
                    if (audioRef.current) audioRef.current.volume = 1;
                } else if (audioRef.current) {
                    audioRef.current.volume = Math.min(1, eff); // 无图时仅能衰减（增益上限 1）
                }
            };

            // 频谱驱动均衡器：播放时关闭 CSS 循环动画，改用实时频率数据设置每根条高度；
            // 无 Web Audio 分析能力（如浏览器不支持 AudioContext）时直接返回，退回 CSS 循环动画。
            const startViz = () => {
                if (vizActiveRef.current) return; // 已在驱动，避免切歌时叠加多个 rAF 循环
                const gr = graphRef.current;
                const eq = eqWrapRef.current;
                if (!gr || !gr.analyser || !eq) return;
                if (!freqDataRef.current) freqDataRef.current = new Uint8Array(gr.analyser.frequencyBinCount);
                for (let i = 0; i < eq.children.length; i++) eq.children[i].style.animation = 'none'; // 停掉 CSS 关键帧
                vizActiveRef.current = true;
                const data = freqDataRef.current;
                const draw = () => {
                    if (!vizActiveRef.current) return;
                    gr.analyser.getByteFrequencyData(data);
                    const spans = eq.children, n = spans.length;
                    for (let i = 0; i < n; i++) {
                        // 取频谱低 ~60%（中低频，律动最明显），映射到各条
                        const bin = Math.floor((i + 0.5) / n * (data.length * 0.6));
                        const v = data[bin] || 0;
                        const hh = 6 + (v / 255) * 18;
                        spans[i].style.height = hh.toFixed(1) + 'px';
                    }
                    rafRef.current = requestAnimationFrame(draw);
                };
                rafRef.current = requestAnimationFrame(draw);
            };

            // 停止频谱驱动：取消 rAF，恢复静止小条（保持 animation:none，避免 CSS 动画在暂停态“卡”在某一帧）
            const stopViz = () => {
                vizActiveRef.current = false;
                if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
                const eq = eqWrapRef.current;
                if (eq) for (let i = 0; i < eq.children.length; i++) {
                    eq.children[i].style.animation = 'none';
                    eq.children[i].style.height = '8px';
                }
            };

            const fmt = (s) => {
                if (!s || isNaN(s)) return '0:00';
                const m = Math.floor(s / 60), ss = Math.floor(s % 60);
                return m + ':' + (ss < 10 ? '0' + ss : ss);
            };

            const loadAndPlay = (idx, autoplay = true) => {
                if (idx < 0 || idx >= tracksRef.current.length) return;
                const t = tracksRef.current[idx];
                setCurrent(idx);
                const a = audioRef.current;
                if (!a) return;
                a.src = t.url;
                a.load();
                ensureGraph();          // 首次播放时建立 Web Audio 图
                analyzeTrack(t);        // 归一化该曲目的响度增益
                if (autoplay) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
            };

            const togglePlay = () => {
                const a = audioRef.current;
                if (!a) return;
                if (current < 0) {
                    const n = tracksRef.current.length;
                    if (!n) return;
                    // 开启随机播放时，从未选曲状态起播就随机选一首；否则从列表首曲开始
                    const startIdx = shuffleRef.current ? Math.floor(Math.random() * n) : 0;
                    loadAndPlay(startIdx);
                    return;
                }
                if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
                else a.pause();
            };

            // 构建随机播放队列：以 startIdx 为起点（旋转到队首），保证从当前曲开始把每首各播一遍
            const buildShuffle = (startIdx) => {
                const n = tracksRef.current.length;
                shuffleQueueRef.current = [];
                shufflePosRef.current = -1;
                if (!n) return;
                const order = [];
                for (let i = 0; i < n; i++) order.push(i);
                for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
                if (startIdx != null && startIdx >= 0) {
                    const k = order.indexOf(startIdx);
                    if (k > 0) shuffleQueueRef.current = order.slice(k).concat(order.slice(0, k));
                    else shuffleQueueRef.current = order;
                    shufflePosRef.current = 0;
                } else {
                    shuffleQueueRef.current = order;
                    shufflePosRef.current = -1;
                }
            };
            // 队列与当前曲目/曲库不一致时重建（用户点了别的曲、增删了曲目等都安全）
            const syncShuffleQueue = () => {
                const n = tracksRef.current.length;
                if (!shuffleQueueRef.current.length || shuffleQueueRef.current.length !== n || shuffleQueueRef.current[shufflePosRef.current] !== currentRef.current) {
                    buildShuffle(currentRef.current);
                }
            };
            const nextIdx = () => {
                const n = tracksRef.current.length;
                if (!n) return -1;
                if (shuffleRef.current) {
                    syncShuffleQueue();
                    let pos = shufflePosRef.current + 1;
                    if (pos >= shuffleQueueRef.current.length) {
                        // 一轮随机播完：重新洗牌并继续无限随机播放所有音乐（单首时则原地重播）
                        const n = tracksRef.current.length;
                        buildShuffle(currentRef.current);
                        if (n <= 1) { shufflePosRef.current = 0; return shuffleQueueRef.current[0]; }
                        shufflePosRef.current = 0; pos = 1;
                    }
                    shufflePosRef.current = pos;
                    return shuffleQueueRef.current[pos];
                }
                return (currentRef.current + 1) % n;
            };
            const prevIdx = () => {
                const n = tracksRef.current.length;
                if (!n) return -1;
                if (shuffleRef.current) {
                    syncShuffleQueue();
                    let pos = shufflePosRef.current - 1;
                    if (pos < 0) {
                        // 已到队列开头：重新洗牌并跳到本轮最后一首，继续无限回退随机播放
                        const n = tracksRef.current.length;
                        buildShuffle(currentRef.current);
                        if (n <= 1) { shufflePosRef.current = 0; return shuffleQueueRef.current[0]; }
                        shufflePosRef.current = 0; pos = shuffleQueueRef.current.length - 1;
                    }
                    shufflePosRef.current = pos;
                    return shuffleQueueRef.current[pos];
                }
                return (currentRef.current - 1 + n) % n;
            };

            const onNext = () => { const i = nextIdx(); if (i >= 0) loadAndPlay(i); };
            const onPrev = () => {
                const a = audioRef.current;
                if (a && a.currentTime > 3) { a.currentTime = 0; return; }
                const i = prevIdx(); if (i >= 0) loadAndPlay(i);
            };

            const onEnded = () => {
                if (repeatRef.current === 'one') {
                    const a = audioRef.current;
                    if (a) { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); }
                    return;
                }
                if (shuffleRef.current) {
                    const i = nextIdx();
                    if (i < 0) { setPlaying(false); return; } // 仅曲库为空时才停止；否则 nextIdx 已重新洗牌无限续播
                    loadAndPlay(i);
                    return;
                }
                const n = tracksRef.current.length;
                if (currentRef.current >= n - 1 && repeatRef.current === 'off') { setPlaying(false); stopViz(); return; }
                onNext();
            };

            const onTime = () => {
                const a = audioRef.current; if (!a) return;
                setCur(a.currentTime);
                setProgress(a.duration ? a.currentTime / a.duration : 0);
            };
            const onMeta = () => { const a = audioRef.current; if (a) setDuration(a.duration || 0); };

            const seek = (e) => {
                const a = audioRef.current; if (!a || !a.duration) return;
                const v = parseFloat(e.target.value);
                a.currentTime = (v / 1000) * a.duration;
                setCur(a.currentTime); setProgress(v / 1000);
            };
            const onVol = (e) => { const v = parseFloat(e.target.value) / 100; setVolume(v); if (v > 0) setMuted(false); };
            const toggleMute = () => setMuted(m => !m);

            const addFileList = (fileList) => {
                const files = Array.from(fileList || []).filter(isAudioFile);
                if (!files.length) return 0;
                let added = 0;
                files.forEach(f => {
                    const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 7) + added;
                    const baseTitle = f.name.replace(/\.[^.]+$/, '');
                    added++;
                    // 先以文件名占位立即上架，再异步回填 ID3 标签（歌手/标题），避免大文件阻塞导入
                    const track = { id, title: baseTitle, artist: '', url: URL.createObjectURL(f) };
                    idbPut({ id, blob: f, title: baseTitle, artist: '' });
                    setTracks(ts => ts.concat(track));
                    parseAudioMeta(f).then(meta => {
                        const artist = (meta.artist || '').trim();
                        const title = (meta.title || '').trim();
                        if (!artist && !title) return;
                        setTracks(ts => ts.map(t => t.id === id ? { ...t, artist: artist || t.artist, title: title || t.title } : t));
                        idbPut({ id, blob: f, title: title || baseTitle, artist: artist || '' });
                    }).catch(() => {});
                });
                return added;
            };
            const addFiles = (e) => {
                addFileList(e.target.files);
                e.target.value = '';
            };
            const addFolder = (e) => {
                addFileList(e.target.files);
                e.target.value = '';
            };
            // 拖拽到面板添加
            const dragDepth = useRef(0);
            const [dragOver, setDragOver] = useState(false);
            // 内部拖拽（题库/文件夹）悬停在面板上的提示态：面板只接收音频，不处理数据
            const [extHover, setExtHover] = useState(false);
            React.useEffect(() => {
                const onHover = e => { setExtHover(!!(e.detail && e.detail.over)); };
                window.addEventListener('xdd:music-hover', onHover);
                return () => window.removeEventListener('xdd:music-hover', onHover);
            }, []);
            const onDragEnter = (e) => { e.preventDefault(); dragDepth.current++; setDragOver(true); };
            const onDragOverP = (e) => { e.preventDefault(); };
            const onDragLeave = (e) => { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } };
            // 实际导入由 Home 的 window 级 onDrop（inMusic 分支）统一处理并经 xdd:add-music 派发，
            // 这里只做 preventDefault 与视觉状态收尾，避免与统一路径重复导入
            const onDrop = (e) => {
                e.preventDefault();
                dragDepth.current = 0; setDragOver(false);
            };
            // 接收从主区域拖入的音频（落到非音乐面板时由题库拖放逻辑转发过来）
            React.useEffect(() => {
                const onAddMusic = (e) => { if (e && e.detail && e.detail.files && e.detail.files.length) addFileList(e.detail.files); };
                window.addEventListener('xdd:add-music', onAddMusic);
                return () => window.removeEventListener('xdd:add-music', onAddMusic);
            }, []);
            const removeTrack = (id) => {
                const idx = tracks.findIndex(t => t.id === id);
                if (idx === -1) return;
                const t = tracks[idx];
                if (t && t.url && t.url.startsWith('blob:')) idbDelete(id);
                const nt = tracks.filter(t => t.id !== id);
                if (idx === current) {
                    const a = audioRef.current;
                    if (a) { a.pause(); a.src = ''; }
                    setCurrent(-1); setPlaying(false); setProgress(0); setCur(0); setDuration(0);
                } else if (idx < current) {
                    setCurrent(current - 1);
                }
                setTracks(nt);
            };
            const playTrack = (idx) => loadAndPlay(idx);

            const curTrack = current >= 0 ? tracks[current] : null;

            return h('aside', { className: 'music-panel' + ((dragOver || extHover) ? ' drag-over' : '') + (extHover ? ' ext-drag' : ''), onDragEnter: onDragEnter, onDragOver: onDragOverP, onDragLeave: onDragLeave, onDrop: onDrop },
                (dragOver || extHover) && h('div', { className: 'drop-hint' }, extHover ? '这里只接收音频文件 🎵' : '松开以添加音乐 🎵'),
                h('div', { className: 'music-head', onClick: togglePlay, title: '点击播放 / 暂停' },
                    h('span', { className: 'm-ico' }, '🎵'),
                    h('span', { className: 'm-title' }, '音乐')
                ),
                h('div', { className: 'now-playing' + (playing ? ' playing' : ''), onClick: togglePlay, title: '点击播放 / 暂停' },
                    h('div', { className: 'np-cover' },
                        h('div', { ref: eqWrapRef, className: 'eq' + (playing ? '' : ' paused') },
                            h('span'), h('span'), h('span'), h('span'), h('span')
                        )
                    ),
                    h('div', { className: 'np-meta' },
                        h('div', { className: 'np-title' }, curTrack ? curTrack.title : '未选择曲目'),
                        curTrack
                            ? (curTrack.artist ? h('div', { className: 'np-artist' }, curTrack.artist) : null)
                            : h('div', { className: 'np-artist' }, '点击列表或添加音乐开始播放')
                    )
                ),
                h('div', { className: 'seek-row' },
                    h('span', { className: 't-cur' }, fmt(cur)),
                    h('input', { type: 'range', className: 'seek', min: 0, max: 1000, value: Math.round(progress * 1000), onChange: seek, disabled: !curTrack }),
                    h('span', { className: 't-dur' }, fmt(duration))
                ),
                h('div', { className: 'ctrl-row' },
                    h('button', { className: 'ctrl-btn sm' + (shuffle ? ' active' : ''), title: shuffle ? '随机播放：开' : '随机播放：关', onClick: () => { const ns = !shuffle; setShuffle(ns); if (ns) setRepeat('off'); } }, '🔀'),
                    h('button', { className: 'ctrl-btn', title: '上一首', onClick: onPrev }, '⏮'),
                    h('button', { className: 'ctrl-btn play', title: playing ? '暂停' : '播放', onClick: togglePlay }, playing ? '⏸' : '▶'),
                    h('button', { className: 'ctrl-btn', title: '下一首', onClick: onNext }, '⏭'),
                    h('button', { className: 'ctrl-btn sm' + (repeat !== 'off' ? ' active' : ''), title: repeat !== 'off' ? '循环播放（单曲）：开' : '循环播放（单曲）：关', onClick: () => { const on = repeat === 'off'; setRepeat(on ? 'one' : 'off'); if (on) setShuffle(false); } }, repeat !== 'off' ? '🔂' : '🔁')
                ),
                h('div', { className: 'vol-row' },
                    h('button', { className: 'vol-ico', onClick: toggleMute, title: muted ? '取消静音' : '静音' }, muted ? '🔇' : '🔊'),
                    h('button', { className: 'ctrl-btn sm balance-btn' + (balanceOn ? ' active' : ''), title: balanceOn ? '平衡音量：开（自动均衡各曲响度，同音量听起来一样响）' : '平衡音量：关（保持原始响度）', onClick: () => setBalanceOn(b => !b) }, '⚖'),
                    h('input', { type: 'range', className: 'vol', min: 0, max: 100, value: Math.round((muted ? 0 : volume) * 100), onChange: onVol }),
                    analyzing ? h('span', { className: 'vol-status' }, '分析中…') : null
                ),
                h('div', { className: 'add-row' },
                    h('button', { className: 'add-btn', onClick: () => fileRef.current && fileRef.current.click() }, '＋ 本地音乐'),
                    h('button', { className: 'add-btn', onClick: () => folderRef.current && folderRef.current.click() }, '📁 文件夹'),
                    h('input', { ref: fileRef, type: 'file', accept: 'audio/*', multiple: true, style: { display: 'none' }, onChange: addFiles }),
                    h('input', { ref: folderRef, type: 'file', multiple: true, webkitdirectory: '', directory: '', style: { display: 'none' }, onChange: addFolder })
                ),
                h('div', { className: 'pl-head' }, '播放列表', h('span', { className: 'pl-count' }, String(tracks.length))),
                h('div', { className: 'pl-list' },
                    tracks.length === 0
                        ? h('div', { className: 'pl-empty' }, '还没有歌曲，添加本地音乐或文件夹吧～')
                        : tracks.map((t, i) => h('div', { key: t.id, className: 'pl-item' + (i === current ? ' active' : ''), onClick: () => playTrack(i) },
                            h('span', { className: 'pl-ico' }, (i === current && playing) ? '🔊' : '🎶'),
                            h('div', { className: 'pl-info' },
                                h('div', { className: 'pl-title' }, t.title),
                                t.artist ? h('div', { className: 'pl-artist' }, t.artist) : null
                            ),
                            h('button', { className: 'pl-del', title: '移除', onClick: (e) => { e.stopPropagation(); removeTrack(t.id); } }, '✕')
                        ))
                ),
                h('audio', { ref: audioRef, onTimeUpdate: onTime, onLoadedMetadata: onMeta, onEnded: onEnded, onPlay: () => { setPlaying(true); ensureGraph(); applyGain(); startViz(); }, onPause: () => { setPlaying(false); stopViz(); } })
            );
        });

        // 结算面板组件（CountUp / ResultPanel）外置于 App 之外，作为模块级组件。
        // 原因：若定义在 App 函数体内，每次 App 因 context 更新而重渲染时都会生成新的组件类型引用，
        // React 会将其视为不同的组件而卸载重建，导致 .rp-card/.rp-row 入场动画与 CountUp 数字滚动动画反复重播。
        const CountUp = ({ value, duration = 1000, suffix = '' }) => {
            const [n, setN] = useState(0);
            useEffect(() => {
                let raf, startT;
                const tick = (t) => {
                    if (startT === undefined) startT = t;
                    const p = Math.min(1, (t - startT) / duration);
                    const eased = 1 - Math.pow(1 - p, 3);
                    setN(Math.round(value * eased));
                    if (p < 1) raf = requestAnimationFrame(tick);
                };
                raf = requestAnimationFrame(tick);
                return () => cancelAnimationFrame(raf);
            }, [value, duration]);
            return React.createElement("span", null, n + suffix);
        };
        const ResultPanel = ({ result, title, onRestart, onBack, stats }) => {
            const earned = result.earned || 0;
            const total = result.total || 0;
            const xp = result.xpGained || 0;
            const rate = total > 0 ? Math.round(earned / total * 100) : 0;
            const timeMs = result.timeSpent || 0;
            const mm = Math.floor(timeMs / 60000);
            const ss = Math.floor((timeMs % 60000) / 1000);
            const timeStr = (mm > 0 ? mm + ' 分 ' : '') + ss + ' 秒';
            const streak = (stats && stats.streak) || 0;
            const level = (stats && stats.level) || 1;
            const rows = [
                { ico: '⏱️', label: '本次用时', value: timeStr, cls: 'time' },
                { ico: '⭐', label: '获得分数', value: earned, suffix: ' / ' + total, cls: 'score', count: true },
                { ico: '⚡', label: '获得经验', value: xp, prefix: '+', cls: 'xp', count: true },
                { ico: '🎯', label: '正确率', value: rate, suffix: '%', cls: 'rate' },
                { ico: '🔥', label: '连续学习', value: streak, suffix: ' 天', cls: 'time' }
            ];
            return React.createElement("div", { className: "rp-overlay" },
                React.createElement("div", { className: "rp-card" },
                    React.createElement("div", { className: "rp-eyebrow" }, "差事已完成 · MISSION COMPLETE"),
                    React.createElement("h1", { className: "rp-title" }, title),
                    React.createElement("div", { className: "rp-sub" }, "本次共 " + (result.count || 0) + " 题　·　答对 " + (result.correctCount != null ? result.correctCount : '—') + " 题"),
                    result.leveledUp ? React.createElement("div", { className: "rp-levelup" }, "⭐ 等级提升　LV." + level + " ⭐") : null,
                    React.createElement("div", { className: "rp-rows" },
                        rows.map((r, i) => React.createElement("div", { className: "rp-row", style: { animationDelay: (0.12 + i * 0.08) + 's' }, key: i },
                            React.createElement("div", { className: "rp-label" },
                                React.createElement("span", { className: "rp-ico" }, r.ico),
                                React.createElement("span", null, r.label)
                            ),
                            React.createElement("div", { className: "rp-value " + r.cls },
                                r.prefix || '',
                                r.count ? React.createElement(CountUp, { value: r.value }) : r.value,
                                r.suffix ? React.createElement("span", { className: "rp-unit" }, r.suffix) : null
                            )
                        ))
                    ),
                    React.createElement("div", { className: "rp-foot" },
                        React.createElement("div", { className: "rp-total-label" }, "综合评级"),
                        React.createElement("div", { className: "rp-total" }, rate + "%",
                            React.createElement("small", null, "　·　LV." + level))
                    ),
                    React.createElement("div", { className: "rp-actions" },
                        React.createElement("button", { className: "rp-btn rp-btn-primary", onClick: onRestart }, "🔄 再来一次"),
                        React.createElement("button", { className: "rp-btn rp-btn-ghost", onClick: onBack }, "🏠 返回首页")
                    )
                )
            );
        };

        const App = () => {
            const { session, practiceSession, setSession, setPracticeSession, learnResult, practiceResult, setLearnResult, setPracticeResult } = useSession();
            const { stats } = useStats();
            const { decks, setDecks } = useData();
            const { mode, setMode } = useUi();
            const { startLearning, startPractice, startFavPractice } = useActions();
            const appShellRef = useRef(null);
            useEffect(() => {
                // 手写识别逻辑已移除，画板改为可导出图片 / 交由 AI 批改，无需预加载模型。
            }, []);
            // 仅触发原生全屏（兼容 webkit 前缀），UI 保持不变
            const enterFs = () => {
                const el = appShellRef.current; if (!el) return;
                const fn = el.requestFullscreen || el.webkitRequestFullscreen;
                if (fn) { const p = fn.call(el); if (p && p.catch) p.catch(() => {}); }
            };
            const exitFs = () => {
                const fn = document.exitFullscreen || document.webkitExitFullscreen;
                if (fn) { try { fn.call(document); } catch (_) {} }
            };
            const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
            const toggleImmersive = () => { if (isFs()) exitFs(); else enterFs(); };
            // 结算面板组件（CountUp / ResultPanel）已外置于 App 之外（见上层模块级定义），
            // 避免父组件重渲染时组件类型变化导致入场动画与数字滚动动画反复重播。

            let content;
            if (mode === 'generate') content = React.createElement(AIGenerator, null);
            else if (learnResult) content = React.createElement(ResultPanel, { result: learnResult, title: '🎉 答题完成', stats,
                onRestart: () => { setLearnResult(null); startLearning(learnResult.deckId); },
                onBack: () => { setLearnResult(null); setSession(null); setMode('home'); } });
            else if (mode === 'learn' && session) content = React.createElement(QuestionCard, null);
            else if (mode === 'wrong') content = React.createElement(WrongList, null);
            else if (mode === 'favorites') content = React.createElement(FavoritesList, null);
            else if (mode === 'me') content = React.createElement(MePage, null);
            else if (practiceResult) content = React.createElement(ResultPanel, { result: practiceResult, title: '🎉 练习完成', stats,
                onRestart: () => { setPracticeResult(null); const items = practiceSession ? practiceSession.items : []; if (practiceResult.kind === 'favorite') startFavPractice(items); else startPractice(items); },
                onBack: () => { setPracticeResult(null); setPracticeSession(null); setMode(practiceResult.kind === 'favorite' ? 'favorites' : 'wrong'); } });
            else if (mode === 'practice' && practiceSession) content = React.createElement(PracticeCard, null);
            else content = React.createElement(Home, null);

            return React.createElement("div", { className: "app-shell" + (mode === 'generate' || mode === 'learn' || mode === 'practice' || mode === 'wrong' || mode === 'favorites' ? " mode-fill" : ""), ref: appShellRef },
                React.createElement(Sidebar, null),
                React.createElement("main", { className: mode === 'home' ? "main-content home-mode" : (mode === 'wrong' || mode === 'favorites' || mode === 'generate') ? "main-content wf-fill" : "main-content" },
                    React.createElement(LearnTimeProvider, { session, practiceSession, decks, setDecks, mode },
                        React.createElement(TopBar, { onImmersive: toggleImmersive })
                    ),
                    React.createElement("div", { className: mode === 'home' ? "content-wrap home-mode" : (mode === 'wrong' || mode === 'favorites') ? "content-wrap wf-mode" : "content-wrap" }, content)
                ),
                React.createElement(MusicPlayer, null),
                React.createElement(ScratchPad, null)
            );
        };

        // ============================================================
        // 18.x LaTeX 输入补全（Tab / Enter 触发，IDE 代码补全风格）
        // ============================================================
        const installLatexAutocomplete = () => {
            if (window.__latexAcInstalled) return;
            window.__latexAcInstalled = true;

            // 命令词典：t=触发词(不含反斜杠,小写)  s=插入片段  d=说明  c=光标落点(默认片段末尾；含 "\name{}" 时进入首对花括号；环境类显式指定)
            const LATEX_RAW = [
                // 希腊字母（小写）
                ['alpha','\\alpha','希腊字母 α'],['beta','\\beta','希腊字母 β'],['gamma','\\gamma','希腊字母 γ'],
                ['delta','\\delta','希腊字母 δ'],['epsilon','\\epsilon','希腊字母 ε'],['varepsilon','\\varepsilon','变体 ε'],
                ['zeta','\\zeta','希腊字母 ζ'],['eta','\\eta','希腊字母 η'],['theta','\\theta','希腊字母 θ'],
                ['vartheta','\\vartheta','变体 θ'],['iota','\\iota','希腊字母 ι'],['kappa','\\kappa','希腊字母 κ'],
                ['lambda','\\lambda','希腊字母 λ'],['mu','\\mu','希腊字母 μ'],['nu','\\nu','希腊字母 ν'],
                ['xi','\\xi','希腊字母 ξ'],['pi','\\pi','希腊字母 π'],['rho','\\rho','希腊字母 ρ'],
                ['sigma','\\sigma','希腊字母 σ'],['tau','\\tau','希腊字母 τ'],['upsilon','\\upsilon','希腊字母 υ'],
                ['phi','\\phi','希腊字母 φ'],['varphi','\\varphi','变体 φ'],['chi','\\chi','希腊字母 χ'],
                ['psi','\\psi','希腊字母 ψ'],['omega','\\omega','希腊字母 ω'],
                // 希腊字母（大写）
                ['Gamma','\\Gamma','大写 Γ'],['Delta','\\Delta','大写 Δ'],['Theta','\\Theta','大写 Θ'],
                ['Lambda','\\Lambda','大写 Λ'],['Xi','\\Xi','大写 Ξ'],['Pi','\\Pi','大写 Π'],
                ['Sigma','\\Sigma','大写 Σ'],['Phi','\\Phi','大写 Φ'],['Psi','\\Psi','大写 Ψ'],['Omega','\\Omega','大写 Ω'],
                // 运算 / 关系符号
                ['cdot','\\cdot','点乘 ·'],['times','\\times','乘号 ×'],['div','\\div','除号 ÷'],
                ['pm','\\pm','正负 ±'],['mp','\\mp','负正 ∓'],['ast','\\ast','星号 *'],['star','\\star','★'],
                ['circ','\\circ','圈 °'],['bullet','\\bullet','•'],['oplus','\\oplus','⊕'],['otimes','\\otimes','⊗'],['odot','\\odot','⊙'],
                ['leq','\\leq','≤'],['geq','\\geq','≥'],['neq','\\neq','≠'],['approx','\\approx','≈'],['equiv','\\equiv','≡'],
                ['cong','\\cong','≅'],['sim','\\sim','∼'],['simeq','\\simeq','≃'],['propto','\\propto','∝'],
                ['ll','\\ll','≪'],['gg','\\gg','≫'],['in','\\in','∈'],['notin','\\notin','∉'],['ni','\\ni','∋'],
                ['subset','\\subset','⊂'],['subseteq','\\subseteq','⊆'],['supset','\\supset','⊃'],['supseteq','\\supseteq','⊇'],
                ['cup','\\cup','∪'],['cap','\\cap','∩'],['setminus','\\setminus','集合差 \\'],['forall','\\forall','∀'],
                ['exists','\\exists','∃'],['nexists','\\nexists','∄'],['neg','\\neg','¬'],['land','\\land','∧'],['lor','\\lor','∨'],
                ['implies','\\implies','⇒'],['iff','\\iff','⇔'],['emptyset','\\emptyset','∅'],['varnothing','\\varnothing','∅'],
                ['infty','\\infty','∞'],['partial','\\partial','∂'],['nabla','\\nabla','∇'],['prime','\\prime','′'],
                ['angle','\\angle','∠'],['deg','\\deg','°'],['top','\\top','⊤'],['bot','\\bot','⊥'],['Re','\\Re','ℜ'],
                ['Im','\\Im','ℑ'],['aleph','\\aleph','ℵ'],['hbar','\\hbar','ℏ'],['ell','\\ell','ℓ'],['wp','\\wp','℘'],
                ['flat','\\flat','♭'],['natural','\\natural','♮'],['sharp','\\sharp','♯'],
                ['le','\\le','≤(简写)'],['ge','\\ge','≥(简写)'],['ne','\\ne','≠(简写)'],
                ['perp','\\perp','垂直 ⊥'],['prec','\\prec','≺'],['succ','\\succ','≻'],
                ['preceq','\\preceq','≼'],['succeq','\\succeq','≽'],['models','\\models','⊨'],
                ['vdash','\\vdash','⊢'],['dashv','\\dashv','⊣'],
                ['subsetneq','\\subsetneq','⊊'],['supsetneq','\\supsetneq','⊋'],
                ['vee','\\vee','∨(或)'],['wedge','\\wedge','∧(与)'],
                ['rightarrow','\\rightarrow','→'],['Rightarrow','\\Rightarrow','⇒'],['longrightarrow','\\longrightarrow','⟶'],
                ['leftarrow','\\leftarrow','←'],['Leftarrow','\\Leftarrow','⇐'],['leftrightarrow','\\leftrightarrow','↔'],
                ['Leftrightarrow','\\Leftrightarrow','⇔'],['mapsto','\\mapsto','↦'],['to','\\to','→(简写)'],
                ['uparrow','\\uparrow','↑'],['downarrow','\\downarrow','↓'],
                ['updownarrow','\\updownarrow','↕'],['nearrow','\\nearrow','↗'],['searrow','\\searrow','↘'],
                ['nwarrow','\\nwarrow','↖'],['swarrow','\\swarrow','↙'],
                ['Longrightarrow','\\Longrightarrow','⟹'],['Longleftarrow','\\Longleftarrow','⟸'],
                ['Longleftrightarrow','\\Longleftrightarrow','⟺'],
                ['R','\\mathbb{R}','实数集 ℝ'],['Q','\\mathbb{Q}','有理数 ℚ'],['Z','\\mathbb{Z}','整数集 ℤ'],
                ['N','\\mathbb{N}','自然数 ℕ'],['C','\\mathbb{C}','复数 ℂ'],
                ['langle','\\langle','⟨'],['rangle','\\rangle','⟩'],['lfloor','\\lfloor','⌊'],['rfloor','\\rfloor','⌋'],
                ['lceil','\\lceil','⌈'],['rceil','\\rceil','⌉'],['mid','\\mid','∣'],['parallel','\\parallel','∥'],
                ['backslash','\\backslash','反斜杠'],['ldots','\\ldots','…'],['cdots','\\cdots','⋯'],['vdots','\\vdots','⋮'],['ddots','\\ddots','⋱'],
                // 函数 / 算子
                ['frac','\\frac{}{}','分式 a/b'],['dfrac','\\dfrac{}{}','display 分式'],['tfrac','\\tfrac{}{}','小分式'],
                ['sqrt','\\sqrt{}','根号'],['sum','\\sum','求和 Σ'],['prod','\\prod','求积 ∏'],['coprod','\\coprod','∐'],
                ['int','\\int','积分 ∫'],                ['iint','\\iint','二重积分'],['iiint','\\iiint','三重积分'],['oint','\\oint','环路积分'],
                ['lim','\\lim','极限'],['log','\\log','log'],['ln','\\ln','ln'],['lg','\\lg','lg'],
                ['sin','\\sin','sin'],['cos','\\cos','cos'],
                ['tan','\\tan','tan'],['cot','\\cot','cot'],['sec','\\sec','sec'],['csc','\\csc','csc'],['exp','\\exp','exp'],
                ['det','\\det','det'],['dim','\\dim','dim'],['max','\\max','max'],['min','\\min','min'],['sup','\\sup','sup'],
                ['inf','\\inf','inf'],['arg','\\arg','arg'],['gcd','\\gcd','gcd'],['Pr','\\Pr','Pr'],
                ['binom','\\binom{}{}','二项式系数'],['sqrtn','\\sqrt[n]{}','n 次根'],
                ['limsup','\\limsup','上极限'],['liminf','\\liminf','下极限'],
                ['bmod','\\bmod','二元取模'],['pmod','\\pmod{}','带括号取模'],['mod','\\mod','取模'],
                // 重音 / 修饰
                ['vec','\\vec{}','向量 →'],['hat','\\hat{}','帽 ^'],['bar','\\bar{}','横杠 ¯'],['tilde','\\tilde{}','波浪 ~'],
                ['dot','\\dot{}','点'],['ddot','\\ddot{}','双点'],['overline','\\overline{}','上划线'],['underline','\\underline{}','下划线'],
                ['widehat','\\widehat{}','宽帽'],['widetilde','\\widetilde{}','宽波浪'],['check','\\check{}','∨'],['breve','\\breve{}','˘'],
                ['acute','\\acute{}','´'],['grave','\\grave{}','`'],['mathring','\\mathring{}','˚'],
                ['overrightarrow','\\overrightarrow{}','上箭头'],['overleftarrow','\\overleftarrow{}','下箭头'],
                // 括号 / 定界符
                ['left','\\left( \\right)','左圆括号(自动配对)',6],['leftb','\\left[ \\right]','左方括号(自动配对)',6],
                ['leftc','\\left\\{ \\right\\}','左花括号(自动配对)',6],['bigl','\\bigl','大左定界'],['bigr','\\bigr','大右定界'],
                ['Bigl','\\Bigl','更大左定界'],['Bigr','\\Bigr','更大右定界'],
                ['vert','\\vert','竖线 ∣'],['Vert','\\Vert','双竖线 ‖'],
                // 字体 / 格式
                ['mathbf','\\mathbf{}','粗体'],['mathrm','\\mathrm{}','正体'],['mathsf','\\mathsf{}','无衬线'],
                ['mathit','\\mathit{}','斜体'],['mathtt','\\mathtt{}','等宽'],['mathcal','\\mathcal{}','花体'],
                ['mathbb','\\mathbb{}','黑板粗体'],['mathfrak','\\mathfrak{}','哥特体'],['boldsymbol','\\boldsymbol{}','粗斜体'],
                ['text','\\text{}','文本'],['textbf','\\textbf{}','粗文本'],['textit','\\textit{}','斜文本'],['textrm','\\textrm{}','正文本'],['texttt','\\texttt{}','等宽文本'],
                ['boxed','\\boxed{}','框选'],
                // 上下标 / 大符号
                ['overset','\\overset{}{}','上放置'],['underset','\\underset{}{}','下放置'],
                ['overbrace','\\overbrace{}','上花括号'],['underbrace','\\underbrace{}','下花括号'],
                ['color','\\color{}','颜色'],['textcolor','\\textcolor{}{}','指定颜色文本'],
                ['displaystyle','\\displaystyle','行间样式'],['limits','\\limits','上下限置于正上下方'],
                ['operatorname','\\operatorname{}','自定义算子'],
                ['dots','\\dots','⋯(基线)'],['dotsc','\\dotsc','⋯(标点后)'],['dotsb','\\dotsb','⋯(二元算子)'],['dotsm','\\dotsm','⋯(乘)'],['dotsi','\\dotsi','⋯(积分)'],
                // 间距
                ['quad','\\quad','大间距'],['qquad','\\qquad','更大间距'],['space','\\space','空格'],['thinsp','\\,','细间距'],['medsp','\\;','中间距'],['negsp','\\!','负间距'],
                // 矩阵 / 环境
                ['begin','\\begin{matrix}\n  \n\\end{matrix}','矩阵',17],
                ['pmatrix','\\begin{pmatrix}\n  \n\\end{pmatrix}','圆括号矩阵',18],
                ['bmatrix','\\begin{bmatrix}\n  \n\\end{bmatrix}','方括号矩阵',18],
                ['Bmatrix','\\begin{Bmatrix}\n  \n\\end{Bmatrix}','花括号矩阵',18],
                ['vmatrix','\\begin{vmatrix}\n  \n\\end{vmatrix}','行列式',18],
                ['Vmatrix','\\begin{Vmatrix}\n  \n\\end{Vmatrix}','双竖线行列式',18],
                ['cases','\\begin{cases}\n  \n\\end{cases}','分段函数',16],
                ['align','\\begin{align}\n  \n\\end{align}','对齐公式',16],
                ['aligned','\\begin{aligned}\n  \n\\end{aligned}','内联对齐',18],
                ['gather','\\begin{gather}\n  \n\\end{gather}','居中对齐',18],
                ['array','\\begin{array}{cc}\n  \n\\end{array}','表格阵列',22],
                ['matrix','\\begin{matrix}\n  \n\\end{matrix}','无括号矩阵',17],
                ['split','\\begin{split}\n  \n\\end{split}','公式拆分',17],
                ['smallmatrix','\\begin{smallmatrix}\n  \n\\end{smallmatrix}','行内小矩阵',24],
                ['substack','\\substack{ \\\\ }','多行下标',11],
                ['tag','\\tag{}','公式编号',6],
                // ===== 扩展：更多希腊字母 =====
                ['digamma','\\digamma','希腊字母 ϝ'],['varkappa','\\varkappa','希腊字母 ϰ'],['varrho','\\varrho','变体 ρ'],['varpi','\\varpi','变体 π'],
                // ===== 否定关系符 =====
                ['nleq','\\nleq','≰'],['ngeq','\\ngeq','≱'],['nless','\\nless','≮'],['ngtr','\\ngtr','≯'],
                ['nprec','\\nprec','⊀'],['nsucc','\\nsucc','⊁'],['nsim','\\nsim','≁'],['ncong','\\ncong','≇'],
                ['nparallel','\\nparallel','∦'],['nmid','\\nmid','∤'],['nsubseteq','\\nsubseteq','⊈'],['nsupseteq','\\nsupseteq','⊉'],
                ['nvDash','\\nvDash','⊭'],['nvdash','\\nvdash','⊬'],['ntriangleleft','\\ntriangleleft','⋪'],['ntriangleright','\\ntriangleright','⋫'],
                ['ntrianglelefteq','\\ntrianglelefteq','⋬'],['ntrianglerighteq','\\ntrianglerighteq','⋭'],
                ['nLeftarrow','\\nLeftarrow','⇍'],['nRightarrow','\\nRightarrow','⇏'],['nLeftrightarrow','\\nLeftrightarrow','⇎'],
                ['nrightarrow','\\nrightarrow','↛'],['nleftarrow','\\nleftarrow','↚'],['nleftrightarrow','\\nleftrightarrow','↮'],
                // ===== 更多关系符 =====
                ['doteq','\\doteq','≐'],['doteqdot','\\doteqdot','≑'],['risingdotseq','\\risingdotseq','≓'],['fallingdotseq','\\fallingdotseq','≒'],
                ['eqcirc','\\eqcirc','≖'],['circeq','\\circeq','≗'],['triangleq','\\triangleq','≜'],
                ['lesssim','\\lesssim','≲'],['gtrsim','\\gtrsim','≳'],['lessgtr','\\lessgtr','≶'],['gtrless','\\gtrless','≷'],
                ['lesseqgtr','\\lesseqgtr','⋚'],['gtreqless','\\gtreqless','⋛'],['lesseqqgtr','\\lesseqqgtr','⪋'],['gtreqqless','\\gtreqqless','⪌'],
                ['eqsim','\\eqsim','≂'],['lessdot','\\lessdot','⋖'],['gtrdot','\\gtrdot','⋗'],['lll','\\lll','⋘'],['ggg','\\ggg','⋙'],
                ['leqq','\\leqq','≦'],['geqq','\\geqq','≧'],['lneq','\\lneq','⪇'],['gneq','\\gneq','⪈'],['lneqq','\\lneqq','≨'],['gneqq','\\gneqq','≩'],
                ['between','\\between','≬'],['pitchfork','\\pitchfork','⋔'],['vartriangle','\\vartriangle','△'],['triangleright','\\triangleright','▷'],
                ['triangleleft','\\triangleleft','◁'],['sqsubset','\\sqsubset','⊏'],['sqsupset','\\sqsupset','⊐'],['sqsubseteq','\\sqsubseteq','⊑'],
                ['sqsupseteq','\\sqsupseteq','⊒'],['sqcap','\\sqcap','⊓'],['sqcup','\\sqcup','⊔'],['uplus','\\uplus','⊎'],
                ['dotplus','\\dotplus','∔'],['smallsetminus','\\smallsetminus','∖'],['curlywedge','\\curlywedge','⋏'],['curlyvee','\\curlyvee','⋎'],
                ['veebar','\\veebar','⊻'],['barwedge','\\barwedge','⊼'],['doublebarwedge','\\doublebarwedge','⌆'],
                ['boxplus','\\boxplus','⊞'],['boxminus','\\boxminus','⊟'],['boxtimes','\\boxtimes','⊠'],['boxdot','\\boxdot','⊡'],
                ['circleddash','\\circleddash','⊝'],['circledast','\\circledast','⊛'],['circledcirc','\\circledcirc','⊚'],['centerdot','\\centerdot','⋅'],
                ['divideontimes','\\divideontimes','⋇'],['leftthreetimes','\\leftthreetimes','⋋'],['rightthreetimes','\\rightthreetimes','⋌'],
                ['backepsilon','\\backepsilon','∍'],['because','\\because','∵'],['therefore','\\therefore','∴'],
                ['mathbin','\\mathbin{}','二元算子类'],['mathrel','\\mathrel{}','关系符类'],['mathopen','\\mathopen{}','左界类'],['mathclose','\\mathclose{}','右界类'],['mathpunct','\\mathpunct{}','标点类'],
                ['lhd','\\lhd','◁(半序)'],['rhd','\\rhd','▷(半序)'],['unlhd','\\unlhd','⊴'],['unrhd','\\unrhd','⊵'],
                ['asymp','\\asymp','≍'],['bowtie','\\bowtie','⋈'],['Vdash','\\Vdash','⊪'],['Vvdash','\\Vvdash','⊫'],['vDash','\\vDash','⊨'],
                ['nVdash','\\nVdash','⊯'],['nVDash','\\nVDash','⊮'],['shortmid','\\shortmid','∣'],['shortparallel','\\shortparallel','∥'],
                ['nshortmid','\\nshortmid','∤'],['nshortparallel','\\nshortparallel','∦'],['wr','\\wr','≀'],
                ['eqslantless','\\eqslantless','⪕'],['eqslantgtr','\\eqslantgtr','⪖'],['gtrapprox','\\gtrapprox','⪆'],['lessapprox','\\lessapprox','⪅'],
                ['approxeq','\\approxeq','≊'],['trianglelefteq','\\trianglelefteq','⊴'],['trianglerighteq','\\trianglerighteq','⊵'],
                ['smallfrown','\\smallfrown','⌢'],['smallsmile','\\smallsmile','⌣'],['frown','\\frown','⌒'],['smile','\\smile','⌣'],
                // ===== 更多二元运算符 =====
                ['amalg','\\amalg','⨿'],['eth','\\eth','ð'],['hslash','\\hslash','ℏ'],
                ['iiiint','\\iiiint','四重积分'],['idotsint','\\idotsint','∫⋯∫'],['smallint','\\smallint','∫'],['oiint','\\oiint','∯'],['oiiint','\\oiiint','∰'],
                ['varointclockwise','\\varointclockwise','∱'],['ointctrclockwise','\\ointctrclockwise','∲'],['sqiint','\\sqiint','∳'],
                ['rtimes','\\rtimes','⋈'],['ltimes','\\ltimes','⋉'],
                // ===== 大型运算符 =====
                ['bigcap','\\bigcap','∩ 大'],['bigcup','\\bigcup','∪ 大'],['bigoplus','\\bigoplus','⊕ 大'],['bigotimes','\\bigotimes','⊗ 大'],
                ['bigodot','\\bigodot','⊙ 大'],['biguplus','\\biguplus','⊎ 大'],['bigsqcap','\\bigsqcap','⊓ 大'],['bigsqcup','\\bigsqcup','⊔ 大'],
                ['bigvee','\\bigvee','∨ 大'],['bigwedge','\\bigwedge','∧ 大'],
                // ===== 更多箭头 =====
                ['Uparrow','\\Uparrow','⇑'],['Downarrow','\\Downarrow','⇓'],['Updownarrow','\\Updownarrow','⇕'],
                ['leftrightarrows','\\leftrightarrows','⇆'],['leftleftarrows','\\leftleftarrows','⇇'],['rightrightarrows','\\rightrightarrows','⇉'],['rightleftarrows','\\rightleftarrows','⇄'],
                ['twoheadrightarrow','\\twoheadrightarrow','↠'],['twoheadleftarrow','\\twoheadleftarrow','↞'],['rightarrowtail','\\rightarrowtail','↣'],['leftarrowtail','\\leftarrowtail','↢'],
                ['looparrowright','\\looparrowright','↬'],['looparrowleft','\\looparrowleft','↫'],['leftrightharpoons','\\leftrightharpoons','⇋'],['rightleftharpoons','\\rightleftharpoons','⇌'],
                ['curvearrowleft','\\curvearrowleft','↶'],['curvearrowright','\\curvearrowright','↷'],['circlearrowleft','\\circlearrowleft','↺'],['circlearrowright','\\circlearrowright','↻'],
                ['Lsh','\\Lsh','↰'],['Rsh','\\Rsh','↱'],['upuparrows','\\upuparrows','⇈'],['downdownarrows','\\downdownarrows','⇊'],
                ['multimap','\\multimap','⊸'],['rightsquigarrow','\\rightsquigarrow','⇝'],['leftrightsquigarrow','\\leftrightsquigarrow','⇜'],
                ['dashrightarrow','\\dashrightarrow','⇢'],['dashleftarrow','\\dashleftarrow','⇠'],['hookrightarrow','\\hookrightarrow','↪'],['hookleftarrow','\\hookleftarrow','↩'],
                ['longmapsto','\\longmapsto','⟼'],
                // ===== 更多函数 =====
                ['arcsin','\\arcsin','反正弦'],['arccos','\\arccos','反余弦'],['arctan','\\arctan','反正切'],
                ['sinh','\\sinh','双曲正弦'],['cosh','\\cosh','双曲余弦'],['tanh','\\tanh','双曲正切'],['coth','\\coth','双曲余切'],
                ['hom','\\hom','hom'],['ker','\\ker','ker'],
                // ===== 更多重音 / 修饰 =====
                ['dddot','\\dddot{}','三点上'],['ddddot','\\ddddot{}','四点上'],['sideset','\\sideset{}{}','两侧标注'],
                ['imath','\\imath','无点 i'],['jmath','\\jmath','无点 j'],
                ['underrightarrow','\\underrightarrow{}','下箭头'],['underleftarrow','\\underleftarrow{}','下箭头左'],['underleftrightarrow','\\underleftrightarrow{}','下双向箭头'],
                ['overleftrightarrow','\\overleftrightarrow{}','上双向箭头'],
                // ===== 定界符 / 括号 =====
                ['ulcorner','\\ulcorner','⌜'],['urcorner','\\urcorner','⌝'],['llcorner','\\llcorner','⌞'],['lrcorner','\\lrcorner','⌟'],
                ['lmoustache','\\lmoustache','⎰'],['rmoustache','\\rmoustache','⎱'],['arrowvert','\\arrowvert','∣'],['Arrowvert','\\Arrowvert','‖'],
                ['bracevert','\\bracevert','⎪'],['lgroup','\\lgroup','⌊'],['rgroup','\\rgroup','⌋'],
                ['colon','\\colon',':'],['lbrace','\\lbrace','{'],['rbrace','\\rbrace','}'],['lbrack','\\lbrack','['],['rbrack','\\rbrack',']'],
                ['big','\\big','定界尺寸'],['Big','\\Big','定界尺寸'],['bigg','\\bigg','定界尺寸'],['Bigg','\\Bigg','定界尺寸'],
                ['bigm','\\bigm','中定界'],['biggm','\\biggm','中大定界'],
                // ===== 字体 / 格式 =====
                ['mathnormal','\\mathnormal{}','常规数学体'],['pmb','\\pmb{}','重粗体'],
                ['colorbox','\\colorbox{}{}','底色框'],['fcolorbox','\\fcolorbox{}{}{}','边框底色框'],
                ['cfrac','\\cfrac{}{}','连分式'],['dbinom','\\dbinom{}{}','display 二项式'],['tbinom','\\tbinom{}{}','小二项式'],
                // ===== 杂项符号 =====
                ['checkmark','\\checkmark','✓'],['circledR','\\circledR','®'],['circledS','\\circledS','Ⓢ'],['complement','\\complement','∁'],
                ['diagdown','\\diagdown','╲'],['diagup','\\diagup','╱'],['Bbbk','\\Bbbk','𝕜'],['blacksquare','\\blacksquare','■'],
                ['square','\\square','□'],['triangle','\\triangle','△'],['triangledown','\\triangledown','▽'],['lozenge','\\lozenge','◇'],
                ['blacklozenge','\\blacklozenge','◆'],['bigstar','\\bigstar','★'],['bigcirc','\\bigcirc','◯'],
                ['spadesuit','\\spadesuit','♠'],['heartsuit','\\heartsuit','♥'],['diamondsuit','\\diamondsuit','♦'],['clubsuit','\\clubsuit','♣'],
                ['backprime','\\backprime','‵'],['dagger','\\dagger','†'],['ddagger','\\ddagger','‡'],
                ['LaTeX','\\LaTeX','LaTeX 标志'],['TeX','\\TeX','TeX 标志'],['not','\\not','否定前缀'],['surd','\\surd','√'],
                ['measuredangle','\\measuredangle','∡'],['sphericalangle','\\sphericalangle','∢'],
                ['Finv','\\Finv','Ⅎ'],['Game','\\Game','⅁'],['beth','\\beth','ℶ'],['gimel','\\gimel','ℷ'],['daleth','\\daleth','ℸ'],
                ['blacktriangle','\\blacktriangle','▲'],['blacktriangledown','\\blacktriangledown','▼'],['blacktriangleleft','\\blacktriangleleft','◀'],['blacktriangleright','\\blacktriangleright','▶']
            ];
            const LATEX_CMDS = LATEX_RAW.map(([t, s, d, c]) => {
                const caret = (c != null) ? c : (s.match(/^\\[A-Za-z]+\{\}/) ? s.indexOf('{') + 1 : s.length);
                return { t: String(t).toLowerCase(), s, d: d || '', c: caret };
            });

            const computeCandidates = (query) => {
                const q = (query || '').toLowerCase();
                if (!q) return [];
                const out = [];
                for (const e of LATEX_CMDS) if (e.t.indexOf(q) === 0) out.push(e);
                return out;
            };

            const getToken = (el) => {
                const pos = el.selectionStart;
                if (pos == null || pos <= 0) return null;
                const text = el.value;
                let j = pos;
                while (j > 0 && /[A-Za-z]/.test(text[j - 1])) j--;
                if (j > 0 && text[j - 1] === '\\') return { start: j - 1, end: pos, token: text.slice(j - 1, pos) };
                return null;
            };

            const _ac = { el: null, box: null, items: [], index: 0, tok: null };
            // 滚动关闭弹窗的处理函数（独立引用，便于在 showBox 挂载、hideAc 卸载时增删，避免全局常驻监听）
            const _acOnScrollClose = (e) => {
                if (_ac.box && _ac.box.contains(e.target)) return;
                hideAc();
            };

            const ensureBox = () => {
                if (_ac.box) return _ac.box;
                const box = document.createElement('div');
                box.id = 'latex-ac';
                box.style.display = 'none';
                // 被动监听改为非被动，以便滚轮切换候选时能 preventDefault
                box.addEventListener('wheel', onBoxWheel, { passive: false });
                document.body.appendChild(box);
                _ac.box = box;
                return box;
            };

            const hideAc = () => {
                window.removeEventListener('scroll', _acOnScrollClose, true);
                window.removeEventListener('resize', hideAc);
                _ac.items = []; _ac.el = null; _ac.tok = null; _ac.index = 0;
                if (_ac.box) _ac.box.style.display = 'none';
            };

            const renderBox = () => {
                const box = ensureBox();
                const items = _ac.items;
                const max = Math.min(items.length, 60);
                let html = '<div class="latex-ac-list">';
                for (let i = 0; i < max; i++) {
                    const e = items[i];
                    const active = i === _ac.index ? ' active' : '';
                    html += '<div class="latex-ac-item' + active + '" data-i="' + i + '">' +
                        '<code class="latex-ac-cmd">' + escapeHtml(e.s) + '</code>' +
                        '<span class="latex-ac-desc">' + escapeHtml(e.d) + '</span></div>';
                }
                html += '</div>';
                const act = items[_ac.index];
                if (act) {
                    const delim = act.s.indexOf('\n') >= 0 ? '$$' : '$';
                    html += '<div class="latex-ac-preview"><span class="latex-ac-hint">预览</span>' +
                        latexToHtml(delim + act.s + delim) + '</div>';
                }
                html += '<div class="latex-ac-foot">Tab / Enter 补全 · ↑↓ / 滚轮 切换 · Esc 关闭</div>';
                box.innerHTML = html;
                box.querySelectorAll('.latex-ac-item').forEach((r) => {
                    r.addEventListener('mousedown', (ev) => {
                        ev.preventDefault();
                        acceptAc(parseInt(r.getAttribute('data-i'), 10));
                    });
                });
                // 选中项自动滚入可视区域（仅滚动弹窗自身，不影响页面）
                const actEl = box.querySelector('.latex-ac-item.active');
                if (actEl) {
                    const top = actEl.offsetTop, bottom = top + actEl.offsetHeight;
                    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 4);
                    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 4;
                }
            };

            const showBox = (el) => {
                const box = ensureBox();
                box.style.display = 'block';
                const r = el.getBoundingClientRect();
                const bw = box.offsetWidth, bh = box.offsetHeight;
                const vw = window.innerWidth, vh = window.innerHeight;
                let left = r.left;
                let top = r.bottom + 4;
                if (left + bw > vw - 8) left = Math.max(8, vw - bw - 8);
                if (top + bh > vh - 8) top = Math.max(8, r.top - bh - 4);
                box.style.left = left + 'px';
                box.style.top = top + 'px';
                // 仅在弹窗显示期间挂载滚动/缩放监听（先移除再添加，避免重复挂载）
                window.removeEventListener('scroll', _acOnScrollClose, true);
                window.addEventListener('scroll', _acOnScrollClose, true);
                window.removeEventListener('resize', hideAc);
                window.addEventListener('resize', hideAc);
            };

            const moveIndex = (d) => {
                const n = _ac.items.length; if (!n) return;
                _ac.index = (_ac.index + d + n) % n;
                renderBox(); showBox(_ac.el);
            };

            const applyCompletion = (el, tok, entry) => {
                const text = el.value;
                const before = text.slice(0, tok.start);
                const after = text.slice(tok.end);
                const newText = before + entry.s + after;
                const caret = Math.min(Math.max(0, tok.start + entry.c), newText.length);
                el.focus();
                // 受控组件兼容：用“原生 value setter”写入，绕过 React 在实例上安装的值追踪器。
                // 否则 React 会认为“值未变化”而不触发 onChange，导致补全结果被下一次渲染覆盖掉（表现为插不进去/被吞）。
                const proto = el.tagName === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                nativeValueSetter.call(el, newText);
                try { el.setSelectionRange(caret, caret); } catch (e) {}
                el.dispatchEvent(new Event('input', { bubbles: true }));
                // React 在 onChange 后重渲染会用受控值重置 value 与光标，待提交后再恢复光标位置
                const restoreCaret = () => {
                    try {
                        if (document.activeElement !== el) el.focus();
                        const p = Math.min(Math.max(0, caret), el.value.length);
                        el.setSelectionRange(p, p);
                    } catch (e) {}
                };
                requestAnimationFrame(restoreCaret);
                setTimeout(restoreCaret, 0);
            };

            const acceptAc = (i) => {
                const el = _ac.el, tok = _ac.tok, entry = _ac.items[i];
                hideAc();
                if (el && entry) applyCompletion(el, tok, entry);
            };

            const openFor = (el, tok) => {
                const items = computeCandidates(tok.token.slice(1));
                if (!items.length) { hideAc(); return; }
                _ac.el = el; _ac.tok = tok; _ac.items = items; _ac.index = 0;
                renderBox(); showBox(el);
            };

            const onKeyDown = (e) => {
                const el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
                if (el.getAttribute('data-latex') !== '1') return;
                if (_ac.el === el && _ac.items.length) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); moveIndex(1); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); moveIndex(-1); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(_ac.index); return; }
                    if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
                }
                if (e.key === 'Tab') {
                    const tok = getToken(el);
                    if (!tok) return; // 无 \token，Tab 正常切换焦点
                    const items = computeCandidates(tok.token.slice(1));
                    if (!items.length) { e.preventDefault(); return; } // 无匹配：吞掉避免焦点跳转
                    e.preventDefault();
                    if (items.length === 1) applyCompletion(el, tok, items[0]);
                    else openFor(el, tok);
                }
            };

            const onInput = (e) => {
                const el = e.target;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
                if (el.getAttribute('data-latex') !== '1') return;
                if (_ac.el && _ac.el !== el) hideAc();
                const tok = getToken(el);
                if (!tok) { hideAc(); return; }
                const q = tok.token.slice(1);
                const items = computeCandidates(q);
                // 已完整输完某个命令时不重新弹窗（避免补全后再次弹出）
                if (items.length === 1 && items[0].t === q) { hideAc(); return; }
                if (items.length) { _ac.el = el; _ac.tok = tok; _ac.items = items; if (_ac.index >= items.length) _ac.index = 0; renderBox(); showBox(el); }
                else hideAc();
            };

            const onMouseDown = (e) => {
                if (_ac.box && !_ac.box.contains(e.target) && e.target !== _ac.el) hideAc();
            };

            // 在弹出框上滚动鼠标滚轮 = 切换候选高亮（不滚动页面/弹窗内容）
            const onBoxWheel = (e) => {
                if (!_ac.box || _ac.box.style.display === 'none') return;
                if (!_ac.items.length) return;
                e.preventDefault();
                moveIndex(e.deltaY > 0 ? 1 : -1);
            };

            document.addEventListener('keydown', onKeyDown, true);
            document.addEventListener('input', onInput, true);
            document.addEventListener('mousedown', onMouseDown, true);
            window.addEventListener('blur', hideAc);
        };

        // ============================================================
        // 19. 渲染
        // ============================================================
        // 设备检测：手机 / 平板不提供适配，拦截并提示使用电脑
        function isMobileDevice() {
            var ua = navigator.userAgent || '';
            if (/Mobi|Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Tablet/i.test(ua)) return true;
            if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true; // iPadOS 伪装成 Mac
            if (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 500) return true; // 触屏竖屏手机兜底
            return false;
        }
        if (isMobileDevice()) {
            document.getElementById('root').innerHTML =
                '<div class="mobile-block">' +
                '<div class="ico">🖥️</div>' +
                '<h1>手机无法使用</h1>' +
                '<p>请使用电脑打开本应用。</p>' +
                '</div>';
        } else {
            installLatexAutocomplete();
            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(
                React.createElement(ThemeProvider, null,
                    React.createElement(AppProvider, null,
                        React.createElement(App, null)
                    )
                )
            );
        }