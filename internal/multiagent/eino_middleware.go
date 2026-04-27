package multiagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"cyberstrike-ai/internal/config"

	localbk "github.com/cloudwego/eino-ext/adk/backend/local"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/middlewares/dynamictool/toolsearch"
	"github.com/cloudwego/eino/adk/middlewares/patchtoolcalls"
	"github.com/cloudwego/eino/adk/middlewares/plantask"
	"github.com/cloudwego/eino/adk/middlewares/reduction"
	"github.com/cloudwego/eino/components/tool"
	"go.uber.org/zap"
)

// einoMWPlacement controls which optional middleware runs on orchestrator vs sub-agents.
type einoMWPlacement int

const (
	einoMWMain einoMWPlacement = iota // Deep / Supervisor main chat agent
	einoMWSub                         // Specialist ChatModelAgent
)

func sanitizeEinoPathSegment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "default"
	}
	s = strings.ReplaceAll(s, string(filepath.Separator), "-")
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, "\\", "-")
	s = strings.ReplaceAll(s, "..", "__")
	if len(s) > 180 {
		s = s[:180]
	}
	return s
}

// localPlantaskBackend wraps the eino-ext local backend with plantask.Delete (Local has no Delete).
type localPlantaskBackend struct {
	*localbk.Local
}

func (l *localPlantaskBackend) Delete(ctx context.Context, req *plantask.DeleteRequest) error {
	if l == nil || l.Local == nil || req == nil {
		return nil
	}
	p := strings.TrimSpace(req.FilePath)
	if p == "" {
		return nil
	}
	return os.Remove(p)
}

func splitToolsForToolSearch(all []tool.BaseTool, alwaysVisible int) (static []tool.BaseTool, dynamic []tool.BaseTool, ok bool) {
	if alwaysVisible <= 0 || len(all) <= alwaysVisible+1 {
		return all, nil, false
	}
	return append([]tool.BaseTool(nil), all[:alwaysVisible]...), append([]tool.BaseTool(nil), all[alwaysVisible:]...), true
}

func buildReductionMiddleware(ctx context.Context, mw config.MultiAgentEinoMiddlewareConfig, convID string, loc *localbk.Local, logger *zap.Logger) (adk.ChatModelAgentMiddleware, error) {
	if loc == nil {
		return nil, fmt.Errorf("reduction: local backend nil")
	}
	root := strings.TrimSpace(mw.ReductionRootDir)
	if root == "" {
		root = filepath.Join(os.TempDir(), "cyberstrike-reduction", sanitizeEinoPathSegment(convID))
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("reduction root: %w", err)
	}
	excl := append([]string(nil), mw.ReductionClearExclude...)
	defaultExcl := []string{
		"task", "transfer_to_agent", "exit", "write_todos", "skill", "tool_search",
		"TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
	}
	excl = append(excl, defaultExcl...)
	redMW, err := reduction.New(ctx, &reduction.Config{
		Backend:           loc,
		RootDir:           root,
		ReadFileToolName:  "read_file",
		ClearExcludeTools: excl,
	})
	if err != nil {
		return nil, err
	}
	if logger != nil {
		logger.Info("eino middleware: reduction enabled", zap.String("root", root))
	}
	return redMW, nil
}

