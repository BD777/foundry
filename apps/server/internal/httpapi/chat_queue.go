package httpapi

import (
	"cmp"
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Chat queues: messages a person sends while a chat's session is still
// answering wait on the server, in an order the person controls, and the
// server sends each as the chat's next input once the session is idle. A
// browser only shows and edits the queue, so it keeps going with every tab
// closed, and every tab shows the same one.

// chatQueueConflict is a refused queue change with the queue as it is now.
type chatQueueConflict struct {
	Error string          `json:"error"`
	Code  string          `json:"code"`
	Queue store.ChatQueue `json:"queue"`
}

// chatQueueChat resolves the chat a queue route names: a Foundry chat
// session (by its thread id) or a device's native chat. Changing the queue
// takes control of the chat: the session's starter or a maintainer; a
// native chat belongs to the workspace's members (the route rule).
func (s *Server) chatQueueChat(w http.ResponseWriter, r *http.Request, change bool) (string, string, bool) {
	chatID := strings.TrimSpace(r.PathValue("id"))
	session, err := s.store.GetAgentSessionSummary(r.Context(), chatID)
	if err == nil {
		if session.Role != "" || (session.Source != "" && session.Source != "chat") {
			writeError(w, http.StatusNotFound, "not a chat")
			return "", "", false
		}
		if change && !s.canControlSession(r.Context(), actorFromContext(r.Context()), session) {
			writeForbidden(w, "you cannot change the queue of this chat")
			return "", "", false
		}
		threadID := session.ThreadID
		if threadID == "" {
			threadID = session.ID
		}
		return session.WorkspaceID, threadID, true
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeResult(w, nil, err)
		return "", "", false
	}
	chat, err := s.store.GetChat(r.Context(), chatID)
	if err != nil {
		writeResult(w, nil, err)
		return "", "", false
	}
	return chat.WorkspaceID, chat.ID, true
}

// writeChatQueueResult answers a queue change: the queue after it, or the
// refusal with the queue as it is.
func (s *Server) writeChatQueueResult(w http.ResponseWriter, r *http.Request, workspaceID, chatID string, queue store.ChatQueue, err error, status int) {
	if err == nil {
		s.chats.queueChanged(queue)
		writeJSON(w, status, queue)
		return
	}
	code := ""
	switch {
	case errors.Is(err, store.ErrChatQueueItemSent), errors.Is(err, store.ErrSessionInputExists):
		code, err = "already_sent", store.ErrChatQueueItemSent
	case errors.Is(err, store.ErrChatQueueItemSending), errors.Is(err, store.ErrChatQueueBusy):
		code, err = "sending", store.ErrChatQueueItemSending
	case errors.Is(err, store.ErrChatQueueConflict), errors.Is(err, store.ErrChatQueuePaused):
		code = "changed"
	case errors.Is(err, store.ErrInvalidChatQueueMessage):
		writeError(w, http.StatusBadRequest, err.Error())
		return
	default:
		writeResult(w, nil, err)
		return
	}
	current, readErr := s.store.ChatQueue(r.Context(), workspaceID, chatID)
	if readErr != nil {
		writeResult(w, nil, readErr)
		return
	}
	writeJSON(w, http.StatusConflict, chatQueueConflict{Error: err.Error(), Code: code, Queue: current})
}

func (s *Server) handleGetChatQueue(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, false)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	queue, err := s.store.ChatQueue(r.Context(), workspaceID, chatID)
	writeResult(w, queue, err)
}

func (s *Server) handleEnqueueChatMessage(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	var input store.EnqueueChatMessageInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	idempotent, handled := s.beginIdempotentRequest(w, r, "chat-queue/enqueue:"+chatID, input, http.StatusCreated)
	if handled {
		return
	}
	defer idempotent.release()
	queue, err := s.store.EnqueueChatMessage(r.Context(), workspaceID, chatID, actorFromContext(r.Context()).AccountID(), input)
	if err == nil {
		idempotent.record(r.Context(), queue)
	}
	s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusCreated)
	if err == nil {
		s.kickChatQueue(workspaceID, chatID)
	}
}

func (s *Server) handleEditChatQueueItem(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	var input store.EditChatQueueItemInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.ExpectedRevision == nil {
		writeError(w, http.StatusBadRequest, "expectedRevision is required")
		return
	}
	queue, err := s.store.EditChatQueueItem(r.Context(), workspaceID, chatID, r.PathValue("itemId"), input)
	s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
}

func (s *Server) handleDeleteChatQueueItem(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	queue, err := s.store.DeleteChatQueueItem(r.Context(), workspaceID, chatID, r.PathValue("itemId"))
	s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
	if err == nil {
		// A failed message no longer holds the queue.
		s.kickChatQueue(workspaceID, chatID)
	}
}

