/// <reference lib="dom" />
// Adapted from sirouk/prime-agent-vscode webview/markdown.ts.
// Copyright (c) 2026 sirouk. MIT License; see LICENSE.
namespace NodecodeMarkdown {
/**
 * Minimal, safe markdown renderer. Builds DOM nodes via textContent only — no
 * innerHTML anywhere — so agent output can't inject markup into the webview.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function copyToClipboard(text: string, onDone?: () => void): void {
	const fallback = () => {
        const focus=document.activeElement as HTMLElement | null;
        const selection=window.getSelection();
        const ranges=selection ? Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()) : [];
        const input=focus instanceof HTMLTextAreaElement || focus instanceof HTMLInputElement ? {start:focus.selectionStart,end:focus.selectionEnd} : undefined;
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand("copy");
		} catch {
			// ignore
		}
		ta.remove();
        focus?.focus({preventScroll:true});
        if(selection){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range));}
        if(input && !ranges.length && (focus instanceof HTMLTextAreaElement || focus instanceof HTMLInputElement))focus.setSelectionRange(input.start,input.end);
		onDone?.();
	};
	if (navigator.clipboard?.writeText) {
		navigator.clipboard.writeText(text).then(() => onDone?.(), fallback);
	} else {
		fallback();
	}
}

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function sanitizeHref(href: string): string {
	try {
		// Deliberately NO base URL. Resolving against one turned a relative or
		// protocol-relative target ("docs/x.md", "//evil.example") into an
		// "allowed" https link whose real destination the text never named — and
		// which the host then refuses anyway. Only an explicit, absolute,
		// allow-listed URL becomes a link; anything else stays inert.
		const url = new URL(href);
		if (ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return url.href;
	} catch {
		// not an absolute URL
	}
	return "#";
}

function bareHref(raw: string): string {
	let href = raw.replace(/[.,:;!?'\]]+$/, "");
	while (href.endsWith(")") && (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0)) href = href.slice(0, -1);
	return href;
}

function fileAnchor(label: HTMLElement, raw: string, links: LinkHandlers): HTMLElement {
	const target = parseFileLink(raw);
	if (!links.file || !target) return label;
	const anchor = el("a") as HTMLAnchorElement;
	anchor.href = "#"; anchor.title = raw; anchor.appendChild(label);
	anchor.addEventListener("click", (event) => { event.preventDefault(); links.file?.(target.path, target.startLine, target.endLine); });
	anchor.addEventListener("auxclick", (event) => event.preventDefault());
	return anchor;
}

function fileShaped(text: string, inCode = false): boolean {
	if (!/[A-Za-z]/.test(text) || /[\s\0*?\[\]{}|<>"'`$;&=]/.test(text) || (URL_SCHEME.test(text) && !WINDOWS_DRIVE.test(text))) return false;
	if (/^(?:\/|~\/|\.{1,2}\/)/.test(text) || WINDOWS_DRIVE.test(text)) return true;
	const file = text.replace(/:\d+(?:-\d+|:\d+)?$/, "");
	if (inCode && /^[\w.-]+\.[A-Za-z0-9]{1,10}$/.test(file)) return true;
	return file.includes("/") && (inCode || /\/[^/.]+\.[^/]+$/.test(file) || file.endsWith("/"));
}

function unwrapDestination(raw: string): string {
	const target = raw.trim();
	return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1).trim() : target;
}

/** What a click on a rendered link does; `file` absent means file targets stay inert. */
export interface LinkHandlers {
	external(href: string): void;
	file?(path: string, startLine?: number, endLine?: number): void;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/**
 * A link target that names a FILE rather than a page: what the agent writes for
 * things it saved (`sandbox:/mnt/data/x.pine`, `/root/lab/x.py`, `docs/setup.md`,
 * `src/a.ts:12`, `src/a.ts#L10-L20`). Only `sandbox:` and `file:` schemes count;
 * every other scheme, a protocol-relative `//host/x`, and a bare `#anchor` stay
 * inert. The host decides whether such a path exists and where.
 */
export function parseFileLink(raw: string): { path: string; startLine?: number; endLine?: number } | null {
	let target = unwrapDestination(raw);
	const scheme = /^(sandbox|file):/i.exec(target);
	if (scheme) {
		target = target.slice(scheme[0].length);
		// `file:///abs`, `file://localhost/abs` and `sandbox:///abs` all reduce to `/abs`.
		target = target.replace(/^\/\/(?:localhost)?(?=\/)/i, "");
	} else if (URL_SCHEME.test(target) && !WINDOWS_DRIVE.test(target)) {
		return null;
	}
	// `//host/x` and `\\host\share\x` are network paths, not workspace files.
	if (target.startsWith("//") || target.startsWith("\\\\") || target.startsWith("#") || target === "") return null;
	let startLine: number | undefined;
	let endLine: number | undefined;
	const fragment = /#L(\d+)(?:-L?(\d+))?$/.exec(target);
	// `src/a.ts:12`, `src/a.ts:10-20`, and `src/a.ts:12:5` (the column is dropped: a
	// greedy `:5` as the LINE left `src/a.ts:12` as the path, which does not exist).
	const suffix = fragment ? null : /:(\d+)(?:-(\d+)|:\d+)?$/.exec(target);
	const lines = fragment ?? suffix;
	if (lines) {
		target = target.slice(0, lines.index);
		startLine = Number(lines[1]);
		if (lines[2] !== undefined) endLine = Number(lines[2]);
		if (endLine !== undefined && endLine < startLine) endLine = undefined;
	}
	// A heading anchor (`docs/setup.md#install`) names a place inside the file.
	target = target.split("?")[0].split("#")[0];
	try {
		target = decodeURIComponent(target);
	} catch {
		// keep the literal text: a stray % is a filename character, not an escape
	}
	if (target === "" || target.includes("\0")) return null;
	return { path: target, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) };
}

/** Render inline markdown (code spans, bold, italic, links) into parent. */
export function renderInline(text: string, parent: HTMLElement, links: LinkHandlers, depth = 0): void {
	// Tokenize with a single pass regex; code spans win over emphasis.
	// Every alternative is newline-bounded AND length-bounded. With open-ended
	// classes an unmatched delimiter ("[", "**", a stray backtick) rescanned to
	// the end of the message from every position — quadratic per pass, and the
	// transcript re-runs this on every streaming delta, so one long reply
	// containing bare "[" froze the panel (measured: 1.9 s at 40k occurrences,
	// 7.4 s at 80k; now 20 ms / 64 ms). The caps are far above any real inline
	// span; anything longer simply renders as the literal text it already is.
	//
	// Delimiter boundaries (without them prose full of identifiers is mangled):
	//  - `_` / `__` never open inside a word and never close before one, as in
	//    CommonMark: `tests/test_foo_bar.py` and `MAX_RETRY_COUNT` stay literal.
	//  - a single `*` must not touch whitespace or another `*` on its inner side nor a
	//    word character on its outer side, so `src/**/*.ts` and `2*3*4` stay literal.
	// Lookbehind keeps the capture-group numbering the branches below rely on.
	const pattern =
		/(`+)([^`\n]|`(?!`)){0,1000}?\1|\*\*([^*\n]{1,1000})\*\*|(?<!\w)__(?!\s)([^_\n]{1,1000})__(?!\w)|(?<![\w*])\*(?![\s*])([^*\n]{1,1000})(?<![\s*])\*(?![\w*])|(?<!\w)_(?!\s)([^_\n]{1,1000})(?<!\s)_(?!\w)|!?\[([^\]\n]{1,500})\]\(((?:<[^>\n]{1,2000}>|[^)\s\n]{1,2000}))\)|\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])|\*\*\*([^*\n]{1,1000})\*\*\*|~~([^~\n]{1,1000})~~|(?<!\w)(https?:\/\/[^\s<>"`]{1,2000})|<span style=["']color:\s*(#[0-9a-fA-F]{6});?["']>([^\n]{1,1000}?)<\/span>|(?<![\w/])((?:\.{1,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]+(?::\d+(?:-\d+|:\d+)?)?)/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) {
			parent.appendChild(document.createTextNode(text.slice(last, match.index)));
		}
		if (match[1]) {
			const code = el("code");
			// strip the wrapping backticks
			const inner = match[0].slice(match[1].length, -match[1].length);
			code.textContent = inner;
			parent.appendChild(fileShaped(inner, true) ? fileAnchor(code, inner, links) : code);
		} else if (match[3] || match[4]) {
			const strong = el("strong");
			emphasisContent(strong, match[3] ?? match[4] ?? "", links, depth);
			parent.appendChild(strong);
		} else if (match[5] || match[6]) {
			const em = el("em");
			emphasisContent(em, match[5] ?? match[6] ?? "", links, depth);
			parent.appendChild(em);
		} else if (match[9]) {
			parent.appendChild(document.createTextNode(match[9]));
		} else if (match[10]) {
			const strong = el("strong"), em = el("em");
			emphasisContent(em, match[10], links, depth);
			strong.appendChild(em); parent.appendChild(strong);
		} else if (match[11]) {
			const strike = el("s"); emphasisContent(strike, match[11], links, depth); parent.appendChild(strike);
		} else if (match[13]) {
			const span = el("span"); span.style.color = match[13];
			emphasisContent(span, match[14], links, depth); parent.appendChild(span);
		} else if (match[15]) {
			const literal = el("span", undefined, match[15]);
			parent.appendChild(fileShaped(match[15]) ? fileAnchor(literal, match[15], links) : literal);
		} else if ((match[7] && match[8]) || match[12]) {
			const label = match[7];
			const rawHref = match[8] ? unwrapDestination(match[8]) : bareHref(match[12]);
			const a = el("a") as HTMLAnchorElement;
			a.textContent = label || rawHref;
			const href = sanitizeHref(rawHref);
			const file = href === "#" && links.file ? parseFileLink(rawHref) : null;
			const openable = href !== "#" || file !== null;
			// The anchor itself never navigates the webview: a file target keeps the
			// inert "#" and is opened by the host from the click handler below.
			a.href = href;
			// Hand the HOST the sanitized absolute URL, never the raw text: the two
			// must agree on the destination, or a click opens something the link
			// never claimed. A file target is shown as written so the reader can
			// see exactly which path a click will ask for.
			a.title = openable ? rawHref : `${rawHref} — not an openable link`;
			if (!openable) a.className = "md-link-inert";
			a.addEventListener("click", (event) => {
				event.preventDefault();
				if (file) links.file?.(file.path, file.startLine, file.endLine);
				else if (openable) links.external(href);
			});
			// Middle-click and modifier-click bypass the click handler entirely, so
			// an inert target must not stay navigable through them either.
			a.addEventListener("auxclick", (event) => event.preventDefault());
			parent.appendChild(a);
			if (match[12] && rawHref.length < match[12].length) parent.appendChild(document.createTextNode(match[12].slice(rawHref.length)));
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) {
		parent.appendChild(document.createTextNode(text.slice(last)));
	}
}