// prependEinoMiddlewares returns handlers to prepend (outermost first) and optionally replaces tools when tool_search is used.
func prependEinoMiddlewares(
	ctx context.Context,
	mw *config.MultiAgentEinoMiddlewareConfig,
	place einoMWPlacement,
	tools []tool.BaseTool,
	einoLoc *localbk.Local,
	skillsRoot string,
	conversationID string,
	logger *zap.Logger,
) (outTools []tool.BaseTool, extraHandlers []adk.ChatModelAgentMiddleware, err error) {
	if mw == nil {
		return tools, nil, nil
	}
	outTools = tools

	if mw.PatchToolCallsEffective() {
		patchMW, perr := patchtoolcalls.New(ctx, &patchtoolcalls.Config{})
		if perr != nil {
			return nil, nil, fmt.Errorf("patchtoolcalls: %w", perr)
		}
		extraHandlers = append(extraHandlers, patchMW)
	}

	if mw.ReductionEnable && einoLoc != nil {
		if place == einoMWSub && !mw.ReductionSubAgents {
			// skip
		} else {
			redMW, rerr := buildReductionMiddleware(ctx, *mw, conversationID, einoLoc, logger)
			if rerr != nil {
				return nil, nil, rerr
			}
			extraHandlers = append(extraHandlers, redMW)
		}
	}

	minTools := mw.ToolSearchMinTools
	if minTools <= 0 {
		minTools = 20
	}
	alwaysVis := mw.ToolSearchAlwaysVisible
	if alwaysVis <= 0 {
		alwaysVis = 12
	}
	if mw.ToolSearchEnable && len(tools) >= minTools {
		static, dynamic, split := splitToolsForToolSearch(tools, alwaysVis)
		if split && len(dynamic) > 0 {
			ts, terr := toolsearch.New(ctx, &toolsearch.Config{DynamicTools: dynamic})
			if terr != nil {
				return nil, nil, fmt.Errorf("toolsearch: %w", terr)
			}
			extraHandlers = append(extraHandlers, ts)
			outTools = static
			if logger != nil {
				logger.Info("eino middleware: tool_search enabled",
					zap.Int("static_tools", len(static)),
					zap.Int("dynamic_tools", len(dynamic)))
			}
		}
	}

	if place == einoMWMain && mw.PlantaskEnable {
		if einoLoc == nil || strings.TrimSpace(skillsRoot) == "" {
			if logger != nil {
				logger.Warn("eino middleware: plantask_enable ignored (need eino_skills + skills_dir)")
			}
		} else {
			rel := strings.TrimSpace(mw.PlantaskRelDir)
			if rel == "" {
				rel = ".eino/plantask"
			}
			baseDir := filepath.Join(skillsRoot, rel, sanitizeEinoPathSegment(conversationID))
			if mk := os.MkdirAll(baseDir, 0o755); mk != nil {
				return nil, nil, fmt.Errorf("plantask mkdir: %w", mk)
			}
			ptBE := &localPlantaskBackend{Local: einoLoc}
			pt, perr := plantask.New(ctx, &plantask.Config{Backend: ptBE, BaseDir: baseDir})
			if perr != nil {
				return nil, nil, fmt.Errorf("plantask: %w", perr)
			}
			extraHandlers = append(extraHandlers, pt)
			if logger != nil {
				logger.Info("eino middleware: plantask enabled", zap.String("baseDir", baseDir))
			}
		}
	}

	return outTools, extraHandlers, nil
}

func deepExtrasFromConfig(ma *config.MultiAgentConfig) (outputKey string, retry *adk.ModelRetryConfig, taskDesc func(context.Context, []adk.Agent) (string, error)) {
	if ma == nil {
		return "", nil, nil
	}
	mw := ma.EinoMiddleware
	if k := strings.TrimSpace(mw.DeepOutputKey); k != "" {
		outputKey = k
	}
	if mw.DeepModelRetryMaxRetries > 0 {
		retry = &adk.ModelRetryConfig{MaxRetries: mw.DeepModelRetryMaxRetries}
	}
	prefix := strings.TrimSpace(mw.TaskToolDescriptionPrefix)
	if prefix != "" {
		taskDesc = func(ctx context.Context, agents []adk.Agent) (string, error) {
			_ = ctx
			var names []string
			for _, a := range agents {
				if a == nil {
					continue
				}
				n := strings.TrimSpace(a.Name(ctx))
				if n != "" {
					names = append(names, n)
				}
			}
			if len(names) == 0 {
				return prefix, nil
			}
			return prefix + "\n可用子代理（按名称 transfer / task 调用）：" + strings.Join(names, "、"), nil
		}
	}
	return outputKey, retry, taskDesc
}
