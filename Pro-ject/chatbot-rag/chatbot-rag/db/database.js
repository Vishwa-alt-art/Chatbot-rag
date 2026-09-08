const mysql = require('mysql2');
require('dotenv').config();
const tableManager = require('../rag/tableManager');
const cache = require('../services/cacheService');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const promisePool = pool.promise();

async function searchMultipleTables(question) {
    try {
        const relevant = tableManager.identifyRelevantTables(question);
        console.log(`📋 Tables to search: ${relevant.tables.join(', ')}`);

        const { sql, queryType } = tableManager.generateSQLQuery(question, relevant.tables);

        let results = {};

        if (sql) {
            // --- Cache: check before hitting MySQL ---
            const cached = await cache.getQueryResult(sql);
            if (cached) {
                results[queryType || 'results'] = cached;
                return { results, queryType, tablesSearched: relevant.tables, fromCache: true };
            }

            console.log(`🔍 Executing: ${sql.substring(0, 200)}...`);
            const [rows] = await promisePool.execute(sql);
            results[queryType || 'results'] = rows;
            console.log(`✅ Found ${rows.length} results`);

            // Store in cache
            await cache.setQueryResult(sql, rows);
        } else {
            const fallbackSQL = 'SELECT * FROM products';
            const cached = await cache.getQueryResult(fallbackSQL);
            if (cached) {
                results.products = cached;
                return { results, queryType, tablesSearched: relevant.tables, fromCache: true };
            }

            console.log(`⚠️ No specific query, fetching products...`);
            const [products] = await promisePool.execute(fallbackSQL);
            results.products = products;

            await cache.setQueryResult(fallbackSQL, products);
        }

        return { results, queryType, tablesSearched: relevant.tables, fromCache: false };

    } catch (error) {
        console.error('❌ Search error:', error);
        return { results: {}, error: error.message, tablesSearched: [] };
    }
}

async function getComprehensiveData(question) {
    try {
        const allData = {};
        const sql = 'SELECT COUNT(*) as total FROM products';

        const cached = await cache.getQueryResult(sql);
        if (cached) {
            allData.total_products = cached[0]?.total || 0;
            return allData;
        }

        const [products] = await promisePool.execute(sql);
        allData.total_products = products[0]?.total || 0;

        await cache.setQueryResult(sql, products);
        return allData;
    } catch (error) {
        return {};
    }
}

async function getTableSchemas() {
    // Schemas rarely change — use a long-TTL cache entry
    const cached = await cache.getSchema();
    if (cached) return cached;

    try {
        const [tables] = await promisePool.execute(
            'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
            [process.env.DB_NAME]
        );
        const schemas = {};
        for (const table of tables) {
            const [columns] = await promisePool.execute(
                'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
                [process.env.DB_NAME, table.table_name]
            );
            schemas[table.table_name] = columns;
        }

        await cache.setSchema(schemas);
        return schemas;
    } catch (error) {
        return {};
    }
}

async function saveConversation(question, answer, contextUsed) {
    try {
        await promisePool.execute(
            'INSERT INTO conversation_history (question, answer, context_used) VALUES (?, ?, ?)',
            [question, answer, JSON.stringify(contextUsed)]
        );
        // Invalidate the history cache so the next read is fresh
        await cache.del('conversation:history');
    } catch (error) {
        console.error('Save error:', error);
    }
}

async function getSimilarPastConversations(question, limit = 3) {
    const cacheKey = `conversation:similar:${question.toLowerCase().trim().substring(0, 80)}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    try {
        const [history] = await promisePool.execute(
            `SELECT question, answer FROM conversation_history 
             WHERE question LIKE ? LIMIT ?`,
            [`%${question}%`, limit]
        );
        await cache.set(cacheKey, history, 600); // 10-minute TTL for conversation similarity
        return history;
    } catch (error) {
        return [];
    }
}

module.exports = {
    searchMultipleTables,
    getComprehensiveData,
    getTableSchemas,
    saveConversation,
    getSimilarPastConversations,
    pool: promisePool
};