func (s *Server) handleReorderChatQueue(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	var input store.ReorderChatQueueInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.ExpectedRevision == nil {
		writeError(w, http.StatusBadRequest, "expectedRevision is required")
		return
	}
	queue, err := s.store.ReorderChatQueue(r.Context(), workspaceID, chatID, input)
	s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
	if err == nil {
		s.kickChatQueue(workspaceID, chatID)
	}
}

func (s *Server) handleRetryChatQueueItem(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	queue, err := s.store.RetryChatQueueItem(r.Context(), workspaceID, chatID, r.PathValue("itemId"))
	s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
	if err == nil {
		s.kickChatQueue(workspaceID, chatID)
	}
}

// handleSteerChatQueueItem moves a queued message into an active native turn.
func (s *Server) handleSteerChatQueueItem(w http.ResponseWriter, r *http.Request) {
	workspaceID, chatID, ok := s.chatQueueChat(w, r, true)
	if !ok {
		return
	}
	session, found, active, err := s.store.ChatQueueSession(r.Context(), workspaceID, chatID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !found || !active {
		writeError(w, http.StatusConflict, "nothing is running in this chat to steer into")
		return
	}
	connection := s.hub.connectionFor(session.DeviceID)
	if session.Provider != "claude" && (session.Provider != "codex" || connection == nil || !connection.hasCapability("codex_active_steer")) {
		writeError(w, http.StatusConflict, "this device does not support steering this runtime; send the message when the turn ends")
		return
	}
	item, queue, err := s.store.ClaimChatQueueItem(r.Context(), workspaceID, chatID, r.PathValue("itemId"), false)
	if err != nil {
		s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
		return
	}
	s.chats.queueChanged(queue)
	// The claim is settled whatever becomes of the person's request.
	settleCtx := context.WithoutCancel(r.Context())
	// Already in a session's transcript (a steer its device applied after
	// its answer came too late): sent, not steered a second time.
	if recordedBy, recorded, err := s.store.ChatQueueInputSession(settleCtx, item.ID); err == nil && recorded {
		queue, err = s.store.SettleChatQueueItem(settleCtx, item.ID, store.ChatQueueStateSent, recordedBy, "")
		s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
		return
	}
	_, steerErr := s.sendSessionMessage(r.Context(), session.ID, store.SendAgentSessionInput{
		Prompt: item.Text, Attachments: item.Attachments, InputID: item.ID,
	})
	if steerErr == nil {
		queue, err = s.store.SettleChatQueueItem(settleCtx, item.ID, store.ChatQueueStateSent, session.ID, "")
		s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
		return
	}
	var settled store.ChatQueue
	var unanswered *deviceNoAnswerError
	if errors.As(steerErr, &unanswered) {
		// The device was handed the steer and its answer did not come. Its
		// transcript may already show the message (the event came, the
		// answer is late): then it was steered.
		if recordedBy, recorded, err := s.store.ChatQueueInputSession(settleCtx, item.ID); err == nil && recorded {
			queue, err = s.store.SettleChatQueueItem(settleCtx, item.ID, store.ChatQueueStateSent, recordedBy, "")
			s.writeChatQueueResult(w, r, workspaceID, chatID, queue, err, http.StatusOK)
			return
		}
		// Otherwise it may still apply it. Queued again, the message would
		// also go out as the next turn; it waits for the person instead,
		// marked maybe sent. A worker that knows the steer's id applies it
		// only once, and its transcript event settles the message
		// (onSteerRecorded); an older one leaves the decision to the person.
		settled, err = s.store.SettleChatQueueItemUnconfirmed(settleCtx, item.ID, unanswered.summary())
		// The event may have landed between the check and the settle.
		if recordedBy, recorded, recordErr := s.store.ChatQueueInputSession(settleCtx, item.ID); err == nil && recordErr == nil && recorded {
			if confirmed, confirmedNow, confirmErr := s.store.SettleRecordedChatQueueItem(settleCtx, item.ID, recordedBy); confirmErr == nil && confirmedNow {
				settled = confirmed
			}
		}
	} else {
		// Refused: the message waits in its place again.
		settled, err = s.store.SettleChatQueueItem(settleCtx, item.ID, store.ChatQueueStateQueued, "", "")
	}
	if err == nil {
		s.chats.queueChanged(settled)
	} else {
		log.Printf("settle steered message %s: %v", item.ID, err)
	}
	writeError(w, cmp.Or(errorStatus(steerErr), http.StatusConflict), steerErr.Error())
}

// kickChatQueue sends the chat's next queued message, in the background,
// if its session is idle.
func (s *Server) kickChatQueue(workspaceID, chatID string) {
	if workspaceID == "" || chatID == "" {
		return
	}
	s.chatQueueKicks.Add(1)
	go func() {
		defer s.chatQueueKicks.Done()
		s.dispatchChatQueue(context.Background(), workspaceID, chatID)
	}()
}

// kickPendingChatQueues looks at every chat with queued messages, e.g. once
// a device connects again.
func (s *Server) kickPendingChatQueues(ctx context.Context) {
	refs, err := s.store.PendingChatQueues(ctx)
	if err != nil {
		log.Printf("list pending chat queues: %v", err)
		return
	}
	for _, ref := range refs {
		s.kickChatQueue(ref.WorkspaceID, ref.ChatID)
	}
}

// chatQueueReactions sends a chat's next queued message when its turn ends,
// however it ended, and settles a message a turn took in late.
type chatQueueReactions struct{ s *Server }

func (r chatQueueReactions) sessionChanged(_ context.Context, change sessionChange, session store.AgentSession) {
	if change != sessionCompleted || session.Role != "" || (session.Source != "" && session.Source != "chat") {
		return
	}
	chatID := session.ThreadID
	if chatID == "" {
		chatID = session.ID
	}
	r.s.kickChatQueue(session.WorkspaceID, chatID)
}

func (r chatQueueReactions) sessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	r.s.onSteerRecorded(event)
}

