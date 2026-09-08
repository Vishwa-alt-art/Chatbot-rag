const Redis = require('ioredis');

async function testRedis() {
    console.log('Testing Redis connection with IPv4...');
    
    const redis = new Redis({
        host: '127.0.0.1',
        port: 6379,
        family: 4,
        lazyConnect: false
    });
    
    redis.on('connect', () => {
        console.log('✅ Connected to Redis!');
    });
    
    redis.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
    });
    
    try {
        // Test ping
        const pong = await redis.ping();
        console.log('✅ Ping test:', pong);
        
        // Test set/get
        await redis.set('test:key', 'Hello Redis!', 'EX', 60);
        const value = await redis.get('test:key');
        console.log('✅ Set/Get test:', value);
        
        // Get Redis info
        const info = await redis.info('server');
        const version = info.match(/redis_version:(\d+\.\d+\.\d+)/)?.[1];
        console.log('✅ Redis version:', version);
        
        // Cleanup
        await redis.del('test:key');
        console.log('✅ All tests passed!');
        
        await redis.quit();
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testRedis();