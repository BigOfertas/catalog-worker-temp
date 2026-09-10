import fs from "node:fs";
import { chromium } from "playwright";

const verification = JSON.parse(fs.readFileSync(".artifacts/finalize/verification.json", "utf8"));
const samples = Array.isArray(verification.samples) ? verification.samples : [];
if (samples.length === 0) throw new Error("Nenhuma amostra para verificação pública.");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(45_000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  const home = await page.goto("https://bigofertas.net", { waitUntil: "commit", timeout: 45_000 });
  if (!home?.ok()) throw new Error(`Homepage HTTP ${home?.status()}`);
  await page.locator("main").waitFor({ state: "visible" });

  for (const sample of samples) {
    if (!sample?.slug || !sample?.name) throw new Error("Amostra pública incompleta.");
    const url = `https://bigofertas.net/product/${encodeURIComponent(sample.slug)}`;
    const response = await page.goto(url, { waitUntil: "commit", timeout: 45_000 });
    if (!response?.ok()) throw new Error(`${sample.catalog_code}: HTTP ${response?.status()}`);
    await page.locator("main").waitFor({ state: "visible" });
    await page.waitForFunction(
      (expectedName) => document.querySelector("main")?.innerText.includes(expectedName),
      sample.name,
    );
    await page.waitForFunction(() => {
      const main = document.querySelector("main");
      if (!main?.innerText.includes("R$")) return false;
      return [...document.images].some((image) => {
        const src = image.currentSrc || image.src;
        return /googleusercontent\.com/.test(src) && image.complete && image.naturalWidth > 0;
      });
    });
    console.log(`PUBLIC_PRODUCT_OK code=${sample.catalog_code} competition=${sample.campeonato} slug=${sample.slug}`);
  }

  if (pageErrors.length > 0) {
    throw new Error(`Erros de página: ${pageErrors.join(" | ").slice(0, 1500)}`);
  }
  console.log(`PUBLIC_FINALIZATION_OK samples=${samples.length}`);
} finally {
  await browser.close();
}
