class TableManager {
    constructor() {
        this.tables = {
            products: { name: 'products', key_fields: ['name', 'description', 'price', 'category', 'stock'] },
            customers: { name: 'customers', key_fields: ['name', 'email', 'city', 'membership_level'] },
            orders: { name: 'orders', key_fields: ['order_date', 'total_amount', 'status'] },
            order_items: { name: 'order_items', key_fields: ['quantity', 'price'] },
            inventory: { name: 'inventory', key_fields: ['warehouse_location', 'quantity', 'last_restocked'] }
        };
    }
    
    identifyRelevantTables(question) {
        const lowerQuestion = question.toLowerCase();
        const relevantTables = new Set();
        
        // Fix: Handle typos like "wharehouse" -> "warehouse"
        const normalizedQuestion = lowerQuestion.replace(/wharehouse/g, 'warehouse');
        
        // Order-related queries
        if (normalizedQuestion.match(/delivered|shipped|order|purchase|bought|transaction/)) {
            relevantTables.add('orders');
            relevantTables.add('order_items');
            relevantTables.add('customers');
            console.log('📦 Order-related query detected');
        }
        
        // Customer-related queries
        if (normalizedQuestion.match(/customer details|customer information|customer|user|member|person|john|jane|bob/)) {
            relevantTables.add('customers');
            relevantTables.add('orders');
            console.log('👤 Customer-related query detected');
        }
        
        // Warehouse/Inventory queries
        if (normalizedQuestion.match(/warehouse|inventory|stock level|restocked|warehouse a|warehouse b|warehouse c/)) {
            relevantTables.add('inventory');
            relevantTables.add('products');
            console.log('🏭 Warehouse/Inventory query detected');
        }
        
        // Category queries
        if (normalizedQuestion.match(/electronics|accessories|category/)) {
            relevantTables.add('products');
            console.log('📂 Category query detected');
        }
        
        // Product queries (default)
        if (relevantTables.size === 0) {
            relevantTables.add('products');
        }
        
        return { tables: Array.from(relevantTables) };
    }

