package handler

import (
	"net/http"

	"cyberstrike-ai/internal/database"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// GroupHandler 分组处理器
type GroupHandler struct {
	db     *database.DB
	logger *zap.Logger
}

// NewGroupHandler 创建新的分组处理器
func NewGroupHandler(db *database.DB, logger *zap.Logger) *GroupHandler {
	return &GroupHandler{
		db:     db,
		logger: logger,
	}
}

// CreateGroupRequest 创建分组请求
type CreateGroupRequest struct {
	Name string `json:"name"`
	Icon string `json:"icon"`
}

// CreateGroup 创建分组
func (h *GroupHandler) CreateGroup(c *gin.Context) {
	var req CreateGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "分组名称不能为空"})
		return
	}

	group, err := h.db.CreateGroup(req.Name, req.Icon)
	if err != nil {
		h.logger.Error("创建分组失败", zap.Error(err))
		// 如果是名称重复错误，返回400状态码
		if err.Error() == "分组名称已存在" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "分组名称已存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, group)
}

// ListGroups 列出所有分组
func (h *GroupHandler) ListGroups(c *gin.Context) {
	groups, err := h.db.ListGroups()
	if err != nil {
		h.logger.Error("获取分组列表失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, groups)
}

// GetGroup 获取分组
func (h *GroupHandler) GetGroup(c *gin.Context) {
	id := c.Param("id")

	group, err := h.db.GetGroup(id)
	if err != nil {
		h.logger.Error("获取分组失败", zap.Error(err))
		c.JSON(http.StatusNotFound, gin.H{"error": "分组不存在"})
		return
	}

	c.JSON(http.StatusOK, group)
}

// UpdateGroupRequest 更新分组请求
type UpdateGroupRequest struct {
	Name string `json:"name"`
	Icon string `json:"icon"`
}

// UpdateGroup 更新分组
func (h *GroupHandler) UpdateGroup(c *gin.Context) {
	id := c.Param("id")

	var req UpdateGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "分组名称不能为空"})
		return
	}

	if err := h.db.UpdateGroup(id, req.Name, req.Icon); err != nil {
		h.logger.Error("更新分组失败", zap.Error(err))
		// 如果是名称重复错误，返回400状态码
		if err.Error() == "分组名称已存在" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "分组名称已存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	group, err := h.db.GetGroup(id)
	if err != nil {
		h.logger.Error("获取更新后的分组失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, group)
}

// DeleteGroup 删除分组
func (h *GroupHandler) DeleteGroup(c *gin.Context) {
	id := c.Param("id")

	if err := h.db.DeleteGroup(id); err != nil {
		h.logger.Error("删除分组失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "删除成功"})
}

// AddConversationToGroupRequest 添加对话到分组请求
type AddConversationToGroupRequest struct {
	ConversationID string `json:"conversationId"`
	GroupID        string `json:"groupId"`
}

// AddConversationToGroup 将对话添加到分组
func (h *GroupHandler) AddConversationToGroup(c *gin.Context) {
	var req AddConversationToGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.AddConversationToGroup(req.ConversationID, req.GroupID); err != nil {
		h.logger.Error("添加对话到分组失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "添加成功"})
}

// RemoveConversationFromGroup 从分组中移除对话
func (h *GroupHandler) RemoveConversationFromGroup(c *gin.Context) {
	conversationID := c.Param("conversationId")
	groupID := c.Param("id")

	if err := h.db.RemoveConversationFromGroup(conversationID, groupID); err != nil {
		h.logger.Error("从分组中移除对话失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "移除成功"})
}

// GetGroupConversations 获取分组中的所有对话
func (h *GroupHandler) GetGroupConversations(c *gin.Context) {
	groupID := c.Param("id")

	conversations, err := h.db.GetConversationsByGroup(groupID)
	if err != nil {
		h.logger.Error("获取分组对话失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, conversations)
}

// UpdateConversationPinnedRequest 更新对话置顶状态请求
type UpdateConversationPinnedRequest struct {
	Pinned bool `json:"pinned"`
}

// UpdateConversationPinned 更新对话置顶状态
func (h *GroupHandler) UpdateConversationPinned(c *gin.Context) {
	conversationID := c.Param("id")

	var req UpdateConversationPinnedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.UpdateConversationPinned(conversationID, req.Pinned); err != nil {
		h.logger.Error("更新对话置顶状态失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "更新成功"})
}

// UpdateGroupPinnedRequest 更新分组置顶状态请求
type UpdateGroupPinnedRequest struct {
	Pinned bool `json:"pinned"`
}

// UpdateGroupPinned 更新分组置顶状态
func (h *GroupHandler) UpdateGroupPinned(c *gin.Context) {
	groupID := c.Param("id")

	var req UpdateGroupPinnedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.db.UpdateGroupPinned(groupID, req.Pinned); err != nil {
		h.logger.Error("更新分组置顶状态失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "更新成功"})
}