/**
 * Emphasis can wrap a link (`**[Download](sandbox:/x)**`), which is how agents
 * mark the thing to click. Parse the inside one level further; deeper nesting
 * stays literal text, which also keeps the work per delta bounded.
 */
function emphasisContent(node: HTMLElement, text: string, links: LinkHandlers, depth: number): void {
	if (depth >= 2) node.textContent = text;
	else renderInline(text, node, links, depth + 1);
}

interface ListLine {
	indent: number;
	ordered: boolean;
	/** The number an ordered item was written with, so a list resumed after a code block keeps counting. */
	number?: number;
	text: string;
}

export function renderMarkdown(markdown: string, container: HTMLElement, links: LinkHandlers): void {
	container.classList.add("md");
	renderBlocks(markdown, container, links, 0);
}

function renderBlocks(markdown: string, container: HTMLElement, links: LinkHandlers, quoteDepth: number): void {
	// Agent output is untrusted: keep pathological quote nesting off the call
	// stack while preserving the remaining source instead of dropping it.
	if (quoteDepth >= 64) {
		const p = el("p", undefined, markdown);
		p.style.whiteSpace = "pre-wrap";
		container.appendChild(p);
		return;
	}
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// fenced code block
		const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
		if (fence) {
			// An agent indents a fence under a list item ("1. Install:" / "   ```bash").
			// Requiring column 0 turned the fence into literal backticks.
			const indent = fence[1].length;
			const marker = fence[2][0], length = fence[2].length;
			const lang = fence[3].trim().replace(/^(?:\{[^.]*\.|\.)/, "").split(/[\s,}\[\]]/, 1)[0];
			const body: string[] = [];
			i++;
			while (i < lines.length && !new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${length},}\\s*$`).test(lines[i])) {
				body.push(lines[i].replace(new RegExp(`^\\s{0,${indent}}`), ""));
				i++;
			}
			i++; // skip closing fence
			const pre = el("pre");
			const code = el("code");
			if (lang) code.className = `language-${lang}`;
			const codeText = body.join("\n");
			code.textContent = codeText;
			pre.appendChild(code);
			const wrapper = el("div", "codeblock");
			const head = el("div", "codeblock-head");
			head.appendChild(el("span", "codeblock-lang", lang || "code"));
			const copyBtn = el("button", "codeblock-copy");
            const clipboardIcon='<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/></svg>';
            copyBtn.innerHTML=clipboardIcon;copyBtn.setAttribute("aria-label","Copy code");copyBtn.title="Copy code";
			copyBtn.addEventListener("click", (event) => {
				event.stopPropagation();
				copyToClipboard(codeText, () => {
					copyBtn.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';copyBtn.setAttribute("aria-label","Copied");
                    setTimeout(() => {copyBtn.innerHTML=clipboardIcon;copyBtn.setAttribute("aria-label","Copy code");}, 1200);
				});
			});
			head.appendChild(copyBtn);
			wrapper.append(head, pre);
			container.appendChild(wrapper);
			continue;
		}

		// table
		const alignments = i + 1 < lines.length ? tableAlignment(lines[i + 1]) : null;
		if (line.includes("|") && alignments && splitTableRow(line).length === alignments.length) {
			const headerCells = splitTableRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].trim() && splitTableRow(lines[i]).length > 1) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}
			const table = el("table");
			const thead = el("thead");
			const tr = el("tr");
			for (const [column, cell] of headerCells.entries()) {
				const th = el("th");
				if (alignments[column]) th.style.textAlign = alignments[column];
				renderInline(cell, th, links);
				tr.appendChild(th);
			}
			thead.appendChild(tr);
			table.appendChild(thead);
			const tbody = el("tbody");
			for (const row of rows) {
				const trBody = el("tr");
				for (const [column, cell] of row.slice(0, headerCells.length).entries()) {
					const td = el("td");
					if (alignments[column]) td.style.textAlign = alignments[column];
					renderInline(cell, td, links);
					trBody.appendChild(td);
				}
				tbody.appendChild(trBody);
			}
			table.appendChild(tbody);
			container.appendChild(table);
			continue;
		}

		// heading
		const heading = line.match(/^(#{1,6})(?:\s+(.*)|$)/);
		if (heading) {
			const h = el(`h${heading[1].length}`);
			renderInline((heading[2] || "").replace(/\s+#+\s*$/, ""), h, links);
			container.appendChild(h);
			i++;
			continue;
		}

		// horizontal rule
		if (/^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
			container.appendChild(el("hr"));
			i++;
			continue;
		}

		// blockquote
		if (/^\s*>/.test(line)) {
			const quote = el("blockquote");
			const quoteLines: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			renderBlocks(quoteLines.join("\n"), quote, links, quoteDepth + 1);
			container.appendChild(quote);
			continue;
		}

		// list (indentation and ordered/unordered groups)
		const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (listMatch) {
			const items: ListLine[] = [];
			const itemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
			while (i < lines.length) {
				const m = lines[i].match(itemRe);
				if (!m) {
					// A single blank line between items is spacing, not the end of the list;
					// ending it there restarted every item as "1.".
					if (lines[i].trim() === "" && i + 1 < lines.length && itemRe.test(lines[i + 1])) {
						i++;
						continue;
					}
					break;
				}
				items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), ...(/^\d/.test(m[2]) ? { number: parseInt(m[2], 10) } : {}), text: m[3] });
				i++;
			}
			for (const list of buildList(items, links)) container.appendChild(list);
			continue;
		}

		// blank line
		if (line.trim() === "") {
			i++;
			continue;
		}

		// paragraph: consume until a block boundary
		const paraLines: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines, i)) {
			paraLines.push(lines[i]);
			i++;
		}
		const p = el("p");
		renderInline(paraLines.join("\n"), p, links);
		p.style.whiteSpace = "pre-wrap";
		container.appendChild(p);
	}
}

function isBlockStart(lines: string[], i: number): boolean {
	const line = lines[i];
	return (
		/^\s*(?:`{3,}|~{3,})/.test(line) ||
		/^#{1,6}(?:\s|$)/.test(line) ||
		/^\s*>/.test(line) ||
		/^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
		/^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line) ||
		(line.includes("|") && i + 1 < lines.length && tableAlignment(lines[i + 1]) !== null)
	);
}