    generateSQLQuery(question, relevantTables) {
    const lowerQuestion = question.toLowerCase();
    // Fix: Define normalizedQuestion here
    const normalizedQuestion = lowerQuestion.replace(/wharehouse/g, 'warehouse');
    
    let sql = null;
    let queryType = '';
    
    console.log(`🔧 Generating SQL for: "${normalizedQuestion}"`);
    
    // ============================================
    // CUSTOMER SPECIFIC QUERIES (Enhanced)
    // ============================================
    
    // Handle "Jane Smith's order list", "Jane Smith orders", "Jane Smith's orders"
    if ((normalizedQuestion.includes('order list') || normalizedQuestion.includes('orders') || normalizedQuestion.includes('order history')) &&
        (normalizedQuestion.includes('jane') || normalizedQuestion.includes('john') || normalizedQuestion.includes('bob'))) {
        
        let customerName = '';
        if (normalizedQuestion.includes('jane')) customerName = 'Jane Smith';
        else if (normalizedQuestion.includes('john')) customerName = 'John Doe';
        else if (normalizedQuestion.includes('bob')) customerName = 'Bob Johnson';
        
        if (customerName) {
            sql = `SELECT o.id as order_id, o.order_date, o.status, o.total_amount,
                           GROUP_CONCAT(CONCAT(p.name, ' (x', oi.quantity, ')') SEPARATOR ', ') as products
                    FROM orders o
                    JOIN customers c ON o.customer_id = c.id
                    JOIN order_items oi ON o.id = oi.order_id
                    JOIN products p ON oi.product_id = p.id
                    WHERE c.name = '${customerName}'
                    GROUP BY o.id
                    ORDER BY o.order_date DESC`;
            queryType = 'customer_orders';
            console.log(`👤 Fetching orders for ${customerName}`);
            return { sql, queryType };
        }
    }
    
    // Handle "John Doe's details", "Jane Smith details", "Bob details"
    if ((normalizedQuestion.includes('details') || normalizedQuestion.includes('detail') || normalizedQuestion.includes('information')) &&
        (normalizedQuestion.includes('jane') || normalizedQuestion.includes('john') || normalizedQuestion.includes('bob'))) {
        
        let customerName = '';
        if (normalizedQuestion.includes('jane')) customerName = 'Jane Smith';
        else if (normalizedQuestion.includes('john')) customerName = 'John Doe';
        else if (normalizedQuestion.includes('bob')) customerName = 'Bob Johnson';
        
        if (customerName) {
            sql = `SELECT c.name, c.email, c.city, c.membership_level,
                          COUNT(o.id) as total_orders,
                          COALESCE(SUM(o.total_amount), 0) as total_spent,
                          MAX(o.order_date) as last_order_date
                   FROM customers c
                   LEFT JOIN orders o ON c.id = o.customer_id
                   WHERE c.name = '${customerName}'
                   GROUP BY c.id`;
            queryType = 'customer_details_specific';
            console.log(`👤 Fetching details for ${customerName}`);
            return { sql, queryType };
        }
    }
    
    // Handle just a name like "Jane Smith" (without any other keywords)
    if ((normalizedQuestion.match(/^(jane|john|bob)/) || 
         normalizedQuestion.includes('jane smith') || 
         normalizedQuestion.includes('john doe') || 
         normalizedQuestion.includes('bob johnson')) &&
        !normalizedQuestion.includes('product') && 
        !normalizedQuestion.includes('order') &&
        !normalizedQuestion.includes('warehouse')) {
        
        let customerName = '';
        if (normalizedQuestion.includes('jane')) customerName = 'Jane Smith';
        else if (normalizedQuestion.includes('john')) customerName = 'John Doe';
        else if (normalizedQuestion.includes('bob')) customerName = 'Bob Johnson';
        
        if (customerName) {
            sql = `SELECT c.name, c.email, c.city, c.membership_level,
                          COUNT(o.id) as total_orders,
                          COALESCE(SUM(o.total_amount), 0) as total_spent,
                          MAX(o.order_date) as last_order_date
                   FROM customers c
                   LEFT JOIN orders o ON c.id = o.customer_id
                   WHERE c.name = '${customerName}'
                   GROUP BY c.id`;
            queryType = 'customer_details_specific';
            console.log(`👤 Fetching details for ${customerName}`);
            return { sql, queryType };
        }
    }
    
    // ============================================
    // CUSTOMER DETAILS QUERIES (All customers)
    // ============================================
    
    // Handle customer details query for all customers
    if (normalizedQuestion.includes('customer details') || 
        normalizedQuestion.includes('customer information') ||
        (normalizedQuestion.includes('customer') && normalizedQuestion.includes('detail')) ||
        (normalizedQuestion.includes('all') && normalizedQuestion.includes('customer'))) {
        
        // Get all customers
        sql = `SELECT c.name, c.email, c.city, c.membership_level,
                      COUNT(o.id) as total_orders,
                      COALESCE(ROUND(SUM(o.total_amount), 2), 0) as total_spent
               FROM customers c
               LEFT JOIN orders o ON c.id = o.customer_id
               GROUP BY c.id
               ORDER BY total_spent DESC`;
        queryType = 'customer_details_all';
        console.log(`👤 Fetching all customer details`);
        return { sql, queryType };
    }
    
    // ============================================
    // ORDER QUERIES (Enhanced)
    // ============================================
    
    // Handle "delivered orders" or "delivered products"
    if (normalizedQuestion.includes('delivered')) {
        sql = `SELECT o.id as order_id, o.order_date, o.status, c.name as customer_name,
                       SUM(oi.quantity) as total_items, o.total_amount
                FROM orders o
                JOIN customers c ON o.customer_id = c.id
                JOIN order_items oi ON o.id = oi.order_id
                WHERE o.status = 'Delivered'
                GROUP BY o.id
                ORDER BY o.order_date DESC`;
        queryType = 'delivered_orders';
        console.log(`📦 Fetching delivered orders`);
        return { sql, queryType };
    }
    
    // Handle "shipped orders" or "shipped products"
    if (normalizedQuestion.includes('shipped')) {
        sql = `SELECT o.id as order_id, o.order_date, o.status, c.name as customer_name,
                       SUM(oi.quantity) as total_items, o.total_amount
                FROM orders o
                JOIN customers c ON o.customer_id = c.id
                JOIN order_items oi ON o.id = oi.order_id
                WHERE o.status = 'Shipped'
                GROUP BY o.id
                ORDER BY o.order_date DESC`;
        queryType = 'shipped_orders';
        console.log(`📦 Fetching shipped orders`);
        return { sql, queryType };
    }
    
    // ============================================
    // WAREHOUSE QUERIES
    // ============================================
    
    // Handle warehouse products
    if (normalizedQuestion.includes('warehouse') && 
        (normalizedQuestion.includes('products') || normalizedQuestion.includes('items') || normalizedQuestion.includes('in'))) {
        
        let warehouse = '';
        if (normalizedQuestion.includes('warehouse a')) warehouse = 'Warehouse A';
        else if (normalizedQuestion.includes('warehouse b')) warehouse = 'Warehouse B';
        else if (normalizedQuestion.includes('warehouse c')) warehouse = 'Warehouse C';
        
        if (warehouse) {
            sql = `SELECT p.name, p.price, p.description, p.category, 
                          i.quantity as stock, i.warehouse_location, i.last_restocked
                   FROM inventory i
                   JOIN products p ON i.product_id = p.id
                   WHERE i.warehouse_location = '${warehouse}'`;
            queryType = 'warehouse_products';
            console.log(`🏭 Fetching products in ${warehouse}`);
            return { sql, queryType };
        }
    }
    
    // Handle warehouse restocked queries
    if (normalizedQuestion.includes('warehouse') && normalizedQuestion.includes('restocked')) {
        let warehouse = '';
        if (normalizedQuestion.includes('warehouse a')) warehouse = 'Warehouse A';
        else if (normalizedQuestion.includes('warehouse b')) warehouse = 'Warehouse B';
        else if (normalizedQuestion.includes('warehouse c')) warehouse = 'Warehouse C';
        
        if (warehouse) {
            sql = `SELECT p.name, i.warehouse_location, i.quantity, i.last_restocked
                   FROM inventory i
                   JOIN products p ON i.product_id = p.id
                   WHERE i.warehouse_location = '${warehouse}'
                   ORDER BY i.last_restocked DESC`;
            queryType = 'warehouse_restocked';
            console.log(`🏭 Fetching restocked items in ${warehouse}`);
            return { sql, queryType };
        }
    }
    
    // ============================================
    // CATEGORY QUERIES
    // ============================================
    
    // Handle electronics products
    if (normalizedQuestion.includes('electronic') || normalizedQuestion.includes('electronics')) {
        sql = `SELECT name, description, price, category, stock 
               FROM products 
               WHERE LOWER(category) = 'electronics'`;
        queryType = 'category_products';
        console.log(`📂 Fetching electronics products`);
        return { sql, queryType };
    }
    
    // Handle accessories products
    if (normalizedQuestion.includes('accessories') || normalizedQuestion.includes('accessory')) {
        sql = `SELECT name, description, price, category, stock 
               FROM products 
               WHERE LOWER(category) = 'accessories'`;
        queryType = 'category_products';
        console.log(`📂 Fetching accessories products`);
        return { sql, queryType };
    }
    
    // ============================================
    // SPECIFIC PRODUCT QUERIES
    // ============================================
    
    // Handle specific product price
    if ((normalizedQuestion.includes('price') || normalizedQuestion.includes('cost')) && 
        this.extractProductName(normalizedQuestion)) {
        const productMatch = this.extractProductName(normalizedQuestion);
        sql = `SELECT name, description, price, category, stock 
               FROM products 
               WHERE LOWER(name) LIKE '%${productMatch}%'`;
        queryType = 'product_price';
        console.log(`💰 Fetching price for ${productMatch}`);
        return { sql, queryType };
    }
    
    // Handle specific product stock
    if ((normalizedQuestion.includes('stock') || normalizedQuestion.includes('available')) && 
        this.extractProductName(normalizedQuestion)) {
        const productMatch = this.extractProductName(normalizedQuestion);
        sql = `SELECT name, stock, price, description, category 
               FROM products 
               WHERE LOWER(name) LIKE '%${productMatch}%'`;
        queryType = 'product_stock';
        console.log(`📦 Fetching stock for ${productMatch}`);
        return { sql, queryType };
    }
    
    // ============================================
    // DEFAULT - List all products
    // ============================================
    
    // Handle general product list
    if (normalizedQuestion.includes('list') || normalizedQuestion.includes('show me') || 
        normalizedQuestion.includes('products') || normalizedQuestion.includes('product list') ||
        normalizedQuestion.includes('all products')) {
        sql = `SELECT name, description, price, category, stock FROM products LIMIT 10`;
        queryType = 'all_products';
        console.log(`📋 Listing all products`);
        return { sql, queryType };
    }
    
    return { sql, queryType };
}
    
