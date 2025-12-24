package attackchain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"cyberstrike-ai/internal/agent"
	"cyberstrike-ai/internal/config"
	"cyberstrike-ai/internal/database"
	"cyberstrike-ai/internal/openai"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// Builder 攻击链构建器
type Builder struct {
	db           *database.DB
	logger       *zap.Logger
	openAIClient *openai.Client
	openAIConfig *config.OpenAIConfig
	tokenCounter agent.TokenCounter
	maxTokens    int // 最大tokens限制，默认100000
}

// Node 攻击链节点（使用database包的类型）
type Node = database.AttackChainNode

// Edge 攻击链边（使用database包的类型）
type Edge = database.AttackChainEdge

// Chain 完整的攻击链
type Chain struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// NewBuilder 创建新的攻击链构建器
func NewBuilder(db *database.DB, openAIConfig *config.OpenAIConfig, logger *zap.Logger) *Builder {
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}
	httpClient := &http.Client{Timeout: 5 * time.Minute, Transport: transport}

	// 优先使用配置文件中的统一 Token 上限（config.yaml -> openai.max_total_tokens）
	maxTokens := 0
	if openAIConfig != nil && openAIConfig.MaxTotalTokens > 0 {
		maxTokens = openAIConfig.MaxTotalTokens
	} else if openAIConfig != nil {
		// 如果未显式配置 max_total_tokens，则根据模型设置一个合理的默认值
		model := strings.ToLower(openAIConfig.Model)
		if strings.Contains(model, "gpt-4") {
			maxTokens = 128000 // gpt-4通常支持128k
		} else if strings.Contains(model, "gpt-3.5") {
			maxTokens = 16000 // gpt-3.5-turbo通常支持16k
		} else if strings.Contains(model, "deepseek") {
			maxTokens = 131072 // deepseek-chat通常支持131k
		} else {
			maxTokens = 100000 // 兜底默认值
		}
	} else {
		// 没有 OpenAI 配置时使用兜底值，避免为 0
		maxTokens = 100000
	}

	return &Builder{
		db:           db,
		logger:       logger,
		openAIClient: openai.NewClient(openAIConfig, httpClient, logger),
		openAIConfig: openAIConfig,
		tokenCounter: agent.NewTikTokenCounter(),
		maxTokens:    maxTokens,
	}
}

