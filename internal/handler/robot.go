package handler

import (
	"context"
	"crypto/aes"
	"errors"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"cyberstrike-ai/internal/config"
	"cyberstrike-ai/internal/database"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const (
	robotCmdHelp     = "帮助"
	robotCmdList     = "列表"
	robotCmdListAlt  = "对话列表"
	robotCmdSwitch   = "切换"
	robotCmdContinue = "继续"
	robotCmdNew      = "新对话"
	robotCmdClear    = "清空"
	robotCmdCurrent  = "当前"
	robotCmdStop     = "停止"
)

// RobotHandler 企业微信/钉钉/飞书等机器人回调处理
type RobotHandler struct {
	config         *config.Config
	db             *database.DB
	agentHandler   *AgentHandler
	logger         *zap.Logger
	mu             sync.RWMutex
	sessions       map[string]string             // key: "platform_userID", value: conversationID
	cancelMu       sync.Mutex                    // 保护 runningCancels
	runningCancels map[string]context.CancelFunc // key: "platform_userID", 用于停止命令中断任务
}

// NewRobotHandler 创建机器人处理器
func NewRobotHandler(cfg *config.Config, db *database.DB, agentHandler *AgentHandler, logger *zap.Logger) *RobotHandler {
	return &RobotHandler{
		config:         cfg,
		db:             db,
		agentHandler:   agentHandler,
		logger:         logger,
		sessions:       make(map[string]string),
		runningCancels: make(map[string]context.CancelFunc),
	}
}

// sessionKey 生成会话 key
func (h *RobotHandler) sessionKey(platform, userID string) string {
	return platform + "_" + userID
}

// getOrCreateConversation 获取或创建当前会话，title 用于新对话的标题（取用户首条消息前50字）
func (h *RobotHandler) getOrCreateConversation(platform, userID, title string) (convID string, isNew bool) {
	h.mu.RLock()
	convID = h.sessions[h.sessionKey(platform, userID)]
	h.mu.RUnlock()
	if convID != "" {
		return convID, false
	}
	t := strings.TrimSpace(title)
	if t == "" {
		t = "新对话 " + time.Now().Format("01-02 15:04")
	} else {
		t = safeTruncateString(t, 25)
	}
	conv, err := h.db.CreateConversation(t)
	if err != nil {
		h.logger.Warn("创建机器人会话失败", zap.Error(err))
		return "", false
	}
	convID = conv.ID
	h.mu.Lock()
	h.sessions[h.sessionKey(platform, userID)] = convID
	h.mu.Unlock()
	return convID, true
}

// setConversation 切换当前会话
func (h *RobotHandler) setConversation(platform, userID, convID string) {
	h.mu.Lock()
	h.sessions[h.sessionKey(platform, userID)] = convID
	h.mu.Unlock()
}

// clearConversation 清空当前会话（切换到新对话）
func (h *RobotHandler) clearConversation(platform, userID string) (newConvID string) {
	title := "新对话 " + time.Now().Format("01-02 15:04")
	conv, err := h.db.CreateConversation(title)
	if err != nil {
		h.logger.Warn("创建新对话失败", zap.Error(err))
		return ""
	}
	h.setConversation(platform, userID, conv.ID)
	return conv.ID
}

// HandleMessage 处理用户输入，返回回复文本（供各平台 webhook 调用）
func (h *RobotHandler) HandleMessage(platform, userID, text string) (reply string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "请输入内容或发送「帮助」查看命令。"
	}

	// 命令分发
	switch {
	case text == robotCmdHelp || text == "help" || text == "？" || text == "?":
		return h.cmdHelp()
	case text == robotCmdList || text == robotCmdListAlt:
		return h.cmdList(userID)
	case strings.HasPrefix(text, robotCmdSwitch+" ") || strings.HasPrefix(text, robotCmdContinue+" "):
		var id string
		if strings.HasPrefix(text, robotCmdSwitch+" ") {
			id = strings.TrimSpace(text[len(robotCmdSwitch)+1:])
		} else {
			id = strings.TrimSpace(text[len(robotCmdContinue)+1:])
		}
		return h.cmdSwitch(platform, userID, id)
	case text == robotCmdNew:
		return h.cmdNew(platform, userID)
	case text == robotCmdClear:
		return h.cmdClear(platform, userID)
	case text == robotCmdCurrent:
		return h.cmdCurrent(platform, userID)
	case text == robotCmdStop || text == "stop":
		return h.cmdStop(platform, userID)
	}

	// 普通消息：走 Agent
	convID, _ := h.getOrCreateConversation(platform, userID, text)
	if convID == "" {
		return "无法创建或获取对话，请稍后再试。"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	sk := h.sessionKey(platform, userID)
	h.cancelMu.Lock()
	h.runningCancels[sk] = cancel
	h.cancelMu.Unlock()
	defer func() {
		cancel()
		h.cancelMu.Lock()
		delete(h.runningCancels, sk)
		h.cancelMu.Unlock()
	}()
	resp, newConvID, err := h.agentHandler.ProcessMessageForRobot(ctx, convID, text, "默认")
	if err != nil {
		h.logger.Warn("机器人 Agent 执行失败", zap.String("platform", platform), zap.String("userID", userID), zap.Error(err))
		if errors.Is(err, context.Canceled) {
			return "任务已取消。"
		}
		return "处理失败: " + err.Error()
	}
	if newConvID != convID {
		h.setConversation(platform, userID, newConvID)
	}
	return resp
}

func (h *RobotHandler) cmdHelp() string {
	return `【CyberStrikeAI 机器人命令】
· 帮助 — 显示本帮助
· 列表 / 对话列表 — 列出所有对话标题与 ID
· 切换 <对话ID> / 继续 <对话ID> — 指定对话继续
· 新对话 — 开启新对话
· 清空 — 清空当前上下文（等同于新对话）
· 当前 — 显示当前对话 ID 与标题
· 停止 — 中断当前正在执行的任务
除以上命令外，直接输入内容将发送给 AI 进行渗透测试/安全分析。`
}

func (h *RobotHandler) cmdList(userID string) string {
	convs, err := h.db.ListConversations(50, 0, "")
	if err != nil {
		return "获取对话列表失败: " + err.Error()
	}
	if len(convs) == 0 {
		return "暂无对话。发送任意内容将自动创建新对话。"
	}
	var b strings.Builder
	b.WriteString("【对话列表】\n")
	for i, c := range convs {
		if i >= 20 {
			b.WriteString("… 仅显示前 20 条\n")
			break
		}
		b.WriteString(fmt.Sprintf("· %s\n  ID: %s\n", c.Title, c.ID))
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func (h *RobotHandler) cmdSwitch(platform, userID, convID string) string {
	if convID == "" {
		return "请指定对话 ID，例如：切换 xxx-xxx-xxx"
	}
	conv, err := h.db.GetConversation(convID)
	if err != nil {
		return "对话不存在或 ID 错误。"
	}
	h.setConversation(platform, userID, conv.ID)
	return fmt.Sprintf("已切换到对话：「%s」\nID: %s", conv.Title, conv.ID)
}

func (h *RobotHandler) cmdNew(platform, userID string) string {
	newID := h.clearConversation(platform, userID)
	if newID == "" {
		return "创建新对话失败，请重试。"
	}
	return "已开启新对话，可直接发送内容。"
}

func (h *RobotHandler) cmdClear(platform, userID string) string {
	return h.cmdNew(platform, userID)
}

func (h *RobotHandler) cmdStop(platform, userID string) string {
	sk := h.sessionKey(platform, userID)
	h.cancelMu.Lock()
	cancel, ok := h.runningCancels[sk]
	if ok {
		delete(h.runningCancels, sk)
		cancel()
	}
	h.cancelMu.Unlock()
	if !ok {
		return "当前没有正在执行的任务。"
	}
	return "已停止当前任务。"
}

func (h *RobotHandler) cmdCurrent(platform, userID string) string {
	h.mu.RLock()
	convID := h.sessions[h.sessionKey(platform, userID)]
	h.mu.RUnlock()
	if convID == "" {
		return "当前没有进行中的对话。发送任意内容将创建新对话。"
	}
	conv, err := h.db.GetConversation(convID)
	if err != nil {
		return "当前对话 ID: " + convID + "（获取标题失败）"
	}
	return fmt.Sprintf("当前对话：「%s」\nID: %s", conv.Title, conv.ID)
}

// —————— 企业微信 ——————

// wecomXML 企业微信回调 XML（明文模式下的简化结构；加密模式需先解密再解析）
type wecomXML struct {
	ToUserName   string `xml:"ToUserName"`
	FromUserName string `xml:"FromUserName"`
	CreateTime   int64  `xml:"CreateTime"`
	MsgType      string `xml:"MsgType"`
	Content      string `xml:"Content"`
	MsgID        string `xml:"MsgId"`
	AgentID      int64  `xml:"AgentID"`
	Encrypt      string `xml:"Encrypt"` // 加密模式下消息在此
}

// wecomReplyXML 被动回复 XML
type wecomReplyXML struct {
	XMLName      xml.Name `xml:"xml"`
	ToUserName   string   `xml:"ToUserName"`
	FromUserName string  `xml:"FromUserName"`
	CreateTime   int64   `xml:"CreateTime"`
	MsgType      string  `xml:"MsgType"`
	Content      string  `xml:"Content"`
}

// HandleWecomGET 企业微信 URL 校验（GET）
func (h *RobotHandler) HandleWecomGET(c *gin.Context) {
	if !h.config.Robots.Wecom.Enabled {
		c.String(http.StatusNotFound, "")
		return
	}
	echostr := c.Query("echostr")
	if echostr == "" {
		c.String(http.StatusBadRequest, "missing echostr")
		return
	}
	// 明文模式时企业微信可能直接传 echostr，先直接返回以通过校验
	c.String(http.StatusOK, echostr)
}

// wecomDecrypt 企业微信消息解密（AES-256-CBC，PKCS7，明文格式：16字节随机+4字节长度+消息+corpID）
func wecomDecrypt(encodingAESKey, encryptedB64 string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(encodingAESKey + "=")
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("encoding_aes_key 解码后应为 32 字节")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encryptedB64)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	iv := key[:16]
	mode := cipher.NewCBCDecrypter(block, iv)
	if len(ciphertext)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("密文长度不是块大小的倍数")
	}
	plain := make([]byte, len(ciphertext))
	mode.CryptBlocks(plain, ciphertext)
	// 去除 PKCS7 填充
	n := int(plain[len(plain)-1])
	if n < 1 || n > 32 {
		return nil, fmt.Errorf("无效的 PKCS7 填充")
	}
	plain = plain[:len(plain)-n]
	// 企业微信格式：16 字节随机 + 4 字节长度(大端) + 消息 + corpID
	if len(plain) < 20 {
		return nil, fmt.Errorf("明文过短")
	}
	msgLen := binary.BigEndian.Uint32(plain[16:20])
	if int(20+msgLen) > len(plain) {
		return nil, fmt.Errorf("消息长度越界")
	}
	return plain[20 : 20+msgLen], nil
}

// HandleWecomPOST 企业微信消息回调（POST），支持明文与加密模式
func (h *RobotHandler) HandleWecomPOST(c *gin.Context) {
	if !h.config.Robots.Wecom.Enabled {
		c.String(http.StatusOK, "")
		return
	}
	bodyRaw, _ := io.ReadAll(c.Request.Body)
	var body wecomXML
	if err := xml.Unmarshal(bodyRaw, &body); err != nil {
		h.logger.Debug("企业微信 POST 解析 XML 失败", zap.Error(err))
		c.String(http.StatusOK, "")
		return
	}
	// 加密模式：先解密再解析内层 XML
	if body.Encrypt != "" && h.config.Robots.Wecom.EncodingAESKey != "" {
		decrypted, err := wecomDecrypt(h.config.Robots.Wecom.EncodingAESKey, body.Encrypt)
		if err != nil {
			h.logger.Warn("企业微信消息解密失败", zap.Error(err))
			c.String(http.StatusOK, "")
			return
		}
		if err := xml.Unmarshal(decrypted, &body); err != nil {
			h.logger.Warn("企业微信解密后 XML 解析失败", zap.Error(err))
			c.String(http.StatusOK, "")
			return
		}
	}
	if body.MsgType != "text" {
		c.XML(http.StatusOK, wecomReplyXML{
			ToUserName:   body.FromUserName,
			FromUserName: body.ToUserName,
			CreateTime:  time.Now().Unix(),
			MsgType:     "text",
			Content:     "暂仅支持文本消息，请发送文字。",
		})
		return
	}
	userID := body.FromUserName
	text := strings.TrimSpace(body.Content)
	reply := h.HandleMessage("wecom", userID, text)
	// 加密模式需加密回复（此处简化为明文回复；若企业要求加密需再实现加密）
	c.XML(http.StatusOK, wecomReplyXML{
		ToUserName:   body.FromUserName,
		FromUserName: body.ToUserName,
		CreateTime:  time.Now().Unix(),
		MsgType:     "text",
		Content:     reply,
	})
}

// —————— 测试接口（需登录，用于验证机器人逻辑，无需钉钉/飞书客户端） ——————

// RobotTestRequest 模拟机器人消息请求
type RobotTestRequest struct {
	Platform string `json:"platform"` // 如 "dingtalk"、"lark"、"wecom"
	UserID   string `json:"user_id"`
	Text     string `json:"text"`
}

// HandleRobotTest 供本地验证：POST JSON { "platform", "user_id", "text" }，返回 { "reply": "..." }
func (h *RobotHandler) HandleRobotTest(c *gin.Context) {
	var req RobotTestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需为 JSON，包含 platform、user_id、text"})
		return
	}
	platform := strings.TrimSpace(req.Platform)
	if platform == "" {
		platform = "test"
	}
	userID := strings.TrimSpace(req.UserID)
	if userID == "" {
		userID = "test_user"
	}
	reply := h.HandleMessage(platform, userID, req.Text)
	c.JSON(http.StatusOK, gin.H{"reply": reply})
}

// —————— 钉钉 ——————

// HandleDingtalkPOST 钉钉事件回调（流式接入等）；当前为占位，返回 200
func (h *RobotHandler) HandleDingtalkPOST(c *gin.Context) {
	if !h.config.Robots.Dingtalk.Enabled {
		c.JSON(http.StatusOK, gin.H{})
		return
	}
	// 钉钉流式/事件回调格式需按官方文档解析并异步回复，此处仅返回 200
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// —————— 飞书 ——————

// HandleLarkPOST 飞书事件回调；当前为占位，返回 200；验证时需返回 challenge
func (h *RobotHandler) HandleLarkPOST(c *gin.Context) {
	if !h.config.Robots.Lark.Enabled {
		c.JSON(http.StatusOK, gin.H{})
		return
	}
	var body struct {
		Challenge string `json:"challenge"`
	}
	if err := c.ShouldBindJSON(&body); err == nil && body.Challenge != "" {
		c.JSON(http.StatusOK, gin.H{"challenge": body.Challenge})
		return
	}
	c.JSON(http.StatusOK, gin.H{})
}
