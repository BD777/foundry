package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (c *daemonConnection) handleEnvelope(ctx context.Context, envelope wsEnvelope) error {
	deviceID, _ := c.registrationSnapshot()
	if deviceID == "" && envelope.Type != wsHelloType {
		return errors.New("daemon websocket requires hello before other messages")
	}
	if deviceID != "" && envelope.Type == wsHelloType {
		return errors.New("daemon websocket is already registered")
	}
	if err := c.authorizeTarget(ctx, envelope); err != nil {
		return err
	}
	if envelope.Type == wsReplyChunkType {
		whole, complete, err := c.handleEnvelopePiece(envelope)
		if err != nil || !complete {
			return err
		}
		return c.handleEnvelope(ctx, whole)
	}
	handle, ok := inboundHandlers[envelope.Type]
	if !ok {
		return errors.New("unknown websocket message type: " + envelope.Type)
	}
	return handle(c, ctx, envelope)
}

type inboundHandler func(c *daemonConnection, ctx context.Context, envelope wsEnvelope) error

// inboundHandlers handle what a device sends, by message type: what it tells
// on its own, and its answers to the server's requests.
var inboundHandlers = map[string]inboundHandler{
	wsHelloType:                       (*daemonConnection).onHello,
	wsHeartbeatType:                   (*daemonConnection).onHeartbeat,
	wsReadyForIssueType:               (*daemonConnection).onReadyForIssue,
	wsBackgroundTaskOutputChangedType: (*daemonConnection).backgroundTaskOutputChanged,
	wsIssueEnvironmentChangedType:     (*daemonConnection).issueEnvironmentChanged,
	wsResourcesReportType:             (*daemonConnection).resourcesReported,
	wsWorkspaceFoldersType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return c.workspaceFoldersChanged(envelope)
	},

	// The sessions the device runs (daemon_session_inbound.go).
	wsSessionStartedType:         (*daemonConnection).onSessionStarted,
	wsSessionEventType:           (*daemonConnection).onSessionEvent,
	wsSessionBlockedType:         (*daemonConnection).onSessionBlocked,
	wsSessionResumedType:         (*daemonConnection).onSessionResumed,
	wsSessionNativeSessionIDType: (*daemonConnection).onSessionNativeID,
	wsSessionCompleteType:        (*daemonConnection).onSessionCompleted,

	// Answers to the server's requests.
	wsFileReadType:                 answer[wsFileReadPayload],
	wsIssueEnvironmentResultType:   answer[wsIssueEnvironmentResult],
	wsEvidenceResultType:           answer[wsEvidenceResult],
	wsWorkspaceInspectedType:       answer[wsWorkspaceInspectionResult],
	wsNativeCliInstalledType:       answer[wsNativeCliInstallResult],
	wsWorkerUpdateStartedType:      answer[wsWorkerUpdateStarted],
	wsToolInstalledType:            answer[wsToolInstalled],
	wsRepositoryRefsReadType:       answer[wsRepositoryRefs],
	wsSkillRepositoryFetchedType:   answer[wsSkillRepositoryFetched],
	wsDiagnosticsReadyType:         answer[wsDiagnosticsReady],
	wsRepairDoneType:               answer[wsRepairDone],
	wsNativeAccountInspectedType:   answer[wsNativeAccountInspectionResult],
	wsSubagentTranscriptReadType:   answer[wsSubagentTranscriptReadPayload],
	wsSessionFileReadType:          answer[wsSessionFileReadPayload],
	wsSessionFileDiffReadType:      answer[wsSessionFileDiffReadPayload],
	wsBackgroundTaskOutputReadType: answer[wsBackgroundTaskOutputReadPayload],
	wsBackgroundTaskStoppedType:    answer[wsBackgroundTaskStoppedPayload],
	wsSessionUsageReadType:         answer[wsSessionUsageRead],
	wsSubagentsListedType:          answer[wsSubagentsListedPayload],
	wsDirectoriesListedType:        answer[wsDirectoriesListedPayload],
	wsWorkspaceTreeListedType:      answer[wsWorkspaceTreeListedPayload],
	wsWorkspaceForgottenType:       answer[wsWorkspaceForgottenPayload],
	wsWorkspaceRelinkedType:        answer[wsWorkspaceRelinkedPayload],
	wsMovedWorkspaceFoundType:      answer[wsMovedWorkspaceFoundPayload],
	wsResourceOperatedType:         answer[store.ResourceOperateResult],
	wsResourceBackendInstalledType: answer[store.ResourceBackendInstallResult],
	wsResourceSettingsAppliedType:  answer[store.ResourceSourceSettings],
	wsAttachmentWrittenType:        answer[wsAttachmentWrittenPayload],
	wsAttachmentChunkReadType:      answer[wsAttachmentChunkReadPayload],
	wsAgentModelsListedType:        refusable[wsAgentModelsListedPayload],
	wsProfileCredentialReadType:    refusable[wsProfileCredentialReadPayload],
	wsResourcesRefreshedType:       refusable[wsResourcesRefreshedPayload],
	wsSessionSteeredType:           refusable[wsSessionSteeredPayload],
	wsSkillsScannedType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsSkillsScannedPayload) error { return replyRefusal(reply.Error) })
	},
	wsSkillFileReadType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsSkillFileReadPayload) error { return replyRefusal(reply.Error) })
	},
	wsSkillContentReadType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsSkillContentReadPayload) error { return replyRefusal(reply.Error) })
	},
	wsWorkerUpdateStatusType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(status wsWorkerUpdateStatus) error {
			if deviceID, _ := c.registrationSnapshot(); deviceID != "" && c.hub.onWorkerUpdateStatus != nil {
				c.hub.onWorkerUpdateStatus(deviceID, status)
			}
			return nil
		})
	},
	wsWorkspaceReadyType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsWorkspaceReadyPayload) error {
			if err := reply.refusal(); err != nil {
				return err
			}
			if reply.Registration.Device.ID != "" {
				if err := c.syncRegistration(reply.Registration); err != nil {
					return err
				}
				c.reply(registeredEnvelope(envelope.ID))
				go c.dispatchQueuedAgentSessions(reply.Registration.Workspace.ID)
				go c.claimAndSend()
			}
			return nil
		})
	},
	wsAgentProfileUpsertedType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsAgentProfileUpsertedPayload) error {
			if err := reply.refusal(); err != nil {
				return err
			}
			return c.registrationAnswered(reply.Registration)
		})
	},
	wsRuntimeSettingsUpsertedType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsAgentRuntimeSettingsUpsertedPayload) error {
			if err := reply.refusal(); err != nil {
				return err
			}
			return c.registrationAnswered(reply.Registration)
		})
	},
	wsSessionCanceledType: func(c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(reply wsSessionCanceledPayload) error {
			if err := reply.refusal(); err != nil {
				return err
			}
			c.setActiveSession(reply.SessionID, false)
			return nil
		})
	},
	wsResourceResetDoneType: func(c *daemonConnection, ctx context.Context, envelope wsEnvelope) error {
		return deliverDaemonResponse(c, envelope, func(result store.ResourceResetResult) error {
			// A confirmation whose request no longer waits still counts.
			return c.hub.leases.ResetDone(ctx, result.ResourceID, result.Generation, result.Error)
		})
	},
}