// BuildChainFromConversation 从对话构建攻击链（简化版本：用户输入+最后一轮ReAct输入+大模型输出）
func (b *Builder) BuildChainFromConversation(ctx context.Context, conversationID string) (*Chain, error) {
	b.logger.Info("开始构建攻击链（简化版本）", zap.String("conversationId", conversationID))

	// 0. 首先检查是否有实际的工具执行记录
	messages, err := b.db.GetMessages(conversationID)
	if err != nil {
		return nil, fmt.Errorf("获取对话消息失败: %w", err)
	}

	if len(messages) == 0 {
		b.logger.Info("对话中没有数据", zap.String("conversationId", conversationID))
		return &Chain{Nodes: []Node{}, Edges: []Edge{}}, nil
	}

	// 检查是否有实际的工具执行（通过检查assistant消息的mcp_execution_ids）
	hasToolExecutions := false
	for i := len(messages) - 1; i >= 0; i-- {
		if strings.EqualFold(messages[i].Role, "assistant") {
			if len(messages[i].MCPExecutionIDs) > 0 {
				hasToolExecutions = true
				break
			}
		}
	}

	// 检查任务是否被取消（通过检查最后一条assistant消息内容或process_details）
	taskCancelled := false
	for i := len(messages) - 1; i >= 0; i-- {
		if strings.EqualFold(messages[i].Role, "assistant") {
			content := strings.ToLower(messages[i].Content)
			if strings.Contains(content, "取消") || strings.Contains(content, "cancelled") {
				taskCancelled = true
			}
			break
		}
	}

	// 如果任务被取消且没有实际工具执行，返回空攻击链
	if taskCancelled && !hasToolExecutions {
		b.logger.Info("任务已取消且没有实际工具执行，返回空攻击链",
			zap.String("conversationId", conversationID),
			zap.Bool("taskCancelled", taskCancelled),
			zap.Bool("hasToolExecutions", hasToolExecutions))
		return &Chain{Nodes: []Node{}, Edges: []Edge{}}, nil
	}

	// 如果没有实际工具执行，也返回空攻击链（避免AI编造）
	if !hasToolExecutions {
		b.logger.Info("没有实际工具执行记录，返回空攻击链",
			zap.String("conversationId", conversationID))
		return &Chain{Nodes: []Node{}, Edges: []Edge{}}, nil
	}

	// 1. 优先尝试从数据库获取保存的最后一轮ReAct输入和输出
	reactInputJSON, modelOutput, err := b.db.GetReActData(conversationID)
	if err != nil {
		b.logger.Warn("获取保存的ReAct数据失败，将使用消息历史构建", zap.Error(err))
		// 继续使用原来的逻辑
		reactInputJSON = ""
		modelOutput = ""
	}

	// var userInput string
	var reactInputFinal string
	var dataSource string // 记录数据来源

	// 如果成功获取到保存的ReAct数据，直接使用
	if reactInputJSON != "" && modelOutput != "" {
		// 计算 ReAct 输入的哈希值，用于追踪
		hash := sha256.Sum256([]byte(reactInputJSON))
		reactInputHash := hex.EncodeToString(hash[:])[:16] // 使用前16字符作为短标识

		// 统计消息数量
		var messageCount int
		var tempMessages []interface{}
		if json.Unmarshal([]byte(reactInputJSON), &tempMessages) == nil {
			messageCount = len(tempMessages)
		}

		dataSource = "database_last_react_input"
		b.logger.Info("使用保存的ReAct数据构建攻击链",
			zap.String("conversationId", conversationID),
			zap.String("dataSource", dataSource),
			zap.Int("reactInputSize", len(reactInputJSON)),
			zap.Int("messageCount", messageCount),
			zap.String("reactInputHash", reactInputHash),
			zap.Int("modelOutputSize", len(modelOutput)))

		// 从保存的ReAct输入（JSON格式）中提取用户输入
		// userInput = b.extractUserInputFromReActInput(reactInputJSON)

		// 将JSON格式的messages转换为可读格式
		reactInputFinal = b.formatReActInputFromJSON(reactInputJSON)
	} else {
		// 2. 如果没有保存的ReAct数据，从对话消息构建
		dataSource = "messages_table"
		b.logger.Info("从消息历史构建ReAct数据",
			zap.String("conversationId", conversationID),
			zap.String("dataSource", dataSource),
			zap.Int("messageCount", len(messages)))

		// 提取用户输入（最后一条user消息）
		for i := len(messages) - 1; i >= 0; i-- {
			if strings.EqualFold(messages[i].Role, "user") {
				// userInput = messages[i].Content
				break
			}
		}

		// 提取最后一轮ReAct的输入（历史消息+当前用户输入）
		reactInputFinal = b.buildReActInput(messages)

		// 提取大模型最后的输出（最后一条assistant消息）
		for i := len(messages) - 1; i >= 0; i-- {
			if strings.EqualFold(messages[i].Role, "assistant") {
				modelOutput = messages[i].Content
				break
			}
		}
	}

	// 3. 构建简化的prompt，一次性传递给大模型
	prompt := b.buildSimplePrompt(reactInputFinal, modelOutput)
	// fmt.Println(prompt)
	// 6. 调用AI生成攻击链（一次性，不做任何处理）
	chainJSON, err := b.callAIForChainGeneration(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("AI生成失败: %w", err)
	}

	// 7. 解析JSON并生成节点/边ID（前端需要有效的ID）
	chainData, err := b.parseChainJSON(chainJSON)
	if err != nil {
		// 如果解析失败，返回空链，让前端处理错误
		b.logger.Warn("解析攻击链JSON失败", zap.Error(err), zap.String("raw_json", chainJSON))
		return &Chain{
			Nodes: []Node{},
			Edges: []Edge{},
		}, nil
	}

	b.logger.Info("攻击链构建完成",
		zap.String("conversationId", conversationID),
		zap.String("dataSource", dataSource),
		zap.Int("nodes", len(chainData.Nodes)),
		zap.Int("edges", len(chainData.Edges)))

	// 保存到数据库（供后续加载使用）
	if err := b.saveChain(conversationID, chainData.Nodes, chainData.Edges); err != nil {
		b.logger.Warn("保存攻击链到数据库失败", zap.Error(err))
		// 即使保存失败，也返回数据给前端
	}

	// 直接返回，不做任何处理和校验
	return chainData, nil
}

