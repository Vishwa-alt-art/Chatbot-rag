const redis = require('redis');
require('dotenv').config();

class CacheService {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.defaultTTL = 300; // 5 minutes

        // TTL config per cache type (in seconds)
        this.ttlConfig = {
            intent: 3600,       // Intent parsing: 1 hour (stable for same question)
            query_result: 300,  // DB query results: 5 minutes (data can change)
            llm_answer: 600,    // Full LLM answers: 10 minutes
            schema: 86400,      // Table schemas: 24 hours (rarely changes)
            conversation: 1800  // Conversation history: 30 minutes
        };
    }

    async connect() {
        try {
            this.client = redis.createClient({
                socket: {
                    host: process.env.REDIS_HOST || '127.0.0.1',
                    port: parseInt(process.env.REDIS_PORT) || 6379,
                    reconnectStrategy: (retries) => {
                        if (retries > 5) {
                            console.warn('⚠️ Redis: max reconnect attempts reached, disabling cache');
                            return false; // Stop retrying
                        }
                        return Math.min(retries * 200, 2000); // Backoff
                    }
                },
                password: process.env.REDIS_PASSWORD || undefined
            });

            this.client.on('error', (err) => {
                if (this.isConnected) {
                    console.warn('⚠️ Redis error (cache disabled):', err.message);
                }
                this.isConnected = false;
            });

            this.client.on('connect', () => {
                this.isConnected = true;
                console.log('✅ Redis connected — caching enabled');
            });

            this.client.on('reconnecting', () => {
                console.log('🔄 Redis reconnecting...');
            });

            await this.client.connect();
        } catch (err) {
            console.warn('⚠️ Redis unavailable — running without cache:', err.message);
            this.isConnected = false;
        }
    }

    // -------------------------------------------------------------------
    // Core get/set/del/flush
    // -------------------------------------------------------------------

    /**
     * Get a cached value by key.
     * Returns parsed JSON value or null on miss/error.
     */
    async get(key) {
        if (!this.isConnected || !this.client) return null;
        try {
            const raw = await this.client.get(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            console.log(`🎯 Cache HIT: ${key}`);
            return parsed;
        } catch (err) {
            console.warn('⚠️ Cache get error:', err.message);
            return null;
        }
    }

    /**
     * Store a value in cache.
     * @param {string} key
     * @param {*} value   - Will be JSON-serialised
     * @param {number} [ttl] - Seconds; defaults to this.defaultTTL
     */
    async set(key, value, ttl = this.defaultTTL) {
        if (!this.isConnected || !this.client) return false;
        try {
            await this.client.setEx(key, ttl, JSON.stringify(value));
            console.log(`💾 Cache SET: ${key} (TTL ${ttl}s)`);
            return true;
        } catch (err) {
            console.warn('⚠️ Cache set error:', err.message);
            return false;
        }
    }

    /**
     * Delete a specific key.
     */
    async del(key) {
        if (!this.isConnected || !this.client) return false;
        try {
            await this.client.del(key);
            console.log(`🗑️ Cache DEL: ${key}`);
            return true;
        } catch (err) {
            console.warn('⚠️ Cache del error:', err.message);
            return false;
        }
    }

    /**
     * Delete all keys matching a pattern (e.g. "query_result:*").
     */
    async flush(pattern = '*') {
        if (!this.isConnected || !this.client) return false;
        try {
            const keys = await this.client.keys(pattern);
            if (keys.length > 0) {
                await this.client.del(keys);
                console.log(`🧹 Cache FLUSH: ${keys.length} keys matching "${pattern}"`);
            }
            return true;
        } catch (err) {
            console.warn('⚠️ Cache flush error:', err.message);
            return false;
        }
    }

    // -------------------------------------------------------------------
    // Typed helpers — normalise keys and apply the right TTL per domain
    // -------------------------------------------------------------------

    /**
     * Hash any string into a fixed-length hex digest safe for use as a Redis key.
     * Using crypto.createHash avoids collisions that the old slug approach caused —
     * e.g. "John Smith's orders" and "John Smiths orders" both slugged to
     * "john_smiths_orders" and shared the same cache entry.
     */
    _hash(input) {
        const { createHash } = require('crypto');
        return createHash('sha256').update(input.toLowerCase().trim()).digest('hex');
    }

    /** Cache LLM intent-parse results */
    async getIntent(question) {
        return this.get(`intent:${this._hash(question)}`);
    }

    async setIntent(question, intentData) {
        const key = `intent:${this._hash(question)}`;
        console.log(`  ↳ intent key for: "${question.substring(0, 80)}"`);
        return this.set(key, intentData, this.ttlConfig.intent);
    }

    /** Cache raw DB query results — keyed on the exact SQL (hashed) */
    async getQueryResult(sql) {
        return this.get(`query_result:${this._hash(sql)}`);
    }

    async setQueryResult(sql, rows) {
        const key = `query_result:${this._hash(sql)}`;
        console.log(`  ↳ query key for: "${sql.replace(/\s+/g, ' ').trim().substring(0, 100)}"`);
        return this.set(key, rows, this.ttlConfig.query_result);
    }

    /** Cache complete LLM answers */
    async getLLMAnswer(question) {
        return this.get(`llm_answer:${this._hash(question)}`);
    }

    async setLLMAnswer(question, answer) {
        const key = `llm_answer:${this._hash(question)}`;
        console.log(`  ↳ answer key for: "${question.substring(0, 80)}"`);
        return this.set(key, answer, this.ttlConfig.llm_answer);
    }

    /** Cache table schema (long TTL — schema rarely changes) */
    async getSchema() {
        return this.get('schema:all_tables');
    }

    async setSchema(schemas) {
        return this.set('schema:all_tables', schemas, this.ttlConfig.schema);
    }

    // -------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------

    /** How many seconds remain on a key (-1 = no TTL, -2 = missing) */
    async ttl(key) {
        if (!this.isConnected || !this.client) return -2;
        try {
            return await this.client.ttl(key);
        } catch {
            return -2;
        }
    }

    /** Gracefully close the connection (call on server shutdown) */
    async disconnect() {
        if (this.client && this.isConnected) {
            await this.client.quit();
            console.log('🔌 Redis disconnected');
        }
    }
}

// Export a singleton so every module shares the same connection
const cacheService = new CacheService();
module.exports = cacheService;