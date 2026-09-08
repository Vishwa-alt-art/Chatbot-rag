const OpenAI = require('openai');
require('dotenv').config();
const cache = require('./cacheService');

class LLMService {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.conversationMemory = new Map();
    }

    getConversationContext(sessionId) {
        if (!this.conversationMemory.has(sessionId)) {
            this.conversationMemory.set(sessionId, []);
        }
        return this.conversationMemory.get(sessionId).slice(-3);
    }

    saveToMemory(sessionId, userMessage, botResponse) {
        if (!this.conversationMemory.has(sessionId)) {
            this.conversationMemory.set(sessionId, []);
        }
        this.conversationMemory.get(sessionId).push(
            { role: 'user',      content: userMessage  },
            { role: 'assistant', content: botResponse  }
        );
    }

    isGeneralQuestion(question) {
        const generalPatterns = [
            /^hi\b|^hello\b|^hey\b|^greetings/i,
            /how are you/i,
            /what can you do|how can you help|your capabilities/i,
            /thank|thanks/i,
            /good morning|good afternoon|good evening/i,
            /who are you|what are you/i,
            /bye\b|goodbye|see you/i
        ];
        return generalPatterns.some(p => p.test(question));
    }

    async handleGeneralQuestion(question) {
        const q = question.toLowerCase();
        if (q.match(/^hi\b|^hello\b|^hey\b|^greetings/))
            return "Hello! I'm your assistant. Ask me about products, customers, orders, or warehouse inventory.";
        if (q.includes('how are you'))
            return "I'm ready to help! What would you like to know?";
        if (q.includes('what can you do') || q.includes('how can you help') || q.includes('capabilities'))
            return `I can help you with:\n\nProducts — prices, stock, categories\nCustomers — details, order history, spending\nOrders — status, customer orders\nWarehouse — inventory by location\n\nTry: "Show all products" or "What did John Doe order?"`;
        if (q.includes('thank')) return "You're welcome! Anything else I can help with?";
        if (q.includes('bye') || q.includes('goodbye')) return "Goodbye! Come back if you have more questions.";
        if (q.includes('who are you')) return "I'm an AI database assistant for products, customers, orders, and inventory.";
        return null;
    }

    async parseIntent(question, context = '') {
        if (this.isGeneralQuestion(question)) {
            const response = await this.handleGeneralQuestion(question);
            if (response) {
                return { intent: 'general', entities: {}, general_response: response, clarification_needed: false };
            }
        }

        const cachedIntent = await cache.getIntent(question);
        if (cachedIntent) {
            console.log('🎯 Intent cache HIT:', question);
            return cachedIntent;
        }

        try {
            // OPTIMIZATION: Tighter prompt → fewer tokens → faster response (~150ms saved)
            const prompt = `DB schema: products(name,price,category,stock), customers(name,email,city,membership_level), orders(order_date,total_amount,status), inventory(warehouse_location,quantity,last_restocked)

Q: "${question}"

JSON only (no text):
{"intent":"product_query|customer_query|order_query|warehouse_query|category_query|general","entities":{"product_name":null,"customer_name":null,"category":null,"warehouse":null,"order_status":null,"price_query":false,"stock_query":false,"sort_by":null,"sort_dir":null,"with_order_details":false},"is_general":false}`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0,          // Deterministic = cacheable, slightly faster
                max_tokens: 120,         // Was 100 — give a little room to avoid truncation
                response_format: { type: 'json_object' }  // Forces JSON, no preamble
            });

            const result = JSON.parse(response.choices[0].message.content);
            console.log('🧠 Intent:', result.intent, '| entities:', JSON.stringify(result.entities));

            await cache.setIntent(question, result);
            return result;

        } catch (error) {
            console.error('Intent parsing error:', error.message);
            return { intent: 'general_query', entities: {}, is_general: false };
        }
    }

    async formatResponse(question, intent, entities, data, error = null) {
        if (error) {
            return `Sorry, I encountered an error: ${error.substring(0, 80)}. Please try again.`;
        }
        if (!data || data.length === 0) {
            return `I couldn't find any information matching your question. Try asking about products, customers, orders, or warehouse inventory.`;
        }

        try {
            // OPTIMIZATION: Strict short prompt → max_tokens 100 (was 150) → faster
            // For patient-facing use: plain, clear sentences; no markdown
            const prompt = `Answer this question based on the data. Be clear, direct, and concise. Use plain text only — no markdown, no bullet points, no asterisks. Maximum 2-3 sentences.

Question: "${question}"
Data: ${JSON.stringify(data).slice(0, 800)}

Answer:`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 100    // Tighter = faster, still enough for 2-3 sentences
            });

            return response.choices[0].message.content.trim();

        } catch (error) {
            console.error('Format response error:', error.message);
            return this.fallbackResponse(data);
        }
    }

    fallbackResponse(data) {
        if (!data || data.length === 0) return 'No results found.';
        if (data.length === 1) {
            const item = data[0];
            if (item.name && item.price) return `${item.name}: $${item.price} (${item.stock || 0} in stock)`;
            if (item.name) return item.name;
        }
        const names = data.map(d => d.name || d.customer_name || d.product_name).filter(Boolean);
        return names.length ? `Found: ${names.join(', ')}.` : `Found ${data.length} results.`;
    }

    async generateSQL(question, schema) {
        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: `MySQL only. Schema: ${JSON.stringify(schema)}\nQ: "${question}"\nSQL:` }],
                temperature: 0,
                max_tokens: 150
            });
            return response.choices[0].message.content.trim();
        } catch (error) {
            console.error('SQL generation error:', error.message);
            return null;
        }
    }
}

module.exports = new LLMService();
