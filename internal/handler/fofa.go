package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"cyberstrike-ai/internal/config"
	openaiClient "cyberstrike-ai/internal/openai"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

type FofaHandler struct {
	cfg          *config.Config
	logger       *zap.Logger
	client       *http.Client
	openAIClient *openaiClient.Client
}

func NewFofaHandler(cfg *config.Config, logger *zap.Logger) *FofaHandler {
	// LLM 请求通常比 FOFA 查询更慢一点，单独给一个更宽松的超时。
	llmHTTPClient := &http.Client{Timeout: 2 * time.Minute}
	var llmCfg *config.OpenAIConfig
	if cfg != nil {
		llmCfg = &cfg.OpenAI
	}
	return &FofaHandler{
		cfg:          cfg,
		logger:       logger,
		client:       &http.Client{Timeout: 30 * time.Second},
		openAIClient: openaiClient.NewClient(llmCfg, llmHTTPClient, logger),
	}
}

type fofaSearchRequest struct {
	Query  string `json:"query" binding:"required"`
	Size   int    `json:"size,omitempty"`
	Page   int    `json:"page,omitempty"`
	Fields string `json:"fields,omitempty"`
	Full   bool   `json:"full,omitempty"`
}

type fofaParseRequest struct {
	Text string `json:"text" binding:"required"`
}

type fofaParseResponse struct {
	Query       string   `json:"query"`
	Explanation string   `json:"explanation,omitempty"`
	Warnings    []string `json:"warnings,omitempty"`
}

type fofaAPIResponse struct {
	Error   bool            `json:"error"`
	ErrMsg  string          `json:"errmsg"`
	Size    int             `json:"size"`
	Page    int             `json:"page"`
	Total   int             `json:"total"`
	Mode    string          `json:"mode"`
	Query   string          `json:"query"`
	Results [][]interface{} `json:"results"`
}

type fofaSearchResponse struct {
	Query        string                   `json:"query"`
	Size         int                      `json:"size"`
	Page         int                      `json:"page"`
	Total        int                      `json:"total"`
	Fields       []string                 `json:"fields"`
	ResultsCount int                      `json:"results_count"`
	Results      []map[string]interface{} `json:"results"`
}

func (h *FofaHandler) resolveCredentials() (email, apiKey string) {
	// 优先环境变量（便于容器部署），其次配置文件
	email = strings.TrimSpace(os.Getenv("FOFA_EMAIL"))
	apiKey = strings.TrimSpace(os.Getenv("FOFA_API_KEY"))
	if email != "" && apiKey != "" {
		return email, apiKey
	}
	if h.cfg != nil {
		if email == "" {
			email = strings.TrimSpace(h.cfg.FOFA.Email)
		}
		if apiKey == "" {
			apiKey = strings.TrimSpace(h.cfg.FOFA.APIKey)
		}
	}
	return email, apiKey
}

func (h *FofaHandler) resolveBaseURL() string {
	if h.cfg != nil {
		if v := strings.TrimSpace(h.cfg.FOFA.BaseURL); v != "" {
			return v
		}
	}
	return "https://fofa.info/api/v1/search/all"
}

