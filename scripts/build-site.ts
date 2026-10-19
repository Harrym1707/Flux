/**
 * Build the deployable FLUX website from docs/site/*.md — zero dependencies.
 *
 *   node --import tsx scripts/build-site.ts
 *
 * Output: docs/site/dist/ — static HTML pages, llms.txt at the root,
 * robots.txt, sitemap.xml, and FAQ structured data (schema.org FAQPage) so
 * answer engines can cite the pages directly. Deploying is one founder
 * action: enable GitHub Pages on the folder, or drag it into any static host.
 *
 *   FLUX_SITE_ORIGIN  canonical origin (e.g. https://flux.dev); a placeholder
 *                     is used (and loudly warned about) when unset.
 *   FLUX_REPO_URL     where ../pilot/* links resolve (the public repo).
 *
 * The generator verifies its own output and exits non-zero on anything
 * malformed, so a broken page can never ship silently.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(root, "docs/site");
const outDir = path.join(siteDir, "dist");

const ORIGIN = (process.env.FLUX_SITE_ORIGIN ?? "https://REPLACE-WITH-YOUR-DOMAIN.example").replace(/\/$/, "");
const REPO_URL = (process.env.FLUX_REPO_URL ?? "https://github.com/Harrym1707/Flux").replace(/\/$/, "");
if (ORIGIN.includes("REPLACE-WITH-YOUR-DOMAIN")) {
  console.warn("WARNING: FLUX_SITE_ORIGIN is unset; canonical URLs and the sitemap use a placeholder domain.");
}

/** Page order defines the nav. */
const PAGES: Array<{ file: string; nav: string }> = [
  { file: "index.md", nav: "Overview" },
  { file: "segments.md", nav: "Savings by segment" },
  { file: "methodology.md", nav: "Methodology" },
  { file: "evidence.md", nav: "Evidence" },
  { file: "comparison.md", nav: "Honest comparison" },
  { file: "faq.md", nav: "FAQ" },
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown: bold, inline code, links. Input is raw; output is HTML. */
function inline(raw: string): string {
  let text = escapeHtml(raw);
  text = text.replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    let target = href;
    if (target.startsWith("../pilot/")) target = `${REPO_URL}/blob/main/docs/pilot/${target.slice("../pilot/".length)}`;
    else if (target.endsWith(".md")) target = target.replace(/\.md$/, ".html");
    return `<a href="${target}">${label}</a>`;
  });
  return text;
}

/** Block-level markdown for the subset these pages use. */
function renderBody(markdown: string): { html: string; title: string; description: string } {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let title = "";
  let description = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("# ")) {
      if (title === "") title = line.slice(2).trim();
      out.push(`<h1>${inline(line.slice(2).trim())}</h1>`);
      index += 1;
    } else if (line.startsWith("### ")) {
      out.push(`<h3>${inline(line.slice(4).trim())}</h3>`);
      index += 1;
    } else if (line.startsWith("## ")) {
      out.push(`<h2>${inline(line.slice(3).trim())}</h2>`);
      index += 1;
    } else if (line.startsWith("|")) {
      const rows: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("|")) {
        rows.push(lines[index]!);
        index += 1;
      }
      const cells = (row: string): string[] => row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = cells(rows[0]!);
      const bodyRows = rows.slice(rows[1]?.match(/^\|[\s:-]+\|/) ? 2 : 1);
      out.push("<div class=\"table-wrap\"><table>");
      out.push(`<thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`);
      out.push("<tbody>");
      for (const row of bodyRows) {
        out.push(`<tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      }
      out.push("</tbody></table></div>");
    } else if (line.startsWith("- ")) {
      out.push("<ul>");
      while (index < lines.length && (lines[index]!.startsWith("- ") || lines[index]!.startsWith("  "))) {
        if (lines[index]!.startsWith("- ")) {
          let item = lines[index]!.slice(2);
          index += 1;
          while (index < lines.length && lines[index]!.startsWith("  ") && !lines[index]!.startsWith("- ")) {
            item += ` ${lines[index]!.trim()}`;
            index += 1;
          }
          out.push(`<li>${inline(item)}</li>`);
        } else {
          index += 1;
        }
      }
      out.push("</ul>");
    } else if (line.trim() === "") {
      index += 1;
    } else {
      let paragraph = line;
      index += 1;
      while (index < lines.length && lines[index]!.trim() !== "" && !/^(#|\||- )/.test(lines[index]!)) {
        paragraph += ` ${lines[index]!}`;
        index += 1;
      }
      if (description === "" && title !== "") description = paragraph.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      out.push(`<p>${inline(paragraph)}</p>`);
    }
  }
  return { html: out.join("\n"), title, description: description.slice(0, 300) };
}

const CSS = `
:root{--bg:#ffffff;--fg:#1a1a1a;--muted:#555;--line:#e3e3e3;--accent:#0b5fff;--code:#f4f4f4}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#e8e8e8;--muted:#aaa;--line:#333;--accent:#7aa5ff;--code:#1f1f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
nav{border-bottom:1px solid var(--line);padding:.75rem 1.25rem;display:flex;flex-wrap:wrap;gap:1rem;font-size:.92rem}
nav a{color:var(--muted);text-decoration:none}nav a.active,nav a:hover{color:var(--accent)}
nav .brand{font-weight:700;color:var(--fg)}
h1{font-size:1.7rem;line-height:1.25;margin:1.2rem 0 .6rem}h2{font-size:1.25rem;margin:2rem 0 .5rem}h3{font-size:1.05rem}
a{color:var(--accent)}code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.9em}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.95rem}
th,td{border:1px solid var(--line);padding:.5rem .6rem;text-align:left;vertical-align:top}
th{background:var(--code)}footer{border-top:1px solid var(--line);margin-top:3rem;padding-top:1rem;font-size:.85rem;color:var(--muted)}
`.trim();

function layout(page: { file: string; nav: string }, body: string, title: string, description: string, extraHead = ""): string {
  const htmlName = page.file.replace(/\.md$/, ".html");
  const nav = PAGES.map((p) => {
    const href = p.file.replace(/\.md$/, ".html");
    const cls = p.file === page.file ? " class=\"active\"" : "";
    return `<a href="${href}"${cls}>${p.nav}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}/${htmlName === "index.html" ? "" : htmlName}">
