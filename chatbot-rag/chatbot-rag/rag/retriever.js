const db = require('../db/database');

class RAGRetriever {
    async retrieveContext(question) {
        console.log(`🔍 Retrieving context for: "${question}"`);
        
        const searchResults = await db.searchMultipleTables(question);
        const comprehensiveData = await db.getComprehensiveData(question);
        const schemas = await db.getTableSchemas();
        const pastConversations = await db.getSimilarPastConversations(question);
        
        const context = {
            search_results: searchResults.results,
            query_type: searchResults.queryType,
            tables_searched: searchResults.tablesSearched || [],
            comprehensive_data: comprehensiveData,
            database_schema: schemas,
            similar_questions: pastConversations,
            timestamp: new Date().toISOString()
        };
        
        const contextSummary = this.generateContextSummary(context);
        return { context, contextSummary };
    }
    
    generateContextSummary(context) {
        let summary = "=== MULTI-TABLE KNOWLEDGE BASE CONTEXT ===\n\n";
        if (context.query_type) {
            summary += `Query Type: ${context.query_type}\n`;
            summary += `Tables Searched: ${context.tables_searched.join(', ')}\n\n`;
        }
        return summary;
    }
    
    async answerWithContext(question) {
        const { context, contextSummary } = await this.retrieveContext(question);
        const answer = this.generateSmartAnswer(question, context);
        
        await db.saveConversation(question, answer, context);
        
        return { 
            question, 
            answer, 
            context_used: {
                tables_searched: context.tables_searched,
                query_type: context.query_type,
                data_found: Object.keys(context.search_results).length
            }, 
            context_summary: contextSummary 
        };
    }
    