// ParseNaturalLanguage 将自然语言解析为 FOFA 查询语法（仅生成，不执行查询）
func (h *FofaHandler) ParseNaturalLanguage(c *gin.Context) {
	var req fofaParseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的请求参数: " + err.Error()})
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text 不能为空"})
		return
	}

	if h.cfg == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "系统配置未初始化"})
		return
	}
	if strings.TrimSpace(h.cfg.OpenAI.APIKey) == "" || strings.TrimSpace(h.cfg.OpenAI.Model) == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "未配置 AI 模型：请在系统设置中填写 openai.api_key 与 openai.model（支持 OpenAI 兼容 API，如 DeepSeek）",
			"need":  []string{"openai.api_key", "openai.model"},
		})
		return
	}
	if h.openAIClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "AI 客户端未初始化"})
		return
	}

	systemPrompt := strings.TrimSpace(`
你是“FOFA 查询语法生成器”。任务：把用户输入的自然语言搜索意图，转换成 FOFA 查询语法。

输出要求（非常重要）：
1) 只输出 JSON（不要 markdown、不要代码块、不要额外解释文本）
2) JSON 结构必须是：
{
  "query": "string，FOFA查询语法（可直接粘贴到 FOFA 或本系统查询框）",
  "explanation": "string，可选，解释你如何映射字段/逻辑",
  "warnings": ["string"...] 可选，列出歧义/风险/需要人工确认的点
}

查询语法要点（来自 FOFA 语法参考）：
- 逻辑连接符：&&（与）、||（或），必要时用 () 包住子表达式以确认优先级（括号优先级最高）
- 比较/匹配：
  - =  匹配；当字段="" 时，可查询“不存在该字段”或“值为空”的情况
  - == 完全匹配；当字段=="" 时，可查询“字段存在且值为空”的情况
  - != 不匹配；当字段!="" 时，可查询“值不为空”的情况
  - *= 模糊匹配；可使用 * 或 ? 进行搜索
- 直接输入关键词（不带字段）会在标题、HTML内容、HTTP头、URL字段中搜索；但当意图明确时优先用字段表达（更可控、更准确）

常用字段速查（来自截图的分类示例，按需使用）：
- 基础类（General）：ip、port、domain、host、os、server、asn、org、is_domain、is_ipv6
- 标记类（Special Label）：app、fid、product、product.version
- 其它筛选：category、type（常见：type="service" / type="subdomain"）、cloud_name、is_cloud、is_fraud、is_honeypot
- 网站类（type=subdomain）：title、header、header_hash、body、body_hash、js_name、js_md5、cname、cname_domain、icon_hash、status_code、icp、sdk_hash
- 地理位置（Location）：country、region、city
- 证书类（Certificate）：cert、cert.subject、cert.issuer、cert.subject.org、cert.subject.cn、cert.issuer.org、cert.issuer.cn、cert.domain、
  cert.is_equal、cert.is_valid、cert.is_match、cert.is_expired、jarm

生成规则（务必遵守）：
- 字符串值一律用英文双引号包裹，例如 title="登录"、country="CN"
- 不要捏造不存在的 FOFA 字段；不确定时把不确定点写进 warnings，并输出一个保守的 query
- 当用户描述里有“多个与/或条件”，优先加 () 明确优先级，例如：(app="Apache" || app="Nginx") && country="CN"
- 当用户缺少关键条件导致范围过大或歧义（如地点/协议/端口/服务类型未说明），允许 query 为空字符串，并在 warnings 里明确需要补充的信息
`)

	userPrompt := fmt.Sprintf("自然语言意图：%s", req.Text)

	requestBody := map[string]interface{}{
		"model": h.cfg.OpenAI.Model,
		"messages": []map[string]interface{}{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"temperature": 0.1,
		"max_tokens":  1200,
	}

	// OpenAI 返回结构：只需要 choices[0].message.content
	var apiResponse struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()

	if err := h.openAIClient.ChatCompletion(ctx, requestBody, &apiResponse); err != nil {
		var apiErr *openaiClient.APIError
		if errors.As(err, &apiErr) {
			h.logger.Warn("FOFA自然语言解析：LLM返回错误", zap.Int("status", apiErr.StatusCode))
			c.JSON(http.StatusBadGateway, gin.H{"error": "AI 解析失败（上游返回非 200），请检查模型配置或稍后重试"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "AI 解析失败: " + err.Error()})
		return
	}
	if len(apiResponse.Choices) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"error": "AI 未返回有效结果"})
		return
	}

	content := strings.TrimSpace(apiResponse.Choices[0].Message.Content)
	// 兼容模型偶尔返回 ```json ... ``` 的情况
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)

	var parsed fofaParseResponse
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		// 直接回传一部分原文，方便排查，但避免太大
		snippet := content
		if len(snippet) > 1200 {
			snippet = snippet[:1200]
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"error":   "AI 返回内容无法解析为 JSON，请稍后重试或换个描述方式",
			"snippet": snippet,
		})
		return
	}
	parsed.Query = strings.TrimSpace(parsed.Query)
	if parsed.Query == "" {
		// query 允许为空（表示需求不明确），但前端需要明确提示
		if len(parsed.Warnings) == 0 {
			parsed.Warnings = []string{"需求信息不足，未能生成可用的 FOFA 查询语法，请补充关键条件（如国家/端口/产品/域名等）。"}
		}
	}

	c.JSON(http.StatusOK, parsed)
}