function splitTableRow(line: string): string[] {
	let trimmed = line.trim().replace(/^\|/, "");
	const trailingBackslashes = /\\*$/.exec(trimmed.slice(0, -1))?.[0].length ?? 0;
	if (trimmed.endsWith("|") && trailingBackslashes % 2 === 0) trimmed = trimmed.slice(0, -1);
	const cells: string[] = [];
	let cell = "", codeRun = 0;
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (char === "\\" && trimmed[i + 1] === "|") { cell += "|"; i++; continue; }
		if (char === "\\" && trimmed[i + 1] === "\\") { cell += "\\\\"; i++; continue; }
		if (char === "`") {
			let end = i + 1; while (trimmed[end] === "`") end++;
			const run = end - i;
			if (!codeRun && trimmed.indexOf("`".repeat(run), end) !== -1) codeRun = run;
			else if (codeRun === run) codeRun = 0;
			cell += trimmed.slice(i, end); i = end - 1; continue;
		}
		if (char === "|" && !codeRun) { cells.push(cell.trim()); cell = ""; }
		else cell += char;
	}
	cells.push(cell.trim());
	return cells;
}

function tableAlignment(line: string): Array<"left" | "right" | "center" | ""> | null {
	const cells = splitTableRow(line);
	if (!cells.length || !cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
	return cells.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "");
}

