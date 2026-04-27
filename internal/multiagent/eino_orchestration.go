package multiagent

import (
	"context"
	"fmt"
	"strings"

	"cyberstrike-ai/internal/config"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/prebuilt/planexecute"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
	"go.uber.org/zap"
)

// PlanExecuteRootArgs 构建 Eino adk/prebuilt/planexecute 根 Agent 所需参数。
type PlanExecuteRootArgs struct {
	MainToolCallingModel *openai.ChatModel
	ExecModel            *openai.ChatModel
	OrchInstruction      string
	ToolsCfg             adk.ToolsConfig
	ExecMaxIter          int
	LoopMaxIter          int
	// AppCfg / Logger 非空时为 Executor 挂载与 Deep/Supervisor 一致的 Eino summarization 中间件。
	AppCfg *config.Config
	Logger *zap.Logger
	// ExecPreMiddlewares 是由 prependEinoMiddlewares 构建的前置中间件（patchtoolcalls, reduction, toolsearch, plantask），
	// 与 Deep/Supervisor 主代理的 mainOrchestratorPre 一致。
	ExecPreMiddlewares []adk.ChatModelAgentMiddleware
	// SkillMiddleware 是 Eino 官方 skill 渐进式披露中间件（可选）。
	SkillMiddleware adk.ChatModelAgentMiddleware
	// FilesystemMiddleware 是 Eino filesystem 中间件，当 eino_skills.filesystem_tools 启用时提供本机文件读写与 Shell 能力（可选）。
	FilesystemMiddleware adk.ChatModelAgentMiddleware
}

// NewPlanExecuteRoot 返回 plan → execute → replan 预置编排根节点（与 Deep / Supervisor 并列）。
func NewPlanExecuteRoot(ctx context.Context, a *PlanExecuteRootArgs) (adk.ResumableAgent, error) {
	if a == nil {
		return nil, fmt.Errorf("plan_execute: args 为空")
	}
	if a.MainToolCallingModel == nil || a.ExecModel == nil {
		return nil, fmt.Errorf("plan_execute: 模型为空")
	}
	tcm, ok := interface{}(a.MainToolCallingModel).(model.ToolCallingChatModel)
	if !ok {
		return nil, fmt.Errorf("plan_execute: 主模型需实现 ToolCallingChatModel")
	}
	plannerCfg := &planexecute.PlannerConfig{
		ToolCallingChatModel: tcm,
	}
	if fn := planExecutePlannerGenInput(a.OrchInstruction); fn != nil {
		plannerCfg.GenInputFn = fn
	}
	planner, err := planexecute.NewPlanner(ctx, plannerCfg)
	if err != nil {
		return nil, fmt.Errorf("plan_execute planner: %w", err)
	}
	replanner, err := planexecute.NewReplanner(ctx, &planexecute.ReplannerConfig{
		ChatModel:  tcm,
		GenInputFn: planExecuteReplannerGenInput(a.OrchInstruction),
	})
	if err != nil {
		return nil, fmt.Errorf("plan_execute replanner: %w", err)
	}

	// 组装 executor handler 栈，顺序与 Deep/Supervisor 主代理一致（outermost first）。
	var execHandlers []adk.ChatModelAgentMiddleware
	// 1. patchtoolcalls, reduction, toolsearch, plantask（来自 prependEinoMiddlewares）
	if len(a.ExecPreMiddlewares) > 0 {
		execHandlers = append(execHandlers, a.ExecPreMiddlewares...)
	}
	// 2. filesystem 中间件（可选）
	if a.FilesystemMiddleware != nil {
		execHandlers = append(execHandlers, a.FilesystemMiddleware)
	}
	// 3. skill 中间件（可选）
	if a.SkillMiddleware != nil {
		execHandlers = append(execHandlers, a.SkillMiddleware)
	}
	// 4. summarization（最后，与 Deep/Supervisor 一致）
	if a.AppCfg != nil {
		sumMw, sumErr := newEinoSummarizationMiddleware(ctx, a.ExecModel, a.AppCfg, a.Logger)
		if sumErr != nil {
			return nil, fmt.Errorf("plan_execute executor summarization: %w", sumErr)
		}
		execHandlers = append(execHandlers, sumMw)
	}
	executor, err := newPlanExecuteExecutor(ctx, &planexecute.ExecutorConfig{
		Model:         a.ExecModel,
		ToolsConfig:   a.ToolsCfg,
		MaxIterations: a.ExecMaxIter,
		GenInputFn:    planExecuteExecutorGenInput(a.OrchInstruction),
	}, execHandlers)
	if err != nil {
		return nil, fmt.Errorf("plan_execute executor: %w", err)
	}
	loopMax := a.LoopMaxIter
	if loopMax <= 0 {
		loopMax = 10
	}
	return planexecute.New(ctx, &planexecute.Config{
		Planner:       planner,
		Executor:      executor,
		Replanner:     replanner,
		MaxIterations: loopMax,
	})
}

