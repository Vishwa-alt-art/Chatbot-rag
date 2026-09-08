// Simple TF-IDF style keyword extraction (no external API)
class SimpleEmbedding {
    // Extract keywords from text
    extractKeywords(text) {
        // Remove punctuation and convert to lowercase
        const cleanText = text.toLowerCase().replace(/[^\w\s]/g, '');
        const words = cleanText.split(/\s+/);
        
        // Remove stop words
        const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'but', 'not', 'so', 'very', 'just']);
        
        const keywords = words.filter(word => 
            word.length > 2 && !stopWords.has(word)
        );
        
        // Count frequency
        const frequency = {};
        keywords.forEach(word => {
            frequency[word] = (frequency[word] || 0) + 1;
        });
        
        // Return top keywords
        return Object.entries(frequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(entry => entry[0]);
    }
    
    // Calculate simple relevance score between question and content
    calculateRelevance(question, content) {
        const questionWords = new Set(this.extractKeywords(question));
        const contentWords = new Set(this.extractKeywords(content));
        
        // Calculate Jaccard similarity
        const intersection = new Set([...questionWords].filter(x => contentWords.has(x)));
        const union = new Set([...questionWords, ...contentWords]);
        
        return intersection.size / union.size;
    }
    
    // Rank search results by relevance
    rankResults(question, results, contentField = 'description') {
        return results.map(result => {
            const content = result[contentField] || '';
            const score = this.calculateRelevance(question, content);
            return { ...result, relevance_score: score };
        }).sort((a, b) => b.relevance_score - a.relevance_score);
    }
}

module.exports = new SimpleEmbedding();