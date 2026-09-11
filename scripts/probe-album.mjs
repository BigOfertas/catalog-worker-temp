import fs from "node:fs";
import path from "node:path";

const [url, team, output = ".artifacts/probe.json"] = process.argv.slice(2);
if (!/^https:\/\/photos\.google\.com\/share\//.test(url || "")) throw new Error("URL inválida.");
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: "pt-BR" });
const page = await context.newPage();
const requests = [];
page.on("request", (req) => {
  const u = req.url();
  if (/(googleusercontent\.com|usercontent\.google\.com|ggpht\.com)/i.test(u)) requests.push(u);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3500);
for (const label of ["Aceitar tudo", "Aceitar", "I agree", "Accept all", "Entendi", "Continuar"]) {
  try {
    const button = page.getByRole("button", { name: label, exact: false }).first();
    if (await button.isVisible({ timeout: 150 })) await button.click();
  } catch {}
}
await page.waitForTimeout(1000);
const data = await page.evaluate(() => {
  const mediaRe = /(?:googleusercontent\.com|usercontent\.google\.com|ggpht\.com)/i;
  const titleRe = /\b(CAMISA|CONJUNTO|KIT|SHORTS?|CAL[CÇ][AÃ]O|CORTA[ -]?VENTO|WINDBREAKER|REGATA|PLAYER|JOGADOR|TORCEDOR|FEMININ[AO]|KIDS?|INFANTIL|INFATIL|RET[RÔO]|TREINO|VIAGEM|GOLEIRO)\b/i;
  const attrs = [];
  const titles = [];
  let visibleMedia = 0;
  let cssMedia = 0;
  for (const el of document.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    for (const name of ["aria-label", "title", "alt", "data-tooltip", "data-title"]) {
      const value = (el.getAttribute?.(name) || "").replace(/\s+/g, " ").trim();
      if (value && value.length <= 240) attrs.push({ name, value, visible });
      if (value && titleRe.test(value)) titles.push({ source: name, text: value, visible });
    }
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (visible && text && text.length <= 240 && titleRe.test(text)) titles.push({ source: "innerText", text, visible: true });
    for (const attr of el.attributes || []) if (mediaRe.test(attr.value || "") && visible) visibleMedia += 1;
    for (const pseudo of [null, "::before", "::after"]) {
      try {
        const bg = getComputedStyle(el, pseudo).backgroundImage || "";
        if (visible && mediaRe.test(bg)) cssMedia += 1;
      } catch {}
    }
  }
  const perf = performance.getEntriesByType("resource").map((entry) => entry.name).filter((u) => mediaRe.test(u));
  return {
    bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    elementCount: document.querySelectorAll("*").length,
    imgCount: document.images?.length || 0,
    visibleMedia,
    cssMedia,
    perfMedia: perf.length,
    perfSamples: perf.slice(0, 20),
    titleCandidates: titles.slice(0, 80),
    interestingAttributes: attrs.filter((item) => /album|foto|photo|camisa|kit|conjunto|produto|shared|compartilh/i.test(item.value)).slice(0, 80),
  };
});
const report = {
  team,
  sourceUrl: url,
  resolvedUrl: page.url(),
  pageTitle: await page.title(),
  requestMedia: requests.length,
  requestSamples: [...new Set(requests)].slice(0, 20),
  ...data,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`PROBE_ALBUM team=${team} title=${JSON.stringify(report.pageTitle)} resolved=${report.resolvedUrl} body=${JSON.stringify(report.bodyText.slice(0, 600))}`);
console.log(`PROBE_COUNTS team=${team} requests=${report.requestMedia} perf=${report.perfMedia} imgs=${report.imgCount} visibleMedia=${report.visibleMedia} cssMedia=${report.cssMedia} titleCandidates=${report.titleCandidates.length}`);
await page.screenshot({ path: output.replace(/\.json$/i, ".png"), fullPage: false });
await browser.close();
