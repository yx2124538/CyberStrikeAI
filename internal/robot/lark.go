package robot

import (
	"context"
	"encoding/json"
	"strings"

	"cyberstrike-ai/internal/config"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
	"go.uber.org/zap"
)

type larkTextContent struct {
	Text string `json:"text"`
}

// StartLark 启动飞书长连接（无需公网），收到消息后调用 handler 并回复。
// ctx 被取消时长连接会退出，便于配置变更时重启。
func StartLark(ctx context.Context, cfg config.RobotLarkConfig, h MessageHandler, logger *zap.Logger) {
	if !cfg.Enabled || cfg.AppID == "" || cfg.AppSecret == "" {
		return
	}
	larkClient := lark.NewClient(cfg.AppID, cfg.AppSecret)
	eventHandler := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
		go handleLarkMessage(ctx, event, h, larkClient, logger)
		return nil
	})
	wsClient := larkws.NewClient(cfg.AppID, cfg.AppSecret,
		larkws.WithEventHandler(eventHandler),
		larkws.WithLogLevel(larkcore.LogLevelInfo),
	)
	go func() {
		err := wsClient.Start(ctx)
		if err != nil && ctx.Err() == nil {
			logger.Error("飞书长连接退出", zap.Error(err))
		} else if ctx.Err() != nil {
			logger.Info("飞书长连接已按配置重启关闭")
		}
	}()
	logger.Info("飞书长连接已启动（无需公网）", zap.String("app_id", cfg.AppID))
}

func handleLarkMessage(ctx context.Context, event *larkim.P2MessageReceiveV1, h MessageHandler, client *lark.Client, logger *zap.Logger) {
	if event == nil || event.Event == nil || event.Event.Message == nil || event.Event.Sender == nil || event.Event.Sender.SenderId == nil {
		return
	}
	msg := event.Event.Message
	msgType := larkcore.StringValue(msg.MessageType)
	if msgType != larkim.MsgTypeText {
		logger.Debug("飞书暂仅处理文本消息", zap.String("msg_type", msgType))
		return
	}
	var textBody larkTextContent
	if err := json.Unmarshal([]byte(larkcore.StringValue(msg.Content)), &textBody); err != nil {
		logger.Warn("飞书消息 Content 解析失败", zap.Error(err))
		return
	}
	text := strings.TrimSpace(textBody.Text)
	if text == "" {
		return
	}
	userID := ""
	if event.Event.Sender.SenderId.UserId != nil {
		userID = *event.Event.Sender.SenderId.UserId
	}
	messageID := larkcore.StringValue(msg.MessageId)
	reply := h.HandleMessage("lark", userID, text)
	contentBytes, _ := json.Marshal(larkTextContent{Text: reply})
	_, err := client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().
		MessageId(messageID).
		Body(larkim.NewReplyMessageReqBodyBuilder().
			MsgType(larkim.MsgTypeText).
			Content(string(contentBytes)).
			Build()).
		Build())
	if err != nil {
		logger.Warn("飞书回复失败", zap.String("message_id", messageID), zap.Error(err))
		return
	}
	logger.Debug("飞书已回复", zap.String("message_id", messageID))
}
