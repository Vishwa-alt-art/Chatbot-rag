/**
 * knowledgeService.js  (UPDATED — website-scoped RAG)
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolution order for every user question:
 *
 *  Layer 1 — Default Q&A (defaultQA.json)
 *    Instant, no API. Business hours, policies, FAQs.
 *
 *  Layer 2 — Website knowledge (websiteKnowledge.json + embeddings)
 *    Retrieves the most relevant page chunks from the crawled website,
 *    then asks GPT to synthesise a grounded answer from ONLY that content.
 *    GPT is instructed to say "I don't have that information" if the
 *    chunks don't contain an answer — no hallucination allowed.
 *
 *  Layer 3 — null
 *    Returned when neither layer matches.
 *    The existing LLM+DB pipeline handles it (products, orders, etc.).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Key design decisions:
 *  • Website knowledge is NEVER mixed with DB data — clean separation.
 *  • GPT is given a strict "only answer from the provided content" system prompt.
 *  • If the retrieved chunks have avg score < MIN_SCORE_THRESHOLD, we skip GPT
 *    entirely and return null so the DB pipeline can take over.
 *  • Domain DB keywords short-circuit directly to DB pipeline (no website lookup).
 */

const path   = require('path');
const fs     = require('fs');
const OpenAI = require('openai');
require('dotenv').config();

const { findRelevantChunks, precomputeEmbeddings } = require('./embeddingService');

// ─── Config ──────────────────────────────────────────────────────────────────
const QA_PATH            = path.resolve(__dirname, '../data/defaultQA.json');
const KNOWLEDGE_PATH     = path.resolve(__dirname, '../data/websiteKnowledge.json');
const TOP_K              = 4;      // chunks to retrieve per query
const MIN_SCORE_THRESHOLD = 0.22;  // below this → skip GPT, fall to DB pipeline
const MAX_CONTEXT_CHARS  = 3000;   // guard against huge prompts

// ─── State ───────────────────────────────────────────────────────────────────
let defaultQA       = null;
let websiteKnowledge = null;   // parsed websiteKnowledge.json
let embeddingsReady  = false;

// ─── Load / reload helpers ───────────────────────────────────────────────────

function loadQA() {
    try {
        delete require.cache[QA_PATH];
        defaultQA = require(QA_PATH);
        console.log(`📚 Loaded ${defaultQA.faqs?.length || 0} default Q&A entries`);
    } catch (err) {
        console.warn('⚠️  Could not load defaultQA.json:', err.message);
        defaultQA = { faqs: [] };
    }
}

async function loadWebsiteKnowledge() {
    try {
        if (!fs.existsSync(KNOWLEDGE_PATH)) {
            console.warn('⚠️  websiteKnowledge.json not found — website layer disabled');
            websiteKnowledge = { chunks: [], totalChunks: 0 };
            return;
        }

        const raw  = fs.readFileSync(KNOWLEDGE_PATH, 'utf-8');
        const data = JSON.parse(raw);

        websiteKnowledge = data;
        const chunks = data.chunks || [];
        console.log(`🌐 Website knowledge: ${data.totalPages} pages, ${chunks.length} chunks`);

        if (chunks.length > 0) {
            await precomputeEmbeddings(chunks);
            embeddingsReady = true;
        }
    } catch (err) {
        console.warn('⚠️  Could not load websiteKnowledge.json:', err.message);
        websiteKnowledge = { chunks: [], totalChunks: 0 };
    }
}

// ─── Layer 1: Default Q&A ─────────────────────────────────────────────────────

function matchDefaultQA(question) {
    if (!defaultQA?.faqs?.length) return null;
    const q = question.toLowerCase().trim();
    for (const entry of defaultQA.faqs) {
        for (const phrase of entry.questions) {
            if (q.includes(phrase.toLowerCase())) {
                console.log(`✅ Default QA match: [${entry.id}]`);
                return entry.answer;
            }
        }
    }
    return null;
}

// ─── Domain guard — questions that must go to the DB pipeline ────────────────

/**
 * Hard domain keywords — if any are present the question is about store data
 * (products, orders, customers, inventory) and should NOT be handled here.
 */
const DB_DOMAIN_KEYWORDS = [
    'product', 'price', 'stock', 'customer', 'order', 'warehouse',
    'inventory', 'laptop', 'monitor', 'keyboard', 'mouse', 'cable',
    'category', 'electronics', 'accessories', 'shipped', 'membership',
    'gold', 'silver', 'platinum', 'purchase', 'bought', 'cart',
    'order status', 'track order', 'my order', 'invoice', 'receipt',
    'delivery', 'in stock', 'out of stock'
];

