package multiagent

import (
	"context"
	"fmt"
	"strings"

	"cyberstrike-ai/internal/agent"
	"cyberstrike-ai/internal/config"

	"github.com/bytedance/sonic"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/middlewares/summarization"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
	"go.uber.org/zap"
)

// einoSummarizeUserInstruction 与单 Agent MemoryCompressor 目标一致：压缩时保留渗透关键信息。
const einoSummarizeUserInstruction = `在保持所有关键安全测试信息完整的前提下压缩对话历史。

必须保留：已确认漏洞与攻击路径、工具输出中的核心发现、凭证与认证细节、架构与薄弱点、当前进度、失败尝试与死路、策略决策。
保留精确技术细节（URL、路径、参数、Payload、版本号、报错原文可摘要但要点不丢）。
将冗长扫描输出概括为结论；重复发现合并表述。
已枚举资产须保留**可继承的摘要**：主域、关键子域/主机短表（或数量+代表样例）、高价值目标与已识别服务/端口要点，避免后续子代理因「看不见清单」而重复全量枚举。

输出须使后续代理能无缝继续同一授权测试任务。`

// newEinoSummarizationMiddleware 使用 Eino ADK Summarization 中间件（见 https://www.cloudwego.io/zh/docs/eino/core_modules/eino_adk/eino_adk_chatmodelagentmiddleware/middleware_summarization/）。
// 触发阈值与单 Agent MemoryCompressor 一致：当估算 token 超过 openai.max_total_tokens 的 90% 时摘要。
func newEinoSummarizationMiddleware(
	ctx context.Context,
	summaryModel model.BaseChatModel,
	appCfg *config.Config,
	logger *zap.Logger,
) (adk.ChatModelAgentMiddleware, error) {
	if summaryModel == nil || appCfg == nil {
		return nil, fmt.Errorf("multiagent: summarization 需要 model 与配置")
	}
	maxTotal := appCfg.OpenAI.MaxTotalTokens
	if maxTotal <= 0 {
		maxTotal = 120000
	}
	trigger := int(float64(maxTotal) * 0.9)
	if trigger < 4096 {
		trigger = maxTotal
		if trigger < 4096 {
			trigger = 4096
		}
	}
	preserveMax := trigger / 3
	if preserveMax < 2048 {
		preserveMax = 2048
	}

	modelName := strings.TrimSpace(appCfg.OpenAI.Model)
	if modelName == "" {
		modelName = "gpt-4o"
	}
	tokenCounter := einoSummarizationTokenCounter(modelName)
	recentTrailMax := trigger / 4
	if recentTrailMax < 2048 {
		recentTrailMax = 2048
	}
	if recentTrailMax > trigger/2 {
		recentTrailMax = trigger / 2
	}

	mw, err := summarization.New(ctx, &summarization.Config{
		Model: summaryModel,
		Trigger: &summarization.TriggerCondition{
			ContextTokens: trigger,
		},
		TokenCounter:       tokenCounter,
		UserInstruction:    einoSummarizeUserInstruction,
		EmitInternalEvents: false,
		PreserveUserMessages: &summarization.PreserveUserMessages{
			Enabled:   true,
			MaxTokens: preserveMax,
		},
		Finalize: func(ctx context.Context, originalMessages []adk.Message, summary adk.Message) ([]adk.Message, error) {
			return summarizeFinalizeWithRecentAssistantToolTrail(ctx, originalMessages, summary, tokenCounter, recentTrailMax)
		},
		Callback: func(ctx context.Context, before, after adk.ChatModelAgentState) error {
			if logger == nil {
				return nil
			}
			logger.Info("eino summarization 已压缩上下文",
				zap.Int("messages_before", len(before.Messages)),
				zap.Int("messages_after", len(after.Messages)),
				zap.Int("max_total_tokens", maxTotal),
				zap.Int("trigger_context_tokens", trigger),
			)
			return nil
		},
	})
	if err != nil {
		return nil, fmt.Errorf("summarization.New: %w", err)
	}
	return mw, nil
}

