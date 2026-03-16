const express = require("express");
const puppeteer = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 3000;
const W    = 1280;
const MAX_PAGE_HEIGHT = 4000; // Roku max texture ~4096px tall

let browser  = null;
let lastMeta = { finalUrl: "", title: "" };

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    browser = await puppeteer.launch({
        headless: "new",
        args: [
            "--no-sandbox","--disable-setuid-sandbox",
            "--disable-dev-shm-usage","--disable-gpu",
            "--no-first-run","--no-zygote",
            "--single-process","--disable-extensions"
        ]
    });
    browser.on("disconnected", () => { browser = null; });
    return browser;
}

async function buildPage(b, url) {
    const page = await b.newPage();
    await page.setViewport({ width: W, height: 720, deviceScaleFactor: 1 });
    await page.setUserAgent(
        "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1"
    );
    await page.setRequestInterception(true);
    page.on("request", req => {
        if (["font","media"].includes(req.resourceType())) req.abort();
        else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
        const sels = [
            "[class*='cookie']","[id*='cookie']","[class*='gdpr']","[id*='gdpr']",
            "[class*='consent']","[id*='consent']","[class*='popup']","[id*='popup']",
            "[class*='overlay']","[id*='overlay']","[class*='modal']","[id*='modal']",
            "[class*='banner']","[id*='banner']"
        ];
        sels.forEach(s => document.querySelectorAll(s).forEach(el => el.style.display = "none"));
        document.body.style.overflow = "auto";
    });
    return page;
}

// Health check
app.get("/", (req, res) => res.send("PieBrowser render server running."));

// GET /lastmeta
app.get("/lastmeta", (req, res) => res.json(lastMeta));

// GET /meta?url=...
app.get("/meta", async (req, res) => {
    const url = req.query.url;
    if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Invalid url" });
    let page = null;
    try {
        const b = await getBrowser();
        page = await b.newPage();
        await page.setUserAgent("Mozilla/5.0 (compatible)");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const title    = await page.title();
        const finalUrl = page.url();
        res.json({ finalUrl, title });
    } catch(err) {
        res.json({ finalUrl: url, title: "" });
    } finally {
        if (page) try { await page.close(); } catch(_) {}
    }
});

// GET /fullpage?url=...
// Takes ONE tall screenshot of the entire page (up to MAX_PAGE_HEIGHT px)
// Roku downloads this once and pans around it locally - no more per-scroll requests
app.get("/fullpage", async (req, res) => {
    const url = req.query.url;
    if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Invalid url" });

    let page = null;
    try {
        const b    = await getBrowser();
        page       = await buildPage(b, url);

        // Get real page height, cap at MAX_PAGE_HEIGHT
        const fullH = await page.evaluate(() => document.body.scrollHeight);
        const capH  = Math.min(fullH, MAX_PAGE_HEIGHT);

        // Resize viewport to full page height to capture everything at once
        await page.setViewport({ width: W, height: capH, deviceScaleFactor: 1 });
        await new Promise(r => setTimeout(r, 400));

        const title    = await page.title();
        const finalUrl = page.url();
        lastMeta       = { finalUrl, title };

        // Full page screenshot as JPEG
        const buf = await page.screenshot({
            type:    "jpeg",
            quality: 80,
            clip:    { x: 0, y: 0, width: W, height: capH }
        });

        res.set({
            "Content-Type":    "image/jpeg",
            "X-Page-Height":   String(capH),
            "X-Full-Height":   String(fullH),
            "X-Final-Url":     encodeURIComponent(finalUrl.substring(0, 300)),
            "X-Page-Title":    encodeURIComponent(title.substring(0, 100)),
            "Cache-Control":   "no-store"
        });
        res.send(buf);

    } catch(err) {
        console.error(err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (page) try { await page.close(); } catch(_) {}
    }
});

// POST /click  body: { url, x, y, scrollY, imageHeight }
// x,y are in IMAGE coordinates (since Roku pans a tall image)
app.use(express.json());
app.post("/click", async (req, res) => {
    const { url, x, y, imageHeight } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });

    let page = null;
    try {
        const b   = await getBrowser();
        page      = await buildPage(b, url);

        // Expand viewport to match the full image height we originally captured
        const capH = imageHeight || MAX_PAGE_HEIGHT;
        await page.setViewport({ width: W, height: capH, deviceScaleFactor: 1 });
        await new Promise(r => setTimeout(r, 400));

        // Click at the image coordinate directly
        await page.mouse.click(x, y);
        await new Promise(r => setTimeout(r, 2500));

        const finalUrl  = page.url();
        const title     = await page.title();
        lastMeta        = { finalUrl, title };

        // Return the new page as a full-page screenshot
        const fullH = await page.evaluate(() => document.body.scrollHeight);
        const newH  = Math.min(fullH, MAX_PAGE_HEIGHT);
        await page.setViewport({ width: W, height: newH, deviceScaleFactor: 1 });
        await new Promise(r => setTimeout(r, 400));

        const buf = await page.screenshot({
            type:    "jpeg",
            quality: 80,
            clip:    { x: 0, y: 0, width: W, height: newH }
        });

        res.set({
            "Content-Type":  "image/jpeg",
            "X-Page-Height": String(newH),
            "X-Full-Height": String(fullH),
            "X-Final-Url":   encodeURIComponent(finalUrl.substring(0, 300)),
            "X-Page-Title":  encodeURIComponent(title.substring(0, 100)),
            "Cache-Control": "no-store"
        });
        res.send(buf);

    } catch(err) {
        console.error(err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (page) try { await page.close(); } catch(_) {}
    }
});

app.listen(PORT, () => console.log(`PieBrowser server on port ${PORT}`));