    // generateSQLQuery(question, relevantTables) {
    //     const lowerQuestion = question.toLowerCase();
    //     // Fix: Define normalizedQuestion here
    //     const normalizedQuestion = lowerQuestion.replace(/wharehouse/g, 'warehouse');
        
    //     let sql = null;
    //     let queryType = '';
        
    //     console.log(`🔧 Generating SQL for: "${normalizedQuestion}"`);
        
    //     // ============================================
    //     // CUSTOMER DETAILS QUERIES (Priority)
    //     // ============================================
        
    //     // Handle customer details query
    //     if (normalizedQuestion.includes('customer details') || 
    //         normalizedQuestion.includes('customer information') ||
    //         (normalizedQuestion.includes('customer') && normalizedQuestion.includes('detail'))) {
            
    //         // Check if asking about a specific customer
    //         let customerName = '';
    //         if (normalizedQuestion.includes('john')) customerName = 'John Doe';
    //         else if (normalizedQuestion.includes('jane')) customerName = 'Jane Smith';
    //         else if (normalizedQuestion.includes('bob')) customerName = 'Bob Johnson';
            
    //         if (customerName) {
    //             // Get specific customer details
    //             sql = `SELECT c.name, c.email, c.city, c.membership_level,
    //                           COUNT(o.id) as total_orders,
    //                           COALESCE(SUM(o.total_amount), 0) as total_spent,
    //                           MAX(o.order_date) as last_order_date
    //                    FROM customers c
    //                    LEFT JOIN orders o ON c.id = o.customer_id
    //                    WHERE c.name = '${customerName}'
    //                    GROUP BY c.id`;
    //             queryType = 'customer_details_specific';
    //             console.log(`👤 Fetching details for ${customerName}`);
    //         } else {
    //             // Get all customers
    //             sql = `SELECT c.name, c.email, c.city, c.membership_level,
    //                           COUNT(o.id) as total_orders,
    //                           COALESCE(ROUND(SUM(o.total_amount), 2), 0) as total_spent
    //                    FROM customers c
    //                    LEFT JOIN orders o ON c.id = o.customer_id
    //                    GROUP BY c.id
    //                    ORDER BY total_spent DESC`;
    //             queryType = 'customer_details_all';
    //             console.log(`👤 Fetching all customer details`);
    //         }
    //         return { sql, queryType };
    //     }
        