    generateSmartAnswer(question, context) {
        const lowerQuestion = question.toLowerCase();
        const results = context.search_results || {};
        
        // ============================================
        // SPECIFIC PRODUCT QUERIES (NEW)
        // ============================================
        
        // Check for single product query
        const singleProductMatch = this.extractSingleProduct(lowerQuestion);
        if (singleProductMatch && (results.product_prices || results.products)) {
            const products = results.product_prices || results.products;
            const matchedProduct = products.find(p => 
                p.name.toLowerCase().includes(singleProductMatch) ||
                singleProductMatch.includes(p.name.toLowerCase())
            );
            
            if (matchedProduct) {
                // Check what information is being asked
                if (lowerQuestion.includes('price') || lowerQuestion.includes('cost')) {
                    return `💰 **${matchedProduct.name}** costs **$${matchedProduct.price}**\n\n📝 ${matchedProduct.description}\n📂 Category: ${matchedProduct.category}\n📦 Stock: ${matchedProduct.stock} units`;
                }
                
                if (lowerQuestion.includes('stock') || lowerQuestion.includes('available') || lowerQuestion.includes('quantity')) {
                    const status = matchedProduct.stock > 0 ? `✅ In stock` : `❌ Out of stock`;
                    return `📦 **${matchedProduct.name}**\n${status}: ${matchedProduct.stock} units available\n💰 Price: $${matchedProduct.price}\n📍 Category: ${matchedProduct.category}`;
                }
                
                if (lowerQuestion.includes('description') || lowerQuestion.includes('tell me about') || lowerQuestion.includes('details')) {
                    return `📝 **${matchedProduct.name}**\n\n${matchedProduct.description}\n\n💰 Price: $${matchedProduct.price}\n📂 Category: ${matchedProduct.category}\n📦 Stock: ${matchedProduct.stock} units`;
                }
                
                // Default product info
                return `📦 **${matchedProduct.name}**\n💰 Price: $${matchedProduct.price}\n📝 ${matchedProduct.description}\n📂 ${matchedProduct.category} | 📦 ${matchedProduct.stock} in stock`;
            }
        }
        
        // ============================================
        // ORDER STATUS QUERIES
        // ============================================
        
        if (results.delivered_orders || results.shipped_orders) {
            const orders = results.delivered_orders || results.shipped_orders;
            const status = results.delivered_orders ? 'Delivered' : 'Shipped';
            
            if (orders && orders.length > 0) {
                // If only one order, show details
                if (orders.length === 1) {
                    const order = orders[0];
                    return `📦 **${status} Order**\n🆔 Order #${order.order_id}\n👤 Customer: ${order.customer_name}\n📅 Date: ${new Date(order.order_date).toLocaleDateString()}\n💰 Total: $${order.total_amount}\n📦 Items: ${order.total_items}`;
                }
                
                // Multiple orders
                let answer = `📦 **${status} Orders:**\n\n`;
                orders.forEach(order => {
                    answer += `🆔 Order #${order.order_id} - ${order.customer_name}\n`;
                    answer += `   📅 ${new Date(order.order_date).toLocaleDateString()} | 💰 $${order.total_amount}\n\n`;
                });
                return answer;
            }
            return `No ${status.toLowerCase()} orders found.`;
        }
        // ============================================
        // CUSTOMER DETAILS RESPONSES (ADD THIS SECTION)
        // ============================================

        // Handle specific customer details
        if (results.customer_details_specific) {
            const customers = results.customer_details_specific;
            if (customers && customers.length > 0) {
                const c = customers[0];
                let answer = `👤 **Customer Profile: ${c.name}**\n\n`;
                answer += `📧 Email: ${c.email}\n`;
                answer += `📍 City: ${c.city}\n`;
                answer += `⭐ Membership: ${c.membership_level}\n`;
                answer += `📦 Total Orders: ${c.total_orders || 0}\n`;
                answer += `💰 Total Spent: $${c.total_spent || 0}\n`;
                if (c.last_order_date) {
                    answer += `📅 Last Order: ${new Date(c.last_order_date).toLocaleDateString()}\n`;
                }
                return answer;
            }
            return "Customer not found.";
        }

        // Handle all customers details
        if (results.customer_details_all) {
            const customers = results.customer_details_all;
            if (customers && customers.length > 0) {
                let answer = `👥 **All Customers:**\n\n`;
                customers.forEach((c, i) => {
                    answer += `${i+1}. **${c.name}**\n`;
                    answer += `   📧 ${c.email}\n`;
                    answer += `   📍 ${c.city} | ⭐ ${c.membership_level}\n`;
                    answer += `   📦 ${c.total_orders || 0} orders | 💰 $${c.total_spent || 0}\n\n`;
                });
                return answer;
            }
            return "No customers found.";
        }
        // ============================================
        // CUSTOMER ORDER DETAILS
        // ============================================
        
        if (results.customer_orders) {
            const orders = results.customer_orders;
            if (orders && orders.length > 0) {
                // Extract customer name from question
                let customerName = '';
                if (lowerQuestion.includes('john')) customerName = 'John Doe';
                else if (lowerQuestion.includes('jane')) customerName = 'Jane Smith';
                else if (lowerQuestion.includes('bob')) customerName = 'Bob Johnson';
                
                if (orders.length === 1 && customerName) {
                    const order = orders[0];
                    return `👤 **${customerName}'s Order**\n🆔 Order #${order.order_id}\n📅 Date: ${new Date(order.order_date).toLocaleDateString()}\n💰 Total: $${order.total_amount}\n📦 Products: ${order.products}\n📌 Status: ${order.status}`;
                }
                
                let answer = `👤 **${customerName || 'Customer'} Order History:**\n\n`;
                orders.forEach(order => {
                    answer += `🆔 Order #${order.order_id} - ${new Date(order.order_date).toLocaleDateString()}\n`;
                    answer += `   💰 $${order.total_amount} | 📌 ${order.status}\n`;
                    answer += `   📦 ${order.products}\n\n`;
                });
                return answer;
            }
            return "No orders found for this customer.";
        }
        
        // ============================================
        // WAREHOUSE QUERIES
        // ============================================
        
        if (results.warehouse_restocked) {
            const items = results.warehouse_restocked;
            if (items && items.length > 0) {
                if (items.length === 1) {
                    const item = items[0];
                    return `🏭 **Restocked Item**\n📦 ${item.name}\n📍 ${item.warehouse_location}\n📊 Quantity: ${item.quantity}\n📅 Last Restocked: ${new Date(item.last_restocked).toLocaleDateString()}`;
                }
                
                let answer = `🏭 **Warehouse Restocked Items:**\n\n`;
                items.forEach(item => {
                    answer += `📦 ${item.name}\n`;
                    answer += `   📍 ${item.warehouse_location} | 📊 ${item.quantity} units\n`;
                    answer += `   📅 Last: ${new Date(item.last_restocked).toLocaleDateString()}\n\n`;
                });
                return answer;
            }
        }
        
        if (results.warehouse_products) {
            const products = results.warehouse_products;
            if (products && products.length > 0) {
                // Extract warehouse from question
                let warehouse = '';
                if (lowerQuestion.includes('warehouse a')) warehouse = 'Warehouse A';
                else if (lowerQuestion.includes('warehouse b')) warehouse = 'Warehouse B';
                else if (lowerQuestion.includes('warehouse c')) warehouse = 'Warehouse C';
                
                if (products.length === 1 && warehouse) {
                    const product = products[0];
                    return `🏭 **Product in ${warehouse}**\n📦 ${product.name}\n💰 Price: $${product.price}\n📊 Stock: ${product.stock}\n📅 Last Restocked: ${new Date(product.last_restocked).toLocaleDateString()}`;
                }
                
                let answer = `🏭 **Products in ${warehouse || 'Warehouse'}:**\n\n`;
                products.forEach(product => {
                    answer += `📦 ${product.name}\n`;
                    answer += `   💰 $${product.price} | 📊 ${product.stock} in stock\n`;
                    answer += `   📅 Restocked: ${new Date(product.last_restocked).toLocaleDateString()}\n\n`;
                });
                return answer;
            }
            return "No products found in this warehouse.";
        }
        
        // ============================================
        // PRODUCT LIST / PRICE QUERIES
        // ============================================
        
        if (results.product_prices || results.products) {
            const products = results.product_prices || results.products;
            
            if (products && products.length > 0) {
                // Specific product price query
                if (lowerQuestion.includes('price') || lowerQuestion.includes('cost')) {
                    // Check if asking about a specific product
                    const specificProduct = this.extractSingleProduct(lowerQuestion);
                    if (specificProduct) {
                        const product = products.find(p => 
                            p.name.toLowerCase().includes(specificProduct)
                        );
                        if (product) {
                            return `💰 **${product.name}** costs **$${product.price}**\n\n📝 ${product.description}\n📂 Category: ${product.category}\n📦 Stock: ${product.stock} units`;
                        }
                    }
                    
                    // List all prices
                    let answer = "💰 **Product Prices:**\n\n";
                    products.forEach(p => {
                        answer += `• **${p.name}**: $${p.price} (${p.category})\n`;
                    });
                    return answer;
                }
                
                // Specific product stock query
                if (lowerQuestion.includes('stock') || lowerQuestion.includes('available')) {
                    const specificProduct = this.extractSingleProduct(lowerQuestion);
                    if (specificProduct) {
                        const product = products.find(p => 
                            p.name.toLowerCase().includes(specificProduct)
                        );
                        if (product) {
                            const status = product.stock > 0 ? `✅ In stock` : `❌ Out of stock`;
                            return `📦 **${product.name}**\n${status}: ${product.stock} units available\n💰 Price: $${product.price}`;
                        }
                    }
                    
                    // List all stock
                    let answer = "📊 **Stock Availability:**\n\n";
                    products.forEach(p => {
                        const status = p.stock > 0 ? `✅ ${p.stock} in stock` : `❌ Out of stock`;
                        answer += `• **${p.name}**: ${status}\n`;
                    });
                    return answer;
                }
                
                // Just list products
                if (lowerQuestion.includes('list') || lowerQuestion.includes('show me') || lowerQuestion.includes('products')) {
                    let answer = "📋 **Our Products:**\n\n";
                    products.forEach((p, i) => {
                        answer += `${i+1}. **${p.name}** - $${p.price}\n`;
                        answer += `   ${p.description.substring(0, 80)}...\n`;
                        answer += `   📂 ${p.category} | 📦 ${p.stock} in stock\n\n`;
                    });
                    return answer;
                }
            }
        }
        
        // ============================================
        // FALLBACK - Helpful message
        // ============================================
        
        return `I can help you with:

📦 **Products**
• "laptop price" - Get price of a specific product
• "wireless mouse stock" - Check availability
• "product list" - See all products

📦 **Orders**
• "delivered products" - See delivered orders
• "shipped products" - See shipped orders
• "John Doe order details" - Customer order history

🏭 **Warehouse**
• "Warehouse A products" - Products in specific warehouse
• "Warehouse B last restocked" - Restocked items

Try being more specific with your question!`;
    }
    
    // Helper method to extract single product name from question
    extractSingleProduct(question) {
        const products = ['laptop', 'mouse', 'keyboard', 'monitor', 'cable', 'usb', 'headphone'];
        for (const product of products) {
            if (question.includes(product)) {
                return product;
            }
        }
        return null;
    }
}

module.exports = new RAGRetriever();