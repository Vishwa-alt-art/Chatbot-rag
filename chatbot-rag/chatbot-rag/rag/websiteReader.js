/**
 * websiteReader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads neuralarc.com LIVE using a headless browser.
 * No pre-crawl. No JSON file. No manual maintenance.
 *
 * On every question:
 *   1. Determine which page(s) are relevant to the question
 *   2. Check Redis cache (1 hour TTL) — return cached text if fresh
 *   3. If not cached — launch Playwright, fetch the page, extract text, cache it
 *   4. Return the live text to knowledgeService for GPT synthesis
 */

'use strict';

const cache = require('../services/cacheService');
require('dotenv').config();

const ROOT_URL = process.env.WEBSITE_URL || 'https://neuralarc.com';
const PAGE_CACHE_TTL = 60 * 60; // 1 hour

// ─── Site map ─────────────────────────────────────────────────────────────────
// Maps intent keywords → which page to fetch live.
// Add more entries as your site grows.
const SITE_MAP = [
    {
        id:       'home',
        url:      `${ROOT_URL}`,
        keywords: ['neuralarc', 'about', 'company', 'who are', 'what is', 'what does', 'overview', 'introduction', 'founded', 'mission', 'vision', 'values']
    },
    {
        id:       'about',
        url:      `${ROOT_URL}/about`,
        keywords: ['about', 'company', 'team', 'experience', 'founded', 'history', 'background', 'who', 'values', 'mission', 'experts', 'professionals']
    },
    {
        id:       'services',
        url:      `${ROOT_URL}/Services`,
        keywords: ['service', 'services', 'offer', 'provide', 'offerings', 'what do you do', 'capabilities']
    },
    {
        id:       'iot',
        url:      `${ROOT_URL}/services/iot`,
        keywords: ['iot', 'internet of things', 'smart device', 'gateway', 'sensor', 'edge', 'automation', 'agriculture', 'logistics', 'building automation', 'monitoring']
    },
    {
        id:       'ai',
        url:      `${ROOT_URL}/services/AI,%20ML%20&%20Data%20Science`,
        keywords: ['ai', 'artificial intelligence', 'machine learning', 'ml', 'data science', 'nlp', 'computer vision', 'predictive', 'analytics', 'deep learning', 'neural']
    },
    {
        id:       'embedded',
        url:      `${ROOT_URL}/services/Embedded%20Software%20Development`,
        keywords: ['embedded', 'firmware', 'rtos', 'microcontroller', 'hardware', 'driver', 'real time', 'low level', 'embedded software']
    },
    {
        id:       'fullstack',
        url:      `${ROOT_URL}/services/Full%20Stack%20Development`,
        keywords: ['full stack', 'fullstack', 'web development', 'frontend', 'backend', 'react', 'node', 'api', 'web app', 'website development']
    },
    {
        id:       'mobile',
        url:      `${ROOT_URL}/services/app-development`,
        keywords: ['mobile', 'app', 'android', 'ios', 'application', 'flutter', 'react native', 'app development']
    },
    {
        id:       'training',
        url:      `${ROOT_URL}/services/training`,
        keywords: ['training', 'internship', 'intern', 'course', 'learn', 'program', 'certification', 'workshop', 'placement', 'student']
    },
    {
        id:       'contact',
        url:      `${ROOT_URL}/contact`,
        keywords: ['contact', 'reach', 'email', 'phone', 'address', 'location', 'office', 'get in touch', 'support', 'enquiry', 'inquiry']
    }
];

// ─── Page selector ────────────────────────────────────────────────────────────

/**
 * Pick the most relevant pages for the question.
 * Returns up to 2 pages sorted by keyword match count.
 */
function selectPages(question) {
    const q = question.toLowerCase();

    const scored = SITE_MAP.map(page => {
        const hits = page.keywords.filter(kw => q.includes(kw)).length;
        return { ...page, hits };
    }).filter(p => p.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    // Always include home as a fallback if nothing matched
    if (scored.length === 0) {
        return [SITE_MAP[0]]; // home page
    }

    return scored.slice(0, 2);
}

// ─── Live page fetcher ────────────────────────────────────────────────────────

/**
 * Fetch a single URL with Playwright and return clean body text.
 * Skips nav/footer/script/style noise.
 */
async function fetchPageLive(url) {
    let browser = null;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage({
            userAgent: 'Mozilla/5.0 (compatible; NeuralArcBot/1.0)'
        });

        await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(1500); // let lazy content render

        const text = await page.evaluate(() => {
            // Remove noise elements before extracting
            ['script','style','noscript','nav','footer','header','iframe','svg']
                .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));

            return (document.body?.innerText || '')
                .replace(/\s{3,}/g, '\n\n')
                .replace(/\n{4,}/g, '\n\n\n')
                .trim();
        });

        return text || null;
    } catch (err) {
        console.error(`❌ Failed to fetch ${url}:`, err.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

// ─── Main: get live content for a question ────────────────────────────────────

/**
 * Returns an array of { url, title, text } objects for the most relevant pages.
 * Hits Redis cache first; fetches live only on cache miss.
 *
 * @param {string} question
 * @returns {Promise<Array<{url, title, text}>>}
 */
async function getLiveContent(question) {
    const pages  = selectPages(question);
    const result = [];

    console.log(`🌐 Live pages selected for "${question}": ${pages.map(p => p.id).join(', ')}`);

    for (const pageDef of pages) {
        const cacheKey = `website_page:${pageDef.id}`;

        // Try cache first
        const cached = await cache.get(cacheKey);
        if (cached) {
            console.log(`🎯 Page cache HIT: ${pageDef.id}`);
            result.push({ url: pageDef.url, title: pageDef.id, text: cached });
            continue;
        }

        // Live fetch
        console.log(`🔗 Fetching live: ${pageDef.url}`);
        const text = await fetchPageLive(pageDef.url);

        if (text && text.length > 50) {
            await cache.set(cacheKey, text, PAGE_CACHE_TTL);
            console.log(`✅ Fetched & cached: ${pageDef.id} (${text.length} chars)`);
            result.push({ url: pageDef.url, title: pageDef.id, text });
        } else {
            console.warn(`⚠️  Thin or no content from ${pageDef.url}`);
        }
    }

    return result;
}

/**
 * Invalidate all cached website pages (call after site update).
 */
async function clearPageCache() {
    await cache.flush('website_page:*');
    console.log('🗑️  Website page cache cleared');
}

module.exports = { getLiveContent, clearPageCache, selectPages };