import {
  Boxes,
  Check,
  CircleDot,
  Plus,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Issue } from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { issueDisplayId } from "../../lib/issue-meta";

export interface IssueDetailAction {
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
}

/**
 * Callbacks the issue-detail view needs from the app shell. Keeping these
 * as an interface lets the view stay decoupled from App state and handlers.
 */
export interface IssueActionCallbacks {
  onAcceptIssue: () => void;
  onDraftFromSource: (text: string) => void;
  onNavigate: (view: string) => void;
  onNewIssue: () => void;
  onNotice: (message: string) => void;
  onRefresh: (issueId?: string) => void;
  onRequestChanges: () => void;
  onStartProduction: () => void;
}

/**
 * Resolve the primary/secondary actions for an issue based on its status.
 * Extracted from App.tsx so the issue-detail feature owns its own actions.
 */
export function issueActions(
  issue: Issue | undefined,
  callbacks: IssueActionCallbacks,
): { primary?: IssueDetailAction; secondary?: IssueDetailAction } {
  if (!issue) {
    return {
      primary: {
        icon: Plus,
        label: i18n.t("issueDetail:actions.newIssue"),
        onClick: callbacks.onNewIssue,
      },
      secondary: {
        icon: RefreshCw,
        label: i18n.t("common:actions.refresh"),
        onClick: () => void callbacks.onRefresh(),
      },
    };
  }

  if (issue.status === "verifying") {
    return {
      primary: {
        icon: Check,
        label: i18n.t("issueDetail:actions.reviewEvidence"),
        onClick: callbacks.onAcceptIssue,
      },
      secondary: {
        label: i18n.t("issueDetail:actions.requestChanges"),
        onClick: callbacks.onRequestChanges,
      },
    };
  }

  if (issue.status === "pending") {
    return {
      primary: {
        label: i18n.t("issueDetail:actions.startProduction"),
        onClick: callbacks.onStartProduction,
      },
    };
  }
  if (issue.status === "blocked") {
    return {
      primary: {
        icon: RefreshCw,
        label: i18n.t("issueDetail:actions.retryInCandidate"),
        onClick: callbacks.onRequestChanges,
      },
    };
  }

  if (issue.status === "in_progress") {
    return {
      primary: {
        label: i18n.t("issueDetail:actions.guide"),
        onClick: callbacks.onRequestChanges,
      },
      secondary: {
        icon: RefreshCw,
        label: i18n.t("common:actions.refresh"),
        onClick: () => void callbacks.onRefresh(issue.id),
      },
    };
  }

  if (issue.status === "accepted") {
    return {
      primary: {
        icon: Plus,
        label: i18n.t("issueDetail:actions.createFollowUp"),
        onClick: () =>
          callbacks.onDraftFromSource(
            i18n.t("issueDetail:view.followUpDraft", {
              id: issueDisplayId(issue),
              title: issue.title,
              source: issue.sourceInput,
            }),
          ),
      },
      secondary: {
        icon: CircleDot,
        label: i18n.t("issueDetail:actions.issues"),
        onClick: () => callbacks.onNavigate("issues"),
      },
    };
  }

  return {
    primary: {
      icon: Boxes,
      label: i18n.t("issueDetail:actions.openAssets"),
      onClick: () => callbacks.onNavigate("assets"),
    },
    secondary: {
      icon: Wrench,
      label: i18n.t("issueDetail:actions.unblock"),
      onClick: () =>
        callbacks.onDraftFromSource(
          i18n.t("issueDetail:actions.unblockDraft", {
            id: issueDisplayId(issue),
            title: issue.title,
            checks: issue.checks.join("\n"),
          }),
        ),
    },
  };
}