// steeredIntoTurnLabel is the transcript event of a message steered into a
// running turn. A worker given the message's id names it evt_<id>.
const steeredIntoTurnLabel = "Steered into active turn"

// onSteerRecorded settles a queued message whose steer its device applied
// after the server stopped waiting for the answer: the message was marked
// maybe sent (or queued again by a retry) and holds the queue. Its
// transcript event shows it arrived, so it is sent and the queue moves on.
func (s *Server) onSteerRecorded(event store.AgentSessionEvent) {
	if event.Label != steeredIntoTurnLabel || !strings.HasPrefix(event.ID, "evt_") {
		return
	}
	itemID := strings.TrimPrefix(event.ID, "evt_")
	s.chatQueueKicks.Add(1)
	go func() {
		defer s.chatQueueKicks.Done()
		ctx := context.Background()
		queue, settled, err := s.store.SettleRecordedChatQueueItem(ctx, itemID, event.SessionID)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				log.Printf("settle steered message %s: %v", itemID, err)
			}
			return
		}
		if settled {
			s.chats.queueChanged(queue)
			s.kickChatQueue(queue.WorkspaceID, queue.ChatID)
		}
	}()
}

// RecoverChatQueues settles what a stopped server left mid-send, then sends
// what waits. Each message goes out once: one a session recorded is sent.
func (s *Server) RecoverChatQueues(ctx context.Context) {
	recovered, err := s.store.RecoverChatQueueDispatches(ctx)
	if err != nil {
		log.Printf("recover chat queues: %v", err)
	}
	for _, queue := range recovered {
		s.chats.queueChanged(queue)
	}
	s.kickPendingChatQueues(ctx)
}

func (s *Server) lockChatQueues(workspaceID string) func() {
	value, _ := s.chatQueueLocks.LoadOrStore(workspaceID, &sync.Mutex{})
	mutex := value.(*sync.Mutex)
	mutex.Lock()
	return mutex.Unlock
}

// dispatchChatQueue sends the chat's next message once its session is idle.
// Dispatches of one workspace run one at a time (a native chat's queue moves
// to the session that adopts it); the claim itself is transactional.
func (s *Server) dispatchChatQueue(ctx context.Context, workspaceID, chatID string) {
	unlock := s.lockChatQueues(workspaceID)
	defer unlock()
	// A queue changed between reading and claiming is read again.
	for attempt := 0; attempt < 3; attempt++ {
		if !s.dispatchNextChatQueueItem(ctx, workspaceID, chatID) {
			return
		}
	}
}

