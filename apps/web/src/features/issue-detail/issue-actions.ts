import {
  Boxes,
  Check,
  CircleDot,
  Plus,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Issue } from "@foundry/protocol";
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
        label: "New issue",
        onClick: callbacks.onNewIssue,
      },
      secondary: {
        icon: RefreshCw,
        label: "Refresh",
        onClick: () => void callbacks.onRefresh(),
      },
    };
  }

  if (issue.status === "verifying") {
    return {
      primary: {
        icon: Check,
        label: "Review evidence and acceptance",
        onClick: callbacks.onAcceptIssue,
      },
      secondary: {
        label: "Request changes",
        onClick: callbacks.onRequestChanges,
      },
    };
  }

  if (issue.status === "pending") {
    return {
      primary: {
        label: "Start production",
        onClick: callbacks.onStartProduction,
      },
    };
  }
  if (issue.status === "blocked") {
    return {
      primary: {
        icon: RefreshCw,
        label: "Retry in candidate",
        onClick: callbacks.onRequestChanges,
      },
    };
  }

  if (issue.status === "in_progress") {
    return {
      primary: {
        label: "Guide this Issue",
        onClick: callbacks.onRequestChanges,
      },
      secondary: {
        icon: RefreshCw,
        label: "Refresh",
        onClick: () => void callbacks.onRefresh(issue.id),
      },
    };
  }

  if (issue.status === "accepted") {
    return {
      primary: {
        icon: Plus,
        label: "Create follow-up",
        onClick: () =>
          callbacks.onDraftFromSource(
            `Follow up on ${issueDisplayId(issue)}: ${issue.title}\n\n${issue.sourceInput}`,
          ),
      },
      secondary: {
        icon: CircleDot,
        label: "Issues",
        onClick: () => callbacks.onNavigate("issues"),
      },
    };
  }

  return {
    primary: {
      icon: Boxes,
      label: "Open assets",
      onClick: () => callbacks.onNavigate("assets"),
    },
    secondary: {
      icon: Wrench,
      label: "Unblock issue",
      onClick: () =>
        callbacks.onDraftFromSource(
          `Unblock ${issueDisplayId(issue)}: ${issue.title}\n\n${issue.checks.join("\n")}`,
        ),
    },
  };
}
