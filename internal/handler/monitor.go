package handler

import (
	"net/http"
	"strconv"
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
	Total      int                        `json:"total,omitempty"`
	Page       int                        `json:"page,omitempty"`
	PageSize   int                        `json:"page_size,omitempty"`
	TotalPages int                        `json:"total_pages,omitempty"`
}

// Monitor 获取监控信息
func (h *MonitorHandler) Monitor(c *gin.Context) {
	// 解析分页参数
	page := 1
	pageSize := 20
	if pageStr := c.Query("page"); pageStr != "" {
		if p, err := strconv.Atoi(pageStr); err == nil && p > 0 {
			page = p
		}
	}
	if pageSizeStr := c.Query("page_size"); pageSizeStr != "" {
		if ps, err := strconv.Atoi(pageSizeStr); err == nil && ps > 0 && ps <= 100 {
			pageSize = ps
		}
	}

	executions, total := h.loadExecutionsWithPagination(page, pageSize)
	stats := h.loadStats()

	totalPages := (total + pageSize - 1) / pageSize
	if totalPages == 0 {
		totalPages = 1
	}

	c.JSON(http.StatusOK, MonitorResponse{
		Executions: executions,
		Stats:      stats,
		Timestamp:  time.Now(),
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
		TotalPages: totalPages,
	})
}

func (h *MonitorHandler) loadExecutions() []*mcp.ToolExecution {
	executions, _ := h.loadExecutionsWithPagination(1, 1000)
	return executions
}

func (h *MonitorHandler) loadExecutionsWithPagination(page, pageSize int) ([]*mcp.ToolExecution, int) {
	if h.db == nil {
		allExecutions := h.mcpServer.GetAllExecutions()
		total := len(allExecutions)
		offset := (page - 1) * pageSize
		end := offset + pageSize
		if end > total {
			end = total
		}
		if offset >= total {
			return []*mcp.ToolExecution{}, total
		}
		return allExecutions[offset:end], total
	}

	offset := (page - 1) * pageSize
	executions, err := h.db.LoadToolExecutionsWithPagination(offset, pageSize)
	if err != nil {
		h.logger.Warn("从数据库加载执行记录失败，回退到内存数据", zap.Error(err))
		allExecutions := h.mcpServer.GetAllExecutions()
		total := len(allExecutions)
		offset := (page - 1) * pageSize
		end := offset + pageSize
		if end > total {
			end = total
		}
		if offset >= total {
			return []*mcp.ToolExecution{}, total
		}
		return allExecutions[offset:end], total
	}

	// 获取总数
	total, err := h.db.CountToolExecutions()
	if err != nil {
		h.logger.Warn("获取执行记录总数失败", zap.Error(err))
		// 回退：使用已加载的记录数估算
		total = offset + len(executions)
		if len(executions) == pageSize {
			total = offset + len(executions) + 1
		}
	}

	return executions, total
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