// dispatchNextChatQueueItem reports whether the queue changed under it.
func (s *Server) dispatchNextChatQueueItem(ctx context.Context, workspaceID, chatID string) bool {
	queue, err := s.store.ChatQueue(ctx, workspaceID, chatID)
	if err != nil || len(queue.Items) == 0 {
		return false
	}
	next := queue.Items[0]
	if next.State != store.ChatQueueStateQueued {
		// Being sent, or failed: the queue waits for the person.
		return false
	}
	session, found, active, err := s.store.ChatQueueSession(ctx, workspaceID, chatID)
	if err != nil || active {
		return false
	}
	if !s.chatQueueDeviceConnected(ctx, workspaceID, session, found, next.RunSettings) {
		// Sent once the device is back.
		return false
	}
	item, claimed, err := s.store.ClaimChatQueueItem(ctx, workspaceID, chatID, next.ID, true)
	if errors.Is(err, store.ErrChatQueueConflict) {
		return true
	}
	if err != nil {
		return false
	}
	s.chats.queueChanged(claimed)
	sent, sendErr := s.sendChatQueueItem(ctx, workspaceID, chatID, session, found, item)
	state, sessionID, message := store.ChatQueueStateSent, sent.ID, ""
	if recordedBy, recorded, err := s.store.ChatQueueInputSession(ctx, item.ID); err == nil && recorded {
		// A session took it, even if its device then could not.
		sessionID = recordedBy
	} else if sendErr == nil {
		state, message = store.ChatQueueStateFailed, "the message was not recorded"
	} else if errors.Is(sendErr, store.ErrAgentSessionActive) || errors.Is(sendErr, ErrLocalDaemonNotConnected) {
		// The session got busy, or its device went away: wait for it.
		state = store.ChatQueueStateQueued
	} else {
		state, message = store.ChatQueueStateFailed, sendErr.Error()
	}
	settled, err := s.store.SettleChatQueueItem(ctx, item.ID, state, sessionID, message)
	if err != nil {
		log.Printf("settle queued message %s as %s: %v", item.ID, state, err)
		return false
	}
	s.chats.queueChanged(settled)
	return false
}

// chatQueueDeviceConnected reports whether the device the message would run
// on is connected. A message that names no agent continues on the session's.
func (s *Server) chatQueueDeviceConnected(ctx context.Context, workspaceID string, session store.AgentSession, found bool, settings store.ChatQueueRunSettings) bool {
	if found && settings.AgentID == "" && settings.ProfileID == "" && settings.Provider == "" {
		return s.hub.HasConnection(session.DeviceID)
	}
	input := store.CreateAgentSessionInput{WorkspaceID: workspaceID, AgentID: settings.AgentID, ProfileID: settings.ProfileID, Provider: settings.Provider}
	if err := s.pickSessionDevice(ctx, &input, false); err != nil {
		// Any other refusal fails the message when it is sent.
		return errorStatus(err) != http.StatusConflict
	}
	return true
}

// sendChatQueueItem sends a message the way the composer sends one: the
// chat's next input, or the first input of a session that adopts a native
// chat. The message's id becomes the input's id.
func (s *Server) sendChatQueueItem(ctx context.Context, workspaceID, chatID string, session store.AgentSession, found bool, item store.ChatQueueItem) (store.AgentSession, error) {
	settings := item.RunSettings
	note := strings.TrimSpace(settings.ProfileTransitionNote)
	if found && (settings.AgentID == "" || settings.AgentID == session.AgentID) &&
		(settings.ProfileID == "" || settings.ProfileID == session.ProfileID) {
		// Written for a switch an earlier message already made.
		note = ""
	}
	if found {
		return s.sendSessionMessage(ctx, session.ID, store.SendAgentSessionInput{
			AgentID: settings.AgentID, Provider: settings.Provider, ProfileID: settings.ProfileID, Model: settings.Model,
			ClaudeEffort: settings.ClaudeEffort, ClaudePermissionMode: settings.ClaudePermissionMode,
			CodexReasoningEffort: settings.CodexReasoningEffort, CodexSandboxMode: settings.CodexSandboxMode,
			CodexApprovalPolicy: settings.CodexApprovalPolicy, CodexSpeed: settings.CodexSpeed,
			Prompt: item.Text, Attachments: item.Attachments, ProfileTransitionNote: note,
			RequireIdle: true, InputID: item.ID,
		})
	}
	return s.startAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: item.CreatedBy, WorkspaceID: workspaceID, ChatID: chatID, Source: "chat",
		AgentID: settings.AgentID, Provider: settings.Provider, ProfileID: settings.ProfileID, Model: settings.Model,
		ClaudeEffort: settings.ClaudeEffort, ClaudePermissionMode: settings.ClaudePermissionMode,
		CodexReasoningEffort: settings.CodexReasoningEffort, CodexSandboxMode: settings.CodexSandboxMode,
		CodexApprovalPolicy: settings.CodexApprovalPolicy, CodexSpeed: settings.CodexSpeed,
		Prompt: item.Text, Attachments: item.Attachments, ProfileTransitionNote: note, InputID: item.ID,
	})
}

// dropChatQueueItemsBy removes what an account queued once it may no longer
// send in the workspace.
func (s *Server) dropChatQueueItemsBy(ctx context.Context, workspaceID, userID string) {
	refs, err := s.store.DeleteChatQueueItemsBy(ctx, workspaceID, userID)
	if err != nil {
		log.Printf("drop queued messages of %s in %s: %v", userID, workspaceID, err)
		return
	}
	for _, ref := range refs {
		s.chats.announceQueue(ctx, ref.WorkspaceID, ref.ChatID)
		s.kickChatQueue(ref.WorkspaceID, ref.ChatID)
	}
}
