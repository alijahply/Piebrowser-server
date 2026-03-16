const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

// Roku screen is 1280x720
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

// One shared browser instance, relaunched if it crashes
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions"
    ]
  });
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

// Health check
app.get("/", (req, res) => {
  res.send("PieBrowser render server is running.");
});

// Screenshot endpoint
// GET /screenshot?url=https://example.com&w=1280&h=720&scroll=0
app.get("/screenshot", async (req, res) => {
  const url = req.query.url;
  const w   = parseInt(req.query.w)      || VIEWPORT_W;
  const h   = parseInt(req.query.h)      || VIEWPORT_H;
  const scrollY = parseInt(req.query.scroll) || 0;

  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid or missing url parameter" });
  }

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1"
    );

    // Block heavy assets to speed up rendering
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["font", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    // Let page settle a moment
    await new Promise(r => setTimeout(r, 1500));

    // Scroll to position if requested
    if (scrollY > 0) {
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      await new Promise(r => setTimeout(r, 300));
    }

    // Inject minimal TV-friendly CSS: bigger text, hide cookie banners
    await page.evaluate(() => {
      // Hide common cookie/GDPR popups and overlays
      const selectors = [
        "[class*='cookie']","[id*='cookie']",
        "[class*='gdpr']","[id*='gdpr']",
        "[class*='consent']","[id*='consent']",
        "[class*='popup']","[id*='popup']",
        "[class*='overlay']","[id*='overlay']",
        "[class*='modal']","[id*='modal']",
        "[class*='banner']","[id*='banner']"
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          el.style.display = "none";
        });
      });
      // Ensure body scrolls and text is readable
      document.body.style.overflow = "auto";
    });

    const screenshot = await page.screenshot({
      type: "jpeg",
      quality: 82,
      clip: { x: 0, y: 0, width: w, height: h }
    });

    // Get page title and final URL for the Roku client
    const title    = await page.title();
    const finalUrl = page.url();

    // Get total scroll height for paging
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);

    res.set({
      "Content-Type":        "image/jpeg",
      "X-Page-Title":        encodeURIComponent(title.substring(0, 80)),
      "X-Final-Url":         encodeURIComponent(finalUrl.substring(0, 200)),
      "X-Scroll-Height":     String(scrollHeight),
      "X-Scroll-Position":   String(scrollY),
      "Cache-Control":       "no-store"
    });
    res.send(screenshot);

  } catch (err) {
    console.error("Screenshot error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
});

// Click-and-screenshot endpoint
// POST /click  body: { url, x, y, scroll }
app.use(express.json());
app.post("/click", async (req, res) => {
  const { url, x, y, scroll } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1"
    );
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["font","media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 1000));

    if (scroll > 0) {
      await page.evaluate((sy) => window.scrollTo(0, sy), scroll);
      await new Promise(r => setTimeout(r, 200));
    }

    // Perform the click
    await page.mouse.click(x, y + scroll);
    await new Promise(r => setTimeout(r, 2000));

    const finalUrl     = page.url();
    const title        = await page.title();
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);

    // Take screenshot of result
    await page.evaluate((sy) => window.scrollTo(0, sy), 0);
    await new Promise(r => setTimeout(r, 300));

    const screenshot = await page.screenshot({
      type: "jpeg",
      quality: 82,
      clip: { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H }
    });

    res.set({
      "Content-Type":      "image/jpeg",
      "X-Page-Title":      encodeURIComponent(title.substring(0, 80)),
      "X-Final-Url":       encodeURIComponent(finalUrl.substring(0, 200)),
      "X-Scroll-Height":   String(scrollHeight),
      "X-Scroll-Position": "0",
      "Cache-Control":     "no-store"
    });
    res.send(screenshot);

  } catch (err) {
    console.error("Click error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

app.listen(PORT, () => {
  console.log(`PieBrowser render server listening on port ${PORT}`);
});
