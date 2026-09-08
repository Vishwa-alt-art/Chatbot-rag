const express = require('express');
const router = express.Router();
const llmRetriever = require('../rag/llmRetriever');
const db = require('../db/database');
const { resolveKnowledge, matchDefaultQA, isDBQuestion } = require('../services/knowledgeService');
const { getLiveContent } = require('../rag/websiteReader');
const OpenAI = require('openai');

const USE_LLM = true;

/**
 * Layer constants sent from the frontend:
 *   'all'    — default full pipeline (static → db → website)
 *   'static' — only defaultQA.json keyword match
 *   'db'     — only MySQL / LLM SQL pipeline
 *   'web'    — only live website fetch + GPT synthesis
 */
const VALID_LAYERS = new Set(['all', 'static', 'db', 'web']);

router.post('/ask', async (req, res) => {
    try {
        const { question, session_id, layer = 'all' } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        const sessionId    = session_id || req.ip || 'default';
        const searchLayer  = VALID_LAYERS.has(layer) ? layer : 'all';

        console.log(`🤖 [${sessionId}] Layer: "${searchLayer}" | Q: "${question}"`);

        let result;

        // ── Layer-specific routing ──────────────────────────────────────────

        if (searchLayer === 'static') {
            // Only check defaultQA.json — no DB, no website
            const answer = matchDefaultQA(question);
            if (answer) {
                result = {
                    question,
                    answer,
                    context_used: { intent: 'default_qa', source: 'default_qa', from_cache: false, session_id: sessionId }
                };
            } else {
                result = {
                    question,
                    answer: "ℹ️ No static Q&A match found for that question. Try switching to **Database** or **Website** layer, or use **All layers**.",
                    context_used: { intent: 'no_match', source: 'default_qa', session_id: sessionId }
                };
            }

        } else if (searchLayer === 'db') {
            // Only the DB / LLM SQL pipeline — skip static and website layers
            result = await llmRetriever.answerWithLLM(question, sessionId, { skipKnowledge: true });

        } else if (searchLayer === 'web') {
            // Only live website read + GPT synthesis
            result = await handleWebsiteOnlyQuery(question, sessionId);

        } else {
            // 'all' — full pipeline (existing behaviour)
            result = await llmRetriever.answerWithLLM(question, sessionId);
        }

        res.json({
            success: true,
            data: result,
            mode: USE_LLM ? 'llm' : 'rag',
            layer: searchLayer
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * Website-only handler: fetches live pages and asks GPT to synthesise an answer.
 * Returns the same result shape as llmRetriever.answerWithLLM.
 */
async function handleWebsiteOnlyQuery(question, sessionId) {
    const pages = await getLiveContent(question);

    if (!pages || pages.length === 0) {
        return {
            question,
            answer: "🌐 I couldn't retrieve any relevant content from the website for that question. Try the **All layers** mode.",
            context_used: { intent: 'website_live', source: 'website_live', data_found: 0, session_id: sessionId }
        };
    }

    const MAX_CTX = 1500;
    const context = pages
        .map(p => `=== ${p.url} ===\n${p.text}`)
        .join('\n\n')
        .slice(0, MAX_CTX);

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a helpful assistant for NeuralArc (neuralarc.com).
Answer the user's question using ONLY the website content provided below.
STRICT RULES:
1. Use only what is in the provided content. No outside knowledge.
2. If the content does not contain a clear answer, say:
   "I don't have specific information about that. Please visit neuralarc.com or contact the team directly."
3. Be concise and natural — 2 to 5 sentences or a short bullet list.
4. Never mention "context", "chunk", "source", or internal terms.
5. Sound like a knowledgeable NeuralArc team member.

LIVE WEBSITE CONTENT:
${context}`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3,
            max_tokens: 80
        });

        return {
            question,
            answer: res.choices[0].message.content.trim(),
            context_used: {
                intent: 'website_live',
                source: 'website_live',
                data_found: pages.length,
                used_llm: true,
                session_id: sessionId
            }
        };

    } catch (err) {
        console.error('Website-only GPT error:', err.message);
        return {
            question,
            answer: "⚠️ Failed to synthesise a website answer. Please try again.",
            context_used: { intent: 'website_live', source: 'website_live', error: err.message, session_id: sessionId }
        };
    }
}

router.post('/mode', (req, res) => {
    const { use_llm } = req.body;
    res.json({
        success: true,
        message: `Mode would be set to ${use_llm ? 'LLM' : 'RAG'}`,
        tip: 'Restart server with USE_LLM = ' + use_llm
    });
});

router.get('/history', async (req, res) => {
    try {
        const [history] = await db.pool.execute(
            'SELECT * FROM conversation_history ORDER BY created_at DESC LIMIT 50'
        );
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;