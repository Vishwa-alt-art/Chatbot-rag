const db = require('../db/database');
const llmService = require('../services/llmService');
const cache = require('../services/cacheService');
const { resolveKnowledge } = require('../services/knowledgeService');

// Words that signal the user wants individual order rows, not an aggregated summary
const ORDER_INTENT_WORDS = /\borders?\b|\bpurchase[sd]?\b|\bbought\b|\btransaction[s]?\b/i;

// Pronouns that refer back to whoever was last mentioned
const PRONOUN_PATTERN = /\b(he|she|his|her|their|they|this (customer|person|user)|that (customer|person|user))\b/i;

// How long a session context lives without any activity (30 minutes)
const SESSION_TTL_MS = 30 * 60 * 1000;

class LLMRetriever {
    constructor() {
        /**
         * Per-user session context map.
         * Key:   sessionId (string sent by the frontend)
         * Value: { lastCustomerName, lastProductName, lastIntent, lastActive }
         *
         * Each user gets their own isolated context — no cross-user bleed.
         * Stale sessions are pruned automatically after SESSION_TTL_MS.
         */
        this.sessions = new Map();

        // Prune expired sessions every 10 minutes
        setInterval(() => this._pruneExpiredSessions(), 10 * 60 * 1000);
    }

    // -------------------------------------------------------------------
    // Session helpers
    // -------------------------------------------------------------------