// buildReActInput 构建最后一轮ReAct的输入（历史消息+当前用户输入）
func (b *Builder) buildReActInput(messages []database.Message) string {
	var builder strings.Builder
	for _, msg := range messages {
		builder.WriteString(fmt.Sprintf("[%s]: %s\n\n", msg.Role, msg.Content))
	}
	return builder.String()
}

// extractUserInputFromReActInput 从保存的ReAct输入（JSON格式的messages数组）中提取最后一条用户输入
// func (b *Builder) extractUserInputFromReActInput(reactInputJSON string) string {
// 	// reactInputJSON是JSON格式的ChatMessage数组，需要解析
// 	var messages []map[string]interface{}
// 	if err := json.Unmarshal([]byte(reactInputJSON), &messages); err != nil {
// 		b.logger.Warn("解析ReAct输入JSON失败", zap.Error(err))
// 		return ""
// 	}

// 	// 从后往前查找最后一条user消息
// 	for i := len(messages) - 1; i >= 0; i-- {
// 		if role, ok := messages[i]["role"].(string); ok && strings.EqualFold(role, "user") {
// 			if content, ok := messages[i]["content"].(string); ok {
// 				return content
// 			}
// 		}
// 	}

// 	return ""
// }

// formatReActInputFromJSON 将JSON格式的messages数组转换为可读的字符串格式
func (b *Builder) formatReActInputFromJSON(reactInputJSON string) string {
	var messages []map[string]interface{}
	if err := json.Unmarshal([]byte(reactInputJSON), &messages); err != nil {
		b.logger.Warn("解析ReAct输入JSON失败", zap.Error(err))
		return reactInputJSON // 如果解析失败，返回原始JSON
	}

	var builder strings.Builder
	for _, msg := range messages {
		role, _ := msg["role"].(string)
		content, _ := msg["content"].(string)

		// 处理assistant消息：提取tool_calls信息
		if role == "assistant" {
			if toolCalls, ok := msg["tool_calls"].([]interface{}); ok && len(toolCalls) > 0 {
				// 如果有文本内容，先显示
				if content != "" {
					builder.WriteString(fmt.Sprintf("[%s]: %s\n", role, content))
				}
				// 详细显示每个工具调用
				builder.WriteString(fmt.Sprintf("[%s] 工具调用 (%d个):\n", role, len(toolCalls)))
				for i, toolCall := range toolCalls {
					if tc, ok := toolCall.(map[string]interface{}); ok {
						toolCallID, _ := tc["id"].(string)
						if funcData, ok := tc["function"].(map[string]interface{}); ok {
							toolName, _ := funcData["name"].(string)
							arguments, _ := funcData["arguments"].(string)
							builder.WriteString(fmt.Sprintf("  [工具调用 %d]\n", i+1))
							builder.WriteString(fmt.Sprintf("    ID: %s\n", toolCallID))
							builder.WriteString(fmt.Sprintf("    工具名称: %s\n", toolName))
							builder.WriteString(fmt.Sprintf("    参数: %s\n", arguments))
						}
					}
				}
				builder.WriteString("\n")
				continue
			}
		}

		// 处理tool消息：显示tool_call_id和完整内容
		if role == "tool" {
			toolCallID, _ := msg["tool_call_id"].(string)
			if toolCallID != "" {
				builder.WriteString(fmt.Sprintf("[%s] (tool_call_id: %s):\n%s\n\n", role, toolCallID, content))
			} else {
				builder.WriteString(fmt.Sprintf("[%s]: %s\n\n", role, content))
			}
			continue
		}

		// 其他消息类型（system, user等）正常显示
		builder.WriteString(fmt.Sprintf("[%s]: %s\n\n", role, content))
	}

	return builder.String()
}

