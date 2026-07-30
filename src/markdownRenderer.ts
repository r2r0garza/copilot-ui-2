import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

/**
 * Render model-authored Markdown for the webview.
 *
 * Raw HTML is disabled in the parser and the generated markup is sanitized
 * before it crosses into the webview. This keeps `innerHTML` limited to a
 * small, known-safe set of presentational elements.
 */
export function renderMarkdown(value: string): string {
  return sanitizeHtml(markdown.render(value), {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title"],
      code: ["class"],
    },
    allowedClasses: {
      code: [/^language-[\w-]+$/],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  });
}
