const express    = require("express");
const playwright = require("playwright-core");
const chromium   = require("@sparticuz/chromium");

const app  = express();
const PORT = process.env.PORT || 3000;
const W    = 1280;
const MAX_HEIGHT = 3840;

let browser  = null;
let lastMeta = { finalUrl: "", title: "" };

async function getBrowser() {
    if (browser) {
        try {
            // Test if still alive
            await browser.version();
            return browser;
        } catch(e) {
            browser = null;
        }
    }
    browser = await playwright.chromium.launch({
        args:            chromium.args,
        executablePath:  await chromium.executablePath(),
        headless:        true
    });
    return browser;
}

async function buildPage(b, url) {
    const ctx  = await b.newContext({
        viewport:  { width: W, height: 720 },
        userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1"
    });
    const page = await ctx.newPage();

    // Block heavy resources for speed
    await page.route("**/*", route => {
        const type = route.request().resourceType();
        if (["font","media","stylesheet"].includes(type)) {
            route.abort();
        } else {
            route.continue();
        }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1200);

    // Hide cookie banners and popups
    await page.evaluate(() => {
        const sels = [
            "[class*='cookie']","[id*='cookie']","[class*='gdpr']","[id*='gdpr']",
            "[class*='consent']","[id*='consent']","[class*='popup']","[id*='popup']",
            "[class*='overlay']","[id*='overlay']","[class*='modal']","[id*='modal']",
            "[class*='banner']","[id*='banner']"
        ];
        sels.forEach(s => {
            try { document.querySelectorAll(s).forEach(el => el.style.display = "none"); } catch(e) {}
        });
    });

    return { page, ctx };
}

app.get("/", (req, res) => res.send("PieBrowser server running OK"));
app.get("/ping", (req, res) => res.json({ ok: true }));
app.get("/lastmeta", (req, res) => res.json(lastMeta));

// Full page screenshot
app.get("/fullpage", async (req, res) => {
    const url = req.query.url;
    if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Invalid url" });

    let ctx = null;
    try {
        const b        = await getBrowser();
        const result   = await buildPage(b, url);
        const page     = result.page;
        ctx            = result.ctx;

        const title    = await page.title();
        const finalUrl = page.url();
        lastMeta       = { finalUrl, title };

        const fullH = await page.evaluate(() =>
            Math.min(document.body.scrollHeight, document.documentElement.scrollHeight)
        );
        const capH = Math.min(Math.max(fullH, 720), MAX_HEIGHT);

        await page.setViewportSize({ width: W, height: capH });
        await page.waitForTimeout(400);

        const buf = await page.screenshot({
            type:    "jpeg",
            quality: 75,
            clip:    { x: 0, y: 0, width: W, height: capH }
        });

        res.set({
            "Content-Type":  "image/jpeg",
            "X-Page-Height": String(capH),
            "X-Final-Url":   encodeURIComponent(finalUrl.substring(0, 300)),
            "X-Page-Title":  encodeURIComponent(title.substring(0, 100)),
            "Cache-Control": "no-store"
        });
        res.send(buf);

    } catch(err) {
        console.error("fullpage error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (ctx) try { await ctx.close(); } catch(_) {}
    }
});

// Click via GET
app.get("/clickget", async (req, res) => {
    const url = req.query.url;
    const x   = parseInt(req.query.x) || 640;
    const y   = parseInt(req.query.y) || 360;
    const h   = parseInt(req.query.h) || MAX_HEIGHT;
    if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Invalid url" });

    let ctx = null;
    try {
        const b      = await getBrowser();
        const result = await buildPage(b, url);
        const page   = result.page;
        ctx          = result.ctx;

        const capH = Math.min(h, MAX_HEIGHT);
        await page.setViewportSize({ width: W, height: capH });
        await page.waitForTimeout(400);

        await page.mouse.click(x, y);
        await page.waitForTimeout(2500);

        const finalUrl = page.url();
        const title    = await page.title();
        lastMeta       = { finalUrl, title };

        const fullH = await page.evaluate(() =>
            Math.min(document.body.scrollHeight, document.documentElement.scrollHeight)
        );
        const newH = Math.min(Math.max(fullH, 720), MAX_HEIGHT);
        await page.setViewportSize({ width: W, height: newH });
        await page.waitForTimeout(400);

        const buf = await page.screenshot({
            type:    "jpeg",
            quality: 75,
            clip:    { x: 0, y: 0, width: W, height: newH }
        });

        res.set({
            "Content-Type":  "image/jpeg",
            "X-Page-Height": String(newH),
            "X-Final-Url":   encodeURIComponent(finalUrl.substring(0, 300)),
            "X-Page-Title":  encodeURIComponent(title.substring(0, 100)),
            "Cache-Control": "no-store"
        });
        res.send(buf);

    } catch(err) {
        console.error("clickget error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (ctx) try { await ctx.close(); } catch(_) {}
    }
});

app.listen(PORT, () => console.log("PieBrowser server on port " + PORT));