// buildSimplePrompt 构建简化的prompt
func (b *Builder) buildSimplePrompt(reactInput, modelOutput string) string {
	return fmt.Sprintf(`你是一个专业的安全测试分析师。请根据以下对话和工具执行记录，生成清晰、有教育意义的攻击链图。

## 核心原则

**目标：让不懂渗透测试的同学可以通过这个攻击链路学习到知识，而不是无数个节点看花眼。**
**⚠️ 特别重要：失败路径和错误经验同样具有重要价值！**

**失败路径的价值：**
- **指引作用**：失败的尝试往往揭示了系统的防御机制、配置信息或攻击面边界
- **学习价值**：展示"为什么这条路走不通"、"遇到了什么障碍"、"如何绕过或解决"
- **完整还原**：真实的渗透测试过程包含大量失败尝试，只展示成功路径会误导学习者
- **关键线索**：即使工具执行失败，错误信息、超时、拒绝连接等都可能包含重要信息（如WAF类型、防护策略、端口状态等）

**必须保留的失败路径类型：**
1. **工具执行失败但提供了线索**：如"工具未安装"、"权限不足"、"连接被拒绝"、"超时"等，这些信息有助于理解环境限制
2. **漏洞验证失败但指明了方向**：如"SQL注入尝试失败，但暴露了数据库类型"、"XSS尝试被WAF拦截，但暴露了WAF规则"
3. **扫描失败但揭示了防护**：如"端口扫描被防火墙拦截"、"目录枚举被限制"、"暴力破解被锁定"
4. **配置错误或环境问题**：如"工具配置错误"、"目标不可达"、"证书验证失败"等，这些可能揭示系统配置问题
5. **AI分析中的失败尝试**：如果AI在对话中明确提到"尝试了X但失败了，因为Y"，这也应该被记录

**关键要求：**
1. **节点标签必须简洁明了**：每个节点标签控制在15-25个汉字以内，使用简洁的动宾结构
   - action节点要描述"做了什么"和"发现了什么"（如"扫描端口发现22/80/443"、"验证SQL注入成功"、"WAF拦截暴露厂商"、"SQLMap扫描失败（工具未安装）"）
   - 失败路径的标签应明确标注失败原因（如"尝试SQL注入（被WAF拦截）"、"端口扫描（连接超时）"）
   - 避免冗长描述，关键信息放在metadata中详细说明
2. **严格控制节点数量**：优先保留关键步骤，避免生成过多细碎节点。理想情况下，单个目标的攻击链应控制在8-15个节点以内
   - 如果节点太多（>20个），优先保留最重要的节点（包括重要的失败路径），合并或删除次要节点
   - 合并相似的action节点（如同一工具的连续调用，如果结果相似）
   - 对于同一类型的多个发现，考虑合并为一个节点（如"发现多个开放端口"而不是为每个端口创建节点）
   - **但不要因为节点数量限制而删除有价值的失败路径**
3. **确保DAG结构**：生成的图必须是有向无环图（DAG），不允许出现循环。边的方向必须符合时间顺序和逻辑关系（从早期步骤指向后期步骤）
   - 生成后必须检查：确保图中不存在循环（即不存在路径A→B→...→A）
   - 如果发现循环，必须断开形成循环的边，保留最重要的连接
   - **失败路径也应该正确连接到后续的成功路径**（如"尝试A失败" → "改用B方法成功"）
4. **层次清晰**：攻击链应该呈现清晰的层次结构：目标 → 信息收集（包括失败的尝试） → 漏洞发现 → 漏洞利用 → 后续行动

## ⚠️ 重要原则 - 严禁杜撰

**严格禁止编造或推测任何内容！** 你必须：
1. **只使用实际发生的信息**：仅基于ReAct输入中实际执行的工具调用和实际返回的结果
2. **不要推测**：如果没有实际执行工具或发现漏洞，不要编造
3. **不要假设**：不能仅根据URL、目标名称等推断漏洞类型
4. **基于事实**：每个节点和边都必须有实际依据，来自工具执行结果或模型的实际输出

如果ReAct输入中没有实际的工具执行记录，或者模型输出中明确表示任务未完成/被取消，必须返回空的攻击链（空的nodes和edges数组）。

## 最后一轮ReAct的输入（历史对话上下文）
%s

## 大模型最后的输出
%s

## 任务要求

### 1. 节点类型（简化，只保留3种）

**target（目标）**：从用户输入中提取测试目标（IP、域名、URL等）
- **重要：如果对话中测试了多个不同的目标（如先测试A网页，后测试B网页），必须：**
  - 为每个不同的目标创建独立的target节点
  - 每个target节点只关联属于它的action和vulnerability节点
  - 不同目标的节点之间**不应该**建立任何关联关系
  - 这样会形成多个独立的攻击链分支，每个分支对应一个测试目标

**action（行动）**：**工具执行 + AI分析结果 = 一个action节点**
- 将每个工具执行和AI对该工具结果的分析合并为一个action节点
- **节点标签必须简洁**：控制在15-25个汉字，使用动宾结构，描述"做了什么"和"发现了什么"
  - 成功示例："扫描端口发现22/80/443"、"验证SQL注入成功"、"WAF拦截暴露厂商"
  - **失败示例（必须保留）**："尝试SQL注入（被WAF拦截）"、"端口扫描（连接超时）"、"SQLMap扫描（工具未安装）"、"目录枚举（权限不足）"
  - 避免冗长描述，关键信息放在metadata中详细说明
- **⚠️ 失败路径处理规则**：
  - **必须创建节点**：如果工具执行失败但提供了任何线索、错误信息或指引，必须创建action节点
  - **标记失败状态**：在metadata.status中标记为"failed_insight"，并在findings中详细说明失败原因和获得的线索
  - **说明线索价值**：在ai_analysis中明确说明"为什么这个失败很重要"、"提供了什么信息"、"如何指引了后续行动"
  - **连接后续节点**：失败路径应该连接到后续的成功路径，展示"失败 → 调整策略 → 成功"的完整过程
- **重要：action节点必须关联到正确的target节点（通过工具执行参数判断目标）**
- **risk_score**：**action节点没有风险，risk_score必须设置为0**（只有vulnerability节点才有风险等级）

**vulnerability（漏洞）**：从工具执行结果和AI分析中提取的**真实漏洞**（不是所有发现都是漏洞）
- 若验证失败但能明确表明某个漏洞利用方向不可行，可作为行动节点的线索描述，而不是漏洞节点
- **risk_score**：反映实际发现的漏洞的风险等级（高危80-100，中危60-80，低危40-60）

### 2. 简化结构

- 只创建target、action、vulnerability三种节点
- 不要创建discovery、decision等节点
- 让攻击链清晰、有教育意义

### 3. 过滤规则（重要！）

**必须忽略的失败执行（可以删除）：**
- 完全没有输出、没有任何错误信息的失败
- 纯粹的系统错误（如"内存不足"、"磁盘满"等），且与测试目标无关
- 重复的、完全相同的失败尝试（只保留第一次）

**必须保留的失败执行（必须创建节点）：**
- **工具执行失败但提供了线索**：如错误信息、超时、拒绝连接、权限错误等
- **漏洞验证失败但指明了方向**：如"SQL注入尝试失败，但暴露了数据库类型"、"XSS被WAF拦截，但暴露了WAF规则"
- **扫描失败但揭示了防护**：如"端口扫描被防火墙拦截"、"目录枚举被限制"、"暴力破解被锁定"
- **配置或环境问题**：如"工具未安装"、"目标不可达"、"证书验证失败"等，这些可能揭示系统配置问题
- **AI明确分析的失败尝试**：如果AI在对话中明确提到"尝试了X但失败了，因为Y"，必须记录

**判断标准：**
- 如果失败提供了**任何**有助于理解系统、调整策略或学习的信息，就必须保留
- 如果失败揭示了**任何**关于目标系统、防护机制或环境配置的信息，就必须保留
- 如果失败指引了**后续的成功尝试**，就必须保留并建立连接关系
- **宁可多保留一些失败路径，也不要遗漏有价值的线索**

**只保留对学习或溯源有帮助的节点**：包括成功路径和重要的失败路径

### 4. 关联关系（确保DAG结构）

- target → action：目标指向属于它的所有行动（通过工具执行参数判断目标）
- action → action：按时间顺序连接，但只连接有逻辑关系的
  - **重要：只连接属于同一目标的action节点，不同目标的action节点之间不应该连接**
  - **必须确保无环**：只能从早期步骤指向后期步骤，不能形成循环
  - 优先连接直接相关的步骤，避免过度连接
- action → vulnerability：行动发现的漏洞
- vulnerability → vulnerability：漏洞间的因果关系
  - **重要：只连接属于同一目标的漏洞，不同目标的漏洞之间不应该连接**
  - **必须确保无环**：漏洞间的因果关系也必须是单向的

### 5. 节点属性

每个节点需要：id, type, label, risk_score, metadata

**重要：risk_score规则**
- **target节点**：可以设置适当的risk_score（如40），表示目标本身的风险
- **action节点**：**必须设置为0**，因为行动本身没有风险，只有漏洞才有风险
- **vulnerability节点**：必须根据漏洞严重程度设置risk_score（高危80-100，中危60-80，低危40-60）

**action节点metadata必须包含：**
- tool_name: 工具名称（必须与ReAct中的tool_calls一致）
- tool_intent: 工具调用意图（如"端口扫描"、"漏洞扫描"、"目录枚举"等）
- ai_analysis: AI对工具结果的分析总结（不超过150字）
  - **成功节点**：总结关键发现和结果
  - **失败节点**：**必须详细说明**：①失败的具体原因 ②获得了什么线索或信息 ③这些线索如何指引了后续行动 ④为什么这个失败很重要
- findings: 关键发现列表（数组）
  - 成功节点：如["发现80端口开放", "检测到WAF"]
  - **失败节点**：必须包含失败原因和获得的线索，如["WAF拦截SQL注入尝试", "返回403错误", "目标部署了Web应用防火墙"]
- status: 
  - 成功节点：可以不设置或设置为"success"
  - **失败节点：必须标记为"failed_insight"**，表示失败但提供了有价值的线索

**target节点metadata必须包含：**
- target: 测试目标（URL、IP、域名等）

**vulnerability节点metadata必须包含：**
- vulnerability_type: 漏洞类型
- description: 实际发现的漏洞描述（必须与模型输出中明确提及的漏洞一致）
- severity: 严重程度（"critical"|"high"|"medium"|"low"）
- location: 漏洞位置

## 输出格式

请以JSON格式返回攻击链，严格按照以下格式：

{
   "nodes": [
     {
       "id": "node_1",
       "type": "target",
       "label": "测试目标: example.com",
       "risk_score": 40,
       "metadata": {
         "target": "example.com"
       }
     },
     {
       "id": "node_2",
       "type": "action",
       "label": "扫描端口发现80/443",
       "risk_score": 0,
       "metadata": {
         "tool_name": "nmap",
         "tool_intent": "端口扫描",
         "ai_analysis": "使用nmap扫描发现80和443端口开放，目标运行标准Web服务",
         "findings": ["80端口开放", "443端口开放"]
       }
     },
     {
       "id": "node_3",
       "type": "action",
       "label": "SQLMap扫描（工具未安装）",
       "risk_score": 0,
       "metadata": {
         "tool_name": "sqlmap",
         "tool_intent": "SQL注入测试",
         "ai_analysis": "sqlmap工具未安装，无法进行SQL注入测试。这个失败揭示了测试环境的工具配置情况，需要先安装工具才能继续测试。",
         "findings": ["工具未安装，需要先安装sqlmap工具", "环境配置限制：缺少SQL注入测试工具"],
         "status": "failed_insight"
       }
     },
     {
       "id": "node_5",
       "type": "action",
       "label": "尝试SQL注入（被WAF拦截）",
       "risk_score": 0,
       "metadata": {
         "tool_name": "manual_test",
         "tool_intent": "SQL注入验证",
         "ai_analysis": "尝试SQL注入攻击时被WAF拦截，返回403错误。这个失败提供了重要线索：目标部署了WAF防护，且WAF规则较为严格。后续可以尝试绕过WAF或寻找其他攻击面。",
         "findings": ["WAF拦截SQL注入尝试", "返回403错误", "目标部署了Web应用防火墙"],
         "status": "failed_insight"
       }
     },
     {
       "id": "node_6",
       "type": "action",
       "label": "端口扫描（连接超时）",
       "risk_score": 0,
       "metadata": {
         "tool_name": "nmap",
         "tool_intent": "端口扫描",
         "ai_analysis": "对目标进行端口扫描时，多个端口连接超时。这个失败表明目标可能部署了防火墙或IDS，对扫描行为进行了检测和拦截。超时信息有助于了解目标的防护策略。",
         "findings": ["多个端口连接超时", "可能部署了防火墙或IDS", "目标对扫描行为有防护"],
         "status": "failed_insight"
       }
     },
     {
       "id": "node_4",
       "type": "vulnerability",
       "label": "SQL注入漏洞",
       "risk_score": 85,
       "metadata": {
         "vulnerability_type": "SQL注入",
         "description": "在/admin/login.php发现SQL注入漏洞",
         "severity": "high",
         "location": "/admin/login.php"
       }
     }
   ],
   "edges": [
     {
       "source": "node_1",
       "target": "node_2",
       "type": "leads_to",
       "weight": 3
     },
     {
       "source": "node_2",
       "target": "node_4",
       "type": "discovers",
       "weight": 5
     }
   ]
 }

**关键要求：**
- 节点id必须从"node_1"开始，按顺序递增（node_1, node_2, node_3, ...）
- 所有边的source节点id必须小于target节点id（确保DAG无环）
- target节点必须是node_1（如果是多目标，第一个target是node_1，第二个target是node_2，以此类推）
- 节点之间必须形成清晰的路径，不能有孤立节点
- 如果有vulnerability节点，必须展示从target到vulnerability的完整路径
- 边的类型只能是：leads_to、discovers、enables

**再次强调：如果没有实际数据，返回空的nodes和edges数组。严禁杜撰！**

## ⚠️ 关于失败路径的最后提醒

**请特别注意：在生成攻击链时，不要只关注成功的路径，也要仔细检查ReAct输入中的所有失败尝试。**

**检查清单（在生成节点前，请逐一检查）：**
1. ✅ 是否所有工具执行失败都被检查过了？
2. ✅ 每个失败是否提供了线索、错误信息或指引？
3. ✅ 失败路径是否连接到了后续的成功路径？
4. ✅ 失败节点的metadata是否详细说明了线索价值？
5. ✅ 是否因为节点数量限制而误删了重要的失败路径？

**记住：一个完整的攻击链应该展示真实的渗透测试过程，包括成功和重要的失败尝试。失败路径不是噪音，而是宝贵的经验和学习材料！**

只返回JSON，不要包含其他解释文字。`, reactInput, modelOutput)
}