    //     // ============================================
    //     // WAREHOUSE QUERIES
    //     // ============================================
        
    //     // Handle warehouse products
    //     if (normalizedQuestion.includes('warehouse') && 
    //         (normalizedQuestion.includes('products') || normalizedQuestion.includes('items') || normalizedQuestion.includes('in'))) {
            
    //         let warehouse = '';
    //         if (normalizedQuestion.includes('warehouse a')) warehouse = 'Warehouse A';
    //         else if (normalizedQuestion.includes('warehouse b')) warehouse = 'Warehouse B';
    //         else if (normalizedQuestion.includes('warehouse c')) warehouse = 'Warehouse C';
            
    //         if (warehouse) {
    //             sql = `SELECT p.name, p.price, p.description, p.category, 
    //                           i.quantity as stock, i.warehouse_location, i.last_restocked
    //                    FROM inventory i
    //                    JOIN products p ON i.product_id = p.id
    //                    WHERE i.warehouse_location = '${warehouse}'`;
    //             queryType = 'warehouse_products';
    //             console.log(`🏭 Fetching products in ${warehouse}`);
    //             return { sql, queryType };
    //         }
    //     }
        
    //     // Handle warehouse restocked queries
    //     if (normalizedQuestion.includes('warehouse') && normalizedQuestion.includes('restocked')) {
    //         let warehouse = '';
    //         if (normalizedQuestion.includes('warehouse a')) warehouse = 'Warehouse A';
    //         else if (normalizedQuestion.includes('warehouse b')) warehouse = 'Warehouse B';
    //         else if (normalizedQuestion.includes('warehouse c')) warehouse = 'Warehouse C';
            
