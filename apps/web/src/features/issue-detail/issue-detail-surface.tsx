import { ArrowLeft } from "lucide-react";
import { Children, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";

type BadgeTone = NonNullable<BadgeProps["tone"]>;

export interface IssueDetailScreenProps {
  children: ReactNode;
  inspector: ReactNode;
}

export function IssueDetailScreen({
  children,
  inspector,
}: IssueDetailScreenProps) {
  const [header, ...body] = Children.toArray(children);

  return (
    <section className="flex h-full min-h-0 animate-chat-screen-in max-[860px]:block max-[860px]:h-auto max-[860px]:overflow-visible">
      <ScrollArea
        className="min-w-0 flex-1"
        data-foundry-scroll-reset-viewport="true"
      >
        <div className="box-border w-[min(860px,100%)] max-w-[860px] min-w-0 px-6.5 pt-5.5 pb-12.5 max-[860px]:mx-6 max-[860px]:w-auto max-[860px]:max-w-none max-[860px]:px-0 max-[860px]:pb-10.5">
          {header}
          {body}
          <div className="hidden max-[860px]:mt-4 max-[860px]:mb-6 max-[860px]:block">
            {inspector}
          </div>
        </div>
      </ScrollArea>
      <div className="contents max-[860px]:hidden">{inspector}</div>
    </section>
  );
}

export interface IssueDetailHeaderProps {
  artifactLabel: ReactNode;
  issueId: ReactNode;
  onBack: () => void;
  runLabel?: ReactNode;
  runtimeLabel: ReactNode;
  statusLabel: ReactNode;
  statusTone: BadgeTone;
  title: ReactNode;
}

export function IssueDetailHeader({
  artifactLabel,
  issueId,
  onBack,
  runLabel,
  runtimeLabel,
  statusLabel,
  statusTone,
  title,
}: IssueDetailHeaderProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <header className="max-w-[760px] min-w-0">
      <Button
        className="mb-3.5 h-auto min-h-3.5 items-center rounded-md active:scale-100 gap-1.5 p-0 text-xs leading-none font-medium text-ink-faint hover:bg-transparent hover:text-ink-muted"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft size={14} />
        {t("surface.back")}
      </Button>
      <div className="mb-1.25 flex min-w-0 flex-wrap items-center gap-2.75">
        <h1 className="m-0 max-w-full min-w-0 text-2xl leading-[1.2] font-bold text-ink wrap-anywhere text-pretty">
          {title}
        </h1>
        <code className="flex-none font-mono text-2xs leading-none font-medium text-ink-faint">
          {issueId}
        </code>
        <Badge className="min-w-[140px] justify-start" tone={statusTone}>
          {statusLabel}
        </Badge>
      </div>
      <p className="mb-5 max-w-[720px] text-xs leading-[1.4] text-ink-faint wrap-anywhere">
        {t("surface.primaryArtifact")}{" "}
        <strong className="font-bold text-ink-muted">{artifactLabel}</strong> ·{" "}
        {runtimeLabel}
        {runLabel ? (
          <>
            {" "}
            · {t("surface.run")}{" "}
            <code className="font-mono text-2xs font-semibold text-ink-faint">
              {runLabel}
            </code>
          </>
        ) : null}
      </p>
    </header>
  );
}

const turnLabelClass =
  "mb-1.5 block text-2xs leading-none font-semibold text-ink-faint";
const turnTextClass =
  "m-0 text-md leading-[1.6] text-ink wrap-anywhere text-pretty";

export interface IssueContractBodyProps {
  inferredTask: ReactNode;
  sourceInput: ReactNode;
}

export function IssueContractBody({
  inferredTask,
  sourceInput,
}: IssueContractBodyProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <div className="mb-5.5 flex max-w-[720px] min-w-0 flex-col gap-4">
      <article
        className="ml-auto block w-fit max-w-[82%] min-w-0 rounded-xl rounded-br-xs bg-panel-soft bg-clip-padding px-3.5 py-2.75"
        data-role="user"
      >
        <span className={turnLabelClass + " text-right"}>
          {t("surface.user")}
        </span>
        <p className={turnTextClass}>{sourceInput}</p>
      </article>
      <article className="block max-w-full min-w-0 pb-0.5" data-role="bot">
        {/* i18n-ignore: product name */}
        <span className={turnLabelClass}>Foundry</span>
        <p className={turnTextClass}>{inferredTask}</p>
      </article>
    </div>
  );
}