// saveChain 保存攻击链到数据库
func (b *Builder) saveChain(conversationID string, nodes []Node, edges []Edge) error {
	// 先删除旧的攻击链数据
	if err := b.db.DeleteAttackChain(conversationID); err != nil {
		b.logger.Warn("删除旧攻击链失败", zap.Error(err))
	}

	for _, node := range nodes {
		metadataJSON, _ := json.Marshal(node.Metadata)
		if err := b.db.SaveAttackChainNode(conversationID, node.ID, node.Type, node.Label, "", string(metadataJSON), node.RiskScore); err != nil {
			b.logger.Warn("保存攻击链节点失败", zap.String("nodeId", node.ID), zap.Error(err))
		}
	}

	// 保存边
	for _, edge := range edges {
		if err := b.db.SaveAttackChainEdge(conversationID, edge.ID, edge.Source, edge.Target, edge.Type, edge.Weight); err != nil {
			b.logger.Warn("保存攻击链边失败", zap.String("edgeId", edge.ID), zap.Error(err))
		}
	}

	return nil
}

// LoadChainFromDatabase 从数据库加载攻击链
func (b *Builder) LoadChainFromDatabase(conversationID string) (*Chain, error) {
	nodes, err := b.db.LoadAttackChainNodes(conversationID)
	if err != nil {
		return nil, fmt.Errorf("加载攻击链节点失败: %w", err)
	}

	edges, err := b.db.LoadAttackChainEdges(conversationID)
	if err != nil {
		return nil, fmt.Errorf("加载攻击链边失败: %w", err)
	}

	return &Chain{
		Nodes: nodes,
		Edges: edges,
	}, nil
}

