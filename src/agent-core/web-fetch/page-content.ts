import { MIMEType } from "node:util";
import { Readability } from "@mozilla/readability";
import iconv from "iconv-lite";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

const removedElements = "script, style, noscript, iframe, object, embed, template, img, svg, base, [hidden]";
const MAX_ELEMENTS = 30_000;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(tables);

export function extractPage(bytes: Buffer, url: URL, contentType: string, mimeType: string, maxChars: number) {
  let title: string | null = null;
  let markdown: string;
  if (mimeType === "text/plain") {
    const charset = new MIMEType(contentType).params.get("charset") ?? "utf-8";
    if (!iconv.encodingExists(charset)) {
      throw new Error("unsupported_charset: The page uses an unsupported text encoding.");
    }
    markdown = iconv.decode(bytes, charset);
  } else {
    const dom = new JSDOM(bytes, { url: url.href, contentType, virtualConsole: new VirtualConsole() });
    try {
      const document = dom.window.document;
      const pageTitle = document.title.trim();
      if (document.querySelector("#challenge-form, #cf-challenge-running")) {
        throw new Error("access_challenge: The website requires a browser challenge.");
      }
      if (document.getElementsByTagName("*").length > MAX_ELEMENTS) {
        throw new Error("page_too_complex: The page exceeds 30000 HTML elements.");
      }
      for (const element of document.querySelectorAll(removedElements)) element.remove();

      const main = document.querySelector<HTMLElement>("main, [role=main]");
      const article = main?.querySelector("pre, table") ? null :
        new Readability(document.cloneNode(true) as Document, { serializer: (node) => node as HTMLElement }).parse();
      const fallback = main ?? document.querySelector<HTMLElement>("article") ?? document.body;
      if (!article?.textContent?.trim() && fallback.querySelector('input[type="password"]')) {
        throw new Error("login_required: The page requires authentication.");
      }
      const content = article?.content ?? fallback;
      for (const element of content.querySelectorAll("nav, footer, form, button, [role=navigation]")) element.remove();
      for (const pre of content.querySelectorAll("pre")) {
        if (pre.firstChild?.nodeName === "CODE") continue;
        const code = document.createElement("code");
        code.textContent = pre.textContent;
        pre.replaceChildren(code);
      }
      // The table plugin keeps headerless tables as raw HTML. Give them a Markdown header row.
      for (const table of content.querySelectorAll("table")) {
        const row = table.rows[0];
        if (!row?.cells.length) {
          table.remove();
          continue;
        }
        if (row.parentElement?.tagName !== "THEAD") table.createTHead().prepend(row);
      }
      for (const anchor of content.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href")!;
        try {
          const target = new URL(href, url);
          if (target.protocol === "http:" || target.protocol === "https:") {
            anchor.setAttribute("href", target.href);
            continue;
          }
        } catch {
          // Keep the link's visible text when its URL is invalid.
        }
        anchor.removeAttribute("href");
      }
      markdown = turndown.turndown(content);
      title = (article?.title?.trim() || pageTitle).slice(0, 500) || null;
    } finally {
      dom.window.close();
    }
  }

  const content = markdown.trim();
  if (!content) throw new Error("empty_content: No static page content was found.");
  return { title, ...limitContent(content, maxChars) };
}

function limitContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  // Turndown emits fenced code blocks. Ignore paragraph breaks inside them.
  let fence: string | undefined;
  let fenceStart = 0;
  let boundary = 0;
  const lines = content.slice(0, maxChars + 1).split("\n");
  lines.pop();
  let offset = 0;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1]!;
      fenceStart = offset;
    } else if (!line.trim()) {
      boundary = offset;
    }
    offset += line.length + 1;
  }
  if (boundary > 0) return { content: content.slice(0, boundary).trimEnd(), truncated: true };
  if (fence && fenceStart > 0) return { content: content.slice(0, fenceStart).trimEnd(), truncated: true };
  if (fence && fence.length + 1 < maxChars) {
    return { content: `${sliceContent(content, maxChars - fence.length - 1)}\n${fence}`, truncated: true };
  }
  return { content: sliceContent(content, maxChars), truncated: true };
}

function sliceContent(content: string, length: number): string {
  // Avoid leaving half of a surrogate pair at the limit.
  return content.slice(0, length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}