function buildList(items: ListLine[], links: LinkHandlers): HTMLElement[] {
	const roots: HTMLElement[] = [];
	const stack: Array<{ indent: number; ordered: boolean; list: HTMLElement }> = [];
	for (const item of items) {
		while (stack.length && stack[stack.length - 1].indent > item.indent) stack.pop();
		let current = stack[stack.length - 1];
		if (current?.indent === item.indent && current.ordered !== item.ordered) {
			stack.pop();
			current = stack[stack.length - 1];
		}
		if (!current || current.indent < item.indent) {
			const list = el(item.ordered ? "ol" : "ul");
			if (item.ordered && item.number !== undefined && item.number !== 1) (list as HTMLOListElement).start = item.number;
			// A larger indent opens one child list, regardless of whether the
			// source uses two, four, or more spaces. It belongs to the last item.
			if (current) current.list.lastElementChild!.appendChild(list);
			else roots.push(list);
			current = { indent: item.indent, ordered: item.ordered, list };
			stack.push(current);
		}
		const li = el("li");
		const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
		if (task) {
			const checkbox = el("input") as HTMLInputElement;
			checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = task[1].toLowerCase() === "x";
			li.appendChild(checkbox); li.appendChild(document.createTextNode(" "));
		}
		renderInline(task ? task[2] : item.text, li, links);
		current.list.appendChild(li);
	}
	return roots;
}

}
