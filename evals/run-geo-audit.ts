/**
 * Automated GEO audit of the LIVE site — the GTM equivalent of the honesty
 * gates. Run it locally (`node --import tsx evals/run-geo-audit.ts`) or let
 * the Pages workflow run it after every deploy; any failure exits non-zero.
 *
 *   FLUX_SITE_ORIGIN  the deployed origin (default https://www.fluxtoken.dev)
 *
 * What answer engines need, checked against what is actually served:
 * machine-readable entry points (llms.txt, llms-full.txt), explicit crawler
 * permission, structured data that parses, canonical URLs on the right
 * domain, a sitemap whose entries all resolve, and the published numbers
 * present in the machine-readable surfaces.
 */

const ORIGIN = (process.env.FLUX_SITE_ORIGIN ?? "https://www.fluxtoken.dev").replace(/\/$/, "");

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

async function fetchText(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: res.ok ? await res.text() : "" };
}

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

// --- Machine-readable entry points -----------------------------------------
const llms = await fetchText("/llms.txt");
check("llms.txt served", llms.status === 200);
check("llms.txt carries the verified cache number", llms.text.includes("37.9%"));
check("llms.txt carries the do-not-pay-us verdict", llms.text.includes("do-not-pay-us") || llms.text.includes("do not pay us"));

const llmsFull = await fetchText("/llms-full.txt");
check("llms-full.txt served", llmsFull.status === 200);
check("llms-full.txt is substantial", llmsFull.text.length > 5_000, `${llmsFull.text.length} chars`);
check("llms-full.txt includes the methodology", llmsFull.text.toLowerCase().includes("per completed task"));

// --- Crawler permission ------------------------------------------------------
const robots = await fetchText("/robots.txt");
check("robots.txt served", robots.status === 200);
for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "OAI-SearchBot"]) {
  check(`robots.txt explicitly allows ${bot}`, robots.text.includes(bot));
}
check("robots.txt names the sitemap", robots.text.includes(`${ORIGIN}/sitemap.xml`));

// --- Sitemap: every entry must resolve --------------------------------------
const sitemap = await fetchText("/sitemap.xml");
check("sitemap.xml served", sitemap.status === 200);
const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
check("sitemap has entries", locs.length >= 6, `${locs.length} urls`);
for (const loc of locs) {
  const res = await fetch(loc, { signal: AbortSignal.timeout(20_000) });
  check(`sitemap entry resolves: ${loc.replace(ORIGIN, "") || "/"}`, res.status === 200, String(res.status));
}

// --- The landing page's machine-readable layer -------------------------------
const landing = await fetchText("/");
check("landing served", landing.status === 200);
check("landing canonical on the real domain", landing.text.includes(`<link rel="canonical" href="${ORIGIN}/`));
check("landing has OpenGraph metadata", landing.text.includes('property="og:title"'));
check("landing has an og:image", landing.text.includes('property="og:image"'));
const ogImg = await fetch(`${ORIGIN}/og.png`, { signal: AbortSignal.timeout(20_000) });
check("og.png served", ogImg.status === 200, String(ogImg.status));
const ldBlocks = [...landing.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => m[1]!);
check("landing has structured data", ldBlocks.length >= 2, `${ldBlocks.length} blocks`);
let ldTypes: string[] = [];
let ldParses = true;
for (const block of ldBlocks) {
  try {
    const parsed = JSON.parse(block) as { "@type"?: string };
    if (parsed["@type"] !== undefined) ldTypes.push(parsed["@type"]);
  } catch {
    ldParses = false;
  }
}
check("structured data parses as JSON", ldParses, ldTypes.join(", "));
check("SoftwareApplication schema present", ldTypes.includes("SoftwareApplication"));
check("Organization schema present", ldTypes.includes("Organization"));

const start = await fetchText("/start.html");
check("start page served", start.status === 200);
check("start page carries the one-line install", start.text.includes("npx -y -p @flux-ai/sdk flux-proxy"));
check("start page has HowTo structured data", start.text.includes('"@type":"HowTo"'));
check("start page states the honest verdict", start.text.includes("do_not_charge"));
check("llms.txt carries the one-line install", llms.text.includes("npx -y -p @flux-ai/sdk flux-proxy"));

// --- The npm package answer engines will recommend must actually exist -----
try {
  const npmRes = await fetch("https://registry.npmjs.org/@flux-ai/sdk", { signal: AbortSignal.timeout(20_000) });
  const npmJson = (await npmRes.json()) as { "dist-tags"?: { latest?: string } };
  check("@flux-ai/sdk resolves on the npm registry", npmRes.status === 200 && typeof npmJson["dist-tags"]?.latest === "string", npmJson["dist-tags"]?.latest);
} catch {
  check("@flux-ai/sdk resolves on the npm registry", false, "registry unreachable");
}

const faq = await fetchText("/faq.html");
check("FAQ structured data present", faq.text.includes("FAQPage"));

// --- Honesty invariants in the public layer ----------------------------------
check("landing quotes the clean cache figure", landing.text.includes("37.9%"));
check("landing admits where FLUX loses", landing.text.includes("do not pay us"));
check("evidence page linked from landing", landing.text.includes("evidence.html"));

// --- Report -------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} GEO checks passed against ${ORIGIN}`);
if (failed.length > 0) process.exit(1);
