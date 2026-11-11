package httpapi

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/wirerecord"
)

// The Go shapes declared today for what crosses the device link, for the
// wire drift report (scripts/wire-drift-report.mjs,
// docs/refactor/phase6-openapi-design.md S1). Each daemon message type has
// the type its receiver decodes it into (in: the server's handler; out: the
// struct the server encodes, which the worker's type is compared with in
// the script). Where the server builds a payload from a map or an
// anonymous struct there is no declared shape to compare: unchecked says
// so. Goes with S3b, when the generated types replace these.
type wireDecl struct {
	dir, kind string
	goType    reflect.Type
	// noPayload: the envelope carries none (ack, registered…).
	noPayload bool
	unchecked string
}

func goShape[T any]() reflect.Type { return reflect.TypeFor[T]() }

const (
	fromMap       = "server builds it from a map"
	fromAnonymous = "anonymous struct"
	emptyObject   = "server sends {}"
)

var wireDecls = []wireDecl{
	// From the device: its own reports.
	{dir: "in", kind: wsHelloType, goType: goShape[store.DaemonRegistration]()},
	{dir: "in", kind: wsHeartbeatType, goType: goShape[wsHeartbeatPayload]()},
	{dir: "in", kind: wsReadyForIssueType, noPayload: true},
	{dir: "in", kind: wsBackgroundTaskOutputChangedType, goType: goShape[wsBackgroundTaskOutputChangedPayload]()},
	{dir: "in", kind: wsIssueEnvironmentChangedType, goType: goShape[wsIssueEnvironmentChangedPayload]()},
	{dir: "in", kind: wsResourcesReportType, goType: goShape[store.ResourcesReport]()},
	{dir: "in", kind: wsConnectorProgressType, goType: goShape[store.ConnectorProgressPayload]()},
	{dir: "in", kind: wsWorkspaceFoldersType, unchecked: fromAnonymous},
	{dir: "in", kind: wsSessionStartedType, goType: goShape[wsSessionStartedPayload]()},
	{dir: "in", kind: wsSessionEventType, goType: goShape[wsSessionEventPayload]()},
	{dir: "in", kind: wsSessionBlockedType, unchecked: fromAnonymous},
	{dir: "in", kind: wsSessionResumedType, unchecked: fromAnonymous},
	{dir: "in", kind: wsSessionNativeSessionIDType, goType: goShape[wsSessionNativeSessionIDPayload]()},
	{dir: "in", kind: wsSessionCompleteType, goType: goShape[wsSessionCompletedPayload]()},
	{dir: "in", kind: wsSessionTurnType, goType: goShape[wsSessionTurnPayload]()},
	{dir: "in", kind: wsExecutionRunnerType, goType: goShape[store.DeviceRunner]()},
	{dir: "in", kind: wsReplyChunkType, goType: goShape[wsReplyChunkPayload]()},
	// From the device: answers.
	{dir: "in", kind: wsFileReadType, goType: goShape[wsFileReadPayload]()},
	{dir: "in", kind: wsDeviceFileReadType, goType: goShape[wsDeviceFileRead]()},
	{dir: "in", kind: wsContextPatchedType, goType: goShape[wsContextPatchReply]()},
	{dir: "in", kind: wsKnowledgeResultType, goType: goShape[wsKnowledgeReply]()},
	{dir: "in", kind: wsIssueEnvironmentResultType, goType: goShape[wsIssueEnvironmentResult]()},
	{dir: "in", kind: wsEvidenceResultType, goType: goShape[wsEvidenceResult]()},
	{dir: "in", kind: wsWorkspaceInspectedType, goType: goShape[wsWorkspaceInspectionResult]()},
	{dir: "in", kind: wsNativeCliInstalledType, goType: goShape[wsNativeCliInstallResult]()},
	{dir: "in", kind: wsNativeSignInReplyType, goType: goShape[store.NativeSignInReplyPayload]()},
	{dir: "in", kind: wsWorkerUpdateStartedType, goType: goShape[wsWorkerUpdateStarted]()},
	{dir: "in", kind: wsExecutionRunnerReadType, goType: goShape[wsExecutionRunnerRead]()},
	{dir: "in", kind: wsExecutionRunnerSwitchedType, goType: goShape[wsExecutionRunnerSwitched]()},
	{dir: "in", kind: wsToolInstalledType, goType: goShape[wsToolInstalled]()},
	{dir: "in", kind: wsToolCheckedType, goType: goShape[wsToolChecked]()},
	{dir: "in", kind: wsConnectorReplyType, goType: goShape[store.ConnectorReplyPayload]()},
	{dir: "in", kind: wsExtensionReplyType, goType: goShape[store.ExtensionReplyPayload]()},
	{dir: "in", kind: wsRepositoryRefsReadType, goType: goShape[wsRepositoryRefs]()},
	{dir: "in", kind: wsSkillRepositoryFetchedType, goType: goShape[wsSkillRepositoryFetched]()},
	{dir: "in", kind: wsDiagnosticsReadyType, goType: goShape[wsDiagnosticsReady]()},
	{dir: "in", kind: wsRepairDoneType, goType: goShape[wsRepairDone]()},
	{dir: "in", kind: wsNativeAccountInspectedType, goType: goShape[wsNativeAccountInspectionResult]()},
	{dir: "in", kind: wsSubagentTranscriptReadType, goType: goShape[wsSubagentTranscriptReadPayload]()},
	{dir: "in", kind: wsNativeHistoryReadType, goType: goShape[wsNativeHistoryReadPayload]()},
	{dir: "in", kind: wsNativeArchiveResultType, goType: goShape[wsNativeArchiveResultPayload]()},
	{dir: "in", kind: wsSessionFileReadType, goType: goShape[wsSessionFileReadPayload]()},
	{dir: "in", kind: wsSessionFileDiffReadType, goType: goShape[wsSessionFileDiffReadPayload]()},
	{dir: "in", kind: wsBackgroundTaskOutputReadType, goType: goShape[wsBackgroundTaskOutputReadPayload]()},
	{dir: "in", kind: wsBackgroundTaskStoppedType, goType: goShape[wsBackgroundTaskStoppedPayload]()},
	{dir: "in", kind: wsSessionGoalControlledType, goType: goShape[wsSessionGoalControlledPayload]()},
	{dir: "in", kind: wsSessionUsageReadType, goType: goShape[wsSessionUsageRead]()},
	{dir: "in", kind: wsSubagentsListedType, goType: goShape[wsSubagentsListedPayload]()},
	{dir: "in", kind: wsDirectoriesListedType, goType: goShape[wsDirectoriesListedPayload]()},
	{dir: "in", kind: wsWorkspaceTreeListedType, goType: goShape[wsWorkspaceTreeListedPayload]()},
	{dir: "in", kind: wsServiceListenersListedType, goType: goShape[wsServiceListenersListedPayload]()},
	{dir: "in", kind: wsWorkspaceForgottenType, goType: goShape[wsWorkspaceForgottenPayload]()},
	{dir: "in", kind: wsWorkspaceRelinkedType, goType: goShape[wsWorkspaceRelinkedPayload]()},
	{dir: "in", kind: wsMovedWorkspaceFoundType, goType: goShape[wsMovedWorkspaceFoundPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationProgressType, goType: goShape[wsWorkspaceMigrationProgressPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationScannedType, goType: goShape[wsWorkspaceMigrationScannedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationCheckedType, goType: goShape[wsWorkspaceMigrationCheckedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationTransferStartedType, goType: goShape[wsWorkspaceMigrationTransferStartedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationVerifiedType, goType: goShape[wsWorkspaceMigrationVerifiedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationRescannedType, goType: goShape[wsWorkspaceMigrationRescannedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationActivatedType, goType: goShape[wsWorkspaceMigrationActivatedPayload]()},
	{dir: "in", kind: wsWorkspaceMigrationRetiredType, goType: goShape[wsReplyError]()},
	{dir: "in", kind: wsWorkspaceMigrationAbortedType, goType: goShape[wsReplyError]()},
	{dir: "in", kind: wsWorkspaceMigrationPurgedType, goType: goShape[wsWorkspaceMigrationPurgedPayload]()},
	{dir: "in", kind: wsResourceOperatedType, goType: goShape[store.ResourceOperateResult]()},
	{dir: "in", kind: wsResourceBackendInstalledType, goType: goShape[store.ResourceBackendInstallResult]()},
	{dir: "in", kind: wsResourceSettingsAppliedType, goType: goShape[store.ResourceSourceSettings]()},
	{dir: "in", kind: wsResourceResetDoneType, goType: goShape[store.ResourceResetResult]()},
	{dir: "in", kind: wsAttachmentWrittenType, goType: goShape[wsAttachmentWrittenPayload]()},
	{dir: "in", kind: wsAttachmentChunkReadType, goType: goShape[wsAttachmentChunkReadPayload]()},
	{dir: "in", kind: wsExternalConnectionCheckedType, goType: goShape[wsExternalConnectionReply]()},
	{dir: "in", kind: wsExternalConnectionRemovedType, goType: goShape[wsExternalConnectionReply]()},
	{dir: "in", kind: wsExternalConnectionSetupReadType, goType: goShape[wsExternalConnectionSetupRead]()},
	{dir: "in", kind: wsExternalConnectionSetupStartedType, goType: goShape[wsExternalConnectionSetupRunReply]()},
	{dir: "in", kind: wsExternalConnectionSetupCancelledType, goType: goShape[wsExternalConnectionSetupRunReply]()},
	{dir: "in", kind: wsAgentModelsListedType, goType: goShape[wsAgentModelsListedPayload]()},
	{dir: "in", kind: wsAgentProfileCheckedType, goType: goShape[wsAgentProfileCheckedPayload]()},
	{dir: "in", kind: wsProviderKeyReadType, goType: goShape[wsProviderKeyReadPayload]()},
	{dir: "in", kind: wsResourcesRefreshedType, goType: goShape[wsResourcesRefreshedPayload]()},
	{dir: "in", kind: wsSessionSteeredType, goType: goShape[wsSessionSteeredPayload]()},
	{dir: "in", kind: wsWorkspaceSkillsRefreshedType, goType: goShape[workspaceDraftReply]()},
	{dir: "in", kind: wsSkillsScannedType, goType: goShape[wsSkillsScannedPayload]()},
	{dir: "in", kind: wsSkillFileReadType, goType: goShape[wsSkillFileReadPayload]()},
	{dir: "in", kind: wsSkillContentReadType, goType: goShape[wsSkillContentReadPayload]()},
	{dir: "in", kind: wsWorkerUpdateStatusType, goType: goShape[wsWorkerUpdateStatus]()},
	{dir: "in", kind: wsWorkspaceReadyType, goType: goShape[wsWorkspaceReadyPayload]()},
	{dir: "in", kind: wsAgentProfileUpsertedType, goType: goShape[wsAgentProfileUpsertedPayload]()},
	{dir: "in", kind: wsRuntimeSettingsUpsertedType, goType: goShape[wsAgentRuntimeSettingsUpsertedPayload]()},
	{dir: "in", kind: wsSessionCanceledType, goType: goShape[wsSessionCanceledPayload]()},

	// To the device: answers about the connection.
	{dir: "out", kind: wsAckType, unchecked: "none, or {replyChunkSeq} from a map"},
	{dir: "out", kind: wsErrorType, noPayload: true},
	{dir: "out", kind: wsRegisteredType, noPayload: true},
	{dir: "out", kind: wsRegistrationNeededType, goType: goShape[wsRegistrationNeededPayload]()},
	// To the device: requests and work.
	{dir: "out", kind: wsRunSessionType, goType: goShape[wsRunSessionPayload]()},
	{dir: "out", kind: wsRecoverSessionType, goType: goShape[wsRecoverSessionPayload]()},
	{dir: "out", kind: wsSteerSessionType, goType: goShape[wsSteerSessionPayload]()},
	{dir: "out", kind: wsCancelSessionType, goType: goShape[wsCancelSessionPayload]()},
	{dir: "out", kind: wsReadFileType, goType: goShape[wsReadFilePayload]()},
	{dir: "out", kind: wsReadDeviceFileType, goType: goShape[wsReadDeviceFilePayload]()},
	{dir: "out", kind: wsReadSubagentTranscriptType, goType: goShape[wsReadSubagentTranscriptPayload]()},
	{dir: "out", kind: wsReadNativeHistoryType, goType: goShape[wsReadNativeHistoryPayload]()},
	{dir: "out", kind: wsReadSessionUsageType, goType: goShape[wsReadSessionUsage]()},
	{dir: "out", kind: wsReadSessionFileType, goType: goShape[wsReadSessionFilePayload]()},
	{dir: "out", kind: wsReadSessionFileDiffType, goType: goShape[wsReadSessionFileDiffPayload]()},
	{dir: "out", kind: wsReadBackgroundTaskOutputType, goType: goShape[wsBackgroundTaskRequestPayload]()},
	{dir: "out", kind: wsStopBackgroundTaskType, goType: goShape[wsBackgroundTaskRequestPayload]()},
	{dir: "out", kind: wsControlSessionGoalType, goType: goShape[wsSessionGoalControlPayload]()},
	{dir: "out", kind: wsListSubagentsType, goType: goShape[wsListSubagentsPayload]()},
	{dir: "out", kind: wsListDirectoriesType, goType: goShape[wsListDirectoriesPayload]()},
	{dir: "out", kind: wsListWorkspaceTreeType, goType: goShape[wsListWorkspaceTreePayload]()},
	{dir: "out", kind: wsListServiceListenersType, goType: goShape[wsListServiceListenersPayload]()},
	{dir: "out", kind: wsServiceTunnelOpenType, goType: goShape[wsServiceTunnelOpenPayload]()},
	{dir: "out", kind: wsInspectWorkspaceType, unchecked: fromMap},
	{dir: "out", kind: wsInspectNativeAccountType, unchecked: fromAnonymous},
	{dir: "out", kind: wsInstallNativeCliType, unchecked: fromAnonymous},
	{dir: "out", kind: wsNativeSignInType, goType: goShape[store.NativeSignInRequestPayload]()},
	{dir: "out", kind: wsUpdateWorkerType, unchecked: emptyObject},
	{dir: "out", kind: wsReadWorkerUpdateStatusType, unchecked: emptyObject},
	{dir: "out", kind: wsReadExecutionRunnerType, unchecked: emptyObject},
	{dir: "out", kind: wsSwitchExecutionRunnerType, unchecked: fromMap},
	{dir: "out", kind: wsRunDiagnosticsType, unchecked: emptyObject},
	{dir: "out", kind: wsRunRepairType, goType: goShape[wsRunRepair]()},
	{dir: "out", kind: wsInstallToolType, goType: goShape[wsInstallTool]()},
	{dir: "out", kind: wsCheckToolType, goType: goShape[wsCheckTool]()},
	{dir: "out", kind: wsConnectorRequestType, goType: goShape[store.ConnectorRequestPayload]()},
	{dir: "out", kind: wsExtensionRequestType, goType: goShape[store.ExtensionRequestPayload]()},
	{dir: "out", kind: wsReadRepositoryRefsType, goType: goShape[wsReadRepositoryRefs]()},
	{dir: "out", kind: wsFetchSkillRepositoryType, goType: goShape[wsFetchSkillRepository]()},
	{dir: "out", kind: wsSetupWorkspaceType, goType: goShape[wsSetupWorkspacePayload]()},
	{dir: "out", kind: wsForgetWorkspaceType, goType: goShape[wsForgetWorkspacePayload]()},
	{dir: "out", kind: wsRelinkWorkspaceType, goType: goShape[wsRelinkWorkspacePayload]()},
	{dir: "out", kind: wsFindMovedWorkspaceType, goType: goShape[wsFindMovedWorkspacePayload]()},
	{dir: "out", kind: wsWorkspaceMigrationScanType, goType: goShape[wsWorkspaceMigrationScanPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationCheckType, goType: goShape[wsWorkspaceMigrationCheckPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationTransferType, goType: goShape[wsWorkspaceMigrationTransferPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationVerifyType, goType: goShape[wsWorkspaceMigrationVerifyPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationRescanType, goType: goShape[wsWorkspaceMigrationRescanPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationActivateType, goType: goShape[wsWorkspaceMigrationActivatePayload]()},
	{dir: "out", kind: wsWorkspaceMigrationRetireType, goType: goShape[wsWorkspaceMigrationRetirePayload]()},
	{dir: "out", kind: wsWorkspaceMigrationAbortType, goType: goShape[wsWorkspaceMigrationAbortPayload]()},
	{dir: "out", kind: wsWorkspaceMigrationPurgeType, goType: goShape[wsWorkspaceMigrationPurgePayload]()},
	{dir: "out", kind: wsUpsertAgentProfileType, goType: goShape[wsUpsertAgentProfilePayload]()},
	{dir: "out", kind: wsUpsertRuntimeSettingsType, goType: goShape[wsUpsertAgentRuntimeSettingsPayload]()},
	{dir: "out", kind: wsListAgentModelsType, goType: goShape[wsListAgentModelsPayload]()},
	{dir: "out", kind: wsReadProviderKeyType, goType: goShape[wsReadProviderKeyPayload]()},
	{dir: "out", kind: wsRefreshResourcesType, goType: goShape[wsRefreshResourcesPayload]()},
	{dir: "out", kind: wsResourceOperateType, goType: goShape[store.ResourceOperateRequest]()},
	{dir: "out", kind: wsResourceResetType, goType: goShape[store.ResourceResetRequest]()},
	{dir: "out", kind: wsResourceSettingsType, goType: goShape[store.ResourceSourceSettings]()},
	{dir: "out", kind: wsInstallResourceBackendType, goType: goShape[store.ResourceBackendInstallRequest]()},
	{dir: "out", kind: wsAttachmentWriteType, goType: goShape[wsAttachmentWritePayload]()},
	{dir: "out", kind: wsAttachmentReadType, goType: goShape[wsAttachmentReadPayload]()},
	{dir: "out", kind: wsPrepareSkillsType, goType: goShape[wsPrepareSkillsPayload]()},
	{dir: "out", kind: wsScanSkillsType, goType: goShape[wsScanSkillsPayload]()},
	{dir: "out", kind: wsReadSkillContentType, goType: goShape[wsReadSkillContentPayload]()},
	{dir: "out", kind: wsReadSkillFileType, unchecked: fromMap},
	{dir: "out", kind: wsRefreshWorkspaceSkillsType, unchecked: fromMap},
	{dir: "out", kind: wsContextPatchType, goType: goShape[store.ContextPatchCommand]()},
	{dir: "out", kind: wsKnowledgeCommandType, goType: goShape[store.KnowledgeCommand]()},
	{dir: "out", kind: wsNativeArchiveType, goType: goShape[wsNativeArchivePayload]()},
	{dir: "out", kind: wsIssueEnvironmentType, unchecked: fromMap},
	{dir: "out", kind: wsEvidenceRequestType, unchecked: fromMap},
	{dir: "out", kind: wsCheckExternalConnectionType, goType: goShape[wsExternalConnectionRequestPayload]()},
	{dir: "out", kind: wsCheckAgentProfileType, goType: goShape[wsCheckAgentProfilePayload]()},
	{dir: "out", kind: wsRemoveExternalConnectionType, goType: goShape[wsExternalConnectionRequestPayload]()},
	{dir: "out", kind: wsReadExternalConnectionSetupType, goType: goShape[wsReadExternalConnectionSetup]()},
	{dir: "out", kind: wsStartExternalConnectionSetupType, goType: goShape[wsStartExternalConnectionSetup]()},
	{dir: "out", kind: wsCancelExternalConnectionSetupType, goType: goShape[wsCancelExternalConnectionSetup]()},
}

// The device REST routes the recording samples (recordedDeviceRoute), with
// the Go types of their request and response bodies.
type restDecl struct {
	request, response reflect.Type
	// unchecked says which body has no declared type, and why.
	unchecked string
}

var restDecls = map[string]restDecl{
	"POST /api/daemon/pair":                                 {unchecked: "request and response are anonymous structs"},
	"GET /api/worker/release":                               {response: goShape[workerRelease]()},
	"POST /api/daemon/attachment-previews":                  {unchecked: "request is an anonymous struct; response from a map"},
	"POST /api/daemon/chats/sync":                           {request: goShape[store.SyncChatsInput](), response: goShape[syncedChats]()},
	"GET /api/daemon/chats/running":                         {unchecked: "response from a map"},
	"GET /api/daemon/chats/digests":                         {unchecked: "response from a map"},
	"GET /api/daemon/session-work":                          {unchecked: "see the handler's response"},
	"POST /api/daemon/session-work":                         {unchecked: "request is an anonymous struct"},
	"POST /api/daemon/sessions/{id}/work-fire":              {unchecked: "request is an anonymous struct"},
	"POST /api/daemon/sessions/{id}/timer-fire":             {unchecked: "request is an anonymous struct; response from a map"},
	"POST /api/daemon/sessions/{id}/session-tokens":         {unchecked: "response from a map"},
	"POST /api/connectors/cloudflare/session-handle":        {unchecked: "request is an anonymous struct"},
	"POST /api/connectors/appstoreconnect/session-handle":   {unchecked: "request is an anonymous struct"},
	"POST /api/connectors/extensions/{kind}/session-handle": {unchecked: "request is an anonymous struct"},
}

// declaredMessageTypes reads every ws*Type constant of the package.
func declaredMessageTypes(t *testing.T) map[string]string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	declared := map[string]string{}
	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			spec, ok := node.(*ast.ValueSpec)
			if !ok {
				return true
			}
			for i, name := range spec.Names {
				if !strings.HasPrefix(name.Name, "ws") || !strings.HasSuffix(name.Name, "Type") || i >= len(spec.Values) {
					continue
				}
				if literal, ok := spec.Values[i].(*ast.BasicLit); ok && literal.Kind == token.STRING {
					value, _ := strconv.Unquote(literal.Value)
					declared[value] = name.Name
				}
			}
			return true
		})
	}
	return declared
}

// Every message type the package declares has a declared shape in the
// direction it travels, every handled one an "in" entry, and every recorded
// REST route its entry: a new type or route cannot slip past the report.
func TestWireDeclsCoverTheDeviceProtocol(t *testing.T) {
	declared := declaredMessageTypes(t)
	if len(declared) < 130 {
		t.Fatalf("read only %d message types", len(declared))
	}
	seen := map[string]bool{}
	directions := map[string]bool{}
	for _, decl := range wireDecls {
		if decl.dir != "in" && decl.dir != "out" {
			t.Errorf("%s: direction %q", decl.kind, decl.dir)
		}
		if _, ok := declared[decl.kind]; !ok {
			t.Errorf("wireDecls names %q, which no ws*Type constant declares", decl.kind)
		}
		if directions[decl.dir+" "+decl.kind] {
			t.Errorf("%s %s declared twice", decl.dir, decl.kind)
		}
		directions[decl.dir+" "+decl.kind] = true
		if (decl.goType == nil) == (decl.unchecked == "" && !decl.noPayload) {
			t.Errorf("%s %s: give a Go type, or say why there is none", decl.dir, decl.kind)
		}
		seen[decl.kind] = true
	}
	for value, name := range declared {
		if !seen[value] {
			t.Errorf("%s (%q) has no entry in wireDecls", name, value)
		}
	}
	for kind := range inboundHandlers {
		if !directions["in "+kind] {
			t.Errorf("handled message %q has no \"in\" entry in wireDecls", kind)
		}
	}
	server := NewServer(newEmptyTestStore(t))
	routes := map[string]bool{}
	for _, r := range server.routeTable() {
		if recordedDeviceRoute(r) {
			routes[r.pattern] = true
			if _, ok := restDecls[r.pattern]; !ok {
				t.Errorf("recorded route %q has no entry in restDecls", r.pattern)
			}
		}
	}
	for pattern := range restDecls {
		if !routes[pattern] {
			t.Errorf("restDecls names %q, which is not a recorded route", pattern)
		}
	}
	if len(routes) != 14 {
		t.Errorf("recorded device routes = %d, want the 14 JSON routes of the design", len(routes))
	}
}

func typeName(t reflect.Type) string {
	if t == nil {
		return ""
	}
	return t.String()
}

// checkWireRecord checks one recorded record against what Go declares for
// it: the declared type's name, why it was not checked, and the issues.
func checkWireRecord(record wirerecord.Record, decls map[string]wireDecl) (string, string, []wirerecord.Issue) {
	if record.Channel == "rest" {
		decl, ok := restDecls[record.Kind]
		if !ok {
			return "", "not a declared device route", nil
		}
		var issues []wirerecord.Issue
		var names []string
		for _, body := range []struct {
			name string
			typ  reflect.Type
			raw  json.RawMessage
		}{{"request", decl.request, record.Payload}, {"response", decl.response, record.Response}} {
			if body.typ == nil || len(body.raw) == 0 || record.Status >= 300 && body.name == "response" {
				continue
			}
			names = append(names, body.name+" "+body.typ.String())
			value, err := wirerecord.Decode(body.raw)
			if err != nil {
				issues = append(issues, wirerecord.Issue{Kind: "type", Path: body.name, Detail: err.Error()})
				continue
			}
			issues = append(issues, wirerecord.CheckGo(body.typ, value, body.name)...)
		}
		return strings.Join(names, ", "), decl.unchecked, issues
	}
	decl, ok := decls[record.Dir+" "+record.Kind]
	if !ok {
		return "", "no declared message of this type and direction", []wirerecord.Issue{{Kind: "unknown", Path: "type", Detail: record.Dir + " " + record.Kind}}
	}
	if len(record.Payload) == 0 {
		if decl.goType != nil && record.Omitted == "" {
			return typeName(decl.goType), "", []wirerecord.Issue{{Kind: "missing", Path: "payload", Detail: decl.goType.String()}}
		}
		return typeName(decl.goType), decl.unchecked, nil
	}
	if decl.noPayload {
		return "", "", []wirerecord.Issue{{Kind: "unknown", Path: "payload", Detail: "no payload declared"}}
	}
	if decl.goType == nil {
		return "", decl.unchecked, nil
	}
	value, err := wirerecord.Decode(record.Payload)
	if err != nil {
		return typeName(decl.goType), "", []wirerecord.Issue{{Kind: "type", Path: "payload", Detail: err.Error()}}
	}
	return typeName(decl.goType), "", wirerecord.CheckGo(decl.goType, value, "payload")
}

// The Go half of the wire drift report: run by scripts/wire-drift-report.mjs
// with FOUNDRY_WIRE_DRIFT_INPUT (a recording) and FOUNDRY_WIRE_DRIFT_OUTPUT
// (where its JSON goes); skipped otherwise.
func TestWireDriftReport(t *testing.T) {
	input, output := os.Getenv("FOUNDRY_WIRE_DRIFT_INPUT"), os.Getenv("FOUNDRY_WIRE_DRIFT_OUTPUT")
	if input == "" || output == "" {
		t.Skip("FOUNDRY_WIRE_DRIFT_INPUT and FOUNDRY_WIRE_DRIFT_OUTPUT name a recording and the report")
	}
	report, err := wireDriftReport(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.MarshalIndent(report, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

type wireDriftDeclared struct {
	Channel   string `json:"channel"`
	Dir       string `json:"dir,omitempty"`
	Kind      string `json:"kind"`
	GoType    string `json:"goType,omitempty"`
	Unchecked string `json:"unchecked,omitempty"`
}

type wireDriftGoReport struct {
	Declared []wireDriftDeclared     `json:"declared"`
	Kinds    []wirerecord.KindReport `json:"kinds"`
}

func wireDriftReport(path string) (wireDriftGoReport, error) {
	decls := map[string]wireDecl{}
	var declared []wireDriftDeclared
	for _, decl := range wireDecls {
		decls[decl.dir+" "+decl.kind] = decl
		unchecked := decl.unchecked
		if decl.noPayload {
			unchecked = "no payload"
		}
		declared = append(declared, wireDriftDeclared{Channel: "ws", Dir: decl.dir, Kind: decl.kind, GoType: typeName(decl.goType), Unchecked: unchecked})
	}
	for pattern, decl := range restDecls {
		var names []string
		if decl.request != nil {
			names = append(names, "request "+decl.request.String())
		}
		if decl.response != nil {
			names = append(names, "response "+decl.response.String())
		}
		declared = append(declared, wireDriftDeclared{Channel: "rest", Kind: pattern, GoType: strings.Join(names, ", "), Unchecked: decl.unchecked})
	}
	slices.SortFunc(declared, func(a, b wireDriftDeclared) int {
		return strings.Compare(a.Channel+a.Dir+a.Kind, b.Channel+b.Dir+b.Kind)
	})
	report := wirerecord.NewReport()
	err := wirerecord.Read(path, func(record wirerecord.Record) error {
		goType, unchecked, issues := checkWireRecord(record, decls)
		report.Add(record, goType, unchecked, issues)
		return nil
	})
	return wireDriftGoReport{Declared: declared, Kinds: report.Kinds()}, err
}
