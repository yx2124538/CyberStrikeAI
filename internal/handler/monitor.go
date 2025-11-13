package handler

import (
	"net/http"
	"time"

	"cyberstrike-ai/internal/database"
	"cyberstrike-ai/internal/mcp"
	"cyberstrike-ai/internal/security"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// MonitorHandler 监控处理器
type MonitorHandler struct {
	mcpServer *mcp.Server
	executor  *security.Executor
	db        *database.DB
	logger    *zap.Logger
}

// NewMonitorHandler 创建新的监控处理器
func NewMonitorHandler(mcpServer *mcp.Server, executor *security.Executor, db *database.DB, logger *zap.Logger) *MonitorHandler {
	return &MonitorHandler{
		mcpServer: mcpServer,
		executor:  executor,
		db:        db,
		logger:    logger,
	}
}

// MonitorResponse 监控响应
type MonitorResponse struct {
	Executions []*mcp.ToolExecution      `json:"executions"`
	Stats      map[string]*mcp.ToolStats `json:"stats"`
	Timestamp  time.Time                  `json:"timestamp"`
}

// Monitor 获取监控信息
func (h *MonitorHandler) Monitor(c *gin.Context) {
	executions := h.loadExecutions()
	stats := h.loadStats()

	c.JSON(http.StatusOK, MonitorResponse{
		Executions: executions,
		Stats:      stats,
		Timestamp:  time.Now(),
	})
}

func (h *MonitorHandler) loadExecutions() []*mcp.ToolExecution {
	if h.db == nil {
		return h.mcpServer.GetAllExecutions()
	}

	executions, err := h.db.LoadToolExecutions()
	if err != nil {
		h.logger.Warn("从数据库加载执行记录失败，回退到内存数据", zap.Error(err))
		return h.mcpServer.GetAllExecutions()
	}
	return executions
}

func (h *MonitorHandler) loadStats() map[string]*mcp.ToolStats {
	if h.db == nil {
		return h.mcpServer.GetStats()
	}

	stats, err := h.db.LoadToolStats()
	if err != nil {
		h.logger.Warn("从数据库加载统计信息失败，回退到内存数据", zap.Error(err))
		return h.mcpServer.GetStats()
	}
	return stats
}


// GetExecution 获取特定执行记录
func (h *MonitorHandler) GetExecution(c *gin.Context) {
	id := c.Param("id")

	exec, exists := h.mcpServer.GetExecution(id)
	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "执行记录未找到"})
		return
	}

	c.JSON(http.StatusOK, exec)
}

// GetStats 获取统计信息
func (h *MonitorHandler) GetStats(c *gin.Context) {
	stats := h.loadStats()
	c.JSON(http.StatusOK, stats)
}