// planExecutePlannerGenInput 将 orchestrator instruction 作为 SystemMessage 注入 planner 输入。
// 返回 nil 时 Eino 使用内置默认 planner prompt。
func planExecutePlannerGenInput(orchInstruction string) planexecute.GenPlannerModelInputFn {
	oi := strings.TrimSpace(orchInstruction)
	if oi == "" {
		return nil
	}
	return func(ctx context.Context, userInput []adk.Message) ([]adk.Message, error) {
		msgs := make([]adk.Message, 0, 1+len(userInput))
		msgs = append(msgs, schema.SystemMessage(oi))
		msgs = append(msgs, userInput...)
		return msgs, nil
	}
}

func planExecuteExecutorGenInput(orchInstruction string) planexecute.GenModelInputFn {
	oi := strings.TrimSpace(orchInstruction)
	return func(ctx context.Context, in *planexecute.ExecutionContext) ([]adk.Message, error) {
		planContent, err := in.Plan.MarshalJSON()
		if err != nil {
			return nil, err
		}
		userMsgs, err := planexecute.ExecutorPrompt.Format(ctx, map[string]any{
			"input":          planExecuteFormatInput(in.UserInput),
			"plan":           string(planContent),
			"executed_steps": planExecuteFormatExecutedSteps(in.ExecutedSteps),
			"step":           in.Plan.FirstStep(),
		})
		if err != nil {
			return nil, err
		}
		if oi != "" {
			userMsgs = append([]adk.Message{schema.SystemMessage(oi)}, userMsgs...)
		}
		return userMsgs, nil
	}
}

func planExecuteFormatInput(input []adk.Message) string {
	var sb strings.Builder
	for _, msg := range input {
		sb.WriteString(msg.Content)
		sb.WriteString("\n")
	}
	return sb.String()
}

func planExecuteFormatExecutedSteps(results []planexecute.ExecutedStep) string {
	capped := capPlanExecuteExecutedSteps(results)
	var sb strings.Builder
	for _, result := range capped {
		sb.WriteString(fmt.Sprintf("Step: %s\nResult: %s\n\n", result.Step, result.Result))
	}
	return sb.String()
}

// planExecuteReplannerGenInput 与 Eino 默认 Replanner 输入一致，但 executed_steps 经 cap 后再写入 prompt，
// 且在 orchInstruction 非空时 prepend SystemMessage 使 replanner 也能接收全局指令。
func planExecuteReplannerGenInput(orchInstruction string) planexecute.GenModelInputFn {
	oi := strings.TrimSpace(orchInstruction)
	return func(ctx context.Context, in *planexecute.ExecutionContext) ([]adk.Message, error) {
		planContent, err := in.Plan.MarshalJSON()
		if err != nil {
			return nil, err
		}
		msgs, err := planexecute.ReplannerPrompt.Format(ctx, map[string]any{
			"plan":           string(planContent),
			"input":          planExecuteFormatInput(in.UserInput),
			"executed_steps": planExecuteFormatExecutedSteps(in.ExecutedSteps),
			"plan_tool":      planexecute.PlanToolInfo.Name,
			"respond_tool":   planexecute.RespondToolInfo.Name,
		})
		if err != nil {
			return nil, err
		}
		if oi != "" {
			msgs = append([]adk.Message{schema.SystemMessage(oi)}, msgs...)
		}
		return msgs, nil
	}
}

// planExecuteStreamsMainAssistant 将规划/执行/重规划各阶段助手流式输出映射到主对话区。
func planExecuteStreamsMainAssistant(agent string) bool {
	if agent == "" {
		return true
	}
	switch agent {
	case "planner", "executor", "replanner", "execute_replan", "plan_execute_replan":
		return true
	default:
		return false
	}
}

func planExecuteEinoRoleTag(agent string) string {
	_ = agent
	return "orchestrator"
}