// callAIForChainGeneration 调用AI生成攻击链
func (b *Builder) callAIForChainGeneration(ctx context.Context, prompt string) (string, error) {
	requestBody := map[string]interface{}{
		"model": b.openAIConfig.Model,
		"messages": []map[string]interface{}{
			{
				"role":    "system",
				"content": "你是一个专业的安全测试分析师，擅长构建攻击链图。请严格按照JSON格式返回攻击链数据。",
			},
			{
				"role":    "user",
				"content": prompt,
			},
		},
		"temperature": 0.3,
		"max_tokens":  8000,
	}

	var apiResponse struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if b.openAIClient == nil {
		return "", fmt.Errorf("OpenAI客户端未初始化")
	}
	if err := b.openAIClient.ChatCompletion(ctx, requestBody, &apiResponse); err != nil {
		var apiErr *openai.APIError
		if errors.As(err, &apiErr) {
			bodyStr := strings.ToLower(apiErr.Body)
			if strings.Contains(bodyStr, "context") || strings.Contains(bodyStr, "length") || strings.Contains(bodyStr, "too long") {
				return "", fmt.Errorf("context length exceeded")
			}
		} else if strings.Contains(strings.ToLower(err.Error()), "context") || strings.Contains(strings.ToLower(err.Error()), "length") {
			return "", fmt.Errorf("context length exceeded")
		}
		return "", fmt.Errorf("请求失败: %w", err)
	}

	if len(apiResponse.Choices) == 0 {
		return "", fmt.Errorf("API未返回有效响应")
	}

	content := strings.TrimSpace(apiResponse.Choices[0].Message.Content)
	// 尝试提取JSON（可能包含markdown代码块）
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)

	return content, nil
}

