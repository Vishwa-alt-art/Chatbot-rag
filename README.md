# Chatbot-RAG

A production-style **conversational store assistant** that answers natural-language questions about products, customers, orders and warehouse inventory — backed by a **Retrieval-Augmented Generation (RAG)** pipeline, an **OpenAI LLM**, live **website reading**, and an optional **bilingual voice interface**.

The bot understands intent, resolves follow-up pronouns ("show me **his** orders"), generates safe SQL against a MySQL schema, synthesises answers with GPT, and keeps everything fast with a Redis cache layer. When it can't find something in the database, it reads the live company website and answers from that.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Database schema](#database-schema)
- [Running the app](#running-the-app)
- [API reference](#api-reference)
- [How the RAG pipeline works](#how-the-rag-pipeline-works)
- [FAQ data](#faq-data)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Natural-language DB queries** — ask about products, prices, stock, customers, orders, spending and warehouse inventory in plain English.
- **RAG knowledge layers** answered in order:
  1. **Static** — instant keyword match against `defaultQA.json` (zero API calls)
  2. **Website (live)** — fetches relevant pages from `neuralarc.com` on demand with Playwright and answers from the live content
  3. **Database / LLM** — intent parsing, SQL generation and response synthesis with GPT
- **Configurable search layers** — clients can force one source via the `layer` parameter: `all`, `static`, `db`, `web`.
- **Conversation memory** — per-session context with pronoun resolution ("his orders") and automatic session pruning.
- **Redis caching** — intent parses, query results, LLM answers, table schemas and crawled pages are cached with per-type TTLs. The app degrades gracefully and runs without cache if Redis is down.
- **Voice support** — proxies text and audio to a Flask voice backend (LabAssist), returning transcriptions and spoken answers.
- **Health & ops endpoints** — health checks, cache flushing, Q&A reload, site-cache clearing.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser (test.html / chatos-demo-v2.html)                               │
│  ──────────────────────────────────────────                              │
│   text  ──┬──────────────────────────┐  audio ──┐                        │
│           ▼                          ▼           ▼                        │
│   POST /api/chat/ask          POST /api/voice/chat   POST /api/voice/audio│
└───────────┬──────────────────────────────────────────────┬───────────────┘
            │ (Express :3000)                               │ proxy
┌───────────▼──────────────────────────────────────────────▼───────────────┐
│  chatbot-rag/chatbot-rag (Node.js/Express "chatbot-rag")                 │
│  ───────────────────────────────────────────────────────────────         │
│  routes/chat.js  ──►  rag/llmRetriever.js  ──►  MySQL + Redis            │
│     │                    │                                              │
│     │              services/knowledgeService.js                         │
│     │                    │                                              │
│     │              rag/websiteReader.js ──► Playwright ──► neuralarc.com │
│     │              services/llmservice.js ◄──► OpenAI API (gpt-4o-mini) │
└───────────┬──────────────────────────────────────────────┬───────────────┘
            │                                              │ :5000
            ▼                                              ▼
   MySQL (chatbot_db)   Redis (cache)            Flask LabAssist voice backend
```

---

## Repository layout

```
Chatbot-rag/
├── README.md
├── .gitignore
│
├── chatbot-rag/                       # Main Node.js chatbot + RAG backend
│   ├── package.json
│   └── chatbot-rag/
│       ├── server.js                  # Express app — RAG routes + voice proxy
│       ├── package.json
│       ├── checkhome.js               # Diagnostic script
│       ├── diagnose.js                # Diagnostic script
│       ├── test-redis.js              # Redis smoke test
│       ├── test.html                  # Web chat UI (served at http://localhost:3000)
│       ├── data/
│       │   ├── defaultQA.json         # Static FAQ (keyword-matched, layer 1)
│       │   └── websiteKnowledge.json  # Legacy/optional knowledge
│       ├── db/
│       │   └── database.js            # MySQL pool + query helpers
│       ├── rag/
│       │   ├── embedding.js           # Lightweight TF-IDF-ish keyword extractor
│       │   ├── llmRetriever.js        # LLM RAG orchestrator (intent → SQL → answer)
│       │   ├── retriever.js           # Multi-table context retriever
│       │   ├── tableManager.js        # Schema-aware query builder
│       │   └── websiteReader.js       # Live website reader (Playwright + Redis)
│       ├── routes/
│       │   └── chat.js                # /api/chat/* endpoints
│       └── services/
│           ├── cacheService.js        # Redis cache wrapper (typed, TTL-aware)
│           ├── knowledgeService.js    # Layer resolution: static → website → DB
│           ├── Embeddingservice.js
│           ├── llmservice.js          # OpenAI: intent parsing, SQL, formatting
│           └── ...
│
├── Pro-ject/chatbot-rag/              # Alternative/earlier copy of the app
│   └── chatbot-rag/                   # Same stack, leaner module set
│
└── labassist-bilingual-gtts/          # Voice-assistant component
    ├── test_case.ipynb                # Test notebook
    └── labassist-gtts/
        ├── README.md                  # Original LabAssist bilingual voice readme
        └── chatos-demo-v2.html        # "ChatOS v2" demo UI (voice chat frontend)
```

> Note: `chatbot-rag/` and `Pro-ject/chatbot-rag/` are two variants of the same
> back-end. Follow the instructions below for the primary one under `chatbot-rag/chatbot-rag/`.

---

## Tech stack

| Layer       | Technology                                              |
|-------------|---------------------------------------------------------|
| Runtime     | Node.js (Express 5), Python 3 (Flask voice backend)     |
| Database    | MySQL (mysql2)                                          |
| Cache       | Redis (`redis`, with ioredis available)                 |
| AI          | OpenAI API — `gpt-4o-mini` intent/SQL/answer, `gpt-3.5-turbo` for some website synthesis |
| Web scraping| Playwright (headless Chromium)                          |
| Voice       | Flask + gTTS (Tamil) / pyttsx3 (English)                |
| Orchestration | dotenv, multer (audio upload), node-fetch, cors      |

---

## Prerequisites

1. **Node.js** 18+ and **npm**
2. **MySQL** (e.g. XAMPP running MySQL on `127.0.0.1:3306`)
3. **Redis** on `127.0.0.1:6379` (optional but recommended — the app runs without it)
4. **Python 3** + pip — only if you want the Flask voice backend
5. An **OpenAI API key**

---

## Installation

### 1. Backend (Node.js)

```bash
# from the repo root
cd chatbot-rag/chatbot-rag
npm install
```

### 2. Browser engine for live website reading

```bash
npx playwright install chromium
```

### 3. Voice backend (optional)

```bash
cd labassist-bilingual-gtts/labassist-gtts
pip install -r requirements.txt
```

> On Windows, if `pyaudio` fails to install, try:
> ```bash
> pip install pipwin
> pipwin install pyaudio
> ```

---

## Environment variables

Copy the reference values into a `.env` file inside `chatbot-rag/chatbot-rag/`:

```
PORT=3000
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=
DB_NAME=chatbot_db

FLASK_URL=http://localhost:5000

OPENAI_API_KEY=sk-...

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_TTL=3600

WEBSITE_URL=https://neuralarc.com
WEBSITE_MAX_PAGES=5
WEBSITE_CRAWL_DEPTH=3
WEBSITE_EXCLUDED_PATHS=/admin,/login,/logout,/cart,/checkout
WEBSITE_CRAWL_DELAY=300
WEBSITE_REQUEST_TIMEOUT=8000
WEBSITE_RECRAWL_ON_START=false
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Express listen port |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL connection (database `chatbot_db`) |
| `FLASK_URL` | `http://localhost:5000` | Voice backend base URL proxied by `/api/voice/*` |
| `OPENAI_API_KEY` | — | OpenAI key for intent parsing, SQL and answers |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_TTL` | `127.0.0.1` / `6379` / `3600` | Redis cache connection |
| `WEBSITE_URL` & `WEBSITE_*` | `https://neuralarc.com` | Live-crawl target and limits for the website layer |

---

## Database schema

The bot queries a `chatbot_db` database with the following core tables:

| Table | Purpose | Key columns |
|---|---|---|
| `products` | Catalog | `name`, `price`, `category`, `stock` |
| `customers` | Customer directory | `name`, `email`, `city`, `membership_level` |
| `orders` | Sales orders | `customer_id`, `order_date`, `total_amount`, `status` |
| `order_items` | Line items | `order_id`, `quantity`, `price` |
| `inventory` | Stock by warehouse | `product_id`, `warehouse_location`, `quantity`, `last_restocked` |
| `conversation_history` | Chat logging | `question`, `answer`, `context_used`, `created_at` |

---

## Running the app

Recommended startup order (matches `server.js`):

```bash
# 1. Start MySQL (XAMPP) and Redis — on Windows/Mac/Linux respectively

# 2. Voice backend (optional)
python app.py            # or: cd labassist-bilingual-gtts/labassist-gtts && python app.py

# 3. Chatbot backend
cd chatbot-rag/chatbot-rag
npm start                # node server.js  (or: npm run dev → nodemon)
```

Then open **http://localhost:3000** to use the chat UI (`test.html`).

Ports:
- `3000` — Node.js Chatbot RAG + voice proxy
- `5000` — Flask voice backend (LabAssist)

---

## API reference

Base URL: `http://localhost:3000`

### Chat (RAG)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat/ask` | Ask a question. Body: `{ "question": "...", "session_id": "opt", "layer": "all\|static\|db\|web" }` |
| `POST` | `/api/chat/mode` | Toggle LLM/RAG mode hint. Body: `{ "use_llm": true }` |
| `GET` | `/api/chat/history` | Last 50 saved conversations |

**`layer` options:**
- `all` — full pipeline (default): static Q&A → live website → DB
- `static` — only keyword FAQ from `defaultQA.json`
- `db` — only the DB / LLM-SQL pipeline
- `web` — only live website fetch + GPT synthesis

### Voice (proxied to Flask)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/voice/chat` | Send text to the voice backend. Body: `{ "question": "..." }` |
| `POST` | `/api/voice/audio` | Upload a WAV blob (multipart field `audio`), returns transcript + answer |
| `GET` | `/api/voice/health` | Check if the Flask voice backend is alive |

### Operations

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server + cache status |
| `POST` | `/api/reload-qa` | Reload `defaultQA.json` (warm reload) |
| `POST` | `/api/clear-site-cache` | Invalidate cached website pages |
| `DELETE` | `/api/cache?pattern=*` | Flush Redis keys matching `pattern` (default `*`) |

---

## How the RAG pipeline works

For every `POST /api/chat/ask` request (`layer=all`):

1. **Static layer** — `knowledgeService.matchDefaultQA()` scans `defaultQA.json` for a phrase match. Instant, zero API calls.
2. **Domain guard** — if the question mentions products/customers/orders/inventory (or looks like a person name), the website layer is skipped and it goes straight to the DB pipeline.
3. **Website layer** — `websiteReader.getLiveContent()` picks the most relevant pages from a site map, reads them **live** with Playwright (cached in Redis for 1 hour), and GPT synthesises an answer constrained to that content only.
4. **Intent parsing** — `llmservice.parseIntent()` classifies the intent (`product_query`, `customer_query`, `order_query`, `warehouse_query`, `category_query`, `general`) and extracts entities. Results are cached (1 h TTL).
5. **Pronoun resolution** — `llmRetriever` tracks the last mentioned customer/product per session and resolves "his", "their", "that customer", etc.
6. **SQL generation** — intent is mapped to a parameterised query via `rag/tableManager.js` / `rag/llmRetriever.js` and executed against MySQL. Row results are cached (5 min TTL).
7. **Answer synthesis** — `formatResponse()` turns the rows into a short, plain-text answer. Pronoun-based answers are never cached (user-specific).
8. **Session memory** — conversation turns are stored so follow-ups can refer back, and the session is pruned after 30 minutes of inactivity.

**Cache TTLs (Redis):**

| Cache type | TTL |
|---|---|
| Intent parses | 1 hour |
| Query results | 5 min |
| LLM answers | 10 min |
| Table schemas | 24 h |
| Crawled website pages | 1 hour |
| Conversation history | 30 min |

---

## FAQ data

Static Q&A lives in `chatbot-rag/chatbot-rag/data/defaultQA.json`. Each entry maps several phrasings to one answer:

```json
{
  "faqs": [
    {
      "id": "return_policy",
      "questions": ["return policy", "can i return", "refund policy"],
      "answer": "We accept returns within 30 days of purchase..."
    }
  ]
}
```

Matching is case-insensitive and checks whether the user's message *contains* any listed phrase. Reload without restarting via `POST /api/reload-qa`.

---

## Security notes

- `.env`, `node_modules/`, `.venv/`, `__pycache__/` and other generated files are **git-ignored** — never commit your `OPENAI_API_KEY`.
- Provide your key via environment variables or your own local `.env` file.
- The SQL query builders are intended for a trusted, single-schema environment; review access before exposing the API publicly.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Redis unavailable — running without cache` | Start Redis, or accept cache-less mode |
| Website answers "I don't have specific information…" | Ensure `npx playwright install chromium` ran; check `WEBSITE_URL` reachable |
| Voice endpoint returns 503 | Flask voice backend must be running on `FLASK_URL` (default `:5000`) |
| `ECONNREFUSED` on DB | Start MySQL/XAMPP and confirm `chatbot_db` exists with the schema above |
| Tamil voice silence | gTTS needs internet; install `mpg123`/`ffmpeg` (see LabAssist README) |
| Port already in use | Change `PORT` in `.env` |

---

## License

ISC — see the individual `package.json` files.