package robot

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"cyberstrike-ai/internal/config"

	"github.com/open-dingtalk/dingtalk-stream-sdk-go/chatbot"
	"github.com/open-dingtalk/dingtalk-stream-sdk-go/client"
	dingutils "github.com/open-dingtalk/dingtalk-stream-sdk-go/utils"
	"go.uber.org/zap"
)

// StartDing 启动钉钉 Stream 长连接（无需公网），收到消息后调用 handler 并通过 SessionWebhook 回复。
// ctx 被取消时长连接会退出，便于配置变更时重启。
func StartDing(ctx context.Context, cfg config.RobotDingtalkConfig, h MessageHandler, logger *zap.Logger) {
	if !cfg.Enabled || cfg.ClientID == "" || cfg.ClientSecret == "" {
		return
	}
	streamClient := client.NewStreamClient(
		client.WithAppCredential(client.NewAppCredentialConfig(cfg.ClientID, cfg.ClientSecret)),
		client.WithSubscription(dingutils.SubscriptionTypeKCallback, "/v1.0/im/bot/messages/get",
			chatbot.NewDefaultChatBotFrameHandler(func(ctx context.Context, msg *chatbot.BotCallbackDataModel) ([]byte, error) {
				go handleDingMessage(ctx, msg, h, logger)
				return nil, nil
			}).OnEventReceived),
	)
	logger.Info("钉钉 Stream 正在连接…", zap.String("client_id", cfg.ClientID))
	go func() {
		err := streamClient.Start(ctx)
		if err != nil && ctx.Err() == nil {
			logger.Error("钉钉 Stream 长连接退出", zap.Error(err))
		} else if ctx.Err() != nil {
			logger.Info("钉钉 Stream 已按配置重启关闭")
		}
	}()
	logger.Info("钉钉 Stream 已启动（无需公网），等待收消息", zap.String("client_id", cfg.ClientID))
}

func handleDingMessage(ctx context.Context, msg *chatbot.BotCallbackDataModel, h MessageHandler, logger *zap.Logger) {
	if msg == nil || msg.SessionWebhook == "" {
		return
	}
	content := ""
	if msg.Text.Content != "" {
		content = strings.TrimSpace(msg.Text.Content)
	}
	if content == "" && msg.Msgtype == "richText" {
		if cMap, ok := msg.Content.(map[string]interface{}); ok {
			if rich, ok := cMap["richText"].([]interface{}); ok {
				for _, c := range rich {
					if m, ok := c.(map[string]interface{}); ok {
						if txt, ok := m["text"].(string); ok {
							content = strings.TrimSpace(txt)
							break
						}
					}
				}
			}
		}
	}
	if content == "" {
		logger.Debug("钉钉消息内容为空，已忽略", zap.String("msgtype", msg.Msgtype))
		return
	}
	logger.Info("钉钉收到消息", zap.String("sender", msg.SenderId), zap.String("content", content))
	userID := msg.SenderId
	if userID == "" {
		userID = msg.ConversationId
	}
	reply := h.HandleMessage("dingtalk", userID, content)
	body := map[string]interface{}{
		"msgtype": "text",
		"text":    map[string]string{"content": reply},
	}
	bodyBytes, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, msg.SessionWebhook, bytes.NewReader(bodyBytes))
	if err != nil {
		logger.Warn("钉钉构造回复请求失败", zap.Error(err))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		logger.Warn("钉钉回复请求失败", zap.Error(err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logger.Warn("钉钉回复非 200", zap.Int("status", resp.StatusCode))
		return
	}
	logger.Debug("钉钉回复成功", zap.String("content_preview", reply))
}
