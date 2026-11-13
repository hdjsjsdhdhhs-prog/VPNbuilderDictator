package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/interfaces"
)

// OpsTelegramSender delivers operational notifications to Telegram.
//
// Without a token the message goes through the main bot. With a token of a
// separate notification bot (Admin -> "События" -> settings) it is sent with a
// direct Bot API call, so the alert channel does not depend on the main bot's
// rate limits. The token is never part of an error or a log line.
type OpsTelegramSender struct {
	mu     sync.RWMutex
	bot    interfaces.BotAPI
	client *http.Client
	// apiBase is the Bot API origin (overridden in tests).
	apiBase string
}

// NewOpsTelegramSender creates a sender; SetBot wires the main bot later.
func NewOpsTelegramSender(bot interfaces.BotAPI) *OpsTelegramSender {
	return &OpsTelegramSender{bot: bot, client: &http.Client{Timeout: 15 * time.Second}, apiBase: "https://api.telegram.org"}
}

// SetBot replaces the main bot client (after the bot is initialized).
func (s *OpsTelegramSender) SetBot(bot interfaces.BotAPI) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bot = bot
}

// SendOps implements OpsSender.
func (s *OpsTelegramSender) SendOps(ctx context.Context, botToken string, chatID int64, html string) error {
	if chatID == 0 {
		return ErrOpsNotConfigured
	}
	if botToken == "" {
		s.mu.RLock()
		bot := s.bot
		s.mu.RUnlock()
		if bot == nil {
			return ErrOpsNotConfigured
		}
		msg := tgbotapi.NewMessage(chatID, html)
		msg.ParseMode = tgbotapi.ModeHTML
		msg.DisableWebPagePreview = true
		_, err := bot.Send(msg)
		if err != nil {
			return fmt.Errorf("telegram send: %w", err)
		}
		return nil
	}
	return s.sendDirect(ctx, botToken, chatID, html)
}

func (s *OpsTelegramSender) sendDirect(ctx context.Context, token string, chatID int64, html string) error {
	body, err := json.Marshal(map[string]any{
		"chat_id": chatID, "text": html, "parse_mode": "HTML", "disable_web_page_preview": true,
	})
	if err != nil {
		return fmt.Errorf("encode telegram request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiBase+"/bot"+token+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return errors.New("build telegram request failed")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		// The transport error quotes the request URL, which contains the token.
		return fmt.Errorf("telegram request failed: %s", strings.ReplaceAll(err.Error(), token, "***"))
	}
	defer func() { _ = resp.Body.Close() }()
	var reply struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	_ = json.Unmarshal(raw, &reply)
	if resp.StatusCode != http.StatusOK || !reply.OK {
		description := strings.ReplaceAll(reply.Description, token, "***")
		if description == "" {
			description = "no description"
		}
		return fmt.Errorf("telegram answered %d: %s", resp.StatusCode, description)
	}
	return nil
}