// summarizeFinalizeWithRecentAssistantToolTrail 在摘要消息后保留最近 assistant/tool 轨迹，避免压缩后执行链断裂。
func summarizeFinalizeWithRecentAssistantToolTrail(
	ctx context.Context,
	originalMessages []adk.Message,
	summary adk.Message,
	tokenCounter summarization.TokenCounterFunc,
	recentTrailTokenBudget int,
) ([]adk.Message, error) {
	systemMsgs := make([]adk.Message, 0, len(originalMessages))
	nonSystem := make([]adk.Message, 0, len(originalMessages))
	for _, msg := range originalMessages {
		if msg == nil {
			continue
		}
		if msg.Role == schema.System {
			systemMsgs = append(systemMsgs, msg)
			continue
		}
		nonSystem = append(nonSystem, msg)
	}

	if recentTrailTokenBudget <= 0 || len(nonSystem) == 0 {
		out := make([]adk.Message, 0, len(systemMsgs)+1)
		out = append(out, systemMsgs...)
		out = append(out, summary)
		return out, nil
	}

	selectedReverse := make([]adk.Message, 0, 8)
	seen := make(map[adk.Message]struct{})
	totalTokens := 0
	assistantToolKept := 0
	const minAssistantToolTrail = 4

	tryKeep := func(msg adk.Message) (bool, error) {
		if msg == nil {
			return false, nil
		}
		if _, ok := seen[msg]; ok {
			return false, nil
		}
		n, err := tokenCounter(ctx, &summarization.TokenCounterInput{Messages: []adk.Message{msg}})
		if err != nil {
			return false, err
		}
		if n <= 0 {
			n = 1
		}
		if totalTokens+n > recentTrailTokenBudget {
			return false, nil
		}
		totalTokens += n
		selectedReverse = append(selectedReverse, msg)
		seen[msg] = struct{}{}
		return true, nil
	}

	// 优先保留最近 assistant/tool，确保执行轨迹可续跑。
	for i := len(nonSystem) - 1; i >= 0; i-- {
		msg := nonSystem[i]
		if msg.Role != schema.Assistant && msg.Role != schema.Tool {
			continue
		}
		ok, err := tryKeep(msg)
		if err != nil {
			return nil, err
		}
		if ok {
			assistantToolKept++
		}
		if assistantToolKept >= minAssistantToolTrail {
			break
		}
	}

	// 在预算内回填更多最近消息，保持短链路上下文。
	for i := len(nonSystem) - 1; i >= 0; i-- {
		_, exists := seen[nonSystem[i]]
		if exists {
			continue
		}
		ok, err := tryKeep(nonSystem[i])
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
	}

	selected := make([]adk.Message, 0, len(selectedReverse))
	for i := len(selectedReverse) - 1; i >= 0; i-- {
		selected = append(selected, selectedReverse[i])
	}

	out := make([]adk.Message, 0, len(systemMsgs)+1+len(selected))
	out = append(out, systemMsgs...)
	out = append(out, summary)
	out = append(out, selected...)
	return out, nil
}

func einoSummarizationTokenCounter(openAIModel string) summarization.TokenCounterFunc {
	tc := agent.NewTikTokenCounter()
	return func(ctx context.Context, input *summarization.TokenCounterInput) (int, error) {
		var sb strings.Builder
		for _, msg := range input.Messages {
			if msg == nil {
				continue
			}
			sb.WriteString(string(msg.Role))
			sb.WriteByte('\n')
			if msg.Content != "" {
				sb.WriteString(msg.Content)
				sb.WriteByte('\n')
			}
			if msg.ReasoningContent != "" {
				sb.WriteString(msg.ReasoningContent)
				sb.WriteByte('\n')
			}
			if len(msg.ToolCalls) > 0 {
				if b, err := sonic.Marshal(msg.ToolCalls); err == nil {
					sb.Write(b)
					sb.WriteByte('\n')
				}
			}
			for _, part := range msg.UserInputMultiContent {
				if part.Type == schema.ChatMessagePartTypeText && part.Text != "" {
					sb.WriteString(part.Text)
					sb.WriteByte('\n')
				}
			}
		}
		for _, tl := range input.Tools {
			if tl == nil {
				continue
			}
			cp := *tl
			cp.Extra = nil
			if text, err := sonic.MarshalString(cp); err == nil {
				sb.WriteString(text)
				sb.WriteByte('\n')
			}
		}
		text := sb.String()
		n, err := tc.Count(openAIModel, text)
		if err != nil {
			return (len(text) + 3) / 4, nil
		}
		return n, nil
	}
}