// Search FOFA 查询（后端代理，避免前端暴露 key）
func (h *FofaHandler) Search(c *gin.Context) {
	var req fofaSearchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的请求参数: " + err.Error()})
		return
	}

	req.Query = strings.TrimSpace(req.Query)
	if req.Query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query 不能为空"})
		return
	}
	if req.Size <= 0 {
		req.Size = 100
	}
	if req.Page <= 0 {
		req.Page = 1
	}
	// FOFA 接口 size 上限和账户权限相关，这里只做一个合理的保护
	if req.Size > 10000 {
		req.Size = 10000
	}
	if req.Fields == "" {
		req.Fields = "host,ip,port,domain,title,protocol,country,province,city,server"
	}

	email, apiKey := h.resolveCredentials()
	if email == "" || apiKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "FOFA 未配置：请在系统设置中填写 FOFA Email/API Key，或设置环境变量 FOFA_EMAIL/FOFA_API_KEY",
			"need":    []string{"fofa.email", "fofa.api_key"},
			"env_key": []string{"FOFA_EMAIL", "FOFA_API_KEY"},
		})
		return
	}

	baseURL := h.resolveBaseURL()
	qb64 := base64.StdEncoding.EncodeToString([]byte(req.Query))

	u, err := url.Parse(baseURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "FOFA base_url 无效: " + err.Error()})
		return
	}

	params := u.Query()
	params.Set("email", email)
	params.Set("key", apiKey)
	params.Set("qbase64", qb64)
	params.Set("size", fmt.Sprintf("%d", req.Size))
	params.Set("page", fmt.Sprintf("%d", req.Page))
	params.Set("fields", strings.TrimSpace(req.Fields))
	if req.Full {
		params.Set("full", "true")
	} else {
		// 明确传 false，便于排查
		params.Set("full", "false")
	}
	u.RawQuery = params.Encode()

	httpReq, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建请求失败: " + err.Error()})
		return
	}

	resp, err := h.client.Do(httpReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "请求 FOFA 失败: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("FOFA 返回非 2xx: %d", resp.StatusCode)})
		return
	}

	var apiResp fofaAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "解析 FOFA 响应失败: " + err.Error()})
		return
	}
	if apiResp.Error {
		msg := strings.TrimSpace(apiResp.ErrMsg)
		if msg == "" {
			msg = "FOFA 返回错误"
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": msg})
		return
	}

	fields := splitAndCleanCSV(req.Fields)
	results := make([]map[string]interface{}, 0, len(apiResp.Results))
	for _, row := range apiResp.Results {
		item := make(map[string]interface{}, len(fields))
		for i, f := range fields {
			if i < len(row) {
				item[f] = row[i]
			} else {
				item[f] = nil
			}
		}
		results = append(results, item)
	}

	c.JSON(http.StatusOK, fofaSearchResponse{
		Query:        req.Query,
		Size:         apiResp.Size,
		Page:         apiResp.Page,
		Total:        apiResp.Total,
		Fields:       fields,
		ResultsCount: len(results),
		Results:      results,
	})
}

func splitAndCleanCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		v := strings.TrimSpace(p)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
