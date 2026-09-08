/**
 * server.js — Chatbot RAG + LabAssist Voice (Merged)
 *
 * All original RAG routes unchanged.
 * NEW: /api/voice/chat  → proxies text  to Flask :5000/chat
 *      /api/voice/audio → proxies audio to Flask :5000/audio-chat
 *
 * Run order:
 *   1. Start XAMPP (MySQL)
 *   2. Start Redis
 *   3. python app.py        (Flask voice, port 5000)
 *   4. node server.js       (this file, port 3000)
 */

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const fetch      = require('node-fetch');
const FormData   = require('form-data');
require('dotenv').config();

const chatRoutes = require('./routes/chat');
const cache      = require('./services/cacheService');
const { init, reloadQA }   = require('./services/knowledgeService');
const { clearPageCache }   = require('./rag/websiteReader');

const app    = express();
const PORT   = process.env.PORT || 3000;
const FLASK  = process.env.FLASK_URL || 'http://localhost:5000';

// ── Multer: hold audio in memory so we can forward it to Flask ──
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve test.html at root ──────────────────────────────────────
app.use(express.static(__dirname));

// ── Original RAG routes (unchanged) ─────────────────────────────
app.use('/api/chat', chatRoutes);

// ════════════════════════════════════════════════════════════════
// VOICE ROUTES — proxy to Flask LabAssist
// ════════════════════════════════════════════════════════════════

/**
 * POST /api/voice/chat
 * Body: { question: string }
 * Forwards to Flask /chat, returns Flask response directly.
 */
app.post('/api/voice/chat', async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });

    try {
        const flaskRes = await fetch(`${FLASK}/chat`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ question }),
        });
        const data = await flaskRes.json();
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ Flask voice/chat error:', err.message);
        res.status(503).json({
            success: false,
            error:   'Voice service unavailable. Is the Flask server running on port 5000?',
            details: err.message,
        });
    }
});

/**
 * POST /api/voice/audio
 * Multipart: field "audio" = WAV blob from browser MediaRecorder.
 * Forwards to Flask /audio-chat, returns transcript + answer.
 */
app.post('/api/voice/audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file received' });

    try {
        const form = new FormData();
        form.append('audio', req.file.buffer, {
            filename:    'voice.wav',
            contentType: req.file.mimetype || 'audio/wav',
        });

        const flaskRes = await fetch(`${FLASK}/audio-chat`, {
            method:  'POST',
            body:    form,
            headers: form.getHeaders(),
        });
        const data = await flaskRes.json();
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ Flask audio-chat error:', err.message);
        res.status(503).json({
            success: false,
            error:   'Voice service unavailable. Is the Flask server running on port 5000?',
            details: err.message,
        });
    }
});

/**
 * GET /api/voice/health
 * Quick check: is Flask alive?
 */
app.get('/api/voice/health', async (req, res) => {
    try {
        const r = await fetch(`${FLASK}/`, { method: 'GET' });
        res.json({ flask_alive: r.ok, status: r.status });
    } catch {
        res.json({ flask_alive: false, error: 'Flask not reachable' });
    }
});

// ════════════════════════════════════════════════════════════════
// Original utility routes (unchanged)
// ════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status:    'OK',
        timestamp: new Date().toISOString(),
        cache:     cache.isConnected ? 'connected' : 'unavailable',
    });
});

app.delete('/api/cache', async (req, res) => {
    const { pattern } = req.query;
    await cache.flush(pattern || '*');
    res.json({ success: true, message: `Cache flushed (pattern: ${pattern || '*'})` });
});

app.post('/api/reload-qa', (req, res) => {
    const result = reloadQA();
    res.json({ success: true, ...result });
});

app.post('/api/clear-site-cache', async (req, res) => {
    await clearPageCache();
    res.json({ success: true, message: 'Website page cache cleared' });
});

// ════════════════════════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════════════════════════

async function start() {
    await cache.connect();
    await init();

    app.listen(PORT, () => {
        console.log(`\n🚀 Chatbot RAG + Voice API  →  http://localhost:${PORT}`);
        console.log(`🎙️  Voice proxy (Flask)      →  ${FLASK}`);
        console.log(`\n📝 RAG chat:       POST  /api/chat/ask`);
        console.log(`🎙️  Voice text:     POST  /api/voice/chat`);
        console.log(`🎤 Voice audio:     POST  /api/voice/audio`);
        console.log(`💚 Voice health:    GET   /api/voice/health`);
        console.log(`🔄 Reload Q&A:      POST  /api/reload-qa`);
        console.log(`🌐 Clear site cache:POST  /api/clear-site-cache`);
        console.log(`🗑️  Flush Redis:     DELETE/api/cache\n`);
    });
}

process.on('SIGTERM', async () => { await cache.disconnect(); process.exit(0); });
process.on('SIGINT',  async () => { await cache.disconnect(); process.exit(0); });

start();
