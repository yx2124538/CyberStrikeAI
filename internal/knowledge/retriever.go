package knowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"go.uber.org/zap"
)

// Retriever 检索器
type Retriever struct {
	db       *sql.DB
	embedder *Embedder
	config   *RetrievalConfig
	logger   *zap.Logger
}

// RetrievalConfig 检索配置
type RetrievalConfig struct {
	TopK                int
	SimilarityThreshold float64
	HybridWeight        float64
}

// NewRetriever 创建新的检索器
func NewRetriever(db *sql.DB, embedder *Embedder, config *RetrievalConfig, logger *zap.Logger) *Retriever {
	return &Retriever{
		db:       db,
		embedder: embedder,
		config:   config,
		logger:   logger,
	}
}

// cosineSimilarity 计算余弦相似度
func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0.0
	}

	var dotProduct, normA, normB float64
	for i := range a {
		dotProduct += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}

	if normA == 0 || normB == 0 {
		return 0.0
	}

	return dotProduct / (math.Sqrt(normA) * math.Sqrt(normB))
}

// bm25Score 计算BM25分数（简化版）
func (r *Retriever) bm25Score(query, text string) float64 {
	queryTerms := strings.Fields(strings.ToLower(query))
	textLower := strings.ToLower(text)
	textTerms := strings.Fields(textLower)

	score := 0.0
	for _, term := range queryTerms {
		termFreq := 0
		for _, textTerm := range textTerms {
			if textTerm == term {
				termFreq++
			}
		}
		if termFreq > 0 {
			// 简化的BM25公式
			score += float64(termFreq) / float64(len(textTerms))
		}
	}

	return score / float64(len(queryTerms))
}

// Search 搜索知识库
func (r *Retriever) Search(ctx context.Context, req *SearchRequest) ([]*RetrievalResult, error) {
	if req.Query == "" {
		return nil, fmt.Errorf("查询不能为空")
	}

	topK := req.TopK
	if topK <= 0 {
		topK = r.config.TopK
	}
	if topK == 0 {
		topK = 5
	}

	threshold := req.Threshold
	if threshold <= 0 {
		threshold = r.config.SimilarityThreshold
	}
	if threshold == 0 {
		threshold = 0.7
	}

	// 向量化查询
	queryEmbedding, err := r.embedder.EmbedText(ctx, req.Query)
	if err != nil {
		return nil, fmt.Errorf("向量化查询失败: %w", err)
	}

	// 查询所有向量（或按风险类型过滤）
	var rows *sql.Rows
	if req.RiskType != "" {
		rows, err = r.db.Query(`
			SELECT e.id, e.item_id, e.chunk_index, e.chunk_text, e.embedding, i.category, i.title
			FROM knowledge_embeddings e
			JOIN knowledge_base_items i ON e.item_id = i.id
			WHERE i.category = ?
		`, req.RiskType)
	} else {
		rows, err = r.db.Query(`
			SELECT e.id, e.item_id, e.chunk_index, e.chunk_text, e.embedding, i.category, i.title
			FROM knowledge_embeddings e
			JOIN knowledge_base_items i ON e.item_id = i.id
		`)
	}
	if err != nil {
		return nil, fmt.Errorf("查询向量失败: %w", err)
	}
	defer rows.Close()

	// 计算相似度
	type candidate struct {
		chunk      *KnowledgeChunk
		item       *KnowledgeItem
		similarity float64
		bm25Score  float64
	}

	candidates := make([]candidate, 0)

	for rows.Next() {
		var chunkID, itemID, chunkText, embeddingJSON, category, title string
		var chunkIndex int

		if err := rows.Scan(&chunkID, &itemID, &chunkIndex, &chunkText, &embeddingJSON, &category, &title); err != nil {
			r.logger.Warn("扫描向量失败", zap.Error(err))
			continue
		}

		// 解析向量
		var embedding []float32
		if err := json.Unmarshal([]byte(embeddingJSON), &embedding); err != nil {
			r.logger.Warn("解析向量失败", zap.Error(err))
			continue
		}

		// 计算余弦相似度
		similarity := cosineSimilarity(queryEmbedding, embedding)

		// 计算BM25分数（考虑chunk文本、category和title）
		// category和title是结构化字段，完全匹配时应该被优先考虑
		chunkBM25 := r.bm25Score(req.Query, chunkText)
		categoryBM25 := r.bm25Score(req.Query, category)
		titleBM25 := r.bm25Score(req.Query, title)

		// 检查category或title是否有显著匹配（这对于结构化字段很重要）
		hasStrongKeywordMatch := categoryBM25 > 0.3 || titleBM25 > 0.3

		// 综合BM25分数（用于后续排序）
		bm25Score := math.Max(math.Max(chunkBM25, categoryBM25), titleBM25)

		// 过滤策略：
		// 1. 如果向量相似度达到阈值，通过
		// 2. 如果category/title有显著匹配，适当放宽相似度要求（因为它们更可靠）
		// 这样既保持了原有的过滤严格性，又能处理结构化字段匹配的情况
		if similarity < threshold {
			// 只有当category或title有明显匹配时，才适当放宽阈值
			if hasStrongKeywordMatch {
				// 放宽到原阈值的75%，但至少要有0.35的相似度
				// 这确保了即使关键词匹配，向量相似度也不能太低
				relaxedThreshold := math.Max(threshold*0.75, 0.35)
				if similarity < relaxedThreshold {
					continue
				}
			} else {
				continue
			}
		}

		chunk := &KnowledgeChunk{
			ID:         chunkID,
			ItemID:     itemID,
			ChunkIndex: chunkIndex,
			ChunkText:  chunkText,
			Embedding:  embedding,
		}

		item := &KnowledgeItem{
			ID:       itemID,
			Category: category,
			Title:    title,
		}

		candidates = append(candidates, candidate{
			chunk:      chunk,
			item:       item,
			similarity: similarity,
			bm25Score:  bm25Score,
		})
	}

	// 混合排序（向量相似度 + BM25）
	hybridWeight := r.config.HybridWeight
	if hybridWeight == 0 {
		hybridWeight = 0.7
	}

	// 按混合分数排序（简化：主要按相似度，BM25作为次要因素）
	// 这里我们主要使用相似度，因为BM25分数可能不稳定
	// 实际可以使用更复杂的混合策略

	// 选择Top-K
	if len(candidates) > topK {
		// 简单排序（按相似度）
		for i := 0; i < len(candidates)-1; i++ {
			for j := i + 1; j < len(candidates); j++ {
				if candidates[i].similarity < candidates[j].similarity {
					candidates[i], candidates[j] = candidates[j], candidates[i]
				}
			}
		}
		candidates = candidates[:topK]
	}

	// 转换为结果
	results := make([]*RetrievalResult, len(candidates))
	for i, cand := range candidates {
		// 计算混合分数
		normalizedBM25 := math.Min(cand.bm25Score, 1.0)
		hybridScore := hybridWeight*cand.similarity + (1-hybridWeight)*normalizedBM25

		results[i] = &RetrievalResult{
			Chunk:      cand.chunk,
			Item:       cand.item,
			Similarity: cand.similarity,
			Score:      hybridScore,
		}
	}

	return results, nil
}