    //         if (warehouse) {
    //             sql = `SELECT p.name, i.warehouse_location, i.quantity, i.last_restocked
    //                    FROM inventory i
    //                    JOIN products p ON i.product_id = p.id
    //                    WHERE i.warehouse_location = '${warehouse}'
    //                    ORDER BY i.last_restocked DESC`;
    //             queryType = 'warehouse_restocked';
    //             console.log(`🏭 Fetching restocked items in ${warehouse}`);
    //             return { sql, queryType };
    //         }
    //     }
        
    //     // ============================================
    //     // CATEGORY QUERIES
    //     // ============================================
        
    //     // Handle electronics products
    //     if (normalizedQuestion.includes('electronic') || normalizedQuestion.includes('electronics')) {
    //         sql = `SELECT name, description, price, category, stock 
    //                FROM products 
    //                WHERE LOWER(category) = 'electronics'`;
    //         queryType = 'category_products';
    //         console.log(`📂 Fetching electronics products`);
    //         return { sql, queryType };
    //     }
        
    //     // Handle accessories products
    //     if (normalizedQuestion.includes('accessories') || normalizedQuestion.includes('accessory')) {
    //         sql = `SELECT name, description, price, category, stock 
    //                FROM products 
    //                WHERE LOWER(category) = 'accessories'`;
    //         queryType = 'category_products';
    //         console.log(`📂 Fetching accessories products`);
    //         return { sql, queryType };
    //     }
        
    //     // ============================================
    //     // ORDER QUERIES
    //     // ============================================
        
    //     // Handle "delivered products" or "shipped products"
    //     if (normalizedQuestion.includes('delivered') || normalizedQuestion.includes('shipped')) {
    //         const status = normalizedQuestion.includes('delivered') ? 'Delivered' : 'Shipped';
    //         sql = `SELECT o.id as order_id, o.order_date, o.status, c.name as customer_name,
    //                        SUM(oi.quantity) as total_items, o.total_amount
    //                 FROM orders o
    //                 JOIN customers c ON o.customer_id = c.id
    //                 JOIN order_items oi ON o.id = oi.order_id
    //                 WHERE o.status = '${status}'
    //                 GROUP BY o.id
    //                 ORDER BY o.order_date DESC`;
    //         queryType = `${status.toLowerCase()}_orders`;
    //         console.log(`📦 Fetching ${status} orders`);
    //         return { sql, queryType };
    //     }
        