    _getSession(sessionId) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                lastCustomerName: null,
                lastProductName:  null,
                lastIntent:       null,
                lastActive:       Date.now()
            });
            console.log(`🆕 New session: ${sessionId}`);
        }
        const session = this.sessions.get(sessionId);
        session.lastActive = Date.now(); // refresh TTL on every access
        return session;
    }

    _updateSession(sessionId, intent, entities) {
        const session = this._getSession(sessionId);
        session.lastIntent = intent;
        if (entities.customer_name) session.lastCustomerName = entities.customer_name;
        if (entities.product_name)  session.lastProductName  = entities.product_name;
    }

    _pruneExpiredSessions() {
        const now = Date.now();
        let pruned = 0;
        for (const [id, session] of this.sessions.entries()) {
            if (now - session.lastActive > SESSION_TTL_MS) {
                this.sessions.delete(id);
                pruned++;
            }
        }
        if (pruned > 0) console.log(`🧹 Pruned ${pruned} expired session(s)`);
    }

    // -------------------------------------------------------------------
    // Context resolution
    // -------------------------------------------------------------------

    /**
     * Fill in missing entities from the session's last known context.
     * Only fires when the question contains a pronoun — avoids false substitutions.
     * Returns an enriched copy; never mutates the original intentData entities.
     */
    _resolveContext(sessionId, question, entities) {
        const resolved = { ...entities };

        if (!PRONOUN_PATTERN.test(question)) return resolved;

        const session = this._getSession(sessionId);

        if (!resolved.customer_name && session.lastCustomerName) {
            resolved.customer_name = session.lastCustomerName;
            console.log(`🔗 [${sessionId}] Pronoun → customer: "${resolved.customer_name}"`);
        }
        if (!resolved.product_name && session.lastProductName) {
            resolved.product_name = session.lastProductName;
            console.log(`🔗 [${sessionId}] Pronoun → product: "${resolved.product_name}"`);
        }

        return resolved;
    }

    // -------------------------------------------------------------------
    // Main entry point
    // -------------------------------------------------------------------

    async answerWithLLM(question, sessionId, opts = {}) {
        console.log(`🤖 [${sessionId}] Processing: "${question}"`);

        // ---------------------------------------------------------------
        // Layer 0: Default Q&A + General Knowledge
        // Checked before cache and before the DB pipeline.
        // resolveKnowledge() returns { answer, source } or null.
        // Returning here means zero DB queries and zero extra LLM calls
        // for questions that don't need them.
        // ---------------------------------------------------------------
        const isPronounQuestion = PRONOUN_PATTERN.test(question);
        const skipKnowledge = opts.skipKnowledge === true;

        if (!isPronounQuestion && !skipKnowledge) {
            const knowledge = await resolveKnowledge(question);
            if (knowledge) {
                console.log(`📖 [${sessionId}] Answered from ${knowledge.source}`);
                // Still update session in case a name was mentioned
                // (e.g. "tell me about John Doe" as a general query)
                return {
                    question,
                    answer: knowledge.answer,
                    context_used: {
                        intent: knowledge.source,
                        used_llm: knowledge.source === 'general_knowledge',
                        is_general: true,
                        from_cache: false,
                        source: knowledge.source,
                        session_id: sessionId
                    }
                };
            }
        }

        if (!isPronounQuestion) {
            const cachedAnswer = await cache.getLLMAnswer(question);
            if (cachedAnswer) {
                console.log(`🎯 Cache HIT: "${question}"`);
                // Still update session so follow-ups work after a cache hit
                this._updateSession(sessionId, cachedAnswer.context_used.intent, cachedAnswer.context_used.entities || {});
                return {
                    ...cachedAnswer,
                    context_used: { ...cachedAnswer.context_used, from_cache: true }
                };
            }
        }

        // Step 1: Parse intent
        const intentData = await llmService.parseIntent(question);

        // Step 2: Resolve pronouns per this user's session
        const entities = this._resolveContext(sessionId, question, intentData.entities || {});

        // Step 3: General questions — no DB
        if (intentData.intent === 'general' && intentData.general_response) {
            return {
                question,
                answer: intentData.general_response,
                context_used: { intent: 'general', used_llm: true, is_general: true, from_cache: false }
            };
        }

        // Step 4: Re-route customer_query → order_query when order words are present
        let intent = intentData.intent;
        if (
            intent === 'customer_query' &&
            entities.customer_name &&
            (entities.with_order_details || ORDER_INTENT_WORDS.test(question))
        ) {
            intent = 'order_query';
            console.log(`🔀 Re-routed customer_query → order_query`);
        }

        // Step 5: Build SQL
        let sql = null;
        let queryType = '';

        if (intent === 'product_query') {
            sql = this.buildProductQuery(entities);
            queryType = 'product_query';
        } else if (intent === 'customer_query') {
            sql = this.buildCustomerQuery(entities);
            queryType = 'customer_query';
        } else if (intent === 'order_query') {
            sql = this.buildOrderQuery(entities);
            queryType = 'order_query';
        } else if (intent === 'warehouse_query') {
            sql = this.buildWarehouseQuery(entities);
            queryType = 'warehouse_query';
        } else if (intent === 'category_query') {
            sql = this.buildCategoryQuery(entities);
            queryType = 'category_query';
        } else {
            sql = 'SELECT name, price, stock FROM products';
            queryType = 'default';
        }

        // Step 6: Execute (query-level cache)
        let data = [];
        let error = null;

        if (sql) {
            const cachedRows = await cache.getQueryResult(sql);
            if (cachedRows) {
                data = cachedRows;
                console.log(`🎯 Query cache HIT (${data.length} rows)`);
            } else {
                try {
                    console.log(`🔍 SQL: ${sql}`);
                    const [rows] = await db.pool.execute(sql);
                    data = rows;
                    console.log(`✅ ${data.length} results`);
                    await cache.setQueryResult(sql, rows);
                } catch (err) {
                    error = err.message;
                    console.error('Query error:', err);
                }
            }
        }

        // Step 7: Format with LLM
        const formattedResponse = await llmService.formatResponse(
            question, intent, entities, data, error
        );

        // Step 8: Update this user's session context for next turn
        this._updateSession(sessionId, intent, entities);
        llmService.saveToMemory(sessionId, question, formattedResponse);

        const result = {
            question,
            answer: formattedResponse,
            context_used: {
                intent,
                entities,
                data_found: data.length,
                used_llm: true,
                is_general: false,
                from_cache: false,
                context_resolved: isPronounQuestion,
                session_id: sessionId
            }
        };

        // Don't cache pronoun answers — they're user-specific
        if (!isPronounQuestion) {
            await cache.setLLMAnswer(question, result);
        }

        return result;
    }

    // -------------------------------------------------------------------
    // Query builders
    // -------------------------------------------------------------------

    buildProductQuery(entities) {
        const conditions = [];
        if (entities.product_name) {
            conditions.push(`LOWER(name) LIKE '%${entities.product_name.toLowerCase()}%'`);
        }
        if (entities.price_query) {
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            return `SELECT name, price, stock FROM products ${where} ORDER BY price`.trim();
        }
        if (entities.stock_query) {
            const where = conditions.length
                ? `WHERE ${conditions.join(' AND ')} AND stock > 0`
                : 'WHERE stock > 0';
            return `SELECT name, stock, price FROM products ${where}`;
        }
        if (conditions.length === 0) return `SELECT name, price, stock FROM products`;
        return `SELECT name, price, category, stock FROM products WHERE ${conditions.join(' AND ')}`;
    }

    buildCustomerQuery(entities) {
        const sortBy     = entities.sort_by  || null;
        const sortDir    = entities.sort_dir || 'DESC';
        const withOrders = entities.with_order_details;

        const base = `SELECT c.name, c.email, c.city, c.membership_level,
                             COUNT(o.id)                                AS total_orders,
                             ROUND(COALESCE(SUM(o.total_amount), 0), 2) AS total_spent
                      FROM customers c
                      LEFT JOIN orders o ON c.id = o.customer_id`;

        if (entities.customer_name) {
            return `${base} WHERE c.name = '${entities.customer_name}' GROUP BY c.id`;
        }
        if (sortBy === 'spending') {
            return `${base} GROUP BY c.id ORDER BY total_spent ${sortDir}`;
        }
        if (sortBy === 'order_count') {
            return `${base} GROUP BY c.id ORDER BY total_orders ${sortDir}`;
        }
        if (withOrders) {
            return `SELECT c.name AS customer, c.email, c.membership_level,
                           o.id AS order_id, o.order_date, o.status, o.total_amount
                    FROM customers c
                    LEFT JOIN orders o ON c.id = o.customer_id
                    ORDER BY c.name, o.order_date DESC`;
        }
        return `${base} GROUP BY c.id ORDER BY c.name`;
    }

    buildOrderQuery(entities) {
        if (entities.order_status) {
            return `SELECT o.id, o.order_date, o.status, c.name AS customer, o.total_amount
                    FROM orders o JOIN customers c ON o.customer_id = c.id
                    WHERE o.status = '${entities.order_status}'
                    ORDER BY o.order_date DESC`;
        }
        if (entities.customer_name) {
            return `SELECT o.id, o.order_date, o.status, o.total_amount
                    FROM orders o JOIN customers c ON o.customer_id = c.id
                    WHERE c.name = '${entities.customer_name}'
                    ORDER BY o.order_date DESC`;
        }
        return `SELECT o.id, o.order_date, o.status, c.name AS customer, o.total_amount
                FROM orders o JOIN customers c ON o.customer_id = c.id
                ORDER BY o.order_date DESC`;
    }

    buildWarehouseQuery(entities) {
        if (entities.warehouse) {
            return `SELECT p.name, p.price, i.quantity AS stock
                    FROM inventory i JOIN products p ON i.product_id = p.id
                    WHERE i.warehouse_location = '${entities.warehouse}'`;
        }
        return `SELECT warehouse_location, SUM(quantity) AS total_stock
                FROM inventory GROUP BY warehouse_location`;
    }

    buildCategoryQuery(entities) {
        if (entities.category) {
            const category = entities.category === 'electronics' ? 'Electronics' : 'Accessories';
            return `SELECT name, price, stock FROM products WHERE category = '${category}'`;
        }
        return `SELECT category, COUNT(*) AS count FROM products GROUP BY category`;
    }
}

module.exports = new LLMRetriever();