// ChainJSON 攻击链JSON结构
type ChainJSON struct {
	Nodes []struct {
		ID        string                 `json:"id"`
		Type      string                 `json:"type"`
		Label     string                 `json:"label"`
		RiskScore int                    `json:"risk_score"`
		Metadata  map[string]interface{} `json:"metadata"`
	} `json:"nodes"`
	Edges []struct {
		Source string `json:"source"`
		Target string `json:"target"`
		Type   string `json:"type"`
		Weight int    `json:"weight"`
	} `json:"edges"`
}

// parseChainJSON 解析攻击链JSON
func (b *Builder) parseChainJSON(chainJSON string) (*Chain, error) {
	var chainData ChainJSON
	if err := json.Unmarshal([]byte(chainJSON), &chainData); err != nil {
		return nil, fmt.Errorf("解析JSON失败: %w", err)
	}

	// 创建节点ID映射（AI返回的ID -> 新的UUID）
	nodeIDMap := make(map[string]string)

	// 转换为Chain结构
	nodes := make([]Node, 0, len(chainData.Nodes))
	for _, n := range chainData.Nodes {
		// 生成新的UUID节点ID
		newNodeID := fmt.Sprintf("node_%s", uuid.New().String())
		nodeIDMap[n.ID] = newNodeID

		node := Node{
			ID:        newNodeID,
			Type:      n.Type,
			Label:     n.Label,
			RiskScore: n.RiskScore,
			Metadata:  n.Metadata,
		}
		if node.Metadata == nil {
			node.Metadata = make(map[string]interface{})
		}
		nodes = append(nodes, node)
	}

	// 转换边
	edges := make([]Edge, 0, len(chainData.Edges))
	for _, e := range chainData.Edges {
		sourceID, ok := nodeIDMap[e.Source]
		if !ok {
			continue
		}
		targetID, ok := nodeIDMap[e.Target]
		if !ok {
			continue
		}

		// 生成边的ID（前端需要）
		edgeID := fmt.Sprintf("edge_%s", uuid.New().String())

		edges = append(edges, Edge{
			ID:     edgeID,
			Source: sourceID,
			Target: targetID,
			Type:   e.Type,
			Weight: e.Weight,
		})
	}

	return &Chain{
		Nodes: nodes,
		Edges: edges,
	}, nil
}

// 以下所有方法已不再使用，已删除以简化代码