function isDBQuestion(question) {
    const q = question.toLowerCase();
    return DB_DOMAIN_KEYWORDS.some(kw => q.includes(kw));
}

// ─── Layer 2: Website knowledge retrieval + GPT synthesis ────────────────────

async function answerFromWebsite(question) {
    const chunks = websiteKnowledge?.chunks || [];
    if (chunks.length === 0) return null;

    // Retrieve top-K most relevant chunks
    const topChunks = await findRelevantChunks(question, chunks, TOP_K);

    if (topChunks.length === 0) {
        console.log(`🔍 No relevant website chunks found for: "${question}"`);
        return null;
    }

    const bestScore = topChunks[0].score;
    console.log(`🌐 Website retrieval: top score=${bestScore.toFixed(3)}, method=${topChunks[0].method}`);

    // If even the best chunk is a weak match, don't waste a GPT call
    if (bestScore < MIN_SCORE_THRESHOLD) {
        console.log(`ℹ️  Best score ${bestScore.toFixed(3)} < threshold ${MIN_SCORE_THRESHOLD} — skipping website layer`);
        return null;
    }

    // Build context string (trim to avoid huge prompts)
    const context = topChunks
        .map((c, i) => `[Source ${i + 1}: ${c.title || c.url}]\n${c.text}`)
        .join('\n\n---\n\n')
        .slice(0, MAX_CONTEXT_CHARS);

    // Ask GPT to synthesise an answer from ONLY the retrieved content
    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `You are a helpful assistant for the NeuralArc website.

Your ONLY job is to answer the user's question using the website content provided below.

STRICT RULES:
1. Answer ONLY from the provided content. Do NOT use outside knowledge.
2. If the content does not contain a clear answer, say EXACTLY:
   "I don't have specific information about that on the NeuralArc website. You can visit neuralarc.com directly or contact the team for more details."
3. Do NOT mention "Source 1", "Source 2", or cite chunk indices in your reply.
4. Be concise (2–5 sentences unless a list is genuinely needed).
5. Do NOT mention products, prices, stock, orders, or any database content.
6. Sound natural and helpful — you represent NeuralArc.

WEBSITE CONTENT:
${context}`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3,
            max_tokens: 400
        });

        const answer = response.choices[0].message.content.trim();

        // Safety check: if GPT somehow leaked "I don't have information" for a
        // question where we DID find good chunks, that's fine — we trust it.
        return answer;

    } catch (err) {
        console.error('Website GPT synthesis error:', err.message);
        return null;
    }
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolves a question through all knowledge layers.
 *
 * Returns { answer, source } or null.
 * null → let the existing LLM+DB pipeline handle it.
 */
async function resolveKnowledge(question) {
    // ── Layer 1: Default Q&A ────────────────────────────────────────────────
    const qaAnswer = matchDefaultQA(question);
    if (qaAnswer) {
        return { answer: qaAnswer, source: 'default_qa' };
    }

    // ── Guard: DB-domain questions go straight to the DB pipeline ──────────
    if (isDBQuestion(question)) {
        console.log(`🗄️  DB-domain question — routing to DB pipeline: "${question}"`);
        return null;
    }

    // ── Layer 2: Website knowledge ──────────────────────────────────────────
    if (websiteKnowledge?.chunks?.length > 0) {
        const websiteAnswer = await answerFromWebsite(question);
        if (websiteAnswer) {
            return { answer: websiteAnswer, source: 'website_knowledge' };
        }
    }

    // ── Layer 3: Not handled — fall through to DB pipeline ─────────────────
    // The DB pipeline's LLM will decide if it's a general or DB question.
    // If it can't answer either, it replies with its own fallback message.
    return null;
}

// ─── Reload helpers (for hot-reload API endpoint) ─────────────────────────────

function reloadQA() {
    loadQA();
    return { reloaded: true, count: defaultQA?.faqs?.length || 0 };
}

async function reloadWebsiteKnowledge() {
    embeddingsReady = false;
    await loadWebsiteKnowledge();
    return {
        reloaded:    true,
        pages:       websiteKnowledge?.totalPages  || 0,
        chunks:      websiteKnowledge?.totalChunks || 0,
        embeddings:  embeddingsReady
    };
}

// ─── Init (called once at server startup) ────────────────────────────────────

async function init() {
    loadQA();
    await loadWebsiteKnowledge();
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
    init,
    resolveKnowledge,
    reloadQA,
    reloadWebsiteKnowledge,
    matchDefaultQA,
    isDBQuestion
};