    //     // Handle customer order details
    //     if (normalizedQuestion.includes('order details') && 
    //         (normalizedQuestion.includes('john') || normalizedQuestion.includes('jane') || normalizedQuestion.includes('bob'))) {
            
    //         let customerName = '';
    //         if (normalizedQuestion.includes('john')) customerName = 'John Doe';
    //         else if (normalizedQuestion.includes('jane')) customerName = 'Jane Smith';
    //         else if (normalizedQuestion.includes('bob')) customerName = 'Bob Johnson';
            
    //         if (customerName) {
    //             sql = `SELECT o.id as order_id, o.order_date, o.status, o.total_amount,
    //                            GROUP_CONCAT(CONCAT(p.name, ' (x', oi.quantity, ')') SEPARATOR ', ') as products
    //                     FROM orders o
    //                     JOIN customers c ON o.customer_id = c.id
    //                     JOIN order_items oi ON o.id = oi.order_id
    //                     JOIN products p ON oi.product_id = p.id
    //                     WHERE c.name = '${customerName}'
    //                     GROUP BY o.id
    //                     ORDER BY o.order_date DESC`;
    //             queryType = 'customer_orders';
    //             console.log(`👤 Fetching orders for ${customerName}`);
    //             return { sql, queryType };
    //         }
    //     }
        
    //     // ============================================
    //     // SPECIFIC PRODUCT QUERIES
    //     // ============================================
        
    //     // Handle specific product price
    //     if ((normalizedQuestion.includes('price') || normalizedQuestion.includes('cost')) && 
    //         this.extractProductName(normalizedQuestion)) {
    //         const productMatch = this.extractProductName(normalizedQuestion);
    //         sql = `SELECT name, description, price, category, stock 
    //                FROM products 
    //                WHERE LOWER(name) LIKE '%${productMatch}%'`;
    //         queryType = 'product_price';
    //         console.log(`💰 Fetching price for ${productMatch}`);
    //         return { sql, queryType };
    //     }
        
    //     // Handle specific product stock
    //     if ((normalizedQuestion.includes('stock') || normalizedQuestion.includes('available')) && 
    //         this.extractProductName(normalizedQuestion)) {
    //         const productMatch = this.extractProductName(normalizedQuestion);
    //         sql = `SELECT name, stock, price, description, category 
    //                FROM products 
    //                WHERE LOWER(name) LIKE '%${productMatch}%'`;
    //         queryType = 'product_stock';
    //         console.log(`📦 Fetching stock for ${productMatch}`);
    //         return { sql, queryType };
    //     }
        
    //     // ============================================
    //     // DEFAULT - List all products
    //     // ============================================
        
    //     // Handle general product list
    //     if (normalizedQuestion.includes('list') || normalizedQuestion.includes('show me') || 
    //         normalizedQuestion.includes('products') || normalizedQuestion.includes('product list')) {
    //         sql = `SELECT name, description, price, category, stock FROM products LIMIT 10`;
    //         queryType = 'all_products';
    //         console.log(`📋 Listing all products`);
    //         return { sql, queryType };
    //     }
        
    //     // Handle product prices (general)
    //     if (normalizedQuestion.includes('price') || normalizedQuestion.includes('cost')) {
    //         sql = `SELECT name, price, category FROM products LIMIT 10`;
    //         queryType = 'product_prices';
    //         console.log(`💰 Fetching all product prices`);
    //         return { sql, queryType };
    //     }
        
    //     return { sql, queryType };
    // }
    
    extractProductName(question) {
        const productKeywords = ['laptop', 'mouse', 'keyboard', 'monitor', 'cable', 'usb', 'headphone', '4k'];
        for (const keyword of productKeywords) {
            if (question.includes(keyword)) {
                return keyword;
            }
        }
        return null;
    }
    
    getTableInfo() {
        return this.tables;
    }
}

module.exports = new TableManager();