// answer hands a device's answer to the request waiting for it; one nobody
// waits for any more is dropped.
func answer[T any](c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
	return deliverDaemonResponse[T](c, envelope, nil)
}

// refusable is answer for an answer that may refuse its request: a refusal
// nobody waits for any more goes back to the device as an error.
func refusable[T deviceReply](c *daemonConnection, _ context.Context, envelope wsEnvelope) error {
	return deliverDaemonResponse(c, envelope, func(reply T) error { return reply.refusal() })
}

func (c *daemonConnection) onHello(_ context.Context, envelope wsEnvelope) error {
	var registration store.DaemonRegistration
	if err := decodeWebSocketPayload(envelope.Payload, &registration); err != nil {
		return err
	}
	if err := c.syncRegistration(registration); err != nil {
		return err
	}
	c.applyServedWorkspaces(registration)
	c.reply(registeredEnvelope(envelope.ID))
	if c.hub.onDeviceConnected != nil {
		go c.hub.onDeviceConnected(c.lifetime, registration.Device.ID, registration.Capabilities)
	}
	go c.claimAndSend()
	// A daemon serves several workspaces; hello names only one of them.
	go c.dispatchQueuedAgentSessions("")
	go c.recoverOrphanedAgentSessions(registration.ActiveSessionIDs != nil)
	go c.sendSessionTimers()
	go c.reportLegacyResources(c.lifetime, registration)
	return nil
}

func (c *daemonConnection) onHeartbeat(_ context.Context, envelope wsEnvelope) error {
	c.noteHeartbeat(envelope.Payload)
	c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	return nil
}

func (c *daemonConnection) onReadyForIssue(_ context.Context, envelope wsEnvelope) error {
	c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	go c.claimAndSend()
	return nil
}

// errForeignTarget refuses a message about an issue, run or session that
// belongs to another device.
var errForeignTarget = errors.New("message targets work of another device")

// authorizeTarget keeps a device's messages to its own issues, runs and
// sessions. Only package tests produce a daemon actor without a device id.
func (c *daemonConnection) authorizeTarget(ctx context.Context, envelope wsEnvelope) error {
	deviceID := c.actor.DeviceID
	if deviceID == "" {
		return nil
	}
	var probe struct {
		SessionID string `json:"sessionId"`
		Event     struct {
			SessionID string `json:"sessionId"`
		} `json:"event"`
	}
	switch envelope.Type {
	case wsSessionSteeredType, wsSessionCanceledType, wsSessionStartedType, wsSessionEventType,
		wsSessionBlockedType, wsSessionResumedType, wsSessionNativeSessionIDType, wsSessionCompleteType:
	default:
		return nil
	}
	if err := json.Unmarshal(envelope.Payload, &probe); err != nil {
		return err
	}
	sessionID := probe.SessionID
	if envelope.Type == wsSessionEventType {
		sessionID = probe.Event.SessionID
	}
	session, err := c.hub.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err != nil || session.DeviceID != deviceID {
		return errForeignTarget
	}
	return nil
}

// sessionLifecycleTypes are the session messages a worker keeps until the
// server acknowledges them (its reliable session outbox).
var sessionLifecycleTypes = map[string]bool{
	wsSessionStartedType: true, wsSessionEventType: true, wsSessionBlockedType: true,
	wsSessionResumedType: true, wsSessionNativeSessionIDType: true, wsSessionCompleteType: true,
}

// refusedForGood reports a session message refused for a reason no retry
// changes: its session does not exist (any more), no longer takes it, or
// belongs to another device. Other failures (the store) may pass.
func refusedForGood(messageType string, err error) bool {
	return sessionLifecycleTypes[messageType] &&
		(errors.Is(err, errForeignTarget) || errors.Is(err, store.ErrNotFound))
}