<style>${CSS}</style>
${extraHead}</head>
<body>
<nav><a class="brand" href="index.html">FLUX</a>${nav}</nav>
<main>
${body}
<footer>Every number on this site traces to a command and a commit — <a href="evidence.html">evidence</a>.
Savings are measured per completed task; estimates are always labelled. <a href="${REPO_URL}">Source</a> · <a href="llms.txt">llms.txt</a></footer>
</main>
</body>
</html>
`;
}

/** schema.org FAQPage from faq.md's **Question?** / answer structure. */
function faqJsonLd(markdown: string): string {
  const pairs: Array<{ q: string; a: string }> = [];
  const blocks = markdown.split(/\n\n+/);
  for (let i = 0; i < blocks.length; i += 1) {
    const match = blocks[i]!.match(/^\*\*(.+?)\*\*\n([\s\S]+)$/);
    if (match) pairs.push({ q: match[1]!, a: match[2]!.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim() });
  }
  if (pairs.length === 0) return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: pairs.map((p) => ({
      "@type": "Question",
      name: p.q,
      acceptedAnswer: { "@type": "Answer", text: p.a },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>\n`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const built: string[] = [];
for (const page of PAGES) {
  const markdown = readFileSync(path.join(siteDir, page.file), "utf8");
  const { html, title, description } = renderBody(markdown);
  const extraHead = page.file === "faq.md" ? faqJsonLd(markdown) : "";
  const htmlName = page.file.replace(/\.md$/, ".html");
  writeFileSync(path.join(outDir, htmlName), layout(page, html, title, description, extraHead), "utf8");
  built.push(htmlName);
}

writeFileSync(path.join(outDir, "llms.txt"), readFileSync(path.join(siteDir, "llms.txt"), "utf8"), "utf8");
writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, "utf8");
const today = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  built.map((name) => `  <url><loc>${ORIGIN}/${name === "index.html" ? "" : name}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
  "\n</urlset>\n", "utf8");

// --- Self-verification: a malformed page must never ship silently. ---------
const failures: string[] = [];
for (const name of built) {
  const html = readFileSync(path.join(outDir, name), "utf8");
  if (!html.includes("<title>") || html.includes("<title></title>")) failures.push(`${name}: missing title`);
  if (/\]\(/.test(html)) failures.push(`${name}: unrendered markdown link`);
  if (/\*\*[^*]+\*\*/.test(html)) failures.push(`${name}: unrendered bold`);
  if (!html.includes("</table>") && (name === "index.html" || name === "evidence.html")) failures.push(`${name}: expected a table`);
}
const faqHtml = readFileSync(path.join(outDir, "faq.html"), "utf8");
if (!faqHtml.includes("application/ld+json") || !faqHtml.includes("FAQPage")) failures.push("faq.html: missing FAQ structured data");
if (failures.length > 0) {
  for (const failure of failures) console.error(`SITE BUILD FAILED: ${failure}`);
  process.exit(1);
}
console.log(`site built: ${built.length} pages + llms.txt + robots.txt + sitemap.xml -> ${path.relative(root, outDir)}`);
console.log(`canonical origin: ${ORIGIN}${ORIGIN.includes("REPLACE") ? "  <- set FLUX_SITE_ORIGIN before deploying" : ""}`);
